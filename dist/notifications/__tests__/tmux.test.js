import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("../../cli/tmux-utils.js", async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, tmuxShell: vi.fn() };
});
import { tmuxShell } from "../../cli/tmux-utils.js";
import { getCurrentTmuxSession, getCurrentTmuxPaneId, formatTmuxInfo, getTeamTmuxSessions, } from "../tmux.js";
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
        mockTmuxShell.mockReturnValueOnce("%0 main\n%1 main\n%2 background\n%3 my-detached-session\n");
        expect(getCurrentTmuxSession()).toBe("my-detached-session");
        expect(mockTmuxShell).toHaveBeenCalledWith("list-panes -a -F '#{pane_id} #{session_name}'", expect.objectContaining({ timeout: 3000 }));
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
        expect(mockTmuxShell).toHaveBeenCalledWith("display-message -p '#S'", expect.objectContaining({ timeout: 3000 }));
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
        mockTmuxShell.mockReturnValueOnce("omc-team-myteam-worker1\nomc-team-myteam-worker2\nother-session\n");
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
//# sourceMappingURL=tmux.test.js.map