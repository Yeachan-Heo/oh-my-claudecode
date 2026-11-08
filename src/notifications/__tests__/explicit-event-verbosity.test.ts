import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NotificationConfig } from "../types.js";

const mockDispatchNotifications = vi.fn();
vi.mock("../dispatcher.js", () => ({
  dispatchNotifications: (...args: unknown[]) => mockDispatchNotifications(...args),
  sendDiscord: vi.fn(),
  sendDiscordBot: vi.fn(),
  sendTelegram: vi.fn(),
  sendSlack: vi.fn(),
  sendSlackBot: vi.fn(),
  sendWebhook: vi.fn(),
}));

const mockGetNotificationConfig = vi.fn();
const mockIsEventEnabled = vi.fn();
const mockIsEventAllowedByVerbosity = vi.fn();
vi.mock("../config.js", () => ({
  getNotificationConfig: (profileName?: string) => mockGetNotificationConfig(profileName),
  isEventEnabled: (config: unknown, event: unknown) => mockIsEventEnabled(config, event),
  getVerbosity: () => "session",
  getTmuxTailLines: () => 15,
  isEventAllowedByVerbosity: (verbosity: unknown, event: unknown) =>
    mockIsEventAllowedByVerbosity(verbosity, event),
  shouldIncludeTmuxTail: () => false,
}));

vi.mock("../tmux.js", () => ({
  getCurrentTmuxSession: () => "test-tmux",
  getCurrentTmuxPaneId: () => "%99",
  getTeamTmuxSessions: () => [],
  formatTmuxInfo: () => null,
}));

vi.mock("../hook-config.js", () => ({
  getHookConfig: () => null,
  resolveEventTemplate: () => undefined,
  resetHookConfigCache: vi.fn(),
  mergeHookConfigIntoNotificationConfig: (_hook: unknown, config: unknown) => config,
}));

vi.mock("../session-registry.js", () => ({
  registerMessage: vi.fn(),
}));

import { notify } from "../index.js";

const baseConfig: NotificationConfig = {
  enabled: true,
  webhook: {
    enabled: true,
    url: "https://example.test/webhook",
  },
};

describe("explicit event notification verbosity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockGetNotificationConfig.mockReturnValue(baseConfig);
    mockIsEventEnabled.mockReturnValue(true);
    mockIsEventAllowedByVerbosity.mockReturnValue(false);
    mockDispatchNotifications.mockResolvedValue({
      anySuccess: true,
      results: [{ platform: "webhook", success: true }],
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps default session verbosity as a gate for ask-user-question when the event is not explicitly enabled", async () => {
    const result = await notify("ask-user-question", {
      sessionId: "sess-default-gated",
      question: "Continue?",
    });

    expect(result).toBeNull();
    expect(mockIsEventAllowedByVerbosity).toHaveBeenCalledWith(
      "session",
      "ask-user-question",
    );
    expect(mockDispatchNotifications).not.toHaveBeenCalled();
  });

  it("dispatches explicitly enabled ask-user-question even when default session verbosity would otherwise block it", async () => {
    mockGetNotificationConfig.mockReturnValue({
      ...baseConfig,
      events: {
        "ask-user-question": { enabled: true },
      },
    } satisfies NotificationConfig);

    const result = await notify("ask-user-question", {
      sessionId: "sess-explicit-ask",
      question: "Which option?",
    });

    expect(result).toEqual({
      anySuccess: true,
      results: [{ platform: "webhook", success: true }],
    });
    expect(mockIsEventAllowedByVerbosity).not.toHaveBeenCalled();
    expect(mockDispatchNotifications).toHaveBeenCalledOnce();
    expect(mockDispatchNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        events: { "ask-user-question": { enabled: true } },
      }),
      "ask-user-question",
      expect.objectContaining({
        event: "ask-user-question",
        sessionId: "sess-explicit-ask",
        question: "Which option?",
      }),
      undefined,
    );
  });
});
