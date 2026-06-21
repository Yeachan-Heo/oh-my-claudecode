import { describe, expect, it } from 'vitest';

import { resolveTaskAssignment } from '../runtime-v2.js';
import { buildResolvedRoutingSnapshot } from '../stage-router.js';
import type { CliAgentType } from '../model-contract.js';

const resolvedRouting = buildResolvedRoutingSnapshot({});
const binaries: Partial<Record<CliAgentType, string>> = {
  claude: '/usr/bin/claude',
  gemini: '/usr/bin/gemini',
  codex: '/usr/bin/codex',
  antigravity: '/usr/bin/agy',
};

describe('runtime-v2 explicit provider + role preservation', () => {
  // Regression: `1:antigravity:executor` must launch antigravity, not silently fall
  // back to the default executor primary (Claude) just because a role was supplied.
  it('keeps an explicit antigravity provider when a role suffix is used (no role routing config)', () => {
    const assignment = resolveTaskAssignment(
      { subject: 'Executor task', description: 'apply the implementation', role: 'executor' },
      resolvedRouting,
      undefined,
      binaries,
      'antigravity',
    );
    expect(assignment).toEqual({ agentType: 'antigravity', model: '', role: 'executor' });
  });

  it('preserves other explicit CLI providers + role too (e.g. gemini:reviewer)', () => {
    const assignment = resolveTaskAssignment(
      { subject: 'Review', description: 'review the change', role: 'reviewer' },
      resolvedRouting,
      undefined,
      binaries,
      'gemini',
    );
    expect(assignment.agentType).toBe('gemini');
    // 'reviewer' normalizes to the canonical 'code-reviewer' role.
    expect(assignment.role).toBe('code-reviewer');
  });

  it('still routes a role-only spec (default claude provider) normally', () => {
    const assignment = resolveTaskAssignment(
      { subject: 'Executor task', description: 'apply the implementation', role: 'executor' },
      resolvedRouting,
      undefined,
      binaries,
      'claude',
    );
    expect(assignment.agentType).toBe('claude');
    expect(assignment.role).toBe('executor');
  });
});
