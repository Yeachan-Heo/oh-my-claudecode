import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const HOOK_SCRIPTS: Array<[string, string]> = [
  ["plugin", join(__dirname, "..", "..", "scripts", "session-start.mjs")],
  [
    "template",
    join(__dirname, "..", "..", "templates", "hooks", "session-start.mjs"),
  ],
];
const TRUNCATION_NOTICE = "[truncated to preserve SessionStart context budget]";
const SENTINEL = "END-OF-PRIORITY-CONTEXT-SENTINEL";

function runHook(
  script: string,
  project: string,
  home: string,
  extraEnv: Record<string, string>,
): string {
  const stdout = execFileSync(NODE, [script], {
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      source: "startup",
      session_id: "budget-env",
      cwd: project,
    }),
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OMC_NOTIFY: "0",
      ...extraEnv,
    },
    timeout: 15000,
  });
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  return parsed.hookSpecificOutput?.additionalContext || "";
}

describe.each(HOOK_SCRIPTS)(
  "%s session-start.mjs honors OMC_SESSION_START_CONTEXT_BUDGET",
  (_label, script) => {
    let root: string;
    let project: string;
    let home: string;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "omc-budget-env-"));
      project = join(root, "project");
      home = join(root, "home");
      mkdirSync(join(project, ".omc"), { recursive: true });
      mkdirSync(home, { recursive: true });
      execFileSync("git", ["init", "--quiet"], {
        cwd: project,
        stdio: "ignore",
      });
      // 7,000 chars of Priority Context: over the default 6,000-char aggregate budget on its own.
      writeFileSync(
        join(project, ".omc", "notepad.md"),
        `## Priority Context\n${"- keep this priority line\n".repeat(280)}${SENTINEL}\n`,
        "utf-8",
      );
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it("truncates to the 6000-char default when the variable is unset", () => {
      const context = runHook(script, project, home, {
        OMC_SESSION_START_CONTEXT_BUDGET: "",
      });
      expect(context.length).toBeLessThanOrEqual(6000);
      expect(context).toContain(TRUNCATION_NOTICE);
      expect(context).not.toContain(SENTINEL);
    });

    it("delivers the whole context when the variable raises the budget", () => {
      const context = runHook(script, project, home, {
        OMC_SESSION_START_CONTEXT_BUDGET: "20000",
      });
      expect(context).toContain(SENTINEL);
      expect(context).not.toContain(TRUNCATION_NOTICE);
    });

    it("ignores values that are not positive integers", () => {
      for (const invalid of ["abc", "0", "-500", "12.5"]) {
        const context = runHook(script, project, home, {
          OMC_SESSION_START_CONTEXT_BUDGET: invalid,
        });
        expect(context.length).toBeLessThanOrEqual(6000);
        expect(context).toContain(TRUNCATION_NOTICE);
      }
    });
  },
);
