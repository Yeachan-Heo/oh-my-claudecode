import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "../..");
function readProjectFile(...segments) {
    return readFileSync(join(PROJECT_ROOT, ...segments), "utf-8");
}
describe("Claude Code /goal adapter docs contract", () => {
    const adapterDoc = readProjectFile("docs", "design", "CLAUDE_CODE_GOAL_ADAPTER.md");
    const referenceDoc = readProjectFile("docs", "REFERENCE.md");
    it("documents Claude/Anthropic as the only authority for Claude Code /goal facts", () => {
        expect(adapterDoc).toContain("https://code.claude.com/docs/en/goal");
        expect(adapterDoc).toContain("https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md");
        expect(adapterDoc).toContain("they are not authority for Claude Code `/goal` facts");
    });
    it("documents the hidden-state non-mutation boundary", () => {
        expect(adapterDoc).toContain("it does not mutate hidden Claude Code goal state");
        expect(adapterDoc).toContain("instead of writing hidden Claude Code session state directly");
        expect(referenceDoc).toContain("it must not mutate hidden Claude Code session state directly");
    });
    it("locks deterministic loop conflict policy values and forbids warn-and-continue behavior", () => {
        for (const policy of ["`refuse`", "`adopt_existing`", "`artifact_only`"]) {
            expect(adapterDoc).toContain(policy);
        }
        expect(adapterDoc).toContain("must never “warn and continue”");
        expect(adapterDoc).toContain("Any unknown policy is invalid");
    });
    it("keeps evaluator success separate from OMC final completion", () => {
        expect(adapterDoc).toContain("`evaluator_passed` is not `complete`");
        expect(adapterDoc).toContain("Direct `evaluator_passed -> complete` transitions are invalid");
        expect(adapterDoc).toContain("the `/goal` evaluator judges surfaced conversation evidence");
        expect(adapterDoc).not.toContain("the evaluator independently reads files and runs commands");
    });
    it("links the adapter design from REFERENCE.md", () => {
        expect(referenceDoc).toContain("[Claude Code `/goal` Adapter Design](#claude-code-goal-adapter-design)");
        expect(referenceDoc).toContain("./design/CLAUDE_CODE_GOAL_ADAPTER.md");
    });
});
//# sourceMappingURL=claude-goal-adapter-doc.test.js.map