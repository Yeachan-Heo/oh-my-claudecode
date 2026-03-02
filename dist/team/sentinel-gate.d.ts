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
export declare function checkSentinelReadiness(options?: SentinelReadinessOptions): SentinelGateResult;
//# sourceMappingURL=sentinel-gate.d.ts.map