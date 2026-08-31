import { describe, expect, it } from 'vitest';

import { resolveTaskAssignment } from '../runtime-v2.js';
import { buildResolvedRoutingSnapshot } from '../stage-router.js';

const resolvedRouting = buildResolvedRoutingSnapshot({});

/**
 * Cursor used to be pinned to the executor role: reviewer-style roles threw,
 * and a keyword heuristic silently rewrote inferred roles to `executor` so the
 * throw would not fire on ordinary implementation work. Both are gone (issue
 * #3880) — cursor now resolves roles the same way every other CLI provider
 * does.
 */
describe('runtime-v2 cursor task assignment', () => {
  it('keeps inferred executor-style implementation tasks on cursor', () => {
    const assignment = resolveTaskAssignment(
      { subject: 'Implement plan', description: 'apply the implementation plan' },
      resolvedRouting,
      undefined,
      'cursor',
    );

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
      const assignment = resolveTaskAssignment(
        { subject: description, description },
        resolvedRouting,
        undefined,
        'cursor',
      );

      expect(assignment.agentType).toBe('cursor');
    }
  });

  it('keeps explicit cursor executor tasks on cursor', () => {
    const assignment = resolveTaskAssignment(
      { subject: 'Executor task', description: 'apply the implementation plan', role: 'executor' },
      resolvedRouting,
      undefined,
      'cursor',
    );

    expect(assignment).toEqual({ agentType: 'cursor', model: '', role: 'executor' });
  });

  it('accepts explicit reviewer-style roles for cursor workers (issue #3880)', () => {
    for (const role of ['code-reviewer', 'critic', 'security-reviewer', 'test-engineer'] as const) {
      const assignment = resolveTaskAssignment(
        { subject: 'Review the change', description: 'inspect without editing', role },
        resolvedRouting,
        undefined,
        'cursor',
      );

      expect(assignment.agentType).toBe('cursor');
      expect(assignment.role).toBe(role);
    }
  });

  it('no longer throws on inferred review/security/verdict-style tasks (issue #3880)', () => {
    const cases = [
      { subject: 'Review auth', description: 'review the auth module for maintainability' },
      { subject: 'Security review', description: 'review auth for vulnerabilities and injection issues' },
      { subject: 'Validation verdict', description: 'verify tests and provide final verdict' },
    ];

    for (const task of cases) {
      expect(() =>
        resolveTaskAssignment(task, resolvedRouting, undefined, 'cursor'),
      ).not.toThrow();
    }
  });

  it('routes an inferred reviewer task to the role the router picked, not a coerced executor', () => {
    // The removed heuristic forced `executor` here to dodge the guard. The role
    // the router infers must now survive, or reviewer work would silently run
    // with executor guidance and never emit a verdict.
    const assignment = resolveTaskAssignment(
      { subject: 'Review auth', description: 'review the auth module for maintainability' },
      resolvedRouting,
      undefined,
      'cursor',
    );

    expect(assignment.agentType).toBe('cursor');
    expect(assignment.role).not.toBeNull();
    expect(assignment.role).not.toBe('executor');
  });
});
