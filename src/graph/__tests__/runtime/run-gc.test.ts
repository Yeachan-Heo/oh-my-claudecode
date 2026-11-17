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
  existsSync,
  lstatSync,
  linkSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { graphCommand } from "../../../cli/graph.js";
import { FileOwnershipFence } from "../../runtime/fence.js";
import { resolveRunDirHandle } from "../../runtime/run-dir.js";
import {
  classifyRun,
  DEFAULT_RETENTION_DAYS,
  isSwitchOn,
  parseRetentionDays,
  quarantineRun,
  removeRun,
  removeTree,
  repairTornTail,
  runGc,
  runGraphGc,
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

const SCENARIOS: Record<string, Scenario & { expected: string }> = {
  // Verification node completed with evidence; every activation completed; no cohorts.
  succeeded: {
    count: 2,
    activations: {
      a1: activation("a1", "n1", "completed", { completed_transition_id: "t1" }),
      a2: activation("a2", "v1", "completed", { completed_transition_id: "t2" }),
    },
    committed: {
      t1: { outcome: "succeeded", evidence_refs: [] },
      t2: { outcome: "succeeded", evidence_refs: [{ kind: "file" }] },
    },
    terminal: ["a2"],
    expected: "final-succeeded",
  },
  // A node failed for good; nothing ready or running; not a success.
  failed: {
    count: 1,
    activations: {
      a1: activation("a1", "n1", "failed"),
      a2: activation("a2", "v1", "completed", { completed_transition_id: "t1" }),
    },
    committed: { t1: { outcome: "succeeded", evidence_refs: [] } },
    terminal: [],
    expected: "final-failed",
  },
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
  // A human-approval gate is waiting for a decision.
  approval: {
    count: 1,
    activations: { ap1: activation("ap1", "ap", "ready") },
    committed: {},
    terminal: [],
    expected: "resumable-approval",
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

// A run that finished successfully (final state), as the runtime leaves it.
function makeFinishedRun(root: string, id: string): string {
  return makeScenarioRun(root, id, SCENARIOS.succeeded);
}

function gc(root: string, extra: Partial<Parameters<typeof runGc>[0]> = {}) {
  return runGc({ runsRoot: root, retentionDays: 7, enabled: true, nowMs: NOW, ...extra });
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

  // ---- Run states ------------------------------------------------------------------------------

  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    it(`state ${scenario.expected}: ${name} run`, () => {
      withBase((base) => {
        const root = makeRoot(base);
        const dir = makeScenarioRun(root, "run-state", scenario);
        ageTree(dir, OLD);

        const classified = classifyRun(dir, "run-state");
        expect(classified.state).toBe(scenario.expected);

        const result = gc(root);
        const run = decisionOf(result, "run-state");
        expect(run.state).toBe(scenario.expected);
        if (scenario.expected.startsWith("final-")) {
          expect(run.action, "a final run past retention must be removed").toBe("deleted");
          expect(existsSync(dir)).toBe(false);
        } else {
          expect(run.action, "a resumable run must never be removed").toBe("keep");
          expect(run.reason).toBe(scenario.expected);
          expect(existsSync(join(dir, "projection.json"))).toBe(true);
        }
      });
    });
  }

  it("a succeeded transition without evidence is not a success: the run is final-failed", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const scenario = {
        ...SCENARIOS.succeeded,
        committed: {
          t1: { outcome: "succeeded", evidence_refs: [] },
          t2: { outcome: "succeeded", evidence_refs: [] },
        },
      };
      const dir = makeScenarioRun(root, "run-no-evidence", scenario);
      ageTree(dir, OLD);
      expect(classifyRun(dir, "run-no-evidence").state).toBe("final-failed");
    });
  });

  it("an aborted run with a ready and a running activation is resumable, not final", () => {
    withBase((base) => {
      const root = makeRoot(base);
      const scenario: Scenario = {
        count: 1,
        activations: {
          a1: activation("a1", "n1", "running"),
          a2: activation("a2", "v1", "ready"),
        },
        committed: {},
        terminal: ["a2"],
      };
      const dir = makeScenarioRun(root, "run-aborted", scenario);
      ageTree(dir, OLD);
      const result = gc(root);
      expect(decisionOf(result, "run-aborted").state).toBe("resumable-running");
      expect(existsSync(dir)).toBe(true);
    });
  });

  // Each case leaves one piece of the run unreadable or inconsistent. Every one must be kept.
  const UNKNOWN_CASES: {
    name: string;
    reason: string;
    build: (root: string, id: string, base: string) => string;
  }[] = [
    {
      name: "snapshot file missing",
      reason: "unknown:projection.json-missing",
      build: (root, id) => makeScenarioRun(root, id, SCENARIOS.succeeded, { projection: null }),
    },
    {
      name: "snapshot older than the journal",
      reason: "unknown:snapshot-stale",
      build: (root, id) => makeScenarioRun(root, id, SCENARIOS.succeeded, { savedAtSeq: 0 }),
    },
    {
      name: "snapshot is not JSON",
      reason: "unknown:projection.json-not-json",
      build: (root, id) => makeScenarioRun(root, id, SCENARIOS.succeeded, { projection: "not json" }),
    },
    {
      name: "snapshot bound to another descriptor",
      reason: "unknown:snapshot-malformed",
      build: (root, id) =>
        makeScenarioRun(root, id, SCENARIOS.succeeded, {
          projection: JSON.stringify({ ...envelopeFor(id, projectionFor(id, SCENARIOS.succeeded), 1), descriptor_hash: OTHER_HASH }),
        }),
    },
    {
      name: "snapshot projection names another run",
      reason: "unknown:projection-mismatch",
      build: (root, id) =>
        makeScenarioRun(root, id, SCENARIOS.succeeded, {
          projection: JSON.stringify(envelopeFor(id, { ...projectionFor("other-run", SCENARIOS.succeeded) }, 1)),
        }),
    },
    {
      name: "activation with a status this tool does not know",
      reason: "unknown:activation-unknown",
      build: (root, id) =>
        makeScenarioRun(root, id, {
          count: 1,
          activations: { a1: activation("a1", "n1", "paused") },
          committed: {},
          terminal: [],
        }),
    },
    {
      name: "cohort without a boolean consumed flag",
      reason: "unknown:projection-malformed",
      build: (root, id) =>
        makeScenarioRun(root, id, {
          count: 1,
          activations: { a1: activation("a1", "n1", "failed") },
          cohorts: { c1: {} },
          committed: {},
          terminal: [],
        }),
    },
    {
      name: "no activations at all",
      reason: "unknown:no-activations",
      build: (root, id) => makeScenarioRun(root, id, { count: 1, activations: {}, committed: {}, terminal: [] }),
    },
    {
      name: "descriptor is not JSON",
      reason: "unknown:descriptor.json-not-json",
      build: (root, id) => makeScenarioRun(root, id, SCENARIOS.succeeded, { descriptor: "{not json" }),
    },
    {
      name: "descriptor names another run",
      reason: "unknown:descriptor-malformed",
      build: (root, id) =>
        makeScenarioRun(root, id, SCENARIOS.succeeded, { descriptor: JSON.stringify({ ...descriptorFor("other-run") }) }),
    },
    {
      name: "journal file missing",
      reason: "unknown:journal.jsonl-missing",
      build: (root, id) => makeRun(root, id, { "descriptor.json": JSON.stringify(descriptorFor(id)), "projection.json": "{}" }),
    },
    {
      name: "journal sequence has a gap",
      reason: "unknown:journal-bad-record",
      build: (root, id) =>
        makeScenarioRun(root, id, SCENARIOS.succeeded, {
          journal: `${JSON.stringify({ seq: 0, transition: {} })}\n${JSON.stringify({ seq: 2, transition: {} })}\n`,
        }),
    },
    {
      name: "snapshot is a symbolic link",
      reason: "unknown:projection.json-not-a-regular-file",
      build: (root, id, base) => {
        const dir = makeScenarioRun(root, id, SCENARIOS.succeeded, { projection: null });
        const outside = join(base, "outside-projection.json");
        writeFileSync(outside, JSON.stringify(envelopeFor(id, projectionFor(id, SCENARIOS.succeeded), 1)));
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
      const before = snapshot(base);
      const result = gc(root, { repairTornWal: true, nowMs: NOW });
      const run = decisionOf(result, "run-collision");
      expect(run.action).toBe("repair-failed");
      expect(run.error).toMatch(/EEXIST/);
      expect(result.summary.repair_failed).toBe(1);
      expect(snapshot(base), "a failed repair changed the tree").toBe(before);
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
