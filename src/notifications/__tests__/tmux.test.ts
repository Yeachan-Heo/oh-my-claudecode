import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const herdrMocks = vi.hoisted(() => ({
  listHerdrTeams: vi.fn(),
}));

vi.mock("../../cli/tmux-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../cli/tmux-utils.js")>();
  return { ...actual, tmuxShell: vi.fn() };
});

vi.mock("../../team/herdr-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../team/herdr-session.js")>();
  return { ...actual, listHerdrTeams: herdrMocks.listHerdrTeams };
});

import { tmuxShell } from "../../cli/tmux-utils.js";
import {
  getCurrentTmuxSession,
  getCurrentTmuxPaneId,
  getCurrentHerdrPaneId,
  formatTmuxInfo,
  getTeamTmuxSessions,
  getTeamHerdrWorkspaces,
} from "../tmux.js";

const mockTmuxShell = vi.mocked(tmuxShell);

describe("getCurrentTmuxSession", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns null when not inside tmux (no TMUX env)", () => {
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    expect(getCurrentTmuxSession()).toBeNull();
    expect(mockTmuxShell).not.toHaveBeenCalled();
  });

  it("uses TMUX_PANE to resolve the session name for the current pane", () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
    process.env.TMUX_PANE = "%3";

    mockTmuxShell.mockReturnValueOnce(
      "%0 main\n%1 main\n%2 background\n%3 my-detached-session\n"
    );

    expect(getCurrentTmuxSession()).toBe("my-detached-session");
    expect(mockTmuxShell).toHaveBeenCalledWith(
      "list-panes -a -F '#{pane_id} #{session_name}'",
      expect.objectContaining({ timeout: 3000 })
    );
  });

  it("preserves spaces and tabs in the matched session name", () => {
    process.env.TMUX = "/tmp/owned-socket,1234,0";
    process.env.TMUX_PANE = "%3";
    mockTmuxShell.mockReturnValue("%30 other\n%3 owned project\twith tab\n");
    expect(getCurrentTmuxSession()).toBe("owned project\twith tab");
    expect(formatTmuxInfo()).toBe("tmux: owned project\twith tab");
  });

  it("returns the correct session even when an earlier pane has the same ID prefix", () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
    process.env.TMUX_PANE = "%1";

    // %10 must NOT match %1
    mockTmuxShell.mockReturnValueOnce("%10 other\n%1 target-session\n%2 foo\n");

    expect(getCurrentTmuxSession()).toBe("target-session");
  });

  it("falls back to display-message when TMUX_PANE is absent", () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
    delete process.env.TMUX_PANE;

    mockTmuxShell.mockReturnValueOnce("fallback-session\n");

    expect(getCurrentTmuxSession()).toBe("fallback-session");
    expect(mockTmuxShell).toHaveBeenCalledWith(
      "display-message -p '#S'",
      expect.objectContaining({ timeout: 3000 })
    );
  });

  it("falls back to display-message when pane not found in list", () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
    process.env.TMUX_PANE = "%99";

    // list-panes doesn't include %99
    mockTmuxShell
      .mockReturnValueOnce("%0 main\n%1 main\n")
      .mockReturnValueOnce("attached-session\n");

    expect(getCurrentTmuxSession()).toBe("attached-session");
  });

  it("returns null when execSync throws", () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
    process.env.TMUX_PANE = "%1";

    mockTmuxShell.mockImplementation(() => {
      throw new Error("tmux not found");
    });

    expect(getCurrentTmuxSession()).toBeNull();
  });

  it("returns null when session name is empty string", () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
    delete process.env.TMUX_PANE;

    mockTmuxShell.mockReturnValueOnce("  \n");

    expect(getCurrentTmuxSession()).toBeNull();
  });
});

describe("getCurrentTmuxPaneId", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns null when not in tmux", () => {
    delete process.env.TMUX;
    expect(getCurrentTmuxPaneId()).toBeNull();
  });

  it("returns TMUX_PANE env var when valid", () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
    process.env.TMUX_PANE = "%5";
    expect(getCurrentTmuxPaneId()).toBe("%5");
    expect(mockTmuxShell).not.toHaveBeenCalled();
  });

  it("falls back to tmux display-message when env var is absent", () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
    delete process.env.TMUX_PANE;

    mockTmuxShell.mockReturnValueOnce("%2\n");
    expect(getCurrentTmuxPaneId()).toBe("%2");
  });
});

describe("formatTmuxInfo", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns null when not in tmux", () => {
    delete process.env.TMUX;
    expect(formatTmuxInfo()).toBeNull();
  });

  it("formats session name correctly", () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
    process.env.TMUX_PANE = "%0";

    mockTmuxShell.mockReturnValueOnce("%0 my-session\n");

    expect(formatTmuxInfo()).toBe("tmux: my-session");
  });
});

describe("getTeamTmuxSessions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns sessions matching the team prefix", () => {
    mockTmuxShell.mockReturnValueOnce(
      "omc-team-myteam-worker1\nomc-team-myteam-worker2\nother-session\n"
    );
    expect(getTeamTmuxSessions("myteam")).toEqual(["worker1", "worker2"]);
  });

  it("returns empty array when no sessions match", () => {
    mockTmuxShell.mockReturnValueOnce("some-other-session\n");
    expect(getTeamTmuxSessions("myteam")).toEqual([]);
  });

  it("returns empty array for empty team name", () => {
    expect(getTeamTmuxSessions("")).toEqual([]);
    expect(mockTmuxShell).not.toHaveBeenCalled();
  });

  it("returns empty array when execSync throws", () => {
    mockTmuxShell.mockImplementation(() => {
      throw new Error("no server running");
    });
    expect(getTeamTmuxSessions("myteam")).toEqual([]);
  });
});

describe("herdr pane context", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("validates the HERDR_PANE_ID grammar before use", () => {
    process.env.HERDR_PANE_ID = "w9:p12";
    expect(getCurrentHerdrPaneId()).toBe("w9:p12");
    process.env.HERDR_PANE_ID = "%3";
    expect(getCurrentHerdrPaneId()).toBeNull();
    delete process.env.HERDR_PANE_ID;
    expect(getCurrentHerdrPaneId()).toBeNull();
  });

  it("routes pane id and session detection to the herdr pane", () => {
    process.env.HERDR_PANE_ID = "w9:p12";
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;

    expect(getCurrentTmuxPaneId()).toBe("w9:p12");
    expect(getCurrentTmuxSession()).toBe("herdr:w9");
    expect(formatTmuxInfo()).toBe("herdr: w9");
    expect(mockTmuxShell).not.toHaveBeenCalled();
  });

  it("keeps tmux detection when HERDR_PANE_ID is absent or malformed", () => {
    delete process.env.HERDR_PANE_ID;
    process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
    process.env.TMUX_PANE = "%5";
    expect(getCurrentTmuxPaneId()).toBe("%5");

    process.env.HERDR_PANE_ID = "not-a-pane";
    mockTmuxShell.mockReturnValueOnce("%5 tmux-session\n");
    expect(getCurrentTmuxSession()).toBe("tmux-session");
  });

  it("lists herdr team workspaces for a team", async () => {
    herdrMocks.listHerdrTeams.mockResolvedValue([
      { workspaceId: "w2", teamName: "myteam", label: "omc-team-myteam" },
      { workspaceId: "w3", teamName: "other", label: "omc-team-other" },
    ]);
    await expect(getTeamHerdrWorkspaces("myteam")).resolves.toEqual([
      { workspaceId: "w2", teamName: "myteam", label: "omc-team-myteam" },
    ]);
    await expect(getTeamHerdrWorkspaces("")).resolves.toEqual([]);
    herdrMocks.listHerdrTeams.mockRejectedValue(new Error("server_not_running"));
    await expect(getTeamHerdrWorkspaces("myteam")).resolves.toEqual([]);
  });
});
