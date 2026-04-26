import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { isShortTeamFollowupRequest, isShortRalphFollowupRequest, isApprovedExecutionFollowupShortcut, resolveApprovedTeamFollowupContext, } from "../followup-planner.js";
describe("team/followup-planner", () => {
    describe("isShortTeamFollowupRequest", () => {
        it.each([
            "team",
            "team please",
            "/team",
            "run team",
            "start team",
            "launch team",
            "go team",
            "team으로 해줘",
        ])("matches %s", (value) => {
            expect(isShortTeamFollowupRequest(value)).toBe(true);
        });
        it.each([
            "team now please do it",
            "please run the team",
            "autopilot team",
            "",
        ])("rejects %s", (value) => {
            expect(isShortTeamFollowupRequest(value)).toBe(false);
        });
    });
    describe("isShortRalphFollowupRequest", () => {
        it.each([
            "ralph",
            "ralph please",
            "/ralph",
            "run ralph",
            "start ralph",
            "launch ralph",
            "go ralph",
        ])("matches %s", (value) => {
            expect(isShortRalphFollowupRequest(value)).toBe(true);
        });
        it.each(["ralph do everything", "please run ralph now", ""])("rejects %s", (value) => {
            expect(isShortRalphFollowupRequest(value)).toBe(false);
        });
    });
    describe("isApprovedExecutionFollowupShortcut", () => {
        it("requires planningComplete=true", () => {
            expect(isApprovedExecutionFollowupShortcut("team", "team", {
                planningComplete: false,
                priorSkill: "ralplan",
            })).toBe(false);
        });
        it("requires priorSkill=ralplan", () => {
            expect(isApprovedExecutionFollowupShortcut("team", "team", {
                planningComplete: true,
                priorSkill: "plan",
            })).toBe(false);
        });
        it("matches approved team follow-up", () => {
            expect(isApprovedExecutionFollowupShortcut("team", "team", {
                planningComplete: true,
                priorSkill: "ralplan",
            })).toBe(true);
        });
        it("matches approved ralph follow-up", () => {
            expect(isApprovedExecutionFollowupShortcut("ralph", "ralph", {
                planningComplete: true,
                priorSkill: "ralplan",
            })).toBe(true);
        });
    });
    describe("resolveApprovedTeamFollowupContext", () => {
        let testDir;
        let plansDir;
        beforeEach(() => {
            testDir = mkdtempSync(join(tmpdir(), "followup-planner-test-"));
            plansDir = join(testDir, ".omc", "plans");
            mkdirSync(plansDir, { recursive: true });
        });
        afterEach(() => {
            rmSync(testDir, { recursive: true, force: true });
        });
        it("returns null when no plans exist", () => {
            const result = resolveApprovedTeamFollowupContext(testDir, "do the task");
            expect(result).toBeNull();
        });
        it("returns null when only PRD exists (no test spec)", () => {
            writeFileSync(join(plansDir, "prd-feature.md"), [
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
            const result = resolveApprovedTeamFollowupContext(testDir, "do the task");
            expect(result).toBeNull();
        });
        it("returns null when PRD has no launch hint", () => {
            writeFileSync(join(plansDir, "prd-feature.md"), [
                "# PRD",
                "",
                "## Acceptance criteria",
                "- done",
                "",
                "## Requirement coverage map",
                "- req -> impl",
                "",
                "No commands.",
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
            const result = resolveApprovedTeamFollowupContext(testDir, "do the task");
            expect(result).toBeNull();
        });
        it("returns null when latest artifacts are low-signal even if older artifacts were valid", () => {
            writeFileSync(join(plansDir, "prd-aaa.md"), [
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
            writeFileSync(join(plansDir, "test-spec-aaa.md"), [
                "# Test Spec",
                "",
                "## Unit coverage",
                "- unit",
                "",
                "## Verification mapping",
                "- verify",
                "",
            ].join("\n"));
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
            const result = resolveApprovedTeamFollowupContext(testDir, "do the task");
            expect(result).toBeNull();
        });
        it("returns context with hint when planning is complete and hint exists", () => {
            writeFileSync(join(plansDir, "prd-feature.md"), [
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
            const result = resolveApprovedTeamFollowupContext(testDir, "do the task");
            expect(result).not.toBeNull();
            expect(result.hint.mode).toBe("team");
            expect(result.hint.task).toBe("implement auth");
            expect(result.hint.workerCount).toBe(3);
            expect(result.launchCommand).toContain("omc team");
        });
        it("resolves follow-up context from OMX planning artifacts written after a deep-interview/ralplan cycle", () => {
            const omxPlansDir = join(testDir, ".omx", "plans");
            mkdirSync(omxPlansDir, { recursive: true });
            writeFileSync(join(omxPlansDir, "prd-capture-page-ui-draft.md"), [
                "# PRD",
                "",
                "## Acceptance criteria",
                "- done",
                "",
                "## Requirement coverage map",
                "- req -> impl",
                "",
                'omx team ".omx/plans/ralplan-capture-page-ui-draft-v7.md"',
                "",
            ].join("\n"));
            writeFileSync(join(omxPlansDir, "test-spec-capture-page-ui-draft.md"), [
                "# Test Spec",
                "",
                "## Unit coverage",
                "- unit",
                "",
                "## Verification mapping",
                "- verify",
                "",
            ].join("\n"));
            const result = resolveApprovedTeamFollowupContext(testDir, "team");
            expect(result).not.toBeNull();
            expect(result.hint.mode).toBe("team");
            expect(result.launchCommand).toBe('omx team ".omx/plans/ralplan-capture-page-ui-draft-v7.md"');
            expect(result.hint.sourcePath).toContain(join(".omx", "plans", "prd-capture-page-ui-draft.md"));
        });
    });
});
//# sourceMappingURL=followup-planner.test.js.map