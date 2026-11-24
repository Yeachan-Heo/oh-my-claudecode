import { describe, it, expect } from 'vitest';
import { decideNextStage, gradeGate, normalizeRouteTable, MAX_VERIFY_COMMANDS } from '../routing.js';
const table = {
    'success:harbor-passed': { stage: 'pr', skill: 'pr' },
    'success:*': { stage: 'next', skill: 'default-next' },
    'failed:budget-exhausted': { stage: 'stopped', skill: 'alert-human' },
};
describe('decideNextStage', () => {
    it('matches the exact outcome+reason key', () => {
        expect(decideNextStage('success', 'harbor-passed', table)).toEqual({ stage: 'pr', skill: 'pr' });
        expect(decideNextStage('failed', 'budget-exhausted', table)).toEqual({ stage: 'stopped', skill: 'alert-human' });
    });
    it('falls back to the outcome wildcard', () => {
        expect(decideNextStage('success', 'unheard-reason', table)).toEqual({ stage: 'next', skill: 'default-next' });
    });
    it('returns null when nothing matches', () => {
        expect(decideNextStage('failed', 'unheard-reason', table)).toBeNull();
        expect(decideNextStage('needs-human', 'anything', {})).toBeNull();
    });
    it('is pure: same inputs, same output, table unmutated', () => {
        const snapshot = JSON.stringify(table);
        const first = decideNextStage('success', 'harbor-passed', table);
        const second = decideNextStage('success', 'harbor-passed', table);
        expect(first).toEqual(second);
        expect(JSON.stringify(table)).toBe(snapshot);
    });
});
const allClear = { irreversibleOrExternal: false, precedentSetting: false, valueJudgment: false, mechanicalChecksPassed: true };
const factPerCriterion = {
    irreversibleOrExternal: { ...allClear, irreversibleOrExternal: true },
    precedentSetting: { ...allClear, precedentSetting: true },
    valueJudgment: { ...allClear, valueJudgment: true },
};
describe('gradeGate — human-only gates', () => {
    it('keeps intent acceptance human with no auto channel', () => {
        expect(gradeGate('intent-accept', allClear)).toEqual({ kind: 'human', criterion: expect.stringContaining('保留人闸') });
    });
    it('keeps review approval human even with all criteria clear', () => {
        expect(gradeGate('review-approve', allClear)).toEqual({ kind: 'human', criterion: expect.stringContaining('判据一') });
    });
});
describe('gradeGate — tiered gates', () => {
    it('auto-passes spec approval when no criterion fires and mechanical checks pass', () => {
        expect(gradeGate('spec-approve', allClear)).toEqual({ kind: 'auto-pass', signerFact: expect.stringContaining('分级判据均未触发') });
    });
    it('auto-passes harbor review the same way', () => {
        expect(gradeGate('harbor-review', allClear)).toEqual({ kind: 'auto-pass', signerFact: expect.stringContaining('自动过') });
    });
    it.each(Object.entries(factPerCriterion))('escalates spec approval to human when %s fires', (fact, facts) => {
        expect(gradeGate('spec-approve', facts)).toEqual({ kind: 'human', criterion: expect.stringContaining('判据') });
    });
    it.each(Object.entries(factPerCriterion))('escalates harbor review to human when %s fires', (fact, facts) => {
        expect(gradeGate('harbor-review', facts)).toEqual({ kind: 'human', criterion: expect.stringContaining('判据') });
    });
    it('escalates when mechanical checks fail even with no criterion fired', () => {
        expect(gradeGate('spec-approve', { ...allClear, mechanicalChecksPassed: false })).toEqual({ kind: 'human', criterion: expect.stringContaining('机械验证项') });
        expect(gradeGate('harbor-review', { ...allClear, mechanicalChecksPassed: false })).toEqual({ kind: 'human', criterion: expect.stringContaining('机械验证项') });
    });
});
describe('normalizeRouteTable', () => {
    it('keeps well-formed outcome:reason directives', () => {
        expect(normalizeRouteTable({ 'success:*': { stage: 'launch', skill: 'launch' } }))
            .toEqual({ 'success:*': { stage: 'launch', skill: 'launch' } });
    });
    it('rejects a nested group, whose keys carry no colon', () => {
        const nested = { success: { other: { stage: 'launch', skill: 'launch' } } };
        expect(normalizeRouteTable(nested)).toBeNull();
        expect(decideNextStage('success', 'other', nested)).toBeNull();
    });
    it('rejects non-object input', () => {
        expect(normalizeRouteTable(null)).toBeNull();
        expect(normalizeRouteTable(undefined)).toBeNull();
        expect(normalizeRouteTable('success:*')).toBeNull();
        expect(normalizeRouteTable(42)).toBeNull();
        expect(normalizeRouteTable([{ stage: 'a', skill: 'b' }])).toBeNull();
    });
    it('returns an authoritative empty table for an empty object', () => {
        expect(normalizeRouteTable({})).toEqual({});
    });
    it('drops malformed directives but keeps the valid ones', () => {
        const mixed = {
            'success:*': { stage: 'launch', skill: 'launch' },
            success: { other: { stage: 'x', skill: 'y' } },
            'failed:*': { stage: 'terminal' },
            'needs-human:*': 'not-an-object',
        };
        expect(normalizeRouteTable(mixed)).toEqual({ 'success:*': { stage: 'launch', skill: 'launch' } });
    });
    it('keeps plain declared verify commands on the directive', () => {
        expect(normalizeRouteTable({ 'success:other': { stage: 'launch', skill: 'launch', verify: ['npm test', 'npm run build', 'npx vitest run'] } }))
            .toEqual({ 'success:other': { stage: 'launch', skill: 'launch', verify: ['npm test', 'npm run build', 'npx vitest run'] } });
    });
    it('drops verify commands that would split the allowlist or smuggle shell syntax', () => {
        // The allowlist value is comma-separated and lands in spawn argv: a comma
        // splits one entry into two, and metacharacters or a leading option dash
        // would escape the declared command. Both are dropped silently.
        const hostile = {
            'success:other': {
                stage: 'launch',
                skill: 'launch',
                verify: ['npm test && rm -rf /', 'npm test,Write', '--dangerously-skip-permissions', 'npm test;whoami', '$(whoami)', 'a'.repeat(121)],
            },
        };
        expect(normalizeRouteTable(hostile)).toEqual({ 'success:other': { stage: 'launch', skill: 'launch' } });
    });
    it('caps the verify list at the declared maximum', () => {
        const many = { 'success:other': { stage: 'launch', skill: 'launch', verify: Array.from({ length: 14 }, (_, index) => `npm run check${index}`) } };
        expect(normalizeRouteTable(many)?.['success:other']?.verify).toHaveLength(MAX_VERIFY_COMMANDS);
    });
    it('omits the verify key when the list is missing, non-array, or empty of valid entries', () => {
        expect(normalizeRouteTable({ 'success:other': { stage: 'a', skill: 'b' } })?.['success:other']).toEqual({ stage: 'a', skill: 'b' });
        expect(normalizeRouteTable({ 'success:other': { stage: 'a', skill: 'b', verify: 'npm test' } })?.['success:other']).toEqual({ stage: 'a', skill: 'b' });
        expect(normalizeRouteTable({ 'success:other': { stage: 'a', skill: 'b', verify: [] } })?.['success:other']).toEqual({ stage: 'a', skill: 'b' });
    });
});
describe('gradeGate diff-first', () => {
    it('review-approve with diffAttached:false grades human with the diff criterion', () => {
        const facts = { irreversibleOrExternal: false, precedentSetting: false, valueJudgment: false, mechanicalChecksPassed: true, diffAttached: false };
        const v = gradeGate('review-approve', facts);
        expect(v.kind).toBe('human');
        if (v.kind === 'human')
            expect(v.criterion).toContain('diff');
    });
    it('review-approve without a diffAttached declaration still grades human (structural)', () => {
        const facts = { irreversibleOrExternal: false, precedentSetting: false, valueJudgment: false, mechanicalChecksPassed: true };
        const v = gradeGate('review-approve', facts);
        expect(v.kind).toBe('human');
    });
    it('other gates are unaffected by diffAttached', () => {
        const facts = { irreversibleOrExternal: false, precedentSetting: false, valueJudgment: false, mechanicalChecksPassed: true, diffAttached: true };
        const v = gradeGate('spec-approve', facts);
        expect(v.kind).toBe('auto-pass');
    });
});
//# sourceMappingURL=routing.test.js.map