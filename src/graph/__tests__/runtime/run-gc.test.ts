/**
 * Tests for `omc graph gc` (retention and torn-journal repair of graph run directories).
 *
 * Every test builds its own runs root in a temporary directory. Nothing outside that directory is
 * touched. Dead pids come from child processes that already exited; no process is killed.
 * The CLI cases go through the real `graph gc` command; the library cases call runGc directly.
 */

import { afterEach, describe, expect, it } from "vitest";
import { CommanderError } from "commander";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  linkSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { graphCommand } from "../../../cli/graph.js";
import { sealGraphDescriptor, canonicalJson } from "../../descriptor.js";
import { runGraph } from "../../runtime/runner.js";
import { computeJournalFingerprint } from "../../runtime/journal.js";
import { readRunStatus } from "../../runtime/run-status.js";
import type { NodeExecutor } from "../../runtime/types.js";
import { FileOwnershipFence } from "../../runtime/fence.js";
import { resolveRunDirHandle } from "../../runtime/run-dir.js";
import { writeRealRun, type RealRunKind } from "./real-run-fixtures.js";
import {
  classifyRun,
  DEFAULT_RETENTION_DAYS,
  isSwitchOn,
  parseRetentionDays,
  quarantineRun,
  removeRun,
  removeTree,
  repairTornTail,
  type RepairInterlock,
  runGc,
  runGraphGc,
  scanRuns,
  type ScannedRun,
} from "../../runtime/run-gc.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const OLD = NOW - 30 * DAY;
const FRESH = NOW - 60 * 1000;
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const GC_ENV_NAMES = ["OMC_GRAPH_GC", "OMC_GRAPH_RETENTION_DAYS", "OMC_GRAPH_RUNS_ROOT", "OMC_GRAPH_REPAIR_TORN_WAL"];

const tempBases: string[] = [];

// Symbolic links need privileges on Windows and the no-follow guarantee is POSIX-only.
const itSymlink = process.platform === "win32" ? it.skip : it;
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CLI_ENTRY = fileURLToPath(new URL("../../../cli/index.ts", import.meta.url));

function makeFifo(path: string): void {
  const made = spawnSync("mkfifo", [path]);
  if (made.status !== 0) throw new Error(`mkfifo failed: ${made.stderr}`);
}

afterEach(() => {
  for (const base of tempBases.splice(0)) rmSync(base, { recursive: true, force: true });
});

/** Runs `omc graph gc <args>` in-process and captures stdout, stderr and the exit code. */
async function runCli(
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

function captureStream(stream: NodeJS.WriteStream, sink: (text: string) => void): { restore: () => void } {
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

async function withEnvAsync<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
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
function resign(record: Record<string, unknown>): string {
  const { journal_fingerprint: _old, ...unsigned } = record;
  return canonicalJson({ ...unsigned, journal_fingerprint: computeJournalFingerprint(unsigned as never) });
}

// Runs a two-step chain through the runtime itself, with in-process steps. Returns how the run ended.
async function runRuntimeChain(
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

function withBase<T>(fn: (base: string) => T): T {
  const base = mkdtempSync(join(os.tmpdir(), "graph-runs-gc-test-"));
  tempBases.push(base);
  return fn(base);
}

function makeRoot(base: string): string {
  const root = join(base, ".omc", "graph-runs");
  mkdirSync(root, { recursive: true });
  return root;
}

function makeRun(root: string, id: string, files: Record<string, string> = { "descriptor.json": "{}\n", "journal.jsonl": "line\n" }): string {
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
function ageTree(dir: string, ms: number): void {
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
function snapshot(base: string): string {
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

function deadPid(): number {
  // The child has exited and been reaped when spawnSync returns, so its pid is no longer alive.
  return spawnSync(process.execPath, ["-e", ""]).pid as number;
}

interface Decision {
  id: string;
  action?: string;
  reason: string;
  state: string | null;
  copy?: string;
  error?: string;
}

function decisionOf(result: { runs: Decision[] }, id: string): Decision {
  const run = result.runs.find((entry) => entry.id === id);
  if (run === undefined) throw new Error(`no decision for ${id}`);
  return run;
}

// ---- Run fixtures -------------------------------------------------------------------------------
// A run is described by three files: descriptor.json, journal.jsonl and projection.json. The
// scenarios below build the snapshot that the runtime would leave behind in each state.

function descriptorFor(id: string) {
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
function journalText(count: number): string {
  let text = "";
  for (let seq = 0; seq < count; seq += 1) {
    text += `${JSON.stringify({ seq, epoch: 1, descriptor_hash: HASH, transition: { seq }, journal_fingerprint: "0".repeat(64) })}\n`;
  }
  return text;
}

function projectionFor(
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

function envelopeFor(id: string, projection: unknown, savedAtSeq: number) {
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

function activation(id: string, nodeId: string, status: string, extra: Record<string, unknown> = {}) {
  return { activation_id: id, node_id: nodeId, status, ...extra };
}

interface Scenario {
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
const SCENARIOS: Record<string, Scenario & { expected: string }> = {
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
function makeScenarioRun(
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
const finishedJournals = new Map<string, string>();

// A run that finished successfully (final state), as the runtime leaves it.
function makeFinishedRun(root: string, id: string): string {
  return makeRealRun(root, id, "succeeded");
}

// A run of the given kind written the way the runtime writes it (descriptor, journal and snapshot of a real run).
function makeRealRun(root: string, id: string, kind: RealRunKind, epoch = 1): string {
  const run = writeRealRun(root, id, kind, epoch);
  finishedJournals.set(run.dir, run.journal);
  return run.dir;
}

function gc(root: string, extra: Partial<Parameters<typeof runGc>[0]> = {}) {
  return runGc({ runsRoot: root, retentionDays: 7, enabled: true, nowMs: NOW, ...extra });
}

// What a removal gets from a scan of the runs root, for the first run the scan lists.
function scannedFirst(root: string): ScannedRun {
  const scan = scanRuns({ runsRoot: root, retentionDays: 7, nowMs: NOW });
  const run = scan.runs[0] as { identity: { dev: number; ino: number } | null; epochFloor?: number };
  return { identity: run.identity as { dev: number; ino: number }, cutoffMs: scan.cutoffMs, epochFloor: run.epochFloor ?? 0 };
}

describe("omc graph gc", () => {
  // ---- Switch, configuration and basic retention ------------------------------------------------

  it('the switch is on only for exactly "1"', () => {
    expect(isSwitchOn("1")).toBe(true);
    for (const value of ["0", "true", "on", "yes", "", " 1", "1 ", "01", undefined]) {
      expect(isSwitchOn(value), `value ${JSON.stringify(value)} must not switch on`).toBe(false);
    }
  });

  it("retention days: positive integers only, default 7", () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(7);
    expect(parseRetentionDays(undefined)).toBe(7);
    expect(parseRetentionDays("1")).toBe(1);
    expect(parseRetentionDays("36500")).toBe(36500);
    for (const value of ["0", "-1", "abc", "", "7.5", " 7", "1e3", "36501", "99999999"]) {
      expect(() => parseRetentionDays(value), `value ${JSON.stringify(value)} must be refused`).toThrow(/retention days/);
    }
  });

  it("switch off: nothing is deleted or written, both through the library and the CLI", async () => {
    await withBaseAsync(async (base) => {
      const root = makeRoot(base);
      makeFinishedRun(root, "run-old");
      makeRun(root, "run-fresh");
      ageTree(join(root, "run-old"), OLD);
      const before = snapshot(base);
      const removals: string[] = [];

      const lib = runGc({
        runsRoot: root,
        retentionDays: 7,
        enabled: false,
        nowMs: NOW,
        remove: (_realRoot, id) => removals.push(id),
      });
      expect(decisionOf(lib, "run-old").action).toBe("would-delete");
      expect(decisionOf(lib, "run-fresh").action).toBe("keep");
      expect(removals, "removal must not be called with the switch off").toEqual([]);
      expect(snapshot(base), "library run with the switch off changed the tree").toBe(before);

      for (const env of [{}, { OMC_GRAPH_GC: "0" }, { OMC_GRAPH_GC: "true" }]) {
        const cli = await runCli(["--runs-root", root], env);
        expect(cli.code, cli.err).toBe(0);
        expect(cli.out).toMatch(/WOULD-DELETE run-old reason=expired/);
        expect(cli.out).toMatch(/nothing is deleted/);
        expect(snapshot(base), `CLI with ${JSON.stringify(env)} changed the tree`).toBe(before);
      }
    });
  });

  it("switch on: an expired final run is removed and a fresh run is kept", () => {
    withBase((base) => {
      const root = makeRoot(base);
      makeFinishedRun(root, "run-old");
      makeRun(root, "run-fresh");
      ageTree(join(root, "run-old"), OLD);

      const result = gc(root);
      expect(decisionOf(result, "run-old").action).toBe("deleted");
      expect(decisionOf(result, "run-old").state).toBe("final-succeeded");
      expect(decisionOf(result, "run-fresh").action).toBe("keep");
      expect(decisionOf(result, "run-fresh").reason).toBe("fresh");
      expect(existsSync(join(root, "run-old"))).toBe(false);
      expect(existsSync(join(root, "run-fresh", "journal.jsonl"))).toBe(true);
      expect(result.summary.deleted).toBe(1);
      expect(result.summary.failed).toBe(0);
    });
  });

  it("a run whose directory looks old but holds one fresh entry is kept", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-mixed");
      ageTree(dir, OLD);
      utimesSync(join(dir, "journal.jsonl"), new Date(FRESH), new Date(FRESH));

      const result = gc(root);
      expect(decisionOf(result, "run-mixed").reason).toBe("fresh");
      expect(existsSync(dir)).toBe(true);
    });
  });

  it("an owner.lock held by a live process keeps an expired run", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-live");
      writeFileSync(join(dir, "owner.lock"), JSON.stringify({ pid: process.pid, epoch: 1, timestamp: OLD }));
      ageTree(dir, OLD);

      const result = gc(root);
      expect(decisionOf(result, "run-live").reason).toBe("lock-live-pid");
      expect(decisionOf(result, "run-live").action).toBe("keep");
      expect(existsSync(dir)).toBe(true);
    });
  });

  it("an owner.lock whose pid is dead does not protect an expired final run", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-stale");
      writeFileSync(join(dir, "owner.lock"), JSON.stringify({ pid: deadPid(), epoch: 1, timestamp: OLD }));
      ageTree(dir, OLD);

      const result = gc(root);
      expect(decisionOf(result, "run-stale").action).toBe("deleted");
      expect(existsSync(dir)).toBe(false);
    });
  });

  it("an unreadable owner.lock keeps the run (fail closed)", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-garbage");
      writeFileSync(join(dir, "owner.lock"), "not json");
      ageTree(dir, OLD);

      const result = gc(root);
      expect(decisionOf(result, "run-garbage").reason).toBe("lock-unparseable");
      expect(existsSync(dir)).toBe(true);
    });
  });

  it("the current run is kept even when it is expired and final", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-current");
      ageTree(dir, OLD);

      const result = gc(root, { currentRunId: "run-current" });
      expect(decisionOf(result, "run-current").reason).toBe("current");
      expect(existsSync(dir)).toBe(true);
    });
  });

  itSymlink("a symbolic link at the top level of the runs root is never followed or removed", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const outside = join(base, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "keep.txt"), "outside content\n");
      symlinkSync(outside, join(root, "run-link"));
      const before = snapshot(outside);

      const result = gc(root);
      expect(result.skipped.some((s) => s.id === "run-link" && s.reason === "symbolic-link")).toBe(true);
      expect(lstatSync(join(root, "run-link")).isSymbolicLink()).toBe(true);
      expect(snapshot(outside)).toBe(before);
    });
  });

  itSymlink("a link inside an expired final run is unlinked and its target survives", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const outside = join(base, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "keep.txt"), "outside content\n");
      const dir = makeFinishedRun(root, "run-with-link");
      const link = join(dir, "target-link");
      symlinkSync(outside, link);
      // Old run tree; the outside directory keeps its fresh mtime, so following the link would make the run look fresh.
      ageTree(dir, OLD);
      const before = snapshot(outside);

      const result = gc(root);
      expect(decisionOf(result, "run-with-link").action).toBe("deleted");
      expect(existsSync(dir)).toBe(false);
      expect(snapshot(outside), "the link target was modified").toBe(before);
    });
  });

  itSymlink("a symbolic link as the runs root is refused and nothing below it is removed", async () => {
    await withBaseAsync(async (base) => {
      const real = join(base, "real-graph-runs");
      mkdirSync(join(base, "x", ".omc"), { recursive: true });
      mkdirSync(real);
      const dir = makeFinishedRun(real, "run-old");
      ageTree(dir, OLD);
      symlinkSync(real, join(base, "x", ".omc", "graph-runs"));

      const cli = await runCli(["--runs-root", join(base, "x", ".omc", "graph-runs")], { OMC_GRAPH_GC: "1" });
      expect(cli.code).toBe(2);
      expect(cli.err).toMatch(/symbolic link/);
      expect(existsSync(dir)).toBe(true);
    });
  });

  itSymlink("a linked .omc directory is refused: the resolved runs root must also be named .omc/graph-runs", async () => {
    await withBaseAsync(async (base) => {
      const target = join(base, "E-target");
      const dir = makeFinishedRun(join(target, "graph-runs"), "run-old");
      ageTree(dir, OLD);
      mkdirSync(join(base, "E"));
      symlinkSync(target, join(base, "E", ".omc"));

      const cli = await runCli(["--runs-root", join(base, "E", ".omc", "graph-runs")], { OMC_GRAPH_GC: "1" });
      expect(cli.code).toBe(2);
      expect(cli.err).toMatch(/must resolve to a directory named \.omc\/graph-runs/);
      expect(existsSync(dir), "the run behind the linked .omc was removed").toBe(true);
    });
  });

  it("the runs root must be named .omc/graph-runs", async () => {
    await withBaseAsync(async (base) => {
      const plain = join(base, "other");
      const dir = makeFinishedRun(plain, "run-old");
      ageTree(dir, OLD);
      const wrongParent = join(base, "data", "graph-runs");
      makeFinishedRun(wrongParent, "run-old");
      for (const bad of [plain, wrongParent]) {
        const cli = await runCli(["--runs-root", bad], { OMC_GRAPH_GC: "1" });
        expect(cli.code, `root ${bad} must be refused`).toBe(2);
        expect(cli.err).toMatch(/\.omc\/graph-runs/);
      }
      expect(existsSync(dir)).toBe(true);
    });
  });

  it("an invalid retention value stops the run before anything is deleted", async () => {
    await withBaseAsync(async (base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-old");
      ageTree(dir, OLD);
      for (const args of [["--retention-days", "0"], ["--retention-days", "-1"], ["--retention-days", "abc"]]) {
        const cli = await runCli(["--runs-root", root, ...args], { OMC_GRAPH_GC: "1" });
        expect(cli.code, `args ${args.join(" ")} must be refused`).toBe(2);
        expect(existsSync(dir)).toBe(true);
      }
      const fromEnv = await runCli(["--runs-root", root], { OMC_GRAPH_GC: "1", OMC_GRAPH_RETENTION_DAYS: "" });
      expect(fromEnv.code).toBe(2);
      expect(existsSync(dir)).toBe(true);
    });
  });

  it("entries that are not run ids or not directories are never touched", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const spaced = join(root, "not a run");
      mkdirSync(spaced);
      writeFileSync(join(spaced, "x"), "x");
      writeFileSync(join(root, "stray.txt"), "stray\n");
      ageTree(spaced, OLD);
      utimesSync(join(root, "stray.txt"), new Date(OLD), new Date(OLD));
      const before = snapshot(base);

      const result = gc(root);
      expect(result.summary.candidates).toBe(0);
      expect(result.skipped.some((s) => s.reason === "not-a-run-id")).toBe(true);
      expect(result.skipped.some((s) => s.reason === "not-a-directory")).toBe(true);
      expect(snapshot(base)).toBe(before);
    });
  });

  it("a missing runs root is reported as nothing to do and is not created", async () => {
    await withBaseAsync(async (base) => {
      const cli = await runCli(["--runs-root", join(base, ".omc", "graph-runs")], { OMC_GRAPH_GC: "1" });
      expect(cli.code, cli.err).toBe(0);
      expect(existsSync(join(base, ".omc"))).toBe(false);
    });
  });

  it("CLI with the switch on prints per-run lines and a summary", async () => {
    await withBaseAsync(async (base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-old");
      makeRun(root, "run-fresh");
      ageTree(dir, OLD);

      const cli = await runCli(["--runs-root", root, "--retention-days", "7"], { OMC_GRAPH_GC: "1" });
      expect(cli.code, cli.err).toBe(0);
      expect(cli.out).toMatch(/^DELETED run-old reason=expired state=final-succeeded/m);
      expect(cli.out).toMatch(/^KEEP run-fresh reason=fresh/m);
      expect(cli.out).toMatch(/summary: runs=2 candidates=1 deleted=1 failed=0/);
      expect(existsSync(dir)).toBe(false);
    });
  });

  it("CLI --json gives a machine-readable result with the switch state", async () => {
    await withBaseAsync(async (base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-old");
      ageTree(dir, OLD);

      const cli = await runCli(["--runs-root", root, "--json"]);
      expect(cli.code, cli.err).toBe(0);
      const parsed = JSON.parse(cli.out);
      expect(parsed.switch).toBe(false);
      expect(parsed.retention_days).toBe(7);
      expect(parsed.repair_torn_wal).toBe(false);
      expect(parsed.summary.candidates).toBe(1);
      expect(parsed.summary.deleted).toBe(0);
      expect(decisionOf(parsed, "run-old").action).toBe("would-delete");
      expect(decisionOf(parsed, "run-old").state).toBe("final-succeeded");
      expect(existsSync(dir)).toBe(true);
    });
  });

  it("retention from the environment applies without a flag, and the flag overrides it", async () => {
    await withBaseAsync(async (base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-ten-days");
      ageTree(dir, NOW - 10 * DAY);

      const fromEnv = await runCli(["--runs-root", root], { OMC_GRAPH_GC: "1", OMC_GRAPH_RETENTION_DAYS: "30" });
      expect(fromEnv.code, fromEnv.err).toBe(0);
      expect(existsSync(dir), "env retention 30 must keep a 10-day-old run").toBe(true);

      const fromFlag = await runCli(["--runs-root", root, "--retention-days", "5"], {
        OMC_GRAPH_GC: "1",
        OMC_GRAPH_RETENTION_DAYS: "30",
      });
      expect(fromFlag.code, fromFlag.err).toBe(0);
      expect(existsSync(dir), "flag retention 5 must remove the 10-day-old run").toBe(false);
    });
  });

  // ---- Run states: the replay of the journal decides, the snapshot never does -------------------

  const STATE_CASES: { kind: RealRunKind; expected: string }[] = [
    { kind: "succeeded", expected: "final-succeeded" },
    { kind: "failed", expected: "final-failed" },
    { kind: "denied", expected: "final-failed" },
    { kind: "ready", expected: "resumable-ready" },
    { kind: "approval", expected: "resumable-approval" },
    // An attempt that was running when the process stopped is never committed, so the replay leaves it ready.
    { kind: "initial", expected: "resumable-ready" },
  ];

  for (const { kind, expected } of STATE_CASES) {
    it(`state ${expected}: ${kind} run`, () => {
      withBase((base) => {
        const root = makeRoot(base);
        const dir = makeRealRun(root, "run-state", kind);
        ageTree(dir, OLD);

        const classified = classifyRun(dir, "run-state");
        expect(classified.state).toBe(expected);

        const result = gc(root);
        const run = decisionOf(result, "run-state");
        expect(run.state).toBe(expected);
        if (expected.startsWith("final-")) {
          expect(run.action, "a final run past retention must be removed").toBe("deleted");
          expect(existsSync(dir)).toBe(false);
        } else {
          expect(run.action, "a resumable run must never be removed").toBe("keep");
          expect(run.reason).toBe(expected);
          expect(existsSync(join(dir, "projection.json"))).toBe(true);
        }
      });
    });
  }

  function editSnapshot(dir: string, edit: (envelope: Record<string, any>) => void): void {
    const file = join(dir, "projection.json");
    const envelope = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
    edit(envelope);
    writeFileSync(file, JSON.stringify(envelope));
  }

  const setActivationStatus = (status: string) => (envelope: Record<string, any>) => {
    for (const activation of Object.values(envelope.projection.activations) as Record<string, any>[]) activation.status = status;
  };

  // Damage to projection.json. The runtime folds every journal record and treats the snapshot as a status cache, so
  // none of these changes the verdict of a run whose journal replays.
  const SNAPSHOT_DAMAGE: { name: string; damage: (dir: string) => void }[] = [
    { name: "missing", damage: (dir) => rmSync(join(dir, "projection.json")) },
    { name: "not JSON", damage: (dir) => writeFileSync(join(dir, "projection.json"), "not json") },
    { name: "older than the journal", damage: (dir) => editSnapshot(dir, (envelope) => { envelope.saved_at_seq = -1; }) },
    { name: "bound to another descriptor", damage: (dir) => editSnapshot(dir, (envelope) => { envelope.descriptor_hash = OTHER_HASH; }) },
    { name: "naming another run", damage: (dir) => editSnapshot(dir, (envelope) => { envelope.projection.run_id = "other-run"; }) },
    { name: "restored with every activation failed, at the right seq", damage: (dir) => editSnapshot(dir, setActivationStatus("failed")) },
    { name: "restored with every activation completed, at the right seq", damage: (dir) => editSnapshot(dir, setActivationStatus("completed")) },
    { name: "restored with every activation ready, at the right seq", damage: (dir) => editSnapshot(dir, setActivationStatus("ready")) },
    { name: "valid JSON with an emptied body", damage: (dir) => editSnapshot(dir, (envelope) => { envelope.projection.activations = {}; }) },
    { name: "valid JSON with an unknown activation status", damage: (dir) => editSnapshot(dir, setActivationStatus("paused")) },
  ];

  for (const { kind, expected } of [
    { kind: "succeeded" as const, expected: "final-succeeded" },
    { kind: "failed" as const, expected: "final-failed" },
    { kind: "ready" as const, expected: "resumable-ready" },
    { kind: "approval" as const, expected: "resumable-approval" },
  ]) {
    for (const { name, damage } of SNAPSHOT_DAMAGE) {
      it(`a ${kind} run is ${expected} whatever its snapshot is: ${name}`, () => {
        withBase((base) => {
          const root = makeRoot(base);
          const dir = makeRealRun(root, "run-cache", kind);
          damage(dir);
          ageTree(dir, OLD);
          expect(classifyRun(dir, "run-cache").state).toBe(expected);

          const run = decisionOf(gc(root), "run-cache");
          expect(run.state).toBe(expected);
          if (expected.startsWith("final-")) {
            expect(run.action).toBe("deleted");
            expect(existsSync(dir)).toBe(false);
          } else {
            expect(run.action, "a resumable run was removed on the word of its snapshot").toBe("keep");
            expect(existsSync(dir)).toBe(true);
          }
        });
      });
    }
  }

  // Each case leaves one piece of the run unreadable or inconsistent for the replay. Every one must be kept.
  const UNKNOWN_CASES: {
    name: string;
    reason: string;
    build: (root: string, id: string, base: string) => string;
  }[] = [
    {
      name: "descriptor missing",
      reason: "unknown:descriptor-missing",
      build: (root, id) => {
        const dir = makeRealRun(root, id, "succeeded");
        rmSync(join(dir, "descriptor.json"));
        return dir;
      },
    },
    {
      name: "descriptor is not JSON",
      reason: "unknown:descriptor-malformed",
      build: (root, id) => {
        const dir = makeRealRun(root, id, "succeeded");
        writeFileSync(join(dir, "descriptor.json"), "{not json");
        return dir;
      },
    },
    {
      name: "descriptor is not a sealed descriptor (the hash does not match)",
      reason: "unknown:descriptor-malformed",
      build: (root, id) => {
        const dir = makeRealRun(root, id, "succeeded");
        const descriptor = JSON.parse(readFileSync(join(dir, "descriptor.json"), "utf8")) as Record<string, unknown>;
        writeFileSync(join(dir, "descriptor.json"), JSON.stringify({ ...descriptor, goal: "another goal" }));
        return dir;
      },
    },
    {
      name: "descriptor names another run",
      reason: "unknown:descriptor-not-of-run",
      build: (root, id) => {
        const dir = makeRealRun(root, id, "succeeded");
        const other = writeRealRun(root, "run-other", "succeeded");
        writeFileSync(join(dir, "descriptor.json"), readFileSync(join(other.dir, "descriptor.json")));
        rmSync(other.dir, { recursive: true });
        return dir;
      },
    },
    {
      name: "journal file missing although the snapshot has committed records",
      reason: "unknown:no-history",
      build: (root, id) => {
        const dir = makeRealRun(root, id, "succeeded");
        rmSync(join(dir, "journal.jsonl"));
        return dir;
      },
    },
    {
      name: "descriptor without a journal and without the initial snapshot",
      reason: "unknown:no-history",
      build: (root, id) => {
        const dir = makeRealRun(root, id, "initial");
        rmSync(join(dir, "projection.json"));
        return dir;
      },
    },
    {
      name: "journal emptied behind a snapshot that has committed records",
      reason: "unknown:no-history",
      build: (root, id) => {
        const dir = makeRealRun(root, id, "succeeded");
        writeFileSync(join(dir, "journal.jsonl"), "");
        return dir;
      },
    },
    {
      name: "journal sequence has a gap",
      reason: "unknown:journal-corrupt",
      build: (root, id) => {
        const dir = makeRealRun(root, id, "succeeded");
        const lines = readFileSync(join(dir, "journal.jsonl"), "utf8").split("\n").filter((line) => line !== "");
        writeFileSync(join(dir, "journal.jsonl"), `${lines[1]}\n`);
        return dir;
      },
    },
    {
      name: "journal record edited after it was committed (fails its fingerprint)",
      reason: "unknown:replay-rejected",
      build: (root, id) => {
        const dir = makeRealRun(root, id, "succeeded");
        const text = readFileSync(join(dir, "journal.jsonl"), "utf8");
        expect(text).toContain('"output_summary":"succeeded"');
        writeFileSync(join(dir, "journal.jsonl"), text.replace('"output_summary":"succeeded"', '"output_summary":"changed"'));
        return dir;
      },
    },
    {
      name: "journal copied from another run (records bound to another descriptor)",
      reason: "unknown:replay-rejected",
      build: (root, id) => {
        const dir = makeRealRun(root, id, "succeeded");
        const other = writeRealRun(root, "run-other", "succeeded");
        writeFileSync(join(dir, "journal.jsonl"), other.journal);
        rmSync(other.dir, { recursive: true });
        return dir;
      },
    },
    {
      name: "journal records with epochs that decrease",
      reason: "unknown:replay-rejected",
      build: (root, id) => {
        const dir = makeRealRun(root, id, "succeeded");
        const [first, second] = readFileSync(join(dir, "journal.jsonl"), "utf8").split("\n").filter((line) => line !== "");
        const raised = JSON.parse(first) as Record<string, unknown>;
        raised.epoch = 3;
        // The record is re-signed, so only the epoch rule can refuse the run.
        writeFileSync(join(dir, "journal.jsonl"), `${resign(raised)}\n${second}\n`);
        return dir;
      },
    },
    {
      name: "snapshot is a symbolic link",
      reason: "unknown:projection.json-not-a-regular-file",
      build: (root, id, base) => {
        const dir = makeRealRun(root, id, "succeeded");
        const outside = join(base, "outside-projection.json");
        writeFileSync(outside, readFileSync(join(dir, "projection.json")));
        rmSync(join(dir, "projection.json"));
        symlinkSync(outside, join(dir, "projection.json"));
        return dir;
      },
    },
  ];

  for (const unknownCase of UNKNOWN_CASES) {
    const runCase = unknownCase.name === "snapshot is a symbolic link" ? itSymlink : it;
    runCase(`unknown state is kept (fail closed): ${unknownCase.name}`, () => {
      withBase((base) => {
        const root = makeRoot(base);
        const dir = unknownCase.build(root, "run-unknown", base);
        ageTree(dir, OLD);
        const before = snapshot(base);

        const result = gc(root);
        const run = decisionOf(result, "run-unknown");
        expect(run.action).toBe("keep");
        expect(run.reason).toBe(unknownCase.reason);
        expect(run.state).toBe("unknown");
        expect(existsSync(dir)).toBe(true);
        expect(snapshot(base), "an unknown run must not be modified").toBe(before);
      });
    });
  }

  it("a journal whose epoch is above the epoch the lock gives is not removed: a resume would refuse it too", () => {
    withBase((base) => {
      const root = makeRoot(base);
      // No owner.epoch and no lock: the fence hands out epoch 1, and the records say 3.
      const dir = makeRealRun(root, "run-ahead", "succeeded", 3);
      ageTree(dir, OLD);
      // The scan has no ceiling, so it proposes the removal; the replay under ownership, which has one, refuses it.
      const result = gc(root);
      const run = decisionOf(result, "run-ahead");
      expect(run.action).toBe("failed");
      expect(run.error).toMatch(/run changed after the scan \(unknown:replay-rejected\); not removed/);
      expect(existsSync(dir)).toBe(true);
    });
  });

  it("gc and status give the state the runtime gives, on runs the runtime wrote", async () => {
    await withBaseAsync(async (base) => {
      const root = makeRoot(base);
      const cases: { id: string; expected: "succeeded" | "failed" | "in_progress"; chain: Parameters<typeof runRuntimeChain>[2] }[] = [
        { id: "rt-ok", expected: "succeeded", chain: {} },
        { id: "rt-fail", expected: "failed", chain: { failFirst: true } },
        { id: "rt-stopped", expected: "in_progress", chain: { stopAfterFirst: true } },
      ];
      for (const { id, expected, chain } of cases) {
        const result = await runRuntimeChain(root, id, chain);
        const dir = join(root, id);
        const gcState = classifyRun(dir, id).state;
        const status = JSON.parse(readRunStatus({ runId: id, runsRoot: root }).stdout) as { state: string };
        const gcExpected = { succeeded: "final-succeeded", failed: "final-failed", in_progress: "resumable-ready" }[expected];
        expect({ id, terminal: result }, `${id}: the runtime ended it differently`).toEqual({ id, terminal: expected === "in_progress" ? "aborted" : expected });
        expect(gcState, `${id}: gc state`).toBe(gcExpected);
        expect(status.state, `${id}: status state`).toBe(expected);
      }
    });
  });

  // ---- Torn journal repair ---------------------------------------------------------------------

  // A run whose journal ends in an incomplete line. `tailText` is what the writer got out before the cut.
  function makeTornRun(root: string, id: string, tailText = '{"seq":1,"epoch":1,"descr'): string {
    return makeScenarioRun(root, id, SCENARIOS.ready, { journal: `${journalText(1)}${tailText}` });
  }

  it("a torn last line is moved to a copy and the complete lines are unchanged byte for byte", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeTornRun(root, "run-torn");
      const journal = join(dir, "journal.jsonl");
      const prefix = journalText(1);
      const prefixHash = createHash("sha256").update(prefix).digest("hex");

      const result = gc(root, { repairTornWal: true, nowMs: NOW });
      const run = decisionOf(result, "run-torn");
      expect(run.action).toBe("repaired");
      expect(run.reason).toBe("torn-wal");
      expect(result.summary.repaired).toBe(1);
      expect(result.summary.repair_failed).toBe(0);

      const after = readFileSync(journal, "utf8");
      expect(createHash("sha256").update(after).digest("hex"), "complete lines changed").toBe(prefixHash);
      expect(after).toBe(prefix);
      const copy = readFileSync(join(dir, run.copy as string), "utf8");
      expect(copy, "the torn tail must be kept in the copy").toBe('{"seq":1,"epoch":1,"descr');
      expect(existsSync(dir), "a repaired run is never removed in the same pass").toBe(true);
    });
  });

  it("a repaired run keeps its torn copy: the next pass keeps the run and does not delete the copy", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeTornRun(root, "run-copy");
      gc(root, { repairTornWal: true, nowMs: NOW });
      ageTree(dir, OLD);

      const result = gc(root, { repairTornWal: true, nowMs: NOW + 1000 });
      const run = decisionOf(result, "run-copy");
      expect(run.action).toBe("keep");
      expect(run.reason).toBe("torn-copy-kept");
      expect(readdirSync(dir).filter((name) => name.startsWith("journal.jsonl.torn-")).length).toBe(1);
    });
  });

  it("a torn copy from an earlier repair keeps an expired final run", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-with-copy");
      writeFileSync(join(dir, "journal.jsonl.torn-2026-11-01T00-00-00-000Z"), "partial");
      ageTree(dir, OLD);

      const result = gc(root);
      expect(decisionOf(result, "run-with-copy").reason).toBe("torn-copy-kept");
      expect(existsSync(join(dir, "journal.jsonl.torn-2026-11-01T00-00-00-000Z"))).toBe(true);
    });
  });

  it("dry run: a torn tail is reported as WOULD-REPAIR and nothing is written", async () => {
    await withBaseAsync(async (base) => {
      const root = makeRoot(base);
      makeTornRun(root, "run-torn");
      const before = snapshot(base);

      const lib = runGc({ runsRoot: root, retentionDays: 7, enabled: false, repairTornWal: true, nowMs: NOW });
      expect(decisionOf(lib, "run-torn").action).toBe("would-repair");
      expect(snapshot(base)).toBe(before);

      const cli = await runCli(["--runs-root", root, "--repair-torn-wal"]);
      expect(cli.code, cli.err).toBe(0);
      expect(cli.out).toMatch(/^WOULD-REPAIR run-torn reason=torn-wal/m);
      expect(snapshot(base), "CLI dry run changed the tree").toBe(before);
    });
  });

  it("without the repair option a torn tail is kept and left as it is", () => {
    withBase((base) => {
      const root = makeRoot(base);
      makeTornRun(root, "run-torn");
      const before = snapshot(base);
      const result = gc(root, { repairTornWal: false });
      expect(decisionOf(result, "run-torn").action).toBe("keep");
      expect(decisionOf(result, "run-torn").reason).toBe("torn-wal");
      expect(snapshot(base)).toBe(before);
    });
  });

  it("a journal that ends in a newline is not torn and is not touched by repair", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeScenarioRun(root, "run-intact", SCENARIOS.ready);
      const before = snapshot(base);
      const result = gc(root, { repairTornWal: true });
      expect(decisionOf(result, "run-intact").action).toBe("keep");
      expect(decisionOf(result, "run-intact").reason).toBe("fresh");
      expect(result.summary.repaired).toBe(0);
      expect(snapshot(base), "a complete journal was modified").toBe(before);
      expect(
        readdirSync(dir).some((name) => name.startsWith("journal.jsonl.torn-")),
        "a copy was created for a complete journal",
      ).toBe(false);
    });
  });

  it("an empty journal is not torn: repair writes nothing", () => {
    withBase((base) => {
      const root = makeRoot(base);
      makeRun(root, "run-empty", { "descriptor.json": JSON.stringify(descriptorFor("run-empty")), "journal.jsonl": "" });
      const before = snapshot(base);
      const result = gc(root, { repairTornWal: true });
      expect(result.summary.repaired).toBe(0);
      expect(snapshot(base), "an empty journal was modified").toBe(before);
    });
  });

  it("a torn journal with a live owner is not repaired", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeTornRun(root, "run-live");
      writeFileSync(join(dir, "owner.lock"), JSON.stringify({ pid: process.pid, epoch: 1, timestamp: FRESH }));
      const before = snapshot(base);
      const result = gc(root, { repairTornWal: true });
      expect(decisionOf(result, "run-live").reason).toBe("lock-live-pid");
      expect(decisionOf(result, "run-live").action).toBe("keep");
      expect(snapshot(base), "a run with a live owner was modified").toBe(before);
    });
  });

  it("a journal holding only a torn line is repaired to empty, and the whole line is kept in the copy", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeRun(root, "run-only-tail", {
        "descriptor.json": JSON.stringify(descriptorFor("run-only-tail")),
        "journal.jsonl": '{"seq":0,"epoch":1',
      });
      const result = gc(root, { repairTornWal: true });
      const run = decisionOf(result, "run-only-tail");
      expect(run.action).toBe("repaired");
      expect(readFileSync(join(dir, "journal.jsonl"), "utf8")).toBe("");
      expect(readFileSync(join(dir, run.copy as string), "utf8")).toBe('{"seq":0,"epoch":1');
    });
  });

  it("a torn line that stops inside a multi-byte character is copied byte for byte", () => {
    withBase((base) => {
      const root = makeRoot(base);
      // The letter z-with-dot-above (U+017C) is two bytes in UTF-8 (C5 BC). The tail stops after the first byte.
      const tailBytes = Buffer.from([0x7b, 0x22, 0xc5]);
      const dir = makeTornRun(root, "run-utf8", "");
      writeFileSync(join(dir, "journal.jsonl"), Buffer.concat([Buffer.from(journalText(1)), tailBytes]));
      const result = gc(root, { repairTornWal: true });
      const run = decisionOf(result, "run-utf8");
      expect(run.action).toBe("repaired");
      expect(readFileSync(join(dir, run.copy as string))).toEqual(tailBytes);
      expect(readFileSync(join(dir, "journal.jsonl"), "utf8")).toBe(journalText(1));
    });
  });

  it("a repair whose copy name already exists is refused and the journal is unchanged", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeTornRun(root, "run-collision");
      const stamp = new Date(NOW).toISOString().replace(/[:.]/g, "-");
      writeFileSync(join(dir, `journal.jsonl.torn-${stamp}`), "earlier copy");
      const journalBefore = readFileSync(join(dir, "journal.jsonl"), "utf8");
      const result = gc(root, { repairTornWal: true, nowMs: NOW });
      const run = decisionOf(result, "run-collision");
      expect(run.action).toBe("repair-failed");
      expect(run.error).toMatch(/EEXIST/);
      expect(result.summary.repair_failed).toBe(1);
      // The repair owns the run while it works, which leaves the epoch sidecar of the lock protocol; the data stays.
      expect(readFileSync(join(dir, "journal.jsonl"), "utf8"), "a failed repair changed the journal").toBe(journalBefore);
      expect(readFileSync(join(dir, `journal.jsonl.torn-${stamp}`), "utf8")).toBe("earlier copy");
      expect(readdirSync(dir).filter((name) => name.startsWith("journal.jsonl.torn-"))).toEqual([`journal.jsonl.torn-${stamp}`]);
      expect(existsSync(join(dir, "owner.lock")), "the lock taken for the repair was not released").toBe(false);
    });
  });

  it("a repair does not start on a run that a contender took over through the fence after the scan", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeTornRun(root, "run-repair-contended");
      ageTree(dir, OLD);
      const journalBefore = readFileSync(join(dir, "journal.jsonl"), "utf8");
      const contender = new FileOwnershipFence(realpathSync(root), "run-repair-contended");
      expect(contender.acquireSync().outcome).toBe("acquired");

      expect(() => repairTornTail(dir, NOW)).toThrow(/held by a live owner/);
      expect(readFileSync(join(dir, "journal.jsonl"), "utf8"), "the owner's journal was truncated").toBe(journalBefore);
      expect(readdirSync(dir).filter((name) => name.startsWith("journal.jsonl.torn-"))).toEqual([]);
    });
  });

  it("repairTornTail refuses a live owner before it writes any copy", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeTornRun(root, "run-direct-live");
      writeFileSync(join(dir, "owner.lock"), JSON.stringify({ pid: process.pid, epoch: 1, timestamp: FRESH }));
      const before = snapshot(base);
      expect(() => repairTornTail(dir, NOW)).toThrow(/held by a live owner/);
      expect(snapshot(base), "a live run was modified or got a copy").toBe(before);
    });
  });

  itSymlink("repairTornTail refuses a symbolic link as the journal", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeRun(root, "run-link-journal", { "descriptor.json": "{}\n" });
      const outside = join(base, "outside.jsonl");
      writeFileSync(outside, `${journalText(1)}{"seq":1`);
      symlinkSync(outside, join(dir, "journal.jsonl"));
      const before = snapshot(base);
      expect(() => repairTornTail(dir, NOW)).toThrow(/ELOOP|symbolic|journal/);
      expect(snapshot(base)).toBe(before);
    });
  });

  it("CLI repair needs both the switch and the repair option; the environment variable works too", async () => {
    await withBaseAsync(async (base) => {
      const root = makeRoot(base);
      const dir = makeTornRun(root, "run-cli");

      const flagOnly = await runCli(["--runs-root", root, "--repair-torn-wal"], {});
      expect(flagOnly.code, flagOnly.err).toBe(0);
      expect(flagOnly.out).toMatch(/^WOULD-REPAIR run-cli/m);
      expect(readFileSync(join(dir, "journal.jsonl"), "utf8").endsWith('{"seq":1,"epoch":1,"descr')).toBe(true);

      const envOnly = await runCli(["--runs-root", root], { OMC_GRAPH_REPAIR_TORN_WAL: "1" });
      expect(envOnly.code, envOnly.err).toBe(0);
      expect(envOnly.out).toMatch(/^WOULD-REPAIR run-cli/m);

      const both = await runCli(["--runs-root", root], { OMC_GRAPH_GC: "1", OMC_GRAPH_REPAIR_TORN_WAL: "1" });
      expect(both.code, both.err).toBe(0);
      expect(both.out).toMatch(/^REPAIRED run-cli reason=torn-wal bytes=\d+ copy=journal\.jsonl\.torn-/m);
      expect(readFileSync(join(dir, "journal.jsonl"), "utf8")).toBe(journalText(1));
    });
  });

  // ---- Removal failures (injected and real guard) ----------------------------------------------

  it("a failed removal is reported, the other expired runs are still removed, and the exit code is 1", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const failing = makeFinishedRun(root, "run-a");
      const removable = makeFinishedRun(root, "run-b");
      ageTree(failing, OLD);
      ageTree(removable, OLD);
      const remove = (realRoot: string, id: string) => {
        if (id === "run-a") throw new Error("simulated removal failure");
        removeRun(realRoot, id);
      };

      const result = gc(root, { remove });
      expect(decisionOf(result, "run-a").action).toBe("failed");
      expect(decisionOf(result, "run-a").error).toBe("simulated removal failure");
      expect(decisionOf(result, "run-b").action).toBe("deleted");
      expect(result.summary.failed).toBe(1);
      expect(result.summary.deleted).toBe(1);
      expect(existsSync(failing), "the run whose removal failed must stay").toBe(true);
      expect(existsSync(removable)).toBe(false);

      let out = "";
      let err = "";
      const code = runGraphGc(
        { runsRoot: root, current: null, repairTornWal: false, json: false },
        { ...process.env, OMC_GRAPH_GC: "1" },
        { write: (text: string) => (out += text) },
        { write: (text: string) => (err += text) },
        { remove },
      );
      expect(code).toBe(1);
      expect(out).toMatch(/^FAILED run-a reason=expired state=final-succeeded bytes=\d+ error="simulated removal failure"/m);
      expect(err).toBe("");
    });
  });

  it("a removal re-checks the owner lock: a run whose lock turned live after the scan is kept", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-raced");
      ageTree(dir, OLD);
      const remove = (realRoot: string, id: string) => {
        // Simulates a run started between the scan and the removal: its owner lock now names a live process.
        writeFileSync(join(realRoot, id, "owner.lock"), JSON.stringify({ pid: process.pid, epoch: 2, timestamp: NOW }));
        removeRun(realRoot, id);
      };

      const result = gc(root, { remove });
      const run = decisionOf(result, "run-raced");
      expect(run.action).toBe("failed");
      expect(run.error).toMatch(/held by a live owner/);
      expect(existsSync(dir), "a run with a live owner was removed").toBe(true);
    });
  });

  it("a removal that a contender races after the scan does not take the run: the contender took ownership from a stale owner", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-contended");
      ageTree(dir, OLD);
      const journalBefore = readFileSync(join(dir, "journal.jsonl"), "utf8");
      const remove = (realRoot: string, id: string) => {
        // The scan saw a dead owner's old lock. Now a resuming process takes the run over through the real fence.
        const contender = new FileOwnershipFence(realRoot, id);
        expect(contender.acquireSync().outcome, "the contender takes over the stale lock").toBe("acquired");
        removeRun(realRoot, id);
      };

      const result = gc(root, { remove });
      const run = decisionOf(result, "run-contended");
      expect(run.action).toBe("failed");
      expect(run.error).toMatch(/held by a live owner/);
      expect(readFileSync(join(dir, "journal.jsonl"), "utf8"), "the contended run lost its journal").toBe(journalBefore);
      expect(readdirSync(root).filter((name) => name.startsWith(".deleted-"))).toEqual([]);
    });
  });

  it("a removal interrupted after the move leaves a directory the next pass finishes, by the name removeRun gave it", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const realRoot = realpathSync(root);
      const dir = makeFinishedRun(root, "run-original");
      ageTree(dir, OLD);
      // The move that removeRun makes before it deletes; the process stops right after it.
      const quarantine = quarantineRun(realRoot, "run-original", NOW);
      expect(existsSync(dir), "the run directory name must be free after the move").toBe(false);
      expect(existsSync(join(quarantine, "journal.jsonl"))).toBe(true);
      const name = quarantine.slice(realRoot.length + 1);
      // The lock inside names the process that moved the run. It is still alive here (the test process), so the
      // directory is kept; once that process is gone the lock no longer protects it.
      const whileAlive = gc(root);
      expect(decisionOf(whileAlive, name).action).toBe("keep");
      expect(decisionOf(whileAlive, name).reason).toBe("lock-live-pid");
      expect(existsSync(quarantine)).toBe(true);

      writeFileSync(join(quarantine, "owner.lock"), JSON.stringify({ pid: deadPid(), epoch: 2, timestamp: OLD }));
      const result = gc(root);
      expect(decisionOf(result, name).action).toBe("deleted");
      expect(decisionOf(result, name).reason).toBe("quarantine-cleanup");
      expect(result.summary.deleted).toBe(1);
      expect(existsSync(quarantine)).toBe(false);
    });
  });

  it("after the move a contender with the old directory handle cannot lock the moved run, and a new resume starts a fresh directory", async () => {
    await withBaseAsync(async (base) => {
      const root = makeRoot(base);
      const realRoot = realpathSync(root);
      const dir = makeFinishedRun(root, "run-moved");
      ageTree(dir, OLD);
      const staleHandle = resolveRunDirHandle(realRoot, "run-moved");
      const quarantine = quarantineRun(realRoot, "run-moved", NOW);
      const lockBefore = readFileSync(join(quarantine, "owner.lock"), "utf8");

      await expect(new FileOwnershipFence(realRoot, "run-moved", undefined, staleHandle).acquire()).rejects.toThrow();
      expect(readFileSync(join(quarantine, "owner.lock"), "utf8"), "the moved run's lock changed").toBe(lockBefore);

      const resumed = new FileOwnershipFence(realRoot, "run-moved");
      const got = await resumed.acquire();
      expect(got.outcome).toBe("acquired");
      expect(readdirSync(join(realRoot, "run-moved")).sort(), "a new directory holds the new lock only").toEqual(["owner.epoch", "owner.lock"]);
      expect(existsSync(join(quarantine, "journal.jsonl")), "the moved run was touched").toBe(true);
    });
  });

  it("a move that fails leaves the run where it was and releases the lock this process took", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const realRoot = realpathSync(root);
      const dir = makeFinishedRun(root, "run-stays");
      ageTree(dir, OLD);
      const journalBefore = readFileSync(join(dir, "journal.jsonl"), "utf8");
      // The target name is taken by a directory that is not empty, so the rename is refused.
      const taken = join(realRoot, `.deleted-run-stays-${NOW}-fixed`);
      mkdirSync(taken);
      writeFileSync(join(taken, "occupant"), "x");

      expect(() => quarantineRun(realRoot, "run-stays", NOW, "fixed")).toThrow(/ENOTEMPTY|EEXIST/);
      expect(readFileSync(join(dir, "journal.jsonl"), "utf8"), "the run lost its journal").toBe(journalBefore);
      expect(existsSync(join(dir, "owner.lock")), "the lock of the failed move was left in the run").toBe(false);
      expect(readdirSync(taken)).toEqual(["occupant"]);
    });
  });

  // Class: a verdict of the scan is used later than it was read. Every test below puts a change between the scan and
  // the removal. A replacement run is aged and in a final state, so only the directory identity can tell it apart.
  it("a removal does not delete a new run that took the place of the scanned run, even when that run looks expired and final", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-replaced");
      ageTree(dir, OLD);
      const remove = (realRoot: string, id: string, scanned?: ScannedRun) => {
        // Another pass moved the scanned run away; a new run with the same id was created. The old directory stays
        // on disk here, so its inode number cannot be reused by the new one.
        renameSync(join(realRoot, id), join(base, "moved-away"));
        const replacement = makeFinishedRun(realRoot, id);
        ageTree(replacement, OLD);
        removeRun(realRoot, id, scanned);
      };

      const result = gc(root, { remove });
      const run = decisionOf(result, "run-replaced");
      expect(run.action).toBe("failed");
      expect(run.error).toMatch(/replaced after the scan/);
      expect(existsSync(join(dir, "journal.jsonl")), "the new run was deleted on the verdict of the old one").toBe(true);
      expect(readdirSync(dir).sort(), "the refused run was written to").toEqual(["descriptor.json", "journal.jsonl", "projection.json"]);
      expect(readdirSync(root).filter((name) => name.startsWith(".deleted-"))).toEqual([]);
    });
  });

  it("two overlapping passes: the second one, which scanned the same expired run, does not delete the run that replaced it", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const realRoot = realpathSync(root);
      const dir = makeFinishedRun(root, "run-twice");
      ageTree(dir, OLD);
      const first = scannedFirst(root);
      const second = scannedFirst(root);
      // An open descriptor keeps the removed directory's inode allocated, so the new run cannot reuse its number.
      const hold = openSync(dir, "r");
      try {
        removeRun(realRoot, "run-twice", first);
        expect(existsSync(dir)).toBe(false);
        const fresh = makeFinishedRun(root, "run-twice");
        ageTree(fresh, OLD);

        expect(() => removeRun(realRoot, "run-twice", second)).toThrow(/replaced after the scan/);
        expect(readFileSync(join(fresh, "journal.jsonl"), "utf8")).toBe(finishedJournals.get(fresh));
        expect(existsSync(join(fresh, "owner.lock")), "a lock was created in the new run").toBe(false);
      } finally {
        closeSync(hold);
      }
    });
  });

  it("a run that was resumed and finished after the scan is decided again under ownership: it is fresh, so it stays", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-resumed");
      ageTree(dir, OLD);
      const remove = (realRoot: string, id: string, scanned?: ScannedRun) => {
        // The same directory: a resume wrote to it and released its lock. Its files are recent now.
        const now = new Date();
        utimesSync(join(realRoot, id, "journal.jsonl"), now, now);
        removeRun(realRoot, id, scanned);
      };

      const result = gc(root, { remove });
      const run = decisionOf(result, "run-resumed");
      expect(run.action).toBe("failed");
      expect(run.error).toMatch(/changed after the scan \(fresh\)/);
      expect(existsSync(join(dir, "journal.jsonl"))).toBe(true);
      expect(existsSync(join(dir, "owner.lock")), "the lock taken for the check was left in the run").toBe(false);
      expect(readdirSync(root).filter((name) => name.startsWith(".deleted-"))).toEqual([]);
    });
  });

  it("a run that is no longer final under ownership stays: the scan's verdict is not reused", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-reopened");
      ageTree(dir, OLD);
      const remove = (realRoot: string, id: string, scanned?: ScannedRun) => {
        // Same directory, now a run stopped between two steps (the second is ready); its files keep their old times.
        makeRealRun(realRoot, id, "ready");
        ageTree(join(realRoot, id), OLD);
        removeRun(realRoot, id, scanned);
      };

      const result = gc(root, { remove });
      const run = decisionOf(result, "run-reopened");
      expect(run.action).toBe("failed");
      expect(run.error).toMatch(/changed after the scan \(resumable-ready\)/);
      expect(existsSync(join(dir, "journal.jsonl"))).toBe(true);
      expect(existsSync(join(dir, "owner.lock"))).toBe(false);
    });
  });

  it("a run that another process locked and released after the scan, changing nothing, is kept: the lock epoch moved", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-touched");
      ageTree(dir, OLD);
      // A resume that finds the run already finished takes the lock, changes no file and releases it.
      const first = new FileOwnershipFence(realpathSync(root), "run-touched");
      const taken = first.acquireSync();
      expect(taken.outcome).toBe("acquired");
      if (taken.outcome === "acquired") first.releaseSync(taken.epoch);
      ageTree(dir, OLD);
      const scannedBefore = scannedFirst(root);
      // The scan above already saw the first epoch; a second touch happens after it.
      const second = new FileOwnershipFence(realpathSync(root), "run-touched");
      const again = second.acquireSync();
      if (again.outcome === "acquired") second.releaseSync(again.epoch);
      ageTree(dir, OLD);

      expect(() => removeRun(realpathSync(root), "run-touched", scannedBefore)).toThrow(/resumed after the scan/);
      expect(existsSync(join(dir, "journal.jsonl"))).toBe(true);
      expect(existsSync(join(dir, "owner.lock")), "the lock taken for the check was left in the run").toBe(false);
    });
  });

  it("without a touch after the scan the same run is removed although its epoch sidecar is recent", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-quiet");
      ageTree(dir, OLD);
      const first = new FileOwnershipFence(realpathSync(root), "run-quiet");
      const taken = first.acquireSync();
      if (taken.outcome === "acquired") first.releaseSync(taken.epoch);
      ageTree(dir, OLD);

      removeRun(realpathSync(root), "run-quiet", scannedFirst(root));
      expect(existsSync(dir)).toBe(false);
    });
  });

  it.runIf(process.platform === "linux")("a swap of the run's name after the lock is held is refused by identity before the run is decided again", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const realRoot = realpathSync(root);
      const dir = makeFinishedRun(root, "run-swapped-late");
      ageTree(dir, OLD);
      const swapped: ScannedRun = {
        ...scannedFirst(root),
        afterOwnership: () => {
          renameSync(dir, join(base, "moved-away"));
          makeScenarioRun(root, "run-swapped-late", SCENARIOS.running);
          ageTree(dir, OLD);
        },
      };

      expect(() => removeRun(realRoot, "run-swapped-late", swapped)).toThrow(/not the directory that was scanned/);
      expect(readFileSync(join(dir, "journal.jsonl"), "utf8"), "the run that took the name was changed").toBe(journalText(1));
      expect(readdirSync(root).filter((name) => name.startsWith(".deleted-"))).toEqual([]);
    });
  });

  it.runIf(process.platform === "linux")("the run is decided again from the directory that was opened: a swap of the name while it is read changes nothing it reads", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const realRoot = realpathSync(root);
      const dir = makeFinishedRun(root, "run-swapped-reading");
      ageTree(dir, OLD);
      const swapped: ScannedRun = {
        ...scannedFirst(root),
        afterHandle: () => {
          // The directory is open and was checked. The name now leads to an interrupted run; reads by path would see
          // that run and keep it. The reads of the open directory still see the finished one, and the result is
          // refused because the name no longer is the directory that was read.
          renameSync(dir, join(base, "moved-away"));
          makeScenarioRun(root, "run-swapped-reading", SCENARIOS.running);
          ageTree(dir, OLD);
        },
      };

      expect(() => removeRun(realRoot, "run-swapped-reading", swapped)).toThrow(/replaced while it was in use/);
      expect(readFileSync(join(dir, "journal.jsonl"), "utf8"), "the run that took the name was changed").toBe(journalText(1));
      expect(readdirSync(root).filter((name) => name.startsWith(".deleted-"))).toEqual([]);
    });
  });

  it("a leftover directory that was replaced after the scan is not deleted", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const realRoot = realpathSync(root);
      const name = `.deleted-run-left-${NOW}-aaaa`;
      const leftover = makeRun(root, name);
      const scanned = scannedFirst(root);
      renameSync(leftover, join(base, "moved-away"));
      const replacement = makeRun(root, name, { "descriptor.json": "{}\n", "journal.jsonl": "other\n" });

      expect(() => removeRun(realRoot, name, scanned)).toThrow(/not the directory that was scanned/);
      expect(readFileSync(join(replacement, "journal.jsonl"), "utf8")).toBe("other\n");
    });
  });

  it("a torn journal is repaired only in the directory that was scanned", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeTornRun(root, "run-torn-replaced");
      const identity = scanRuns({ runsRoot: root, retentionDays: 7, nowMs: NOW }).runs[0].identity as { dev: number; ino: number };
      renameSync(dir, join(base, "moved-away"));
      const replacement = makeTornRun(root, "run-torn-replaced");
      const before = readFileSync(join(replacement, "journal.jsonl"), "utf8");

      expect(() => repairTornTail(replacement, NOW, identity)).toThrow(/not the directory that was scanned/);
      expect(readFileSync(join(replacement, "journal.jsonl"), "utf8")).toBe(before);
      expect(readdirSync(replacement).sort()).toEqual(["descriptor.json", "journal.jsonl", "projection.json"]);
    });
  });

  // Class: after ownership is taken, every file of the run is reached through the open, identity-checked directory, never
  // by the name. The name is swapped at each step of the repair; what took the name (a link to a directory outside the
  // runs root, or another real run directory) must never be read, copied or truncated.
  describe.runIf(process.platform === "linux")("a torn journal repair when the name of the run is swapped under it", () => {
    const TORN = '{"seq":1,"epoch":1,"descr';
    type Point = keyof RepairInterlock;
    type Swap = "link to an outside directory" | "another real run directory";

    function swapIn(base: string, root: string, id: string, dir: string, kind: Swap): { target: string } {
      renameSync(dir, join(base, "moved-away"));
      if (kind === "another real run directory") {
        const other = makeTornRun(root, id);
        return { target: other };
      }
      const outside = join(base, "outside");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "journal.jsonl"), `${journalText(1)}${TORN}`);
      symlinkSync(outside, dir);
      return { target: outside };
    }

    // For each point: what the original directory (moved away, still open to the repair) looks like afterwards.
    const POINTS: { point: Point; message: RegExp; copy: boolean; truncated: boolean }[] = [
      { point: "afterOwnership", message: /no longer a plain directory|not the directory that was scanned/, copy: false, truncated: false },
      { point: "afterHandle", message: /replaced while it was in use/, copy: false, truncated: false },
      // Swapped after the last check of the name: the copy goes into the directory the repair owns, never into the new one,
      // and the check before the truncation refuses the rest.
      { point: "beforeCopy", message: /replaced while it was in use/, copy: true, truncated: false },
      { point: "afterCopy", message: /replaced while it was in use/, copy: true, truncated: false },
      // Swapped after the check before the truncation: the truncation is on the descriptor of the owned journal, so it
      // completes there; the lock cannot be released through the swapped name, and that is reported.
      { point: "beforeTruncate", message: /journal repaired.*lock could not be released/, copy: true, truncated: true },
      { point: "beforeRelease", message: /journal repaired.*lock could not be released/, copy: true, truncated: true },
    ];
    const KINDS: Swap[] = ["link to an outside directory", "another real run directory"];

    for (const { point, message, copy, truncated } of POINTS) {
      for (const kind of KINDS) {
        it(`${point}: the name is swapped for a ${kind}; the repair changes nothing that took the name`, () => {
          withBase((base) => {
            const root = makeRoot(base);
            const dir = makeTornRun(root, "run-torn-swap");
            const identity = scanRuns({ runsRoot: root, retentionDays: 7, nowMs: NOW }).runs[0].identity as { dev: number; ino: number };
            let target = "";
            let targetBefore = "";
            const interlock: RepairInterlock = {
              [point]: () => {
                target = swapIn(base, root, "run-torn-swap", dir, kind).target;
                targetBefore = snapshot(target);
              },
            };

            expect(() => repairTornTail(dir, NOW, identity, interlock)).toThrow(message);
            expect(snapshot(target), "what took the name was changed").toBe(targetBefore);
            expect(readdirSync(target).filter((name) => name.startsWith("journal.jsonl.torn-")), "a copy appeared where the name leads").toEqual([]);

            const moved = join(base, "moved-away");
            const copies = readdirSync(moved).filter((name) => name.startsWith("journal.jsonl.torn-"));
            expect(copies.length > 0, `copy in the original directory (${copies.join(",")})`).toBe(copy);
            const journal = readFileSync(join(moved, "journal.jsonl"), "utf8");
            expect(journal === journalText(1), "the journal of the original directory was truncated").toBe(truncated);
            if (!truncated) expect(journal).toBe(`${journalText(1)}${TORN}`);
          });
        });
      }
    }

    it("without a swap the same repair copies the tail, truncates the journal and releases the lock", () => {
      withBase((base) => {
        const root = makeRoot(base);
        const dir = makeTornRun(root, "run-torn-plain");
        const identity = scanRuns({ runsRoot: root, retentionDays: 7, nowMs: NOW }).runs[0].identity as { dev: number; ino: number };
        const points: string[] = [];
        const outcome = repairTornTail(dir, NOW, identity, {
          afterOwnership: () => points.push("owned"),
          afterHandle: () => points.push("open"),
          beforeCopy: () => points.push("checked"),
          afterCopy: () => points.push("copied"),
          beforeTruncate: () => points.push("checked"),
          beforeRelease: () => points.push("done"),
        });
        expect(points).toEqual(["owned", "open", "checked", "copied", "checked", "done"]);
        expect(outcome.repaired).toBe(true);
        expect(readFileSync(join(dir, outcome.copy as string), "utf8")).toBe(TORN);
        expect(readFileSync(join(dir, "journal.jsonl"), "utf8")).toBe(journalText(1));
        expect(existsSync(join(dir, "owner.lock"))).toBe(false);
      });
    });
  });

  // The move of the run out of the runs namespace is a rename by name. The name is checked right before it and the moved
  // directory right after it, so a swap in between puts the wrong directory back instead of deleting it.
  it.runIf(process.platform === "linux")("a name swapped between the last check and the move: what was moved is put back, and nothing is deleted", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const realRoot = realpathSync(root);
      const dir = makeFinishedRun(root, "run-swapped-move");
      ageTree(dir, OLD);
      let replacementJournal = "";
      const swapped: ScannedRun = {
        ...scannedFirst(root),
        beforeMove: () => {
          renameSync(dir, join(base, "moved-away"));
          makeFinishedRun(root, "run-swapped-move");
          ageTree(dir, OLD);
          replacementJournal = readFileSync(join(dir, "journal.jsonl"), "utf8");
        },
      };

      expect(() => removeRun(realRoot, "run-swapped-move", swapped)).toThrow(/replaced while it was moved; the moved directory was put back/);
      expect(readFileSync(join(dir, "journal.jsonl"), "utf8"), "the run that took the name was changed").toBe(replacementJournal);
      expect(readdirSync(root).filter((name) => name.startsWith(".deleted-")), "a run was left in quarantine").toEqual([]);
      expect(existsSync(join(base, "moved-away", "journal.jsonl")), "the scanned directory was changed").toBe(true);
    });
  });

  it("removeTree: an entry that another pass removes after its check is not an error", () => {
    withBase((base) => {
      const tree = join(base, "tree");
      mkdirSync(join(tree, "artifacts"), { recursive: true });
      writeFileSync(join(tree, "artifacts", "inner.txt"), "inner\n");
      writeFileSync(join(tree, "top.txt"), "top\n");
      let raced = false;

      removeTree(tree, {
        afterLstat: (entry) => {
          if (raced) return;
          raced = true;
          // The other pass is faster: the subdirectory is gone before this one opens it.
          rmSync(entry, { recursive: true, force: true });
        },
      });
      expect(raced, "the interlock did not run").toBe(true);
      expect(existsSync(tree)).toBe(false);
    });
  });

  it.runIf(process.platform === "linux")("removeTree: a subdirectory swapped for a symbolic link after its check is not followed", () => {
    withBase((base) => {
      const tree = join(base, "tree");
      mkdirSync(join(tree, "artifacts"), { recursive: true });
      writeFileSync(join(tree, "artifacts", "inner.txt"), "inner\n");
      const outside = join(base, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "victim.txt"), "outside content\n");
      const before = snapshot(outside);
      let swapped = false;

      expect(() =>
        removeTree(tree, {
          afterLstat: (entry) => {
            if (swapped) return;
            swapped = true;
            // Between the lstat that saw a directory and the walk into it, a concurrent process swaps in a link.
            rmSync(entry, { recursive: true, force: true });
            symlinkSync(outside, entry);
          },
        }),
      ).toThrow();
      expect(swapped, "the interlock did not run").toBe(true);
      expect(snapshot(outside), "a file outside the removed tree was deleted through the swapped link").toBe(before);
    });
  });

  it("repairTornTail refuses a journal with a second hard link and leaves the other name untouched", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeTornRun(root, "run-hardlink");
      const outside = join(base, "outside.jsonl");
      linkSync(join(dir, "journal.jsonl"), outside);
      const before = snapshot(base);

      expect(() => repairTornTail(dir, NOW)).toThrow(/hard link/);
      expect(snapshot(base), "the shared journal or a copy was written").toBe(before);

      const result = gc(root, { repairTornWal: true });
      expect(decisionOf(result, "run-hardlink").action).toBe("repair-failed");
      expect(readFileSync(outside, "utf8"), "the file outside the runs root was truncated").toBe(readFileSync(join(dir, "journal.jsonl"), "utf8"));
      expect(readFileSync(outside, "utf8").endsWith('{"seq":1,"epoch":1,"descr')).toBe(true);
    });
  });

  itSymlink("a removal that finds the run replaced by a symbolic link fails and leaves the link target alone", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-swapped");
      ageTree(dir, OLD);
      const outside = join(base, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "keep.txt"), "outside content\n");
      const before = snapshot(outside);
      const remove = (realRoot: string, id: string) => {
        // Simulates a swap between the scan and the removal: the real directory is replaced by a link.
        rmSync(join(realRoot, id), { recursive: true, force: true });
        symlinkSync(outside, join(realRoot, id));
        removeRun(realRoot, id);
      };

      const result = gc(root, { remove });
      const run = decisionOf(result, "run-swapped");
      expect(run.action).toBe("failed");
      expect(run.error).toMatch(/no longer a plain directory/);
      expect(lstatSync(dir).isSymbolicLink()).toBe(true);
      expect(snapshot(outside), "the link target was modified").toBe(before);
    });
  });

  it.skipIf(process.platform === "win32")("a FIFO in place of descriptor.json is kept and does not block the command", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const dir = makeFinishedRun(root, "run-fifo");
      rmSync(join(dir, "descriptor.json"), { force: true });
      makeFifo(join(dir, "descriptor.json"));
      ageTree(dir, OLD);
      // Run in a child process: an open() that blocks on a FIFO would hang the test worker itself.
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OMC_GRAPH_")));
      const cli = spawnSync(
        process.execPath,
        ["--import", "tsx", CLI_ENTRY, "graph", "gc", "--runs-root", root],
        { cwd: REPO_ROOT, env: { ...env, OMC_GRAPH_GC: "1" }, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" },
      );
      expect(cli.signal, `the command hung on the FIFO: ${cli.stderr}`).toBeNull();
      expect(cli.status, cli.stderr).toBe(0);
      expect(cli.stdout).toMatch(/^KEEP run-fifo reason=unknown:descriptor\.json-not-a-regular-file/m);
      expect(existsSync(dir), "a run with a FIFO in place of a file was removed").toBe(true);
    });
  }, 90_000);
});

/** Async variant of withBase for tests that drive the CLI. */
async function withBaseAsync<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const base = mkdtempSync(join(os.tmpdir(), "graph-runs-gc-test-"));
  tempBases.push(base);
  return fn(base);
}
