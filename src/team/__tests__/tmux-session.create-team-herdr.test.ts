/**
 * Herdr arm of createTeamSession (Codex review fix).
 *
 * Herdr-only v2 startup calls createTeamSession with workerCount 0 outside
 * tmux. The tmux-only initialization (mouse option, leader select-pane)
 * previously demanded a tmux server identity AFTER the Herdr workspace was
 * already allocated, failing startup and leaking the workspace. These tests
 * pin the exempted zero-worker flow; the Herdr engine is module-mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const herdrMocks = vi.hoisted(() => ({
  ensureHerdrServer: vi.fn(async () => "running" as const),
  herdrCreateTeamWorkspace: vi.fn(async () => "w2"),
  herdrCreateWorkerTab: vi.fn(async () => ({
    paneId: "w2:p2",
    tabId: "w2:t2",
  })),
  herdrCloseWorkspace: vi.fn(async () => undefined),
}));

vi.mock("../herdr-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../herdr-session.js")>();
  return {
    ...actual,
    ensureHerdrServer: herdrMocks.ensureHerdrServer,
    herdrCreateTeamWorkspace: herdrMocks.herdrCreateTeamWorkspace,
    herdrCreateWorkerTab: herdrMocks.herdrCreateWorkerTab,
    herdrCloseWorkspace: herdrMocks.herdrCloseWorkspace,
  };
});

import { createTeamSession } from "../tmux-session.js";

describe("createTeamSession herdr zero-worker flow", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    // Herdr-only startup: no ambient multiplexer, binary pinned to a path
    // that does not exist so no real herdr command can escape the mocks.
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    delete process.env.CMUX_SURFACE_ID;
    delete process.env.OMC_TEAM_MULTIPLEXER;
    process.env.HERDR_BIN_PATH = "/nonexistent/herdr-under-test";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("creates a herdr workspace session without any tmux server identity", async () => {
    process.env.HERDR_PANE_ID = "w1:p1";
    const session = await createTeamSession("alpha", 0, "/repo", {
      multiplexer: "herdr",
    });
    expect(herdrMocks.ensureHerdrServer).toHaveBeenCalledTimes(1);
    expect(herdrMocks.herdrCreateTeamWorkspace).toHaveBeenCalledWith(
      "/repo",
      expect.stringMatching(/^omc-team-alpha/),
    );
    expect(herdrMocks.herdrCreateWorkerTab).not.toHaveBeenCalled();
    expect(session).toEqual({
      sessionName: "herdr:w2",
      leaderPaneId: "w1:p1",
      workerPaneIds: [],
      sessionMode: "split-pane",
    });
    // No tmux server identity may leak into the published session: herdr
    // ownership is workspace-scoped.
    expect("tmuxServerIdentity" in session).toBe(false);
  });

  it("does not fall back to a tmux pane id for the herdr leader", async () => {
    // Without HERDR_PANE_ID the leader simply is not pane-tracked; the
    // tmux-context TMUX_PANE fallback must not leak a %N id into a herdr
    // team target (it would misroute split targeting and ownership proofs).
    process.env.TMUX_PANE = "%5";
    delete process.env.HERDR_PANE_ID;
    const session = await createTeamSession("alpha", 0, "/repo", {
      multiplexer: "herdr",
    });
    expect(session.sessionName).toBe("herdr:w2");
    expect(session.leaderPaneId).toBe("");
  });

  it("still allocates worker tabs up front when workers are requested", async () => {
    process.env.HERDR_PANE_ID = "w1:p1";
    const session = await createTeamSession("alpha", 2, "/repo", {
      multiplexer: "herdr",
    });
    expect(herdrMocks.herdrCreateWorkerTab).toHaveBeenCalledTimes(2);
    expect(session.workerPaneIds).toEqual(["w2:p2", "w2:p2"]);
    expect(session.sessionName).toBe("herdr:w2");
  });

  it("rolls back the workspace when a worker tab creation fails", async () => {
    // Codex P1 finding: Include Herdr in the worker-allocation rollback.
    // When createTeamSession allocates workers up front and a tab fails,
    // cleanupCreatedResources must not return false immediately for herdr.
    process.env.HERDR_PANE_ID = "w1:p1";
    herdrMocks.herdrCreateWorkerTab.mockRejectedValueOnce(
      new Error("tab_creation_timeout"),
    );
    await expect(
      createTeamSession("alpha", 2, "/repo", { multiplexer: "herdr" }),
    ).rejects.toThrow("tab_creation_timeout");
    // No worker pane was recorded, but the workspace this call created must
    // still be closed.
    expect(herdrMocks.herdrCreateWorkerTab).toHaveBeenCalledTimes(1);
    expect(herdrMocks.herdrCloseWorkspace).toHaveBeenCalledWith("w2");
  });
});
