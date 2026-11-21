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
