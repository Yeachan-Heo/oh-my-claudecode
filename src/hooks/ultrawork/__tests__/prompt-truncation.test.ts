/**
 * Regression tests for issue #2971
 *
 * Stop-hook feedback for ultrawork must not reinject the cached original_prompt
 * on every stop event. A live objective may be echoed, but only as a concise
 * current objective.
 */
import { describe, it, expect } from 'vitest';
import {
  getUltraworkPersistenceMessage,
  type UltraworkState,
} from '../index.js';

function makeState(originalPrompt: string, overrides: Partial<UltraworkState> = {}): UltraworkState {
  return {
    active: true,
    started_at: new Date().toISOString(),
    original_prompt: originalPrompt,
    reinforcement_count: 0,
    last_checked_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('getUltraworkPersistenceMessage — safe objective echo (issue #2971)', () => {
  it('does not echo the cached original prompt, even when it is short', () => {
    const state = makeState('Fix the login bug');
    const msg = getUltraworkPersistenceMessage(state);
    expect(msg).not.toContain('Fix the login bug');
    expect(msg).not.toContain('Original task:');
  });

  it('does NOT embed the full long original prompt anywhere in the message', () => {
    const long = 'x'.repeat(500);
    const state = makeState(long);
    const msg = getUltraworkPersistenceMessage(state);
    expect(msg).not.toContain(long);
    expect(msg).not.toContain('Original task:');
  });

  it('echoes a live current objective with a distinct label', () => {
    const state = makeState('Original activation prompt', {
      current_objective: 'Fix issue #2971 Stop-hook reinforcement',
    });
    const msg = getUltraworkPersistenceMessage(state);
    expect(msg).toContain('Current objective: Fix issue #2971 Stop-hook reinforcement');
    expect(msg).not.toContain('Original activation prompt');
  });

  it('truncates a long live objective and appends ellipsis', () => {
    const liveObjective = 'Implement '.repeat(40);
    const state = makeState('Original activation prompt', {
      task_summary: liveObjective,
    });
    const msg = getUltraworkPersistenceMessage(state);

    const match = msg.match(/Current objective: (.+)/);
    expect(match).not.toBeNull();
    const echoed = match![1];
    expect([...echoed].length).toBeLessThanOrEqual(141);
    expect(echoed.endsWith('…')).toBe(true);
    expect(msg).not.toContain(liveObjective);
  });

  it('surfaces cancel guidance in the persistence message', () => {
    const state = makeState('Original activation prompt');
    const msg = getUltraworkPersistenceMessage(state);
    expect(msg).toContain('/oh-my-claudecode:cancel');
  });
});
