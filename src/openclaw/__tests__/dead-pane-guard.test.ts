/**
 * Regression tests for issue #2562: dead tmux sessions must not emit
 * pane-derived keyword/stale alerts after cleanup.
 *
 * The fix uses getNewPaneTail (delta-capture) from pane-fresh-capture.js:
 * only new lines since the last snapshot are forwarded. A dead or idle pane
 * returns an empty string, so no stale scrollback ever reaches the gateway
 * as tmuxTail.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "path";

// Hoisted mock for the delta-capture function used inside wakeOpenClaw.
const mockGetNewPaneTail = vi.fn<(paneId: string, stateDir: string, maxLines?: number) => string>(() => "");

vi.mock("../../features/rate-limit-wait/pane-fresh-capture.js", () => ({
  getNewPaneTail: (paneId: string, stateDir: string, maxLines?: number) =>
    mockGetNewPaneTail(paneId, stateDir, maxLines),
}));

vi.mock("../../notifications/tmux.js", () => ({
  getCurrentTmuxSession: () => "test-session",
}));

vi.mock("../config.js", () => ({
  getOpenClawConfig: vi.fn(),
  resolveGateway: vi.fn(),
  resetOpenClawConfigCache: vi.fn(),
}));

vi.mock("../dispatcher.js", () => ({
  wakeGateway: vi.fn().mockResolvedValue({ success: true }),
  wakeCommandGateway: vi.fn().mockResolvedValue({ success: true }),
  isCommandGateway: vi.fn(() => false),
  shellEscapeArg: vi.fn((v: string) => v),
  interpolateInstruction: vi.fn((t: string) => t),
}));

vi.mock("../dedupe.js", () => ({
  shouldCollapseOpenClawBurst: vi.fn(() => false),
}));

vi.mock("../signal.js", () => ({
  buildOpenClawSignal: vi.fn(() => ({
    kind: "lifecycle",
    name: "stop",
    phase: "idle",
    priority: "normal",
    routeKey: "session.stopped",
    summary: "Session stopped",
  })),
}));

import { wakeOpenClaw } from "../index.js";
import { getOpenClawConfig, resolveGateway } from "../config.js";
import { wakeGateway } from "../dispatcher.js";
import type { OpenClawConfig } from "../types.js";

const TEST_CONFIG: OpenClawConfig = {
  enabled: true,
  gateways: {
    "test-gw": { url: "https://example.com/hook", method: "POST" },
  },
  hooks: {
    stop: { gateway: "test-gw", instruction: "Stopped: {{tmuxTail}}", enabled: true },
    "session-end": { gateway: "test-gw", instruction: "Ended: {{tmuxTail}}", enabled: true },
    "session-start": { gateway: "test-gw", instruction: "Started", enabled: true },
  },
};

const RESOLVED_GW = {
  gatewayName: "test-gw",
  gateway: { url: "https://example.com/hook", method: "POST" as const },
  instruction: "Stopped: {{tmuxTail}}",
};

const PROJECT_PATH = "/home/user/project";
const STATE_DIR = join(PROJECT_PATH, ".omc", "state");

describe("dead-pane guard in wakeOpenClaw (issue #2562)", () => {
  let origTmux: string | undefined;
  let origTmuxPane: string | undefined;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;

  beforeEach(() => {
    origTmux = process.env.TMUX;
    origTmuxPane = process.env.TMUX_PANE;
    origHome = process.env.HOME;
    origUserProfile = process.env.USERPROFILE;
    process.env.HOME = PROJECT_PATH;
    process.env.USERPROFILE = PROJECT_PATH;
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    process.env.TMUX_PANE = "%42";

    vi.mocked(getOpenClawConfig).mockReturnValue(TEST_CONFIG);
    vi.mocked(resolveGateway).mockReturnValue(RESOLVED_GW);
    mockGetNewPaneTail.mockReset();
    mockGetNewPaneTail.mockReturnValue("");
    vi.mocked(wakeGateway).mockReset();
    vi.mocked(wakeGateway).mockResolvedValue({ gateway: "test-gw", success: true });
  });

  afterEach(() => {
    if (origTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = origTmux;
    if (origTmuxPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = origTmuxPane;
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;
    vi.clearAllMocks();
  });

  it("skips capture when pane has no new lines — no stale tmuxTail in payload", async () => {
    mockGetNewPaneTail.mockReturnValue("");

    await wakeOpenClaw("stop", {
      sessionId: "sid-dead",
      projectPath: PROJECT_PATH,
    });

    expect(mockGetNewPaneTail).toHaveBeenCalledWith("%42", STATE_DIR, 15);
    const [, , payload] = vi.mocked(wakeGateway).mock.calls[0] as [string, unknown, { tmuxTail?: string }];
    expect(payload.tmuxTail).toBeUndefined();
  });

  it("captures new pane delta — tmuxTail forwarded to gateway", async () => {
    mockGetNewPaneTail.mockReturnValue("live output line");

    await wakeOpenClaw("stop", {
      sessionId: "sid-alive",
      projectPath: PROJECT_PATH,
    });

    expect(mockGetNewPaneTail).toHaveBeenCalledWith("%42", STATE_DIR, 15);
    const [, , payload] = vi.mocked(wakeGateway).mock.calls[0] as [string, unknown, { tmuxTail?: string }];
    expect(payload.tmuxTail).toBe("live output line");
  });

  it("skips capture for session-end when pane has no new lines", async () => {
    mockGetNewPaneTail.mockReturnValue("");
    vi.mocked(resolveGateway).mockReturnValue({ ...RESOLVED_GW, instruction: "Ended: {{tmuxTail}}" });

    await wakeOpenClaw("session-end", {
      sessionId: "sid-end-dead",
      projectPath: PROJECT_PATH,
    });

    expect(mockGetNewPaneTail).toHaveBeenCalledWith("%42", STATE_DIR, 15);
    const [, , payload] = vi.mocked(wakeGateway).mock.calls[0] as [string, unknown, { tmuxTail?: string }];
    expect(payload.tmuxTail).toBeUndefined();
  });

  it("does not call getNewPaneTail for session-start (non-stop event)", async () => {
    vi.mocked(resolveGateway).mockReturnValue({ ...RESOLVED_GW, instruction: "Started" });

    await wakeOpenClaw("session-start", {
      sessionId: "sid-start",
      projectPath: PROJECT_PATH,
    });

    expect(mockGetNewPaneTail).not.toHaveBeenCalled();
  });

  it("does not call getNewPaneTail when TMUX env is absent", async () => {
    delete process.env.TMUX;

    await wakeOpenClaw("stop", {
      sessionId: "sid-no-tmux",
      projectPath: PROJECT_PATH,
    });

    expect(mockGetNewPaneTail).not.toHaveBeenCalled();
  });

  it("does not call getNewPaneTail when TMUX_PANE env is absent", async () => {
    delete process.env.TMUX_PANE;

    await wakeOpenClaw("stop", {
      sessionId: "sid-no-pane-id",
      projectPath: PROJECT_PATH,
    });

    expect(mockGetNewPaneTail).not.toHaveBeenCalled();
  });

  it("does not call getNewPaneTail when projectPath is absent", async () => {
    await wakeOpenClaw("stop", {
      sessionId: "sid-no-path",
    });

    expect(mockGetNewPaneTail).not.toHaveBeenCalled();
    const [, , payload] = vi.mocked(wakeGateway).mock.calls[0] as [string, unknown, { tmuxTail?: string }];
    expect(payload.tmuxTail).toBeUndefined();
  });

  it("uses caller-provided tmuxTail and skips getNewPaneTail entirely", async () => {
    await wakeOpenClaw("stop", {
      sessionId: "sid-prefilled",
      projectPath: PROJECT_PATH,
      tmuxTail: "pre-captured content",
    });

    expect(mockGetNewPaneTail).not.toHaveBeenCalled();
    const [, , payload] = vi.mocked(wakeGateway).mock.calls[0] as [string, unknown, { tmuxTail?: string }];
    expect(payload.tmuxTail).toBe("pre-captured content");
  });
});
