/**
 * MCP Communication Layer - High-level dispatch functions.
 *
 * Coordinates inbox writes, mailbox messages, and dispatch requests with
 * notification callbacks. Direct mailbox notifications are authorized against
 * current strict durable state before any pane effect.
 */

import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  enqueueDispatchRequest,
  readDispatchRequest,
  readDispatchRequestStrict,
  transitionDispatchRequest,
  markDispatchRequestNotified,
  patchPendingDispatchReason,
  type StrictDispatchReadResult,
  type TeamDispatchRequest,
  type TeamDispatchRequestInput,
} from './dispatch-queue.js';
import {
  teamMarkMessageNotified,
  teamReadCanonicalMailboxMessageStrict,
  type StrictCanonicalMailboxMessageReadResult,
} from './team-ops.js';
import {
  mailboxNotificationSecurityTupleEquals,
  readCurrentMailboxNotificationGuard,
  type MailboxNotificationGuardInput,
  type MailboxNotificationGuardResult,
  type MailboxNotificationTarget,
} from './mailbox-notification-guard.js';
import {
  invokeDirectMailboxEffect,
  verifyTeamTargetOwnership,
  type DirectMailboxEffectResult,
} from './tmux-session.js';
import { absPath, TeamPaths } from './state-paths.js';
import { withProcessIdentityFileLock } from './process-identity-lock.js';
import { createSwallowedErrorLogger } from '../lib/swallowed-error.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface TeamNotifierTarget {
  workerName: string;
  workerIndex?: number;
  paneId?: string;
}

export type DispatchTransport = 'hook' | 'prompt_stdin' | 'tmux_send_keys' | 'mailbox' | 'none';

export interface DispatchOutcome {
  ok: boolean;
  transport: DispatchTransport;
  reason: string;
  request_id?: string;
  message_id?: string;
  to_worker?: string;
  /** Internal handoff marker; removed before queue functions return. */
  notification_managed?: true;
}

export type TeamNotifier = (
  target: TeamNotifierTarget,
  message: string,
  context: { request: TeamDispatchRequest; message_id?: string },
) => DispatchOutcome | Promise<DispatchOutcome>;

/** Dependency interface for inbox write operations */
export interface InboxWriter {
  writeWorkerInbox(teamName: string, workerName: string, inbox: string, cwd: string): Promise<void>;
}

/** Dependency interface for mailbox message operations */
export interface MailboxSender {
  sendDirectMessage(teamName: string, fromWorker: string, toWorker: string, body: string, cwd: string): Promise<{ message_id: string; to_worker: string }>;
  /** Retained for callers that provide the historical mailbox sender shape. */
  broadcastMessage(teamName: string, fromWorker: string, body: string, cwd: string): Promise<Array<{ message_id: string; to_worker: string }>>;
  markMessageNotified(teamName: string, workerName: string, messageId: string, cwd: string): Promise<void | boolean>;
}

export interface MailboxNotificationAttemptParams {
  teamName: string;
  recipient: string;
  requestId: string;
  messageId: string;
  triggerMessage: string;
  cwd: string;
}

export interface MailboxNotificationAttemptDependencies {
  readGuard: (input: MailboxNotificationGuardInput, cwd: string) => Promise<MailboxNotificationGuardResult>;
  readStrictDispatch: (teamName: string, requestId: string, cwd: string) => Promise<StrictDispatchReadResult>;
  readStrictMailbox: (
    teamName: string,
    workerName: string,
    messageId: string,
    cwd: string,
  ) => Promise<StrictCanonicalMailboxMessageReadResult>;
  invokeEffect: (target: MailboxNotificationTarget, message: string) => Promise<DirectMailboxEffectResult>;
  markMailbox: (teamName: string, workerName: string, messageId: string, cwd: string) => Promise<boolean>;
  markDispatch: (teamName: string, requestId: string, cwd: string) => Promise<TeamDispatchRequest | null>;
  patchPendingReason: (teamName: string, requestId: string, reason: string, cwd: string) => Promise<{ kind: string }>;
  withRequestLock: <T>(lockPath: string, fn: () => Promise<T>) => Promise<T>;
}

type MailboxTombstone =
  | { cause: 'delivery' }
  | {
    cause: 'commit';
    confirmationReason: 'worker_pane_notified' | 'leader_pane_notified';
  };

interface MailboxMarkerState {
  safe: boolean;
  mailboxMarked: boolean;
  dispatchMarked: boolean;
}

/**
 * These are deliberately process-local. Without a persisted attempt phase,
 * delivery uncertainty after a restart or in another process remains ambiguous.
 */
const mailboxNotificationTombstones = new Map<string, MailboxTombstone>();

// ── Internal helpers ───────────────────────────────────────────────────────

function isConfirmedNotification(outcome: DispatchOutcome): boolean {
  if (!outcome.ok) return false;
  if (outcome.transport !== 'hook') return true;
  return outcome.reason !== 'queued_for_hook_dispatch';
}

function isLeaderPaneMissingMailboxPersistedOutcome(
  request: TeamDispatchRequest,
  outcome: DispatchOutcome,
): boolean {
  return request.to_worker === 'leader-fixed'
    && outcome.ok
    && outcome.reason === 'leader_pane_missing_mailbox_persisted';
}

function fallbackTransportForPreference(
  preference: TeamDispatchRequestInput['transport_preference'],
): DispatchTransport {
  if (preference === 'prompt_stdin') return 'prompt_stdin';
  if (preference === 'transport_direct') return 'tmux_send_keys';
  return 'hook';
}

function notifyExceptionReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `notify_exception:${message}`;
}

function isExactText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function canonicalNotificationLockIdentity(lockPath: string): string {
  try {
    return realpathSync(lockPath);
  } catch {
    try {
      return join(realpathSync(dirname(lockPath)), basename(lockPath));
    } catch {
      return lockPath;
    }
  }
}

function managedOutcome(
  ok: boolean,
  transport: DispatchTransport,
  reason: string,
): DispatchOutcome {
  return { ok, transport, reason, notification_managed: true };
}

function defaultMailboxNotificationDependencies(): MailboxNotificationAttemptDependencies {
  return {
    readGuard: (input, cwd) => readCurrentMailboxNotificationGuard(input, cwd, {
      verifyProviderOwnership: verifyTeamTargetOwnership,
    }),
    readStrictDispatch: readDispatchRequestStrict,
    readStrictMailbox: teamReadCanonicalMailboxMessageStrict,
    invokeEffect: invokeDirectMailboxEffect,
    markMailbox: teamMarkMessageNotified,
    markDispatch: (teamName, requestId, cwd) => markDispatchRequestNotified(teamName, requestId, {}, cwd),
    patchPendingReason: patchPendingDispatchReason,
    withRequestLock: (lockPath, fn) => withProcessIdentityFileLock(lockPath, fn),
  };
}

function mergeMailboxNotificationDependencies(
  overrides: Partial<MailboxNotificationAttemptDependencies>,
): MailboxNotificationAttemptDependencies {
  return { ...defaultMailboxNotificationDependencies(), ...overrides };
}

function requestMatchesAttempt(
  request: TeamDispatchRequest,
  params: MailboxNotificationAttemptParams,
): boolean {
  return request.request_id === params.requestId
    && request.kind === 'mailbox'
    && request.team_name === params.teamName
    && request.to_worker === params.recipient
    && request.message_id === params.messageId;
}

function mailboxResultMatchesAttempt(
  read: StrictCanonicalMailboxMessageReadResult,
  params: MailboxNotificationAttemptParams,
): boolean {
  if (read.kind !== 'valid' && read.kind !== 'replay_suppressed') return false;
  return read.message.message_id === params.messageId && read.message.to_worker === params.recipient;
}

async function readMailboxMarkerState(
  params: MailboxNotificationAttemptParams,
  deps: MailboxNotificationAttemptDependencies,
): Promise<MailboxMarkerState> {
  try {
    const [dispatch, mailbox] = await Promise.all([
      deps.readStrictDispatch(params.teamName, params.requestId, params.cwd),
      deps.readStrictMailbox(params.teamName, params.recipient, params.messageId, params.cwd),
    ]);
    const dispatchMatches = dispatch.kind === 'valid' && requestMatchesAttempt(dispatch.request, params);
    const mailboxMatches = mailboxResultMatchesAttempt(mailbox, params);
    return {
      safe: dispatchMatches && mailboxMatches,
      dispatchMarked: dispatchMatches && (dispatch.request.status === 'notified' || dispatch.request.status === 'delivered'),
      mailboxMarked: mailboxMatches && mailbox.kind === 'replay_suppressed',
    };
  } catch {
    return { safe: false, dispatchMarked: false, mailboxMarked: false };
  }
}

async function writeAndVerifyMailboxMarkers(
  params: MailboxNotificationAttemptParams,
  deps: MailboxNotificationAttemptDependencies,
): Promise<MailboxMarkerState> {
  const before = await readMailboxMarkerState(params, deps);
  if (!before.safe) return before;

  const writes: Array<Promise<unknown>> = [];
  if (!before.mailboxMarked) {
    writes.push(deps.markMailbox(params.teamName, params.recipient, params.messageId, params.cwd).catch(() => false));
  }
  if (!before.dispatchMarked) {
    writes.push(deps.markDispatch(params.teamName, params.requestId, params.cwd).catch(() => null));
  }
  await Promise.all(writes);
  return readMailboxMarkerState(params, deps);
}

function markerOutcome(
  state: MailboxMarkerState,
  confirmationReason: 'worker_pane_notified' | 'leader_pane_notified',
): DispatchOutcome {
  if (state.mailboxMarked && state.dispatchMarked) {
    return managedOutcome(true, 'tmux_send_keys', confirmationReason);
  }
  if (state.mailboxMarked) {
    return managedOutcome(true, 'tmux_send_keys', 'notification_commit_dispatch_failed');
  }
  if (state.dispatchMarked) {
    return managedOutcome(true, 'tmux_send_keys', 'notification_commit_mailbox_failed');
  }
  return managedOutcome(false, 'tmux_send_keys', 'notification_commit_uncertain');
}

async function persistPendingReason(
  params: MailboxNotificationAttemptParams,
  deps: MailboxNotificationAttemptDependencies,
  reason: string,
  canPatch: boolean,
): Promise<DispatchOutcome> {
  if (!canPatch) return managedOutcome(false, 'none', reason);
  try {
    const patched = await deps.patchPendingReason(params.teamName, params.requestId, reason, params.cwd);
    if (patched.kind === 'patched') {
      if (reason === 'leader_pane_missing_deferred') {
        return managedOutcome(true, 'mailbox', 'leader_pane_missing_mailbox_persisted');
      }
      return managedOutcome(false, 'none', reason);
    }
  } catch {
    // A failed diagnostic patch must not make a pre-effect suppression retryable by assumption.
  }
  return managedOutcome(false, 'none', 'pending_reason_persist_failed');
}

async function suppressFromGuard(
  params: MailboxNotificationAttemptParams,
  deps: MailboxNotificationAttemptDependencies,
  guard: Extract<MailboxNotificationGuardResult, { kind: 'suppress' }>,
): Promise<DispatchOutcome> {
  return persistPendingReason(params, deps, guard.reason, !!guard.safePendingRequest);
}

async function reconcileTombstone(
  params: MailboxNotificationAttemptParams,
  deps: MailboxNotificationAttemptDependencies,
  key: string,
  tombstone: MailboxTombstone,
): Promise<DispatchOutcome> {
  let state = await readMailboxMarkerState(params, deps);
  if (tombstone.cause === 'commit') {
    state = await writeAndVerifyMailboxMarkers(params, deps);
    if (state.mailboxMarked && state.dispatchMarked) {
      mailboxNotificationTombstones.delete(key);
    }
    return markerOutcome(state, tombstone.confirmationReason);
  }

  if (state.mailboxMarked || state.dispatchMarked) {
    mailboxNotificationTombstones.delete(key);
    return markerOutcome(state, 'worker_pane_notified');
  }
  return managedOutcome(false, 'tmux_send_keys', 'notification_delivery_uncertain');
}

/**
 * Runs one direct mailbox notification attempt. The process-identity lock and
 * tombstone are deliberately outside the dispatch lock so checked marker and
 * reason writes can use their existing dispatch serialization without nesting it.
 */
export async function runMailboxNotificationAttempt(
  params: MailboxNotificationAttemptParams,
  overrides: Partial<MailboxNotificationAttemptDependencies> = {},
): Promise<DispatchOutcome> {
  if (!isExactText(params.teamName) || !isExactText(params.recipient) || !isExactText(params.requestId)
    || !isExactText(params.messageId) || !isExactText(params.triggerMessage)) {
    return managedOutcome(false, 'none', 'mailbox_request_identity_mismatch');
  }

  const deps = mergeMailboxNotificationDependencies(overrides);
  const lockPath = absPath(params.cwd, TeamPaths.mailboxNotificationLock(params.teamName, params.requestId));
  const key = canonicalNotificationLockIdentity(lockPath);

  try {
    return await deps.withRequestLock(lockPath, async () => {
      const existingTombstone = mailboxNotificationTombstones.get(key);
      if (existingTombstone) return reconcileTombstone(params, deps, key, existingTombstone);

      const guardInput: MailboxNotificationGuardInput = {
        teamName: params.teamName,
        recipient: params.recipient,
        requestId: params.requestId,
        messageId: params.messageId,
        triggerMessage: params.triggerMessage,
      };
      const current = await deps.readGuard(guardInput, params.cwd);
      if (current.kind === 'suppress') return suppressFromGuard(params, deps, current);

      const final = await deps.readGuard(guardInput, params.cwd);
      if (final.kind === 'suppress') return suppressFromGuard(params, deps, final);
      if (!mailboxNotificationSecurityTupleEquals(current.securityTuple, final.securityTuple)) {
        return persistPendingReason(params, deps, 'mailbox_security_tuple_changed', true);
      }

      mailboxNotificationTombstones.set(key, { cause: 'delivery' });
      let effect: DirectMailboxEffectResult;
      try {
        effect = await deps.invokeEffect(final.target, final.request.trigger_message);
      } catch {
        effect = {
          kind: 'attempted_unconfirmed',
          transport: 'tmux_send_keys',
          reason: 'notification_delivery_uncertain',
          cause: 'threw',
        };
      }

      if (effect.kind === 'not_attempted') {
        mailboxNotificationTombstones.delete(key);
        return persistPendingReason(params, deps, effect.reason, true);
      }
      if (effect.kind === 'attempted_unconfirmed') {
        return managedOutcome(false, effect.transport, 'notification_delivery_uncertain');
      }

      mailboxNotificationTombstones.set(key, { cause: 'commit', confirmationReason: effect.reason });
      const markers = await writeAndVerifyMailboxMarkers(params, deps);
      const outcome = markerOutcome(markers, effect.reason);
      if (markers.mailboxMarked && markers.dispatchMarked) mailboxNotificationTombstones.delete(key);
      return outcome;
    });
  } catch {
    return managedOutcome(false, 'none', 'mailbox_notification_busy');
  }
}

async function markImmediateDispatchFailure(params: {
  teamName: string;
  request: TeamDispatchRequest;
  reason: string;
  messageId?: string;
  cwd: string;
}): Promise<void> {
  const { teamName, request, reason, messageId, cwd } = params;
  if (request.transport_preference === 'hook_preferred_with_fallback') return;
  const logTransitionFailure = createSwallowedErrorLogger(
    'team.mcp-comm.markImmediateDispatchFailure transitionDispatchRequest failed',
  );

  const current = await readDispatchRequest(teamName, request.request_id, cwd);
  if (!current) return;
  if (current.status === 'failed' || current.status === 'notified' || current.status === 'delivered') return;

  await transitionDispatchRequest(
    teamName,
    request.request_id,
    current.status,
    'failed',
    {
      message_id: messageId ?? current.message_id,
      last_reason: reason,
    },
    cwd,
  ).catch(logTransitionFailure);
}

async function markLeaderPaneMissingDeferred(params: {
  teamName: string;
  request: TeamDispatchRequest;
  cwd: string;
  messageId?: string;
}): Promise<void> {
  const { teamName, request, cwd, messageId } = params;
  const logTransitionFailure = createSwallowedErrorLogger(
    'team.mcp-comm.markLeaderPaneMissingDeferred transitionDispatchRequest failed',
  );
  const current = await readDispatchRequest(teamName, request.request_id, cwd);
  if (!current) return;
  if (current.status !== 'pending') return;

  await transitionDispatchRequest(
    teamName,
    request.request_id,
    current.status,
    current.status,
    {
      message_id: messageId ?? current.message_id,
      last_reason: 'leader_pane_missing_deferred',
    },
    cwd,
  ).catch(logTransitionFailure);
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface QueueInboxParams {
  teamName: string;
  workerName: string;
  workerIndex: number;
  paneId?: string;
  inbox: string;
  triggerMessage: string;
  cwd: string;
  transportPreference?: TeamDispatchRequestInput['transport_preference'];
  fallbackAllowed?: boolean;
  inboxCorrelationKey?: string;
  notify: TeamNotifier;
  deps: InboxWriter;
}

export async function queueInboxInstruction(params: QueueInboxParams): Promise<DispatchOutcome> {
  const queued = await enqueueDispatchRequest(
    params.teamName,
    {
      kind: 'inbox',
      to_worker: params.workerName,
      worker_index: params.workerIndex,
      pane_id: params.paneId,
      trigger_message: params.triggerMessage,
      transport_preference: params.transportPreference,
      fallback_allowed: params.fallbackAllowed,
      inbox_correlation_key: params.inboxCorrelationKey,
    },
    params.cwd,
  );

  if (queued.deduped) {
    return {
      ok: false,
      transport: 'none',
      reason: 'duplicate_pending_dispatch_request',
      request_id: queued.request.request_id,
    };
  }

  try {
    await params.deps.writeWorkerInbox(params.teamName, params.workerName, params.inbox, params.cwd);
  } catch (error) {
    await markImmediateDispatchFailure({
      teamName: params.teamName,
      request: queued.request,
      reason: 'inbox_write_failed',
      cwd: params.cwd,
    });
    throw error;
  }

  const notifyOutcome = await Promise.resolve(params.notify(
    { workerName: params.workerName, workerIndex: params.workerIndex, paneId: params.paneId },
    params.triggerMessage,
    { request: queued.request },
  )).catch((error) => ({
    ok: false,
    transport: fallbackTransportForPreference(params.transportPreference),
    reason: notifyExceptionReason(error),
  } as DispatchOutcome));
  const outcome: DispatchOutcome = { ...notifyOutcome, request_id: queued.request.request_id };

  if (isConfirmedNotification(outcome)) {
    await markDispatchRequestNotified(
      params.teamName,
      queued.request.request_id,
      { last_reason: outcome.reason },
      params.cwd,
    );
  } else {
    await markImmediateDispatchFailure({
      teamName: params.teamName,
      request: queued.request,
      reason: outcome.reason,
      cwd: params.cwd,
    });
  }

  return outcome;
}

export interface QueueDirectMessageParams {
  teamName: string;
  fromWorker: string;
  toWorker: string;
  toWorkerIndex?: number;
  toPaneId?: string;
  body: string;
  triggerMessage: string;
  cwd: string;
  transportPreference?: TeamDispatchRequestInput['transport_preference'];
  fallbackAllowed?: boolean;
  notify: TeamNotifier;
  deps: MailboxSender;
}

export async function queueDirectMailboxMessage(params: QueueDirectMessageParams): Promise<DispatchOutcome> {
  const message = await params.deps.sendDirectMessage(params.teamName, params.fromWorker, params.toWorker, params.body, params.cwd);
  const queued = await enqueueDispatchRequest(
    params.teamName,
    {
      kind: 'mailbox',
      to_worker: params.toWorker,
      worker_index: params.toWorkerIndex,
      pane_id: params.toPaneId,
      trigger_message: params.triggerMessage,
      message_id: message.message_id,
      transport_preference: params.transportPreference,
      fallback_allowed: params.fallbackAllowed,
    },
    params.cwd,
  );

  if (queued.deduped) {
    return {
      ok: false,
      transport: 'none',
      reason: 'duplicate_pending_dispatch_request',
      request_id: queued.request.request_id,
      message_id: message.message_id,
    };
  }

  const notifyOutcome = await Promise.resolve(params.notify(
    { workerName: params.toWorker, workerIndex: params.toWorkerIndex, paneId: params.toPaneId },
    params.triggerMessage,
    { request: queued.request, message_id: message.message_id },
  )).catch((error) => ({
    ok: false,
    transport: fallbackTransportForPreference(params.transportPreference),
    reason: notifyExceptionReason(error),
  } as DispatchOutcome));
  const { notification_managed: notificationManaged, ...outcome } = {
    ...notifyOutcome,
    request_id: queued.request.request_id,
    message_id: message.message_id,
    to_worker: params.toWorker,
  };
  if (notificationManaged) return outcome;

  if (isLeaderPaneMissingMailboxPersistedOutcome(queued.request, outcome)) {
    await markLeaderPaneMissingDeferred({
      teamName: params.teamName,
      request: queued.request,
      cwd: params.cwd,
      messageId: message.message_id,
    });
    return outcome;
  }
  if (isConfirmedNotification(outcome)) {
    await params.deps.markMessageNotified(params.teamName, params.toWorker, message.message_id, params.cwd);
    await markDispatchRequestNotified(
      params.teamName,
      queued.request.request_id,
      { message_id: message.message_id, last_reason: outcome.reason },
      params.cwd,
    );
  } else {
    await markImmediateDispatchFailure({
      teamName: params.teamName,
      request: queued.request,
      reason: outcome.reason,
      messageId: message.message_id,
      cwd: params.cwd,
    });
  }
  return outcome;
}

export interface QueueBroadcastParams {
  teamName: string;
  fromWorker: string;
  recipients: Array<{ workerName: string; workerIndex: number; paneId?: string }>;
  body: string;
  cwd: string;
  triggerFor: (workerName: string) => string;
  transportPreference?: TeamDispatchRequestInput['transport_preference'];
  fallbackAllowed?: boolean;
  notify: TeamNotifier;
  deps: MailboxSender;
}

export async function queueBroadcastMailboxMessage(params: QueueBroadcastParams): Promise<DispatchOutcome[]> {
  const recipientNames = new Set<string>();
  const recipients = params.recipients.map((recipient, index) => {
    const duplicate = recipientNames.has(recipient.workerName);
    recipientNames.add(recipient.workerName);
    return { ...recipient, duplicate, index };
  });
  const outcomes: DispatchOutcome[] = [];
  const persistedRecipients: Array<{
    workerName: string;
    workerIndex: number;
    paneId?: string;
    triggerMessage: string;
    message: { message_id: string; to_worker: string };
    index: number;
  }> = [];

  for (const recipient of recipients) {
    if (recipient.duplicate) {
      outcomes[recipient.index] = {
        ok: false,
        transport: 'none',
        reason: 'broadcast_recipient_diverged',
        to_worker: recipient.workerName,
      };
      continue;
    }

    const triggerMessage = params.triggerFor(recipient.workerName);
    const message = await params.deps.sendDirectMessage(
      params.teamName,
      params.fromWorker,
      recipient.workerName,
      params.body,
      params.cwd,
    );
    persistedRecipients.push({ ...recipient, triggerMessage, message });
  }

  for (const recipient of persistedRecipients) {
    const queued = await enqueueDispatchRequest(
      params.teamName,
      {
        kind: 'mailbox',
        to_worker: recipient.workerName,
        worker_index: recipient.workerIndex,
        pane_id: recipient.paneId,
        trigger_message: recipient.triggerMessage,
        message_id: recipient.message.message_id,
        transport_preference: params.transportPreference,
        fallback_allowed: params.fallbackAllowed,
      },
      params.cwd,
    );

    if (queued.deduped) {
      outcomes[recipient.index] = {
        ok: false,
        transport: 'none',
        reason: 'duplicate_pending_dispatch_request',
        request_id: queued.request.request_id,
        message_id: recipient.message.message_id,
        to_worker: recipient.workerName,
      };
      continue;
    }

    if (recipient.message.to_worker !== recipient.workerName) {
      const reasonOutcome = await persistPendingReason(
        {
          teamName: params.teamName,
          recipient: recipient.workerName,
          requestId: queued.request.request_id,
          messageId: recipient.message.message_id,
          triggerMessage: recipient.triggerMessage,
          cwd: params.cwd,
        },
        mergeMailboxNotificationDependencies({
          patchPendingReason: patchPendingDispatchReason,
        }),
        'broadcast_recipient_diverged',
        true,
      );
      const { notification_managed: _managed, ...outcome } = reasonOutcome;
      outcomes[recipient.index] = {
        ...outcome,
        request_id: queued.request.request_id,
        message_id: recipient.message.message_id,
        to_worker: recipient.workerName,
      };
      continue;
    }

    const notifyOutcome = await Promise.resolve(params.notify(
      { workerName: recipient.workerName, workerIndex: recipient.workerIndex, paneId: recipient.paneId },
      recipient.triggerMessage,
      { request: queued.request, message_id: recipient.message.message_id },
    )).catch((error) => ({
      ok: false,
      transport: fallbackTransportForPreference(params.transportPreference),
      reason: notifyExceptionReason(error),
    } as DispatchOutcome));
    const { notification_managed: notificationManaged, ...outcome } = {
      ...notifyOutcome,
      request_id: queued.request.request_id,
      message_id: recipient.message.message_id,
      to_worker: recipient.workerName,
    };
    outcomes[recipient.index] = outcome;
    if (notificationManaged) continue;

    if (isConfirmedNotification(outcome)) {
      await params.deps.markMessageNotified(params.teamName, recipient.workerName, recipient.message.message_id, params.cwd);
      await markDispatchRequestNotified(
        params.teamName,
        queued.request.request_id,
        { message_id: recipient.message.message_id, last_reason: outcome.reason },
        params.cwd,
      );
    } else {
      await markImmediateDispatchFailure({
        teamName: params.teamName,
        request: queued.request,
        reason: outcome.reason,
        messageId: recipient.message.message_id,
        cwd: params.cwd,
      });
    }
  }

  return outcomes;
}

export async function waitForDispatchReceipt(
  teamName: string,
  requestId: string,
  cwd: string,
  options: { timeoutMs: number; pollMs?: number },
): Promise<TeamDispatchRequest | null> {
  const timeoutMs = Math.max(0, Math.floor(options.timeoutMs));
  let currentPollMs = Math.max(25, Math.floor(options.pollMs ?? 50));
  const maxPollMs = 500;
  const backoffFactor = 1.5;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const request = await readDispatchRequest(teamName, requestId, cwd);
    if (!request) return null;
    if (request.status === 'notified' || request.status === 'delivered' || request.status === 'failed') {
      return request;
    }
    const jitter = Math.random() * currentPollMs * 0.3;
    await new Promise((resolve) => setTimeout(resolve, currentPollMs + jitter));
    currentPollMs = Math.min(currentPollMs * backoffFactor, maxPollMs);
  }

  return await readDispatchRequest(teamName, requestId, cwd);
}
