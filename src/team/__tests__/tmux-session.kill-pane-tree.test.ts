import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const tmuxUtilsMocks = vi.hoisted(() => ({
  tmuxExec: vi.fn(),
  tmuxExecAsync: vi.fn(),
  tmuxShell: vi.fn(),
  tmuxCmdAsync: vi.fn(),
}));

vi.mock("../../cli/tmux-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cli/tmux-utils.js")>()),
  tmuxExec: tmuxUtilsMocks.tmuxExec,
  tmuxExecAsync: tmuxUtilsMocks.tmuxExecAsync,
  tmuxShell: tmuxUtilsMocks.tmuxShell,
  tmuxCmdAsync: tmuxUtilsMocks.tmuxCmdAsync,
}));

import { killWorkerPaneProcessTree } from "../tmux-session.js";

const execFileAsync = promisify(execFile);

// Digits only: the fixture encodes this tag as the fractional part of a sleep argument.
const TAG = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
const IDENTITY = {
  socket_path: "/tmp/omc-kill-pane-tree-test.sock",
  server_pid: 1,
  process_started_at: "kill-pane-tree-test",
};

const spawned: ChildProcess[] = [];

/** Stands in for the tmux pane: the mocked guarded query answers with this PID as `#{pane_pid}`. */
function mockPanePid(panePid: number): void {
  tmuxUtilsMocks.tmuxCmdAsync.mockImplementation(async (args: string[]) => {
    const marker = args.join(" ").match(/OMC_TMUX_GUARD_OK_[A-Za-z0-9_]+/)?.[0];
    if (!marker) return { stdout: "", stderr: "" };
    return { stdout: `${panePid}\n${marker}\n`, stderr: "" };
  });
}

/** Starts a pane root process; the root is `sh`, and `script` runs inside it. */
function startPane(script: string): ChildProcess {
  const child = spawn("sh", ["-c", script], { stdio: "ignore" });
  spawned.push(child);
  return child;
}

async function listProcesses(): Promise<Array<{ pid: number; ppid: number; args: string }>> {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,args="], { timeout: 5_000 });
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] }));
}

/** Sleep processes started by this test: the whole command line is `sleep <secs>.<TAG>`. */
async function taggedSleeps(secs: string): Promise<Array<{ pid: number; ppid: number; args: string }>> {
  const re = new RegExp(`^sleep ${secs}\\.${TAG}$`);
  return (await listProcesses()).filter((p) => re.test(p.args));
}

/** Kills every process of this run (fixture shells and their sleeps) by PID, from the process table. */
async function killTagged(): Promise<void> {
  for (const p of (await listProcesses()).filter((x) => x.args.includes(TAG))) {
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {
      /* already exited */
    }
  }
}

async function waitForTaggedSleeps(secs: string, count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await taggedSleeps(secs)).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`fixture processes sleep ${secs}.${TAG} did not start`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

beforeEach(() => {
  tmuxUtilsMocks.tmuxCmdAsync.mockReset();
  delete process.env.OMC_TEAM_KILL_PANE_TREE;
});

afterEach(async () => {
  delete process.env.OMC_TEAM_KILL_PANE_TREE;
  vi.restoreAllMocks();
  for (const child of spawned.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }
  await killTagged();
});

afterAll(async () => {
  await killTagged();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect((await listProcesses()).filter((p) => p.args.includes(TAG)).map((p) => p.pid)).toEqual([]);
});

describe("killWorkerPaneProcessTree (opt-in OMC_TEAM_KILL_PANE_TREE=1)", () => {
  it("does nothing without the variable: no tmux query and descendants keep running", async () => {
    const pane = startPane(`sh -c 'sleep 240.${TAG}' & sleep 241.${TAG} & wait`);
    await waitForTaggedSleeps("240", 1);
    await waitForTaggedSleeps("241", 1);
    mockPanePid(pane.pid!);

    await killWorkerPaneProcessTree(IDENTITY, "%7");

    expect(tmuxUtilsMocks.tmuxCmdAsync).not.toHaveBeenCalled();
    expect((await taggedSleeps("240")).length).toBe(1);
    expect((await taggedSleeps("241")).length).toBe(1);
  });

  it("with the variable set: terminates all descendants, including grandchildren, and leaves the pane root", async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = "1";
    const pane = startPane(`sh -c 'sleep 240.${TAG}' & sleep 241.${TAG} & wait`);
    await waitForTaggedSleeps("240", 1);
    await waitForTaggedSleeps("241", 1);
    mockPanePid(pane.pid!);
    const killSpy = vi.spyOn(process, "kill");

    await killWorkerPaneProcessTree(IDENTITY, "%7");

    expect((await taggedSleeps("240")).length).toBe(0);
    expect((await taggedSleeps("241")).length).toBe(0);
    expect(killSpy.mock.calls.some(([pid]) => pid === pane.pid)).toBe(false);
  });

  it("returns without waiting when the pane root has no descendants", async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = "1";
    const pane = startPane(`exec sleep 240.${TAG}`);
    await waitForTaggedSleeps("240", 1);
    mockPanePid(pane.pid!);

    const started = Date.now();
    await killWorkerPaneProcessTree(IDENTITY, "%7");

    expect(Date.now() - started).toBeLessThan(1_500);
    expect(isAlive(pane.pid!)).toBe(true);
  });

  it("never signals its own process when the reported pane PID is this process", async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = "1";
    const killSpy = vi.spyOn(process, "kill");
    mockPanePid(process.pid);

    await killWorkerPaneProcessTree(IDENTITY, "%7");

    expect(killSpy).not.toHaveBeenCalled();
  });

  it("does nothing when the guarded tmux read is not executed", async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = "1";
    const pane = startPane(`sh -c 'sleep 240.${TAG}' & wait`);
    await waitForTaggedSleeps("240", 1);
    tmuxUtilsMocks.tmuxCmdAsync.mockResolvedValue({ stdout: "", stderr: "tmux_server_unavailable" });

    await killWorkerPaneProcessTree(IDENTITY, "%7");

    expect((await taggedSleeps("240")).length).toBe(1);
    expect(isAlive(pane.pid!)).toBe(true);
  });
});
