/**
 * jev-shadow spawn failure tests: real pre-tool-enforcer.mjs subprocess.
 * Tests the resolver-spawn degraded log entry when a resolver cannot be started.
 * A preload in the hook process makes spawnSync of jev-resolve.mjs return a
 * non-timeout error (EACCES), the branch recordResolverFailure maps to "resolver-spawn".
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  let preload: string;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "jev-spawn-failure-"));
    // Runs in the hook process before its modules load: spawning the resolver fails
    // with EACCES (not ETIMEDOUT), every other spawnSync call goes through.
    preload = join(cwd, "spawn-error.cjs");
    writeFileSync(
      preload,
      [
        "const cp = require('node:child_process');",
        "const real = cp.spawnSync;",
        "cp.spawnSync = function (file, args, options) {",
        "  if (Array.isArray(args) && args.some((a) => String(a).endsWith('jev-resolve.mjs'))) {",
        "    return { error: Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }), status: null, signal: null, stdout: '', stderr: '', pid: 0, output: null };",
        "  }",
        "  return real.apply(this, arguments);",
        "};",
      ].join("\n"),
    );
    env = {
      ...process.env,
      TYPESAFE_API_KEY: API_KEY,
      OMC_JEV_ENDPOINT: "http://127.0.0.1:1",
      NODE_OPTIONS: `--require ${preload.replace(/\\/g, "/")}`,
      OMC_JEV: "model-routing:active",
      OMC_JEV_LOG_CONTEXT: "1",
      OMC_JEV_LOG_DIR: join(cwd, "jev-logs"),
      OMC_JEV_TIMEOUT_MS: "500",
    };
  });

  afterEach(() => {
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
    const lines = existsSync(shadowPath)
      ? readFileSync(shadowPath, "utf-8").trim().split("\n").filter(Boolean)
      : [];
    
    const degraded = lines.find((line) => {
      const entry = JSON.parse(line);
      return entry.mode === "degraded" && entry.reason === "resolver-spawn";
    });

    expect(degraded).toBeUndefined(); // No logging when context logging disabled
  });
});
