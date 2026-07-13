import {
  readDispatchRequestStrict,
  type StrictDispatchReadResult,
  type TeamDispatchRequest,
} from './dispatch-queue.js';
import {
  teamReadCanonicalMailboxMessageStrict,
  teamReadConfig,
  type StrictCanonicalMailboxMessageReadResult,
} from './team-ops.js';
import type { TeamConfig, TeamMailboxMessage } from './types.js';
import { canonicalizeWorkers } from './worker-canonicalization.js';

export interface MailboxNotificationGuardInput {
  teamName: string;
  recipient: string;
  requestId: string;
  messageId: string;
  triggerMessage: string;
}

export type MailboxNotificationProvider = 'tmux' | 'cmux';

export interface MailboxNotificationTarget {
  provider: MailboxNotificationProvider;
  providerTarget: string;
  recipient: string;
  recipientRole: 'leader' | 'worker';
  paneId: string;
  workerIndex?: number;
}

export type MailboxTargetOwnership =
  | {
      kind: 'owned';
      provider: MailboxNotificationProvider;
      providerTarget: string;
      paneId: string;
    }
  | { kind: 'unavailable' }
  | { kind: 'foreign' }
  | { kind: 'provider_mismatch' };

/** Fields that must remain identical between the guard's pre-effect re-reads. */
export interface MailboxNotificationSecurityTuple {
  configName: string;
  configProviderTarget: string;
  recipient: string;
  recipientRole: 'leader' | 'worker';
  canonicalPaneId: string;
  canonicalWorkerIndex?: number;
  requestId: string;
  requestKind: 'mailbox';
  requestTeamName: string;
  requestRecipient: string;
  requestMessageId: string;
  requestTriggerMessage: string;
  requestPaneId?: string;
  requestWorkerIndex?: number;
  requestTransportPreference: TeamDispatchRequest['transport_preference'];
  requestFallbackAllowed: boolean;
  requestStatus: 'pending';
  mailboxOwner: string;
  mailboxMessageId: string;
  mailboxRecipient: string;
  provider: MailboxNotificationProvider;
  providerTarget: string;
  providerPaneId: string;
}

export type MailboxNotificationGuardReason =
  | 'mailbox_team_unavailable'
  | 'mailbox_team_identity_mismatch'
  | 'mailbox_request_missing'
  | 'mailbox_dispatch_store_invalid'
  | 'mailbox_request_ambiguous'
  | 'mailbox_request_not_pending'
  | 'mailbox_request_identity_mismatch'
  | 'mailbox_target_missing'
  | 'mailbox_target_metadata_mismatch'
  | 'leader_pane_missing_deferred'
  | 'mailbox_store_invalid'
  | 'mailbox_message_missing'
  | 'mailbox_message_ambiguous'
  | 'mailbox_recipient_mismatch'
  | 'mailbox_replay_suppressed'
  | 'mailbox_provider_mismatch'
  | 'mailbox_membership_unresolvable'
  | 'mailbox_target_foreign';

export type MailboxNotificationGuardResult =
  | {
      kind: 'allow';
      target: MailboxNotificationTarget;
      request: TeamDispatchRequest;
      message: TeamMailboxMessage;
      securityTuple: MailboxNotificationSecurityTuple;
    }
  | {
      kind: 'suppress';
      reason: MailboxNotificationGuardReason;
      safePendingRequest?: TeamDispatchRequest;
      target?: MailboxNotificationTarget;
    };

export interface MailboxNotificationGuardState {
  config: TeamConfig | null;
  dispatch: StrictDispatchReadResult;
  mailbox: StrictCanonicalMailboxMessageReadResult;
  ownership?: MailboxTargetOwnership;
}

export interface MailboxNotificationGuardDependencies {
  readConfig: (teamName: string, cwd: string) => Promise<TeamConfig | null>;
  readStrictDispatchRequest: (teamName: string, requestId: string, cwd: string) => Promise<StrictDispatchReadResult>;
  readStrictMailboxMessage: (
    teamName: string,
    workerName: string,
    messageId: string,
    cwd: string,
  ) => Promise<StrictCanonicalMailboxMessageReadResult>;
  verifyProviderOwnership: (target: MailboxNotificationTarget) => Promise<MailboxTargetOwnership>;
}

function hasExactText(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value === value.trim();
}

function providerForTarget(providerTarget: string): MailboxNotificationProvider {
  return providerTarget.startsWith('cmux:') ? 'cmux' : 'tmux';
}

function dispatchFailureReason(read: Exclude<StrictDispatchReadResult, { kind: 'valid' }>): MailboxNotificationGuardReason {
  switch (read.kind) {
    case 'store_missing':
    case 'request_missing':
      return 'mailbox_request_missing';
    case 'team_mismatch':
      return 'mailbox_team_identity_mismatch';
    case 'duplicate_request_id':
    case 'ambiguous_request':
      return 'mailbox_request_ambiguous';
    case 'malformed_store':
    case 'malformed_row':
    case 'invalid_kind':
    case 'invalid_status':
      return 'mailbox_dispatch_store_invalid';
  }
  return 'mailbox_dispatch_store_invalid';
}

function mailboxFailureReason(
  read: Exclude<StrictCanonicalMailboxMessageReadResult, { kind: 'valid' }>,
): MailboxNotificationGuardReason {
  switch (read.kind) {
    case 'store_missing':
      return 'mailbox_message_missing';
    case 'malformed_store':
    case 'malformed_message':
      return 'mailbox_store_invalid';
    case 'wrong_owner':
    case 'recipient_mismatch':
      return 'mailbox_recipient_mismatch';
    case 'message_missing':
      return 'mailbox_message_missing';
    case 'duplicate_message_id':
      return 'mailbox_message_ambiguous';
    case 'replay_suppressed':
      return 'mailbox_replay_suppressed';
  }
  return 'mailbox_store_invalid';
}

function resolveCanonicalTarget(
  config: TeamConfig,
  recipient: string,
): { target: MailboxNotificationTarget } | { reason: MailboxNotificationGuardReason } {
  if (!hasExactText(config.tmux_session)) return { reason: 'mailbox_team_unavailable' };

  const providerTarget = config.tmux_session;
  const provider = providerForTarget(providerTarget);
  if (recipient === 'leader-fixed') {
    if (!hasExactText(config.leader_pane_id)) return { reason: 'leader_pane_missing_deferred' };
    return {
      target: {
        provider,
        providerTarget,
        recipient,
        recipientRole: 'leader',
        paneId: config.leader_pane_id,
      },
    };
  }

  if (!Array.isArray(config.workers)) return { reason: 'mailbox_target_missing' };
  const worker = canonicalizeWorkers(config.workers).workers.find((candidate) => candidate.name === recipient);
  if (!worker || !hasExactText(worker.pane_id)) return { reason: 'mailbox_target_missing' };
  return {
    target: {
      provider,
      providerTarget,
      recipient,
      recipientRole: 'worker',
      paneId: worker.pane_id,
      ...(typeof worker.index === 'number' && Number.isFinite(worker.index) ? { workerIndex: worker.index } : {}),
    },
  };
}

function ownershipFailureReason(ownership: MailboxTargetOwnership): MailboxNotificationGuardReason | null {
  switch (ownership.kind) {
    case 'unavailable':
      return 'mailbox_membership_unresolvable';
    case 'foreign':
      return 'mailbox_target_foreign';
    case 'provider_mismatch':
      return 'mailbox_provider_mismatch';
    case 'owned':
      return null;
  }
  return 'mailbox_membership_unresolvable';
}

/**
 * Purely evaluates current strict durable evidence. It has no transport,
 * marker, lock, or persistence effects.
 */
export function evaluateMailboxNotificationGuard(
  input: MailboxNotificationGuardInput,
  state: MailboxNotificationGuardState,
): MailboxNotificationGuardResult {
  if (!hasExactText(input.teamName)) return { kind: 'suppress', reason: 'mailbox_team_unavailable' };
  if (
    !hasExactText(input.recipient)
    || !hasExactText(input.requestId)
    || !hasExactText(input.messageId)
    || !hasExactText(input.triggerMessage)
  ) {
    return { kind: 'suppress', reason: 'mailbox_request_identity_mismatch' };
  }
  if (!state.config) return { kind: 'suppress', reason: 'mailbox_team_unavailable' };
  if (state.config.name !== input.teamName) return { kind: 'suppress', reason: 'mailbox_team_identity_mismatch' };

  if (state.dispatch.kind !== 'valid') {
    return { kind: 'suppress', reason: dispatchFailureReason(state.dispatch) };
  }
  const request = state.dispatch.request;
  if (request.status !== 'pending') return { kind: 'suppress', reason: 'mailbox_request_not_pending' };
  const safePendingRequest = { ...request };
  if (
    request.request_id !== input.requestId
    || request.team_name !== input.teamName
    || request.to_worker !== input.recipient
    || request.message_id !== input.messageId
    || request.trigger_message !== input.triggerMessage
  ) {
    return { kind: 'suppress', reason: 'mailbox_request_identity_mismatch', safePendingRequest };
  }

  const targetResolution = resolveCanonicalTarget(state.config, input.recipient);
  if ('reason' in targetResolution) {
    return { kind: 'suppress', reason: targetResolution.reason, safePendingRequest };
  }
  const target = targetResolution.target;
  if (request.pane_id !== target.paneId) {
    return { kind: 'suppress', reason: 'mailbox_target_metadata_mismatch', safePendingRequest, target };
  }
  if (request.worker_index !== undefined && request.worker_index !== target.workerIndex) {
    return { kind: 'suppress', reason: 'mailbox_target_metadata_mismatch', safePendingRequest, target };
  }

  if (state.mailbox.kind !== 'valid') {
    return { kind: 'suppress', reason: mailboxFailureReason(state.mailbox), safePendingRequest, target };
  }
  const message = state.mailbox.message;
  if (message.message_id !== input.messageId || message.to_worker !== input.recipient) {
    return { kind: 'suppress', reason: 'mailbox_recipient_mismatch', safePendingRequest, target };
  }

  const ownership = state.ownership;
  if (!ownership) return { kind: 'suppress', reason: 'mailbox_membership_unresolvable', safePendingRequest, target };
  if (ownership.kind !== 'owned') {
    return {
      kind: 'suppress',
      reason: ownershipFailureReason(ownership) ?? 'mailbox_membership_unresolvable',
      safePendingRequest,
      target,
    };
  }
  if (
    ownership.provider !== target.provider
    || ownership.providerTarget !== target.providerTarget
    || ownership.paneId !== target.paneId
  ) {
    return { kind: 'suppress', reason: 'mailbox_provider_mismatch', safePendingRequest, target };
  }

  return {
    kind: 'allow',
    target,
    request: { ...request },
    message: { ...message },
    securityTuple: {
      configName: state.config.name,
      configProviderTarget: state.config.tmux_session,
      recipient: input.recipient,
      recipientRole: target.recipientRole,
      canonicalPaneId: target.paneId,
      ...(target.workerIndex !== undefined ? { canonicalWorkerIndex: target.workerIndex } : {}),
      requestId: request.request_id,
      requestKind: 'mailbox',
      requestTeamName: request.team_name,
      requestRecipient: request.to_worker,
      requestMessageId: input.messageId,
      requestTriggerMessage: request.trigger_message,
      ...(request.pane_id !== undefined ? { requestPaneId: request.pane_id } : {}),
      ...(request.worker_index !== undefined ? { requestWorkerIndex: request.worker_index } : {}),
      requestTransportPreference: request.transport_preference,
      requestFallbackAllowed: request.fallback_allowed,
      requestStatus: 'pending',
      mailboxOwner: input.recipient,
      mailboxMessageId: message.message_id,
      mailboxRecipient: message.to_worker,
      provider: target.provider,
      providerTarget: target.providerTarget,
      providerPaneId: target.paneId,
    },
  };
}

/** Compares only authorization-relevant fields; diagnostic dispatch fields are absent by design. */
export function mailboxNotificationSecurityTupleEquals(
  left: MailboxNotificationSecurityTuple,
  right: MailboxNotificationSecurityTuple,
): boolean {
  return left.configName === right.configName
    && left.configProviderTarget === right.configProviderTarget
    && left.recipient === right.recipient
    && left.recipientRole === right.recipientRole
    && left.canonicalPaneId === right.canonicalPaneId
    && left.canonicalWorkerIndex === right.canonicalWorkerIndex
    && left.requestId === right.requestId
    && left.requestKind === right.requestKind
    && left.requestTeamName === right.requestTeamName
    && left.requestRecipient === right.requestRecipient
    && left.requestMessageId === right.requestMessageId
    && left.requestTriggerMessage === right.requestTriggerMessage
    && left.requestPaneId === right.requestPaneId
    && left.requestWorkerIndex === right.requestWorkerIndex
    && left.requestTransportPreference === right.requestTransportPreference
    && left.requestFallbackAllowed === right.requestFallbackAllowed
    && left.requestStatus === right.requestStatus
    && left.mailboxOwner === right.mailboxOwner
    && left.mailboxMessageId === right.mailboxMessageId
    && left.mailboxRecipient === right.mailboxRecipient
    && left.provider === right.provider
    && left.providerTarget === right.providerTarget
    && left.providerPaneId === right.providerPaneId;
}

/**
 * Reads current evidence through strict readers, then runs the pure evaluator.
 * The injected provider verifier must be read-only; this module has no way to
 * invoke a pane transport or write durable delivery markers.
 */
export async function readCurrentMailboxNotificationGuard(
  input: MailboxNotificationGuardInput,
  cwd: string,
  dependencies: Partial<MailboxNotificationGuardDependencies> = {},
): Promise<MailboxNotificationGuardResult> {
  const readConfig = dependencies.readConfig ?? teamReadConfig;
  const readStrictDispatch = dependencies.readStrictDispatchRequest ?? readDispatchRequestStrict;
  const readStrictMailbox = dependencies.readStrictMailboxMessage ?? teamReadCanonicalMailboxMessageStrict;

  const [config, dispatch, mailbox] = await Promise.all([
    readConfig(input.teamName, cwd).catch(() => null),
    readStrictDispatch(input.teamName, input.requestId, cwd).catch(() => ({ kind: 'malformed_store', cause: 'json' } as const)),
    readStrictMailbox(input.teamName, input.recipient, input.messageId, cwd)
      .catch(() => ({ kind: 'malformed_store', cause: 'json' } as const)),
  ]);
  const state: MailboxNotificationGuardState = { config, dispatch, mailbox };
  const initial = evaluateMailboxNotificationGuard(input, state);
  if (initial.kind !== 'suppress' || initial.reason !== 'mailbox_membership_unresolvable' || !initial.target) {
    return initial;
  }

  const ownership = dependencies.verifyProviderOwnership
    ? await dependencies.verifyProviderOwnership(initial.target).catch(() => ({ kind: 'unavailable' } as const))
    : { kind: 'unavailable' } as const;
  return evaluateMailboxNotificationGuard(input, { ...state, ownership });
}
