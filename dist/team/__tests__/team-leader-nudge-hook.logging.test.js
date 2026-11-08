import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
const { appendTeamEventMock } = vi.hoisted(() => ({
    appendTeamEventMock: vi.fn(async () => {
        throw new Error('event write failed');
    }),
}));
vi.mock('../../team/events.js', () => ({
    appendTeamEvent: appendTeamEventMock,
}));
import { maybeNudgeLeader } from '../../hooks/team-leader-nudge-hook.js';
describe('team leader nudge hook logging', () => {
    let cwd;
    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-team-leader-nudge-logging-'));
        appendTeamEventMock.mockClear();
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
    it('logs appendTeamEvent persistence failures without failing the nudge', async () => {
        await writeJson('.omc/state/team/demo-team/config.json', {
            workers: [{ name: 'worker-1' }],
            leader_pane_id: '%1',
        });
        await writeJson('.omc/state/team/demo-team/workers/worker-1/status.json', {
            state: 'idle',
            updated_at: new Date().toISOString(),
        });
        await writeJson('.omc/state/team/demo-team/workers/worker-1/heartbeat.json', {
            alive: true,
            last_turn_at: new Date().toISOString(),
        });
        await writeJson('.omc/state/team/demo-team/tasks/task-1.json', {
            status: 'pending',
        });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
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
        expect(sent[0]).toContain('Leader nudge');
        expect(appendTeamEventMock).toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith('[omc] hooks.team-leader-nudge maybeNudgeLeader persistence failed: event write failed');
    });
});
//# sourceMappingURL=team-leader-nudge-hook.logging.test.js.map