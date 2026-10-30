import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { detectProjectEnvironment } from "../hooks/project-memory/detector.js";

const SCRIPT_PATH = join(process.cwd(), "scripts", "session-start.mjs");
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

describe("session-start with stale project memory", () => {
  it("keeps hot paths, notes, and extra keys while still showing the memory", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "omc-session-start-pm-"));
    const projectDir = join(sandbox, "project");
    mkdirSync(projectDir, { recursive: true });

    try {
      execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
      writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "probe", scripts: { test: "vitest" } }));

      const memoryPath = join(projectDir, ".omc", "project-memory.json");
      mkdirSync(join(projectDir, ".omc"), { recursive: true });
      const seeded = {
        ...(await detectProjectEnvironment(projectDir)),
        lastScanned: Date.now() - TWO_DAYS_MS,
        hotPaths: [{ path: "src/keep.ts", accessCount: 7, lastAccessed: Date.now(), type: "file" }],
        customNotes: [{ category: "probe", content: "keep me", timestamp: Date.now(), source: "manual" }],
        probeExtraKey: "written by project_memory_write",
      };
      writeFileSync(memoryPath, JSON.stringify(seeded, null, 2));

      const result = spawnSync(process.execPath, [SCRIPT_PATH], {
        cwd: projectDir,
        input: JSON.stringify({ cwd: projectDir, session_id: "sess-pm-rescan", hook_event_name: "SessionStart" }),
        encoding: "utf-8",
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: process.cwd(),
          CLAUDE_CONFIG_DIR: join(sandbox, "claude"),
          OMC_STATE_DIR: "",
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("<project-memory-context>");

      const after = JSON.parse(readFileSync(memoryPath, "utf-8"));
      expect(after.hotPaths).toEqual(seeded.hotPaths);
      expect(after.customNotes).toEqual(seeded.customNotes);
      expect(after.probeExtraKey).toBe(seeded.probeExtraKey);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("shows detected context on a first run without writing project memory itself", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "omc-session-start-pm-first-"));
    const projectDir = join(sandbox, "project");
    mkdirSync(projectDir, { recursive: true });

    try {
      execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
      writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "probe", scripts: { test: "vitest" } }));

      const result = spawnSync(process.execPath, [SCRIPT_PATH], {
        cwd: projectDir,
        input: JSON.stringify({ cwd: projectDir, session_id: "sess-pm-first", hook_event_name: "SessionStart" }),
        encoding: "utf-8",
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: process.cwd(),
          CLAUDE_CONFIG_DIR: join(sandbox, "claude"),
          OMC_STATE_DIR: "",
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("<project-memory-context>");
      expect(existsSync(join(projectDir, ".omc", "project-memory.json"))).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
