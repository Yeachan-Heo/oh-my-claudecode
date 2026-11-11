/**
 * Unit tests for the herdr arm of the rate-limit detector
 * (src/features/rate-limit-wait/tmux-detector.ts).
 *
 * The Herdr engine (src/team/herdr-session.ts) is module-mocked; the shared
 * content classifiers (analyzePaneContent, live-menu checks) run for real.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const herdrMocks = vi.hoisted(() => ({
  listHerdrAgents: vi.fn(),
  captureHerdrWorkerPane: vi.fn(),
  herdrSendKey: vi.fn(),
}));

vi.mock("../../team/herdr-session.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../team/herdr-session.js")>();
  return {
    ...actual,
    listHerdrAgents: herdrMocks.listHerdrAgents,
    captureHerdrWorkerPane: herdrMocks.captureHerdrWorkerPane,
    herdrSendKey: herdrMocks.herdrSendKey,
  };
});

vi.mock("../../cli/tmux-utils.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../cli/tmux-utils.js")>();
  return {
    ...actual,
    tmuxExec: vi.fn(),
    tmuxSpawn: vi.fn(() => ({ status: 0 })),
  };
});

import { tmuxExec } from "../../cli/tmux-utils.js";
import {
  isHerdrDetectorEnabled,
  scanForBlockedHerdrPanes,
  revalidateBlockedHerdrPanes,
  sendHerdrResumeSequence,
  capturePaneContent,
  sendToPane,
  sendResumeSequence,
} from "../../features/rate-limit-wait/tmux-detector.js";
import type { BlockedPane } from "../../features/rate-limit-wait/types.js";

/** Live Claude limit screen: option 1 preselected, enter to confirm. */
const RATE_LIMIT_SCREEN = [
  "Claude Code",
  "5-hour usage limit reached",
  "What would you like to do?",
  "──────────────────",
  "1. wait and continue automatically",
  "enter to confirm",
].join("\n");

function herdrPane(overrides: Partial<BlockedPane> = {}): BlockedPane {
  return {
    id: "w9:p1",
    session: "w9",
    windowIndex: 0,
    windowName: "omx-demo-w1",
    paneIndex: 0,
    isActive: true,
    firstDetectedAt: new Date(),
    analysis: {
      hasClaudeCode: true,
      hasRateLimitMessage: true,
      isBlocked: true,
      confidence: 1,
    },
    resumeAttempted: false,
    ...overrides,
  };
}

describe("isHerdrDetectorEnabled", () => {
  it("enables only when the multiplexer elects herdr", () => {
    expect(isHerdrDetectorEnabled({ OMC_TEAM_MULTIPLEXER: "herdr" })).toBe(
      true,
    );
    expect(isHerdrDetectorEnabled({ OMC_TEAM_MULTIPLEXER: "tmux" })).toBe(
      false,
    );
    expect(isHerdrDetectorEnabled({})).toBe(false);
  });
});

describe("scanForBlockedHerdrPanes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flags live agent panes showing a blocked limit screen", async () => {
    herdrMocks.listHerdrAgents.mockResolvedValue([
      { pane_id: "w9:p1", agent: "claude", name: "omx-demo-w1" },
      { pane_id: "w9:p2", agent: "claude", name: "omx-demo-w2" },
    ]);
    herdrMocks.captureHerdrWorkerPane.mockImplementation(
      async (paneId: string) =>
        paneId === "w9:p1" ? RATE_LIMIT_SCREEN : "plain shell output",
    );

    const blocked = await scanForBlockedHerdrPanes(15);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ id: "w9:p1", session: "w9" });
    expect(blocked[0].analysis.isBlocked).toBe(true);
    expect(herdrMocks.captureHerdrWorkerPane).toHaveBeenCalledWith("w9:p1", 15);
  });

  it("returns [] when the agent inventory cannot be read", async () => {
    herdrMocks.listHerdrAgents.mockRejectedValue(
      new Error("server_not_running"),
    );
    await expect(scanForBlockedHerdrPanes()).resolves.toEqual([]);
  });

  it("skips panes whose capture fails", async () => {
    herdrMocks.listHerdrAgents.mockResolvedValue([
      { pane_id: "w4:p1", agent: "claude" },
    ]);
    herdrMocks.captureHerdrWorkerPane.mockRejectedValue(new Error("pane_gone"));
    await expect(scanForBlockedHerdrPanes()).resolves.toEqual([]);
  });
});

describe("revalidateBlockedHerdrPanes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the inventory read is inconclusive", async () => {
    herdrMocks.listHerdrAgents.mockRejectedValue(new Error("spawn_failed"));
    await expect(
      revalidateBlockedHerdrPanes([herdrPane()]),
    ).resolves.toBeNull();
  });

  it("drops panes whose agent is no longer live", async () => {
    herdrMocks.listHerdrAgents.mockResolvedValue([]);
    await expect(revalidateBlockedHerdrPanes([herdrPane()])).resolves.toEqual(
      [],
    );
  });

  it("keeps panes still showing a live resume menu", async () => {
    herdrMocks.listHerdrAgents.mockResolvedValue([
      { pane_id: "w9:p1", agent: "claude" },
    ]);
    herdrMocks.captureHerdrWorkerPane.mockResolvedValue(RATE_LIMIT_SCREEN);

    const resumable = await revalidateBlockedHerdrPanes([herdrPane()]);
    expect(resumable).toHaveLength(1);
    expect(resumable?.[0].id).toBe("w9:p1");
  });

  it("drops panes whose menu is no longer live", async () => {
    herdrMocks.listHerdrAgents.mockResolvedValue([
      { pane_id: "w9:p1", agent: "claude" },
    ]);
    // Same rate-limit wording but no live confirmation prompt at the tail.
    herdrMocks.captureHerdrWorkerPane.mockResolvedValue(
      [
        "Claude Code",
        "5-hour usage limit reached",
        "1. wait and continue automatically",
        "· 42% of 5-hour window used",
      ].join("\n"),
    );

    await expect(revalidateBlockedHerdrPanes([herdrPane()])).resolves.toEqual(
      [],
    );
  });

  it("returns [] for empty input without touching herdr", async () => {
    await expect(revalidateBlockedHerdrPanes([])).resolves.toEqual([]);
    expect(herdrMocks.listHerdrAgents).not.toHaveBeenCalled();
  });
});

describe("sendHerdrResumeSequence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("confirms the preselected option with the agent surface's enter key", async () => {
    herdrMocks.herdrSendKey.mockResolvedValue(undefined);
    await expect(sendHerdrResumeSequence("w9:p1")).resolves.toBe(true);
    expect(herdrMocks.herdrSendKey).toHaveBeenCalledWith("w9:p1", "enter");
  });

  it("rejects non-herdr pane ids and reports delivery failures", async () => {
    await expect(sendHerdrResumeSequence("%3")).resolves.toBe(false);
    expect(herdrMocks.herdrSendKey).not.toHaveBeenCalled();

    herdrMocks.herdrSendKey.mockRejectedValue(new Error("agent_not_found"));
    await expect(sendHerdrResumeSequence("w9:p1")).resolves.toBe(false);
  });
});

describe("tmux surfaces stay gated to tmux panes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("silently declines herdr pane ids instead of shelling out to tmux", () => {
    expect(capturePaneContent("w9:p1", 15)).toBe("");
    expect(sendToPane("w9:p1", "hi")).toBe(false);
    expect(sendResumeSequence("w9:p1")).toBe(false);
    expect(tmuxExec).not.toHaveBeenCalled();
  });
});
