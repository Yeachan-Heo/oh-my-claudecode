import type { TeamReminderIntent } from './reminder-intents.js';
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
    intent?: TeamReminderIntent;
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
    intent?: TeamReminderIntent;
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