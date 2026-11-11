/**
 * model-routing for calls without a model: real pre-tool-enforcer.mjs
 * subprocess against a mock Jev endpoint. By default Jev is asked only when
 * the call or the agent definition names haiku, sonnet or opus;
 * OMC_JEV_MODEL_ROUTING_ALL_AGENTS=1 also asks for calls with no model.
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

const ANSWERS = {
  "model-tier": { type: "choice", choice: "sonnet", confidence: 0.9 },
  effort: { type: "score", score: 1, confidence: 0.7 },
};

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

describe("pre-tool-enforcer.mjs: Jev model-routing for every agent call", () => {
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  let server: Server;
  let requests: unknown[];
  let status: number;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "jev-all-agents-"));
    requests = [];
    status = 200;
    server = createServer((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        raw += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(raw));
        response.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
        response.end(JSON.stringify({ answers: ANSWERS }));
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

  function agentInput(extra: Record<string, unknown> = {}) {
    return {
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: {
        description: "Trace the flaky auth test",
        prompt: "Find why src/auth/session.test.ts fails intermittently and fix it.",
        subagent_type: "general-purpose",
        ...extra,
      },
      cwd,
      session_id: "test-sess-all-agents",
    };
  }

  /** The tool input Claude Code would run: updatedInput when present, else the original. */
  async function routedInput(input: ReturnType<typeof agentInput>, extraEnv: NodeJS.ProcessEnv = {}) {
    const result = await runEnforcer(input, { ...env, ...extraEnv }, cwd);
    expect(result.exitCode, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.continue).toBe(true);
    return (output.hookSpecificOutput?.updatedInput ?? input.tool_input) as Record<string, unknown>;
  }

  it("does not ask Jev about a call without a model by default", async () => {
    const routed = await routedInput(agentInput());
    expect(requests).toHaveLength(0);
    expect(routed).toEqual(agentInput().tool_input);
  }, 15000);

  it.each(["1", "true", " TRUE "])(
    "asks Jev about a call without a model when OMC_JEV_MODEL_ROUTING_ALL_AGENTS=%j, and applies the answers",
    async (value) => {
      const routed = await routedInput(agentInput(), { OMC_JEV_MODEL_ROUTING_ALL_AGENTS: value });
      expect(requests).toHaveLength(1);
      expect(routed).toEqual({ ...agentInput().tool_input, model: "sonnet", effort: "medium" });
    },
    15000,
  );

  it.each(["0", "", "no"])("stays off for OMC_JEV_MODEL_ROUTING_ALL_AGENTS=%j", async (value) => {
    await routedInput(agentInput(), { OMC_JEV_MODEL_ROUTING_ALL_AGENTS: value });
    expect(requests).toHaveLength(0);
  }, 15000);

  it("treats a model of inherit like no model", async () => {
    const routed = await routedInput(agentInput({ model: "inherit" }), { OMC_JEV_MODEL_ROUTING_ALL_AGENTS: "1" });
    expect(requests).toHaveLength(1);
    expect(routed.model).toBe("sonnet");
  }, 15000);

  it("leaves a call that names fable alone", async () => {
    const routed = await routedInput(agentInput({ model: "fable" }), { OMC_JEV_MODEL_ROUTING_ALL_AGENTS: "1" });
    expect(requests).toHaveLength(0);
    expect(routed).toEqual(agentInput({ model: "fable" }).tool_input);
  }, 15000);

  it("still asks about a call that names haiku, sonnet or opus, with or without the variable", async () => {
    await routedInput(agentInput({ model: "haiku" }));
    await routedInput(agentInput({ model: "opus" }), { OMC_JEV_MODEL_ROUTING_ALL_AGENTS: "1" });
    expect(requests).toHaveLength(2);
  }, 30000);

  function writeAgent(dir: string, name: string, frontmatter: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\n${frontmatter}---\n\nYou are an agent.\n`, "utf8");
  }

  it.each([
    ["user", () => join(cwd, "claude", "agents")],
    ["project", () => join(cwd, ".claude", "agents")],
  ])("leaves a %s agent whose definition names fable alone", async (_where, dir) => {
    writeAgent(dir(), "my-agent", "model: fable\n");
    const routed = await routedInput(agentInput({ subagent_type: "my-agent" }), {
      OMC_JEV_MODEL_ROUTING_ALL_AGENTS: "1",
    });
    expect(requests).toHaveLength(0);
    expect(routed).toEqual(agentInput({ subagent_type: "my-agent" }).tool_input);
  }, 15000);

  it("asks about a user agent whose definition has no model or inherits", async () => {
    writeAgent(join(cwd, "claude", "agents"), "plain-agent", "");
    writeAgent(join(cwd, "claude", "agents"), "inheriting-agent", "model: inherit\n");
    for (const subagent_type of ["plain-agent", "inheriting-agent"]) {
      const routed = await routedInput(agentInput({ subagent_type }), { OMC_JEV_MODEL_ROUTING_ALL_AGENTS: "1" });
      expect(routed.model).toBe("sonnet");
    }
    expect(requests).toHaveLength(2);
  }, 30000);

  it("routes a provider-specific Claude model ID by its tier, with or without the variable", async () => {
    const model = "us.anthropic.claude-opus-4-6-v1:0";
    expect((await routedInput(agentInput({ model }))).model).toBe("sonnet");
    expect((await routedInput(agentInput({ model }), { OMC_JEV_MODEL_ROUTING_ALL_AGENTS: "1" })).model).toBe("sonnet");
    expect(requests).toHaveLength(2);
  }, 30000);

  describe("with forceInherit", () => {
    const forceInherit = { OMC_ROUTING_FORCE_INHERIT: "true", CLAUDE_CODE_USE_BEDROCK: "1" };

    it("sets the effort but not a tier alias the provider cannot resolve", async () => {
      const routed = await routedInput(agentInput(), { ...forceInherit, OMC_JEV_MODEL_ROUTING_ALL_AGENTS: "1" });
      expect(requests).toHaveLength(1);
      expect(routed).toEqual({ ...agentInput().tool_input, effort: "medium" });
    }, 15000);

    it("sets the tier alias when the provider resolves it", async () => {
      const routed = await routedInput(agentInput(), {
        ...forceInherit,
        OMC_JEV_MODEL_ROUTING_ALL_AGENTS: "1",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "global.anthropic.claude-sonnet-4-6",
      });
      expect(routed).toEqual({ ...agentInput().tool_input, model: "sonnet", effort: "medium" });
    }, 15000);
  });

  it("a degraded Jev call leaves a call without a model as it was", async () => {
    status = 500;
    const routed = await routedInput(agentInput(), { OMC_JEV_MODEL_ROUTING_ALL_AGENTS: "1" });
    expect(requests).toHaveLength(1);
    expect(routed).toEqual(agentInput().tool_input);
  }, 15000);

  it("shadow mode asks, keeps the input, and logs no heuristic for a call without a model", async () => {
    const input = agentInput();
    const routed = await routedInput(input, { OMC_JEV: "model-routing", OMC_JEV_MODEL_ROUTING_ALL_AGENTS: "1" });
    expect(routed).toEqual(input.tool_input);
    await waitFor(
      () => {
        const entries = readFileSync(join(cwd, "jev-logs", "shadow.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const entry = entries.find((line) => line.point === "model-routing" && line.mode === "shadow");
        expect(entry).toBeDefined();
        expect(entry.heuristic).toBeNull();
        expect(entry.jev.choice).toBe("sonnet");
      },
      { timeout: 5000, interval: 25 },
    );
  }, 15000);
});
