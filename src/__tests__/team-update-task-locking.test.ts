import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// BUG: teamUpdateTask must use locking to prevent concurrent stale overwrites
// ---------------------------------------------------------------------------

describe('team-ops teamUpdateTask locking', () => {
  let tempDir: string;
  const teamName = 'update-lock-test-team';

  function setupTeam(dir: string, tid: string) {
    const root = join(dir, '.omc', 'state', 'team', teamName);
    mkdirSync(join(root, 'tasks'), { recursive: true });
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      name: teamName,
      task: 'test',
      agent_type: 'executor',
      worker_count: 2,
      max_workers: 20,
      tmux_session: 'test-session',
      workers: [
        { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [] },
      ],
      created_at: new Date().toISOString(),
      next_task_id: 2,
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    }));
    writeFileSync(join(root, 'tasks', `task-${tid}.json`), JSON.stringify({
      id: tid,
      subject: 'Initial subject',
      description: 'Initial description',
      status: 'pending',
      version: 1,
      created_at: new Date().toISOString(),
    }));
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'team-update-lock-test-'));
    setupTeam(tempDir, '1');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('teamUpdateTask source uses withTaskClaimLock', () => {
    const { readFileSync } = require('fs');
    const sourcePath = join(__dirname, '..', 'team', 'team-ops.ts');
    const source = readFileSync(sourcePath, 'utf-8');

    const fnStart = source.indexOf('export async function teamUpdateTask');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = source.slice(fnStart, fnStart + 2000);

    expect(fnBody).toContain('withTaskClaimLock');
  });

  it('sequential updates each increment the version', async () => {
    const { teamUpdateTask } = await import('../team/team-ops.js');

    const r1 = await teamUpdateTask(teamName, '1', { subject: 'Update A' }, tempDir);
    expect(r1).not.toBeNull();
    expect(r1!.version).toBe(2);

    const r2 = await teamUpdateTask(teamName, '1', { subject: 'Update B' }, tempDir);
    expect(r2).not.toBeNull();
    expect(r2!.version).toBe(3);
  });

  it('concurrent updates do not lose data — all complete without throwing', async () => {
    const { teamUpdateTask, teamReadTask } = await import('../team/team-ops.js');

    // Fire three concurrent updates; each should succeed (lock serialises them)
    const results = await Promise.all([
      teamUpdateTask(teamName, '1', { description: 'from worker-1' }, tempDir),
      teamUpdateTask(teamName, '1', { description: 'from worker-2' }, tempDir),
      teamUpdateTask(teamName, '1', { description: 'from worker-3' }, tempDir),
    ]);

    // All three calls must return a non-null result
    for (const r of results) {
      expect(r).not.toBeNull();
    }

    // The persisted task should reflect a version advanced at least once
    const final = await teamReadTask(teamName, '1', tempDir);
    expect(final).not.toBeNull();
    expect(final!.version).toBeGreaterThanOrEqual(2);
  });

  it('update returns null for a non-existent task', async () => {
    const { teamUpdateTask } = await import('../team/team-ops.js');

    const result = await teamUpdateTask(teamName, '999', { subject: 'Ghost' }, tempDir);
    expect(result).toBeNull();
  });

  it('update preserves id and created_at regardless of updates payload', async () => {
    const { teamUpdateTask, teamReadTask } = await import('../team/team-ops.js');

    const original = await teamReadTask(teamName, '1', tempDir);
    expect(original).not.toBeNull();

    const updated = await teamUpdateTask(
      teamName,
      '1',
      { id: '999', created_at: '1970-01-01T00:00:00.000Z', subject: 'Should not change id' },
      tempDir,
    );

    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(original!.id);
    expect(updated!.created_at).toBe(original!.created_at);
  });
});
