/**
 * The configuration of `omc graph gc` (switch, runs root, retention) and the scan that decides what happens to each
 * run. The scan modifies nothing; its verdict is a hint that removal decides again under ownership. The rules and the
 * safety notes are in run-gc.ts.
 */
import { type FileIdentity } from "./run-gc-read.js";
export declare const GC_SWITCH_ENV = "OMC_GRAPH_GC";
export declare const GC_RETENTION_ENV = "OMC_GRAPH_RETENTION_DAYS";
export declare const GC_RUNS_ROOT_ENV = "OMC_GRAPH_RUNS_ROOT";
export declare const GC_REPAIR_ENV = "OMC_GRAPH_REPAIR_TORN_WAL";
export declare const DEFAULT_RETENTION_DAYS = 7;
export declare const DEFAULT_GC_RUNS_ROOT: string;
export declare class ConfigError extends Error {
}
export interface RunEntry {
    id: string;
    decision: "keep" | "delete";
    reason: string;
    state: string | null;
    bytes: number;
    newestMs: number | null;
    identity: FileIdentity | null;
    epochFloor?: number;
    torn: boolean;
    action?: string;
    copy?: string;
    error?: string;
}
export interface GcScan {
    root: string;
    realRoot: string | null;
    retentionDays: number;
    cutoffMs: number;
    runs: RunEntry[];
    skipped: {
        id: string;
        reason: string;
    }[];
}
export declare function isSwitchOn(value: string | undefined): boolean;
export declare function parseRetentionDays(value: string | undefined): number;
export declare function resolveRunsRoot(runsRoot: string): string;
export declare function scanRuns({ runsRoot, retentionDays, currentRunId, nowMs, }: {
    runsRoot: string;
    retentionDays: number;
    currentRunId?: string | null;
    nowMs?: number;
}): GcScan;
//# sourceMappingURL=run-gc-scan.d.ts.map