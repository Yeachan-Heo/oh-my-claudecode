/**
 * The command line of `omc graph gc`: the text report and the exit codes. The rules and the safety notes are in
 * run-gc.ts.
 */
import { type GcResult, type GcRunOptions } from "./run-gc-pass.js";
export declare function formatText(result: GcResult): string;
export interface GraphGcArgs {
    readonly runsRoot?: string;
    readonly retentionDays?: string;
    readonly current: string | null;
    readonly repairTornWal: boolean;
    readonly json: boolean;
}
interface Writer {
    write(text: string): unknown;
}
/**
 * CLI body of `omc graph gc`. Exit codes: 0 ok, 1 a removal or repair failed,
 * 2 usage or configuration error. `deps.remove` replaces the removal step (tests only).
 */
export declare function runGraphGc(args: GraphGcArgs, env: NodeJS.ProcessEnv, out: Writer, err: Writer, deps?: {
    remove?: GcRunOptions["remove"];
}): number;
export {};
//# sourceMappingURL=run-gc-cli.d.ts.map