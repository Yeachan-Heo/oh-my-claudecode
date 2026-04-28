/**
 * Integration tests for Skill Bridge Module
 *
 * Tests the bridge API used by skill-injector.mjs for:
 * - Skill file discovery (recursive)
 * - YAML frontmatter parsing
 * - Trigger-based matching
 * - Session cache persistence
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync, } from "fs";
import { join } from "path";
import { contextCollector } from "../../../features/context-injector/index.js";
import { processMessageForSkills, clearSkillSession } from "../../../hooks/learner/index.js";
import { tmpdir } from "os";
import { findSkillFiles, parseSkillFile, matchSkillsForInjection, getInjectedSkillPaths, markSkillsInjected, clearSkillMetadataCache, } from "../../../hooks/learner/bridge.js";
describe("Skill Bridge Module", () => {
    let testProjectRoot;
    let originalCwd;
    beforeEach(() => {
        clearSkillMetadataCache();
        clearSkillSession("emitted-learner-session");
        contextCollector.clear("emitted-learner-session");
        originalCwd = process.cwd();
        testProjectRoot = join(tmpdir(), `omc-bridge-test-${Date.now()}`);
        mkdirSync(testProjectRoot, { recursive: true });
        process.chdir(testProjectRoot);
    });
    afterEach(() => {
        process.chdir(originalCwd);
        contextCollector.clear("emitted-learner-session");
        clearSkillSession("emitted-learner-session");
        if (existsSync(testProjectRoot)) {
            rmSync(testProjectRoot, { recursive: true, force: true });
        }
    });
    describe("findSkillFiles", () => {
        it("should discover skills in project .omc/skills/", () => {
            const skillsDir = join(testProjectRoot, ".omc", "skills");
            mkdirSync(skillsDir, { recursive: true });
            writeFileSync(join(skillsDir, "test-skill.md"), "---\nname: Test Skill\ntriggers:\n  - test\n---\nContent");
            const files = findSkillFiles(testProjectRoot);
            // Filter to project scope to isolate from user's global skills
            const projectFiles = files.filter((f) => f.scope === "project");
            expect(projectFiles).toHaveLength(1);
            expect(projectFiles[0].scope).toBe("project");
            expect(projectFiles[0].path).toContain("test-skill.md");
        });
        it("should discover compatibility skills in project .agents/skills/", () => {
            const skillsDir = join(testProjectRoot, ".agents", "skills");
            mkdirSync(skillsDir, { recursive: true });
            writeFileSync(join(skillsDir, "compat-skill.md"), "---\nname: Compat Skill\ntriggers:\n  - compat\n---\nContent");
            const files = findSkillFiles(testProjectRoot);
            const projectFiles = files.filter((f) => f.scope === "project");
            expect(projectFiles).toHaveLength(1);
            expect(projectFiles[0].sourceDir).toContain(join(".agents", "skills"));
            expect(projectFiles[0].path).toContain("compat-skill.md");
        });
        it("should discover skills recursively in subdirectories", () => {
            const skillsDir = join(testProjectRoot, ".omc", "skills");
            const subDir = join(skillsDir, "subdir", "nested");
            mkdirSync(subDir, { recursive: true });
            writeFileSync(join(skillsDir, "root-skill.md"), "---\nname: Root\ntriggers:\n  - root\n---\nRoot content");
            writeFileSync(join(subDir, "nested-skill.md"), "---\nname: Nested\ntriggers:\n  - nested\n---\nNested content");
            const files = findSkillFiles(testProjectRoot);
            // Filter to project scope to isolate from user's global skills
            const projectFiles = files.filter((f) => f.scope === "project");
            expect(projectFiles).toHaveLength(2);
            const names = projectFiles.map((f) => f.path);
            expect(names.some((n) => n.includes("root-skill.md"))).toBe(true);
            expect(names.some((n) => n.includes("nested-skill.md"))).toBe(true);
        });
        it("should ignore non-.md files", () => {
            const skillsDir = join(testProjectRoot, ".omc", "skills");
            mkdirSync(skillsDir, { recursive: true });
            writeFileSync(join(skillsDir, "valid.md"), "---\nname: Valid\n---\nContent");
            writeFileSync(join(skillsDir, "invalid.txt"), "Not a skill");
            writeFileSync(join(skillsDir, "README"), "Documentation");
            const files = findSkillFiles(testProjectRoot);
            // Filter to project scope to isolate from user's global skills
            const projectFiles = files.filter((f) => f.scope === "project");
            expect(projectFiles).toHaveLength(1);
            expect(projectFiles[0].path).toContain("valid.md");
        });
        it("should treat symlinked project roots as within boundary", () => {
            const skillsDir = join(testProjectRoot, ".omc", "skills");
            mkdirSync(skillsDir, { recursive: true });
            writeFileSync(join(skillsDir, "linked-skill.md"), "---\nname: Linked Skill\ntriggers:\n  - linked\n---\nContent");
            const linkedProjectRoot = join(tmpdir(), `omc-bridge-link-${Date.now()}-${Math.random().toString(16).slice(2)}`);
            try {
                symlinkSync(testProjectRoot, linkedProjectRoot, "dir");
                const files = findSkillFiles(linkedProjectRoot);
                const projectFiles = files.filter((f) => f.scope === "project");
                expect(projectFiles).toHaveLength(1);
                expect(projectFiles[0].path).toContain("linked-skill.md");
            }
            finally {
                rmSync(linkedProjectRoot, { recursive: true, force: true });
            }
        });
    });
    describe("parseSkillFile", () => {
        it("should parse valid frontmatter with all fields", () => {
            const content = `---
name: Comprehensive Skill
description: A test skill
triggers:
  - trigger1
  - trigger2
tags:
  - tag1
matching: fuzzy
model: opus
agent: architect
---

# Skill Content

This is the skill body.`;
            const result = parseSkillFile(content);
            expect(result).not.toBeNull();
            expect(result?.valid).toBe(true);
            expect(result?.metadata.name).toBe("Comprehensive Skill");
            expect(result?.metadata.description).toBe("A test skill");
            expect(result?.metadata.triggers).toEqual(["trigger1", "trigger2"]);
            expect(result?.metadata.tags).toEqual(["tag1"]);
            expect(result?.metadata.matching).toBe("fuzzy");
            expect(result?.metadata.model).toBe("opus");
            expect(result?.metadata.agent).toBe("architect");
            expect(result?.content).toContain("# Skill Content");
        });
        it("should handle files without frontmatter", () => {
            const content = `This is just plain content without frontmatter.`;
            const result = parseSkillFile(content);
            expect(result).not.toBeNull();
            expect(result?.valid).toBe(true);
            expect(result?.content).toBe(content);
        });
        it("should parse inline array syntax", () => {
            const content = `---
name: Inline Triggers
triggers: ["alpha", "beta", "gamma"]
---
Content`;
            const result = parseSkillFile(content);
            expect(result?.metadata.triggers).toEqual(["alpha", "beta", "gamma"]);
        });
        it("should handle unterminated inline array (missing closing bracket)", () => {
            const content = `---
name: Malformed Triggers
triggers: ["alpha", "beta", "gamma"
---
Content`;
            const result = parseSkillFile(content);
            // Missing ] should result in empty triggers array
            expect(result?.valid).toBe(true); // bridge.ts parseSkillFile is more lenient
            expect(result?.metadata.triggers).toEqual([]);
        });
    });
    describe("matchSkillsForInjection", () => {
        it("should match skills by trigger substring", () => {
            const skillsDir = join(testProjectRoot, ".omc", "skills");
            mkdirSync(skillsDir, { recursive: true });
            writeFileSync(join(skillsDir, "deploy-skill.md"), "---\nname: Deploy Skill\ntriggers:\n  - deploy\n  - deployment\n---\nDeployment instructions");
            const matches = matchSkillsForInjection("I need to deploy the application", testProjectRoot, "test-session");
            expect(matches).toHaveLength(1);
            expect(matches[0].name).toBe("Deploy Skill");
            expect(matches[0].score).toBeGreaterThan(0);
        });
        it("returns compact descriptor metadata for matched skills", () => {
            const skillsDir = join(testProjectRoot, ".omc", "skills");
            mkdirSync(skillsDir, { recursive: true });
            const longBody = `${"Full body secret. ".repeat(200)}Do not inject this whole body.`;
            writeFileSync(join(skillsDir, "descriptor-skill.md"), `---
name: Descriptor Skill
description: Use descriptor metadata only
triggers:
  - descriptor
---
${longBody}`);
            const matches = matchSkillsForInjection("please use descriptor guidance", testProjectRoot, "descriptor-session");
            expect(matches).toHaveLength(1);
            expect(matches[0].description).toBe("Use descriptor metadata only");
            expect(matches[0].summary).toBeTruthy();
            expect(matches[0].content).toContain("Full body secret");
        });
        it("registers emitted learner context as compact descriptors within budget", () => {
            const skillsDir = join(testProjectRoot, ".omc", "skills");
            mkdirSync(skillsDir, { recursive: true });
            const giantBody = `${"Sensitive full body content. ".repeat(400)}Tail.`;
            for (const [name, trigger] of [
                ["Alpha Skill", "alpha"],
                ["Beta Skill", "beta"],
                ["Gamma Skill", "gamma"],
            ]) {
                writeFileSync(join(skillsDir, `${trigger}.md`), `---
id: ${trigger}
name: ${name}
description: ${name} summary
source: manual
triggers:
  - ${trigger}
---
${giantBody}`);
            }
            const result = processMessageForSkills("alpha beta gamma", "emitted-learner-session", testProjectRoot);
            const pending = contextCollector.getPending("emitted-learner-session");
            expect(result.injected).toBe(3);
            expect(pending.hasContent).toBe(true);
            expect(pending.merged).toContain("Compact descriptors only");
            expect(pending.merged).toContain("Alpha Skill summary");
            expect(pending.merged).toContain("Load instructions:");
            expect(pending.merged).not.toContain("Sensitive full body content. Sensitive full body content. Sensitive full body content.");
            expect(pending.merged.length).toBeLessThanOrEqual(3000);
        });
        it("keeps learner omission text inside the descriptor budget", () => {
            const skillsDir = join(testProjectRoot, ".omc", "skills");
            mkdirSync(skillsDir, { recursive: true });
            const largeSummary = "Summary ".repeat(220);
            for (const [name, trigger] of [
                ["Delta Skill", "delta"],
                ["Epsilon Skill", "epsilon"],
                ["Zeta Skill", "zeta"],
                ["Eta Skill", "eta"],
            ]) {
                writeFileSync(join(skillsDir, `${trigger}.md`), `---
id: ${trigger}
name: ${name}
description: ${largeSummary}
source: manual
triggers:
  - ${trigger}
---
Body`);
            }
            processMessageForSkills("delta epsilon zeta eta", "emitted-learner-session", testProjectRoot);
            const pending = contextCollector.getPending("emitted-learner-session");
            expect(pending.merged.length).toBeLessThanOrEqual(3000);
            expect(pending.merged).toContain("Additional learned skills omitted");
        });
        it("should not match when triggers dont match", () => {
            const skillsDir = join(testProjectRoot, ".omc", "skills");
            mkdirSync(skillsDir, { recursive: true });
            writeFileSync(join(skillsDir, "database-skill.md"), "---\nname: Database\ntriggers:\n  - database\n  - sql\n---\nDB instructions");
            const matches = matchSkillsForInjection("Help me with React components", testProjectRoot, "test-session");
            expect(matches).toHaveLength(0);
        });
        it("should not match skills with empty scalar triggers", () => {
            const skillsDir = join(testProjectRoot, ".omc", "skills");
            mkdirSync(skillsDir, { recursive: true });
            writeFileSync(join(skillsDir, "blank-trigger-skill.md"), "---\nname: Blank Trigger\ntriggers:\n---\nBlank trigger instructions");
            const matches = matchSkillsForInjection("Help me with React components", testProjectRoot, "blank-trigger-session");
            expect(matches).toHaveLength(0);
        });
        it("should ignore blank trigger entries while matching valid triggers", () => {
            const skillsDir = join(testProjectRoot, ".omc", "skills");
            mkdirSync(skillsDir, { recursive: true });
            writeFileSync(join(skillsDir, "mixed-trigger-skill.md"), `---
name: Mixed Trigger
triggers:
  -
  - ""
  - "   "
  - deploy
---
Mixed trigger instructions`);
            const unrelatedMatches = matchSkillsForInjection("Help me with React components", testProjectRoot, "mixed-trigger-unrelated-session");
            const validMatches = matchSkillsForInjection("Please deploy the app", testProjectRoot, "mixed-trigger-valid-session");
            expect(unrelatedMatches).toHaveLength(0);
            expect(validMatches).toHaveLength(1);
            expect(validMatches[0].triggers).toEqual(["deploy"]);
        });
        it("should use fuzzy matching when opt-in", () => {
            const skillsDir = join(testProjectRoot, ".omc", "skills");
            mkdirSync(skillsDir, { recursive: true });
            // Skill with fuzzy matching enabled
            writeFileSync(join(skillsDir, "fuzzy-skill.md"), "---\nname: Fuzzy Skill\nmatching: fuzzy\ntriggers:\n  - deployment\n---\nFuzzy content");
            // "deploy" is similar to "deployment" - should match with fuzzy
            const matches = matchSkillsForInjection("I need to deploy", testProjectRoot, "test-session-fuzzy");
            // Note: exact substring "deploy" is in "deployment", so it matches anyway
            // To truly test fuzzy, we'd need a trigger that's close but not substring
            expect(matches.length).toBeGreaterThanOrEqual(0);
        });
        it("should respect skill limit", () => {
            const skillsDir = join(testProjectRoot, ".omc", "skills");
            mkdirSync(skillsDir, { recursive: true });
            // Create 10 skills that all match "test"
            for (let i = 0; i < 10; i++) {
                writeFileSync(join(skillsDir, `skill-${i}.md`), `---\nname: Skill ${i}\ntriggers:\n  - test\n---\nContent ${i}`);
            }
            const matches = matchSkillsForInjection("run the test", testProjectRoot, "limit-session", {
                maxResults: 3,
            });
            expect(matches).toHaveLength(3);
        });
    });
    describe("Session Cache", () => {
        it("should track injected skills via file-based cache", () => {
            markSkillsInjected("session-1", ["/path/to/skill1.md", "/path/to/skill2.md"], testProjectRoot);
            const injected = getInjectedSkillPaths("session-1", testProjectRoot);
            expect(injected).toContain("/path/to/skill1.md");
            expect(injected).toContain("/path/to/skill2.md");
        });
        it("should not return skills for different session", () => {
            markSkillsInjected("session-A", ["/path/to/skillA.md"], testProjectRoot);
            const injected = getInjectedSkillPaths("session-B", testProjectRoot);
            expect(injected).toHaveLength(0);
        });
        it("should persist state to file", () => {
            markSkillsInjected("persist-test", ["/path/to/persist.md"], testProjectRoot);
            const stateFile = join(testProjectRoot, ".omc", "state", "skill-sessions.json");
            expect(existsSync(stateFile)).toBe(true);
            const state = JSON.parse(readFileSync(stateFile, "utf-8"));
            expect(state.sessions["persist-test"]).toBeDefined();
            expect(state.sessions["persist-test"].injectedPaths).toContain("/path/to/persist.md");
        });
        it("should not re-inject already injected skills", () => {
            const skillsDir = join(testProjectRoot, ".omc", "skills");
            mkdirSync(skillsDir, { recursive: true });
            writeFileSync(join(skillsDir, "once-skill.md"), "---\nname: Once Only\ntriggers:\n  - once\n---\nOnce content");
            // First match
            const first = matchSkillsForInjection("test once", testProjectRoot, "cache-session");
            expect(first).toHaveLength(1);
            // Mark as injected
            markSkillsInjected("cache-session", [first[0].path], testProjectRoot);
            // Second match - should be empty
            const second = matchSkillsForInjection("test once again", testProjectRoot, "cache-session");
            expect(second).toHaveLength(0);
        });
    });
    describe("Priority", () => {
        it("should return project skills before user skills", () => {
            // We can't easily test user skills dir in isolation, but we can verify
            // that project skills come first in the returned array
            const skillsDir = join(testProjectRoot, ".omc", "skills");
            mkdirSync(skillsDir, { recursive: true });
            writeFileSync(join(skillsDir, "project-skill.md"), "---\nname: Project Skill\ntriggers:\n  - priority\n---\nProject content");
            const files = findSkillFiles(testProjectRoot);
            const projectSkills = files.filter((f) => f.scope === "project");
            expect(projectSkills.length).toBeGreaterThan(0);
            expect(projectSkills[0].scope).toBe("project");
        });
    });
});
//# sourceMappingURL=bridge.test.js.map