import { describe, expect, it } from "vitest";
import { exploreAgent, EXPLORE_PROMPT_METADATA } from "../agents/explore.js";
import { documentSpecialistAgent, DOCUMENT_SPECIALIST_PROMPT_METADATA, } from "../agents/document-specialist.js";
describe("agent guidance boundary for external research", () => {
    it("steers external literature and reference lookups away from explore", () => {
        expect(exploreAgent.description).toMatch(/document-specialist/i);
        expect(exploreAgent.description).toMatch(/literature|papers?|reference databases?/i);
        expect(EXPLORE_PROMPT_METADATA.avoidWhen).toEqual(expect.arrayContaining([
            expect.stringMatching(/external documentation, literature, or academic paper lookup/i),
            expect.stringMatching(/database\/reference\/manual lookups outside the current project/i),
        ]));
        expect(exploreAgent.prompt).toMatch(/external documentation\/literature\/reference search/i);
        expect(exploreAgent.prompt).toMatch(/academic papers, literature reviews, manuals, package references, or database\/reference lookups outside this repository/i);
    });
    it("steers external literature and reference research to document-specialist", () => {
        expect(documentSpecialistAgent.description).toMatch(/literature, academic papers, and reference\/database lookups/i);
        expect(DOCUMENT_SPECIALIST_PROMPT_METADATA.triggers).toEqual(expect.arrayContaining([
            expect.objectContaining({
                domain: "Literature and reference research",
            }),
        ]));
        expect(DOCUMENT_SPECIALIST_PROMPT_METADATA.useWhen).toEqual(expect.arrayContaining([
            expect.stringMatching(/external literature or academic papers/i),
            expect.stringMatching(/manuals, databases, or reference material outside the current project/i),
        ]));
        expect(documentSpecialistAgent.prompt).toMatch(/external literature\/paper\/reference-database research/i);
        expect(documentSpecialistAgent.prompt).toMatch(/academic papers, literature reviews, manuals, standards, external databases, and reference sites/i);
    });
    it("prefers repo docs first and can use curated docs backend with graceful fallback", () => {
        expect(DOCUMENT_SPECIALIST_PROMPT_METADATA.triggers).toEqual(expect.arrayContaining([
            expect.objectContaining({
                domain: "Project documentation",
            }),
            expect.objectContaining({
                domain: "API/framework correctness",
            }),
        ]));
        expect(DOCUMENT_SPECIALIST_PROMPT_METADATA.useWhen).toEqual(expect.arrayContaining([
            expect.stringMatching(/README\/docs\/local reference files/i),
            expect.stringMatching(/curated docs backend/i),
        ]));
        expect(documentSpecialistAgent.prompt).toMatch(/Check local repo docs first/i);
        expect(documentSpecialistAgent.prompt).toMatch(/Context Hub|chub/i);
        expect(documentSpecialistAgent.prompt).toMatch(/`chub` is unavailable|If `chub` is unavailable/i);
        expect(documentSpecialistAgent.prompt).toMatch(/fall back gracefully/i);
    });
});
//# sourceMappingURL=agent-boundary-guidance.test.js.map