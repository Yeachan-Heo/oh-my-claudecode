/**
 * One pass of `omc graph gc`: scan, then repair or remove each run. The rules and the safety notes are in run-gc.ts.
 */
import { join } from "node:path";
import { removeRun } from "./run-gc-remove.js";
import { repairTornTail } from "./run-gc-repair.js";
import { scanRuns } from "./run-gc-scan.js";
// Runs one pass. `remove` is injectable for tests; it defaults to removeRun.
export function runGc(options) {
    const enabled = options.enabled === true;
    const repairRequested = options.repairTornWal === true;
    const nowMs = options.nowMs ?? Date.now();
    const remove = options.remove ?? removeRun;
    const scan = scanRuns({ ...options, nowMs });
    let deleted = 0;
    let failed = 0;
    let candidates = 0;
    let bytesCandidates = 0;
    let bytesDeleted = 0;
    let repaired = 0;
    let repairFailed = 0;
    for (const run of scan.runs) {
        if (run.torn) {
            if (!repairRequested) {
                run.action = "keep";
            }
            else if (!enabled) {
                run.action = "would-repair";
            }
            else {
                try {
                    const outcome = repairTornTail(join(scan.realRoot, run.id), nowMs, run.identity ?? undefined);
                    run.action = outcome.repaired ? "repaired" : "keep";
                    if (outcome.repaired) {
                        run.copy = outcome.copy ?? undefined;
                        repaired += 1;
                    }
                }
                catch (error) {
                    run.action = "repair-failed";
                    run.error = error.message;
                    repairFailed += 1;
                }
            }
            continue;
        }
        if (run.decision !== "delete") {
            run.action = "keep";
            continue;
        }
        candidates += 1;
        bytesCandidates += run.bytes;
        if (!enabled) {
            run.action = "would-delete";
            continue;
        }
        try {
            remove(scan.realRoot, run.id, {
                identity: run.identity,
                cutoffMs: scan.cutoffMs,
                epochFloor: run.epochFloor ?? 0,
            });
            run.action = "deleted";
            deleted += 1;
            bytesDeleted += run.bytes;
        }
        catch (error) {
            run.action = "failed";
            run.error = error.message;
            failed += 1;
        }
    }
    return {
        root: scan.root,
        retention_days: scan.retentionDays,
        cutoff_iso: new Date(scan.cutoffMs).toISOString(),
        switch: enabled,
        repair_torn_wal: repairRequested,
        runs: scan.runs.map((run) => ({
            id: run.id,
            action: run.action,
            reason: run.reason,
            state: run.state,
            bytes: run.bytes,
            newest_iso: run.newestMs === null ? null : new Date(run.newestMs).toISOString(),
            ...(run.copy === undefined ? {} : { copy: run.copy }),
            ...(run.error === undefined ? {} : { error: run.error }),
        })),
        skipped: scan.skipped,
        summary: {
            runs: scan.runs.length,
            candidates,
            deleted,
            failed,
            bytes_candidates: bytesCandidates,
            bytes_deleted: bytesDeleted,
            repaired,
            repair_failed: repairFailed,
        },
    };
}
//# sourceMappingURL=run-gc-pass.js.map