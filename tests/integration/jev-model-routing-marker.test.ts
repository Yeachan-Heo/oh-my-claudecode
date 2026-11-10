/**
 * model-routing `use` marker: real pre-tool-enforcer.mjs subprocess against a
 * mock Jev endpoint. With OMC_JEV_MODEL_ROUTING_MARKER=1 the first line of a
 * Task/Agent prompt (`use <model>`, `use <model> <effort>`, `use <effort>`)
 * pins the model and the effort in place of Jev's answer, and is removed from
 * the prompt. Without the variable the hook behaves exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const API_KEY = "test-key-123";
const TASK = "Find why src/auth/session.test.ts fails intermittently and fix it.";

// Jev's answers: opus and a score of 1 (medium), different from every marker used below.
const ANSWERS = {
  "model-tier": { type: "choice", choice: "opus", confidence: 0.9 },
  effort: { type: "score", score: 1, confidence: 0.7 },
};

// Keep the test's event loop free: the hook's synchronous Jev child must be
// able to POST to the HTTP server running in this process.
// The hook runs with the repository as its working directory, not the temporary one: a detached
// shadow-mode resolver would otherwise keep the directory busy and make the cleanup fail on Windows.
// The call's own directory travels in the hook input (`cwd`).
function runEnforcer(input: Record<string, unknown>, env: NodeJS.ProcessEnv) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(PROJECT_ROOT, "scripts", "pre-tool-enforcer.mjs")], {
      cwd: PROJECT_ROOT,
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

describe("pre-tool-enforcer.mjs: model-routing use marker", () => {
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  let server: Server;
  let requests: Array<{ state: Record<string, unknown>; questions: Record<string, unknown> }>;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "jev-marker-"));
    requests = [];
    server = createServer((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        raw += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(raw));
        response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
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
      OMC_JEV_MODEL_ROUTING_MARKER: "1",
    };
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  function agentInput(prompt: string, extra: Record<string, unknown> = {}, toolName = "Agent") {
    return {
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: {
        description: "Trace the flaky auth test",
        prompt,
        subagent_type: "general-purpose",
        model: "haiku",
        ...extra,
      },
      cwd,
      session_id: "test-sess-marker",
    };
  }

  /** The tool input Claude Code would run: updatedInput when present, else the original. */
  async function routedInput(input: ReturnType<typeof agentInput>, extraEnv: NodeJS.ProcessEnv = {}) {
    const result = await runEnforcer(input, { ...env, ...extraEnv });
    expect(result.exitCode, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.continue).toBe(true);
    return (output.hookSpecificOutput?.updatedInput ?? input.tool_input) as Record<string, unknown>;
  }

  function overrideRows() {
    const file = join(cwd, "jev-logs", "overrides.jsonl");
    return existsSync(file)
      ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      : [];
  }

  it("leaves everything as it was without the variable: the line stays and Jev decides", async () => {
    const routed = await routedInput(agentInput(`use sonnet low\n\n${TASK}`), { OMC_JEV_MODEL_ROUTING_MARKER: "" });
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0].questions)).toEqual(["model-tier", "effort"]);
    expect(routed).toEqual({ ...agentInput(`use sonnet low\n\n${TASK}`).tool_input, model: "opus", effort: "medium" });
    expect(overrideRows()).toEqual([]);
  }, 15000);

  it.each(["0", "no"])("stays off for OMC_JEV_MODEL_ROUTING_MARKER=%j", async (value) => {
    const routed = await routedInput(agentInput(`use sonnet low\n${TASK}`), { OMC_JEV_MODEL_ROUTING_MARKER: value });
    expect(routed.prompt).toBe(`use sonnet low\n${TASK}`);
    expect(overrideRows()).toEqual([]);
  }, 15000);

  it.each(["1", "true", " TRUE "])("accepts OMC_JEV_MODEL_ROUTING_MARKER=%j", async (value) => {
    const routed = await routedInput(agentInput(`use sonnet low\n${TASK}`), { OMC_JEV_MODEL_ROUTING_MARKER: value });
    expect(routed.model).toBe("sonnet");
  }, 15000);

  it("pins model and effort, removes the line and its blank line, and sends nothing to Jev", async () => {
    const routed = await routedInput(agentInput(`use sonnet low\n\n${TASK}\nSecond line.`));
    expect(requests).toHaveLength(0);
    expect(routed).toEqual({
      description: "Trace the flaky auth test",
      prompt: `${TASK}\nSecond line.`,
      subagent_type: "general-purpose",
      model: "sonnet",
      effort: "low",
    });
  }, 15000);

  it("removes the line without a blank line after it, and works for the Task tool", async () => {
    const routed = await routedInput(agentInput(`use opus high\n${TASK}`, {}, "Task"));
    expect(routed.prompt).toBe(TASK);
    expect(routed.model).toBe("opus");
    expect(routed.effort).toBe("high");
  }, 15000);

  it("ignores case and surrounding spaces, and removes the empty lines before the line too", async () => {
    const routed = await routedInput(agentInput(`\n\n   USE  Opus   XHigh  \r\n\r\n${TASK}`));
    expect(routed.model).toBe("opus");
    expect(routed.effort).toBe("xhigh");
    expect(routed.prompt).toBe(TASK);
  }, 15000);

  it("wins over the call's own model and effort", async () => {
    const routed = await routedInput(agentInput(`use haiku medium\n${TASK}`, { model: "opus", effort: "xhigh" }));
    expect(routed.model).toBe("haiku");
    expect(routed.effort).toBe("medium");
  }, 15000);

  it("a model leaves only the effort question to Jev, and the marker model wins over Jev's choice", async () => {
    const routed = await routedInput(agentInput(`use sonnet\n${TASK}`));
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0].questions)).toEqual(["effort"]);
    expect(requests[0].state.task).toBe(TASK);
    expect(routed.model).toBe("sonnet");
    expect(routed.effort).toBe("medium");
    expect(routed.prompt).toBe(TASK);
  }, 15000);

  it("an effort leaves only the model-tier question to Jev, and the marker effort wins over Jev's score", async () => {
    const routed = await routedInput(agentInput(`use xhigh\n${TASK}`));
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0].questions)).toEqual(["model-tier"]);
    expect(routed.model).toBe("opus");
    expect(routed.effort).toBe("xhigh");
  }, 15000);

  it.each([
    ["not on the first non-empty line", `Do this.\nuse sonnet low\n${TASK}`],
    ["with other text on the line", `use sonnet low please\n${TASK}`],
    ["with an unknown word", `use gpt\n${TASK}`],
    ["with a model after the effort", `use low sonnet\n${TASK}`],
    ["with two efforts", `use high low\n${TASK}`],
    ["bare", `use\n${TASK}`],
    ["as `use max high`", `use max high\n${TASK}`],
    ["wrapped in backticks", `\`use sonnet low\`\n${TASK}`],
  ])("a marker %s is plain text", async (_name, prompt) => {
    const routed = await routedInput(agentInput(prompt));
    expect(routed.prompt).toBe(prompt);
    expect(routed.model).toBe("opus"); // Jev decided
    expect(overrideRows()).toEqual([]);
  }, 15000);

  it("does not read the marker from the description", async () => {
    const routed = await routedInput(agentInput(TASK, { description: "use sonnet low" }));
    expect(routed.model).toBe("opus");
    expect(overrideRows()).toEqual([]);
  }, 15000);

  it("keeps a prompt that is only the marker", async () => {
    const routed = await routedInput(agentInput("use sonnet low"));
    expect(routed.model).toBe("sonnet");
    expect(routed.effort).toBe("low");
    expect(routed.prompt).toBe("use sonnet low");
  }, 15000);

  describe("max", () => {
    it("`use max` sets nothing, leaves the line, and Jev decides; the refusal is logged", async () => {
      const routed = await routedInput(agentInput(`use max\n${TASK}`));
      expect(requests).toHaveLength(1);
      expect(Object.keys(requests[0].questions)).toEqual(["model-tier", "effort"]);
      expect(routed).toMatchObject({ prompt: `use max\n${TASK}`, model: "opus", effort: "medium" });
      const rows = overrideRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ point: "model-routing", marker: "use max", rejected: ["max"] });
      expect(rows[0].override).toBeUndefined();
    }, 15000);

    it("`use opus max` takes the model, Jev decides the effort, the refusal is logged", async () => {
      const routed = await routedInput(agentInput(`use opus max\n${TASK}`, { model: "sonnet" }));
      expect(Object.keys(requests[0].questions)).toEqual(["effort"]);
      expect(routed).toMatchObject({ prompt: TASK, model: "opus", effort: "medium" });
      expect(overrideRows()[0]).toMatchObject({ override: "model", rejected: ["max"], marker: "use opus max" });
    }, 15000);

    it("never sets max, even with no Jev", async () => {
      const routed = await routedInput(agentInput(`use opus max\n${TASK}`), { OMC_JEV: "" });
      expect(routed.model).toBe("opus");
      expect(routed.effort).toBeUndefined();
    }, 15000);

    it("a marker effort is capped by OMC_JEV_MAX_EFFORT and the cap is logged", async () => {
      const routed = await routedInput(agentInput(`use opus xhigh\n${TASK}`), { OMC_JEV_MAX_EFFORT: "medium" });
      expect(routed.effort).toBe("medium");
      expect(overrideRows()[0].effort).toEqual({ from: null, to: "medium", capped: true, requested: "xhigh" });
    }, 15000);
  });

  describe("log", () => {
    it("writes one row per marker to overrides.jsonl, not to shadow.jsonl", async () => {
      await routedInput(agentInput(`use sonnet low\n${TASK}`, { effort: "high" }));
      const rows = overrideRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        point: "model-routing",
        session_id: "test-sess-marker",
        subagent_type: "general-purpose",
        marker: "use sonnet low",
        override: "both",
        model: { from: "haiku", to: "sonnet" },
        effort: { from: "high", to: "low" },
      });
      expect(typeof rows[0].ts).toBe("string");
      expect(rows[0]).not.toHaveProperty("rejected");
      expect(existsSync(join(cwd, "jev-logs", "shadow.jsonl"))).toBe(false);
    }, 15000);

    it("names the kind of override: model, effort or both", async () => {
      await routedInput(agentInput(`use sonnet\n${TASK}`));
      await routedInput(agentInput(`use high\n${TASK}`));
      expect(overrideRows().map((row) => row.override)).toEqual(["model", "effort"]);
    }, 30000);
  });

  describe("without Jev and in shadow mode", () => {
    it("works with the point off: no request, the row goes to the default state directory", async () => {
      const withoutLogDir = { ...env };
      delete withoutLogDir.OMC_JEV_LOG_DIR;
      const result = await runEnforcer(agentInput(`use sonnet low\n${TASK}`), { ...withoutLogDir, OMC_JEV: "off" });
      expect(result.exitCode, result.stderr).toBe(0);
      const updated = JSON.parse(result.stdout).hookSpecificOutput.updatedInput;
      expect(updated).toMatchObject({ model: "sonnet", effort: "low", prompt: TASK });
      expect(requests).toHaveLength(0);
      // OMC_STATE_DIR adds a project directory below it: find the file instead of building the path.
      const file = (readdirSync(join(cwd, ".omc"), { recursive: true }) as string[])
        .find((entry) => entry.endsWith("overrides.jsonl"));
      expect(file).toBeDefined();
      // <state root>/state/jev/overrides.jsonl, where shadow.jsonl would be
      expect(file as string).toMatch(/state[\\/]jev[\\/]overrides\.jsonl$/);
      const row = JSON.parse(readFileSync(join(cwd, ".omc", file as string), "utf8").trim());
      expect(row.override).toBe("both");
    }, 15000);

    it("works without TYPESAFE_API_KEY", async () => {
      const routed = await routedInput(agentInput(`use opus\n${TASK}`), { TYPESAFE_API_KEY: "" });
      expect(routed.model).toBe("opus");
      expect(requests).toHaveLength(0);
    }, 15000);

    it("in shadow mode the marker applies, Jev is asked the open question and changes nothing", async () => {
      const routed = await routedInput(agentInput(`use sonnet\n${TASK}`, { effort: "low" }), { OMC_JEV: "model-routing" });
      expect(routed).toMatchObject({ model: "sonnet", effort: "low", prompt: TASK });
      await waitFor(() => expect(requests).toHaveLength(1), { timeout: 5000, interval: 25 });
      expect(Object.keys(requests[0].questions)).toEqual(["effort"]);
      // Wait for the detached resolver to write its line before the directory is cleaned up.
      await waitFor(() => expect(existsSync(join(cwd, "jev-logs", "shadow.jsonl"))).toBe(true), { timeout: 5000, interval: 25 });
    }, 15000);
  });

  describe("with forceInherit", () => {
    const forceInherit = { OMC_ROUTING_FORCE_INHERIT: "true", CLAUDE_CODE_USE_BEDROCK: "1" };

    it("does not set a tier alias the provider cannot resolve, but still sets the effort", async () => {
      const routed = await routedInput(agentInput(`use sonnet low\n${TASK}`, { model: undefined }), forceInherit);
      expect(routed.model).toBeUndefined();
      expect(routed.effort).toBe("low");
      expect(routed.prompt).toBe(TASK);
      expect(overrideRows()[0]).toMatchObject({ override: "effort", rejected: ["force-inherit"] });
    }, 15000);

    it("a marker that names only a model the provider cannot resolve changes nothing and stays in the prompt", async () => {
      const prompt = `use sonnet\n${TASK}`;
      const routed = await routedInput(agentInput(prompt, { model: undefined }), forceInherit);
      expect(routed).toEqual(agentInput(prompt, { model: undefined }).tool_input);
      const rows = overrideRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ marker: "use sonnet", rejected: ["force-inherit"] });
      expect(rows[0].override).toBeUndefined();
    }, 15000);

    it("sets the alias when the provider resolves it", async () => {
      const routed = await routedInput(agentInput(`use sonnet low\n${TASK}`, { model: undefined }), {
        ...forceInherit,
        ANTHROPIC_DEFAULT_SONNET_MODEL: "global.anthropic.claude-sonnet-4-6",
      });
      expect(routed).toMatchObject({ model: "sonnet", effort: "low" });
    }, 15000);
  });

  describe("which calls Jev is asked about", () => {
    it("a call without a model: `use <model>` counts as its model, so the effort question still goes to Jev", async () => {
      const routed = await routedInput(agentInput(`use sonnet\n${TASK}`, { model: undefined }));
      expect(requests).toHaveLength(1);
      expect(Object.keys(requests[0].questions)).toEqual(["effort"]);
      expect(routed).toMatchObject({ model: "sonnet", effort: "medium", prompt: TASK });
    }, 15000);

    it("a call without a model: `use <effort>` alone sends nothing to Jev, as without the marker", async () => {
      const routed = await routedInput(agentInput(`use high\n${TASK}`, { model: undefined }));
      expect(requests).toHaveLength(0);
      expect(routed.model).toBeUndefined();
      expect(routed).toMatchObject({ effort: "high", prompt: TASK });
    }, 15000);

    it("wins over the model from agents.<name>.model in the project config", async () => {
      mkdirSync(join(cwd, ".claude"), { recursive: true });
      writeFileSync(join(cwd, ".claude", "omc.jsonc"), JSON.stringify({ agents: { executor: { model: "sonnet" } } }));
      const routed = await routedInput(
        agentInput(`use opus high\n${TASK}`, { model: undefined, subagent_type: "oh-my-claudecode:executor" }),
        { XDG_CONFIG_HOME: join(cwd, "config"), APPDATA: join(cwd, "config"), OMC_ROUTING_FORCE_INHERIT: "false" },
      );
      expect(routed).toMatchObject({ model: "opus", effort: "high", prompt: TASK });
      expect(overrideRows()[0].model).toEqual({ from: "sonnet", to: "opus" });
    }, 15000);

    it("a marker that is refused alone leaves the line in the task Jev sees", async () => {
      await routedInput(agentInput(`use max\n${TASK}`));
      expect(requests[0].state.task).toBe(`use max\n${TASK}`);
    }, 15000);
  });

  it("a prompt that is not a string is left alone", async () => {
    const input = agentInput(TASK);
    (input.tool_input as Record<string, unknown>).prompt = { text: "use sonnet low" };
    const routed = await routedInput(input);
    expect(routed.prompt).toEqual({ text: "use sonnet low" });
    expect(routed.model).toBe("opus"); // Jev decided
    expect(overrideRows()).toEqual([]);
  }, 15000);

  it.each([
    ["shadow mode", { OMC_JEV: "model-routing" }],
    ["the point off", { OMC_JEV: "off" }],
  ])("without the variable and with %s the call is passed through unchanged", async (_name, extraEnv) => {
    const input = agentInput(`use sonnet low\n${TASK}`);
    const result = await runEnforcer(input, { ...env, ...extraEnv, OMC_JEV_MODEL_ROUTING_MARKER: "" });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput?.updatedInput).toBeUndefined();
    expect(overrideRows()).toEqual([]);
  }, 15000);

  it("can pin fable, which Jev never chooses", async () => {
    const routed = await routedInput(agentInput(`use fable high\n${TASK}`));
    expect(routed).toMatchObject({ model: "fable", effort: "high", prompt: TASK });
    expect(requests).toHaveLength(0);
  }, 15000);

  it("applies to a call whose own model Jev would leave alone", async () => {
    const routed = await routedInput(agentInput(`use sonnet\n${TASK}`, { model: "fable" }), { OMC_JEV: "model-routing" });
    expect(routed.model).toBe("sonnet");
  }, 15000);
});
