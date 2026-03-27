import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { scaleUp } from '../scaling.js';
describe('scaleUp duplicate worker guard', () => {
    let cwd;
    afterEach(async () => {
        if (cwd)
            await rm(cwd, { recursive: true, force: true });
    });
    it('refuses to spawn a duplicate worker identity when next_worker_index collides', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-scaling-duplicate-'));
        const teamName = 'demo-team';
        const root = join(cwd, '.omc', 'state', 'team', teamName);
        await mkdir(root, { recursive: true });
        await writeFile(join(root, 'config.json'), JSON.stringify({
            name: teamName,
            task: 'demo',
            agent_type: 'claude',
            worker_launch_mode: 'interactive',
            worker_count: 1,
            max_workers: 20,
            workers: [{ name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [] }],
            created_at: new Date().toISOString(),
            tmux_session: 'demo-session:0',
            next_task_id: 2,
            next_worker_index: 1,
            leader_pane_id: '%0',
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
            team_state_root: root,
        }, null, 2), 'utf-8');
        const result = await scaleUp(teamName, 1, 'claude', [{ subject: 'demo', description: 'demo task' }], cwd, { OMC_TEAM_SCALING_ENABLED: '1' });
        expect(result.ok).toBe(false);
        if (result.ok)
            return;
        expect(result.error).toContain('refusing to spawn duplicate worker identity');
        const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf-8'));
        expect(config.workers.map((worker) => worker.name)).toEqual(['worker-1']);
    });
});
//# sourceMappingURL=scaling.test.js.map