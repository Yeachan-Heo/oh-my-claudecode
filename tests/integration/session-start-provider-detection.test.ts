/**
 * Both SessionStart hooks (the plugin script and the installed template) carry their own
 * inlined Bedrock and Vertex model-ID patterns. A subprocess per entrypoint checks that a
 * session model naming a provider gets the model-routing override and a Claude model does not.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENTRYPOINTS = [
  ["scripts/session-start.mjs", join(PROJECT_ROOT, "scripts", "session-start.mjs")],
  ["templates/hooks/session-start.mjs", join(PROJECT_ROOT, "templates", "hooks", "session-start.mjs")],
] as const;

// Session model values and whether the hook must announce a non-standard provider.
const MODELS: [string, Record<string, string>, boolean][] = [
  ["a us. Bedrock profile", { ANTHROPIC_MODEL: "us.anthropic.claude-sonnet-4-6-v1:0" }, true],
  ["an eu. Bedrock profile", { ANTHROPIC_MODEL: "eu.anthropic.claude-sonnet-4-6-v1:0" }, true],
  ["an ap. Bedrock profile", { ANTHROPIC_MODEL: "ap.anthropic.claude-sonnet-4-6-v1:0" }, true],
  ["an apac. Bedrock profile", { ANTHROPIC_MODEL: "apac.anthropic.claude-sonnet-4-6-v1:0" }, true],
  ["an upper-case apac. Bedrock profile", { ANTHROPIC_MODEL: "APAC.ANTHROPIC.CLAUDE-SONNET-4-6-V1:0" }, true],
  ["an apac. Bedrock profile in CLAUDE_MODEL", { CLAUDE_MODEL: "apac.anthropic.claude-opus-4-6-v1:0" }, true],
  ["a global. Bedrock profile", { ANTHROPIC_MODEL: "global.anthropic.claude-sonnet-4-6-v1:0" }, true],
  ["a bare anthropic.claude Bedrock ID", { ANTHROPIC_MODEL: "anthropic.claude-3-haiku-20240307-v1:0" }, true],
  ["a Bedrock inference-profile ARN", { ANTHROPIC_MODEL: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6-v1:0" }, true],
  ["a Vertex ID", { ANTHROPIC_MODEL: "vertex_ai/claude-sonnet-4-6" }, true],
  ["a model that is not Claude's", { ANTHROPIC_MODEL: "deepseek-chat" }, true],
  ["a padded apac. Bedrock profile", { ANTHROPIC_MODEL: " apac.anthropic.claude-sonnet-4-6-v1:0 " }, true],
  ["a padded us. Bedrock profile in CLAUDE_MODEL", { CLAUDE_MODEL: "\tus.anthropic.claude-sonnet-4-6-v1:0\n" }, true],
  ["a padded bare Bedrock ID", { ANTHROPIC_MODEL: "  anthropic.claude-3-haiku-20240307-v1:0" }, true],
  ["a padded Bedrock inference-profile ARN", { ANTHROPIC_MODEL: " arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6-v1:0 " }, true],
  ["a padded Vertex ID", { ANTHROPIC_MODEL: " vertex_ai/claude-sonnet-4-6 " }, true],
  ["a blank CLAUDE_MODEL before a Bedrock ANTHROPIC_MODEL", { CLAUDE_MODEL: "  ", ANTHROPIC_MODEL: "apac.anthropic.claude-sonnet-4-6-v1:0" }, true],
  ["a blank CLAUDE_MODEL before a non-Claude ANTHROPIC_MODEL", { CLAUDE_MODEL: " ", ANTHROPIC_MODEL: "deepseek-chat" }, true],
  ["a padded Claude model ID", { ANTHROPIC_MODEL: " claude-sonnet-4-6 " }, false],
  ["a blank CLAUDE_MODEL before a Claude ANTHROPIC_MODEL", { CLAUDE_MODEL: "  ", ANTHROPIC_MODEL: "claude-sonnet-4-6" }, false],
  ["only blank session models", { CLAUDE_MODEL: " ", ANTHROPIC_MODEL: "\t" }, false],
  ["a Claude model ID", { ANTHROPIC_MODEL: "claude-sonnet-4-6" }, false],
  ["no model", {}, false],
];

describe("SessionStart hooks: provider detection from the session model", () => {
  let dir: string;
  let home: string;
  let project: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-start-provider-"));
    home = join(dir, "home");
    project = join(dir, "project");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(project, ".git"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  function context(entrypoint: string, env: Record<string, string>) {
    const result = spawnSync(process.execPath, [entrypoint], {
      input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "session-provider-detection", cwd: project }),
      encoding: "utf-8",
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, "config"),
        CLAUDE_CONFIG_DIR: join(home, "claude"),
        OMC_STATE_DIR: join(dir, ".omc"),
        OMC_NOTIFY: "0",
        NODE_NO_WARNINGS: "1",
        ...env,
      },
      timeout: 15000,
    });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}");
    expect(output.continue).toBe(true);
    return (output.hookSpecificOutput?.additionalContext ?? "") as string;
  }

  describe.each(ENTRYPOINTS)("%s", (_name, entrypoint) => {
    it.each(MODELS)("%s", (_label, env, announces) => {
      const text = context(entrypoint, env);
      if (announces) expect(text).toContain("[MODEL ROUTING OVERRIDE");
      else expect(text).not.toContain("[MODEL ROUTING OVERRIDE");
    }, 20000);

    it("the Bedrock flag announces the override whatever the model is", () => {
      expect(context(entrypoint, { CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_MODEL: "claude-sonnet-4-6" })).toContain("[MODEL ROUTING OVERRIDE");
    }, 20000);

    it("the Bedrock flag with 'true' announces the override (issue #5131)", () => {
      expect(context(entrypoint, { CLAUDE_CODE_USE_BEDROCK: "true", ANTHROPIC_MODEL: "claude-sonnet-4-6" })).toContain("[MODEL ROUTING OVERRIDE");
    }, 20000);

    it("the Bedrock flag with 'TRUE' (uppercase) announces the override (issue #5131)", () => {
      expect(context(entrypoint, { CLAUDE_CODE_USE_BEDROCK: "TRUE", ANTHROPIC_MODEL: "claude-sonnet-4-6" })).toContain("[MODEL ROUTING OVERRIDE");
    }, 20000);

    it("the Bedrock flag with ' true ' (padded) announces the override (issue #5131)", () => {
      expect(context(entrypoint, { CLAUDE_CODE_USE_BEDROCK: " true ", ANTHROPIC_MODEL: "claude-sonnet-4-6" })).toContain("[MODEL ROUTING OVERRIDE");
    }, 20000);

    it("the Vertex flag announces the override whatever the model is", () => {
      expect(context(entrypoint, { CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_MODEL: "claude-sonnet-4-6" })).toContain("[MODEL ROUTING OVERRIDE");
    }, 20000);

    it("the Vertex flag with 'true' announces the override (issue #5131)", () => {
      expect(context(entrypoint, { CLAUDE_CODE_USE_VERTEX: "true", ANTHROPIC_MODEL: "claude-sonnet-4-6" })).toContain("[MODEL ROUTING OVERRIDE");
    }, 20000);

    it("the Vertex flag with 'TRUE' (uppercase) announces the override (issue #5131)", () => {
      expect(context(entrypoint, { CLAUDE_CODE_USE_VERTEX: "TRUE", ANTHROPIC_MODEL: "claude-sonnet-4-6" })).toContain("[MODEL ROUTING OVERRIDE");
    }, 20000);

    it("the Vertex flag with ' true ' (padded) announces the override (issue #5131)", () => {
      expect(context(entrypoint, { CLAUDE_CODE_USE_VERTEX: " true ", ANTHROPIC_MODEL: "claude-sonnet-4-6" })).toContain("[MODEL ROUTING OVERRIDE");
    }, 20000);
  });
});
