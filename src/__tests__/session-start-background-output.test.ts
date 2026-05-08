import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const SCRIPT_PATH = join(process.cwd(), "scripts", "session-start.mjs");

describe("session-start background output isolation", () => {
  it("keeps foreground hook stdout/stderr clean when notification module writes", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "omc-session-start-bg-"));
    const projectDir = join(sandbox, "project");
    const pluginRoot = join(sandbox, "plugin");
    const notificationsDir = join(pluginRoot, "dist", "notifications");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(notificationsDir, { recursive: true });
    writeFileSync(join(pluginRoot, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(
      join(notificationsDir, "index.js"),
      `export async function notify() { console.log("BACKGROUND_STDOUT_LEAK"); console.error("BACKGROUND_STDERR_LEAK"); }\n`,
    );
    writeFileSync(
      join(notificationsDir, "reply-listener.js"),
      `export async function buildDaemonConfig() { return null; }\nexport function startReplyListener() {}\n`,
    );

    try {
      execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
      const result = spawnSync(process.execPath, [SCRIPT_PATH], {
        cwd: projectDir,
        input: JSON.stringify({ cwd: projectDir, session_id: "sess-bg-output" }),
        encoding: "utf-8",
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: pluginRoot,
          CLAUDE_CONFIG_DIR: join(sandbox, "claude"),
          OMC_NOTIFY: "1",
        },
      });

      expect(result.status).toBe(0);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(JSON.parse(result.stdout).continue).toBe(true);
      expect(result.stdout).not.toContain("BACKGROUND_STDOUT_LEAK");
      expect(result.stderr).not.toContain("BACKGROUND_STDERR_LEAK");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
