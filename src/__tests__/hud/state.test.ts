import { describe, it, expect, vi, beforeEach } from "vitest";
import { readHudConfig, writeHudConfig } from "../../hud/state.js";
import { DEFAULT_HUD_CONFIG } from "../../hud/types.js";

// Mock fs and os modules
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("../../lib/atomic-write.js", () => ({
  atomicWriteJsonSync: vi.fn(),
  atomicWriteFileSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: () => "/Users/testuser",
}));

import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "../../lib/atomic-write.js";
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockAtomicWriteFileSync = vi.mocked(atomicWriteFileSync);

describe("readHudConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("priority order", () => {
    it("returns defaults when no config files exist", () => {
      mockExistsSync.mockReturnValue(false);

      const config = readHudConfig();

      expect(config).toEqual(DEFAULT_HUD_CONFIG);
    });

    it("reads from settings.json omcHud key first", () => {
      mockExistsSync.mockImplementation((path) => {
        const s = String(path);
        return /[\\/]Users[\\/]testuser[\\/]\.claude[\\/]settings\.json$/.test(
          s,
        );
      });
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          omcHud: {
            elements: {
              gitRepo: true,
              gitBranch: true,
            },
          },
        }),
      );

      const config = readHudConfig();

      expect(config.elements.gitRepo).toBe(true);
      expect(config.elements.gitBranch).toBe(true);
    });

    it("reads callCountsFormat from settings.json", () => {
      mockExistsSync.mockImplementation((path) => {
        const s = String(path);
        return /[\/]Users[\/]testuser[\/]\.claude[\/]settings\.json$/.test(
          s,
        );
      });
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          omcHud: {
            elements: {
              callCountsFormat: "emoji",
            },
          },
        }),
      );

      const config = readHudConfig();

      expect(config.elements.callCountsFormat).toBe("emoji");
    });

    it("falls back to legacy hud-config.json when settings.json has no omcHud", () => {
      mockExistsSync.mockImplementation((path) => {
        const s = String(path);
        return (
          /[\\/]Users[\\/]testuser[\\/]\.claude[\\/]settings\.json$/.test(s) ||
          /[\\/]Users[\\/]testuser[\\/]\.claude[\\/]\.omc[\\/]hud-config\.json$/.test(
            s,
          )
        );
      });
      mockReadFileSync.mockImplementation((path) => {
        const s = String(path);
        if (
          /[\\/]Users[\\/]testuser[\\/]\.claude[\\/]settings\.json$/.test(s)
        ) {
          return JSON.stringify({ someOtherKey: true });
        }
        if (
          /[\\/]Users[\\/]testuser[\\/]\.claude[\\/]\.omc[\\/]hud-config\.json$/.test(
            s,
          )
        ) {
          return JSON.stringify({
            elements: {
              cwd: true,
            },
          });
        }
        return "{}";
      });

      const config = readHudConfig();

      expect(config.elements.cwd).toBe(true);
    });

    it("prefers settings.json over legacy hud-config.json", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation((path) => {
        const s = String(path);
        if (
          /[\\/]Users[\\/]testuser[\\/]\.claude[\\/]settings\.json$/.test(s)
        ) {
          return JSON.stringify({
            omcHud: {
              elements: {
                gitRepo: true,
              },
            },
          });
        }
        if (
          /[\\/]Users[\\/]testuser[\\/]\.claude[\\/]\.omc[\\/]hud-config\.json$/.test(
            s,
          )
        ) {
          return JSON.stringify({
            elements: {
              gitRepo: false,
              cwd: true,
            },
          });
        }
        return "{}";
      });

      const config = readHudConfig();

      // Should use settings.json value, not legacy
      expect(config.elements.gitRepo).toBe(true);
    });
  });

  describe("error handling", () => {
    it("returns defaults when settings.json is invalid JSON", () => {
      mockExistsSync.mockImplementation((path) => {
        const s = String(path);
        return /[\\/]Users[\\/]testuser[\\/]\.claude[\\/]settings\.json$/.test(
          s,
        );
      });
      mockReadFileSync.mockReturnValue("invalid json");

      const config = readHudConfig();

      expect(config).toEqual(DEFAULT_HUD_CONFIG);
    });

    it("falls back to legacy when settings.json read fails", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation((path) => {
        const s = String(path);
        if (
          /[\\/]Users[\\/]testuser[\\/]\.claude[\\/]settings\.json$/.test(s)
        ) {
          throw new Error("Read error");
        }
        if (
          /[\\/]Users[\\/]testuser[\\/]\.claude[\\/]\.omc[\\/]hud-config\.json$/.test(
            s,
          )
        ) {
          return JSON.stringify({
            elements: { cwd: true },
          });
        }
        return "{}";
      });

      const config = readHudConfig();

      expect(config.elements.cwd).toBe(true);
    });
  });

  describe("merging with defaults", () => {
    it("allows mission board to be explicitly enabled from settings", () => {
      mockExistsSync.mockImplementation((path) => {
        const s = String(path);
        return /[\/]Users[\/]testuser[\/]\.claude[\/]settings\.json$/.test(s);
      });
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          omcHud: {
            elements: {
              missionBoard: true,
            },
          },
        }),
      );

      const config = readHudConfig();

      expect(config.elements.missionBoard).toBe(true);
      expect(config.missionBoard?.enabled).toBe(true);
    });

    it("merges partial config with defaults", () => {
      mockExistsSync.mockImplementation((path) => {
        const s = String(path);
        return /[\\/]Users[\\/]testuser[\\/]\.claude[\\/]settings\.json$/.test(
          s,
        );
      });
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          omcHud: {
            elements: {
              gitRepo: true,
            },
          },
        }),
      );

      const config = readHudConfig();

      // Custom value
      expect(config.elements.gitRepo).toBe(true);
      // Default values preserved
      expect(config.elements.omcLabel).toBe(
        DEFAULT_HUD_CONFIG.elements.omcLabel,
      );
      expect(config.elements.contextBar).toBe(
        DEFAULT_HUD_CONFIG.elements.contextBar,
      );
      expect(config.preset).toBe(DEFAULT_HUD_CONFIG.preset);
    });

    it("merges thresholds with defaults", () => {
      mockExistsSync.mockImplementation((path) => {
        const s = String(path);
        return /[\\/]Users[\\/]testuser[\\/]\.claude[\\/]settings\.json$/.test(
          s,
        );
      });
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          omcHud: {
            thresholds: {
              contextWarning: 80,
            },
          },
        }),
      );

      const config = readHudConfig();

      expect(config.thresholds.contextWarning).toBe(80);
      expect(config.thresholds.contextCritical).toBe(
        DEFAULT_HUD_CONFIG.thresholds.contextCritical,
      );
    });

    it("merges maxWidth and wrapMode from settings", () => {
      mockExistsSync.mockImplementation((path) => {
        const s = String(path);
        return /[\\/]Users[\\/]testuser[\\/]\.claude[\\/]settings\.json$/.test(
          s,
        );
      });
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          omcHud: {
            maxWidth: 80,
            wrapMode: "wrap",
          },
        }),
      );

      const config = readHudConfig();

      expect(config.maxWidth).toBe(80);
      expect(config.wrapMode).toBe("wrap");
    });

    it("merges usageApiPollIntervalMs from settings", () => {
      mockExistsSync.mockImplementation((path) => {
        const s = String(path);
        return /[\\/]Users[\\/]testuser[\\/]\.claude[\\/]settings\.json$/.test(
          s,
        );
      });
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          omcHud: {
            usageApiPollIntervalMs: 180_000,
          },
        }),
      );

      const config = readHudConfig();

      expect(config.usageApiPollIntervalMs).toBe(180_000);
      expect(config.maxWidth).toBe(DEFAULT_HUD_CONFIG.maxWidth);
    });
  });
});

describe("writeHudConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves unrelated settings.json keys while writing omcHud", () => {
    mockExistsSync.mockImplementation((path) =>
      String(path).endsWith("settings.json"),
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ theme: "dark", nested: { keep: true } }),
    );

    const ok = writeHudConfig({
      ...DEFAULT_HUD_CONFIG,
      elements: {
        ...DEFAULT_HUD_CONFIG.elements,
        gitRepo: true,
      },
    });

    expect(ok).toBe(true);
    expect(mockAtomicWriteFileSync).toHaveBeenCalledTimes(1);
    const [, raw] = mockAtomicWriteFileSync.mock.calls[0] as [string, string];
    const written = JSON.parse(raw);
    expect(written.theme).toBe("dark");
    expect(written.nested).toEqual({ keep: true });
    expect(written.omcHud.elements.gitRepo).toBe(true);
  });

  it("merges legacy hud-config defaults into the written omcHud payload", () => {
    mockExistsSync.mockImplementation((path) => {
      const s = String(path);
      return s.endsWith("settings.json") || s.endsWith(".omc/hud-config.json");
    });
    mockReadFileSync.mockImplementation((path) => {
      const s = String(path);
      if (s.endsWith("settings.json")) {
        return JSON.stringify({ existing: true });
      }
      return JSON.stringify({
        elements: { cwd: true },
        wrapMode: "wrap",
      });
    });

    const ok = writeHudConfig({
      ...DEFAULT_HUD_CONFIG,
      elements: {
        ...DEFAULT_HUD_CONFIG.elements,
        gitBranch: true,
      },
    });

    expect(ok).toBe(true);
    const [, raw] = mockAtomicWriteFileSync.mock.calls[0] as [string, string];
    const written = JSON.parse(raw);
    expect(written.omcHud.elements.cwd).toBe(true);
    expect(written.omcHud.elements.gitBranch).toBe(true);
    expect(written.omcHud.wrapMode).toBe("truncate");
  });
});

describe("layout config round-trip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("readHudConfig preserves layout from settings.json", () => {
    mockExistsSync.mockImplementation((path) =>
      String(path).endsWith("settings.json"),
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        omcHud: {
          layout: {
            line1: ["gitBranch", "model"],
            main: ["omcLabel", "contextBar"],
            detail: ["todos"],
          },
        },
      }),
    );

    const config = readHudConfig();

    expect(config.layout).toEqual({
      line1: ["gitBranch", "model"],
      main: ["omcLabel", "contextBar"],
      detail: ["todos"],
    });
  });

  it("readHudConfig returns no layout when not configured", () => {
    mockExistsSync.mockImplementation((path) =>
      String(path).endsWith("settings.json"),
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        omcHud: {
          elements: { gitRepo: true },
        },
      }),
    );

    const config = readHudConfig();

    expect(config.layout).toBeUndefined();
  });

  it("writeHudConfig persists layout to settings.json", () => {
    mockExistsSync.mockImplementation((path) =>
      String(path).endsWith("settings.json"),
    );
    mockReadFileSync.mockReturnValue(JSON.stringify({}));

    const ok = writeHudConfig({
      ...DEFAULT_HUD_CONFIG,
      layout: {
        main: ["contextBar", "omcLabel", "ralph"],
      },
    });

    expect(ok).toBe(true);
    const [, raw] = mockAtomicWriteFileSync.mock.calls[0] as [string, string];
    const written = JSON.parse(raw);
    expect(written.omcHud.layout).toEqual({
      main: ["contextBar", "omcLabel", "ralph"],
    });
  });
});
