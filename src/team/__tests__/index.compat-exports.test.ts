import { describe, expect, it } from 'vitest';
import {
  shouldLoadShellRc,
  validateCliBinaryPath,
  resolveCliBinaryPath,
  clearResolvedPathCache,
  LayoutStabilizer,
} from '../index.js';
import type { TeamTaskEscalation, TeamTaskV2 } from '../index.js';

describe('team index backward-compat exports', () => {
  it('re-exports legacy CLI path helpers', () => {
    expect(typeof shouldLoadShellRc).toBe('function');
    expect(typeof validateCliBinaryPath).toBe('function');
    expect(typeof resolveCliBinaryPath).toBe('function');
    expect(typeof clearResolvedPathCache).toBe('function');
  });

  it('re-exports LayoutStabilizer runtime symbol', () => {
    const instance = new LayoutStabilizer({
      sessionTarget: 'test:0',
      leaderPaneId: '%1',
      debounceMs: 1,
    });
    expect(instance).toBeInstanceOf(LayoutStabilizer);
    instance.dispose();
  });

  // a type-only export: the check is that this file compiles (tsc), a consumer of the `./team` entry point imports it the same way
  it('re-exports the escalation type of a task through the public team entry point', () => {
    const escalation: TeamTaskEscalation = { lane: 'architecture', source: 'terminal_result', recorded_at: '2026-01-01T00:00:00.000Z' };
    const task: Pick<TeamTaskV2, 'escalation'> = { escalation };
    expect(task.escalation?.lane).toBe('architecture');
  });
});
