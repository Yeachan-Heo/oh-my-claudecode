/**
 * Tests for Ralphthon CLI helpers and argument parsing
 */
import { describe, it, expect } from "vitest";
import { parseRalphthonArgs, buildRalphthonInterviewPrompt, buildDefaultSkipInterviewPrdParams, buildRalphthonPlanningContext, } from "../../cli/commands/ralphthon.js";
import { RALPHTHON_DEFAULTS } from "../types.js";
describe("Ralphthon CLI", () => {
    describe("parseRalphthonArgs", () => {
        it("should parse empty args with defaults", () => {
            const options = parseRalphthonArgs([]);
            expect(options.resume).toBe(false);
            expect(options.skipInterview).toBe(false);
            expect(options.maxWaves).toBe(RALPHTHON_DEFAULTS.maxWaves);
            expect(options.pollInterval).toBe(RALPHTHON_DEFAULTS.pollIntervalMs / 1000);
            expect(options.task).toBeUndefined();
        });
        it("should parse task description", () => {
            const options = parseRalphthonArgs(["Build", "a", "REST", "API"]);
            expect(options.task).toBe("Build a REST API");
        });
        it("should parse --resume flag", () => {
            const options = parseRalphthonArgs(["--resume"]);
            expect(options.resume).toBe(true);
        });
        it("should parse --skip-interview flag", () => {
            const options = parseRalphthonArgs(["--skip-interview", "my task"]);
            expect(options.skipInterview).toBe(true);
            expect(options.task).toBe("my task");
        });
        it("should parse --max-waves option", () => {
            const options = parseRalphthonArgs(["--max-waves", "5", "my task"]);
            expect(options.maxWaves).toBe(5);
            expect(options.task).toBe("my task");
        });
        it("should parse --poll-interval option", () => {
            const options = parseRalphthonArgs(["--poll-interval", "60", "my task"]);
            expect(options.pollInterval).toBe(60);
        });
        it("should handle combined options", () => {
            const options = parseRalphthonArgs([
                "--skip-interview",
                "--max-waves",
                "3",
                "--poll-interval",
                "30",
                "Build auth system",
            ]);
            expect(options.skipInterview).toBe(true);
            expect(options.maxWaves).toBe(3);
            expect(options.pollInterval).toBe(30);
            expect(options.task).toBe("Build auth system");
        });
        it("should ignore invalid --max-waves values", () => {
            const options = parseRalphthonArgs(["--max-waves", "abc", "task"]);
            expect(options.maxWaves).toBe(RALPHTHON_DEFAULTS.maxWaves);
        });
        it("should ignore negative --poll-interval values", () => {
            const options = parseRalphthonArgs(["--poll-interval", "-5", "task"]);
            expect(options.pollInterval).toBe(RALPHTHON_DEFAULTS.pollIntervalMs / 1000);
        });
        it("should ignore unknown flags", () => {
            const options = parseRalphthonArgs(["--unknown", "my task"]);
            expect(options.task).toBe("my task");
        });
    });
    describe("planning helpers", () => {
        it("builds explicit brownfield planning context", () => {
            expect(buildRalphthonPlanningContext("Improve planning")).toEqual({
                brownfield: true,
                assumptionsMode: "explicit",
                codebaseMapSummary: "Brownfield target: Improve planning",
                knownConstraints: [
                    "Prefer repository evidence over assumptions",
                    "Capture brownfield/codebase-map findings explicitly before execution",
                ],
            });
        });
        it("builds interview prompt with explicit planning context contract", () => {
            const prompt = buildRalphthonInterviewPrompt("Improve planning", {
                resume: false,
                skipInterview: false,
                maxWaves: 4,
                pollInterval: 45,
                task: "Improve planning",
            });
            expect(prompt).toContain("/deep-interview Improve planning");
            expect(prompt).toContain('"planningContext"');
            expect(prompt).toContain('"assumptionsMode": "explicit"');
            expect(prompt).toContain('"codebaseMapSummary"');
            expect(prompt).toContain("Treat this as brownfield planning");
        });
        it("builds skip-interview defaults with normalized planning context", () => {
            const prd = buildDefaultSkipInterviewPrdParams("Implement auth middleware");
            expect(prd.project).toBe("ralphthon");
            expect(prd.branchName).toBe("feat/ralphthon");
            expect(prd.stories).toHaveLength(1);
            expect(prd.planningContext.assumptionsMode).toBe("explicit");
            expect(prd.planningContext.brownfield).toBe(true);
            expect(prd.planningContext.codebaseMapSummary).toContain("Implement auth middleware");
        });
    });
});
//# sourceMappingURL=cli.test.js.map