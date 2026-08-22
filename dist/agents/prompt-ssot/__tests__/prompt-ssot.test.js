/**
 * Tests for the prompt SSOT composer and projection digests (issue #3704).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeAll, composeProjection, PromptSsotError, } from '../compose.js';
import { digestProjection, normalizePromptText } from '../digest.js';
import { PROMPT_SSOT_MANIFEST } from '../manifest.js';
import { corpusStats, projectionDrift, tokenize } from '../metrics.js';
import { PROMPT_SECTIONS } from '../sections.js';
describe('manifest and sections integrity', () => {
    it('gives every normative clause exactly one owner and a unique id', () => {
        const ids = PROMPT_SECTIONS.map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const section of PROMPT_SECTIONS) {
            expect(section.owner.length).toBeGreaterThan(0);
            expect(section.version).toBeGreaterThanOrEqual(1);
            expect(section.body.trim().length).toBeGreaterThan(0);
        }
    });
    it('references only existing sections from every projection', () => {
        const ids = new Set(PROMPT_SECTIONS.map((s) => s.id));
        for (const spec of PROMPT_SSOT_MANIFEST.projections) {
            for (const id of spec.sections)
                expect(ids.has(id), id).toBe(true);
        }
        for (const id of PROMPT_SSOT_MANIFEST.requiredSections) {
            expect(ids.has(id), id).toBe(true);
        }
    });
    it('declares Tier-0 role projections for planner/executor/reviewer/verifier', () => {
        const ids = PROMPT_SSOT_MANIFEST.projections.map((p) => p.id);
        for (const role of ['planner', 'executor', 'reviewer', 'verifier']) {
            expect(ids).toContain(`role-${role}`);
        }
    });
    it('declares deep-interview and ralplan as distinct Tier-0 workflow sections, not aliases', () => {
        const sectionIds = PROMPT_SECTIONS.map((s) => s.id);
        expect(sectionIds).toContain('workflow/deep-interview');
        expect(sectionIds).toContain('workflow/ralplan');
        const di = PROMPT_SECTIONS.find((s) => s.id === 'workflow/deep-interview');
        const rp = PROMPT_SECTIONS.find((s) => s.id === 'workflow/ralplan');
        expect(di.kind).toBe('workflow-delta');
        expect(rp.kind).toBe('workflow-delta');
        // They are distinct sections — not aliases of each other
        expect(di.body).not.toBe(rp.body);
        // Neither is declared as an alias of another workflow
        expect(di.body.toLowerCase()).not.toContain('alias→');
        expect(rp.body.toLowerCase()).not.toContain('alias→');
        // Coordinator projection includes both
        const coordSpec = PROMPT_SSOT_MANIFEST.projections.find((p) => p.id === 'coordinator');
        expect(coordSpec.sections).toContain('workflow/deep-interview');
        expect(coordSpec.sections).toContain('workflow/ralplan');
    });
});
describe('deterministic renderer', () => {
    it('composes byte-identical output across repeated runs', () => {
        const a = composeProjection(PROMPT_SSOT_MANIFEST, PROMPT_SECTIONS, 'coordinator');
        const b = composeProjection(PROMPT_SSOT_MANIFEST, PROMPT_SECTIONS, 'coordinator');
        expect(a.fileText).toBe(b.fileText);
        expect(a.metadata.digest).toBe(b.metadata.digest);
    });
    it('is insensitive to manifest section listing order (rank-sorted)', () => {
        const reordered = {
            ...PROMPT_SSOT_MANIFEST,
            projections: PROMPT_SSOT_MANIFEST.projections.map((p) => ({
                ...p,
                sections: [...p.sections].reverse(),
            })),
        };
        const a = composeProjection(PROMPT_SSOT_MANIFEST, PROMPT_SECTIONS, 'role-executor');
        const b = composeProjection(reordered, PROMPT_SECTIONS, 'role-executor');
        // Rank ordering dominates; within-kind order differs only if two sections
        // share a rank — executor has one section per base rank, so identical.
        expect(a.body).toBe(b.body);
    });
    it('includes schemaVersion, sourceRevision, and sha256 digest metadata', () => {
        const composed = composeProjection(PROMPT_SSOT_MANIFEST, PROMPT_SECTIONS, 'coordinator');
        expect(composed.fileText).toContain(`schemaVersion: ${PROMPT_SSOT_MANIFEST.schemaVersion}`);
        expect(composed.fileText).toContain(`sourceRevision: ${PROMPT_SSOT_MANIFEST.sourceRevision}`);
        expect(composed.fileText).toContain(`sha256: ${composed.metadata.digest}`);
        expect(composed.metadata.digest).toMatch(/^[0-9a-f]{64}$/);
    });
    it('changes the digest when any section body changes', () => {
        const mutated = PROMPT_SECTIONS.map((s) => s.id === 'safety/hard-boundaries' ? { ...s, body: `${s.body}\nExtra clause.` } : s);
        const a = composeProjection(PROMPT_SSOT_MANIFEST, PROMPT_SECTIONS, 'coordinator');
        const b = composeProjection(PROMPT_SSOT_MANIFEST, mutated, 'coordinator');
        expect(a.metadata.digest).not.toBe(b.metadata.digest);
    });
    it('rejects unknown projections and missing sections', () => {
        expect(() => composeProjection(PROMPT_SSOT_MANIFEST, PROMPT_SECTIONS, 'nope')).toThrow(PromptSsotError);
        const broken = {
            ...PROMPT_SSOT_MANIFEST,
            projections: [
                { id: 'broken', description: '', sections: ['missing/section'], acceptsOverlays: false },
            ],
        };
        expect(() => composeProjection(broken, PROMPT_SECTIONS, 'broken')).toThrow(PromptSsotError);
    });
    it('fails closed when a projection drops a required section', () => {
        const broken = {
            ...PROMPT_SSOT_MANIFEST,
            projections: [
                {
                    id: 'no-safety',
                    description: '',
                    sections: ['task-contract/verification'],
                    acceptsOverlays: false,
                },
            ],
        };
        expect(() => composeProjection(broken, PROMPT_SECTIONS, 'no-safety')).toThrow(/required section/);
    });
});
describe('provider/model overlays', () => {
    it('applies provider and model-tier deltas as data selects', () => {
        const base = composeProjection(PROMPT_SSOT_MANIFEST, PROMPT_SECTIONS, 'role-planner');
        const codexHigh = composeProjection(PROMPT_SSOT_MANIFEST, PROMPT_SECTIONS, 'role-planner', {
            provider: 'codex',
            modelTier: 'high',
        });
        expect(codexHigh.body).toContain('Provider Notes: Codex');
        expect(codexHigh.body).toContain('Model Tier: High');
        expect(codexHigh.body).not.toContain('Provider Notes: Gemini');
        expect(base.body).not.toContain('Provider Notes:');
        expect(codexHigh.metadata.digest).not.toBe(base.metadata.digest);
    });
    it('keeps normative policy text identical across overlays (no copied paragraphs)', () => {
        const claude = composeProjection(PROMPT_SSOT_MANIFEST, PROMPT_SECTIONS, 'coordinator', {
            provider: 'claude',
            modelTier: 'medium',
        });
        const gemini = composeProjection(PROMPT_SSOT_MANIFEST, PROMPT_SECTIONS, 'coordinator', {
            provider: 'gemini',
            modelTier: 'low',
        });
        const policy = PROMPT_SECTIONS.find((s) => s.id === 'safety/hard-boundaries');
        for (const line of policy.body.trim().split('\n')) {
            expect(claude.body).toContain(line);
            expect(gemini.body).toContain(line);
        }
    });
});
describe('normalization and digest primitives', () => {
    it('normalizes CRLF, trailing whitespace, and blank-line runs', () => {
        expect(normalizePromptText('a\r\nb  \n\n\n\nc\n\n')).toBe('a\nb\n\nc\n');
    });
    it('digestProjection is normalization-invariant', () => {
        expect(digestProjection('a\n\n\n\nb')).toBe(digestProjection('a\n\nb'));
    });
});
describe('metrics', () => {
    it('tokenizer is deterministic and case/punctuation-insensitive', () => {
        expect(tokenize('Hello,  WORLD\nhello')).toEqual(['hello', 'world', 'hello']);
    });
    it('reports zero projection drift for freshly composed bodies', () => {
        const composed = composeAll(PROMPT_SSOT_MANIFEST, PROMPT_SECTIONS);
        for (const p of composed) {
            expect(projectionDrift(p.body, p.body)).toBe(0);
        }
    });
    it('measures lower repeated-clause ratio in SSOT sources than legacy corpus', () => {
        const root = join(__dirname, '..', '..', '..', '..');
        const legacyFiles = ['CLAUDE.md', 'docs/CLAUDE.md', '.github/CLAUDE.md'].filter((f) => existsSync(join(root, f)));
        const agentsDir = join(root, 'agents');
        const agentTexts = existsSync(agentsDir)
            ? readdirSync(agentsDir)
                .filter((f) => f.endsWith('.md'))
                .map((f) => readFileSync(join(agentsDir, f), 'utf8'))
            : [];
        const legacy = corpusStats([
            ...legacyFiles.map((f) => readFileSync(join(root, f), 'utf8')),
            ...agentTexts,
        ]);
        const ssot = corpusStats(PROMPT_SECTIONS.map((s) => s.body));
        expect(ssot.repeatedClauseRatio).toBeLessThan(legacy.repeatedClauseRatio);
    });
});
describe('committed projections (stale-projection gate)', () => {
    it('exactly match deterministic composition, with no stray files', () => {
        const root = join(__dirname, '..', '..', '..', '..');
        const generatedDir = join(root, 'generated', 'prompt-ssot');
        const composed = composeAll(PROMPT_SSOT_MANIFEST, PROMPT_SECTIONS);
        const expectedIds = composed.map((p) => p.id).sort();
        expect(existsSync(generatedDir), 'generated/prompt-ssot missing: run npm run prompt-ssot:build').toBe(true);
        const committedIds = readdirSync(generatedDir)
            .filter((f) => f.endsWith('.md'))
            .map((f) => f.replace(/\.md$/, ''))
            .sort();
        expect(committedIds).toEqual(expectedIds);
        for (const p of composed) {
            const committed = readFileSync(join(generatedDir, `${p.id}.md`), 'utf8');
            expect(committed, `${p.id} is stale: run npm run prompt-ssot:build (expected sha256 ${p.metadata.digest})`).toBe(p.fileText);
        }
    });
});
//# sourceMappingURL=prompt-ssot.test.js.map