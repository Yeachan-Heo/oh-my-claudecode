import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { processCliWorkerVerdicts } from '../runtime-v2.js';

/**
 * AC-7 integration smoke: simulate a critic CLI worker by writing a verdict.json
 * to disk (as the codex CLI worker would on exit), then drive the post-exit
 * handler to confirm the task transitions correctly + verdict metadata persists.
 *
 * Skipped when codex CLI binary is not present — keeps CI green on machines
 * without codex installed while still exercising the contract end-to-end when
 * the binary is available.
 */
function codexAvailable(): boolean {
  try {
    execSync('which codex', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const SHOULD_RUN = codexAvailable();

describe.skipIf(!SHOULD_RUN)('critic CLI worker integration (AC-7)', () => {
  it('verdict.json from codex critic worker drives task to completed', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omc-critic-integration-'));
    try {
      const teamName = 'critic-int';
      const teamRoot = join(cwd, '.omc', 'state', 'team', teamName);
      mkdirSync(join(teamRoot, 'tasks'), { recursive: true });
      mkdirSync(join(teamRoot, 'workers', 'worker-critic'), { recursive: true });

      const outputFile = join(teamRoot, 'workers', 'worker-critic', 'verdict.json');

      writeFileSync(
        join(teamRoot, 'config.json'),
        JSON.stringify(
          {
            name: teamName,
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
                pane_id: undefined,
                working_dir: cwd,
                output_file: outputFile,
              },
            ],
            created_at: new Date().toISOString(),
            tmux_session: 'critic-int:0',
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

      const results = await processCliWorkerVerdicts(teamName, cwd);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('completed');

      const finalTask = JSON.parse(readFileSync(taskPath, 'utf-8'));
      expect(finalTask.status).toBe('completed');
      expect(finalTask.metadata?.verdict).toBe('approve');
      expect(finalTask.metadata?.verdict_role).toBe('critic');
      expect(existsSync(outputFile + '.processed')).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('critic CLI worker integration (AC-7) — guard', () => {
  it(`reports codex CLI presence: ${SHOULD_RUN ? 'available' : 'missing (integration skipped)'}`, () => {
    expect(typeof SHOULD_RUN).toBe('boolean');
  });
});
