import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { maybeNudgeLeader } from '../../hooks/team-leader-nudge-hook.js';
describe('team leader nudge hook', () => {
    let cwd;
    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-team-leader-nudge-'));
    });
    afterEach(async () => {
        await rm(cwd, { recursive: true, force: true });
        vi.restoreAllMocks();
    });
    async function writeJson(relativePath, value) {
        const fullPath = join(cwd, relativePath);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, JSON.stringify(value, null, 2), 'utf-8');
    }
    async function seedTeamState(options) {
        const teamRoot = '.omc/state/team/demo-team';
        await writeJson(`${teamRoot}/config.json`, {
            workers: options.workerStates.map((worker) => ({ name: worker.name })),
            leader_pane_id: '%1',
        });
        for (const worker of options.workerStates) {
            await writeJson(`${teamRoot}/workers/${worker.name}/status.json`, {
                state: worker.state,
                updated_at: new Date().toISOString(),
            });
            await writeJson(`${teamRoot}/workers/${worker.name}/heartbeat.json`, {
                alive: worker.alive ?? true,
                last_turn_at: worker.lastTurnAt ?? new Date().toISOString(),
            });
        }
        for (let index = 0; index < options.taskStatuses.length; index += 1) {
            await writeJson(`${teamRoot}/tasks/task-${index + 1}.json`, {
                status: options.taskStatuses[index],
            });
        }
    }
    it('nudges leader to reuse current team when workers are idle with active tasks', async () => {
        await seedTeamState({
            taskStatuses: ['pending', 'blocked'],
            workerStates: [
                { name: 'worker-1', state: 'idle' },
                { name: 'worker-2', state: 'done' },
            ],
        });
        const sent = [];
        const result = await maybeNudgeLeader({
            cwd,
            stateDir: join(cwd, '.omc', 'state'),
            teamName: 'demo-team',
            tmux: {
                async sendKeys(_target, text) {
                    sent.push(text);
                },
            },
        });
        expect(result.nudged).toBe(true);
        expect(result.reason).toContain('all_alive_workers_idle');
        expect(sent[0]).toContain('reuse-current-team');
        const eventsRaw = await readFile(join(cwd, '.omc', 'state', 'team', 'demo-team', 'events.jsonl'), 'utf-8');
        expect(eventsRaw).toContain('"next_action":"reuse-current-team"');
    });
    it('nudges leader to shut down when all tasks are terminal', async () => {
        await seedTeamState({
            taskStatuses: ['completed', 'completed'],
            workerStates: [
                { name: 'worker-1', state: 'idle' },
            ],
        });
        const sent = [];
        const result = await maybeNudgeLeader({
            cwd,
            stateDir: join(cwd, '.omc', 'state'),
            teamName: 'demo-team',
            tmux: {
                async sendKeys(_target, text) {
                    sent.push(text);
                },
            },
        });
        expect(result.nudged).toBe(true);
        expect(result.reason).toContain('all_tasks_terminal');
        expect(sent[0]).toContain('shutdown');
    });
});
//# sourceMappingURL=team-leader-nudge-hook.test.js.map