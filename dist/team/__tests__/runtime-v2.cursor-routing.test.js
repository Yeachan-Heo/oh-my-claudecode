import { describe, expect, it } from 'vitest';
import { resolveTaskAssignment } from '../runtime-v2.js';
import { buildResolvedRoutingSnapshot } from '../stage-router.js';
const resolvedRouting = buildResolvedRoutingSnapshot({});
const binaries = {
    claude: '/usr/bin/claude',
    cursor: '/usr/bin/cursor-agent',
};
describe('runtime-v2 Cursor task assignment guard', () => {
    it('keeps inferred executor-style implementation tasks on cursor', () => {
        const assignment = resolveTaskAssignment({ subject: 'Implement plan', description: 'apply the implementation plan', }, resolvedRouting, undefined, binaries, 'cursor');
        expect(assignment).toEqual({ agentType: 'cursor', model: '', role: 'executor' });
    });
    it('keeps unowned cursor build-test-fix executor contexts on cursor', () => {
        const cases = [
            'fix failing tests',
            'fix the build error',
            'debug the failing test runner',
            'refactor the parser implementation',
            'verify tests after patching the build',
        ];
        for (const description of cases) {
            const assignment = resolveTaskAssignment({ subject: description, description }, resolvedRouting, undefined, binaries, 'cursor');
            expect(assignment).toEqual({ agentType: 'cursor', model: '', role: 'executor' });
        }
    });
    it('keeps explicit cursor executor tasks on cursor', () => {
        const assignment = resolveTaskAssignment({ subject: 'Executor task', description: 'apply the implementation plan', role: 'executor' }, resolvedRouting, undefined, binaries, 'cursor');
        expect(assignment).toEqual({ agentType: 'cursor', model: '', role: 'executor' });
    });
    it('rejects inferred review/security/verdict-style roles for cursor workers', () => {
        const cases = [
            { subject: 'Review auth', description: 'review the auth module for maintainability' },
            { subject: 'Security review', description: 'review auth for vulnerabilities and injection issues' },
            { subject: 'Validation verdict', description: 'verify tests and provide final verdict' },
        ];
        for (const task of cases) {
            expect(() => resolveTaskAssignment(task, resolvedRouting, undefined, binaries, 'cursor')).toThrow(/Cursor workers are executor-style only/);
        }
    });
});
//# sourceMappingURL=runtime-v2.cursor-routing.test.js.map