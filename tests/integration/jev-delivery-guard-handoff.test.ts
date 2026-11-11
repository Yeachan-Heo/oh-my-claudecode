/**
 * Jev delivery guard: the hook ID of a Task/Agent call survives the real chain
 * pre-tool-enforcer.mjs -> Jev request -> shadow.jsonl row, and computeDelivery()
 * can match that row to the agent that ran. Real hook subprocess, mock Jev endpoint.
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

type WireBody = { state: Record<string, unknown> };

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

describe("pre-tool-enforcer.mjs: hook ID to delivery figures", () => {
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  let server: Server;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "jev-handoff-"));
    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
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
    };
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  for (const toolName of ["Agent", "Task"]) {
    it(`a ${toolName} call keeps its tool_use_id in the shadow row, and computeDelivery() matches it to the agent`, async () => {
      const toolUseId = `toolu_handoff_${toolName}`;
      const result = await runEnforcer(
        {
          hook_event_name: "PreToolUse",
          tool_name: toolName,
          tool_use_id: toolUseId,
          tool_input: { description: "Trace it", prompt: "Look at the test.", subagent_type: "general-purpose", model: "haiku" },
          cwd,
          session_id: "test-sess-handoff",
        },
        env,
        cwd,
      );
      expect(result.exitCode, result.stderr).toBe(0);

      const rows = readFileSync(join(cwd, "jev-logs", "shadow.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((row) => row.point === "model-routing" && row.mode === "active");
      expect(rows).toHaveLength(1);
      expect(rows[0].tool_use_id).toBe(toolUseId);

      // The agent that ran on the chosen tier: the row is consumable by the daily figures.
      const subagents = join(cwd, "claude", "projects", "proj", "sess", "subagents");
      mkdirSync(subagents, { recursive: true });
      writeFileSync(join(subagents, `agent-${toolUseId}.meta.json`), JSON.stringify({ toolUseId, model: "sonnet" }));
      const { computeDelivery } = await import(join(PROJECT_ROOT, "scripts", "lib", "jev-delivery-guard.mjs"));
      const figures = await computeDelivery({
        logDir: join(cwd, "jev-logs"),
        configDir: join(cwd, "claude"),
        now: Date.now() + 5 * 60 * 1000, // the row is older than the settle window
        env: {},
      });
      expect(figures).toMatchObject({ decisions: 1, withAgent: 1, delivered: 1, deliveredPercent: 100 });
    }, 20000);
  }
});
