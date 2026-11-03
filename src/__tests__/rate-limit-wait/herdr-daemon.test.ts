/**
 * Daemon-level tests for the herdr arm of the rate-limit poll loop
 * (src/features/rate-limit-wait/daemon.ts).
 *
 * Drives the real pollLoop with the detector boundary mocked: a confirmed
 * limited -> clear transition must resume a tracked herdr pane through
 * sendHerdrResumeSequence while tmux panes keep using sendResumeSequence.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  BlockedPane,
  DaemonConfig,
  DaemonState,
  RateLimitStatus,
} from "../../features/rate-limit-wait/types.js";

const boundary = vi.hoisted(() => ({
  check: vi.fn(),
  tmuxScan: vi.fn(),
  tmuxRevalidate: vi.fn(),
  tmuxResume: vi.fn(() => true),
  herdrEnabled: vi.fn(() => true),
  herdrScan: vi.fn(),
  herdrRevalidate: vi.fn(),
  herdrResume: vi.fn(async () => true),
}));

vi.mock(
  "../../features/rate-limit-wait/rate-limit-monitor.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../features/rate-limit-wait/rate-limit-monitor.js")
      >();
    return { ...actual, checkRateLimitStatus: boundary.check };
  },
);

vi.mock(
  "../../features/rate-limit-wait/tmux-detector.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../features/rate-limit-wait/tmux-detector.js")
      >();
    return {
      ...actual,
      isTmuxAvailable: vi.fn(() => false), // herdr-only machine
      scanForBlockedPanes: boundary.tmuxScan,
      revalidateBlockedPanes: boundary.tmuxRevalidate,
      sendResumeSequence: boundary.tmuxResume,
      isHerdrDetectorEnabled: boundary.herdrEnabled,
      scanForBlockedHerdrPanes: boundary.herdrScan,
      revalidateBlockedHerdrPanes: boundary.herdrRevalidate,
      sendHerdrResumeSequence: boundary.herdrResume,
    };
  },
);

import { pollLoop } from "../../features/rate-limit-wait/daemon.js";
import { getUsageProfileHash } from "../../features/rate-limit-wait/daemon-state.js";

function status(limited: boolean): RateLimitStatus {
  return {
    fiveHourLimited: limited,
    weeklyLimited: false,
    monthlyLimited: false,
    isLimited: limited,
    fiveHourResetsAt: null,
    weeklyResetsAt: null,
    monthlyResetsAt: null,
    nextResetAt: null,
    timeUntilResetMs: null,
    lastCheckedAt: new Date(),
  };
}

function herdrBlockedPane(): BlockedPane {
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
  };
}

describe("rate-limit daemon herdr arm", () => {
  let root: string;
  let config: Required<DaemonConfig>;
  let listeners: { event: "SIGINT" | "SIGTERM" | "exit"; original: unknown[] }[];
  let originalConfigDir: string | undefined;
  let originalOAuthToken: string | undefined;
  let originalBaseUrl: string | undefined;
  let originalAuthToken: string | undefined;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    root = join(tmpdir(), "omc-herdr-daemon-test-" + Date.now());
    config = {
      pollIntervalMs: 1000,
      paneLinesToCapture: 15,
      verbose: false,
      stateFilePath: join(root, "state.json"),
      pidFilePath: join(root, "daemon.pid"),
      logFilePath: join(root, "daemon.log"),
    };
    mkdirSync(root, { recursive: true });
    boundary.check.mockReset();
    boundary.tmuxScan.mockReset().mockReturnValue([]);
    boundary.tmuxRevalidate.mockReset().mockReturnValue([]);
    boundary.tmuxResume.mockClear();
    boundary.herdrEnabled.mockReset().mockReturnValue(true);
    boundary.herdrScan.mockReset().mockResolvedValue([]);
    boundary.herdrRevalidate.mockReset().mockResolvedValue([]);
    boundary.herdrResume.mockClear();

    listeners = [
      { event: "SIGINT", original: process.listeners("SIGINT") },
      { event: "SIGTERM", original: process.listeners("SIGTERM") },
      { event: "exit", original: process.listeners("exit") },
    ];
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
    originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    // Fixed usage profile so quota state survives across polls.
    const profileDir = join(root, "claude-profile");
    mkdirSync(profileDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = profileDir;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    writeFileSync(
      join(profileDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "herdr-test-access-token",
          refreshToken: "herdr-test-refresh-token",
          expiresAt: Date.now() + 60_000,
          oauthAccount: {
            uuid: "herdr-test-account",
            emailAddress: "herdr@example.test",
          },
        },
      }),
    );
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    if (originalOAuthToken === undefined)
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken;
    if (originalBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
    if (originalAuthToken === undefined)
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    for (const { event, original } of listeners) {
      for (const listener of event === "exit"
        ? process.listeners("exit")
        : process.listeners(event)) {
        if (!original.includes(listener))
          process.removeListener(event, listener);
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  function seed(
    blockedPanes: BlockedPane[],
    lastConfirmedLimited: boolean,
  ): void {
    const state: DaemonState = {
      isRunning: true,
      pid: null,
      startedAt: new Date(),
      lastPollAt: null,
      rateLimitStatus: null,
      blockedPanes,
      resumedPaneIds: [],
      totalResumeAttempts: 0,
      successfulResumes: 0,
      errorCount: 0,
      ...(() => {
        const hash = getUsageProfileHash();
        return hash ? { usageProfileHash: hash } : {};
      })(),
      lastConfirmedLimited,
    };
    writeFileSync(config.stateFilePath, JSON.stringify(state));
  }

  function observed(): DaemonState {
    return JSON.parse(
      readFileSync(config.stateFilePath, "utf8"),
    ) as DaemonState;
  }

  async function start(sample: RateLimitStatus | null): Promise<void> {
    boundary.check.mockResolvedValue(sample);
    void pollLoop(config);
    await vi.advanceTimersByTimeAsync(0);
  }

  async function next(sample: RateLimitStatus | null): Promise<void> {
    boundary.check.mockResolvedValue(sample);
    await vi.advanceTimersByTimeAsync(1000);
  }

  it("scans herdr panes while limited and resumes them through the agent surface on clear", async () => {
    seed([], false);
    boundary.herdrScan.mockResolvedValue([herdrBlockedPane()]);

    await start(status(true));
    expect(boundary.herdrScan).toHaveBeenCalled();
    expect(observed().blockedPanes.map((pane) => pane.id)).toContain("w9:p1");
    expect(boundary.tmuxScan).not.toHaveBeenCalled(); // tmux unavailable in this scenario

    boundary.herdrRevalidate.mockResolvedValue([herdrBlockedPane()]);
    await next(status(false));
    expect(boundary.herdrResume).toHaveBeenCalledWith("w9:p1");
    expect(boundary.tmuxResume).not.toHaveBeenCalled();
    const after = observed();
    // resumedPaneIds is intentionally cleared once no blocked panes remain.
    expect(after.totalResumeAttempts).toBe(1);
    expect(after.successfulResumes).toBe(1);
    expect(after.blockedPanes).toEqual([]);
  });

  it("skips herdr scanning entirely when the multiplexer is not herdr", async () => {
    boundary.herdrEnabled.mockReturnValue(false);
    seed([], false);

    await start(status(true));
    expect(boundary.herdrScan).not.toHaveBeenCalled();
  });

  it("retains blocked panes when herdr revalidation is inconclusive", async () => {
    seed([herdrBlockedPane()], true);
    boundary.herdrRevalidate.mockResolvedValue(null); // inventory read failed

    await start(status(false));
    expect(boundary.herdrResume).not.toHaveBeenCalled();
    const after = observed();
    expect(after.resumePending).toBe(true);
    expect(after.blockedPanes.map((pane) => pane.id)).toContain("w9:p1");
  });

  it("skips herdr panes that are no longer resumable after revalidation", async () => {
    seed([herdrBlockedPane()], true);
    boundary.herdrRevalidate.mockResolvedValue([]); // conclusive: menu gone

    await start(status(false));
    expect(boundary.herdrResume).not.toHaveBeenCalled();
    const after = observed();
    expect(after.totalResumeAttempts).toBe(0);
    expect(after.blockedPanes).toEqual([]);
  });
});
