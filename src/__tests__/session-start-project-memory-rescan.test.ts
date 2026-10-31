import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { detectProjectEnvironment } from "../hooks/project-memory/detector.js";

const SCRIPT_PATH = join(process.cwd(), "scripts", "session-start.mjs");
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

async function withProject(run: (projectDir: string, runHook: () => string) => Promise<void> | void) {
  const sandbox = mkdtempSync(join(tmpdir(), "omc-session-start-pm-"));
  const projectDir = join(sandbox, "project");
  mkdirSync(projectDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "probe", scripts: { test: "vitest" } }));

  const runHook = () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: projectDir,
      input: JSON.stringify({ cwd: projectDir, session_id: "sess-pm", hook_event_name: "SessionStart" }),
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: process.cwd(), CLAUDE_CONFIG_DIR: join(sandbox, "claude"), OMC_STATE_DIR: "" },
    });
    expect(result.status).toBe(0);
    return result.stdout;
  };

  try {
    await run(projectDir, runHook);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

describe("session-start with stale project memory", () => {
  it("shows stale memory without rewriting it, so hot paths and extra keys survive", () =>
    withProject(async (projectDir, runHook) => {
      const memoryPath = join(projectDir, ".omc", "project-memory.json");
      mkdirSync(join(projectDir, ".omc"), { recursive: true });
      const seeded = JSON.stringify({
        ...(await detectProjectEnvironment(projectDir)),
        lastScanned: Date.now() - TWO_DAYS_MS,
        hotPaths: [{ path: "src/keep.ts", accessCount: 7, lastAccessed: Date.now(), type: "file" }],
        probeExtraKey: "written by project_memory_write",
      });
      writeFileSync(memoryPath, seeded);

      expect(runHook()).toContain("<project-memory-context>");
      expect(readFileSync(memoryPath, "utf-8")).toBe(seeded);
    }));

  it("shows detected context on a first run without writing project memory itself", () =>
    withProject((projectDir, runHook) => {
      expect(runHook()).toContain("<project-memory-context>");
      expect(existsSync(join(projectDir, ".omc", "project-memory.json"))).toBe(false);
    }));
});
