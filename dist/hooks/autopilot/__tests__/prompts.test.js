import { describe, it, expect } from "vitest";
import { getExpansionPrompt, getDirectPlanningPrompt, getExecutionPrompt, getQAPrompt, getValidationPrompt, getPhasePrompt, } from "../prompts.js";
describe("Prompt Generation", () => {
    describe("getExpansionPrompt", () => {
        it("should include user idea", () => {
            const prompt = getExpansionPrompt("build a CLI tool");
            expect(prompt).toContain("build a CLI tool");
        });
        it("should include analyst Task invocation", () => {
            const prompt = getExpansionPrompt("test");
            expect(prompt).toContain("lazycc:analyst");
        });
        it("should include architect Task invocation", () => {
            const prompt = getExpansionPrompt("test");
            expect(prompt).toContain("lazycc:architect");
        });
        it("should include custom open questions path when provided", () => {
            const prompt = getExpansionPrompt("test", "docs/plans/questions.md");
            expect(prompt).toContain("docs/plans/questions.md");
        });
    });
    describe("getDirectPlanningPrompt", () => {
        it("should reference spec path", () => {
            const prompt = getDirectPlanningPrompt("/path/to/spec.md", "/path/to/plan.md");
            expect(prompt).toContain("/path/to/spec.md");
            expect(prompt).toContain("/path/to/plan.md");
        });
        it("should use direct planning mode without user interview", () => {
            const prompt = getDirectPlanningPrompt("spec.md");
            // Direct mode means no interview with user - spec is already complete
            expect(prompt).toContain("DIRECT PLANNING");
            expect(prompt).toContain("no interview needed");
        });
        it("should include critic Task for validation", () => {
            const prompt = getDirectPlanningPrompt("spec.md");
            expect(prompt).toContain("lazycc:critic");
        });
        it("should include custom plan path when provided", () => {
            const prompt = getDirectPlanningPrompt("spec.md", "docs/plans/plan-autopilot-impl.md");
            expect(prompt).toContain("docs/plans/plan-autopilot-impl.md");
        });
    });
    describe("getExecutionPrompt", () => {
        it("should reference plan path", () => {
            const prompt = getExecutionPrompt("/path/to/plan.md");
            expect(prompt).toContain("/path/to/plan.md");
        });
        it("should specify Ralph+Ultrawork activation", () => {
            const prompt = getExecutionPrompt("plan.md");
            expect(prompt).toContain("Ralph");
            expect(prompt).toContain("Ultrawork");
        });
    });
    describe("getQAPrompt", () => {
        it("should specify build/lint/test sequence", () => {
            const prompt = getQAPrompt();
            expect(prompt).toContain("Build");
            expect(prompt).toContain("Lint");
            expect(prompt).toContain("Test");
        });
    });
    describe("getValidationPrompt", () => {
        it("should specify parallel architect spawns", () => {
            const prompt = getValidationPrompt("spec.md");
            expect(prompt).toContain("parallel");
        });
        it("should include all three validation types", () => {
            const prompt = getValidationPrompt("spec.md");
            expect(prompt).toContain("Functional");
            expect(prompt).toContain("Security");
            expect(prompt).toContain("Quality");
        });
    });
    describe("getPhasePrompt", () => {
        it("should dispatch to correct phase", () => {
            const expansion = getPhasePrompt("expansion", { idea: "test" });
            expect(expansion).toContain("EXPANSION");
            const qa = getPhasePrompt("qa", {});
            expect(qa).toContain("QA");
        });
    });
});
//# sourceMappingURL=prompts.test.js.map