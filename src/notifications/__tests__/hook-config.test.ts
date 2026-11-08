/**
 * Tests for hook notification config reader (omc_config.hook.json).
 *
 * Covers:
 * - File missing → null
 * - File disabled → null
 * - Valid config parsing and caching
 * - Cache reset
 * - Template cascade resolution
 * - Merge into NotificationConfig (event enabled/disabled overrides)
 * - OMC_HOOK_CONFIG env var override
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  getHookConfig,
  resetHookConfigCache,
  resolveEventTemplate,
  mergeHookConfigIntoNotificationConfig,
} from "../hook-config.js";
import type { HookNotificationConfig } from "../hook-config-types.js";
import type { NotificationConfig } from "../types.js";

const TEST_DIR = join(tmpdir(), `omc-hook-config-test-${process.pid}`);
const TEST_CONFIG_PATH = join(TEST_DIR, "omc_config.hook.json");

function writeTestConfig(config: object): void {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(TEST_CONFIG_PATH, JSON.stringify(config, null, 2));
}

describe("hook-config reader", () => {
  beforeEach(() => {
    resetHookConfigCache();
    vi.stubEnv("OMC_HOOK_CONFIG", TEST_CONFIG_PATH);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetHookConfigCache();
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  // -----------------------------------------------------------------------
  // getHookConfig
  // -----------------------------------------------------------------------

  it("returns null when file does not exist", () => {
    vi.stubEnv("OMC_HOOK_CONFIG", join(TEST_DIR, "nonexistent.json"));
    expect(getHookConfig()).toBeNull();
  });

  it("returns null when enabled is false", () => {
    writeTestConfig({ version: 1, enabled: false });
    expect(getHookConfig()).toBeNull();
  });

  it("parses valid config correctly", () => {
    writeTestConfig({
      version: 1,
      enabled: true,
      events: {
        "session-end": {
          enabled: true,
          template: "Session ended: {{duration}}",
        },
      },
    });
    const config = getHookConfig();
    expect(config).not.toBeNull();
    expect(config!.version).toBe(1);
    expect(config!.enabled).toBe(true);
    expect(config!.events?.["session-end"]?.template).toBe(
      "Session ended: {{duration}}",
    );
  });

  it("caches after first read", () => {
    writeTestConfig({ version: 1, enabled: true });
    const first = getHookConfig();
    const second = getHookConfig();
    expect(first).toBe(second); // same reference
  });

  it("resetHookConfigCache clears the cache", () => {
    writeTestConfig({ version: 1, enabled: true });
    const first = getHookConfig();
    resetHookConfigCache();
    // Rewrite with different content
    writeTestConfig({
      version: 1,
      enabled: true,
      defaultTemplate: "changed",
    });
    const second = getHookConfig();
    expect(second).not.toBe(first);
    expect(second!.defaultTemplate).toBe("changed");
  });

  it("returns null for invalid JSON", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(TEST_CONFIG_PATH, "not json{{{");
    expect(getHookConfig()).toBeNull();
  });

  it("OMC_HOOK_CONFIG env var overrides default path", () => {
    const altDir = join(TEST_DIR, "alt");
    const altPath = join(altDir, "custom-hook.json");
    mkdirSync(altDir, { recursive: true });
    writeFileSync(
      altPath,
      JSON.stringify({ version: 1, enabled: true, defaultTemplate: "custom" }),
    );
    vi.stubEnv("OMC_HOOK_CONFIG", altPath);
    resetHookConfigCache();
    const config = getHookConfig();
    expect(config!.defaultTemplate).toBe("custom");
  });

  // -----------------------------------------------------------------------
  // resolveEventTemplate
  // -----------------------------------------------------------------------

  describe("resolveEventTemplate", () => {
    const baseConfig: HookNotificationConfig = {
      version: 1,
      enabled: true,
      defaultTemplate: "Global: {{event}}",
      events: {
        "session-end": {
          enabled: true,
          template: "Event: {{duration}}",
          platforms: {
            discord: { template: "Discord: {{projectDisplay}}" },
            telegram: { enabled: true },
          },
        },
        "session-start": {
          enabled: true,
        },
      },
    };

    it("returns platform override when present", () => {
      expect(resolveEventTemplate(baseConfig, "session-end", "discord")).toBe(
        "Discord: {{projectDisplay}}",
      );
    });

    it("returns null when hookConfig is null", () => {
      expect(resolveEventTemplate(null as any, "session-start", "discord")).toBeNull();
    });

    it("returns event template when no platform override", () => {
      expect(resolveEventTemplate(baseConfig, "session-end", "slack")).toBe(
        "Event: {{duration}}",
      );
    });

    it("returns event template when platform has no template field", () => {
      expect(resolveEventTemplate(baseConfig, "session-end", "telegram")).toBe(
        "Event: {{duration}}",
      );
    });

    it("returns defaultTemplate when event has no template", () => {
      expect(
        resolveEventTemplate(baseConfig, "session-start", "discord"),
      ).toBe("Global: {{event}}");
    });

    it("returns defaultTemplate when event is not in config", () => {
      expect(
        resolveEventTemplate(baseConfig, "session-idle", "discord"),
      ).toBe("Global: {{event}}");
    });

    it("returns null when no template at any level", () => {
      const minimal: HookNotificationConfig = {
        version: 1,
        enabled: true,
        events: { "session-end": { enabled: true } },
      };
      expect(resolveEventTemplate(minimal, "session-end", "discord")).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // mergeHookConfigIntoNotificationConfig
  // -----------------------------------------------------------------------

  describe("mergeHookConfigIntoNotificationConfig", () => {
    const baseNotifConfig: NotificationConfig = {
      enabled: true,
      telegram: {
        enabled: true,
        botToken: "tok-123",
        chatId: "chat-456",
      },
      events: {
        "session-end": { enabled: true },
        "session-start": { enabled: true },
      },
    };

    it("overrides event enabled flag", () => {
      const hookConfig: HookNotificationConfig = {
        version: 1,
        enabled: true,
        events: {
          "session-start": { enabled: false },
        },
      };
      const merged = mergeHookConfigIntoNotificationConfig(
        hookConfig,
        baseNotifConfig,
      );
      expect(merged.events?.["session-start"]?.enabled).toBe(false);
      expect(merged.events?.["session-end"]?.enabled).toBe(true);
    });

    it("preserves platform credentials", () => {
      const hookConfig: HookNotificationConfig = {
        version: 1,
        enabled: true,
        events: {
          "session-end": { enabled: false },
        },
      };
      const merged = mergeHookConfigIntoNotificationConfig(
        hookConfig,
        baseNotifConfig,
      );
      expect(merged.telegram?.botToken).toBe("tok-123");
      expect(merged.telegram?.chatId).toBe("chat-456");
    });

    it("adds new event entries from hook config", () => {
      const hookConfig: HookNotificationConfig = {
        version: 1,
        enabled: true,
        events: {
          "session-idle": { enabled: true },
        },
      };
      const merged = mergeHookConfigIntoNotificationConfig(
        hookConfig,
        baseNotifConfig,
      );
      expect(merged.events?.["session-idle"]?.enabled).toBe(true);
    });

    it("returns unmodified config when hookConfig has no events", () => {
      const hookConfig: HookNotificationConfig = {
        version: 1,
        enabled: true,
      };
      const merged = mergeHookConfigIntoNotificationConfig(
        hookConfig,
        baseNotifConfig,
      );
      expect(merged).toEqual(baseNotifConfig);
    });
  });
});
