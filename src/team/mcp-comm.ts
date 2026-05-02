/**
 * MCP Communication Layer - High-level dispatch functions.
 *
 * Coordinates inbox writes, mailbox messages, and dispatch requests
 * with notification callbacks. OMX-derived behavior is adapted to OMC contracts.
 *
 * Functions:
 * - queueInboxInstruction: write inbox + enqueue dispatch + notify
 * - queueDirectMailboxMessage: send message + enqueue dispatch + notify
 * - queueBroadcastMailboxMessage: broadcast to all recipients
 * - waitForDispatchReceipt: poll with exponential backoff
 */

import {
  enqueueDispatchRequest,
  readDispatchRequest,
  transitionDispatchRequest,
  markDispatchRequestNotified,
  type TeamDispatchRequest,
  type TeamDispatchRequestInput,
} from './dispatch-queue.js';
import type { TeamMailboxMessage } from './types.js';
import {
  broadcastMessage as defaultBroadcastMessage,
  listMailboxMessages as defaultListMailboxMessages,
  markMessageNotified as defaultMarkMessageNotified,
  sendDirectMessage as defaultSendDirectMessage,
  writeWorkerInbox as defaultWriteWorkerInbox,
} from './state.js';
import type { TeamReminderIntent } from './reminder-intents.js';
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
  sendDirectMessage(teamName: string, fromWorker: string, toWorker: string, body: string, cwd: string): Promise<TeamMailboxMessage>;
  broadcastMessage(teamName: string, fromWorker: string, body: string, cwd: string): Promise<TeamMailboxMessage[]>;
  markMessageNotified(teamName: string, workerName: string, messageId: string, cwd: string): Promise<void>;
}

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
  intent?: TeamReminderIntent;
  deps?: InboxWriter;
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
      intent: params.intent,
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
    await (params.deps?.writeWorkerInbox ?? defaultWriteWorkerInbox)(params.teamName, params.workerName, params.inbox, params.cwd);
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
  intent?: TeamReminderIntent;
  deps?: MailboxSender;
}

export async function queueDirectMailboxMessage(params: QueueDirectMessageParams): Promise<DispatchOutcome> {
  const existingMessage = (await defaultListMailboxMessages(params.teamName, params.toWorker, params.cwd))
    .find((candidate) => candidate.from_worker === params.fromWorker
      && candidate.to_worker === params.toWorker
      && candidate.body === params.body
      && candidate.notified_at
      && !candidate.delivered_at);
  if (existingMessage) {
    return {
      ok: true,
      transport: params.toWorker === 'leader-fixed' ? 'mailbox' : fallbackTransportForPreference(params.transportPreference),
      reason: 'existing_message_already_notified',
      message_id: existingMessage.message_id,
      to_worker: params.toWorker,
    };
  }

  const message = await (params.deps?.sendDirectMessage ?? defaultSendDirectMessage)(params.teamName, params.fromWorker, params.toWorker, params.body, params.cwd);
  if (message.notified_at && !message.delivered_at) {
    return {
      ok: true,
      transport: params.toWorker === 'leader-fixed' ? 'mailbox' : fallbackTransportForPreference(params.transportPreference),
      reason: 'existing_message_already_notified',
      message_id: message.message_id,
      to_worker: params.toWorker,
    };
  }

  const queued = await enqueueDispatchRequest(
    params.teamName,
    {
      kind: 'mailbox',
      to_worker: params.toWorker,
      worker_index: params.toWorkerIndex,
      pane_id: params.toPaneId,
      trigger_message: params.triggerMessage,
      intent: params.intent,
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
  const outcome: DispatchOutcome = {
    ...notifyOutcome,
    request_id: queued.request.request_id,
    message_id: message.message_id,
    to_worker: params.toWorker,
  };
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
    await (params.deps?.markMessageNotified ?? defaultMarkMessageNotified)(params.teamName, params.toWorker, message.message_id, params.cwd);
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
  intentFor?: (workerName: string) => TeamReminderIntent;
  transportPreference?: TeamDispatchRequestInput['transport_preference'];
  fallbackAllowed?: boolean;
  notify: TeamNotifier;
  intent?: TeamReminderIntent;
  deps?: MailboxSender;
}

export async function queueBroadcastMailboxMessage(params: QueueBroadcastParams): Promise<DispatchOutcome[]> {
  const messages = await (params.deps?.broadcastMessage ?? defaultBroadcastMessage)(params.teamName, params.fromWorker, params.body, params.cwd);
  const recipientByName = new Map(params.recipients.map((r) => [r.workerName, r]));
  const outcomes: DispatchOutcome[] = [];

  for (const message of messages) {
    const recipient = recipientByName.get(message.to_worker);
    if (!recipient) continue;

    const queued = await enqueueDispatchRequest(
      params.teamName,
      {
        kind: 'mailbox',
        to_worker: recipient.workerName,
        worker_index: recipient.workerIndex,
        pane_id: recipient.paneId,
        trigger_message: params.triggerFor(recipient.workerName),
        intent: params.intentFor?.(recipient.workerName),
        message_id: message.message_id,
        transport_preference: params.transportPreference,
        fallback_allowed: params.fallbackAllowed,
      },
      params.cwd,
    );

    if (queued.deduped) {
      outcomes.push({
        ok: false,
        transport: 'none',
        reason: 'duplicate_pending_dispatch_request',
        request_id: queued.request.request_id,
        message_id: message.message_id,
        to_worker: recipient.workerName,
      });
      continue;
    }

    const notifyOutcome = await Promise.resolve(params.notify(
      { workerName: recipient.workerName, workerIndex: recipient.workerIndex, paneId: recipient.paneId },
      params.triggerFor(recipient.workerName),
      { request: queued.request, message_id: message.message_id },
    )).catch((error) => ({
      ok: false,
      transport: fallbackTransportForPreference(params.transportPreference),
      reason: notifyExceptionReason(error),
    } as DispatchOutcome));

    const outcome: DispatchOutcome = {
      ...notifyOutcome,
      request_id: queued.request.request_id,
      message_id: message.message_id,
      to_worker: recipient.workerName,
    };
    outcomes.push(outcome);

    if (isConfirmedNotification(outcome)) {
      await (params.deps?.markMessageNotified ?? defaultMarkMessageNotified)(params.teamName, recipient.workerName, message.message_id, params.cwd);
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
