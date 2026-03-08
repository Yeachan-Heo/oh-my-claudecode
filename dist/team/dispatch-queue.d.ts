/**
 * Dispatch Queue - Low-level file-based dispatch request operations.
 *
 * Manages dispatch/requests.json with atomic read/write, dedup, and
 * directory-based locking (O_EXCL mkdir) with stale lock detection.
 *
 * State file: .omc/state/team/{name}/dispatch/requests.json
 * Lock path:  .omc/state/team/{name}/dispatch/.lock/
 *
 * Mirrors OMX src/team/state/dispatch.ts behavior exactly.
 */
export type TeamDispatchRequestKind = 'inbox' | 'mailbox' | 'nudge';
export type TeamDispatchRequestStatus = 'pending' | 'notified' | 'delivered' | 'failed';
export type TeamDispatchTransportPreference = 'hook_preferred_with_fallback' | 'transport_direct' | 'prompt_stdin';
export interface TeamDispatchRequest {
    request_id: string;
    kind: TeamDispatchRequestKind;
    team_name: string;
    to_worker: string;
    worker_index?: number;
    pane_id?: string;
    trigger_message: string;
    message_id?: string;
    inbox_correlation_key?: string;
    transport_preference: TeamDispatchTransportPreference;
    fallback_allowed: boolean;
    status: TeamDispatchRequestStatus;
    attempt_count: number;
    created_at: string;
    updated_at: string;
    notified_at?: string;
    delivered_at?: string;
    failed_at?: string;
    last_reason?: string;
}
export interface TeamDispatchRequestInput {
    kind: TeamDispatchRequestKind;
    to_worker: string;
    worker_index?: number;
    pane_id?: string;
    trigger_message: string;
    message_id?: string;
    inbox_correlation_key?: string;
    transport_preference?: TeamDispatchTransportPreference;
    fallback_allowed?: boolean;
    last_reason?: string;
}
export declare function resolveDispatchLockTimeoutMs(env?: NodeJS.ProcessEnv): number;
export declare function normalizeDispatchRequest(teamName: string, raw: Partial<TeamDispatchRequest>, nowIso?: string): TeamDispatchRequest | null;
export declare function enqueueDispatchRequest(teamName: string, requestInput: TeamDispatchRequestInput, cwd: string): Promise<{
    request: TeamDispatchRequest;
    deduped: boolean;
}>;
export declare function listDispatchRequests(teamName: string, cwd: string, opts?: {
    status?: TeamDispatchRequestStatus;
    kind?: TeamDispatchRequestKind;
    to_worker?: string;
    limit?: number;
}): Promise<TeamDispatchRequest[]>;
export declare function readDispatchRequest(teamName: string, requestId: string, cwd: string): Promise<TeamDispatchRequest | null>;
export declare function transitionDispatchRequest(teamName: string, requestId: string, from: TeamDispatchRequestStatus, to: TeamDispatchRequestStatus, patch: Partial<TeamDispatchRequest> | undefined, cwd: string): Promise<TeamDispatchRequest | null>;
export declare function markDispatchRequestNotified(teamName: string, requestId: string, patch: Partial<TeamDispatchRequest> | undefined, cwd: string): Promise<TeamDispatchRequest | null>;
export declare function markDispatchRequestDelivered(teamName: string, requestId: string, patch: Partial<TeamDispatchRequest> | undefined, cwd: string): Promise<TeamDispatchRequest | null>;
//# sourceMappingURL=dispatch-queue.d.ts.map