/**
 * Setup-phase drift enforcement (issue #3871).
 *
 * The shipped `skills/omc-setup/phases/*` instructions previously told the
 * setup agent to invoke skills removed in 5.0.0 (`mcp-setup`) and to persist
 * `defaultExecutionMode: "ultrawork"`. That happened because the workflow
 * registry moved under #3698 consolidation while the setup phase files were
 * not updated with it.
 *
 * This test locks the setup phases to the shipped surface so they cannot
 * drift again:
 *  - every `/oh-my-claudecode:<skill>` reference in the setup phases must
 *    resolve to a skill the plugin actually ships (`.claude-plugin/plugin.json`)
 *  - no setup phase may reference a name retired in 5.0.0 (the canonical
 *    retired list in docs/CLAUDE.md, kept byte-identical to CLAUDE.md)
 *  - no setup phase may instruct writing a retired config value
 *    (`defaultExecutionMode`), and the config keys the phases touch must be
 *    current contract keys (doctor's knownFields minus the retired one)
 *
 * Rollback boundary: delete tests/lint/setup-phases-drift.test.ts — no
 * runtime change.
 */

import { execFileSync } from "child_process";
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync, readdirSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { describe, it, expect } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "../..");
const PHASES_DIR = join(REPO_ROOT, "skills", "omc-setup", "phases");
const PHASE_FILES = [
  "01-install-claude-md.md",
  "02-configure.md",
  "03-integrations.md",
  "04-welcome.md",
] as const;

function readPhase(file: string): string {
  const path = join(PHASES_DIR, file);
  expect(existsSync(path), `missing setup phase ${file}`).toBe(true);
  return readFileSync(path, "utf-8");
}

/** Skills the plugin actually ships, from the shipped manifest. */
function shippedSkills(): Set<string> {
  const pluginJson = JSON.parse(
    readFileSync(join(REPO_ROOT, ".claude-plugin", "plugin.json"), "utf-8"),
  ) as { skills?: string[] };
  const entries = pluginJson.skills ?? [];
  expect(entries.length, "plugin.json must list skills").toBeGreaterThan(0);
  const names = new Set<string>();
  for (const dirRef of entries) {
    const directory = dirRef.replace(/^\.\//, "").replace(/\/$/, "");
    const directoryName = directory.split("/")[1];
    if (directoryName) names.add(directoryName);
    const skillPath = join(REPO_ROOT, directory, "SKILL.md");
    if (existsSync(skillPath)) {
      const match = readFileSync(skillPath, "utf-8").match(/^name:\s*([^\n]+)$/m);
      if (match?.[1]) names.add(match[1].trim());
    }
  }
  return names;
}

/**
 * Names retired in 5.0.0, parsed from the canonical retired sentence in
 * docs/CLAUDE.md (kept identical to the shipped CLAUDE.md by the fable
 * routing doc contract test, so this cannot drift from shipped docs).
 */
function retiredNames(): Set<string> {
  const doc = readFileSync(join(REPO_ROOT, "docs", "CLAUDE.md"), "utf-8");
  const match = doc.match(/\*\*Retired in 5\.0\.0 \(removed, not aliased\):\*\* ([^.]+)\./);
  expect(match, "docs/CLAUDE.md must keep the canonical 5.0.0 retired list").not.toBeNull();
  return new Set(
    match![1]
      .split(",")
      .map((name) => name.trim().replace(/`/g, ""))
      .filter(Boolean),
  );
}

describe("setup phases drift enforcement (issue #3871)", () => {
  const skills = shippedSkills();
  const retired = retiredNames();

  it("knows the shipped and retired sets are non-trivial and disjoint", () => {
    expect(retired.size).toBeGreaterThanOrEqual(15);
    expect(retired.has("mcp-setup")).toBe(true);
    expect(retired.has("ultrawork")).toBe(true);
    expect(skills.has("mcp-setup")).toBe(false);
    expect(skills.has("ultrawork")).toBe(false);
    expect(skills.has("omc-setup")).toBe(true);
    for (const name of retired) {
      expect(skills.has(name), `retired ${name} must not be shipped`).toBe(false);
    }
  });

  it("every referenced /oh-my-claudecode:<skill> exists in the shipped plugin", () => {
    for (const file of PHASE_FILES) {
      const content = readPhase(file);
      const referenced = [...content.matchAll(/\/oh-my-claudecode:([a-z0-9-]+)/g)].map(
        (m) => m[1],
      );
      for (const name of referenced) {
        expect(
          skills.has(name),
          `${file} references /oh-my-claudecode:${name}, but the plugin does not ship a skill with that name`,
        ).toBe(true);
      }
    }
  });

  it("no setup phase references a 5.0.0-retired skill name as an invocation target", () => {
    for (const file of PHASE_FILES) {
      const content = readPhase(file);
      // An invocation-shaped reference is any of:
      //   /oh-my-claudecode:<name>   <name>: <task>   "invoke the <name> skill"
      // Plain-prose retirement notices (a dedicated block listing removed
      // names, or a "removed in 5.0.0" sentence) are allowed — users and the
      // setup agent must still be told what no longer exists.
      const stripped = content
        .replace(/RETIRED IN 5\.0\.0[\s\S]*?(?=\n[A-Z#]|\n```|$)/g, "")
        .replace(/[^.\n]*removed in 5\.0\.0[^.\n]*\.?/gi, "");
      for (const name of retired) {
        const invocationPatterns = [
          new RegExp(`/oh-my-claudecode:${name}\\b`),
          new RegExp(`^#{1,6}.*\\b${name}\\b.*(step|skill|invoke)`, "im"),
          new RegExp(`invoke (?:the )?.{0,20}\\b${name}\\b (?:skill|workflow)`, "i"),
        ];
        for (const pattern of invocationPatterns) {
          expect(
            pattern.test(stripped),
            `${file} treats retired '${name}' as an invocable target`,
          ).toBe(false);
        }
      }
    }
  });

  it("never instructs writing the retired defaultExecutionMode config value", () => {
    for (const file of PHASE_FILES) {
      const content = readPhase(file);
      // Deletion instructions are fine (Step 2.4 clears a stale value);
      // writes/sets are not.
      const writePatterns = [
        /jq[^|]*--arg\s+mode[^|]*defaultExecutionMode/,
        /defaultExecutionMode:\s*["']?\$\{?USER_CHOICE/,
        /\. \{defaultExecutionMode/,
      ];
      for (const pattern of writePatterns) {
        expect(
          pattern.test(content),
          `${file} instructs writing defaultExecutionMode (removed in 5.0.0)`,
        ).toBe(false);
      }
      // If the key appears at all, it must only be in a del/clear context.
      for (const line of content.split("\n")) {
        if (line.includes("defaultExecutionMode") && /[a-z]{2,}\s*["']?defaultExecutionMode/.test(line)) {
          const isClearing = /del\(|del\s|Clear|clear|retired|Retired|grep -q/.test(line);
          expect(
            isClearing,
            `${file} mentions defaultExecutionMode outside a clearing context: ${line.trim()}`,
          ).toBe(true);
        }
      }
    }
  });

  it("executes cleanup for tilde paths and preserves the original on jq or mv failure", () => {
    const phase = readPhase("02-configure.md");
    const snippet = phase.match(/## Step 2\.4:[\s\S]*?```bash\n([\s\S]*?)\n```/)?.[1];
    expect(snippet, "Step 2.4 must keep an executable cleanup snippet").toBeTruthy();
    const root = mkdtempSync(join(tmpdir(), "setup-drift-cleanup-"));
    const original = JSON.stringify({ silentAutoUpdate: false, defaultExecutionMode: "ultrawork" }, null, 2) + "\n";
    try {
      const config = join(root, ".omc-config.json");
      writeFileSync(config, original);
      execFileSync("bash", ["-c", snippet!], { env: { ...process.env, CLAUDE_CONFIG_DIR: root } });
      const cleaned = JSON.parse(readFileSync(config, "utf8")) as Record<string, unknown>;
      expect(cleaned).toEqual({ silentAutoUpdate: false });

      const tildeConfigDir = join(root, "nested");
      const tildeConfig = join(tildeConfigDir, ".omc-config.json");
      mkdirSync(tildeConfigDir, { recursive: true });
      writeFileSync(tildeConfig, original);
      execFileSync("bash", ["-c", snippet!], {
        env: { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: "~/nested" },
      });
      expect(JSON.parse(readFileSync(tildeConfig, "utf8"))).toEqual({ silentAutoUpdate: false });
      writeFileSync(tildeConfig, original);
      execFileSync("bash", ["-c", snippet!], {
        env: { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: "~\\nested" },
      });
      expect(JSON.parse(readFileSync(tildeConfig, "utf8"))).toEqual({ silentAutoUpdate: false });

      const malformed = "{ \"defaultExecutionMode\":";
      writeFileSync(config, malformed);
      execFileSync("bash", ["-c", snippet!], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: root },
        stdio: "ignore",
      });
      expect(readFileSync(config, "utf8")).toBe(malformed);

      writeFileSync(config, original);
      const fakeBin = join(root, "bin");
      const fakeMv = join(fakeBin, "mv");
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(fakeMv, "#!/bin/sh\nexit 1\n");
      chmodSync(fakeMv, 0o755);
      execFileSync("bash", ["-c", snippet!], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: root, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
        stdio: "ignore",
      });
      expect(readFileSync(config, "utf8")).toBe(original);
      expect(readdirSync(root).filter((entry) => entry.includes(".tmp.")).length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes the resume boundary without changing the original progress marker", () => {
    const phase = readPhase("02-configure.md");
    const snippet = phase.match(/## Resume Boundary[\s\S]*?```bash\n([\s\S]*?)\n```/)?.[1];
    expect(snippet, "Phase 2 must keep an executable resume-boundary snippet").toBeTruthy();
    const root = mkdtempSync(join(tmpdir(), "setup-drift-resume-"));
    try {
      mkdirSync(join(root, ".omc", "state"), { recursive: true });
      writeFileSync(join(root, ".omc", "state", "setup-state.json"), JSON.stringify({ lastCompletedStep: 7 }));
      const resumed = execFileSync("bash", ["-c", `${snippet}\nprintf '%s:%s\\n' "$RESUMED_PHASE_TWO_BOUNDARY" "$RESUME_LAST_COMPLETED_STEP"`], { cwd: root });
      expect(resumed.toString()).toContain("true:7");

      writeFileSync(join(root, ".omc", "state", "setup-state.json"), JSON.stringify({ lastCompletedStep: 2 }));
      const fresh = execFileSync("bash", ["-c", `${snippet}\nprintf '%s:%s\\n' "$RESUMED_PHASE_TWO_BOUNDARY" "$RESUME_LAST_COMPLETED_STEP"`], { cwd: root });
      expect(fresh.toString()).toContain("false:2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the installed plan and review skill names in the welcome text", () => {
    const welcome = readPhase("04-welcome.md");
    expect(welcome).toContain("/oh-my-claudecode:omc-plan");
    expect(welcome).toContain("/oh-my-claudecode:omc-review");
    expect(welcome).not.toContain("/oh-my-claudecode:plan");
    expect(welcome).not.toContain("/oh-my-claudecode:review");
  });

  it("executes the team config normalizer for a backslash-tilde path", () => {
    const phase = readPhase("03-integrations.md");
    const block = phase.match(/Store the team configuration[\s\S]*?```bash\n([\s\S]*?)\n```/)?.[1];
    expect(block, "team config block must remain executable").toBeTruthy();
    const preamble = block!.split("\n").slice(0, 8).join("\n");
    const root = mkdtempSync(join(tmpdir(), "setup-drift-team-path-"));
    try {
      const output = execFileSync("bash", ["-c", `${preamble}\nprintf '%s\\n' "$CONFIG_FILE"`], {
        cwd: root,
        env: { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: "~\\claude" },
      });
      expect(output.toString().trim()).toBe(join(root, "claude", ".omc-config.json"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
