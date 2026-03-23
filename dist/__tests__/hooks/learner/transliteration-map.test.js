/**
 * Unit tests for Korean transliteration map (expandTriggers)
 *
 * Verifies that YAML-trigger skills expand to Korean equivalents while
 * built-in keyword-detector entries (autopilot, ralph, etc.) are NOT in the map.
 */
import { describe, it, expect } from "vitest";
import { expandTriggers } from "../../../hooks/learner/transliteration-map.js";
describe("expandTriggers", () => {
    // ---------------------------------------------------------------------------
    // Section 1: Basic expansion
    // ---------------------------------------------------------------------------
    describe("basic expansion", () => {
        it('expands "deep dive" to include Korean variants', () => {
            const result = expandTriggers(["deep dive"]);
            expect(result).toContain("deep dive");
            expect(result).toContain("딥다이브");
            expect(result).toContain("딥 다이브");
        });
        it('expands "deep-dive" to include Korean variant', () => {
            const result = expandTriggers(["deep-dive"]);
            expect(result).toContain("deep-dive");
            expect(result).toContain("딥다이브");
        });
        it('does not expand "autopilot" (handled by keyword-detector)', () => {
            const result = expandTriggers(["autopilot"]);
            expect(result).toEqual(["autopilot"]);
        });
        it('does not expand "ralph" (handled by keyword-detector)', () => {
            const result = expandTriggers(["ralph"]);
            expect(result).toEqual(["ralph"]);
        });
        it('does not expand "cancel" (handled by keyword-detector)', () => {
            const result = expandTriggers(["cancel"]);
            expect(result).toEqual(["cancel"]);
        });
        it("passes through unknown triggers unchanged", () => {
            const result = expandTriggers(["unknown-trigger"]);
            expect(result).toEqual(["unknown-trigger"]);
        });
    });
    // ---------------------------------------------------------------------------
    // Section 2: Multi-trigger expansion
    // ---------------------------------------------------------------------------
    describe("multi-trigger expansion", () => {
        it('expands ["deep dive", "deep-dive"] preserving originals and adding Korean', () => {
            const result = expandTriggers(["deep dive", "deep-dive"]);
            expect(result).toContain("deep dive");
            expect(result).toContain("deep-dive");
            expect(result).toContain("딥다이브");
            expect(result).toContain("딥 다이브");
        });
        it("preserves all originals and expands mapped ones alongside unknown ones", () => {
            const result = expandTriggers([
                "deep dive",
                "unknown",
                "configure notifications",
            ]);
            expect(result).toContain("deep dive");
            expect(result).toContain("unknown");
            expect(result).toContain("configure notifications");
            expect(result).toContain("딥다이브");
            expect(result).toContain("딥 다이브");
            // configure-notifications entries removed (too generic, false-positive risk)
            expect(result).not.toContain("알림 설정");
            expect(result).not.toContain("노티 설정");
        });
        it('expands "trace and interview" to loanword transliteration only', () => {
            const result = expandTriggers(["trace and interview"]);
            expect(result).toContain("trace and interview");
            expect(result).toContain("트레이스 앤 인터뷰");
            // native Korean translations are excluded
            expect(result).not.toContain("추적 인터뷰");
        });
        it('does not expand "investigate deeply" (native Korean translation — removed)', () => {
            const result = expandTriggers(["investigate deeply"]);
            expect(result).toEqual(["investigate deeply"]);
        });
    });
    // ---------------------------------------------------------------------------
    // Section 3: deep-pipeline triggers
    // ---------------------------------------------------------------------------
    describe("deep-pipeline triggers", () => {
        it('expands "deep-pipeline"', () => {
            const result = expandTriggers(["deep-pipeline"]);
            expect(result).toContain("딥파이프라인");
            expect(result).toContain("딥 파이프라인");
        });
        it('expands "deep-pipe"', () => {
            const result = expandTriggers(["deep-pipe"]);
            expect(result).toContain("딥파이프");
        });
        it('expands "pipeline-cycle"', () => {
            const result = expandTriggers(["pipeline-cycle"]);
            expect(result).toContain("파이프라인 사이클");
        });
        it('expands "dev-pipeline"', () => {
            const result = expandTriggers(["dev-pipeline"]);
            expect(result).toContain("개발 파이프라인");
        });
        it('expands "dev-cycle"', () => {
            const result = expandTriggers(["dev-cycle"]);
            expect(result).toContain("개발 사이클");
        });
    });
    // ---------------------------------------------------------------------------
    // Section 5: Deduplication
    // ---------------------------------------------------------------------------
    describe("deduplication", () => {
        it('deduplicates "딥다이브" when both "deep dive" and "deep-dive" are given', () => {
            const result = expandTriggers(["deep dive", "deep-dive"]);
            const count = result.filter((t) => t === "딥다이브").length;
            expect(count).toBe(1);
        });
    });
    // ---------------------------------------------------------------------------
    // Section 6: Edge cases
    // ---------------------------------------------------------------------------
    describe("edge cases", () => {
        it("returns [] for empty input", () => {
            expect(expandTriggers([])).toEqual([]);
        });
        it("passes through empty string", () => {
            const result = expandTriggers([""]);
            expect(result).toContain("");
        });
        it("always preserves all original triggers in output", () => {
            const inputs = ["deep dive", "deep-pipeline", "unknown-xyz"];
            const result = expandTriggers(inputs);
            for (const trigger of inputs) {
                expect(result).toContain(trigger);
            }
        });
        it("output length is always >= input length", () => {
            const cases = [
                [],
                ["deep dive"],
                ["unknown"],
                ["deep dive", "deep-pipeline"],
                ["ralph", "cancel"],
            ];
            for (const input of cases) {
                expect(expandTriggers(input).length).toBeGreaterThanOrEqual(input.length);
            }
        });
    });
    // ---------------------------------------------------------------------------
    // Section 7: Keyword-detector boundary — no leakage
    // ---------------------------------------------------------------------------
    describe("keyword-detector boundary — no leakage", () => {
        const keywordDetectorEntries = [
            "autopilot",
            "ralph",
            "cancel",
            "ultrawork",
            "ralplan",
            "tdd",
            "ccg",
        ];
        for (const trigger of keywordDetectorEntries) {
            it(`does not expand "${trigger}" (keyword-detector scope)`, () => {
                const result = expandTriggers([trigger]);
                expect(result).toEqual([trigger]);
            });
        }
    });
    // ---------------------------------------------------------------------------
    // Section 8: Performance
    // ---------------------------------------------------------------------------
    describe("performance", () => {
        it("completes 1000 calls with 10 triggers each in under 100ms", () => {
            const triggers = [
                "deep dive",
                "deep-dive",
                "trace and interview",
                "deep-pipeline",
                "deep-pipe",
                "pipeline-cycle",
                "dev-pipeline",
                "dev-cycle",
                "unknown-trigger",
            ];
            const start = performance.now();
            for (let i = 0; i < 1000; i++) {
                expandTriggers(triggers);
            }
            const elapsed = performance.now() - start;
            expect(elapsed).toBeLessThan(100);
        });
    });
});
//# sourceMappingURL=transliteration-map.test.js.map