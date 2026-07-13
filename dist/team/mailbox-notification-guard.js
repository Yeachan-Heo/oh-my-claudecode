import { readDispatchRequestStrict, } from './dispatch-queue.js';
import { teamReadCanonicalMailboxMessageStrict, teamReadConfig, } from './team-ops.js';
import { canonicalizeWorkers } from './worker-canonicalization.js';
function hasExactText(value) {
    return typeof value === 'string' && value !== '' && value === value.trim();
}
function providerForTarget(providerTarget) {
    return providerTarget.startsWith('cmux:') ? 'cmux' : 'tmux';
}
function dispatchFailureReason(read) {
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
function mailboxFailureReason(read) {
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
function resolveCanonicalTarget(config, recipient) {
    if (!hasExactText(config.tmux_session))
        return { reason: 'mailbox_team_unavailable' };
    const providerTarget = config.tmux_session;
    const provider = providerForTarget(providerTarget);
    if (recipient === 'leader-fixed') {
        if (!hasExactText(config.leader_pane_id))
            return { reason: 'leader_pane_missing_deferred' };
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
    if (!Array.isArray(config.workers))
        return { reason: 'mailbox_target_missing' };
    const worker = canonicalizeWorkers(config.workers).workers.find((candidate) => candidate.name === recipient);
    if (!worker || !hasExactText(worker.pane_id))
        return { reason: 'mailbox_target_missing' };
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
function ownershipFailureReason(ownership) {
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
export function evaluateMailboxNotificationGuard(input, state) {
    if (!hasExactText(input.teamName))
        return { kind: 'suppress', reason: 'mailbox_team_unavailable' };
    if (!hasExactText(input.recipient)
        || !hasExactText(input.requestId)
        || !hasExactText(input.messageId)
        || !hasExactText(input.triggerMessage)) {
        return { kind: 'suppress', reason: 'mailbox_request_identity_mismatch' };
    }
    if (!state.config)
        return { kind: 'suppress', reason: 'mailbox_team_unavailable' };
    if (state.config.name !== input.teamName)
        return { kind: 'suppress', reason: 'mailbox_team_identity_mismatch' };
    if (state.dispatch.kind !== 'valid') {
        return { kind: 'suppress', reason: dispatchFailureReason(state.dispatch) };
    }
    const request = state.dispatch.request;
    if (request.status !== 'pending')
        return { kind: 'suppress', reason: 'mailbox_request_not_pending' };
    const safePendingRequest = { ...request };
    if (request.request_id !== input.requestId
        || request.team_name !== input.teamName
        || request.to_worker !== input.recipient
        || request.message_id !== input.messageId
        || request.trigger_message !== input.triggerMessage) {
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
    if (!ownership)
        return { kind: 'suppress', reason: 'mailbox_membership_unresolvable', safePendingRequest, target };
    if (ownership.kind !== 'owned') {
        return {
            kind: 'suppress',
            reason: ownershipFailureReason(ownership) ?? 'mailbox_membership_unresolvable',
            safePendingRequest,
            target,
        };
    }
    if (ownership.provider !== target.provider
        || ownership.providerTarget !== target.providerTarget
        || ownership.paneId !== target.paneId) {
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
export function mailboxNotificationSecurityTupleEquals(left, right) {
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
export async function readCurrentMailboxNotificationGuard(input, cwd, dependencies = {}) {
    const readConfig = dependencies.readConfig ?? teamReadConfig;
    const readStrictDispatch = dependencies.readStrictDispatchRequest ?? readDispatchRequestStrict;
    const readStrictMailbox = dependencies.readStrictMailboxMessage ?? teamReadCanonicalMailboxMessageStrict;
    const [config, dispatch, mailbox] = await Promise.all([
        readConfig(input.teamName, cwd).catch(() => null),
        readStrictDispatch(input.teamName, input.requestId, cwd).catch(() => ({ kind: 'malformed_store', cause: 'json' })),
        readStrictMailbox(input.teamName, input.recipient, input.messageId, cwd)
            .catch(() => ({ kind: 'malformed_store', cause: 'json' })),
    ]);
    const state = { config, dispatch, mailbox };
    const initial = evaluateMailboxNotificationGuard(input, state);
    if (initial.kind !== 'suppress' || initial.reason !== 'mailbox_membership_unresolvable' || !initial.target) {
        return initial;
    }
    const ownership = dependencies.verifyProviderOwnership
        ? await dependencies.verifyProviderOwnership(initial.target).catch(() => ({ kind: 'unavailable' }))
        : { kind: 'unavailable' };
    return evaluateMailboxNotificationGuard(input, { ...state, ownership });
}
//# sourceMappingURL=mailbox-notification-guard.js.map