import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getVerbosity,
  isEventAllowedByVerbosity,
  shouldIncludeTmuxTail,
} from "../config.js";
import type { NotificationConfig, VerbosityLevel, NotificationEvent } from "../types.js";

describe("getVerbosity", () => {
  const baseConfig: NotificationConfig = {
    enabled: true,
  };

  beforeEach(() => {
    vi.stubEnv("OMC_NOTIFY_VERBOSITY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 'session' by default when no config or env", () => {
    expect(getVerbosity(baseConfig)).toBe("session");
  });

  it("returns config value when set", () => {
    const config: NotificationConfig = { ...baseConfig, verbosity: "minimal" };
    expect(getVerbosity(config)).toBe("minimal");
  });

  it("returns config value 'verbose'", () => {
    const config: NotificationConfig = { ...baseConfig, verbosity: "verbose" };
    expect(getVerbosity(config)).toBe("verbose");
  });

  it("returns config value 'agent'", () => {
    const config: NotificationConfig = { ...baseConfig, verbosity: "agent" };
    expect(getVerbosity(config)).toBe("agent");
  });

  it("returns env var value when set (overrides config)", () => {
    vi.stubEnv("OMC_NOTIFY_VERBOSITY", "verbose");
    const config: NotificationConfig = { ...baseConfig, verbosity: "minimal" };
    expect(getVerbosity(config)).toBe("verbose");
  });

  it("returns 'session' for invalid env var value", () => {
    vi.stubEnv("OMC_NOTIFY_VERBOSITY", "invalid-level");
    expect(getVerbosity(baseConfig)).toBe("session");
  });

  it("returns config value when env var is invalid", () => {
    vi.stubEnv("OMC_NOTIFY_VERBOSITY", "invalid");
    const config: NotificationConfig = { ...baseConfig, verbosity: "agent" };
    expect(getVerbosity(config)).toBe("agent");
  });

  it("returns 'session' when config verbosity is invalid", () => {
    const config: NotificationConfig = {
      ...baseConfig,
      verbosity: "bogus" as VerbosityLevel,
    };
    expect(getVerbosity(config)).toBe("session");
  });
});

describe("isEventAllowedByVerbosity", () => {
  const sessionEvents: NotificationEvent[] = [
    "session-start",
    "session-stop",
    "session-end",
    "session-idle",
  ];

  describe("minimal", () => {
    it("allows session-start", () => {
      expect(isEventAllowedByVerbosity("minimal", "session-start")).toBe(true);
    });

    it("allows session-stop", () => {
      expect(isEventAllowedByVerbosity("minimal", "session-stop")).toBe(true);
    });

    it("allows session-end", () => {
      expect(isEventAllowedByVerbosity("minimal", "session-end")).toBe(true);
    });

    it("allows session-idle", () => {
      expect(isEventAllowedByVerbosity("minimal", "session-idle")).toBe(true);
    });

    it("blocks ask-user-question", () => {
      expect(isEventAllowedByVerbosity("minimal", "ask-user-question")).toBe(false);
    });

    it("blocks agent-call", () => {
      expect(isEventAllowedByVerbosity("minimal", "agent-call")).toBe(false);
    });
  });

  describe("session", () => {
    it("allows all session events", () => {
      for (const event of sessionEvents) {
        expect(isEventAllowedByVerbosity("session", event)).toBe(true);
      }
    });

    it("blocks ask-user-question", () => {
      expect(isEventAllowedByVerbosity("session", "ask-user-question")).toBe(false);
    });

    it("blocks agent-call", () => {
      expect(isEventAllowedByVerbosity("session", "agent-call")).toBe(false);
    });
  });

  describe("agent", () => {
    it("allows all session events", () => {
      for (const event of sessionEvents) {
        expect(isEventAllowedByVerbosity("agent", event)).toBe(true);
      }
    });

    it("allows agent-call", () => {
      expect(isEventAllowedByVerbosity("agent", "agent-call")).toBe(true);
    });

    it("blocks ask-user-question", () => {
      expect(isEventAllowedByVerbosity("agent", "ask-user-question")).toBe(false);
    });
  });

  describe("verbose", () => {
    it("allows all events", () => {
      const allEvents: NotificationEvent[] = [
        ...sessionEvents,
        "ask-user-question",
        "agent-call",
      ];
      for (const event of allEvents) {
        expect(isEventAllowedByVerbosity("verbose", event)).toBe(true);
      }
    });
  });
});

describe("shouldIncludeTmuxTail", () => {
  it("returns false for minimal", () => {
    expect(shouldIncludeTmuxTail("minimal")).toBe(false);
  });

  it("returns true for session", () => {
    expect(shouldIncludeTmuxTail("session")).toBe(true);
  });

  it("returns true for agent", () => {
    expect(shouldIncludeTmuxTail("agent")).toBe(true);
  });

  it("returns true for verbose", () => {
    expect(shouldIncludeTmuxTail("verbose")).toBe(true);
  });
});
