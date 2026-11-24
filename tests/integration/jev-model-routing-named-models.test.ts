/**
 * OMC_JEV_MODEL_ROUTING_NAMED_MODELS: real pre-tool-enforcer.mjs subprocess against a mock
 * Jev endpoint. Without the variable a Task/Agent call that names a model other than haiku,
 * sonnet or opus never reaches Jev. With it, Jev is asked about such a call too and, in
 * active mode, picks from haiku, sonnet and opus (and fable only with
 * OMC_JEV_MODEL_ROUTING_FABLE). Expected values below come from the inputs and the mock
 * answers, not from running the hook.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const API_KEY = "test-key-123";
const TASK = "Find why src/auth/session.test.ts fails intermittently and fix it.";

const ANSWERS = {
  "model-tier": { type: "choice", choice: "sonnet", confidence: 0.9 },
  effort: { type: "score", score: 1, confidence: 0.7 },
};

const NAMED = { OMC_JEV_MODEL_ROUTING_NAMED_MODELS: "1" };

// Keep the test's event loop free: the hook's synchronous Jev child must be
// able to POST to the HTTP server running in this process.
function runEnforcer(input: Record<string, unknown>, env: NodeJS.ProcessEnv, cwd: string) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(PROJECT_ROOT, "scripts", "pre-tool-enforcer.mjs")], {
      cwd,
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

async function waitFor(condition: () => void, options: { timeout?: number; interval?: number } = {}): Promise<void> {
  const { timeout = 5000, interval = 50 } = options;
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    try {
      condition();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
  condition();
}

type JevRequest = { state: Record<string, unknown>; questions: Record<string, { criteria?: Record<string, string> }> };

describe("pre-tool-enforcer.mjs: Jev model-routing for calls that name a model (OMC_JEV_MODEL_ROUTING_NAMED_MODELS)", () => {
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  let server: Server;
  let requests: JevRequest[];
  let status: number;
  let answers: unknown;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "jev-named-models-"));
    requests = [];
    status = 200;
    answers = ANSWERS;
    server = createServer((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        raw += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(raw));
        response.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
        response.end(JSON.stringify({ answers }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected local TCP endpoint");
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
    };
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  function agentInput(extra: Record<string, unknown> = {}, prompt = TASK) {
    return {
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: {
        description: "Trace the flaky auth test",
        prompt,
        subagent_type: "general-purpose",
        ...extra,
      },
      cwd,
      session_id: "test-sess-named-models",
    };
  }

  /** The hook's whole output and the tool input Claude Code would run. */
  async function run(input: ReturnType<typeof agentInput>, extraEnv: NodeJS.ProcessEnv = {}) {
    const result = await runEnforcer(input, { ...env, ...extraEnv }, cwd);
    expect(result.exitCode, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.continue).toBe(true);
    // A denied call would prove the force-inherit gate, not the check under test.
    expect(output.hookSpecificOutput?.permissionDecision).not.toBe("deny");
    return {
      output,
      routed: (output.hookSpecificOutput?.updatedInput ?? input.tool_input) as Record<string, unknown>,
    };
  }
  const routedInput = async (input: ReturnType<typeof agentInput>, extraEnv: NodeJS.ProcessEnv = {}) =>
    (await run(input, extraEnv)).routed;

  function writeAgent(dir: string, name: string, frontmatter: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\n${frontmatter}---\n\nYou are an agent.\n`, "utf8");
  }
  const projectAgents = () => join(cwd, ".claude", "agents");
  const userAgents = () => join(cwd, "claude", "agents");

  function readLog(file: string) {
    return readFileSync(join(cwd, "jev-logs", file), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  // Names that resolve to none of haiku, sonnet or opus and are not unpinned: the cases the variable is for.
  const NAMED_MODELS = [
    ["the alias fable", "fable"],
    ["a Fable model name", "claude-fable-5"],
    ["a provider ID that contains fable", "us.anthropic.claude-fable-5-v1:0"],
    ["a name with none of the four words", "deepseek-chat"],
  ] as const;

  describe("variable unset: identical to dev", () => {
    it.each(NAMED_MODELS)("sends nothing to Jev for a call that names %s", async (_label, model) => {
      const input = agentInput({ model });
      expect(await routedInput(input)).toEqual(input.tool_input);
      expect(await routedInput(input, { OMC_JEV_MODEL_ROUTING_ALL_AGENTS: "1" })).toEqual(input.tool_input);
      expect(requests).toHaveLength(0);
    }, 30000);

    it.each(["", "0", "no", "yes"])("stays off for OMC_JEV_MODEL_ROUTING_NAMED_MODELS=%j", async (value) => {
      await routedInput(agentInput({ model: "fable" }), { OMC_JEV_MODEL_ROUTING_NAMED_MODELS: value });
      expect(requests).toHaveLength(0);
    }, 15000);

    it.each([
      ["user", userAgents],
      ["project", projectAgents],
    ])("sends nothing to Jev for a %s agent whose definition names a non-Claude model", async (_where, dir) => {
      writeAgent(dir(), "my-agent", "model: deepseek-chat\n");
      const input = agentInput({ subagent_type: "my-agent" });
      expect(await routedInput(input)).toEqual(input.tool_input);
      expect(requests).toHaveLength(0);
    }, 15000);
  });

  describe("variable set", () => {
    it.each(["1", "true", " TRUE "])("asks and applies the answers for OMC_JEV_MODEL_ROUTING_NAMED_MODELS=%j", async (value) => {
      const input = agentInput({ model: "fable" });
      const routed = await routedInput(input, { OMC_JEV_MODEL_ROUTING_NAMED_MODELS: value });
      expect(requests).toHaveLength(1);
      expect(routed).toEqual({ ...input.tool_input, model: "sonnet", effort: "medium" });
    }, 15000);

    it.each(NAMED_MODELS)("asks about a call that names %s and replaces the model with a tier", async (_label, model) => {
      const input = agentInput({ model });
      const routed = await routedInput(input, NAMED);
      expect(requests).toHaveLength(1);
      expect(routed).toEqual({ ...input.tool_input, model: "sonnet", effort: "medium" });
    }, 15000);

    it("sends the same state and the questions of a known tier, without fable among the choices", async () => {
      await routedInput(agentInput({ model: "opus" }));
      await routedInput(agentInput({ model: "claude-fable-5" }), NAMED);
      expect(requests).toHaveLength(2);
      expect(requests[1].state).toEqual(requests[0].state);
      expect(requests[1].questions).toEqual(requests[0].questions);
      expect(Object.keys(requests[1].questions["model-tier"].criteria ?? {})).toEqual(["haiku", "sonnet", "opus"]);
    }, 30000);

    it("limits the effort to OMC_JEV_MAX_EFFORT", async () => {
      answers = { ...ANSWERS, effort: { type: "score", score: 3, confidence: 0.7 } };
      const input = agentInput({ model: "fable" });
      expect((await routedInput(input, { ...NAMED, OMC_JEV_MAX_EFFORT: "high" })).effort).toBe("high");
      expect((await routedInput(input, NAMED)).effort).toBe("xhigh");
    }, 30000);

    it("shadow mode asks, keeps the input, and logs no heuristic", async () => {
      const input = agentInput({ model: "fable" });
      const routed = await routedInput(input, { ...NAMED, OMC_JEV: "model-routing" });
      expect(routed).toEqual(input.tool_input);
      await waitFor(() => {
        expect(requests).toHaveLength(1);
        const entry = readLog("shadow.jsonl").find((line) => line.point === "model-routing" && line.mode === "shadow");
        expect(entry).toBeDefined();
        expect(entry.heuristic).toBeNull();
        expect(entry.jev.choice).toBe("sonnet");
      });
    }, 15000);

    it("does not ask about a call without a model or with inherit, as before", async () => {
      await routedInput(agentInput(), NAMED);
      await routedInput(agentInput({ model: "inherit" }), NAMED);
      expect(requests).toHaveLength(0);
      await routedInput(agentInput({ model: "inherit" }), { ...NAMED, OMC_JEV_MODEL_ROUTING_ALL_AGENTS: "1" });
      expect(requests).toHaveLength(1);
    }, 30000);

    it("a model made of blanks is neither asked about nor replaced", async () => {
      const input = agentInput({ model: "   " });
      expect(await routedInput(input, NAMED)).toEqual(input.tool_input);
      expect(requests).toHaveLength(0);
    }, 15000);

    it("still asks about haiku, sonnet and opus once, whatever the variable", async () => {
      await routedInput(agentInput({ model: "haiku" }), NAMED);
      await routedInput(agentInput({ model: "us.anthropic.claude-opus-4-6-v1:0" }), NAMED);
      expect(requests).toHaveLength(2);
    }, 30000);

    it("a tier named in a project or user definition is not asked, with or without the variable", async () => {
      writeAgent(projectAgents(), "tier-agent", "model: sonnet\n");
      await routedInput(agentInput({ subagent_type: "tier-agent" }), NAMED);
      expect(requests).toHaveLength(0);
    }, 15000);

    it("a degraded Jev call leaves the call as it was", async () => {
      status = 500;
      const input = agentInput({ model: "fable" });
      expect(await routedInput(input, NAMED)).toEqual(input.tool_input);
      expect(requests).toHaveLength(1);
    }, 15000);

    it.each([
      ["no answers", {}],
      ["an unknown choice and a score out of range", {
        "model-tier": { type: "choice", choice: "gpt-5", confidence: 0.9 },
        effort: { type: "score", score: 9, confidence: 0.7 },
      }],
      ["answers of the wrong type", { "model-tier": "sonnet", effort: [1] }],
    ])("leaves the fields as they were for %s", async (_label, malformed) => {
      answers = malformed;
      const input = agentInput({ model: "claude-fable-5", effort: "high" });
      expect(await routedInput(input, NAMED)).toEqual(input.tool_input);
      expect(requests).toHaveLength(1);
    }, 15000);
  });

  describe("fable as an answer", () => {
    beforeEach(() => {
      answers = { ...ANSWERS, "model-tier": { type: "choice", choice: "fable", confidence: 0.9 } };
    });

    it("is rejected without OMC_JEV_MODEL_ROUTING_FABLE: the model stays, the effort is set", async () => {
      const input = agentInput({ model: "deepseek-chat" });
      expect(await routedInput(input, NAMED)).toEqual({ ...input.tool_input, effort: "medium" });
      expect(requests).toHaveLength(1);
    }, 15000);

    it("is accepted with OMC_JEV_MODEL_ROUTING_FABLE, which then also lists fable in the question", async () => {
      const input = agentInput({ model: "deepseek-chat" });
      const routed = await routedInput(input, { ...NAMED, OMC_JEV_MODEL_ROUTING_FABLE: "1" });
      expect(routed).toEqual({ ...input.tool_input, model: "fable", effort: "medium" });
      expect(Object.keys(requests[0].questions["model-tier"].criteria ?? {})).toEqual(["haiku", "sonnet", "opus", "fable"]);
    }, 15000);

    it("FABLE alone asks about fable names, not about a name with none of the four words", async () => {
      const fableOnly = { OMC_JEV_MODEL_ROUTING_FABLE: "1" };
      expect((await routedInput(agentInput({ model: "claude-fable-5" }), fableOnly)).model).toBe("fable");
      expect(requests).toHaveLength(1);
      const input = agentInput({ model: "deepseek-chat" });
      expect(await routedInput(input, fableOnly)).toEqual(input.tool_input);
      expect(requests).toHaveLength(1);
    }, 30000);

    it.each([
      ["user", userAgents],
      ["project", projectAgents],
    ])("both variables together: a %s definition that names fable is asked, as with the first variable alone", async (_where, dir) => {
      for (const model of ["fable", "claude-fable-5"]) {
        writeAgent(dir(), "fable-agent", `model: ${model}\n`);
        const input = agentInput({ subagent_type: "fable-agent" });
        const alone = await routedInput(input, NAMED);
        expect(alone, model).toEqual({ ...input.tool_input, effort: "medium" });
        const both = await routedInput(input, { ...NAMED, OMC_JEV_MODEL_ROUTING_FABLE: "1" });
        expect(both, model).toEqual({ ...input.tool_input, model: "fable", effort: "medium" });
      }
      expect(requests).toHaveLength(4);
    }, 30000);

    it("both variables together: a non-Claude definition is asked and may be given fable", async () => {
      writeAgent(projectAgents(), "my-agent", "model: deepseek-chat\n");
      const routed = await routedInput(agentInput({ subagent_type: "my-agent" }), {
        ...NAMED,
        OMC_JEV_MODEL_ROUTING_FABLE: "1",
      });
      expect(routed).toMatchObject({ model: "fable", effort: "medium", subagent_type: "my-agent" });
      expect(requests).toHaveLength(1);
    }, 15000);
  });

  describe("where the name comes from", () => {
    it.each([
      ["user", userAgents],
      ["project", projectAgents],
    ])("a %s agent whose definition names a non-Claude model is asked and routed", async (_where, dir) => {
      writeAgent(dir(), "my-agent", "model: deepseek-chat\n");
      const input = agentInput({ subagent_type: "my-agent" });
      const routed = await routedInput(input, NAMED);
      expect(requests).toHaveLength(1);
      expect(routed).toEqual({ ...input.tool_input, model: "sonnet", effort: "medium" });
    }, 15000);

    it("a plugin agent whose definition names a non-Claude model is asked and routed", async () => {
      const pluginRoot = join(cwd, "plugin");
      writeAgent(join(pluginRoot, "agents"), "plugin-agent", "model: gpt-5\n");
      const input = agentInput({ subagent_type: "plugin-agent" });
      const routed = await routedInput(input, { ...NAMED, CLAUDE_PLUGIN_ROOT: pluginRoot });
      expect(requests).toHaveLength(1);
      expect(routed).toEqual({ ...input.tool_input, model: "sonnet", effort: "medium" });
    }, 15000);

    it("a model from agents.<name>.model in the project config is asked and routed", async () => {
      mkdirSync(join(cwd, ".claude"), { recursive: true });
      writeFileSync(join(cwd, ".claude", "omc.jsonc"), JSON.stringify({ agents: { executor: { model: "fable" } } }));
      const input = agentInput({ subagent_type: "oh-my-claudecode:executor" });
      const extra = { XDG_CONFIG_HOME: join(cwd, "config"), APPDATA: join(cwd, "config"), OMC_ROUTING_FORCE_INHERIT: "false" };
      // Without the variable the configured fable is injected and Jev is not asked.
      expect(await routedInput(input, extra)).toEqual({ ...input.tool_input, model: "fable" });
      expect(requests).toHaveLength(0);
      expect(await routedInput(input, { ...extra, ...NAMED })).toEqual({ ...input.tool_input, model: "sonnet", effort: "medium" });
      expect(requests).toHaveLength(1);
    }, 30000);
  });

  describe("the use marker (OMC_JEV_MODEL_ROUTING_MARKER)", () => {
    const MARKER = { ...NAMED, OMC_JEV_MODEL_ROUTING_MARKER: "1" };

    it("`use fable high` pins both and asks Jev nothing, with or without the variable", async () => {
      const input = agentInput({ model: "deepseek-chat" }, `use fable high\n${TASK}`);
      const withVariable = await routedInput(input, MARKER);
      const without = await routedInput(input, { OMC_JEV_MODEL_ROUTING_MARKER: "1" });
      expect(withVariable).toEqual(without);
      expect(withVariable).toMatchObject({ model: "fable", effort: "high", prompt: TASK });
      expect(requests).toHaveLength(0);
    }, 30000);

    it("`use fable` on a call that names a model: the model stays fable and Jev is asked the effort question only", async () => {
      const input = agentInput({ model: "deepseek-chat" }, `use fable\n${TASK}`);
      const routed = await routedInput(input, MARKER);
      expect(routed).toMatchObject({ model: "fable", effort: "medium", prompt: TASK });
      expect(requests).toHaveLength(1);
      expect(Object.keys(requests[0].questions)).toEqual(["effort"]);
    }, 15000);

    it("`use fable` without the variable sends nothing to Jev, as on dev", async () => {
      const input = agentInput({ model: "deepseek-chat" }, `use fable\n${TASK}`);
      const routed = await routedInput(input, { OMC_JEV_MODEL_ROUTING_MARKER: "1" });
      expect(routed).toMatchObject({ model: "fable", prompt: TASK });
      expect(routed.effort).toBeUndefined();
      expect(requests).toHaveLength(0);
    }, 15000);

    it("`use fable` and `use sonnet` ask the same effort question, with the variable, and with OMC_JEV_MODEL_ROUTING_FABLE alone", async () => {
      const input = (line: string) => agentInput({ model: "deepseek-chat" }, `${line}\n${TASK}`);
      await routedInput(input("use fable"), { OMC_JEV_MODEL_ROUTING_MARKER: "1", OMC_JEV_MODEL_ROUTING_FABLE: "1" });
      await routedInput(input("use sonnet"), { OMC_JEV_MODEL_ROUTING_MARKER: "1" });
      await routedInput(input("use sonnet"), MARKER);
      expect(requests.map((request) => Object.keys(request.questions))).toEqual([["effort"], ["effort"], ["effort"]]);
    }, 30000);

    it("a marker model that forceInherit refuses still pins a named call: only the effort is asked and the model of the definition is not replaced", async () => {
      writeAgent(projectAgents(), "proxy-agent", "model: deepseek-chat\n");
      const input = agentInput({ subagent_type: "proxy-agent" }, `use fable\n${TASK}`);
      const bedrock = { OMC_JEV_MODEL_ROUTING_MARKER: "1", OMC_ROUTING_FORCE_INHERIT: "true", CLAUDE_CODE_USE_BEDROCK: "1" };
      const routed = await routedInput(input, { ...NAMED, ...bedrock });
      expect(routed.model).toBeUndefined();
      expect(routed.effort).toBe("medium");
      expect(requests).toHaveLength(1);
      expect(Object.keys(requests[0].questions)).toEqual(["effort"]);
      // Without the variable nothing is asked, as on dev.
      const without = await routedInput(input, bedrock);
      expect(without.model).toBeUndefined();
      expect(requests).toHaveLength(1);
      // Where the provider resolves the tier of Jev's answer the model is still not replaced (and sonnet, not fable, is the tier mapped).
      const mapped = await routedInput(input, {
        ...NAMED,
        ...bedrock,
        ANTHROPIC_DEFAULT_SONNET_MODEL: "global.anthropic.claude-sonnet-4-6",
      });
      expect(mapped.model).toBeUndefined();
      expect(mapped.effort).toBe("medium");
      expect(requests).toHaveLength(2);
    }, 30000);

    it("a marker model that forceInherit refuses is not shown to Jev as part of the task, and stays in the prompt of the call", async () => {
      writeAgent(projectAgents(), "proxy-agent", "model: deepseek-chat\n");
      const input = agentInput({ subagent_type: "proxy-agent" }, `use fable\n${TASK}`);
      const bedrock = { OMC_JEV_MODEL_ROUTING_MARKER: "1", OMC_ROUTING_FORCE_INHERIT: "true", CLAUDE_CODE_USE_BEDROCK: "1" };
      const routed = await routedInput(input, { ...NAMED, ...bedrock });
      expect(requests).toHaveLength(1);
      expect(requests[0].state.task).toBe(TASK);
      expect(routed.prompt).toBe(`use fable\n${TASK}`);
    }, 15000);

    it("`use <effort>` on a call that names a model leaves the model question to Jev", async () => {
      const routed = await routedInput(agentInput({ model: "fable" }, `use high\n${TASK}`), MARKER);
      expect(requests).toHaveLength(1);
      expect(Object.keys(requests[0].questions)).toEqual(["model-tier"]);
      expect(routed).toMatchObject({ model: "sonnet", effort: "high", prompt: TASK });
    }, 15000);

    it("`use <effort>` without the variable sends nothing to Jev for such a call", async () => {
      const routed = await routedInput(agentInput({ model: "fable" }, `use high\n${TASK}`), {
        OMC_JEV_MODEL_ROUTING_MARKER: "1",
      });
      expect(requests).toHaveLength(0);
      expect(routed).toMatchObject({ model: "fable", effort: "high", prompt: TASK });
    }, 15000);
  });

  describe("provider check", () => {
    const proxy = { ANTHROPIC_BASE_URL: "http://proxy.example.invalid/v1" };
    const forceInherit = { OMC_ROUTING_FORCE_INHERIT: "true", CLAUDE_CODE_USE_BEDROCK: "1" };

    beforeEach(() => {
      writeAgent(projectAgents(), "proxy-agent", "model: deepseek-chat\n");
    });
    const call = () => agentInput({ subagent_type: "proxy-agent" });

    it("a non-Claude provider without a mapping for the tier: the name stays, the effort is set", async () => {
      expect(await routedInput(call(), { ...NAMED, ...proxy })).toEqual({ ...call().tool_input, effort: "medium" });
      expect(requests).toHaveLength(1);
    }, 15000);

    it("a non-Claude provider that maps the tier: the alias is set (the check does not tell the mapped model from the definition's)", async () => {
      const routed = await routedInput(call(), { ...NAMED, ...proxy, ANTHROPIC_DEFAULT_SONNET_MODEL: "other-proxy-model" });
      expect(routed).toEqual({ ...call().tool_input, model: "sonnet", effort: "medium" });
    }, 15000);

    it("a mapping for another tier does not help", async () => {
      const routed = await routedInput(call(), { ...NAMED, ...proxy, ANTHROPIC_DEFAULT_OPUS_MODEL: "other-proxy-model" });
      expect(routed).toEqual({ ...call().tool_input, effort: "medium" });
    }, 15000);

    it("forceInherit without a mapping: the name stays, the effort is set", async () => {
      expect(await routedInput(call(), { ...NAMED, ...forceInherit })).toEqual({ ...call().tool_input, effort: "medium" });
      expect(requests).toHaveLength(1);
    }, 15000);

    it("forceInherit with a mapping the provider accepts: the alias is set", async () => {
      const routed = await routedInput(call(), {
        ...NAMED,
        ...forceInherit,
        ANTHROPIC_DEFAULT_SONNET_MODEL: "global.anthropic.claude-sonnet-4-6",
      });
      expect(routed).toEqual({ ...call().tool_input, model: "sonnet", effort: "medium" });
    }, 15000);

    it("forceInherit alone, with a Claude session model and no provider variable: the name stays, the effort is set", async () => {
      const claudeSession = { OMC_ROUTING_FORCE_INHERIT: "true", ANTHROPIC_MODEL: "claude-sonnet-5" };
      expect(await routedInput(call(), { ...NAMED, ...claudeSession })).toEqual({ ...call().tool_input, effort: "medium" });
      const mapped = { ...NAMED, ...claudeSession, ANTHROPIC_DEFAULT_SONNET_MODEL: "global.anthropic.claude-sonnet-4-6" };
      expect(await routedInput(call(), mapped)).toEqual({ ...call().tool_input, model: "sonnet", effort: "medium" });
      expect(requests).toHaveLength(2);
    }, 30000);

    it("forceInherit with a call that names fable the provider resolves: Jev's alias is checked as well", async () => {
      const mapped = { ...NAMED, ...forceInherit, ANTHROPIC_DEFAULT_FABLE_MODEL: "global.anthropic.claude-fable-5" };
      const input = agentInput({ model: "fable" });
      expect(await routedInput(input, mapped)).toEqual({ ...input.tool_input, effort: "medium" });
      const both = { ...mapped, ANTHROPIC_DEFAULT_SONNET_MODEL: "global.anthropic.claude-sonnet-4-6" };
      expect(await routedInput(input, both)).toEqual({ ...input.tool_input, model: "sonnet", effort: "medium" });
      expect(requests).toHaveLength(2);
    }, 30000);

    it("a call that names haiku, sonnet or opus is not subject to the check (unchanged)", async () => {
      const routed = await routedInput(agentInput({ model: "opus" }), { ...NAMED, ...proxy });
      expect(routed.model).toBe("sonnet");
    }, 15000);

    it.each([
      ["ANTHROPIC_MODEL=sonnet", { ANTHROPIC_MODEL: "sonnet" }],
      ["CLAUDE_MODEL=fable", { CLAUDE_MODEL: "fable" }],
      ["ANTHROPIC_MODEL=claude-sonnet-5", { ANTHROPIC_MODEL: "claude-sonnet-5" }],
    ])("a native alias as the session model (%s) is a Claude provider: Jev's alias replaces the name", async (_label, session) => {
      const input = agentInput({ model: "fable" });
      expect(await routedInput(input, { ...NAMED, ...session })).toEqual({ ...input.tool_input, model: "sonnet", effort: "medium" });
      expect(requests).toHaveLength(1);
    }, 15000);

    it.each(["sonnet[1m]", "opus[1m]", "haiku[200k]"])("a native alias with a context suffix (%s) is a Claude provider too", async (model) => {
      const input = agentInput({ model: "fable" });
      expect(await routedInput(input, { ...NAMED, ANTHROPIC_MODEL: model })).toEqual({ ...input.tool_input, model: "sonnet", effort: "medium" });
      expect(requests).toHaveLength(1);
    }, 15000);

    it("the alias exception is local to the named-model gate: under forceInherit a session alias does not make a plain tier mapping count as a proxy mapping", async () => {
      // forceInherit from the environment, a session alias, a plain (not provider-specific) mapping,
      // no foreign base URL, Jev off: the call is judged as without the alias exception.
      const input = agentInput({ model: "sonnet" });
      const result = await runEnforcer(
        input,
        { ...env, OMC_JEV: "off", OMC_ROUTING_FORCE_INHERIT: "true", ANTHROPIC_MODEL: "sonnet", ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-5" },
        cwd,
      );
      expect(result.exitCode, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.hookSpecificOutput?.permissionDecision).not.toBe("deny");
      expect(output.hookSpecificOutput?.updatedInput ?? input.tool_input).toEqual(input.tool_input);
      expect(requests).toHaveLength(0);
    }, 15000);

    // The host decides, not a substring of the URL: case-insensitive, any scheme or none, port and
    // credentials ignored; the host is anthropic.com or ends in .anthropic.com.
    it.each([
      "https://API.ANTHROPIC.COM",
      "https://api.anthropic.com:443/v1",
      "api.anthropic.com",
      "api.anthropic.com:443/v1",
      "https://user:secret@api.anthropic.com/",
      "https://anthropic.com",
      "https://api.anthropic.com./",
      "",
    ])("an Anthropic base URL (%j) is a Claude provider: Jev's alias replaces the name", async (baseUrl) => {
      const input = agentInput({ model: "fable" });
      const routed = await routedInput(input, { ...NAMED, ANTHROPIC_BASE_URL: baseUrl });
      expect(routed).toEqual({ ...input.tool_input, model: "sonnet", effort: "medium" });
      expect(requests).toHaveLength(1);
    }, 15000);

    it.each([
      "https://anthropic.com.proxy.invalid",
      "https://fakeanthropic.com",
      "https://anthropic.com@proxy.invalid/",
      "https://proxy.invalid/anthropic.com",
      "https://proxy.invalid/?upstream=anthropic.com",
      "proxy.invalid:8080/anthropic.com",
      "not a url anthropic.com",
    ])("a base URL that only mentions anthropic.com (%j) is a proxy: the name stays, the effort is set", async (baseUrl) => {
      const input = agentInput({ model: "fable" });
      const routed = await routedInput(input, { ...NAMED, ANTHROPIC_BASE_URL: baseUrl });
      expect(routed).toEqual({ ...input.tool_input, effort: "medium" });
      expect(requests).toHaveLength(1);
    }, 15000);

    // With no session model variable, the tier defaults identify the provider, as in
    // src/config/models.ts: a Bedrock or Vertex ID, or a name that is not Claude's, keeps the
    // named model unless the tier Jev picked (sonnet) is mapped natively.
    it.each([
      ["a Bedrock ID in CLAUDE_CODE_BEDROCK_OPUS_MODEL", { CLAUDE_CODE_BEDROCK_OPUS_MODEL: "global.anthropic.claude-opus-4-6-v1:0" }],
      ["a Bedrock ID in ANTHROPIC_DEFAULT_HAIKU_MODEL", { ANTHROPIC_DEFAULT_HAIKU_MODEL: "us.anthropic.claude-haiku-4-5-v1:0" }],
      ["a Vertex ID in ANTHROPIC_DEFAULT_OPUS_MODEL", { ANTHROPIC_DEFAULT_OPUS_MODEL: "vertex_ai/claude-opus-4-6" }],
      ["a model that is not Claude's in ANTHROPIC_DEFAULT_OPUS_MODEL", { ANTHROPIC_DEFAULT_OPUS_MODEL: "other-proxy-model" }],
    ])("tier defaults identify a non-Claude provider (%s): the named model stays, the effort is set", async (_label, tierEnv) => {
      const input = agentInput({ model: "fable" });
      expect(await routedInput(input, { ...NAMED, ...tierEnv })).toEqual({ ...input.tool_input, effort: "medium" });
      expect(requests).toHaveLength(1);
    }, 15000);

    it("tier defaults do not hide the mapping of the tier Jev picked: the alias is set", async () => {
      const input = agentInput({ model: "fable" });
      const env = { CLAUDE_CODE_BEDROCK_OPUS_MODEL: "global.anthropic.claude-opus-4-6-v1:0", CLAUDE_CODE_BEDROCK_SONNET_MODEL: "global.anthropic.claude-sonnet-4-6" };
      expect(await routedInput(input, { ...NAMED, ...env })).toEqual({ ...input.tool_input, model: "sonnet", effort: "medium" });
    }, 15000);

    it.each([
      ["a direct session model wins over a stale tier default", { ANTHROPIC_MODEL: "claude-sonnet-5", CLAUDE_CODE_BEDROCK_OPUS_MODEL: "global.anthropic.claude-opus-4-6-v1:0" }],
      ["a Claude model in a tier default is a Claude provider", { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-8" }],
      ["a native alias in a tier default is a Claude provider", { ANTHROPIC_DEFAULT_OPUS_MODEL: "opus" }],
    ])("%s: Jev's alias replaces the name", async (_label, tierEnv) => {
      const input = agentInput({ model: "fable" });
      expect(await routedInput(input, { ...NAMED, ...tierEnv })).toEqual({ ...input.tool_input, model: "sonnet", effort: "medium" });
    }, 15000);

    // One classification for every variable the named-model gate reads: the session models
    // (CLAUDE_MODEL, then ANTHROPIC_MODEL; blank ones are skipped) and, with neither set, the native
    // default of each tier. A value is trimmed, a context suffix ([1m], [200k]) is dropped and the
    // case is ignored before it is compared with the native aliases.
    const TIER_DEFAULT_KEYS = [
      "CLAUDE_CODE_BEDROCK_HAIKU_MODEL",
      "CLAUDE_CODE_BEDROCK_SONNET_MODEL",
      "CLAUDE_CODE_BEDROCK_OPUS_MODEL",
      "CLAUDE_CODE_BEDROCK_FABLE_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_FABLE_MODEL",
    ];
    // Jev answers sonnet and the call names fable: true when the alias replaced the name.
    async function aliasReplaces(extraEnv: NodeJS.ProcessEnv) {
      const input = agentInput({ model: "fable" });
      const before = requests.length;
      const routed = await routedInput(input, { ...NAMED, ...extraEnv });
      expect(requests).toHaveLength(before + 1);
      if (routed.model === "sonnet") {
        expect(routed).toEqual({ ...input.tool_input, model: "sonnet", effort: "medium" });
        return true;
      }
      expect(routed).toEqual({ ...input.tool_input, effort: "medium" });
      return false;
    }
    const CLAUDE_VALUES = ["opus[1m]", "OPUS[1M]", " sonnet ", "fable[200k]", "Haiku", "Claude-Opus-4-8", "claude-opus-4-8[1m]"];
    const OTHER_VALUES = [
      "global.anthropic.claude-opus-4-6-v1:0",
      " global.anthropic.claude-opus-4-6-v1:0[1m] ",
      "US.ANTHROPIC.CLAUDE-OPUS-4-6-V1:0",
      "anthropic.claude-3-haiku-20240307-v1:0",
      "vertex_ai/claude-opus-4-6",
      "GLM-5",
      "glm-5[1m]",
      "opusplan",
    ];

    it.each(TIER_DEFAULT_KEYS)("a suffixed alias in %s is a Claude provider", async (key) => {
      expect(await aliasReplaces({ [key]: "opus[1m]" })).toBe(true);
    }, 15000);

    it.each(CLAUDE_VALUES)("a Claude value (%j) in a tier default is a Claude provider", async (value) => {
      expect(await aliasReplaces({ ANTHROPIC_DEFAULT_OPUS_MODEL: value })).toBe(true);
    }, 15000);

    // The sonnet defaults are left out: Jev answers sonnet, and a native mapping of that tier is what lets the alias through.
    it.each(TIER_DEFAULT_KEYS.filter((key) => !key.includes("SONNET")))("a Bedrock ID in %s is a non-Claude provider", async (key) => {
      expect(await aliasReplaces({ [key]: "global.anthropic.claude-opus-4-6-v1:0" })).toBe(false);
    }, 15000);

    it.each(OTHER_VALUES)("a provider or non-Claude value (%j) in a tier default is a non-Claude provider", async (value) => {
      expect(await aliasReplaces({ CLAUDE_CODE_BEDROCK_FABLE_MODEL: value })).toBe(false);
    }, 15000);

    it.each(["CLAUDE_MODEL", "ANTHROPIC_MODEL"])("%s with a suffixed, padded or upper-case alias is a Claude provider", async (key) => {
      for (const value of ["opus[1m]", " SONNET[200K] ", "fable"]) {
        expect(await aliasReplaces({ [key]: value }), value).toBe(true);
      }
    }, 30000);

    it.each(["CLAUDE_MODEL", "ANTHROPIC_MODEL"])("%s with a non-Claude name, padded or suffixed, is a non-Claude provider", async (key) => {
      for (const value of [" deepseek-chat ", "deepseek-chat[1m]", "opusplan"]) {
        expect(await aliasReplaces({ [key]: value }), value).toBe(false);
      }
    }, 30000);

    it("blank values are skipped: a blank session model or tier default does not decide the provider", async () => {
      // Blank CLAUDE_MODEL: ANTHROPIC_MODEL decides.
      expect(await aliasReplaces({ CLAUDE_MODEL: "  ", ANTHROPIC_MODEL: "opus[1m]" })).toBe(true);
      expect(await aliasReplaces({ CLAUDE_MODEL: "  ", ANTHROPIC_MODEL: "deepseek-chat" })).toBe(false);
      // Both blank: the tier defaults decide.
      expect(await aliasReplaces({ CLAUDE_MODEL: "", ANTHROPIC_MODEL: " ", ANTHROPIC_DEFAULT_OPUS_MODEL: "opus[1m]" })).toBe(true);
      expect(await aliasReplaces({ CLAUDE_MODEL: "", ANTHROPIC_MODEL: " ", ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5" })).toBe(false);
      // A blank native default is skipped for the next one of the same tier.
      expect(await aliasReplaces({ CLAUDE_CODE_BEDROCK_OPUS_MODEL: " ", ANTHROPIC_DEFAULT_OPUS_MODEL: "opus" })).toBe(true);
      expect(await aliasReplaces({ CLAUDE_CODE_BEDROCK_OPUS_MODEL: " ", ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5" })).toBe(false);
      // Nothing set at all: a Claude provider.
      expect(await aliasReplaces({ CLAUDE_CODE_BEDROCK_OPUS_MODEL: "", ANTHROPIC_DEFAULT_SONNET_MODEL: "  " })).toBe(true);
    }, 60000);

    it("a session model decides alone: tier defaults are not read next to it", async () => {
      expect(await aliasReplaces({ ANTHROPIC_MODEL: "opus[1m]", CLAUDE_CODE_BEDROCK_OPUS_MODEL: "global.anthropic.claude-opus-4-6-v1:0" })).toBe(true);
      expect(await aliasReplaces({ ANTHROPIC_MODEL: "deepseek-chat", ANTHROPIC_DEFAULT_OPUS_MODEL: "opus" })).toBe(false);
    }, 30000);

    // The mapping of the tier Jev picked (sonnet) is judged with the same provider context as the
    // gate: a tier default alone that makes the provider non-Claude is also a valid mapping.
    it.each([
      ["a plain name in ANTHROPIC_DEFAULT_SONNET_MODEL alone", { ANTHROPIC_DEFAULT_SONNET_MODEL: "other-proxy-model" }, true],
      ["a suffixed plain name in ANTHROPIC_DEFAULT_SONNET_MODEL alone", { ANTHROPIC_DEFAULT_SONNET_MODEL: " other-proxy-model[1m] " }, true],
      ["a plain name in CLAUDE_CODE_BEDROCK_SONNET_MODEL alone (not a provider ID)", { CLAUDE_CODE_BEDROCK_SONNET_MODEL: "other-proxy-model" }, false],
      ["a plain name in the default of another tier only", { ANTHROPIC_DEFAULT_OPUS_MODEL: "other-proxy-model" }, false],
      ["a blank sonnet default and a plain name for opus", { ANTHROPIC_DEFAULT_SONNET_MODEL: " ", ANTHROPIC_DEFAULT_OPUS_MODEL: "other-proxy-model" }, false],
      ["a Claude name in ANTHROPIC_DEFAULT_SONNET_MODEL alone (Claude provider)", { ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-5" }, true],
      ["a plain sonnet default next to a session alias (Claude provider)", { ANTHROPIC_MODEL: "sonnet", ANTHROPIC_DEFAULT_SONNET_MODEL: "other-proxy-model" }, true],
      ["a plain sonnet default next to a non-Claude session model", { ANTHROPIC_MODEL: "deepseek-chat", ANTHROPIC_DEFAULT_SONNET_MODEL: "other-proxy-model" }, true],
      ["OMC_SUBAGENT_MODEL next to a plain sonnet default", { OMC_SUBAGENT_MODEL: "global.anthropic.claude-sonnet-4-6", ANTHROPIC_DEFAULT_SONNET_MODEL: "other-proxy-model" }, true],
    ])("mapping judged in the gate's context: %s", async (_label, env, replaced) => {
      const input = agentInput({ model: "fable" });
      const routed = await routedInput(input, { ...NAMED, ...env });
      expect(routed).toEqual(replaced ? { ...input.tool_input, model: "sonnet", effort: "medium" } : { ...input.tool_input, effort: "medium" });
    }, 15000);

    // A choice that is not a tier name must leave only the model field as it was: the effort score of
    // the same answer still applies, under every gate that looks the choice up.
    it.each(["constructor", "__proto__", "CONSTRUCTOR", "hasownproperty", "gpt-5", "", " sonnet", "sonnet "])(
      "a malformed model choice (%j) leaves the model and still sets the effort, in every provider gate",
      async (choice) => {
        answers = { ...ANSWERS, "model-tier": { type: "choice", choice, confidence: 0.9 } };
        const gates: NodeJS.ProcessEnv[] = [
          { ANTHROPIC_BASE_URL: "http://proxy.example.invalid/v1" },
          { OMC_ROUTING_FORCE_INHERIT: "true", CLAUDE_CODE_USE_BEDROCK: "1" },
          { ANTHROPIC_DEFAULT_OPUS_MODEL: "other-proxy-model" },
          {},
        ];
        // The name comes from a definition: a call of its own model is denied under forceInherit by a gate that is not under test.
        writeAgent(projectAgents(), "proxy-agent", "model: deepseek-chat\n");
        for (const gate of gates) {
          const input = agentInput({ subagent_type: "proxy-agent" });
          expect(await routedInput(input, { ...NAMED, ...gate }), JSON.stringify(gate)).toEqual({ ...input.tool_input, effort: "medium" });
        }
        const unpinned = agentInput();
        const forceInherit = { OMC_JEV_MODEL_ROUTING_ALL_AGENTS: "1", OMC_ROUTING_FORCE_INHERIT: "true", CLAUDE_CODE_USE_BEDROCK: "1" };
        expect(await routedInput(unpinned, forceInherit)).toEqual({ ...unpinned.tool_input, effort: "medium" });
      },
      60000,
    );

    // A provider found from a model value (a tier default, or a padded or suffixed session model) is
    // Bedrock or Vertex as much as one found from a flag: a plain Anthropic default is then no mapping
    // for the bare alias, as the proxy mapping rule is for other providers only.
    const PLAIN_SONNET = { ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5" };
    it.each([
      ["a Bedrock ID in CLAUDE_CODE_BEDROCK_OPUS_MODEL", { CLAUDE_CODE_BEDROCK_OPUS_MODEL: "global.anthropic.claude-opus-4-6-v1:0" }],
      ["a Bedrock ID in ANTHROPIC_DEFAULT_HAIKU_MODEL", { ANTHROPIC_DEFAULT_HAIKU_MODEL: "us.anthropic.claude-haiku-4-5-v1:0" }],
      ["a padded upper-case Bedrock ID in ANTHROPIC_DEFAULT_FABLE_MODEL", { ANTHROPIC_DEFAULT_FABLE_MODEL: " US.ANTHROPIC.CLAUDE-FABLE-5-V1:0 " }],
      ["a suffixed Bedrock ID in CLAUDE_CODE_BEDROCK_HAIKU_MODEL", { CLAUDE_CODE_BEDROCK_HAIKU_MODEL: "anthropic.claude-3-haiku-20240307-v1:0[1m]" }],
      ["a Vertex ID in ANTHROPIC_DEFAULT_OPUS_MODEL", { ANTHROPIC_DEFAULT_OPUS_MODEL: "vertex_ai/claude-opus-4-6" }],
      ["a Vertex ID in CLAUDE_CODE_BEDROCK_FABLE_MODEL", { CLAUDE_CODE_BEDROCK_FABLE_MODEL: "VERTEX_AI/claude-fable-5" }],
      ["a padded Bedrock ID as the session model", { ANTHROPIC_MODEL: " global.anthropic.claude-opus-4-6-v1:0 " }],
      ["a suffixed Bedrock ID as the session model", { CLAUDE_MODEL: "global.anthropic.claude-opus-4-6-v1:0[1m]" }],
      ["a padded Vertex ID as the session model", { ANTHROPIC_MODEL: " vertex_ai/claude-opus-4-6 " }],
    ])("%s: a plain sonnet default is no mapping, the name stays and the effort is set", async (_label, env) => {
      const input = agentInput({ model: "fable" });
      expect(await routedInput(input, { ...NAMED, ...PLAIN_SONNET, ...env })).toEqual({ ...input.tool_input, effort: "medium" });
      expect(requests).toHaveLength(1);
    }, 15000);

    it("the same provider found from a tier default does accept a mapping that is provider-specific", async () => {
      const input = agentInput({ model: "fable" });
      const env = { CLAUDE_CODE_BEDROCK_OPUS_MODEL: "global.anthropic.claude-opus-4-6-v1:0", ANTHROPIC_DEFAULT_SONNET_MODEL: "global.anthropic.claude-sonnet-4-6" };
      expect(await routedInput(input, { ...NAMED, ...env })).toEqual({ ...input.tool_input, model: "sonnet", effort: "medium" });
    }, 15000);

    it("a plain default next to a plain non-Claude default is still a proxy mapping: the alias is set", async () => {
      const input = agentInput({ model: "fable" });
      const env = { ANTHROPIC_DEFAULT_OPUS_MODEL: "other-proxy-model", ...PLAIN_SONNET };
      expect(await routedInput(input, { ...NAMED, ...env })).toEqual({ ...input.tool_input, model: "sonnet", effort: "medium" });
    }, 15000);

    // The whole table of the named-model gate: every source of the provider and of the tier mapping
    // against the decision (true: Jev's alias replaces the named model; false: the name stays and only
    // the effort is set). Jev answers sonnet. Sources read: the Bedrock and Vertex flags, the base URL,
    // CLAUDE_MODEL, ANTHROPIC_MODEL, the native defaults of the four tiers and forceInherit. Not read, as
    // in src/config/models.ts: OMC_MODEL_*, and a Foundry flag. The first non-blank native default of
    // the sonnet tier is the mapping: when it is unusable, a later one is not looked at.
    const BEDROCK_ID = "global.anthropic.claude-sonnet-4-6";
    const OPUS_BEDROCK_ID = "global.anthropic.claude-opus-4-6-v1:0";
    const FLAG = { CLAUDE_CODE_USE_BEDROCK: "1" };
    const PROXY = { ANTHROPIC_BASE_URL: "http://proxy.example.invalid/v1" };
    const FORCE = { OMC_ROUTING_FORCE_INHERIT: "true" };
    const GATE_TABLE: [string, NodeJS.ProcessEnv, boolean][] = [
      ["nothing set", {}, true],
      ["Anthropic base URL", { ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, true],
      ["Bedrock flag", FLAG, false],
      ["Bedrock flag, native mapping in the Bedrock variable", { ...FLAG, CLAUDE_CODE_BEDROCK_SONNET_MODEL: BEDROCK_ID }, true],
      ["Bedrock flag, native mapping in the default variable", { ...FLAG, ANTHROPIC_DEFAULT_SONNET_MODEL: BEDROCK_ID }, true],
      ["Bedrock flag, unusable winner and a usable later default", { ...FLAG, CLAUDE_CODE_BEDROCK_SONNET_MODEL: "other-proxy-model", ANTHROPIC_DEFAULT_SONNET_MODEL: BEDROCK_ID }, false],
      ["Bedrock flag, usable winner and a plain later default", { ...FLAG, CLAUDE_CODE_BEDROCK_SONNET_MODEL: BEDROCK_ID, ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5" }, true],
      ["Bedrock flag, blank winner and a usable later default", { ...FLAG, CLAUDE_CODE_BEDROCK_SONNET_MODEL: " ", ANTHROPIC_DEFAULT_SONNET_MODEL: BEDROCK_ID }, true],
      ["Bedrock flag, blank winner and a plain later default", { ...FLAG, CLAUDE_CODE_BEDROCK_SONNET_MODEL: " ", ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5" }, false],
      ["Bedrock flag, only OMC_SUBAGENT_MODEL", { ...FLAG, OMC_SUBAGENT_MODEL: BEDROCK_ID }, false],
      ["Bedrock flag, OMC_SUBAGENT_MODEL and a plain default", { ...FLAG, OMC_SUBAGENT_MODEL: BEDROCK_ID, ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5" }, false],
      ["Vertex flag", { CLAUDE_CODE_USE_VERTEX: "1" }, false],
      ["Vertex flag, Vertex mapping", { CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_DEFAULT_SONNET_MODEL: "vertex_ai/claude-sonnet-4-6" }, true],
      ["Vertex flag, plain default", { CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5" }, false],
      ["foreign base URL", PROXY, false],
      ["foreign base URL, plain default", { ...PROXY, ANTHROPIC_DEFAULT_SONNET_MODEL: "other-proxy-model" }, true],
      ["foreign base URL, unusable winner and a plain later default", { ...PROXY, CLAUDE_CODE_BEDROCK_SONNET_MODEL: "other-proxy-model", ANTHROPIC_DEFAULT_SONNET_MODEL: "other-proxy-model" }, false],
      ["foreign base URL, plain default of another tier", { ...PROXY, ANTHROPIC_DEFAULT_OPUS_MODEL: "other-proxy-model" }, false],
      ["session alias", { CLAUDE_MODEL: "sonnet" }, true],
      ["CLAUDE_MODEL wins over ANTHROPIC_MODEL: alias over a foreign name", { CLAUDE_MODEL: "sonnet", ANTHROPIC_MODEL: "deepseek-chat" }, true],
      ["CLAUDE_MODEL wins over ANTHROPIC_MODEL: foreign name over an alias", { CLAUDE_MODEL: "deepseek-chat", ANTHROPIC_MODEL: "sonnet" }, false],
      ["blank CLAUDE_MODEL, ANTHROPIC_MODEL decides", { CLAUDE_MODEL: " ", ANTHROPIC_MODEL: "deepseek-chat" }, false],
      ["session alias hides a Bedrock tier default", { ANTHROPIC_MODEL: "opus[1m]", CLAUDE_CODE_BEDROCK_OPUS_MODEL: OPUS_BEDROCK_ID }, true],
      ["foreign session name, plain default", { ANTHROPIC_MODEL: "deepseek-chat", ANTHROPIC_DEFAULT_SONNET_MODEL: "other-proxy-model" }, true],
      ["foreign session name, no mapping", { ANTHROPIC_MODEL: "deepseek-chat", ANTHROPIC_DEFAULT_OPUS_MODEL: "opus" }, false],
      ["Bedrock session ID", { ANTHROPIC_MODEL: OPUS_BEDROCK_ID }, false],
      ["Bedrock session ID, plain default", { ANTHROPIC_MODEL: OPUS_BEDROCK_ID, ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5" }, false],
      ["Vertex session ID", { CLAUDE_MODEL: "vertex_ai/claude-opus-4-6" }, false],
      ["foreign tier default only", { ANTHROPIC_DEFAULT_OPUS_MODEL: "other-proxy-model" }, false],
      ["foreign tier default and a plain sonnet default", { ANTHROPIC_DEFAULT_OPUS_MODEL: "other-proxy-model", ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5" }, true],
      ["Bedrock ID in a tier default only", { CLAUDE_CODE_BEDROCK_OPUS_MODEL: OPUS_BEDROCK_ID }, false],
      ["Bedrock ID in a tier default, plain sonnet default", { CLAUDE_CODE_BEDROCK_OPUS_MODEL: OPUS_BEDROCK_ID, ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5" }, false],
      ["Bedrock ID in a tier default, Bedrock sonnet default", { CLAUDE_CODE_BEDROCK_OPUS_MODEL: OPUS_BEDROCK_ID, ANTHROPIC_DEFAULT_SONNET_MODEL: BEDROCK_ID }, true],
      ["Claude and alias tier defaults", { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-8", ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku[1m]" }, true],
      ["APAC Bedrock session ID", { ANTHROPIC_MODEL: "apac.anthropic.claude-sonnet-4-6-v1:0" }, false],
      ["APAC Bedrock session ID, padded and upper-case", { CLAUDE_MODEL: " APAC.ANTHROPIC.CLAUDE-SONNET-4-6-V1:0 " }, false],
      ["APAC Bedrock session ID, plain default", { ANTHROPIC_MODEL: "apac.anthropic.claude-opus-4-6-v1:0", ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5" }, false],
      ["APAC Bedrock ID in a tier default only", { CLAUDE_CODE_BEDROCK_OPUS_MODEL: "apac.anthropic.claude-opus-4-6-v1:0" }, false],
      ["APAC Bedrock ID in a tier default, plain sonnet default", { ANTHROPIC_DEFAULT_OPUS_MODEL: "apac.anthropic.claude-opus-4-6-v1:0", ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5" }, false],
      ["Bedrock flag, APAC mapping", { ...FLAG, ANTHROPIC_DEFAULT_SONNET_MODEL: "apac.anthropic.claude-sonnet-4-6-v1:0" }, true],
      ["Bedrock flag, APAC mapping in the Bedrock variable", { ...FLAG, CLAUDE_CODE_BEDROCK_SONNET_MODEL: "apac.anthropic.claude-sonnet-4-6-v1:0" }, true],
      ["Bedrock flag, Vertex mapping in the default variable", { ...FLAG, ANTHROPIC_DEFAULT_SONNET_MODEL: "vertex_ai/claude-sonnet-4-6" }, false],
      ["Bedrock flag, Vertex mapping in the Bedrock variable", { ...FLAG, CLAUDE_CODE_BEDROCK_SONNET_MODEL: "VERTEX_AI/claude-sonnet-4-6" }, false],
      ["Vertex flag, Bedrock mapping", { CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_DEFAULT_SONNET_MODEL: BEDROCK_ID }, false],
      ["Vertex flag, APAC Bedrock mapping", { CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_BEDROCK_SONNET_MODEL: "apac.anthropic.claude-sonnet-4-6-v1:0" }, false],
      ["Vertex flag, Bedrock ARN mapping", { CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_DEFAULT_SONNET_MODEL: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6-v1:0" }, false],
      ["both flags, Vertex mapping", { ...FLAG, CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_DEFAULT_SONNET_MODEL: "vertex_ai/claude-sonnet-4-6" }, true],
      ["both flags, Bedrock mapping", { ...FLAG, CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_DEFAULT_SONNET_MODEL: BEDROCK_ID }, true],
      ["Bedrock session ID, Vertex mapping", { ANTHROPIC_MODEL: OPUS_BEDROCK_ID, ANTHROPIC_DEFAULT_SONNET_MODEL: "vertex_ai/claude-sonnet-4-6" }, false],
      ["Vertex session ID, Bedrock mapping", { CLAUDE_MODEL: "vertex_ai/claude-opus-4-6", ANTHROPIC_DEFAULT_SONNET_MODEL: BEDROCK_ID }, false],
      ["Vertex session ID, Vertex mapping", { CLAUDE_MODEL: "vertex_ai/claude-opus-4-6", ANTHROPIC_DEFAULT_SONNET_MODEL: "vertex_ai/claude-sonnet-4-6" }, true],
      ["Bedrock ID in a tier default, Vertex mapping of the tier: no flag names the provider, the mapping decides", { CLAUDE_CODE_BEDROCK_OPUS_MODEL: OPUS_BEDROCK_ID, ANTHROPIC_DEFAULT_SONNET_MODEL: "vertex_ai/claude-sonnet-4-6" }, true],
      ["forceInherit without a cloud flag, Vertex mapping", { ...FORCE, ANTHROPIC_DEFAULT_SONNET_MODEL: "vertex_ai/claude-sonnet-4-6" }, true],
      ["padded Vertex session ID, Bedrock mapping", { ANTHROPIC_MODEL: " vertex_ai/claude-opus-4-6 ", ANTHROPIC_DEFAULT_SONNET_MODEL: BEDROCK_ID }, false],
      ["upper-case suffixed Vertex session ID, Bedrock mapping", { CLAUDE_MODEL: "VERTEX_AI/claude-opus-4-6[1m]", CLAUDE_CODE_BEDROCK_SONNET_MODEL: BEDROCK_ID }, false],
      ["blank CLAUDE_MODEL, Vertex ANTHROPIC_MODEL, Bedrock mapping", { CLAUDE_MODEL: "  ", ANTHROPIC_MODEL: "vertex_ai/claude-opus-4-6", ANTHROPIC_DEFAULT_SONNET_MODEL: BEDROCK_ID }, false],
      ["padded Bedrock session ID, Vertex mapping", { ANTHROPIC_MODEL: " " + OPUS_BEDROCK_ID + " ", ANTHROPIC_DEFAULT_SONNET_MODEL: "vertex_ai/claude-sonnet-4-6" }, false],
      ["suffixed APAC Bedrock session ID, Vertex mapping", { CLAUDE_MODEL: "apac.anthropic.claude-opus-4-6-v1:0[1m]", ANTHROPIC_DEFAULT_SONNET_MODEL: "vertex_ai/claude-sonnet-4-6" }, false],
      ["padded Vertex session ID, Vertex mapping", { ANTHROPIC_MODEL: " vertex_ai/claude-opus-4-6 ", ANTHROPIC_DEFAULT_SONNET_MODEL: "vertex_ai/claude-sonnet-4-6" }, true],
      ["blank CLAUDE_MODEL, Bedrock ANTHROPIC_MODEL, Bedrock mapping", { CLAUDE_MODEL: " ", ANTHROPIC_MODEL: OPUS_BEDROCK_ID, ANTHROPIC_DEFAULT_SONNET_MODEL: BEDROCK_ID }, true],
      ["session alias, flag-less, Vertex mapping: no cloud is named", { ANTHROPIC_MODEL: " opus[1m] ", ANTHROPIC_DEFAULT_SONNET_MODEL: "vertex_ai/claude-sonnet-4-6" }, true],
      ["forceInherit alone", FORCE, false],
      ["forceInherit, plain default of a Claude provider", { ...FORCE, ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-5" }, false],
      ["forceInherit, session alias, plain default", { ...FORCE, ANTHROPIC_MODEL: "sonnet", ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-5" }, false],
      ["forceInherit, native mapping", { ...FORCE, ANTHROPIC_DEFAULT_SONNET_MODEL: BEDROCK_ID }, true],
      ["forceInherit, foreign base URL and a plain default", { ...FORCE, ...PROXY, ANTHROPIC_DEFAULT_SONNET_MODEL: "other-proxy-model" }, true],
      ["forceInherit, only OMC_SUBAGENT_MODEL", { ...FORCE, OMC_SUBAGENT_MODEL: BEDROCK_ID }, false],
      ["OMC_MODEL_MEDIUM is not read", { OMC_MODEL_MEDIUM: "deepseek-chat" }, true],
      ["a Foundry flag is not read", { CLAUDE_CODE_USE_FOUNDRY: "1" }, true],
      // #5131: a flag set to true (any case, padded) names the provider like 1.
      ["Bedrock flag true", { CLAUDE_CODE_USE_BEDROCK: "true" }, false],
      ["Bedrock flag padded upper-case TRUE", { CLAUDE_CODE_USE_BEDROCK: " TRUE " }, false],
      ["Bedrock flag true, native mapping", { CLAUDE_CODE_USE_BEDROCK: "true", ANTHROPIC_DEFAULT_SONNET_MODEL: BEDROCK_ID }, true],
      ["Vertex flag true", { CLAUDE_CODE_USE_VERTEX: "true" }, false],
      ["Vertex flag padded upper-case TRUE", { CLAUDE_CODE_USE_VERTEX: " TRUE " }, false],
      ["Vertex flag true, Bedrock mapping", { CLAUDE_CODE_USE_VERTEX: "true", ANTHROPIC_DEFAULT_SONNET_MODEL: BEDROCK_ID }, false],
      ["Bedrock flag false is not a flag", { CLAUDE_CODE_USE_BEDROCK: "false" }, true],
      ["Vertex flag 0 is not a flag", { CLAUDE_CODE_USE_VERTEX: "0" }, true],
    ];
    it.each(GATE_TABLE)("gate table: %s", async (_label, env, replaced) => {
      // The name comes from a definition: a call that names a model of its own is denied under forceInherit by another gate.
      writeAgent(projectAgents(), "table-agent", "model: deepseek-chat\n");
      const input = agentInput({ subagent_type: "table-agent" });
      const routed = await routedInput(input, { ...NAMED, ...env });
      expect(requests).toHaveLength(1);
      expect(routed).toEqual(replaced ? { ...input.tool_input, model: "sonnet", effort: "medium" } : { ...input.tool_input, effort: "medium" });
    }, 15000);

    it("a session model that is not a Claude name still keeps the named model", async () => {
      const input = agentInput({ model: "fable" });
      expect(await routedInput(input, { ...NAMED, ANTHROPIC_MODEL: "deepseek-chat" })).toEqual({ ...input.tool_input, effort: "medium" });
      expect(requests).toHaveLength(1);
    }, 15000);

    it("the definition that wins by name decides, even without a model: a user definition it shadows is not read", async () => {
      writeAgent(projectAgents(), "shadowed-agent", "description: no model here\n");
      writeAgent(userAgents(), "shadowed-agent", "model: fable\n");
      const input = agentInput({ subagent_type: "shadowed-agent" });
      expect(await routedInput(input, NAMED)).toEqual(input.tool_input);
      expect(requests).toHaveLength(0);
      // The user definition alone is asked about, as before.
      const alone = agentInput({ subagent_type: "user-only-agent" });
      writeAgent(userAgents(), "user-only-agent", "model: fable\n");
      expect(await routedInput(alone, NAMED)).toEqual({ ...alone.tool_input, model: "sonnet", effort: "medium" });
      expect(requests).toHaveLength(1);
    }, 30000);

    it("OMC_SUBAGENT_MODEL alone does not make the tier resolvable: the name stays, the effort is set", async () => {
      const only = { OMC_SUBAGENT_MODEL: "global.anthropic.claude-sonnet-4-6" };
      expect(await routedInput(call(), { ...NAMED, ...proxy, ...only })).toEqual({ ...call().tool_input, effort: "medium" });
      expect(await routedInput(call(), { ...NAMED, ...forceInherit, ...only })).toEqual({ ...call().tool_input, effort: "medium" });
      expect(requests).toHaveLength(2);
      // With the native mapping of the tier the alias is set, as before.
      const mapped = { ANTHROPIC_DEFAULT_SONNET_MODEL: "other-proxy-model" };
      expect(await routedInput(call(), { ...NAMED, ...proxy, ...only, ...mapped })).toEqual({
        ...call().tool_input,
        model: "sonnet",
        effort: "medium",
      });
      const bedrock = { CLAUDE_CODE_BEDROCK_SONNET_MODEL: "global.anthropic.claude-sonnet-4-6" };
      expect(await routedInput(call(), { ...NAMED, ...forceInherit, ...only, ...bedrock })).toEqual({
        ...call().tool_input,
        model: "sonnet",
        effort: "medium",
      });
      expect(requests).toHaveLength(4);
    }, 30000);
  });

  describe("applied log (OMC_JEV_APPLIED_LOG)", () => {
    const LOG = { ...NAMED, OMC_JEV_APPLIED_LOG: "1" };

    it("records the name the call had as the model it changed from", async () => {
      await routedInput(agentInput({ model: "claude-fable-5" }), LOG);
      writeAgent(projectAgents(), "my-agent", "model: deepseek-chat\n");
      await routedInput(agentInput({ subagent_type: "my-agent" }), LOG);
      await waitFor(() => {
        const lines = readLog("applied.jsonl").filter((line) => line.point === "model-routing");
        expect(lines.map((line) => line.applied.model)).toEqual([
          { from: "claude-fable-5", to: "sonnet" },
          { from: "deepseek-chat", to: "sonnet" },
        ]);
      });
    }, 30000);

    it("records no model change when the provider check keeps the name", async () => {
      writeAgent(projectAgents(), "my-agent", "model: deepseek-chat\n");
      await routedInput(agentInput({ subagent_type: "my-agent" }), {
        ...LOG,
        ANTHROPIC_BASE_URL: "http://proxy.example.invalid/v1",
      });
      await waitFor(() => {
        const lines = readLog("applied.jsonl").filter((line) => line.point === "model-routing");
        expect(lines).toHaveLength(1);
        expect(lines[0].applied.model).toBeUndefined();
        expect(lines[0].applied.effort).toMatchObject({ from: null, to: "medium" });
      });
    }, 15000);
  });
});
