import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compactOmcStartupGuidance,
  loadConfig,
  loadContextFromFiles,
} from "../loader.js";
import { saveAndClear, restore } from "./test-helpers.js";

const ALL_KEYS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_MODEL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_BASE_URL",
  "OMC_ROUTING_FORCE_INHERIT",
  "OMC_MODEL_HIGH",
  "OMC_MODEL_MEDIUM",
  "OMC_MODEL_LOW",
  "CLAUDE_CODE_BEDROCK_OPUS_MODEL",
  "CLAUDE_CODE_BEDROCK_SONNET_MODEL",
  "CLAUDE_CODE_BEDROCK_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const;

// ---------------------------------------------------------------------------
// Auto-forceInherit for Bedrock / Vertex (issues #1201, #1025)
// ---------------------------------------------------------------------------
describe("loadConfig() — auto-forceInherit for non-standard providers", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveAndClear(ALL_KEYS);
  });
  afterEach(() => {
    restore(saved);
  });

  it("auto-enables forceInherit for global. Bedrock inference profile with [1m] suffix", () => {
    process.env.ANTHROPIC_MODEL = "global.anthropic.claude-sonnet-4-6[1m]";
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(true);
  });

  it("auto-enables forceInherit when CLAUDE_CODE_USE_BEDROCK=1", () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(true);
  });

  it("auto-enables forceInherit for us. Bedrock region prefix", () => {
    process.env.ANTHROPIC_MODEL = "us.anthropic.claude-opus-4-6-v1";
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(true);
  });

  it("auto-enables forceInherit for Bedrock inference-profile ARN model IDs", () => {
    process.env.ANTHROPIC_MODEL =
      "arn:aws:bedrock:us-east-2:123456789012:inference-profile/global.anthropic.claude-opus-4-6-v1:0";
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(true);
  });

  it("auto-enables forceInherit when CLAUDE_CODE_USE_VERTEX=1", () => {
    process.env.CLAUDE_CODE_USE_VERTEX = "1";
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(true);
  });

  it("does NOT auto-enable forceInherit for standard Anthropic API usage", () => {
    process.env.ANTHROPIC_MODEL = "claude-sonnet-4-6";
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(false);
  });

  it("does NOT auto-enable forceInherit when no provider env vars are set", () => {
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(false);
  });

  it("respects explicit OMC_ROUTING_FORCE_INHERIT=false even on Bedrock", () => {
    // When user explicitly sets the var (even to false), auto-detection is skipped.
    // This matches the guard: process.env.OMC_ROUTING_FORCE_INHERIT === undefined
    process.env.ANTHROPIC_MODEL = "global.anthropic.claude-sonnet-4-6[1m]";
    process.env.OMC_ROUTING_FORCE_INHERIT = "false";
    const config = loadConfig();
    // env var is defined → auto-detection skipped → remains at default (false)
    expect(config.routing?.forceInherit).toBe(false);
  });

  it("maps Bedrock family env vars into agent defaults and routing tiers", () => {
    process.env.CLAUDE_CODE_BEDROCK_OPUS_MODEL =
      "us.anthropic.claude-opus-4-6-v1:0";
    process.env.CLAUDE_CODE_BEDROCK_SONNET_MODEL =
      "us.anthropic.claude-sonnet-4-6-v1:0";
    process.env.CLAUDE_CODE_BEDROCK_HAIKU_MODEL =
      "us.anthropic.claude-haiku-4-5-v1:0";

    const config = loadConfig();

    expect(config.agents?.architect?.model).toBe(
      "us.anthropic.claude-opus-4-6-v1:0",
    );
    expect(config.agents?.executor?.model).toBe(
      "us.anthropic.claude-sonnet-4-6-v1:0",
    );
    expect(config.agents?.explore?.model).toBe(
      "us.anthropic.claude-haiku-4-5-v1:0",
    );
    expect(config.routing?.tierModels?.HIGH).toBe(
      "us.anthropic.claude-opus-4-6-v1:0",
    );
    expect(config.routing?.tierModels?.MEDIUM).toBe(
      "us.anthropic.claude-sonnet-4-6-v1:0",
    );
    expect(config.routing?.tierModels?.LOW).toBe(
      "us.anthropic.claude-haiku-4-5-v1:0",
    );
  });

  it("supports Anthropic family-default env vars for tiered routing defaults", () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = "claude-opus-4-6-custom";
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = "claude-sonnet-4-6-custom";
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "claude-haiku-4-5-custom";

    const config = loadConfig();

    expect(config.agents?.architect?.model).toBe("claude-opus-4-6-custom");
    expect(config.agents?.executor?.model).toBe("claude-sonnet-4-6-custom");
    expect(config.agents?.explore?.model).toBe("claude-haiku-4-5-custom");
  });
});

describe("startup context compaction", () => {
  it("compacts only OMC-style guidance in loadContextFromFiles while preserving key sections", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "omc-loader-context-"));

    try {
      const omcAgentsPath = join(tempDir, "AGENTS.md");
      const omcGuidance = `# oh-my-claudecode - Intelligent Multi-Agent Orchestration

<guidance_schema_contract>
schema
</guidance_schema_contract>

<operating_principles>
- keep this
</operating_principles>

<agent_catalog>
- verbose agent catalog
- verbose agent catalog
</agent_catalog>

<skills>
- verbose skills catalog
- verbose skills catalog
</skills>

<team_compositions>
- verbose team compositions
</team_compositions>

<verification>
- verify this stays
</verification>`;

      writeFileSync(omcAgentsPath, omcGuidance);

      const loaded = loadContextFromFiles([omcAgentsPath]);

      expect(loaded).toContain("<operating_principles>");
      expect(loaded).toContain("<verification>");
      expect(loaded).not.toContain("<agent_catalog>");
      expect(loaded).not.toContain("<skills>");
      expect(loaded).not.toContain("<team_compositions>");
      expect(loaded.length).toBeLessThan(
        omcGuidance.length + `## Context from ${omcAgentsPath}\n\n`.length - 40,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("leaves non-OMC guidance unchanged even if it uses similar tags", () => {
    const nonOmc = `# Project guide

<skills>
Keep this custom section.
</skills>`;

    expect(compactOmcStartupGuidance(nonOmc)).toBe(nonOmc);
  });
});

describe("plan output configuration", () => {
  let saved: Record<string, string | undefined>;
  let originalCwd: string;

  beforeEach(() => {
    saved = saveAndClear(ALL_KEYS);
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    restore(saved);
  });

  it("includes plan output defaults", () => {
    const config = loadConfig();
    expect(config.planOutput).toEqual({
      directory: ".omc/plans",
      filenameTemplate: "{{name}}.md",
    });
  });

  it("includes teleport defaults", () => {
    const config = loadConfig();
    expect(config.teleport).toEqual({
      symlinkNodeModules: true,
    });
  });

  it("loads plan output overrides from project config", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "omc-plan-output-"));

    try {
      const claudeDir = join(tempDir, ".claude");
      require("node:fs").mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, "omc.jsonc"),
        JSON.stringify({
          planOutput: {
            directory: "docs/plans",
            filenameTemplate: "plan-{{name}}.md",
          },
        }),
      );

      process.chdir(tempDir);

      const config = loadConfig();
      expect(config.planOutput).toEqual({
        directory: "docs/plans",
        filenameTemplate: "plan-{{name}}.md",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
