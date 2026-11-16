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

import { killOwnedWorkerPane, killWorkerPaneProcessTree, type WorkerPaneOwnership } from "../tmux-session.js";
import { currentStrictProcessStartIdentity } from "../team-owner-epoch.js";

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
  tmuxUtilsMocks.tmuxExecAsync.mockReset();
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

  it.skipIf(currentStrictProcessStartIdentity(process.pid) === null)(
    "with the variable set: SIGKILLs a descendant that ignores SIGTERM, using the default identity reader",
    async () => {
      process.env.OMC_TEAM_KILL_PANE_TREE = "1";
      // The child shell ignores SIGTERM and `exec` keeps that disposition, so the sleep survives SIGTERM.
      // The root execs a longer sleep so it outlives its child, which is killed during the test.
      const pane = startPane(`sh -c 'trap "" TERM; exec sleep 240.${TAG}' & exec sleep 243.${TAG}`);
      await waitForTaggedSleeps("240", 1);
      mockPanePid(pane.pid!);

      await killWorkerPaneProcessTree(IDENTITY, "%7");

      expect((await taggedSleeps("240")).length).toBe(0);
      expect(isAlive(pane.pid!)).toBe(true);
    },
    30_000,
  );

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

describe("killWorkerPaneProcessTree SIGKILL identity check (injected dependencies, no real signals)", () => {
  const FAKE_PANE_PID = 4_000_000;
  const CHILD = 4_000_001;
  const GRANDCHILD = 4_000_002;
  const sleepArgs: number[] = [];

  /** Runs the tree kill against a fake process table; every signal goes to the recorder. */
  async function run(options: {
    identityAfterTerm: (pid: number) => string | null;
    aliveAfterTerm?: (pid: number) => boolean;
  }): Promise<Array<[number, NodeJS.Signals | 0]>> {
    process.env.OMC_TEAM_KILL_PANE_TREE = "1";
    mockPanePid(FAKE_PANE_PID);
    const calls: Array<[number, NodeJS.Signals | 0]> = [];
    sleepArgs.length = 0;
    let waited = false;
    await killWorkerPaneProcessTree(IDENTITY, "%7", {
      readProcessRecords: async () =>
        new Map([
          [CHILD, { ppid: FAKE_PANE_PID }],
          [GRANDCHILD, { ppid: CHILD }],
        ]),
      processIdentity: (pid) => (waited ? options.identityAfterTerm(pid) : `start-${pid}`),
      killProcess: (pid, signal) => {
        calls.push([pid, signal]);
        if (signal === 0 && !(options.aliveAfterTerm?.(pid) ?? true)) {
          throw Object.assign(new Error("no such process"), { code: "ESRCH" });
        }
      },
      sleep: async (ms) => {
        sleepArgs.push(ms);
        waited = true;
      },
    });
    return calls;
  }

  const sigkills = (calls: Array<[number, NodeJS.Signals | 0]>): number[] =>
    calls.filter(([, signal]) => signal === "SIGKILL").map(([pid]) => pid);

  it("sends SIGKILL to a survivor whose start identity is unchanged", async () => {
    const calls = await run({ identityAfterTerm: (pid) => `start-${pid}` });

    expect(calls.filter(([, signal]) => signal === "SIGTERM").map(([pid]) => pid)).toEqual([GRANDCHILD, CHILD]);
    expect(sigkills(calls)).toEqual([GRANDCHILD, CHILD]);
    expect(calls.some(([pid]) => pid === FAKE_PANE_PID)).toBe(false);
  });

  it("waits 2000 ms between SIGTERM and SIGKILL when the pane root has descendants", async () => {
    await run({ identityAfterTerm: (pid) => `start-${pid}` });

    expect(sleepArgs).toEqual([2000]);
  });

  it("does not wait when the pane root has no descendants", async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = "1";
    mockPanePid(FAKE_PANE_PID);
    const calls: Array<[number, NodeJS.Signals | 0]> = [];
    const waits: number[] = [];

    await killWorkerPaneProcessTree(IDENTITY, "%7", {
      readProcessRecords: async () => new Map(),
      processIdentity: () => null,
      killProcess: (pid, signal) => {
        calls.push([pid, signal]);
      },
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    expect(calls).toEqual([]);
    expect(waits).toEqual([]);
  });

  it("sends no SIGKILL when the start identity throws after the wait", async () => {
    const calls = await run({
      identityAfterTerm: () => {
        throw new Error("identity unreadable");
      },
    });

    expect(calls.filter(([, signal]) => signal === "SIGTERM").map(([pid]) => pid)).toEqual([GRANDCHILD, CHILD]);
    expect(sigkills(calls)).toEqual([]);
  });

  it("does not send SIGKILL to a PID that was reused by a different process", async () => {
    const calls = await run({
      identityAfterTerm: (pid) => (pid === CHILD ? "start-of-an-unrelated-process" : `start-${pid}`),
    });

    expect(sigkills(calls)).toEqual([GRANDCHILD]);
  });

  it("does not send SIGKILL to a PID that is no longer alive", async () => {
    const calls = await run({
      identityAfterTerm: (pid) => `start-${pid}`,
      aliveAfterTerm: (pid) => pid !== GRANDCHILD,
    });

    expect(sigkills(calls)).toEqual([CHILD]);
  });

  it("skips a PID whose start identity cannot be read after the wait", async () => {
    const calls = await run({ identityAfterTerm: () => null });

    expect(sigkills(calls)).toEqual([]);
  });

  it("skips a PID whose start identity could not be read when the tree was read", async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = "1";
    mockPanePid(FAKE_PANE_PID);
    const calls: Array<[number, NodeJS.Signals | 0]> = [];

    await killWorkerPaneProcessTree(IDENTITY, "%7", {
      readProcessRecords: async () => new Map([[CHILD, { ppid: FAKE_PANE_PID }]]),
      processIdentity: () => null,
      killProcess: (pid, signal) => {
        calls.push([pid, signal]);
      },
      sleep: async () => undefined,
    });

    expect(calls.filter(([, signal]) => signal === "SIGTERM")).toEqual([[CHILD, "SIGTERM"]]);
    expect(calls.some(([, signal]) => signal === "SIGKILL")).toBe(false);
  });
});

describe.skipIf(currentStrictProcessStartIdentity(process.pid) === null)("killOwnedWorkerPane (tmux) and the pane process tree", () => {
  const PANE_ID = "%7";
  // The identity of this very process, so that the real server identity and ownership checks pass against the mocked tmux.
  const OWN_IDENTITY = {
    socket_path: "/tmp/omc-kill-pane-tree-test.sock",
    server_pid: process.pid,
    process_started_at: currentStrictProcessStartIdentity(process.pid) ?? "unavailable",
  };
  const ownership: WorkerPaneOwnership = {
    provider: "tmux",
    providerTarget: "leader-session:0",
    paneId: PANE_ID,
    splitTarget: "",
    leaderPaneId: "%1",
    reservedPaneIds: [],
    source: "adopted",
    tmuxServerIdentity: OWN_IDENTITY,
  };

  /** Answers the identity probe, the membership list and the two guarded commands; records their order. */
  function mockTmuxServer(panePid: number): { events: string[]; sleepsAtKillPane: number[] } {
    const events: string[] = [];
    const sleepsAtKillPane: number[] = [];
    tmuxUtilsMocks.tmuxExecAsync.mockImplementation(async (args: string[]) => ({
      stdout: args.includes("list-panes") ? `${PANE_ID}\n%1\n` : "",
      stderr: "",
    }));
    tmuxUtilsMocks.tmuxCmdAsync.mockImplementation(async (args: string[]) => {
      if (args[2] === "display-message") return { stdout: `${process.pid}\n`, stderr: "" };
      const joined = args.join(" ");
      const marker = joined.match(/OMC_TMUX_GUARD_OK_[A-Za-z0-9_]+/)?.[0];
      if (args[2] !== "if-shell" || !marker) return { stdout: "", stderr: "" };
      if (joined.includes("#{pane_pid}")) {
        events.push("pane-pid-query");
        return { stdout: `${panePid}\n${marker}\n`, stderr: "" };
      }
      if (joined.includes("kill-pane")) {
        events.push("kill-pane");
        sleepsAtKillPane.push((await taggedSleeps("240")).length, (await taggedSleeps("241")).length);
        return { stdout: `${marker}\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    return { events, sleepsAtKillPane };
  }

  it("with the variable set: the descendants are gone before kill-pane is issued", async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = "1";
    const pane = startPane(`sh -c 'sleep 240.${TAG}' & sleep 241.${TAG} & wait`);
    await waitForTaggedSleeps("240", 1);
    await waitForTaggedSleeps("241", 1);
    const { events, sleepsAtKillPane } = mockTmuxServer(pane.pid!);
    const killSpy = vi.spyOn(process, "kill");

    await killOwnedWorkerPane(ownership);

    expect(events).toEqual(["pane-pid-query", "kill-pane"]);
    expect(sleepsAtKillPane).toEqual([0, 0]);
    // The pane root is left to the pane kill: it is never signalled by the tree kill.
    expect(killSpy.mock.calls.some(([pid]) => pid === pane.pid)).toBe(false);
  }, 30_000);

  it("without the variable: the pane is killed with no tree query and the descendants are left alone", async () => {
    const pane = startPane(`sh -c 'sleep 240.${TAG}' & sleep 241.${TAG} & wait`);
    await waitForTaggedSleeps("240", 1);
    await waitForTaggedSleeps("241", 1);
    const { events, sleepsAtKillPane } = mockTmuxServer(pane.pid!);

    await killOwnedWorkerPane(ownership);

    expect(events).toEqual(["kill-pane"]);
    expect(sleepsAtKillPane).toEqual([1, 1]);
  });
});
