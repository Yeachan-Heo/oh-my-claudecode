/**
 * OMC_JEV_MAX_EFFORT_ALWAYS: real pre-tool-enforcer.mjs subprocess against a
 * mock Jev endpoint. By default OMC_JEV_MAX_EFFORT bounds only the effort the
 * active model-routing point sets. With OMC_JEV_MAX_EFFORT_ALWAYS=1 an explicit
 * Task/Agent effort above the cap is lowered whether or not Jev answers or is
 * asked, and on the hook's error path. Without the variable nothing changes.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const API_KEY = "test-key-123";

type Answers = Record<string, Record<string, unknown>>;

function choiceAnswer(choice: string, confidence = 0.9) {
  return {
    type: "choice",
    choice,
    confidence,
    probabilities: { haiku: 0.05, sonnet: 0.05, opus: 0.05, [choice]: 0.9 },
  };
}

function scoreAnswer(score: number, confidence = 0.7) {
  return {
    type: "score",
    score,
    confidence,
    legend: { "0": "Low", "1": "Medium", "2": "High", "3": "Extra high", "4": "Maximum" },
    probabilities: { "0": 0.1, "1": 0.4, "2": 0.4, "3": 0.05, "4": 0.05 },
  };
}

// Keep the test's event loop free: the hook's synchronous Jev child must be
// able to POST to the HTTP server running in this process. `processCwd` is the
// hook's working directory; the hook reads the project directory from `input.cwd`.
function runEnforcer(input: Record<string, unknown>, env: NodeJS.ProcessEnv, processCwd: string) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(PROJECT_ROOT, "scripts", "pre-tool-enforcer.mjs")], {
      cwd: processCwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    child.stdin.on("error", reject);
    child.stdin.end(JSON.stringify(input));
  });
}

// Polling utility to wait for a condition to be true (replacement for vi.waitFor which is not available in vitest 4.1.11)
async function waitFor(
  condition: () => void,
  options: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const { timeout = 5000, interval = 50 } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      condition();
      return; // Condition passed
    } catch (error) {
      // Condition failed, retry after interval
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  // Last attempt before timeout
  condition();
}

describe("pre-tool-enforcer.mjs: OMC_JEV_MAX_EFFORT_ALWAYS caps every explicit Task/Agent effort", () => {
  // The hooks run with `root` as their working directory, and so do the detached
  // shadow resolvers they start. A process's working directory cannot be removed on
  // Windows, so each test's project directory lives under `root`, which is removed
  // only after every test.
  let root: string;
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  let server: Server;
  let requests: unknown[];
  let status: number;
  let answersFor: () => Answers;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "jev-effort-always-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  beforeEach(async () => {
    cwd = mkdtempSync(join(root, "case-"));
    requests = [];
    status = 200;
    answersFor = () => ({ "model-tier": choiceAnswer("opus") });
    server = createServer((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        raw += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(raw));
        response.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
        response.end(JSON.stringify({ answers: answersFor(), usage: { input_tokens: 10, output_tokens: 2 } }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected local TCP endpoint");

    // Only model-routing is opted in, so no detached shadow children outlive a test.
    env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: cwd,
      USERPROFILE: cwd,
      XDG_CONFIG_HOME: join(cwd, "config"),
      CLAUDE_CONFIG_DIR: join(cwd, "claude"),
      NODE_NO_WARNINGS: "1",
      OMC_DISABLE_MULTIREPO: "1",
      OMC_STATE_DIR: join(cwd, ".omc"),
      OMC_JEV_LOG_DIR: join(cwd, "jev-logs"),
      OMC_JEV_QUIET: "1",
      OMC_JEV_TIMEOUT_MS: "2000",
      OMC_PRE_TOOL_ADVISORY_COOLDOWN_MS: "0",
      TYPESAFE_API_KEY: API_KEY,
      OMC_JEV_ENDPOINT: `http://127.0.0.1:${address.port}/v1/systemone`,
      OMC_JEV: "model-routing:active",
      OMC_JEV_MAX_EFFORT: "high",
    };
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    // A detached shadow resolver may still have its log file open for a moment.
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });

  function agentInput(extra: Record<string, unknown> = {}, toolName = "Agent") {
    return {
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: {
        description: "Trace the flaky auth test",
        prompt: "Find why src/auth/session.test.ts fails intermittently and fix it.",
        subagent_type: "general-purpose",
        model: "haiku",
        ...extra,
      },
      cwd,
      session_id: "test-sess-effort-always",
    };
  }

  /** The tool input Claude Code would run: updatedInput when present, else the original. */
  async function routedInput(input: ReturnType<typeof agentInput>, extraEnv: NodeJS.ProcessEnv = {}) {
    const result = await runEnforcer(input, { ...env, ...extraEnv }, root);
    expect(result.exitCode, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.continue).toBe(true);
    return (output.hookSpecificOutput?.updatedInput ?? input.tool_input) as Record<string, unknown>;
  }

  /** Shadow mode asks Jev from a detached resolver: wait for its row before cleanup. */
  async function waitForShadowRow() {
    await waitFor(
      () => {
        const entries = readFileSync(join(cwd, "jev-logs", "shadow.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ point: "model-routing", mode: "shadow" })]),
        );
      },
      { timeout: 5000, interval: 25 },
    );
  }

  /** A plugin root whose dist module throws on import, so main() fails before it parses the input. */
  function brokenPluginRoot() {
    const pluginRoot = join(cwd, "broken-plugin-root");
    mkdirSync(join(pluginRoot, "dist", "lib"), { recursive: true });
    writeFileSync(join(pluginRoot, "dist", "lib", "worktree-paths.js"), "throw new Error('forced hook failure');\n");
    return pluginRoot;
  }

  /**
   * A plugin root whose getOmcRoot works once and then throws: main() resolves the state
   * root, parses the input and handles the Task/Agent call, then fails in getTodoStatus.
   */
  function laterFailingPluginRoot() {
    const pluginRoot = join(cwd, "later-failing-plugin-root");
    mkdirSync(join(pluginRoot, "dist", "lib"), { recursive: true });
    writeFileSync(join(pluginRoot, "package.json"), '{ "type": "module" }\n');
    writeFileSync(
      join(pluginRoot, "dist", "lib", "worktree-paths.js"),
      [
        "import { join } from 'node:path';",
        "let calls = 0;",
        "export function getOmcRoot(directory) {",
        "  calls += 1;",
        "  if (calls > 1) throw new Error('forced hook failure');",
        "  return join(directory, '.omc');",
        "}",
        "",
      ].join("\n"),
    );
    return pluginRoot;
  }

  const ALWAYS = { OMC_JEV_MAX_EFFORT_ALWAYS: "1" };

  describe("without the variable (unchanged behavior)", () => {
    it.each([
      ["the point is off", { OMC_JEV: undefined }],
      ["OMC_JEV=off", { OMC_JEV: "off" }],
      ["there is no TYPESAFE_API_KEY", { TYPESAFE_API_KEY: undefined }],
    ])("leaves an explicit effort above the cap as it was when %s", async (_label, extraEnv) => {
      const input = agentInput({ effort: "max" });
      expect(await routedInput(input, extraEnv)).toEqual(input.tool_input);
      expect(requests).toHaveLength(0);
    }, 15000);

    it.each(["0", "false", "no", "", " "])("treats OMC_JEV_MAX_EFFORT_ALWAYS=%j as off", async (value) => {
      const input = agentInput({ effort: "max" });
      expect(await routedInput(input, { OMC_JEV: undefined, OMC_JEV_MAX_EFFORT_ALWAYS: value })).toEqual(
        input.tool_input,
      );
    }, 15000);

    it("leaves a call Jev is not asked about as it was", async () => {
      const input = agentInput({ model: "fable", effort: "max" });
      expect(await routedInput(input)).toEqual(input.tool_input);
      expect(requests).toHaveLength(0);
    }, 15000);

    it("leaves the call as it was in shadow mode and after a degraded call", async () => {
      const input = agentInput({ effort: "max" });
      status = 500;
      expect(await routedInput(input)).toEqual(input.tool_input);
      expect(requests).toHaveLength(1);
      status = 200;
      expect(await routedInput(input, { OMC_JEV: "model-routing" })).toEqual(input.tool_input);
      await waitForShadowRow();
    }, 15000);

    it("still caps an explicit effort when the active point answers without an effort", async () => {
      expect((await routedInput(agentInput({ effort: "max" }))).effort).toBe("high");
    }, 15000);

    it("continues with the call unchanged when the hook fails", async () => {
      const result = await runEnforcer(agentInput({ effort: "max" }), { ...env, CLAUDE_PLUGIN_ROOT: brokenPluginRoot() }, root);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ continue: true, suppressOutput: true });
    }, 15000);
  });

  describe("with OMC_JEV_MAX_EFFORT_ALWAYS=1", () => {
    it.each([
      ["the point is off", { OMC_JEV: undefined }],
      ["OMC_JEV=off", { OMC_JEV: "off" }],
      ["there is no TYPESAFE_API_KEY", { TYPESAFE_API_KEY: undefined }],
    ])("caps an explicit effort when %s, and changes nothing else", async (_label, extraEnv) => {
      const input = agentInput({ effort: "max" });
      expect(await routedInput(input, { ...ALWAYS, ...extraEnv })).toEqual({ ...input.tool_input, effort: "high" });
      expect(requests).toHaveLength(0);
    }, 15000);

    it.each([
      ["Agent", "xhigh"],
      ["Task", "max"],
      ["Agent", "MAX"],
    ])("caps a %s call with effort %s", async (toolName, effort) => {
      const input = agentInput({ effort }, toolName);
      expect((await routedInput(input, { ...ALWAYS, OMC_JEV: undefined })).effort).toBe("high");
    }, 15000);

    it.each(["true", " TRUE ", "1"])("is enabled by %j", async (value) => {
      const input = agentInput({ effort: "max" });
      expect((await routedInput(input, { OMC_JEV: undefined, OMC_JEV_MAX_EFFORT_ALWAYS: value })).effort).toBe("high");
    }, 15000);

    it.each([
      ["a model other than haiku, sonnet or opus", { model: "fable" }],
      ["no model, without OMC_JEV_MODEL_ROUTING_ALL_AGENTS", { model: undefined }],
    ])("caps a call Jev is not asked about: %s", async (_label, extra) => {
      const input = agentInput({ ...extra, effort: "max" });
      expect(await routedInput(input, ALWAYS)).toEqual({ ...input.tool_input, effort: "high" });
      expect(requests).toHaveLength(0);
    }, 15000);

    it("caps after a degraded call", async () => {
      status = 500;
      const input = agentInput({ effort: "max" });
      expect(await routedInput(input, ALWAYS)).toEqual({ ...input.tool_input, effort: "high" });
      expect(requests).toHaveLength(1);
    }, 15000);

    it("caps in shadow mode and keeps the model", async () => {
      answersFor = () => ({ effort: scoreAnswer(0.2), "model-tier": choiceAnswer("opus") });
      const input = agentInput({ effort: "xhigh" });
      expect(await routedInput(input, { ...ALWAYS, OMC_JEV: "model-routing" })).toEqual({
        ...input.tool_input,
        effort: "high",
      });
      await waitForShadowRow();
    }, 15000);

    it("caps in plan mode with OMC_JEV_PLAN_MODE=shadow", async () => {
      const input = { ...agentInput({ effort: "max" }), permission_mode: "plan" };
      expect(await routedInput(input, { ...ALWAYS, OMC_JEV_PLAN_MODE: "shadow" })).toEqual({
        ...input.tool_input,
        effort: "high",
      });
      await waitForShadowRow();
    }, 15000);

    it("leaves the active point's answers exactly as without the variable", async () => {
      answersFor = () => ({ effort: scoreAnswer(3.8), "model-tier": choiceAnswer("opus") });
      const withEffortAnswer = await routedInput(agentInput({ effort: "low" }), ALWAYS);
      expect(withEffortAnswer).toEqual(await routedInput(agentInput({ effort: "low" })));
      expect(withEffortAnswer).toMatchObject({ model: "opus", effort: "high" });

      answersFor = () => ({ "model-tier": choiceAnswer("sonnet") });
      const withoutEffortAnswer = await routedInput(agentInput({ effort: "max" }), ALWAYS);
      expect(withoutEffortAnswer).toEqual(await routedInput(agentInput({ effort: "max" })));
      expect(withoutEffortAnswer).toMatchObject({ model: "sonnet", effort: "high" });
    }, 30000);

    it("works with a use marker: the marker sets the model, the cap holds the explicit effort", async () => {
      const prompt = "use opus\n\nFind why src/auth/session.test.ts fails intermittently and fix it.";
      const input = agentInput({ prompt, effort: "max" });
      const routed = await routedInput(input, { ...ALWAYS, OMC_JEV: undefined, OMC_JEV_MODEL_ROUTING_MARKER: "1" });
      expect(routed).toEqual({
        ...input.tool_input,
        prompt: "Find why src/auth/session.test.ts fails intermittently and fix it.",
        model: "opus",
        effort: "high",
      });
      expect(requests).toHaveLength(0);
    }, 15000);

    it("works with a use marker that names an effort: the cap bounds it as well", async () => {
      const prompt = "use sonnet xhigh\n\nFind why src/auth/session.test.ts fails intermittently and fix it.";
      const input = agentInput({ prompt, effort: "max" });
      const routed = await routedInput(input, {
        ...ALWAYS,
        OMC_JEV: undefined,
        OMC_JEV_MODEL_ROUTING_MARKER: "1",
        OMC_JEV_MAX_EFFORT: "medium",
      });
      expect(routed).toMatchObject({ model: "sonnet", effort: "medium" });
      expect(requests).toHaveLength(0);
    }, 15000);

    it.each([
      ["an effort within the cap", { effort: "medium" }, {}],
      ["an effort that is not a level", { effort: "ultra" }, {}],
      ["a call without effort", {}, {}],
      ["an explicit max under the default cap", { effort: "max" }, { OMC_JEV_MAX_EFFORT: undefined }],
    ])("leaves %s as it was", async (_label, extra, extraEnv) => {
      const input = agentInput(extra);
      expect(await routedInput(input, { ...ALWAYS, OMC_JEV: undefined, ...extraEnv })).toEqual(input.tool_input);
    }, 15000);

    it("reports an unknown cap once per hook run, however often it is read", async () => {
      answersFor = () => ({ effort: scoreAnswer(1.2), "model-tier": choiceAnswer("opus") });
      const loudEnv = { ...env, ...ALWAYS, OMC_JEV_QUIET: undefined, OMC_JEV_MAX_EFFORT: "hihg" };
      const active = await runEnforcer(agentInput({ effort: "max" }), loudEnv, root);
      expect(active.exitCode, active.stderr).toBe(0);
      expect(active.stderr.split("OMC_JEV_MAX_EFFORT=hihg")).toHaveLength(2);
      const off = await runEnforcer(agentInput({ effort: "max" }), { ...loudEnv, OMC_JEV: undefined }, root);
      expect(off.exitCode, off.stderr).toBe(0);
      expect(off.stderr.split("OMC_JEV_MAX_EFFORT=hihg")).toHaveLength(2);
      // The unknown value means the default cap (max), so the explicit max stays.
      expect(JSON.parse(off.stdout).hookSpecificOutput?.updatedInput).toBeUndefined();
    }, 30000);

    it("caps the effort on the hook's error path and changes nothing else", async () => {
      const failing = { ...env, ...ALWAYS, CLAUDE_PLUGIN_ROOT: brokenPluginRoot() };
      const input = agentInput({ effort: "max" });
      const result = await runEnforcer(input, failing, root);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...input.tool_input, effort: "high" } },
      });

      // Within the cap, or not a Task/Agent call: the usual error output.
      for (const other of [agentInput({ effort: "medium" }), agentInput({ effort: "max" }, "Bash")]) {
        const plain = await runEnforcer(other, failing, root);
        expect(plain.exitCode, plain.stderr).toBe(0);
        expect(JSON.parse(plain.stdout)).toEqual({ continue: true, suppressOutput: true });
      }
    }, 30000);

    it("caps the call's own effort when the hook fails after it parsed the input", async () => {
      const failing = { ...env, ...ALWAYS, OMC_JEV: undefined, CLAUDE_PLUGIN_ROOT: laterFailingPluginRoot() };
      const input = agentInput({ effort: "xhigh" });
      const result = await runEnforcer(input, failing, root);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...input.tool_input, effort: "high" } },
      });
      // Without the variable the same failure gives the usual error output.
      const plain = await runEnforcer(input, { ...failing, OMC_JEV_MAX_EFFORT_ALWAYS: undefined }, root);
      expect(plain.exitCode, plain.stderr).toBe(0);
      expect(JSON.parse(plain.stdout)).toEqual({ continue: true, suppressOutput: true });
    }, 30000);

    it("keeps a configured per-agent model (issue #3242) and caps the effort", async () => {
      mkdirSync(join(cwd, ".claude"), { recursive: true });
      writeFileSync(join(cwd, ".claude", "omc.jsonc"), '{ "agents": { "explore": { "model": "sonnet" } } }');
      const input = agentInput({ subagent_type: "oh-my-claudecode:explore", model: undefined, effort: "max" }, "Task");
      const routingEnv = { OMC_JEV: undefined, OMC_ROUTING_FORCE_INHERIT: "false" };
      expect(await routedInput(input, { ...routingEnv, ...ALWAYS })).toEqual({
        ...input.tool_input,
        model: "sonnet",
        effort: "high",
      });
      // Without the variable only the model is injected.
      expect(await routedInput(input, routingEnv)).toEqual({ ...input.tool_input, model: "sonnet" });
    }, 30000);

    it("uses the Codex output shape on the error path for a Codex hook input", async () => {
      const failing = { ...env, ...ALWAYS, CLAUDE_PLUGIN_ROOT: brokenPluginRoot() };
      const input = { ...agentInput({ effort: "max" }), turn_id: "turn-1" };
      const result = await runEnforcer(input, failing, root);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { ...input.tool_input, effort: "high" },
        },
      });
    }, 15000);
  });
});
