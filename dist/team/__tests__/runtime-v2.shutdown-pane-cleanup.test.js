import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
const execFileMock = vi.hoisted(() => vi.fn());
const execMock = vi.hoisted(() => vi.fn());
const tmuxCalls = vi.hoisted(() => []);
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        exec: execMock,
        execFile: execFileMock,
    };
});
async function writeJson(cwd, relativePath, value) {
    const fullPath = join(cwd, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, JSON.stringify(value, null, 2), 'utf-8');
}
describe('shutdownTeamV2 split-pane pane cleanup', () => {
    let cwd = '';
    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-pane-cleanup-'));
        tmuxCalls.length = 0;
        execFileMock.mockReset();
        execMock.mockReset();
        const run = (args) => {
            tmuxCalls.push(args);
            let stdout = '';
            if (args[0] === 'list-panes') {
                stdout = '%1\n%2\n%3\n';
            }
            else if (args[0] === 'display-message' && args.includes('#{pane_dead}')) {
                stdout = '1\n';
            }
            return { stdout, stderr: '' };
        };
        const parseTmuxShellCmd = (cmd) => {
            const match = cmd.match(/^tmux\s+(.+)$/);
            if (!match)
                return null;
            const args = match[1].match(/'([^']*(?:\\.[^']*)*)'|"([^"]*)"/g);
            if (!args)
                return null;
            return args.map((token) => {
                if (token.startsWith("'"))
                    return token.slice(1, -1).replace(/'\\''/g, "'");
                return token.slice(1, -1);
            });
        };
        execFileMock.mockImplementation((_cmd, args, cb) => {
            const { stdout, stderr } = run(args);
            if (cb)
                cb(null, stdout, stderr);
            return {};
        });
        execFileMock[Symbol.for('nodejs.util.promisify.custom')] =
            async (_cmd, args) => run(args);
        execMock.mockImplementation((cmd, cb) => {
            const { stdout, stderr } = run(parseTmuxShellCmd(cmd) ?? []);
            cb(null, stdout, stderr);
            return {};
        });
        execMock[Symbol.for('nodejs.util.promisify.custom')] =
            async (cmd) => run(parseTmuxShellCmd(cmd) ?? []);
    });
    afterEach(async () => {
        tmuxCalls.length = 0;
        execFileMock.mockReset();
        execMock.mockReset();
        if (cwd) {
            await rm(cwd, { recursive: true, force: true });
            cwd = '';
        }
    });
    it('kills discovered split-pane worker panes beyond stale recorded pane metadata', async () => {
        const teamName = 'pane-cleanup-team';
        const teamRoot = `.omc/state/team/${teamName}`;
        await writeJson(cwd, `${teamRoot}/config.json`, {
            name: teamName,
            task: 'demo',
            agent_type: 'claude',
            worker_launch_mode: 'interactive',
            worker_count: 2,
            max_workers: 20,
            workers: [
                { name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [], pane_id: '%2' },
                { name: 'worker-2', index: 2, role: 'claude', assigned_tasks: [] },
            ],
            created_at: new Date().toISOString(),
            tmux_session: 'leader-session:0',
            tmux_window_owned: false,
            next_task_id: 1,
            leader_pane_id: '%1',
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
        });
        const { shutdownTeamV2 } = await import('../runtime-v2.js');
        await shutdownTeamV2(teamName, cwd, { timeoutMs: 0 });
        const killPaneTargets = tmuxCalls
            .filter((args) => args[0] === 'kill-pane')
            .map((args) => args[2]);
        expect(killPaneTargets).toEqual(['%2', '%3']);
        expect(killPaneTargets).not.toContain('%1');
        await expect(readFile(join(cwd, teamRoot, 'config.json'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
//# sourceMappingURL=runtime-v2.shutdown-pane-cleanup.test.js.map