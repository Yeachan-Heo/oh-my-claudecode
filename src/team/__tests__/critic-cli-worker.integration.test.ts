import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { absPath, TeamPaths } from '../state-paths.js';
import {
  activateTeamInstanceUnderLock,
  createTeamInstanceBinding,
  reserveTeamInstanceUnderLock,
  withTeamInstanceLifecycleLock,
} from '../team-instance.js';

vi.mock('../tmux-session.js', async importOriginal => ({
  ...await importOriginal<typeof import('../tmux-session.js')>(),
  getOwnedWorkerLiveness: vi.fn(async () => 'dead' as const),
}));
import { processCliWorkerVerdicts } from '../runtime-v2.js';

/**
 * AC-7 integration smoke: simulate a critic CLI worker by writing a verdict.json
 * to disk (as the codex CLI worker would on exit), then drive the post-exit
 * handler to confirm the task transitions correctly + verdict metadata persists.
 */
describe('critic CLI worker integration (AC-7)', () => {
  it('verdict.json from codex critic worker drives task to completed', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omc-critic-integration-'));
    vi.stubEnv('HOME', cwd);
    vi.stubEnv('USERPROFILE', cwd);
    vi.stubEnv('OMC_STATE_DIR', join(cwd, 'omc-state'));
    try {
      const teamName = 'critic-int';
      const instance = createTeamInstanceBinding({ teamName, cwd });
      await withTeamInstanceLifecycleLock(instance.cwd, instance.team_name, async () => {
        await reserveTeamInstanceUnderLock({ teamName, cwd, instanceId: instance.instance_id });
      });
      const teamRoot = absPath(cwd, TeamPaths.root(teamName));
      mkdirSync(join(teamRoot, 'tasks'), { recursive: true });
      mkdirSync(join(teamRoot, 'workers', 'worker-critic'), { recursive: true });

      const outputFile = join(teamRoot, 'workers', 'worker-critic', 'verdict.json');

      writeFileSync(
        join(teamRoot, 'config.json'),
        JSON.stringify(
          {
            name: teamName,
            instance_id: instance.instance_id,
            leader_cwd: cwd,
            lifecycle_state: 'active',
            task: 'integration smoke',
            agent_type: 'codex',
            worker_launch_mode: 'interactive',
            worker_count: 1,
            max_workers: 20,
            workers: [
              {
                name: 'worker-critic',
                index: 1,
                role: 'critic',
                worker_cli: 'codex',
                assigned_tasks: ['1'],
                pane_id: '%dead',
                working_dir: cwd,
                output_file: outputFile,
              },
            ],
            created_at: new Date().toISOString(),
            tmux_session: 'critic-int:0',
            tmux_server_identity: { socket_path: '/tmp/omc-test-tmux.sock', server_pid: 4242, process_started_at: 'test:1700000000' },
            leader_pane_id: '%1',
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
            next_task_id: 2,
            team_state_root: teamRoot,
            workspace_mode: 'single',
          },
          null,
          2,
        ),
        'utf-8',
      );

      const taskPath = join(teamRoot, 'tasks', 'task-1.json');
      writeFileSync(
        taskPath,
        JSON.stringify(
          {
            id: '1',
            subject: 'integration test',
            description: 'critic verdict integration',
            status: 'in_progress',
            owner: 'worker-critic',
            role: 'critic',
            created_at: new Date().toISOString(),
          },
          null,
          2,
        ),
        'utf-8',
      );

      // Simulate critic worker writing verdict before exit
      writeFileSync(
        outputFile,
        JSON.stringify({
          role: 'critic',
          task_id: '1',
          verdict: 'approve',
          summary: 'integration smoke ok',
          findings: [],
        }),
        'utf-8',
      );
      await withTeamInstanceLifecycleLock(instance.cwd, instance.team_name, async () => {
        await activateTeamInstanceUnderLock(instance);
      });

      const { readTeamConfig } = await import('../monitor.js');
      expect((await readTeamConfig(teamName, cwd))?.workers[0]?.output_file).toBe(outputFile);
      const results = await processCliWorkerVerdicts(teamName, cwd, instance.instance_id);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('completed');

      const finalTask = JSON.parse(readFileSync(taskPath, 'utf-8'));
      expect(finalTask.status).toBe('completed');
      expect(finalTask.version).toBe(2);
      expect(finalTask.metadata?.verdict).toBe('approve');
      expect(finalTask.metadata?.verdict_role).toBe('critic');
      expect(existsSync(outputFile + '.processed')).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
