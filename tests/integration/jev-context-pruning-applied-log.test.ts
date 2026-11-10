/**
 * Context pruning applied-log tests: real post-tool-verifier.mjs subprocess
 * against a mock Jev endpoint. Covers the critical and cooldown branches
 * that emit applied-log rows (line 645, 651 in post-tool-verifier.mjs).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const API_KEY = "test-key-123";

type WireBody = { state: Record<string, unknown>; questions: Record<string, unknown> };

// Mock Jev answers: stale context (score 3 triggers critical then suppressed)
const STALE_ANSWER = {
  staleness: { type: "score", score: 3, confidence: 0.8 },
};

function runVerifier(input: Record<string, unknown>, env: NodeJS.ProcessEnv, cwd: string) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(PROJECT_ROOT, "scripts", "post-tool-verifier.mjs")], {
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

describe("post-tool-verifier.mjs: context-pruning applied-log (critical and cooldown)", () => {
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  let server: Server;
  let requests: WireBody[] = [];

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "jev-context-pruning-"));
    requests = [];
    server = createServer((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        raw += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(raw) as WireBody);
        response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
        response.end(JSON.stringify({ answers: STALE_ANSWER }));
      });
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
      OMC_JEV: "context-pruning:active",
      OMC_JEV_APPLIED_LOG: "1",
      OMC_JEV_LOG_DIR: join(cwd, "jev-logs"),
    };
  });

  afterEach(() => {
    server.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("writes applied row when stale context triggers critical", async () => {
    const input = {
      tool_name: "Read",
      tool_response: "A retained tool result with useful context.\nMore content.",
      cwd,
      session_id: "test-session",
      permission_mode: "normal" as const,
      context_window: { used_percentage: 80 },
    };

    const result = await runVerifier(input, env, cwd);
    expect(result.exitCode).toBe(0);

    // Check that applied log exists and contains the context-pruning entry with critical message
    const appliedPath = join(cwd, "jev-logs", "applied.jsonl");
    const lines = readFileSync(appliedPath, "utf-8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);

    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.point).toBe("context-pruning");
    expect(entry.applied.message).toBe("critical");
    expect(entry.applied.staleness).toBe("stale");
  });

  it("writes suppressed row when cooldown prevents second critical", async () => {
    // First call triggers critical
    const input1 = {
      tool_name: "Read",
      tool_response: "A retained tool result with useful context.\nMore content.",
      cwd,
      session_id: "test-session",
      permission_mode: "normal" as const,
      context_window: { used_percentage: 80 },
    };

    const result1 = await runVerifier(input1, env, cwd);
    expect(result1.exitCode).toBe(0);

    // Second call within cooldown should be suppressed
    const input2 = {
      tool_name: "Read",
      tool_response: "Another tool result.",
      cwd,
      session_id: "test-session",
      permission_mode: "normal" as const,
      context_window: { used_percentage: 80 },
    };

    const result2 = await runVerifier(input2, env, cwd);
    expect(result2.exitCode).toBe(0);

    // Check that both rows exist: first critical, second suppressed
    const appliedPath = join(cwd, "jev-logs", "applied.jsonl");
    const lines = readFileSync(appliedPath, "utf-8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const [first, second] = [lines[0], lines[1]].map((l) => JSON.parse(l));
    expect(first.applied.message).toBe("critical");
    expect(first.applied.staleness).toBe("stale");
    expect(second.applied.message).toBe("suppressed");
    expect(second.applied.staleness).toBe("stale");
  });
});
