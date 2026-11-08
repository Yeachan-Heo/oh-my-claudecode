import { describe, expect, it } from 'vitest';

import { deriveTeamLeaderGuidance } from '../leader-nudge-guidance.js';

describe('deriveTeamLeaderGuidance', () => {
  it('returns shutdown when all tasks are terminal', () => {
    const guidance = deriveTeamLeaderGuidance({
      tasks: { pending: 0, blocked: 0, inProgress: 0, completed: 3, failed: 0 },
      workers: { total: 2, alive: 2, idle: 2, nonReporting: 0 },
    });

    expect(guidance.nextAction).toBe('shutdown');
    expect(guidance.reason).toContain('all_tasks_terminal');
  });

  it('returns reuse-current-team when alive workers are idle but active tasks remain', () => {
    const guidance = deriveTeamLeaderGuidance({
      tasks: { pending: 2, blocked: 0, inProgress: 0, completed: 0, failed: 0 },
      workers: { total: 2, alive: 2, idle: 2, nonReporting: 0 },
    });

    expect(guidance.nextAction).toBe('reuse-current-team');
    expect(guidance.reason).toContain('all_alive_workers_idle');
  });

  it('returns launch-new-team when no workers are alive', () => {
    const guidance = deriveTeamLeaderGuidance({
      tasks: { pending: 1, blocked: 0, inProgress: 1, completed: 0, failed: 0 },
      workers: { total: 2, alive: 0, idle: 0, nonReporting: 0 },
    });

    expect(guidance.nextAction).toBe('launch-new-team');
    expect(guidance.reason).toContain('no_alive_workers');
  });

  it('returns keep-checking-status when workers are still active', () => {
    const guidance = deriveTeamLeaderGuidance({
      tasks: { pending: 0, blocked: 0, inProgress: 2, completed: 0, failed: 0 },
      workers: { total: 2, alive: 2, idle: 0, nonReporting: 1 },
    });

    expect(guidance.nextAction).toBe('keep-checking-status');
    expect(guidance.reason).toContain('workers_still_active');
  });
});
