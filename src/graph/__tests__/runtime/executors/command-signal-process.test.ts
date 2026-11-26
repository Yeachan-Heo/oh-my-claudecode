/**
 * Graph run signal cleanup with real processes (OMC_GRAPH_SIGNAL_CLEANUP=1).
 *
 * Each case starts the real CLI (`omc graph run`) in a child process, interrupts it with a real
 * signal, and checks the exit code, the step processes left behind and the run state on disk.
 * A step is a `command` node that runs a small script: the script logs its start, records its pid,
 * optionally ignores SIGTERM, and blocks until its release file exists. Steps stand in for
 * long-running worker teams, which need tmux and a provider.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { readRunStatus } from "../../../runtime/run-status.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const CLI_ENTRY = fileURLToPath(new URL("../../../../cli/index.ts", import.meta.url));
const SWITCH = "OMC_GRAPH_SIGNAL_CLEANUP";
const NODE_OK = 'node -e "process.exit(0)"';
const STEP_TIMEOUT_MS = 90_000;

// Stand-in for one graph step: logs its start, records its pid, optionally ignores SIGTERM,
// and exits once its release file exists.
const STEP_SCRIPT = `const { appendFileSync, existsSync, writeFileSync } = require("node:fs");
const [logFile, stepId, pidFile, releaseFile, mode] = process.argv.slice(2);
appendFileSync(logFile, stepId + "\\n");
writeFileSync(pidFile, String(process.pid));
if (mode === "ignore-term") process.on("SIGTERM", () => {});
const timer = setInterval(() => {
  if (existsSync(releaseFile)) {
    clearInterval(timer);
    process.exit(0);
  }
}, 100);
`;

/** Forward slashes inside a double-quoted shell argument (Windows backslashes are not portable there). */
const slash = (path: string): string => path.split(sep).join("/");

interface CliResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly out: string;
}

interface Fixture {
  readonly dir: string;
  readonly runsRoot: string;
  readonly script: string;
  readonly log: string;
  readonly descriptor: string;
}

const tempDirs: string[] = [];
const stepPids: number[] = [];
const cliPids: number[] = [];

function fixture(name: string): Fixture {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `graph-signal-${name}-`)));
  tempDirs.push(dir);
  const script = join(dir, "step.cjs");
  writeFileSync(script, STEP_SCRIPT);
  return { dir, runsRoot: join(dir, "runs"), script, log: join(dir, "steps.log"), descriptor: join(dir, "descriptor.json") };
}

function release(fx: Fixture, stepId: string): string {
  return join(fx.dir, `${stepId}.release`);
}

function pidFile(fx: Fixture, stepId: string): string {
  return join(fx.dir, `${stepId}.pid`);
}

/** A step that logs its start and exits at once when `open` is true, else blocks until released. */
function stepCommand(fx: Fixture, stepId: string, open: boolean, ignoreTerm = false): string {
  if (open) writeFileSync(release(fx, stepId), "");
  const mode = ignoreTerm ? " ignore-term" : "";
  return `node "${slash(fx.script)}" "${slash(fx.log)}" ${stepId} "${slash(pidFile(fx, stepId))}" "${slash(release(fx, stepId))}"${mode}`;
}

function commandNode(id: string, command: string) {
  return {
    id,
    kind: "command" as const,
    title: `Step ${id}`,
    timeout_ms: 600_000,
    max_attempts: 1,
    effect_policy: { policy: "side_effect_free" as const },
    command,
  };
}

function chainDescriptor(runId: string, step1: string, step2: string) {
  return {
    descriptor_version: 1,
    run_id: runId,
    revision_id: `rev-${runId}`,
    goal: "signal cleanup chain",
    nodes: [commandNode("step-1", step1), commandNode("step-2", step2)],
    edges: [{ id: "e-1-2", kind: "fixed" as const, from: "step-1", to: "step-2" }],
    entry_node_ids: ["step-1"],
    concurrency_limit: 1,
    terminal_verification_node_id: "step-2",
  };
}

function writeDescriptor(fx: Fixture, descriptor: unknown): void {
  writeFileSync(fx.descriptor, JSON.stringify(descriptor));
}

/** Environment of the child CLI: no OMC_* or TYPESAFE_* variables from the outside, the switch only when asked. */
function cliEnv(switchOn: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(OMC_|TYPESAFE_)/.test(name)) delete env[name];
  }
  if (switchOn) env[SWITCH] = "1";
  return env;
}

interface StartedCli {
  readonly child: ChildProcess;
  readonly done: Promise<CliResult>;
}

function startRun(fx: Fixture, switchOn: boolean): StartedCli {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", CLI_ENTRY, "graph", "run", fx.descriptor, "--runs-root", fx.runsRoot],
    { cwd: REPO_ROOT, env: cliEnv(switchOn), stdio: ["ignore", "pipe", "pipe"] },
  );
  // Recorded at once, so afterEach can kill the CLI even when a test timed out before reading a step pid.
  if (child.pid !== undefined) cliPids.push(child.pid);
  let out = "";
  child.stdout?.on("data", (chunk) => (out += chunk));
  child.stderr?.on("data", (chunk) => (out += chunk));
  const done = new Promise<CliResult>((resolve) => {
    // A step process can inherit the pipes and keep them open, so 'close' may never come: resolve on
    // 'exit' after a short window for the remaining output to arrive.
    child.on("exit", (code, signal) => {
      setTimeout(() => resolve({ code, signal, out }), 500);
    });
  });
  return { child, done };
}

/** Runs the CLI to its end (no interrupt) and returns its result. */
async function runToEnd(fx: Fixture, switchOn: boolean): Promise<CliResult> {
  return startRun(fx, switchOn).done;
}

async function until(condition: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function pidOf(fx: Fixture, stepId: string): number {
  const pid = Number(readFileSync(pidFile(fx, stepId), "utf8"));
  stepPids.push(pid);
  return pid;
}

/** True while the process exists and is not a zombie (Linux: /proc state; elsewhere: existence only). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
}

/**
 * An interrupted run leaves its owner.lock behind (the signal path exits without releasing the fence),
 * and the fence takes over a dead owner's lock only after its 30 s grace period. The test ages the
 * lock past that grace period instead of waiting 30 s, as if the interrupted owner had died long ago.
 */
function agePastStaleGrace(fx: Fixture, runId: string): void {
  const lock = join(fx.runsRoot, runId, "owner.lock");
  if (!existsSync(lock)) return;
  const old = new Date(Date.now() - 120_000);
  utimesSync(lock, old, old);
}

function startsOf(fx: Fixture, stepId: string): number {
  if (!existsSync(fx.log)) return 0;
  return readFileSync(fx.log, "utf8").split("\n").filter((line) => line === stepId).length;
}

function statusOf(fx: Fixture, runId: string): { state: string; nodes: Array<{ id: string; state: string }> } {
  const outcome = readRunStatus({ runId, runsRoot: fx.runsRoot });
  return JSON.parse(outcome.stdout) as { state: string; nodes: Array<{ id: string; state: string }> };
}

afterEach(() => {
  for (const pid of [...cliPids.splice(0), ...stepPids.splice(0)]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.runIf(process.platform !== "win32")("graph run with real signals (switch off)", () => {
  // The CLI survives SIGTERM here because of an unrelated handler, not because of the graph code: the LSP
  // client manager registers SIGTERM, SIGINT and SIGHUP listeners at startup, and they stop the language
  // servers without exiting. This test only checks that the graph adds no exit of its own while the switch
  // is off. It does not test the LSP handler, and it can change if that handler or the import order changes.
  it("without the switch SIGTERM neither ends the run nor stops its running step", async () => {
    const fx = fixture("no-switch");
    writeDescriptor(fx, chainDescriptor("sig-no-switch", stepCommand(fx, "step-1", false), NODE_OK));
    const started = startRun(fx, false);
    await until(() => existsSync(pidFile(fx, "step-1")), 30_000, "step 1 to start");
    const stepPid = pidOf(fx, "step-1");

    started.child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    // The signal cleanup is not installed, and the run itself does not end on SIGTERM. The step is in its own
    // process group, so the signal does not reach it either. The run is stopped here so that nothing is left behind.
    expect(started.child.exitCode, "the run ended on SIGTERM").toBeNull();
    expect(started.child.signalCode, "the run was killed by SIGTERM").toBeNull();
    expect(isAlive(stepPid), "the step was stopped without the switch").toBe(true);
    started.child.kill("SIGKILL");
    await started.done;
  }, STEP_TIMEOUT_MS);
});

describe.runIf(process.platform !== "win32")("graph run with real signals (switch on)", () => {
  it("SIGTERM: a step that ignores SIGTERM is killed after the 5 s grace; the run exits 143 and no step survives", async () => {
    const fx = fixture("sigkill");
    writeDescriptor(fx, chainDescriptor("sig-kill", stepCommand(fx, "step-1", false, true), NODE_OK));
    const started = startRun(fx, true);
    await until(() => existsSync(pidFile(fx, "step-1")), 30_000, "step 1 to start");
    const stepPid = pidOf(fx, "step-1");
    expect(isAlive(stepPid), "control: step alive before the signal").toBe(true);

    const sentAt = Date.now();
    started.child.kill("SIGTERM");
    const result = await started.done;
    expect(result.code, result.out).toBe(143);
    // The step ignored SIGTERM, so it could only end by the SIGKILL escalation, after the 5 s grace.
    expect(Date.now() - sentAt).toBeGreaterThanOrEqual(4_500);
    await until(() => !isAlive(stepPid), 10_000, "step to die");
    expect(isAlive(stepPid), "step still alive 10 s after SIGTERM").toBe(false);
  }, STEP_TIMEOUT_MS);

  it("SIGTERM: a descendant that ignores SIGTERM and holds no pipe outlives its shell; the run exits only after the SIGKILL", async () => {
    const fx = fixture("descendant");
    // The shell stays alive (`wait`) and dies of SIGTERM at once, but the step it started in the background
    // ignores SIGTERM and has closed stdio, so the shell's own close event proves nothing about the step.
    const detached = `${stepCommand(fx, "step-1", false, true)} >/dev/null 2>&1 </dev/null & wait`;
    writeDescriptor(fx, chainDescriptor("sig-descendant", detached, NODE_OK));
    const started = startRun(fx, true);
    await until(() => existsSync(pidFile(fx, "step-1")), 30_000, "step 1 to start");
    const stepPid = pidOf(fx, "step-1");
    expect(isAlive(stepPid), "control: step alive before the signal").toBe(true);

    const sentAt = Date.now();
    started.child.kill("SIGTERM");
    const result = await started.done;
    expect(result.code, result.out).toBe(143);
    // The exit waited for the 5 s grace and the SIGKILL of the process group; it did not follow the shell's close.
    expect(Date.now() - sentAt).toBeGreaterThanOrEqual(4_500);
    await until(() => !isAlive(stepPid), 5_000, "step to die");
    expect(isAlive(stepPid), "the step outlived the run").toBe(false);
  }, STEP_TIMEOUT_MS);

  it("SIGINT during a running step stops it and exits 130; the step does not survive", async () => {
    const fx = fixture("sigint");
    writeDescriptor(fx, chainDescriptor("sig-int", stepCommand(fx, "step-1", false), NODE_OK));
    const started = startRun(fx, true);
    await until(() => existsSync(pidFile(fx, "step-1")), 30_000, "step 1 to start");
    const stepPid = pidOf(fx, "step-1");
    expect(isAlive(stepPid), "control: step alive before the signal").toBe(true);

    started.child.kill("SIGINT");
    const result = await started.done;
    expect(result.code, result.out).toBe(130);
    await until(() => !isAlive(stepPid), 10_000, "step to die");
    expect(isAlive(stepPid), "step still alive 10 s after SIGINT").toBe(false);
  }, STEP_TIMEOUT_MS);

  it("two branches in flight when the run is interrupted: no branch is journalled as failed, and a rerun runs them", async () => {
    const fx = fixture("parallel");
    const plain = { policy: "side_effect_free" as const };
    const descriptor = {
      descriptor_version: 1,
      run_id: "sig-parallel",
      revision_id: "rev-sig-parallel",
      goal: "two branches in flight, then a join",
      concurrency_limit: 2,
      entry_node_ids: ["start"],
      terminal_verification_node_id: "end",
      nodes: [
        { id: "start", title: "start", kind: "command", command: NODE_OK, timeout_ms: 60_000, max_attempts: 1, effect_policy: plain },
        { id: "a", title: "branch a", kind: "command", command: stepCommand(fx, "branch-a", false), timeout_ms: 600_000, max_attempts: 1, effect_policy: plain },
        { id: "b", title: "branch b", kind: "command", command: stepCommand(fx, "branch-b", false), timeout_ms: 600_000, max_attempts: 1, effect_policy: plain },
        { id: "join", title: "join", kind: "join", fan_out_node_id: "start", input_branch_ids: ["branch-a", "branch-b"] },
        { id: "end", title: "end", kind: "command", command: NODE_OK, timeout_ms: 60_000, max_attempts: 1, effect_policy: plain },
      ],
      edges: [
        { id: "fan-a", kind: "fan_out", from: "start", to: "a", branch_id: "branch-a", owner_join_id: "join" },
        { id: "fan-b", kind: "fan_out", from: "start", to: "b", branch_id: "branch-b", owner_join_id: "join" },
        { id: "a-to-join", kind: "fixed", from: "a", to: "join" },
        { id: "b-to-join", kind: "fixed", from: "b", to: "join" },
        { id: "join-to-end", kind: "fixed", from: "join", to: "end" },
      ],
    };
    writeDescriptor(fx, descriptor);
    const started = startRun(fx, true);
    await until(() => existsSync(pidFile(fx, "branch-a")) && existsSync(pidFile(fx, "branch-b")), 30_000, "both branches in flight");
    started.child.kill("SIGTERM");
    const result = await started.done;
    expect(result.code, result.out).toBe(143);

    const report = statusOf(fx, "sig-parallel");
    expect(report.state, JSON.stringify(report)).not.toBe("failed");
    for (const id of ["a", "b"]) {
      expect(report.nodes.find((node) => node.id === id)?.state, `branch ${id}`).not.toBe("failed");
    }
    writeFileSync(release(fx, "branch-a"), "");
    writeFileSync(release(fx, "branch-b"), "");
    agePastStaleGrace(fx, "sig-parallel");
    const rerun = await runToEnd(fx, false);
    expect(rerun.code, rerun.out).toBe(0);
    expect(statusOf(fx, "sig-parallel").state).toBe("succeeded");
  }, STEP_TIMEOUT_MS);

  it("interrupt before the first committed transition: a rerun with the same run_id exits 20", async () => {
    const fx = fixture("resume-first");
    writeDescriptor(fx, chainDescriptor("sig-resume-first", stepCommand(fx, "step-1", false), NODE_OK));
    const started = startRun(fx, true);
    await until(() => existsSync(pidFile(fx, "step-1")), 30_000, "step 1 to start");
    started.child.kill("SIGTERM");
    expect((await started.done).code).toBe(143);

    // The descriptor is persisted but the journal has no committed transition: the run is refused.
    agePastStaleGrace(fx, "sig-resume-first");
    const rerun = await runToEnd(fx, false);
    expect(rerun.code, rerun.out).toBe(20);
    expect(rerun.out).toMatch(/no committed journal history/);
    expect(startsOf(fx, "step-1"), "nothing runs after the refusal").toBe(1);
  }, STEP_TIMEOUT_MS);

  it("rerun with the same run_id after an interrupt in step 2 resumes without repeating step 1", async () => {
    const fx = fixture("resume");
    writeDescriptor(fx, chainDescriptor("sig-resume", stepCommand(fx, "step-1", true), stepCommand(fx, "step-2", false)));
    const started = startRun(fx, true);
    await until(() => existsSync(pidFile(fx, "step-2")), 60_000, "step 2 to start");
    expect(startsOf(fx, "step-1"), "step 1 ran once before the interrupt").toBe(1);
    started.child.kill("SIGTERM");
    expect((await started.done).code).toBe(143);

    writeFileSync(release(fx, "step-2"), "");
    agePastStaleGrace(fx, "sig-resume");
    const rerun = await runToEnd(fx, false);
    expect(rerun.code, rerun.out).toBe(0);
    expect(statusOf(fx, "sig-resume").state).toBe("succeeded");
    expect(startsOf(fx, "step-1"), "committed step 1 must not run again").toBe(1);
    expect(startsOf(fx, "step-2"), "step 2 runs again after the interrupt").toBe(2);
  }, STEP_TIMEOUT_MS);

  it("a finished run is replayed by the same run_id without starting any step", async () => {
    const fx = fixture("replay");
    writeDescriptor(fx, chainDescriptor("sig-replay", stepCommand(fx, "step-1", true), stepCommand(fx, "step-2", true)));
    expect((await runToEnd(fx, false)).code).toBe(0);
    const before = startsOf(fx, "step-1") + startsOf(fx, "step-2");
    const again = await runToEnd(fx, false);
    expect(again.code, again.out).toBe(0);
    expect(startsOf(fx, "step-1") + startsOf(fx, "step-2")).toBe(before);
  }, STEP_TIMEOUT_MS);
});
