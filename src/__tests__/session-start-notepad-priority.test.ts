import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const PLUGIN_SCRIPT = join(__dirname, "..", "..", "scripts", "session-start.mjs");
const HOOK_SCRIPTS: Array<[string, string]> = [
  ["plugin", PLUGIN_SCRIPT],
  [
    "template",
    join(__dirname, "..", "..", "templates", "hooks", "session-start.mjs"),
  ],
];

// Only a line that starts with `## ` ends the Priority Context section:
// `###` subheadings and `##` inside a line are part of it.
const PRIORITY_TEXT = [
  "Release checklist for this repo.",
  "### Constraints",
  "- never run the db migration on main",
  "#### Why",
  "Use ## only for section headings in docs.",
].join("\n");
const WORKING_MEMORY_TEXT = "working memory is not priority context";

function runHook(script: string, project: string, home: string): string {
  const stdout = execFileSync(NODE, [script], {
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      source: "startup",
      session_id: "notepad-priority",
      cwd: project,
    }),
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OMC_NOTIFY: "0",
    },
    timeout: 15000,
  });
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  return parsed.hookSpecificOutput?.additionalContext || "";
}

describe("session-start.mjs notepad Priority Context", () => {
  let root: string;
  let project: string;
  let home: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omc-notepad-priority-"));
    project = join(root, "project");
    home = join(root, "home");
    mkdirSync(join(project, ".omc"), { recursive: true });
    mkdirSync(home, { recursive: true });
    execFileSync("git", ["init", "--quiet"], {
      cwd: project,
      stdio: "ignore",
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each(HOOK_SCRIPTS)(
    "%s hook injects ### subheadings and ## inside a line with the rest of the section",
    (_label, script) => {
      writeFileSync(
        join(project, ".omc", "notepad.md"),
        [
          "# Notepad",
          "<!-- Auto-managed by OMC. Manual edits preserved in MANUAL section. -->",
          "",
          "## Priority Context",
          "<!-- ALWAYS loaded. Keep under 500 chars. Critical discoveries only. -->",
          PRIORITY_TEXT,
          "",
          "## Working Memory",
          "<!-- Session notes. Auto-pruned after 7 days. -->",
          "### 2026-11-12 09:30",
          WORKING_MEMORY_TEXT,
          "",
          "## MANUAL",
          "<!-- User content. Never auto-pruned. -->",
          "",
        ].join("\n"),
        "utf-8",
      );

      const context = runHook(script, project, home);

      expect(context).toContain(PRIORITY_TEXT);
      expect(context).not.toMatch(/^#+$/m);
      expect(context).not.toContain(WORKING_MEMORY_TEXT);
    },
  );

  it("plugin hook injects nothing for an empty section that the next heading follows directly", () => {
    writeFileSync(
      join(project, ".omc", "notepad.md"),
      `## Priority Context\n## Working Memory\n### 2026-11-12 09:30\n${WORKING_MEMORY_TEXT}\n`,
      "utf-8",
    );

    const context = runHook(PLUGIN_SCRIPT, project, home);

    expect(context).not.toContain("[NOTEPAD - Priority Context]");
    expect(context).not.toContain(WORKING_MEMORY_TEXT);
  });
});
