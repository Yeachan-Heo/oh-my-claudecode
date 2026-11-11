/**
 * Tests for the Herdr arm of the interop side-by-side
 * (src/cli/interop.ts).
 *
 * The Herdr engine and the interop shared-state store are module-mocked;
 * the tmux fallback path is exercised as a regression guard.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const herdrMocks = vi.hoisted(() => ({
  ensureHerdrServer: vi.fn(async () => "running" as const),
  herdrCreateWorkerTab: vi.fn(async () => ({
    paneId: "w9:p7",
    tabId: "w9:t7",
  })),
  herdrRunPaneCommand: vi.fn(async () => undefined),
}));

const interopStateMocks = vi.hoisted(() => ({
  initInteropSession: vi.fn(() => ({
    sessionId: "test",
    omcDir: "/tmp",
    omxDir: "/tmp",
  })),
  getInteropDir: vi.fn(() => "/tmp/omc-interop-test"),
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    // `codex --version` probe: available by default, overridden per-test.
    execFileSync: vi.fn(() => "codex 1.0"),
  };
});

vi.mock("../../team/herdr-session.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../team/herdr-session.js")>();
  return {
    ...actual,
    ensureHerdrServer: herdrMocks.ensureHerdrServer,
    herdrCreateWorkerTab: herdrMocks.herdrCreateWorkerTab,
    herdrRunPaneCommand: herdrMocks.herdrRunPaneCommand,
  };
});

vi.mock("../../interop/shared-state.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../interop/shared-state.js")>();
  return {
    ...actual,
    initInteropSession: interopStateMocks.initInteropSession,
    getInteropDir: interopStateMocks.getInteropDir,
  };
});

vi.mock("../tmux-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tmux-utils.js")>();
  return {
    ...actual,
    isTmuxAvailable: vi.fn(() => false),
    isClaudeAvailable: vi.fn(() => true),
    tmuxExec: vi.fn(),
  };
});

import { execFileSync } from "child_process";
import { launchInteropSession } from "../interop.js";
import { isTmuxAvailable, tmuxExec } from "../tmux-utils.js";

function printedCalls(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
}

describe("interop herdr arm", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.HERDR_PANE_ID;
    delete process.env.OMC_TEAM_MULTIPLEXER;
    delete process.env.TMUX;
    vi.clearAllMocks();
    // clearAllMocks keeps implementations; re-pin the codex probe and the
    // tmux gate so a previous test's overrides cannot leak.
    vi.mocked(execFileSync).mockImplementation(() => "codex 1.0");
    vi.mocked(isTmuxAvailable).mockReturnValue(false);
    stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
  });

  afterEach(() => {
    process.env = originalEnv;
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("spawns the codex pane as a tab of the current herdr workspace", async () => {
    process.env.HERDR_PANE_ID = "w9:p3";

    await launchInteropSession("/tmp");

    expect(herdrMocks.herdrCreateWorkerTab).toHaveBeenCalledWith(
      "w9",
      "/tmp",
      "codex",
    );
    expect(herdrMocks.herdrRunPaneCommand).toHaveBeenCalledWith(
      "w9:p7",
      "codex",
    );
    expect(interopStateMocks.initInteropSession).toHaveBeenCalledWith(
      expect.stringMatching(/^interop-/),
      "/tmp",
      "/tmp",
    );
    // tmux is not involved (and is even unavailable here).
    expect(tmuxExec).not.toHaveBeenCalled();
    const printed = printedCalls(stdoutSpy);
    expect(printed).toContain("workspace w9");
    expect(printed).toContain("w9:p7");
  });

  it("requires a herdr pane when the multiplexer is elected without one", async () => {
    process.env.OMC_TEAM_MULTIPLEXER = "herdr";

    await expect(launchInteropSession("/tmp")).rejects.toThrow("process.exit");
    expect(herdrMocks.herdrCreateWorkerTab).not.toHaveBeenCalled();
    expect(printedCalls(errorSpy)).toContain(
      "requires running inside a Herdr pane",
    );
  });

  it("degrades gracefully when codex is missing", async () => {
    process.env.HERDR_PANE_ID = "w4:p1";
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("codex not found");
    });

    await launchInteropSession("/tmp");

    expect(herdrMocks.herdrCreateWorkerTab).not.toHaveBeenCalled();
    expect(printedCalls(stdoutSpy)).toContain(
      "Claude Code is ready in this pane.",
    );
  });

  it("exits with an error when the codex tab cannot be created", async () => {
    process.env.HERDR_PANE_ID = "w9:p3";
    herdrMocks.herdrCreateWorkerTab.mockRejectedValueOnce(
      new Error("herdr_spawn_failed: nope"),
    );

    await expect(launchInteropSession("/tmp")).rejects.toThrow("process.exit");
    expect(printedCalls(errorSpy)).toContain("Error creating Codex tab");
  });

  it("keeps the tmux split flow when no herdr context exists", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
    vi.mocked(isTmuxAvailable).mockReturnValue(true);
    vi.mocked(tmuxExec)
      .mockReturnValueOnce("%5") // display-message: current pane id
      .mockReturnValueOnce(""); // select-pane

    await launchInteropSession("/tmp");

    expect(herdrMocks.herdrCreateWorkerTab).not.toHaveBeenCalled();
    const calls = vi.mocked(tmuxExec).mock.calls.map(([args]) => args);
    expect(calls.some((args) => args[0] === "split-window")).toBe(true);
    expect(calls.some((args) => args[0] === "display-message")).toBe(true);
  });
});
