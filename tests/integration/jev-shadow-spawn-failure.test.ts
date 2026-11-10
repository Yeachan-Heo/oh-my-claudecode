/**
 * jev-shadow spawn failure tests: real pre-tool-enforcer.mjs subprocess.
 * Tests the resolver-spawn degraded log entry when a resolver cannot be started.
 * Covers the non-timeout resolver spawn failures branch (line 553 in jev-shadow.mjs).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const API_KEY = "test-key-123";

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

describe("jev-shadow: resolver spawn failure logging", () => {
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  let server: Server;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "jev-spawn-failure-"));
    server = createServer((request, response) => {
      // Simulate resolver unavailable (no resolver at this endpoint)
      response.writeHead(503, { "Content-Type": "application/json", Connection: "close" });
      response.end(JSON.stringify({ error: "Service unavailable" }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected local TCP endpoint");
    const [host, port] = [address.address, address.port];
    env = {
      ...process.env,
      TYPESAFE_API_KEY: API_KEY,
      OMC_JEV_ENDPOINT: `http://${host}:${port}`,
      OMC_JEV: "model-routing:active",
      OMC_JEV_LOG_CONTEXT: "1",
      OMC_JEV_LOG_DIR: join(cwd, "jev-logs"),
      OMC_JEV_TIMEOUT_MS: "500",
    };
  });

  afterEach(() => {
    server.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("logs degraded entry when resolver cannot be spawned", async () => {
    const input = {
      tool_name: "Task",
      tool_input: {
        subagent_type: "executor",
        prompt: "test task",
        model: "haiku",
      },
      cwd,
      session_id: "test-session",
      permission_mode: "normal" as const,
    };

    const result = await runEnforcer(input, env, cwd);
    expect(result.exitCode).toBe(0);

    // Check that shadow log exists and contains a degraded entry
    const shadowPath = join(cwd, "jev-logs", "shadow.jsonl");
    const lines = readFileSync(shadowPath, "utf-8").trim().split("\n").filter(Boolean);
    
    // Find degraded entry
    const degraded = lines.find((line) => {
      const entry = JSON.parse(line);
      return entry.mode === "degraded" && entry.reason === "resolver-spawn";
    });

    expect(degraded).toBeDefined();
    if (degraded) {
      const entry = JSON.parse(degraded);
      expect(entry.point).toBe("model-routing");
      expect(entry.reason).toBe("resolver-spawn");
      expect(entry).toHaveProperty("ts");
      expect(entry).toHaveProperty("session_id");
      expect(entry).toHaveProperty("durationMs");
      // Should NOT have answers or state
      expect(entry.answers).toBeUndefined();
      expect(entry.state).toBeUndefined();
    }
  });

  it("logs degraded entry without extra fields when context logging disabled", async () => {
    const envNoContext = {
      ...env,
      OMC_JEV_LOG_CONTEXT: undefined,
    };

    const input = {
      tool_name: "Task",
      tool_input: {
        subagent_type: "executor",
        prompt: "test task",
        model: "haiku",
      },
      cwd,
      session_id: "test-session",
      permission_mode: "normal" as const,
    };

    const result = await runEnforcer(input, envNoContext, cwd);
    expect(result.exitCode).toBe(0);

    const shadowPath = join(cwd, "jev-logs", "shadow.jsonl");
    const lines = readFileSync(shadowPath, "utf-8").trim().split("\n").filter(Boolean);
    
    const degraded = lines.find((line) => {
      const entry = JSON.parse(line);
      return entry.mode === "degraded" && entry.reason === "resolver-spawn";
    });

    expect(degraded).toBeUndefined(); // No logging when context logging disabled
  });
});
