export interface SentinelReadinessOptions {
    logPath?: string;
    workspace?: string;
    claims?: Record<string, unknown>;
    enabled?: boolean;
}
export interface SentinelGateResult {
    ready: boolean;
    blockers: string[];
    skipped: boolean;
}
export interface SentinelWaitOptions extends SentinelReadinessOptions {
    timeoutMs?: number;
    pollIntervalMs?: number;
}
export interface SentinelWaitResult extends SentinelGateResult {
    timedOut: boolean;
    elapsedMs: number;
    attempts: number;
}
export declare function checkSentinelReadiness(options?: SentinelReadinessOptions): SentinelGateResult;
export declare function waitForSentinelReadiness(options?: SentinelWaitOptions): Promise<SentinelWaitResult>;
//# sourceMappingURL=sentinel-gate.d.ts.map