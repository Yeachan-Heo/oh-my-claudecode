/**
 * Team dispatch hook: drain pending dispatch requests via tmux injection.
 *
 * Mirrors OMX scripts/notify-hook/team-dispatch.js behavior exactly.
 *
 * Called on every leader hook tick. Workers skip (OMC_TEAM_WORKER set).
 * Processes pending dispatch requests with:
 * - Hook-preferred transport only (skips transport_direct, prompt_stdin)
 * - Post-injection verification (3 rounds x 250ms)
 * - Issue cooldown (15 min per issue key)
 * - Trigger cooldown (30s per trigger text)
 * - Max unconfirmed attempts (3) before marking failed
 * - Leader pane missing -> deferred
 */
interface DispatchRequest {
    request_id: string;
    kind: string;
    team_name: string;
    to_worker: string;
    worker_index?: number;
    pane_id?: string;
    trigger_message: string;
    message_id?: string;
    transport_preference: string;
    fallback_allowed: boolean;
    status: string;
    attempt_count: number;
    created_at: string;
    updated_at: string;
    notified_at?: string;
    delivered_at?: string;
    failed_at?: string;
    last_reason?: string;
}
interface TeamConfig {
    workers?: Array<{
        name: string;
        index?: number;
        pane_id?: string;
        worker_cli?: string;
    }>;
    tmux_session?: string;
    leader_pane_id?: string;
}
export interface InjectionResult {
    ok: boolean;
    reason: string;
    pane?: string;
}
export type Injector = (request: DispatchRequest, config: TeamConfig, cwd: string) => Promise<InjectionResult>;
export interface DrainResult {
    processed: number;
    skipped: number;
    failed: number;
    reason?: string;
}
export declare function drainPendingTeamDispatch(options?: {
    cwd: string;
    stateDir?: string;
    logsDir?: string;
    maxPerTick?: number;
    injector?: Injector;
}): Promise<DrainResult>;
export {};
//# sourceMappingURL=team-dispatch-hook.d.ts.map