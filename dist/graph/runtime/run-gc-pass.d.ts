/**
 * One pass of `omc graph gc`: scan, then repair or remove each run. The rules and the safety notes are in run-gc.ts.
 */
import { type ScannedRun } from "./run-gc-remove.js";
export interface GcResult {
    root: string;
    retention_days: number;
    cutoff_iso: string;
    switch: boolean;
    repair_torn_wal: boolean;
    runs: {
        id: string;
        action: string | undefined;
        reason: string;
        state: string | null;
        bytes: number;
        newest_iso: string | null;
        copy?: string;
        error?: string;
    }[];
    skipped: {
        id: string;
        reason: string;
    }[];
    summary: {
        runs: number;
        candidates: number;
        deleted: number;
        failed: number;
        bytes_candidates: number;
        bytes_deleted: number;
        repaired: number;
        repair_failed: number;
    };
}
export interface GcRunOptions {
    runsRoot: string;
    retentionDays: number;
    currentRunId?: string | null;
    enabled?: boolean;
    repairTornWal?: boolean;
    nowMs?: number;
    remove?: (realRoot: string, id: string, scanned?: ScannedRun) => void;
}
export declare function runGc(options: GcRunOptions): GcResult;
//# sourceMappingURL=run-gc-pass.d.ts.map