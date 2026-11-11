export interface SessionEndBootstrapInput {
    session_id: string;
    transcript_path: string;
    cwd: string;
    permission_mode: string;
    hook_event_name: 'SessionEnd';
    reason: 'clear' | 'logout' | 'prompt_input_exit' | 'other';
}
export interface SessionEndBootstrapResult {
    continue: true;
}
/**
 * Publish the durable core cleanup intent (without sealing it) and hand off
 * to the existing worker. Core stays `prepared`, not `sealed`: sealing is
 * the worker's job via `recoverPreparedCoreProducer`, performed only after
 * `foreground-cleanup` durably completes. Sealing here would leave
 * `producers.core.state !== 'prepared'` permanently, which blocks the
 * worker's producer-grace bypass for `foreground-cleanup` and stalls the job.
 */
export declare function publishSessionEndBootstrap(input: SessionEndBootstrapInput): Promise<SessionEndBootstrapResult>;
export default publishSessionEndBootstrap;
//# sourceMappingURL=foreground-bootstrap.d.ts.map