/**
 * The command line of `omc graph gc`: the text report and the exit codes. The rules and the safety notes are in
 * run-gc.ts.
 */
import { runGc } from "./run-gc-pass.js";
import { ConfigError, DEFAULT_GC_RUNS_ROOT, GC_REPAIR_ENV, GC_RETENTION_ENV, GC_RUNS_ROOT_ENV, GC_SWITCH_ENV, isSwitchOn, parseRetentionDays, } from "./run-gc-scan.js";
const COMMAND_NAME = "omc graph gc";
const ACTION_LABEL = {
    keep: "KEEP",
    "would-delete": "WOULD-DELETE",
    deleted: "DELETED",
    failed: "FAILED",
    "would-repair": "WOULD-REPAIR",
    repaired: "REPAIRED",
    "repair-failed": "REPAIR-FAILED",
};
export function formatText(result) {
    const lines = [
        `omc graph gc: root=${result.root} retention_days=${result.retention_days} switch=${result.switch ? "on" : "off"} repair_torn_wal=${result.repair_torn_wal ? "on" : "off"}`,
    ];
    if (!result.switch)
        lines.push(`switch ${GC_SWITCH_ENV} is not "1": nothing is deleted or repaired`);
    for (const run of result.runs) {
        const state = run.state === null ? "" : ` state=${run.state}`;
        const copy = run.copy === undefined ? "" : ` copy=${run.copy}`;
        const error = run.error === undefined ? "" : ` error=${JSON.stringify(run.error)}`;
        lines.push(`${ACTION_LABEL[run.action ?? "keep"]} ${run.id} reason=${run.reason}${state} bytes=${run.bytes}${copy}${error}`);
    }
    for (const skipped of result.skipped) {
        lines.push(`SKIP ${JSON.stringify(skipped.id)} reason=${skipped.reason}`);
    }
    const s = result.summary;
    lines.push(`summary: runs=${s.runs} candidates=${s.candidates} deleted=${s.deleted} failed=${s.failed} ` +
        `bytes_candidates=${s.bytes_candidates} bytes_deleted=${s.bytes_deleted} ` +
        `repaired=${s.repaired} repair_failed=${s.repair_failed}`);
    return lines.join("\n");
}
/**
 * CLI body of `omc graph gc`. Exit codes: 0 ok, 1 a removal or repair failed,
 * 2 usage or configuration error. `deps.remove` replaces the removal step (tests only).
 */
export function runGraphGc(args, env, out, err, deps = {}) {
    let options;
    try {
        options = {
            runsRoot: args.runsRoot ?? env[GC_RUNS_ROOT_ENV] ?? DEFAULT_GC_RUNS_ROOT,
            retentionDays: args.retentionDays !== undefined
                ? parseRetentionDays(args.retentionDays)
                : parseRetentionDays(env[GC_RETENTION_ENV]),
            currentRunId: args.current,
            enabled: isSwitchOn(env[GC_SWITCH_ENV]),
            repairTornWal: args.repairTornWal || env[GC_REPAIR_ENV] === "1",
        };
    }
    catch (error) {
        if (error instanceof ConfigError) {
            err.write(`${COMMAND_NAME}: ${error.message}\n`);
            return 2;
        }
        throw error;
    }
    let result;
    try {
        result = runGc({ ...options, remove: deps.remove });
    }
    catch (error) {
        if (error instanceof ConfigError) {
            err.write(`${COMMAND_NAME}: ${error.message}\n`);
            return 2;
        }
        err.write(`${COMMAND_NAME}: ${error.message}\n`);
        return 1;
    }
    out.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatText(result)}\n`);
    return result.summary.failed > 0 || result.summary.repair_failed > 0 ? 1 : 0;
}
//# sourceMappingURL=run-gc-cli.js.map