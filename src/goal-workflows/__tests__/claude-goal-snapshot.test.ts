import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ClaudeGoalSnapshotError,
  parseClaudeGoalSnapshot,
  readClaudeGoalSnapshotInput,
  reconcileClaudeGoalSnapshot,
} from '../claude-goal-snapshot.js';

describe('claude goal snapshot reconciliation', () => {
  it('normalizes Claude /goal JSON shape with objective synonym', () => {
    const snapshot = parseClaudeGoalSnapshot({
      goal: { objective: 'Ship the feature', status: 'completed', token_budget: 1000 },
      remainingTokens: 25,
    });

    expect(snapshot.available).toBe(true);
    expect(snapshot.objective).toBe('Ship the feature');
    expect(snapshot.status).toBe('complete');
    expect(snapshot.tokenBudget).toBe(1000);
    expect(snapshot.remainingTokens).toBe(25);
  });

  it('accepts `condition` as a synonym for objective and `cleared` as cancelled', () => {
    const snapshot = parseClaudeGoalSnapshot({
      goal: { condition: 'Hold until tests pass', status: 'cleared' },
    });
    expect(snapshot.available).toBe(true);
    expect(snapshot.objective).toBe('Hold until tests pass');
    expect(snapshot.status).toBe('cancelled');
  });

  it('reports absent snapshots as warnings unless required', () => {
    const optional = reconcileClaudeGoalSnapshot(null, { expectedObjective: 'Ship' });
    expect(optional.ok).toBe(true);
    expect(optional.warnings.join('\n')).toMatch(/share the current \/goal condition/);

    const required = reconcileClaudeGoalSnapshot(null, { expectedObjective: 'Ship', requireSnapshot: true });
    expect(required.ok).toBe(false);
    expect(required.errors.join('\n')).toMatch(/share the current \/goal condition/);
  });

  it('detects objective mismatches and incomplete completion proof', () => {
    const mismatch = reconcileClaudeGoalSnapshot(
      parseClaudeGoalSnapshot({ goal: { objective: 'Different', status: 'active' } }),
      { expectedObjective: 'Expected', requireSnapshot: true, requireComplete: true },
    );

    expect(mismatch.ok).toBe(false);
    expect(mismatch.errors.join('\n')).toMatch(/objective mismatch/);
    expect(mismatch.errors.join('\n')).toMatch(/not complete/);
  });

  it('accepts compatible complete proof', () => {
    const result = reconcileClaudeGoalSnapshot(
      parseClaudeGoalSnapshot({ goal: { objective: 'Expected objective', status: 'complete' } }),
      { expectedObjective: 'Expected objective', requireSnapshot: true, requireComplete: true },
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('reads inline JSON and path input but rejects malformed sources', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-claude-goal-snapshot-'));
    try {
      const fromJson = await readClaudeGoalSnapshotInput('{"goal":{"objective":"A","status":"active"}}', cwd);
      expect(fromJson?.objective).toBe('A');

      await writeFile(join(cwd, 'goal.json'), '{"goal":{"objective":"B","status":"complete"}}');
      const fromPath = await readClaudeGoalSnapshotInput('goal.json', cwd);
      expect(fromPath?.objective).toBe('B');

      await expect(readClaudeGoalSnapshotInput('{not-json}', cwd)).rejects.toBeInstanceOf(ClaudeGoalSnapshotError);
      await expect(readClaudeGoalSnapshotInput('missing.json', cwd)).rejects.toThrow(/neither valid JSON nor a readable path/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
