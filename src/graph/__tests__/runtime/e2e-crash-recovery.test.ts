/**
 * E2E crash-recovery tests (AC-2 kill/resume, AC-3 replay determinism).
 *
 * Spawns REAL child processes through the built CLI entry
 * (`node dist/cli/index.js graph run <fixture> --runs-root <tmp>`), kills the
 * child mid-run once a node completion is journaled, then re-spawns and proves:
 * - the resumed run completes exit 0,
 * - journaled nodes are NOT re-executed (replay line + no activation_started
 *   for them in stdout + single journal record + marker mtime unchanged),
 * - the resumed final projection equals a clean direct run's projection under
 *   canonicalJson equality (epoch-bearing envelope fields excluded).
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync, realpathSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

import { canonicalJson } from "../../descriptor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/graph/__tests__/runtime -> repo root
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "dist", "cli", "index.js");
const FIXTURE_PATH = join(__dirname, "fixtures", "simple-linear.json");
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  run_id: string;
};
const RUN_ID = FIXTURE.run_id;
const MARKER_ENV_VAR = "GRAPH_E2E_MARKER_DIR";

/** Sources whose changes require a rebuild before the CLI can be spawned. */
const FRESHNESS_SOURCES = [
  "src/cli/index.ts",
  "src/cli/graph.ts",
  "src/graph/runtime/runner.ts",
  "src/graph/runtime/types.ts",
  "src/graph/runtime/journal.ts",
  "src/graph/runtime/fence.ts",
  "src/graph/runtime/store.ts",
  "src/graph/runtime/approval.ts",
  "src/graph/runtime/progress.ts",
  "src/graph/runtime/executors/command.ts",
  "src/graph/runtime/executors/agent.ts",
  "src/graph/scheduler.ts",
  "src/graph/descriptor.ts",
  "src/graph/schema.ts",
  "src/graph/types.ts",
];

/**
 * Content probe: the built CLI must actually know this branch's subcommand
 * options. mtime alone lies — `git checkout -- dist` restores old content
 * with a NEW mtime, which would silently skip a needed rebuild.
 */
function builtCliLooksCurrent(): boolean {
  try {
    return readFileSync(CLI_ENTRY, "utf8").includes("--runs-root");
  } catch {
    return false;
  }
}

function distIsStale(): boolean {
  if (!existsSync(CLI_ENTRY) || !builtCliLooksCurrent()) return true;
  const builtAt = statSync(CLI_ENTRY).mtimeMs;
  return FRESHNESS_SOURCES.some((rel) => {
    const source = join(REPO_ROOT, rel);
    return existsSync(source) && statSync(source).mtimeMs > builtAt;
  });
}

let distReady: Promise<void> | null = null;

/** Builds dist once per process when missing or older than runtime sources. */
function ensureDist(): Promise<void> {
  if (distReady === null) {
    distReady = (async () => {
      if (!distIsStale()) return;
      const require = createRequire(import.meta.url);
      const tscEntry = require.resolve("typescript/bin/tsc");
      const built = spawnSync(process.execPath, [tscEntry], {
        cwd: REPO_ROOT,
        stdio: "pipe",
        timeout: 300_000,
      });
      // Fail loudly: a silently failed build leaves a stale CLI that dies
      // mid-test with an unrelated-looking usage error.
      if (built.status !== 0 || !existsSync(CLI_ENTRY)) {
        throw new Error(
          `dist build failed (exit ${String(built.status)}):\n${built.stderr?.toString() ?? "(no stderr)"}`,
        );
      }
    })();
  }
  return distReady;
}

interface CliRunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunningCli {
  readonly pid: number | undefined;
  readonly done: Promise<CliRunResult>;
}

function spawnGraphRun(runsRoot: string, markerDir: string): RunningCli {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [MARKER_ENV_VAR]: markerDir,
    CLAUDE_CONFIG_DIR: join(runsRoot, ".claude-config"),
    NODE_NO_WARNINGS: "1",
  };
  // The spawned CLI must parse its argv; the vitest opt-out must not leak.
  // CLAUDECODE trips the nested-session guard in cli/launch.ts (exit 1), and
  // parent-session OMC_* state must not leak into the child either.
  delete env.OMC_CLI_SKIP_PARSE;
  delete env.CLAUDECODE;
  for (const key of Object.keys(env)) {
    if (key.startsWith("OMC_")) delete env[key];
  }
  const child = spawn(
    process.execPath,
    [CLI_ENTRY, "graph", "run", FIXTURE_PATH, "--runs-root", runsRoot],
    {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<CliRunResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { pid: child.pid, done };
}

function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    // Tree-kill reaches the shell grandchildren holding the run's exec slots.
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

interface ParsedJournalRecord {
  readonly seq: number;
  readonly epoch: number;
  readonly transition: { readonly node_id: string; readonly outcome: string };
}

function journalRecords(runDir: string): ParsedJournalRecord[] {
  const path = join(runDir, "journal.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ParsedJournalRecord];
      } catch {
        return [];
      }
    });
}

describe("e2e crash recovery via spawned CLI (AC-2/AC-3)", () => {
  let baseDir: string | undefined;

  beforeAll(async () => {
    await ensureDist();
  }, 300_000);

  afterAll(() => {
    if (baseDir !== undefined) {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("resumes a killed run without re-executing journaled nodes and converges to the direct-run projection", async () => {
    baseDir = mkdtempSync(join(realpathSync(tmpdir()), "omc-graph-e2e-crash-"));
    const runsRoot = join(baseDir, "runs-resume");
    const markers = join(baseDir, "markers-resume");
    const directRunsRoot = join(baseDir, "runs-direct");
    const directMarkers = join(baseDir, "markers-direct");
    const configDir = join(baseDir, "claude-config");
    for (const dir of [markers, directMarkers, configDir]) {
      mkdirSync(dir, { recursive: true });
    }

    // --- Run 1: kill mid-run once n1 is journaled and n2 is sleeping. ---
    const first = spawnGraphRun(runsRoot, markers);
    const runDir = join(runsRoot, RUN_ID);
    await waitFor(
      () => existsSync(join(markers, "n1.marker")),
      "n1 marker to appear",
      60_000,
    );
    await waitFor(
      () =>
        journalRecords(runDir).some(
          (record) => record.transition.node_id === "n1",
        ),
      "n1 journal record",
      15_000,
    );
    const markersBeforeKill = Object.fromEntries(
      ["n1.marker", "n2.marker", "n3.marker", "term.marker"].map((name) => [
        name,
        existsSync(join(markers, name))
          ? statSync(join(markers, name)).mtimeMs
          : null,
      ]),
    );
    expect(first.pid).toBeDefined();
    killProcessTree(first.pid as number);
    const killed = await first.done;
    expect(killed.stdout).not.toContain("[done] succeeded");

    // Crash semantics: the lock file stays behind (abnormal exit).
    const lockPath = join(runDir, "owner.lock");
    expect(existsSync(lockPath)).toBe(true);

    // Backdate the dead owner past the stale grace so the takeover path is
    // exercised deterministically instead of busy-failing for 30s.
    const past = new Date(Date.now() - 120_000);
    utimesSync(lockPath, past, past);

    // --- Run 2: resume completes exit 0 without re-running n1. ---
    const resumed = await spawnGraphRun(runsRoot, markers).done;
    if (resumed.code !== 0) {
      throw new Error(
        `resume exited ${resumed.code}\nstdout:\n${resumed.stdout}\nstderr:\n${resumed.stderr}`,
      );
    }

    // Skip evidence 1: the resume replayed exactly the one journaled record.
    expect(resumed.stdout).toContain("[replay] 1 record(s)");
    // Skip evidence 2: n1 never started an activation in the resumed process.
    expect(resumed.stdout).not.toMatch(/\[node\] n1 /);
    // Skip evidence 3: exactly one committed n1 record, written by epoch 1.
    const records = journalRecords(runDir);
    const n1Records = records.filter(
      (record) => record.transition.node_id === "n1",
    );
    expect(n1Records).toHaveLength(1);
    expect(n1Records[0].epoch).toBe(1);
    // Takeover advanced the epoch: resumed commits carry epoch >= 2.
    const resumedCommits = records.filter(
      (record) => record.transition.node_id !== "n1",
    );
    expect(resumedCommits.map((record) => record.transition.node_id)).toEqual([
      "n2",
      "n3",
      "term",
    ]);
    for (const record of resumedCommits) {
      expect(record.epoch).toBeGreaterThanOrEqual(2);
    }
    // Skip evidence 4: n1's marker was not rewritten by a re-execution.
    expect(statSync(join(markers, "n1.marker")).mtimeMs).toBe(
      markersBeforeKill["n1.marker"],
    );
    for (const name of ["n2.marker", "n3.marker", "term.marker"]) {
      expect(existsSync(join(markers, name))).toBe(true);
    }

    // --- AC-3: same graph, no kill, fresh dirs -> identical projection. ---
    const direct = await spawnGraphRun(directRunsRoot, directMarkers).done;
    if (direct.code !== 0) {
      throw new Error(
        `direct run exited ${direct.code}\nstdout:\n${direct.stdout}\nstderr:\n${direct.stderr}`,
      );
    }
    expect(direct.stdout).toContain("[replay] 0 record(s)");

    const envelopeA = JSON.parse(
      readFileSync(join(runsRoot, RUN_ID, "projection.json"), "utf8"),
    ) as { projection: unknown };
    const envelopeB = JSON.parse(
      readFileSync(join(directRunsRoot, RUN_ID, "projection.json"), "utf8"),
    ) as { projection: unknown };
    // The command executor measures wall-clock per attempt and embeds
    // duration_ms into output_summary/evidence; request_fingerprint is a hash
    // over that raw content, so both are run-to-run variance. Normalize them.
    expect(canonicalJson(normalizeVolatile(envelopeA.projection))).toBe(
      canonicalJson(normalizeVolatile(envelopeB.projection)),
    );
  }, 300_000);
});

/**
 * Neutralizes run-to-run volatile values: executor-measured `duration_ms=N`
 * tokens inside strings, and `request_fingerprint` hashes derived from them.
 */
function normalizeVolatile(value: unknown, key?: string): unknown {
  if (key === "request_fingerprint") return "<derived-from-measured-io>";
  if (typeof value === "string") {
    return value.replace(/duration_ms=\d+/g, "duration_ms=<measured>");
  }
  if (Array.isArray(value)) {
    return value.map((child) => normalizeVolatile(child));
  }
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        normalizeVolatile(child, childKey),
      ]),
    );
  }
  return value;
}
