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

import {
  capturePaneProcessTree,
  killOwnedWorkerPane,
  killWorkerPaneProcessTree,
  terminatePaneProcessTree,
  type WorkerPaneOwnership,
} from "../tmux-session.js";
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

/**
 * Stands in for the tmux pane: the mocked guarded query answers `#{pane_pid} #{pane_dead}` with this PID and a live pane. `afterwards`
 * are the answers to the queries after the first (the last one repeats): another PID, or a dead pane. Without it the pane stays alive
 * on the same PID.
 */
function mockPanePid(panePid: number, ...afterwards: Array<{ pid: number; dead?: boolean }>): void {
  let queries = 0;
  tmuxUtilsMocks.tmuxCmdAsync.mockImplementation(async (args: string[]) => {
    const marker = args.join(" ").match(/OMC_TMUX_GUARD_OK_[A-Za-z0-9_]+/)?.[0];
    if (!marker) return { stdout: "", stderr: "" };
    const answer =
      queries === 0 || afterwards.length === 0
        ? { pid: panePid, dead: false }
        : afterwards[Math.min(queries - 1, afterwards.length - 1)]!;
    queries += 1;
    return { stdout: `${answer.pid} ${answer.dead ? 1 : 0}\n${marker}\n`, stderr: "" };
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

describe("killWorkerPaneProcessTree with a pane root that is not the one it read (real processes)", () => {
  it("signals nothing when the pane is dead at the second read: the descendants keep running and the root is not touched", async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = "1";
    const pane = startPane(`sh -c 'sleep 240.${TAG}' & sleep 241.${TAG} & wait`);
    await waitForTaggedSleeps("240", 1);
    await waitForTaggedSleeps("241", 1);
    mockPanePid(pane.pid!, { pid: pane.pid!, dead: true });
    const killSpy = vi.spyOn(process, "kill");

    await killWorkerPaneProcessTree(IDENTITY, "%7");

    expect((await taggedSleeps("240")).length).toBe(1);
    expect((await taggedSleeps("241")).length).toBe(1);
    expect(killSpy.mock.calls.filter(([, signal]) => signal === "SIGTERM" || signal === "SIGKILL")).toEqual([]);
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
      processIdentity: (pid) => (pid === FAKE_PANE_PID ? "root-incarnation" : null),
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

  it("signals nothing for a PID whose start identity could not be read when the tree was read", async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = "1";
    mockPanePid(FAKE_PANE_PID);
    const calls: Array<[number, NodeJS.Signals | 0]> = [];
    const waits: number[] = [];

    await killWorkerPaneProcessTree(IDENTITY, "%7", {
      readProcessRecords: async () => new Map([[CHILD, { ppid: FAKE_PANE_PID }]]),
      processIdentity: (pid) => (pid === FAKE_PANE_PID ? "root-incarnation" : null),
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
});

describe("pane process tree captured first and terminated later (injected dependencies, no real signals)", () => {
  const FAKE_PANE_PID = 4_000_000;
  const CHILD = 4_000_001;
  const GRANDCHILD = 4_000_002;
  const records = async () =>
    new Map([
      [CHILD, { ppid: FAKE_PANE_PID }],
      [GRANDCHILD, { ppid: CHILD }],
    ]);

  it("without the variable the capture is null and reads neither tmux nor the process table", async () => {
    const readProcessRecords = vi.fn(records);
    mockPanePid(FAKE_PANE_PID);

    await expect(capturePaneProcessTree(IDENTITY, "%7", { readProcessRecords })).resolves.toBeNull();

    expect(tmuxUtilsMocks.tmuxCmdAsync).not.toHaveBeenCalled();
    expect(readProcessRecords).not.toHaveBeenCalled();
  });

  it("the capture records the descendants breadth first with their start identities and signals nothing", async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = "1";
    mockPanePid(FAKE_PANE_PID);
    const killProcess = vi.fn();

    const tree = await capturePaneProcessTree(IDENTITY, "%7", {
      readProcessRecords: records,
      processIdentity: (pid) => `start-${pid}`,
      killProcess,
    });

    expect(tree).toEqual({
      panePid: FAKE_PANE_PID,
      pids: [CHILD, GRANDCHILD],
      startIdentities: new Map([
        [CHILD, `start-${CHILD}`],
        [GRANDCHILD, `start-${GRANDCHILD}`],
      ]),
    });
    expect(killProcess).not.toHaveBeenCalled();
  });

  it("records only the descendants that keep their parent in a second read of the process table (a reused PID shows another parent)", async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = "1";
    mockPanePid(FAKE_PANE_PID);
    const LATER = 4_000_003;
    const first = new Map([
      [CHILD, { ppid: FAKE_PANE_PID }],
      [GRANDCHILD, { ppid: CHILD }],
      [LATER, { ppid: CHILD }],
    ]);
    // GRANDCHILD exited and its PID went to an unrelated process (another parent); LATER exited and is not in the table any more
    const second = new Map([
      [CHILD, { ppid: FAKE_PANE_PID }],
      [GRANDCHILD, { ppid: 1 }],
    ]);
    const readProcessRecords = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(second);

    const tree = await capturePaneProcessTree(IDENTITY, "%7", {
      readProcessRecords,
      processIdentity: (pid) => `start-${pid}`,
    });

    expect(readProcessRecords).toHaveBeenCalledTimes(2);
    expect(tree?.pids).toEqual([CHILD]);
  });

  it("a capture whose descendants all changed parent before the second read is null, so nothing is signalled later", async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = "1";
    mockPanePid(FAKE_PANE_PID);
    const readProcessRecords = vi
      .fn()
      .mockResolvedValueOnce(new Map([[CHILD, { ppid: FAKE_PANE_PID }]]))
      .mockResolvedValue(new Map([[CHILD, { ppid: 1 }]]));

    await expect(
      capturePaneProcessTree(IDENTITY, "%7", { readProcessRecords, processIdentity: (pid) => `start-${pid}` }),
    ).resolves.toBeNull();
  });

  describe("the pane root is revalidated before its descendants are trusted", () => {
    const OTHER = 4_000_009;
    const identities = (pid: number) => `start-${pid}`;
    const capture = (extra: Parameters<typeof capturePaneProcessTree>[2] = {}) =>
      capturePaneProcessTree(IDENTITY, "%7", { readProcessRecords: records, processIdentity: identities, ...extra });

    beforeEach(() => {
      process.env.OMC_TEAM_KILL_PANE_TREE = "1";
    });

    it("asks tmux for the root PID and whether the pane is dead, once before and once after the process table reads", async () => {
      mockPanePid(FAKE_PANE_PID);
      const readProcessRecords = vi.fn(records);

      await expect(capture({ readProcessRecords })).resolves.not.toBeNull();

      const queries = tmuxUtilsMocks.tmuxCmdAsync.mock.invocationCallOrder;
      const tables = readProcessRecords.mock.invocationCallOrder;
      expect(queries).toHaveLength(2);
      expect(tables).toHaveLength(2);
      expect(queries[0]!).toBeLessThan(tables[0]!);
      expect(queries[1]!).toBeGreaterThan(tables[1]!);
      for (const call of tmuxUtilsMocks.tmuxCmdAsync.mock.calls) {
        expect((call[0] as string[]).join(" ")).toContain("#{pane_pid} #{pane_dead}");
      }
    });

    it("a pane that reports another root PID after the reads (its process exited and the PID went to another process) gives no tree", async () => {
      mockPanePid(FAKE_PANE_PID, { pid: OTHER });
      await expect(capture()).resolves.toBeNull();
    });

    it("a pane that is dead after the reads gives no tree, even on the same PID (remain-on-exit keeps the PID)", async () => {
      mockPanePid(FAKE_PANE_PID, { pid: FAKE_PANE_PID, dead: true });
      await expect(capture()).resolves.toBeNull();
    });

    it("a pane that cannot be read the second time gives no tree", async () => {
      let queries = 0;
      tmuxUtilsMocks.tmuxCmdAsync.mockImplementation(async (args: string[]) => {
        const marker = args.join(" ").match(/OMC_TMUX_GUARD_OK_[A-Za-z0-9_]+/)?.[0];
        queries += 1;
        if (queries > 1) return { stdout: "", stderr: "tmux_server_unavailable" };
        return { stdout: `${FAKE_PANE_PID} 0\n${marker}\n`, stderr: "" };
      });
      await expect(capture()).resolves.toBeNull();
    });

    it("a pane that is dead at the first read gives no tree and the process table is not read", async () => {
      mockPanePid(FAKE_PANE_PID);
      tmuxUtilsMocks.tmuxCmdAsync.mockImplementation(async (args: string[]) => {
        const marker = args.join(" ").match(/OMC_TMUX_GUARD_OK_[A-Za-z0-9_]+/)?.[0];
        return { stdout: `${FAKE_PANE_PID} 1\n${marker}\n`, stderr: "" };
      });
      const readProcessRecords = vi.fn(records);
      await expect(capture({ readProcessRecords })).resolves.toBeNull();
      expect(readProcessRecords).not.toHaveBeenCalled();
    });

    it("a root process whose start identity changed between the reads (a pane respawned onto the same PID) gives no tree", async () => {
      mockPanePid(FAKE_PANE_PID);
      let rootReads = 0;
      const processIdentity = (pid: number) => (pid === FAKE_PANE_PID ? `root-incarnation-${++rootReads}` : identities(pid));
      await expect(capture({ processIdentity })).resolves.toBeNull();
      expect(rootReads).toBe(2);
    });

    it("a root process whose start identity cannot be read at the first read gives no tree, and a kill signals nothing", async () => {
      mockPanePid(FAKE_PANE_PID);
      const processIdentity = (pid: number) => (pid === FAKE_PANE_PID ? null : identities(pid));
      await expect(capture({ processIdentity })).resolves.toBeNull();

      const killProcess = vi.fn();
      const sleep = vi.fn(async () => undefined);
      mockPanePid(FAKE_PANE_PID);
      await killWorkerPaneProcessTree(IDENTITY, "%7", { readProcessRecords: records, processIdentity, killProcess, sleep });
      expect(killProcess).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
    });

    it("a root process whose start identity can be read at the first read but not at the second gives no tree", async () => {
      mockPanePid(FAKE_PANE_PID);
      let rootReads = 0;
      const processIdentity = (pid: number) => (pid === FAKE_PANE_PID ? (++rootReads === 1 ? "root-incarnation" : null) : identities(pid));
      await expect(capture({ processIdentity })).resolves.toBeNull();
      expect(rootReads).toBe(2);
    });

    it("a root identity that throws is treated as unreadable: no tree, and no failure of the capture", async () => {
      mockPanePid(FAKE_PANE_PID);
      const throwing = (pid: number) => {
        if (pid === FAKE_PANE_PID) throw new Error("no such process");
        return identities(pid);
      };
      await expect(capture({ processIdentity: throwing })).resolves.toBeNull();

      let rootReads = 0;
      const throwsSecond = (pid: number) => {
        if (pid !== FAKE_PANE_PID) return identities(pid);
        if (++rootReads > 1) throw new Error("no such process");
        return "root-incarnation";
      };
      await expect(capture({ processIdentity: throwsSecond })).resolves.toBeNull();
    });

    it("a grid of root identity reads at the first and the second read gives a tree only when both are readable and equal", async () => {
      const reads: Array<[string | null, string | null, boolean]> = [
        ["a", "a", true],
        ["a", "b", false],
        ["a", null, false],
        [null, "a", false],
        [null, null, false],
      ];
      for (const [first, second, expectTree] of reads) {
        mockPanePid(FAKE_PANE_PID);
        let rootReads = 0;
        const processIdentity = (pid: number) => (pid === FAKE_PANE_PID ? (++rootReads === 1 ? first : second) : identities(pid));
        const tree = await capture({ processIdentity });
        expect(tree !== null, `${first} then ${second}`).toBe(expectTree);
      }
    });
  });

  it("terminating a null capture does nothing", async () => {
    const killProcess = vi.fn();
    const sleep = vi.fn(async () => undefined);

    await terminatePaneProcessTree(null, { killProcess, sleep });

    expect(killProcess).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  /** Captures with every identity readable, then terminates with `identityNow` as the identity reader. */
  async function captureThenTerminate(identityNow: (pid: number, waited: boolean) => string | null) {
    process.env.OMC_TEAM_KILL_PANE_TREE = "1";
    mockPanePid(FAKE_PANE_PID);
    const tree = await capturePaneProcessTree(IDENTITY, "%7", {
      readProcessRecords: records,
      processIdentity: (pid) => `start-${pid}`,
    });
    const calls: Array<[number, NodeJS.Signals | 0]> = [];
    const waits: number[] = [];
    let waited = false;
    await terminatePaneProcessTree(tree, {
      processIdentity: (pid) => identityNow(pid, waited),
      killProcess: (pid, signal) => {
        calls.push([pid, signal]);
      },
      sleep: async (ms) => {
        waits.push(ms);
        waited = true;
      },
    });
    return { calls, waits };
  }
  const withSignal = (calls: Array<[number, NodeJS.Signals | 0]>, signal: NodeJS.Signals): number[] =>
    calls.filter(([, s]) => s === signal).map(([pid]) => pid);

  it("signals the descendants deepest first when their identities are unchanged", async () => {
    const { calls, waits } = await captureThenTerminate((pid) => `start-${pid}`);

    expect(withSignal(calls, "SIGTERM")).toEqual([GRANDCHILD, CHILD]);
    expect(withSignal(calls, "SIGKILL")).toEqual([GRANDCHILD, CHILD]);
    expect(waits).toEqual([2000]);
  });

  it("sends no SIGTERM, and later no SIGKILL, to a PID that was reused after the capture", async () => {
    const { calls } = await captureThenTerminate((pid) => (pid === CHILD ? "start-of-an-unrelated-process" : `start-${pid}`));

    expect(withSignal(calls, "SIGTERM")).toEqual([GRANDCHILD]);
    expect(withSignal(calls, "SIGKILL")).toEqual([GRANDCHILD]);
    expect(calls.some(([pid]) => pid === CHILD)).toBe(false);
  });

  it("sends nothing and does not wait when no identity can be read at termination time", async () => {
    const { calls, waits } = await captureThenTerminate(() => null);

    expect(calls).toEqual([]);
    expect(waits).toEqual([]);
  });

  it("a descendant that left the pane tree after the capture is still terminated, and a fresh read no longer finds it", async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = "1";
    const pane = startPane(`sh -c 'sleep 240.${TAG}' & sleep 241.${TAG} & wait`);
    await waitForTaggedSleeps("240", 1);
    await waitForTaggedSleeps("241", 1);
    mockPanePid(pane.pid!);

    const tree = await capturePaneProcessTree(IDENTITY, "%7");
    expect(tree?.pids.length).toBeGreaterThanOrEqual(2);

    // The pane's root goes away first, as the provider does in the shutdown loop: its children are reparented.
    pane.kill("SIGKILL");
    await new Promise<void>((resolve) => pane.once("exit", () => resolve()));
    await killWorkerPaneProcessTree(IDENTITY, "%7");
    expect((await taggedSleeps("240")).length).toBe(1);
    expect((await taggedSleeps("241")).length).toBe(1);

    await terminatePaneProcessTree(tree);
    expect((await taggedSleeps("240")).length).toBe(0);
    expect((await taggedSleeps("241")).length).toBe(0);
  }, 30_000);
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
        return { stdout: `${panePid} 0\n${marker}\n`, stderr: "" };
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

    // the root is read before and after the process table; both reads come before the pane is killed
    expect(events).toEqual(["pane-pid-query", "pane-pid-query", "kill-pane"]);
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
