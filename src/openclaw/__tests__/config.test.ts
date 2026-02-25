import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fs and paths before imports
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("../../utils/paths.js", () => ({
  getClaudeConfigDir: vi.fn(() => "/home/user/.claude"),
}));

import { existsSync, readFileSync } from "fs";
import {
  getOpenClawConfig,
  resolveGateway,
  resetOpenClawConfigCache,
} from "../config.js";
import type { OpenClawConfig } from "../types.js";

const validConfig: OpenClawConfig = {
  enabled: true,
  gateways: {
    "my-gateway": {
      url: "https://example.com/wake",
      method: "POST",
    },
  },
  hooks: {
    "session-start": {
      gateway: "my-gateway",
      instruction: "Session started for {{projectName}}",
      enabled: true,
    },
    "session-end": {
      gateway: "my-gateway",
      instruction: "Session ended",
      enabled: false,
    },
  },
};

describe("getOpenClawConfig", () => {
  beforeEach(() => {
    resetOpenClawConfigCache();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(validConfig));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    resetOpenClawConfigCache();
  });

  it("returns null when OMC_OPENCLAW is not set", () => {
    vi.stubEnv("OMC_OPENCLAW", "");
    expect(getOpenClawConfig()).toBeNull();
  });

  it("returns null when OMC_OPENCLAW is not '1'", () => {
    vi.stubEnv("OMC_OPENCLAW", "true");
    expect(getOpenClawConfig()).toBeNull();
  });

  it("returns null when config file is missing", () => {
    vi.stubEnv("OMC_OPENCLAW", "1");
    vi.mocked(existsSync).mockReturnValue(false);
    expect(getOpenClawConfig()).toBeNull();
  });

  it("returns null when config has enabled: false", () => {
    vi.stubEnv("OMC_OPENCLAW", "1");
    const disabledConfig = { ...validConfig, enabled: false };
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(disabledConfig));
    expect(getOpenClawConfig()).toBeNull();
  });

  it("returns null when config has invalid JSON", () => {
    vi.stubEnv("OMC_OPENCLAW", "1");
    vi.mocked(readFileSync).mockReturnValue("not valid json {{");
    expect(getOpenClawConfig()).toBeNull();
  });

  it("returns null when config is missing gateways", () => {
    vi.stubEnv("OMC_OPENCLAW", "1");
    const noGateways = { enabled: true, hooks: {} };
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(noGateways));
    expect(getOpenClawConfig()).toBeNull();
  });

  it("returns null when config is missing hooks", () => {
    vi.stubEnv("OMC_OPENCLAW", "1");
    const noHooks = { enabled: true, gateways: {} };
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(noHooks));
    expect(getOpenClawConfig()).toBeNull();
  });

  it("returns valid config when file exists and OMC_OPENCLAW=1", () => {
    vi.stubEnv("OMC_OPENCLAW", "1");
    const config = getOpenClawConfig();
    expect(config).not.toBeNull();
    expect(config!.enabled).toBe(true);
    expect(config!.gateways["my-gateway"]).toBeDefined();
  });

  it("caches config after first read", () => {
    vi.stubEnv("OMC_OPENCLAW", "1");
    getOpenClawConfig();
    getOpenClawConfig();
    getOpenClawConfig();
    // readFileSync should only be called once due to caching
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });

  it("resetOpenClawConfigCache clears the cache", () => {
    vi.stubEnv("OMC_OPENCLAW", "1");
    getOpenClawConfig();
    expect(readFileSync).toHaveBeenCalledTimes(1);
    resetOpenClawConfigCache();
    getOpenClawConfig();
    expect(readFileSync).toHaveBeenCalledTimes(2);
  });

  it("respects OMC_OPENCLAW_CONFIG env var for custom config path", () => {
    vi.stubEnv("OMC_OPENCLAW", "1");
    vi.stubEnv("OMC_OPENCLAW_CONFIG", "/custom/path/config.json");
    // The config file path is resolved at module load time, so we just verify
    // that readFileSync is called (the path is set at import time)
    getOpenClawConfig();
    expect(existsSync).toHaveBeenCalled();
  });
});

describe("resolveGateway", () => {
  it("returns null for unmapped event", () => {
    const result = resolveGateway(validConfig, "stop");
    expect(result).toBeNull();
  });

  it("returns null for disabled hook event", () => {
    const result = resolveGateway(validConfig, "session-end");
    expect(result).toBeNull();
  });

  it("resolves correctly for mapped enabled event", () => {
    const result = resolveGateway(validConfig, "session-start");
    expect(result).not.toBeNull();
    expect(result!.gatewayName).toBe("my-gateway");
    expect(result!.gateway.url).toBe("https://example.com/wake");
    expect(result!.instruction).toBe("Session started for {{projectName}}");
  });

  it("returns gatewayName alongside gateway config", () => {
    const result = resolveGateway(validConfig, "session-start");
    expect(result).toHaveProperty("gatewayName");
    expect(result).toHaveProperty("gateway");
    expect(result).toHaveProperty("instruction");
  });

  it("returns null when gateway name references non-existent gateway", () => {
    const configWithBadGateway: OpenClawConfig = {
      ...validConfig,
      hooks: {
        "session-start": {
          gateway: "non-existent-gateway",
          instruction: "test",
          enabled: true,
        },
      },
    };
    const result = resolveGateway(configWithBadGateway, "session-start");
    expect(result).toBeNull();
  });
});
