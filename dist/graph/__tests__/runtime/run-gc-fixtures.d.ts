/**
 * Helpers of the `omc graph gc` tests: temporary runs roots, runs in each state, the CLI driver and the stand-ins for
 * the directory-relative operations of other platforms. Every test builds its own runs root in a temporary directory
 * (`withBase`), and the files that use it remove those directories after each test (`removeTempBases`).
 */
import { type OperationsFor, runGc, type ScannedRun } from "../../runtime/run-gc.js";
import { type RealRunKind } from "./real-run-fixtures.js";
export declare const DAY: number;
export declare const NOW: number;
export declare const OLD: number;
export declare const FRESH: number;
export declare const HASH: string;
export declare const OTHER_HASH: string;
export declare const GC_ENV_NAMES: string[];
export declare const tempBases: string[];
export declare function removeTempBases(): void;
export declare const REPO_ROOT: string;
export declare const CLI_ENTRY: string;
export declare function makeFifo(path: string): void;
/** Runs `omc graph gc <args>` in-process and captures stdout, stderr and the exit code. */
export declare function runCli(args: string[], env?: Record<string, string | undefined>): Promise<{
    code: number;
    out: string;
    err: string;
}>;
export declare function captureStream(stream: NodeJS.WriteStream, sink: (text: string) => void): {
    restore: () => void;
};
export declare function withEnvAsync<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T>;
export declare function resign(record: Record<string, unknown>): string;
export declare function runRuntimeChain(root: string, id: string, options: {
    failFirst?: boolean;
    stopAfterFirst?: boolean;
}): Promise<string>;
export declare function withBase<T>(fn: (base: string) => T): T;
export declare function makeRoot(base: string): string;
export declare function makeRun(root: string, id: string, files?: Record<string, string>): string;
export declare function ageTree(dir: string, ms: number): void;
export declare function snapshot(base: string): string;
export declare function deadPid(): number;
export interface Decision {
    id: string;
    action?: string;
    reason: string;
    state: string | null;
    copy?: string;
    error?: string;
}
export declare function decisionOf(result: {
    runs: Decision[];
}, id: string): Decision;
export declare function descriptorFor(id: string): {
    descriptor_hash: string;
    run_id: string;
    revision_id: string;
    nodes: {
        id: string;
        kind: string;
        title: string;
    }[];
    edges: never[];
};
export declare function journalText(count: number): string;
export declare function projectionFor(id: string, { activations, cohorts, committed, terminal }: Omit<Scenario, "count" | "expected">): {
    descriptor_hash: string;
    run_id: string;
    revision_id: string;
    activations: Record<string, unknown>;
    cohorts: Record<string, unknown>;
    branch_tokens: {};
    traversal_counts: {};
    committed_transitions: Record<string, unknown>;
    terminal_verification_activation_ids: string[];
};
export declare function envelopeFor(id: string, projection: unknown, savedAtSeq: number): {
    schema_version: number;
    descriptor_hash: string;
    run_id: string;
    revision_id: string;
    epoch: number;
    saved_at_seq: number;
    projection: unknown;
};
export declare function activation(id: string, nodeId: string, status: string, extra?: Record<string, unknown>): {
    activation_id: string;
    node_id: string;
    status: string;
};
export interface Scenario {
    count: number;
    activations: Record<string, unknown>;
    cohorts?: Record<string, unknown>;
    committed: Record<string, unknown>;
    terminal: string[];
    expected?: string;
}
export declare const SCENARIOS: Record<string, Scenario & {
    expected: string;
}>;
export declare function makeScenarioRun(root: string, id: string, scenario: Scenario, options?: {
    descriptor?: string;
    journal?: string;
    projection?: string | null;
    savedAtSeq?: number;
}): string;
export declare const finishedJournals: Map<string, string>;
export declare function makeFinishedRun(root: string, id: string): string;
export declare function makeRealRun(root: string, id: string, kind: RealRunKind, epoch?: number): string;
export declare function gc(root: string, extra?: Partial<Parameters<typeof runGc>[0]>): import("../../runtime/run-gc-pass.js").GcResult;
export declare function scannedFirst(root: string): ScannedRun;
export declare const operationCalls: string[];
export declare const macLike: OperationsFor;
export declare const noOperations: OperationsFor;
export declare const KINDS_WITH_OPERATIONS: readonly (readonly [string, OperationsFor | undefined])[];
export declare function makeTornRun(root: string, id: string, tailText?: string): string;
/** Async variant of withBase for tests that drive the CLI. */
export declare function withBaseAsync<T>(fn: (base: string) => Promise<T>): Promise<T>;
//# sourceMappingURL=run-gc-fixtures.d.ts.map