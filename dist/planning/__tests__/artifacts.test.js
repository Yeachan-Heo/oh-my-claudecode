import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readPlanningArtifacts, isPlanningComplete, readApprovedExecutionLaunchHint, } from "../artifacts.js";
describe("planning/artifacts", () => {
    let testDir;
    let plansDir;
    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), "artifacts-test-"));
        plansDir = join(testDir, ".omc", "plans");
        mkdirSync(plansDir, { recursive: true });
    });
    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });
    function writeValidArtifacts(prdName = "prd-feature.md", specName = "test-spec-feature.md") {
        writeFileSync(join(plansDir, prdName), [
            "# PRD",
            "",
            "## Acceptance criteria",
            "- done",
            "",
            "## Requirement coverage map",
            "- req -> impl",
            "",
            'omc team 3:claude "implement auth"',
            "",
        ].join("\n"));
        writeFileSync(join(plansDir, specName), [
            "# Test Spec",
            "",
            "## Unit coverage",
            "- unit",
            "",
            "## Verification mapping",
            "- verify",
            "",
        ].join("\n"));
    }
    describe("readPlanningArtifacts", () => {
        it("returns empty arrays when plans dir does not exist", () => {
            const result = readPlanningArtifacts(join(testDir, "nonexistent"));
            expect(result).toEqual({ prdPaths: [], testSpecPaths: [] });
        });
        it("returns empty arrays when plans dir is empty", () => {
            const result = readPlanningArtifacts(testDir);
            expect(result).toEqual({ prdPaths: [], testSpecPaths: [] });
        });
        it("returns prd paths for prd-*.md files", () => {
            writeFileSync(join(plansDir, "prd-feature.md"), "# PRD");
            const result = readPlanningArtifacts(testDir);
            expect(result.prdPaths).toHaveLength(1);
            expect(result.prdPaths[0]).toContain("prd-feature.md");
        });
        it("returns test-spec paths for test-spec-*.md files", () => {
            writeFileSync(join(plansDir, "test-spec-feature.md"), "# Test Spec");
            const result = readPlanningArtifacts(testDir);
            expect(result.testSpecPaths).toHaveLength(1);
            expect(result.testSpecPaths[0]).toContain("test-spec-feature.md");
        });
        it("ignores non-matching files", () => {
            writeFileSync(join(plansDir, "notes.md"), "# Notes");
            writeFileSync(join(plansDir, "README.txt"), "readme");
            const result = readPlanningArtifacts(testDir);
            expect(result.prdPaths).toHaveLength(0);
            expect(result.testSpecPaths).toHaveLength(0);
        });
        it("returns multiple files sorted descending", () => {
            writeFileSync(join(plansDir, "prd-aaa.md"), "# PRD A");
            writeFileSync(join(plansDir, "prd-bbb.md"), "# PRD B");
            const result = readPlanningArtifacts(testDir);
            expect(result.prdPaths).toHaveLength(2);
            expect(result.prdPaths[0]).toContain("prd-bbb.md");
        });
    });
    describe("isPlanningComplete", () => {
        it("returns false when no PRDs", () => {
            expect(isPlanningComplete({ prdPaths: [], testSpecPaths: ["spec.md"] })).toBe(false);
        });
        it("returns false when no test specs", () => {
            expect(isPlanningComplete({ prdPaths: ["prd.md"], testSpecPaths: [] })).toBe(false);
        });
        it("returns false when the latest PRD is missing requirement coverage", () => {
            writeFileSync(join(plansDir, "prd-feature.md"), ["# PRD", "", "## Acceptance criteria", "- done", ""].join("\n"));
            writeFileSync(join(plansDir, "test-spec-feature.md"), [
                "# Test Spec",
                "",
                "## Unit coverage",
                "- unit",
                "",
                "## Verification mapping",
                "- verify",
                "",
            ].join("\n"));
            expect(isPlanningComplete(readPlanningArtifacts(testDir))).toBe(false);
        });
        it("returns false when the latest PRD is missing acceptance criteria", () => {
            writeFileSync(join(plansDir, "prd-feature.md"), ["# PRD", "", "## Requirement coverage map", "- req -> impl", ""].join("\n"));
            writeFileSync(join(plansDir, "test-spec-feature.md"), [
                "# Test Spec",
                "",
                "## Unit coverage",
                "- unit",
                "",
                "## Verification mapping",
                "- verify",
                "",
            ].join("\n"));
            expect(isPlanningComplete(readPlanningArtifacts(testDir))).toBe(false);
        });
        it("returns false when the latest test spec is missing verification mapping", () => {
            writeFileSync(join(plansDir, "prd-feature.md"), [
                "# PRD",
                "",
                "## Acceptance criteria",
                "- done",
                "",
                "## Requirement coverage map",
                "- req -> impl",
                "",
            ].join("\n"));
            writeFileSync(join(plansDir, "test-spec-feature.md"), ["# Test Spec", "", "## Unit coverage", "- unit", ""].join("\n"));
            expect(isPlanningComplete(readPlanningArtifacts(testDir))).toBe(false);
        });
        it("returns false when the latest test spec is missing unit coverage", () => {
            writeFileSync(join(plansDir, "prd-feature.md"), [
                "# PRD",
                "",
                "## Acceptance criteria",
                "- done",
                "",
                "## Requirement coverage map",
                "- req -> impl",
                "",
            ].join("\n"));
            writeFileSync(join(plansDir, "test-spec-feature.md"), ["# Test Spec", "", "## Verification mapping", "- verify", ""].join("\n"));
            expect(isPlanningComplete(readPlanningArtifacts(testDir))).toBe(false);
        });
        it("returns false for whitespace-only sections", () => {
            writeFileSync(join(plansDir, "prd-feature.md"), [
                "# PRD",
                "",
                "## Acceptance criteria",
                "   ",
                "",
                "## Requirement coverage map",
                "- req -> impl",
                "",
            ].join("\n"));
            writeFileSync(join(plansDir, "test-spec-feature.md"), [
                "# Test Spec",
                "",
                "## Unit coverage",
                "- unit",
                "",
                "## Verification mapping",
                "- verify",
                "",
            ].join("\n"));
            expect(isPlanningComplete(readPlanningArtifacts(testDir))).toBe(false);
        });
        it("returns true when both latest artifacts contain required sections", () => {
            writeValidArtifacts();
            expect(isPlanningComplete(readPlanningArtifacts(testDir))).toBe(true);
        });
        it("treats required heading matches as case-insensitive", () => {
            writeFileSync(join(plansDir, "prd-feature.md"), [
                "# PRD",
                "",
                "## ACCEPTANCE CRITERIA",
                "- done",
                "",
                "## requirement coverage map",
                "- req -> impl",
                "",
            ].join("\n"));
            writeFileSync(join(plansDir, "test-spec-feature.md"), [
                "# Test Spec",
                "",
                "## UNIT COVERAGE",
                "- unit",
                "",
                "## verification mapping",
                "- verify",
                "",
            ].join("\n"));
            expect(isPlanningComplete(readPlanningArtifacts(testDir))).toBe(true);
        });
        it("uses the latest artifacts when older ones were valid", () => {
            writeValidArtifacts("prd-aaa.md", "test-spec-aaa.md");
            writeFileSync(join(plansDir, "prd-zzz.md"), ["# PRD", "", "## Acceptance criteria", "- done", ""].join("\n"));
            writeFileSync(join(plansDir, "test-spec-zzz.md"), [
                "# Test Spec",
                "",
                "## Unit coverage",
                "- unit",
                "",
                "## Verification mapping",
                "- verify",
                "",
            ].join("\n"));
            expect(isPlanningComplete(readPlanningArtifacts(testDir))).toBe(false);
        });
    });
    describe("readApprovedExecutionLaunchHint", () => {
        it("returns null when no plans dir", () => {
            const result = readApprovedExecutionLaunchHint(join(testDir, "nope"), "team");
            expect(result).toBeNull();
        });
        it("returns null when PRD has no launch command", () => {
            writeFileSync(join(plansDir, "prd-feature.md"), "# PRD\n\nNo commands here.");
            const result = readApprovedExecutionLaunchHint(testDir, "team");
            expect(result).toBeNull();
        });
        it("extracts team launch hint with worker count and agent type", () => {
            writeValidArtifacts();
            const result = readApprovedExecutionLaunchHint(testDir, "team");
            expect(result).not.toBeNull();
            expect(result.mode).toBe("team");
            expect(result.task).toBe("implement auth");
            expect(result.workerCount).toBe(3);
            expect(result.agentType).toBe("claude");
            expect(result.linkedRalph).toBe(false);
            expect(result.sourcePath).toContain("prd-feature.md");
        });
        it("extracts team launch hint without worker spec", () => {
            writeFileSync(join(plansDir, "prd-feature.md"), [
                "# PRD",
                "",
                "## Acceptance criteria",
                "- done",
                "",
                "## Requirement coverage map",
                "- req -> impl",
                "",
                'Run: omc team "implement the feature"',
                "",
            ].join("\n"));
            const result = readApprovedExecutionLaunchHint(testDir, "team");
            expect(result).not.toBeNull();
            expect(result.task).toBe("implement the feature");
            expect(result.workerCount).toBeUndefined();
            expect(result.agentType).toBeUndefined();
        });
        it("detects --linked-ralph flag", () => {
            writeFileSync(join(plansDir, "prd-feature.md"), [
                "# PRD",
                "",
                "## Acceptance criteria",
                "- done",
                "",
                "## Requirement coverage map",
                "- req -> impl",
                "",
                'omc team 2:codex "fix the bug" --linked-ralph',
                "",
            ].join("\n"));
            const result = readApprovedExecutionLaunchHint(testDir, "team");
            expect(result).not.toBeNull();
            expect(result.linkedRalph).toBe(true);
        });
        it("extracts ralph launch hint", () => {
            writeFileSync(join(plansDir, "prd-feature.md"), [
                "# PRD",
                "",
                "## Acceptance criteria",
                "- done",
                "",
                "## Requirement coverage map",
                "- req -> impl",
                "",
                'omc ralph "do the work"',
                "",
            ].join("\n"));
            const result = readApprovedExecutionLaunchHint(testDir, "ralph");
            expect(result).not.toBeNull();
            expect(result.mode).toBe("ralph");
            expect(result.task).toBe("do the work");
        });
        it("returns null for ralph mode when only team command present", () => {
            writeValidArtifacts();
            const result = readApprovedExecutionLaunchHint(testDir, "ralph");
            expect(result).toBeNull();
        });
        it("still parses launch hints even when quality gates fail", () => {
            writeFileSync(join(plansDir, "prd-feature.md"), '# PRD\n\nRun: omc team "new task"\n');
            writeFileSync(join(plansDir, "test-spec-feature.md"), [
                "# Test Spec",
                "",
                "## Unit coverage",
                "- unit",
                "",
                "## Verification mapping",
                "- verify",
                "",
            ].join("\n"));
            expect(isPlanningComplete(readPlanningArtifacts(testDir))).toBe(false);
            expect(readApprovedExecutionLaunchHint(testDir, "team").task).toBe("new task");
        });
    });
});
//# sourceMappingURL=artifacts.test.js.map