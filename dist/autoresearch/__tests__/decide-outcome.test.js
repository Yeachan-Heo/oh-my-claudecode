import { describe, it, expect } from 'vitest';
import { decideAutoresearchOutcome } from '../runtime.js';
function makeCandidate(overrides = {}) {
    return {
        status: 'candidate',
        candidate_commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        base_commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        description: 'fixture candidate',
        notes: [],
        created_at: '2026-04-30T22:00:00Z',
        ...overrides,
    };
}
function makeEvaluation(overrides = {}) {
    return {
        command: 'node scripts/eval.js',
        ran_at: '2026-04-30T22:01:00Z',
        status: 'pass',
        pass: true,
        score: 0.42,
        ...overrides,
    };
}
describe('decideAutoresearchOutcome (score_improvement bootstrap)', () => {
    it('keeps the first numeric-scored pass when last_kept_score is null', () => {
        const manifest = { keep_policy: 'score_improvement', last_kept_score: null };
        const decision = decideAutoresearchOutcome(manifest, makeCandidate(), makeEvaluation({ score: 0.398459 }));
        expect(decision.decision).toBe('keep');
        expect(decision.keep).toBe(true);
        expect(decision.decisionReason).toMatch(/bootstrap/i);
        expect(decision.evaluator?.score).toBe(0.398459);
    });
    it('still discards an ambiguous pass that has no numeric score', () => {
        const manifest = { keep_policy: 'score_improvement', last_kept_score: null };
        const evaluation = makeEvaluation();
        delete evaluation.score;
        const decision = decideAutoresearchOutcome(manifest, makeCandidate(), evaluation);
        expect(decision.decision).toBe('ambiguous');
        expect(decision.keep).toBe(false);
        expect(decision.decisionReason).toMatch(/numeric score/i);
    });
    it('keeps a higher-scoring pass once a comparable baseline is set', () => {
        const manifest = { keep_policy: 'score_improvement', last_kept_score: 0.36 };
        const decision = decideAutoresearchOutcome(manifest, makeCandidate(), makeEvaluation({ score: 0.40 }));
        expect(decision.decision).toBe('keep');
        expect(decision.keep).toBe(true);
        expect(decision.decisionReason).toMatch(/score improved/i);
    });
    it('discards a pass that does not improve the kept score', () => {
        const manifest = { keep_policy: 'score_improvement', last_kept_score: 0.50 };
        const decision = decideAutoresearchOutcome(manifest, makeCandidate(), makeEvaluation({ score: 0.40 }));
        expect(decision.decision).toBe('discard');
        expect(decision.keep).toBe(false);
    });
    it('discards an evaluator failure regardless of bootstrap state', () => {
        const manifest = { keep_policy: 'score_improvement', last_kept_score: null };
        const decision = decideAutoresearchOutcome(manifest, makeCandidate(), makeEvaluation({ status: 'fail', pass: false, score: 0.10 }));
        expect(decision.decision).toBe('discard');
        expect(decision.keep).toBe(false);
    });
    it('still accepts pass_only policy without touching the bootstrap branch', () => {
        const manifest = { keep_policy: 'pass_only', last_kept_score: null };
        const decision = decideAutoresearchOutcome(manifest, makeCandidate(), makeEvaluation());
        expect(decision.decision).toBe('keep');
        expect(decision.keep).toBe(true);
        expect(decision.decisionReason).toMatch(/pass_only/i);
    });
});
//# sourceMappingURL=decide-outcome.test.js.map