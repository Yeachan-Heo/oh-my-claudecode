/**
 * Helpers of the `omc graph gc` tests: temporary runs roots, runs in each state, the CLI driver and the stand-ins for
 * the directory-relative operations of other platforms. Every test builds its own runs root in a temporary directory
 * (`withBase`), and the files that use it remove those directories after each test (`removeTempBases`).
 */

import { it } from "vitest";
import { CommanderError } from "commander";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { graphCommand } from "../../../cli/graph.js";
import { sealGraphDescriptor, canonicalJson } from "../../descriptor.js";
import { directoryOperations } from "../../runtime/contained-fd.js";
import { computeJournalFingerprint } from "../../runtime/journal.js";
import { type OperationsFor, runGc, scanRuns, type ScannedRun } from "../../runtime/run-gc.js";
import { runGraph } from "../../runtime/runner.js";
import { type NodeExecutor } from "../../runtime/types.js";
import { writeRealRun, type RealRunKind } from "./real-run-fixtures.js";

export const DAY = 24 * 60 * 60 * 1000;
export const NOW = Date.now();
export const OLD = NOW - 30 * DAY;
export const FRESH = NOW - 60 * 1000;
export const HASH = "a".repeat(64);
export const OTHER_HASH = "b".repeat(64);
export const GC_ENV_NAMES = ["OMC_GRAPH_GC", "OMC_GRAPH_RETENTION_DAYS", "OMC_GRAPH_RUNS_ROOT", "OMC_GRAPH_REPAIR_TORN_WAL"];

export const tempBases: string[] = [];

export function removeTempBases(): void {
  for (const base of tempBases.splice(0)) rmSync(base, { recursive: true, force: true });
}

export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
export const CLI_ENTRY = fileURLToPath(new URL("../../../cli/index.ts", import.meta.url));

export function makeFifo(path: string): void {
  const made = spawnSync("mkfifo", [path]);
  if (made.status !== 0) throw new Error(`mkfifo failed: ${made.stderr}`);
}


/** Runs `omc graph gc <args>` in-process and captures stdout, stderr and the exit code. */
export async function runCli(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ code: number; out: string; err: string }> {
  const cleared = Object.fromEntries(GC_ENV_NAMES.map((name) => [name, undefined]));
  let out = "";
  let err = "";
  const outSpy = captureStream(process.stdout, (text) => (out += text));
  const errSpy = captureStream(process.stderr, (text) => (err += text));
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await withEnvAsync({ ...cleared, ...env }, () => graphCommand().parseAsync(["gc", ...args], { from: "user" }));
    return { code: Number(process.exitCode ?? 0), out, err };
  } catch (error) {
    if (error instanceof CommanderError) return { code: error.exitCode, out, err };
    throw error;
  } finally {
    outSpy.restore();
    errSpy.restore();
    process.exitCode = previousExitCode;
  }
}

export function captureStream(stream: NodeJS.WriteStream, sink: (text: string) => void): { restore: () => void } {
  const original = stream.write;
  stream.write = ((chunk: string | Uint8Array) => {
    sink(String(chunk));
    return true;
  }) as typeof stream.write;
  return {
    restore: () => {
      stream.write = original;
    },
  };
}

export async function withEnvAsync<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const name of Object.keys(vars)) previous.set(name, process.env[name]);
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// Re-signs a journal record that a test edited, so that only the rule under test can refuse it.
export function resign(record: Record<string, unknown>): string {
  const { journal_fingerprint: _old, ...unsigned } = record;
  return canonicalJson({ ...unsigned, journal_fingerprint: computeJournalFingerprint(unsigned as never) });
}

// Runs a two-step chain through the runtime itself, with in-process steps. Returns how the run ended.
export async function runRuntimeChain(
  root: string,
  id: string,
  options: { failFirst?: boolean; stopAfterFirst?: boolean },
): Promise<string> {
  const node = (nodeId: string) => ({
    id: nodeId,
    kind: "command" as const,
    title: nodeId,
    timeout_ms: 60_000,
    max_attempts: 1,
    effect_policy: { policy: "side_effect_free" as const },
    command: "unused",
  });
  const sealed = sealGraphDescriptor({
    descriptor_version: 1,
    run_id: id,
    revision_id: `rev-${id}`,
    goal: "differential",
    nodes: [node("step-1"), node("step-2")],
    edges: [{ id: "e-1-2", kind: "fixed" as const, from: "step-1", to: "step-2" }],
    entry_node_ids: ["step-1"],
    concurrency_limit: 1,
    terminal_verification_node_id: "step-2",
  });
  const controller = new AbortController();
  const executor: NodeExecutor = {
    kinds: ["command", "agent"],
    execute: async (context) => {
      if (options.stopAfterFirst === true && context.node.id === "step-1") controller.abort();
      return {
        outcome: options.failFirst === true && context.node.id === "step-1" ? "failed" : "succeeded",
        output_summary: "done",
        evidence_refs: [{ kind: "command", ref: "unused" }],
      };
    },
  };
  try {
    const result = await runGraph(sealed, { runsRoot: root, executors: [executor], prompter: { prompt: async () => "approved" }, signal: controller.signal });
    return result.terminal;
  } catch {
    return "aborted";
  }
}

export function withBase<T>(fn: (base: string) => T): T {
  const base = mkdtempSync(join(os.tmpdir(), "graph-runs-gc-test-"));
  tempBases.push(base);
  return fn(base);
}

export function makeRoot(base: string): string {
  const root = join(base, ".omc", "graph-runs");
  mkdirSync(root, { recursive: true });
  return root;
}

export function makeRun(root: string, id: string, files: Record<string, string> = { "descriptor.json": "{}\n", "journal.jsonl": "line\n" }): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

// Sets the modification time of every entry below `dir`, and of `dir`, to `ms`.
// Symbolic links get their own times (lutimes), so a link cannot inherit a target's age.
export function ageTree(dir: string, ms: number): void {
  const when = new Date(ms);
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) ageTree(path, ms);
    if (stat.isSymbolicLink()) lutimesSync(path, when, when);
    else utimesSync(path, when, when);
  }
  utimesSync(dir, when, when);
}

// Deterministic description of every entry below `base`: path, type, size, mtime and content hash.
export function snapshot(base: string): string {
  const rows: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      let body = "";
      if (stat.isFile()) body = createHash("sha256").update(readFileSync(path)).digest("hex");
      if (stat.isSymbolicLink()) body = readlinkSync(path);
      const type = stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "link" : "file";
      rows.push([path.slice(base.length), type, stat.size, stat.mtimeMs, body].join("|"));
      if (stat.isDirectory()) visit(path);
    }
  };
  visit(base);
  return rows.join("\n");
}

export function deadPid(): number {
  // The child has exited and been reaped when spawnSync returns, so its pid is no longer alive.
  return spawnSync(process.execPath, ["-e", ""]).pid as number;
}

export interface Decision {
  id: string;
  action?: string;
  reason: string;
  state: string | null;
  copy?: string;
  error?: string;
}

export function decisionOf(result: { runs: Decision[] }, id: string): Decision {
  const run = result.runs.find((entry) => entry.id === id);
  if (run === undefined) throw new Error(`no decision for ${id}`);
  return run;
}

// ---- Run fixtures -------------------------------------------------------------------------------
// A run is described by three files: descriptor.json, journal.jsonl and projection.json. The
// scenarios below build the snapshot that the runtime would leave behind in each state.

export function descriptorFor(id: string) {
  return {
    descriptor_hash: HASH,
    run_id: id,
    revision_id: "rev-1",
    nodes: [
      { id: "n1", kind: "agent", title: "work" },
      { id: "v1", kind: "agent", title: "verify" },
      { id: "ap", kind: "human-approval", title: "approve" },
    ],
    edges: [],
  };
}

// Journal with `count` complete records, seq 0 .. count-1.
export function journalText(count: number): string {
  let text = "";
  for (let seq = 0; seq < count; seq += 1) {
    text += `${JSON.stringify({ seq, epoch: 1, descriptor_hash: HASH, transition: { seq }, journal_fingerprint: "0".repeat(64) })}\n`;
  }
  return text;
}

export function projectionFor(
  id: string,
  { activations, cohorts = {}, committed = {}, terminal = [] }: Omit<Scenario, "count" | "expected">,
) {
  return {
    descriptor_hash: HASH,
    run_id: id,
    revision_id: "rev-1",
    activations,
    cohorts,
    branch_tokens: {},
    traversal_counts: {},
    committed_transitions: committed,
    terminal_verification_activation_ids: terminal,
  };
}

export function envelopeFor(id: string, projection: unknown, savedAtSeq: number) {
  return {
    schema_version: 1,
    descriptor_hash: HASH,
    run_id: id,
    revision_id: "rev-1",
    epoch: 1,
    saved_at_seq: savedAtSeq,
    projection,
  };
}

export function activation(id: string, nodeId: string, status: string, extra: Record<string, unknown> = {}) {
  return { activation_id: id, node_id: nodeId, status, ...extra };
}

export interface Scenario {
  count: number;
  activations: Record<string, unknown>;
  cohorts?: Record<string, unknown>;
  committed: Record<string, unknown>;
  terminal: string[];
  expected?: string;
}

// Fabricated runs for the tests of retention, locks and torn-journal repair. Their descriptor is not a sealed one, so
// the runtime's replay cannot read them and gc keeps them as unknown; the tests that decide on a run's state use
// writeRealRun (real-run-fixtures.ts) instead.
export const SCENARIOS: Record<string, Scenario & { expected: string }> = {
  // The process stopped while an attempt was running. An aborted run looks the same.
  running: {
    count: 1,
    activations: { a1: activation("a1", "n1", "running") },
    committed: {},
    terminal: ["a1"],
    expected: "resumable-running",
  },
  // Nothing has started yet.
  ready: {
    count: 1,
    activations: { a1: activation("a1", "n1", "ready") },
    committed: {},
    terminal: ["a1"],
    expected: "resumable-ready",
  },
};

// Writes a run built from a scenario. Options can replace any of the three files.
export function makeScenarioRun(
  root: string,
  id: string,
  scenario: Scenario,
  options: { descriptor?: string; journal?: string; projection?: string | null; savedAtSeq?: number } = {},
): string {
  const descriptor = options.descriptor ?? JSON.stringify(descriptorFor(id));
  const journal = options.journal ?? journalText(scenario.count);
  // An explicit `projection: null` means "no snapshot file", so test for the key, not for nullishness.
  const projection = Object.prototype.hasOwnProperty.call(options, "projection")
    ? options.projection
    : JSON.stringify(envelopeFor(id, projectionFor(id, scenario), options.savedAtSeq ?? scenario.count - 1));
  const files: Record<string, string> = { "descriptor.json": descriptor, "journal.jsonl": journal };
  if (projection !== null && projection !== undefined) files["projection.json"] = projection;
  return makeRun(root, id, files);
}

// The journal text of every run written by makeFinishedRun, by directory.
export const finishedJournals = new Map<string, string>();

// A run that finished successfully (final state), as the runtime leaves it.
export function makeFinishedRun(root: string, id: string): string {
  return makeRealRun(root, id, "succeeded");
}

// A run of the given kind written the way the runtime writes it (descriptor, journal and snapshot of a real run).
export function makeRealRun(root: string, id: string, kind: RealRunKind, epoch = 1): string {
  const run = writeRealRun(root, id, kind, epoch);
  finishedJournals.set(run.dir, run.journal);
  return run.dir;
}

export function gc(root: string, extra: Partial<Parameters<typeof runGc>[0]> = {}) {
  return runGc({ runsRoot: root, retentionDays: 7, enabled: true, nowMs: NOW, ...extra });
}

// What a removal gets from a scan of the runs root, for the first run the scan lists.
export function scannedFirst(root: string): ScannedRun {
  const scan = scanRuns({ runsRoot: root, retentionDays: 7, nowMs: NOW });
  const run = scan.runs[0] as { identity: { dev: number; ino: number } | null; epochFloor?: number };
  return { identity: run.identity as { dev: number; ino: number }, cutoffMs: scan.cutoffMs, epochFloor: run.epochFloor ?? 0 };
}

// Stand-ins for the directory-relative operations of other platforms, so that on Linux the code those platforms run is
// exercised. `macLike` plays macOS with the native module: the operations of Linux without `rmdir` (the native module has
// none) and with the entry fields the native module returns, every call recorded. `noOperations` plays a platform
// that has none (Windows).
export const operationCalls: string[] = [];
export const macLike: OperationsFor = (fd) => {
  const real = directoryOperations(fd, "linux");
  const { rmdir: _rmdir, ...withoutRmdir } = real;
  return {
    ...withoutRmdir,
    open: (name, flags, mode) => { operationCalls.push(`open ${name}`); return real.open(name, flags, mode); },
    // What the native module returns for an entry: these six fields and the type tests derived from the mode.
    lstat: (name) => {
      operationCalls.push(`lstat ${name}`);
      const { dev, ino, mode, nlink, size, mtimeMs } = real.lstat(name);
      return {
        dev, ino, mode, nlink, size, mtimeMs,
        isFile: () => (mode & 0o170000) === 0o100000,
        isDirectory: () => (mode & 0o170000) === 0o040000,
        isSymbolicLink: () => (mode & 0o170000) === 0o120000,
      };
    },
    readDir: () => { operationCalls.push("readDir"); return real.readDir(); },
    unlink: (name) => { operationCalls.push(`unlink ${name}`); real.unlink(name); },
  };
};
export const noOperations: OperationsFor = () => null;
// Every platform that has operations: Linux itself (the default) and the stand-in for macOS.
export const KINDS_WITH_OPERATIONS: readonly (readonly [string, OperationsFor | undefined])[] = [
  ["Linux", undefined],
  ["a platform with operations and no rmdir", macLike],
];


// A run whose journal ends in an incomplete line. `tailText` is what the writer got out before the cut.
export function makeTornRun(root: string, id: string, tailText = '{"seq":1,"epoch":1,"descr'): string {
  return makeScenarioRun(root, id, SCENARIOS.ready, { journal: `${journalText(1)}${tailText}` });
}
/** Async variant of withBase for tests that drive the CLI. */
export async function withBaseAsync<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const base = mkdtempSync(join(os.tmpdir(), "graph-runs-gc-test-"));
  tempBases.push(base);
  return fn(base);
}
