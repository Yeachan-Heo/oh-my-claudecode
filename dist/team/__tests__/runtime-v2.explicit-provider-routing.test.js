import { describe, expect, it } from 'vitest';
import { resolveTaskAssignment } from '../runtime-v2.js';
import { buildResolvedRoutingSnapshot } from '../stage-router.js';
const resolvedRouting = buildResolvedRoutingSnapshot({});
describe('runtime-v2 explicit provider + role preservation', () => {
    // Regression: `1:antigravity:executor` must launch antigravity, not silently fall
    // back to the default executor primary (Claude) just because a role was supplied.
    it('keeps an explicit antigravity provider when a role suffix is used (no role routing config)', () => {
        const assignment = resolveTaskAssignment({ subject: 'Executor task', description: 'apply the implementation', role: 'executor' }, resolvedRouting, undefined, 'antigravity');
        expect(assignment).toEqual({ agentType: 'antigravity', model: '', role: 'executor' });
    });
    it('preserves other explicit CLI providers + role too (e.g. gemini:reviewer)', () => {
        const assignment = resolveTaskAssignment({ subject: 'Review', description: 'review the change', role: 'reviewer' }, resolvedRouting, undefined, 'gemini');
        expect(assignment.agentType).toBe('gemini');
        // 'reviewer' normalizes to the canonical 'code-reviewer' role.
        expect(assignment.role).toBe('code-reviewer');
    });
    it('still routes a role-only spec (default claude provider) normally', () => {
        const assignment = resolveTaskAssignment({ subject: 'Executor task', description: 'apply the implementation', role: 'executor' }, resolvedRouting, undefined, 'claude', false);
        expect(assignment.agentType).toBe('claude');
        expect(assignment.role).toBe('executor');
    });
    it.each(['gemini', 'claude'])('keeps an explicit %s provider when roleRouting conflicts', (provider) => {
        const roleRouting = { executor: { provider: 'codex' } };
        const routing = buildResolvedRoutingSnapshot({ team: { roleRouting } });
        const assignment = resolveTaskAssignment({ subject: 'Executor task', description: 'apply the implementation', role: 'executor' }, routing, roleRouting, provider, true);
        expect(assignment).toEqual({ agentType: provider, model: '', role: 'executor' });
    });
    it('applies roleRouting when the provider was omitted', () => {
        const roleRouting = { executor: { provider: 'codex' } };
        const routing = buildResolvedRoutingSnapshot({ team: { roleRouting } });
        const assignment = resolveTaskAssignment({ subject: 'Executor task', description: 'apply the implementation', role: 'executor' }, routing, roleRouting, 'claude', false);
        expect(assignment.agentType).toBe('codex');
    });
});
//# sourceMappingURL=runtime-v2.explicit-provider-routing.test.js.map