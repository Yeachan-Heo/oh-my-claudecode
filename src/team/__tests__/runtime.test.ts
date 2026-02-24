import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { monitorTeam } from '../runtime.js';
import type { TeamConfig } from '../runtime.js';

describe('runtime types', () => {
  it('TeamConfig has required fields', () => {
    const config: TeamConfig = {
      teamName: 'test',
      workerCount: 2,
      agentTypes: ['codex', 'gemini'],
      tasks: [{ subject: 'Task 1', description: 'Do something' }],
      cwd: '/tmp',
    };
    expect(config.teamName).toBe('test');
    expect(config.workerCount).toBe(2);
  });

  it('monitorTeam returns performance telemetry', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'team-runtime-monitor-'));
    const teamName = 'monitor-team';
    const tasksDir = join(cwd, '.omc', 'state', 'team', teamName, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, '1.json'), JSON.stringify({ status: 'pending' }), 'utf-8');
    writeFileSync(join(tasksDir, '2.json'), JSON.stringify({ status: 'completed' }), 'utf-8');

    const snapshot = await monitorTeam(teamName, cwd, []);
    expect(snapshot.taskCounts.pending).toBe(1);
    expect(snapshot.taskCounts.completed).toBe(1);
    expect(snapshot.monitorPerformance.listTasksMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.monitorPerformance.workerScanMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.monitorPerformance.totalMs).toBeGreaterThanOrEqual(snapshot.monitorPerformance.listTasksMs);

    rmSync(cwd, { recursive: true, force: true });
  });

  it('monitorTeam rejects invalid team names before path usage', async () => {
    await expect(monitorTeam('Bad-Team', '/tmp', [])).rejects.toThrow('Invalid team name');
  });
});
