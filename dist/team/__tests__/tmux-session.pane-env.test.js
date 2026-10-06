import { spawnSync } from 'child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'fs';
import { dirname } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerPaneShellCommand } from '../tmux-session.js';
const SECRET = 'issue-4230-secret-sentinel';
const posix = process.platform !== 'win32';
describe.skipIf(!posix)('worker pane env passthrough stays off the command line (#4230)', () => {
    const cleanup = [];
    afterEach(() => {
        vi.unstubAllEnvs();
        for (const path of cleanup.splice(0))
            rmSync(path, { recursive: true, force: true });
    });
    it('keeps passthrough values out of argv and delivers them through a private file', () => {
        vi.stubEnv('OMC_TEAM_WORKER_ENV_PASSTHROUGH', 'OMC_4230_TOKEN');
        vi.stubEnv('OMC_4230_TOKEN', SECRET);
        const pane = workerPaneShellCommand();
        expect(pane.envFile).not.toBeNull();
        cleanup.push(dirname(pane.envFile));
        const command = pane.args.join(' ');
        expect(command).toContain('/usr/bin/env -i');
        expect(command).not.toContain(SECRET);
        expect(command).not.toContain('OMC_4230_TOKEN');
        expect(statSync(pane.envFile).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(pane.envFile)).mode & 0o777).toBe(0o700);
        expect(readFileSync(pane.envFile, 'utf8')).toBe(`export OMC_4230_TOKEN='${SECRET}'\n`);
    });
    it('the built pane command gives the shell the passthrough value, removes the file, and keeps the env -i baseline', () => {
        vi.stubEnv('OMC_TEAM_WORKER_ENV_PASSTHROUGH', 'OMC_4230_TOKEN');
        vi.stubEnv('OMC_4230_TOKEN', `${SECRET} with 'quotes' and $dollar`);
        vi.stubEnv('OMC_4230_LEADER_ONLY', 'must-not-leak');
        const pane = workerPaneShellCommand();
        cleanup.push(dirname(pane.envFile));
        // tmux runs the pane command through `sh -c`; the login shell then reads `env` from stdin.
        const run = spawnSync('/bin/sh', ['-c', pane.args.join(' ')], { encoding: 'utf8', env: process.env, input: 'env\n' });
        expect(run.status).toBe(0);
        const env = run.stdout.split('\n');
        expect(env).toContain(`OMC_4230_TOKEN=${SECRET} with 'quotes' and $dollar`);
        expect(env.some(line => line.startsWith('OMC_4230_LEADER_ONLY='))).toBe(false);
        expect(env.some(line => line.startsWith('OMC_PANE_ENV_FILE='))).toBe(false);
        expect(existsSync(dirname(pane.envFile))).toBe(false);
    });
    it('writes no file and inlines only the baseline when nothing is passed through', () => {
        vi.stubEnv('OMC_TEAM_WORKER_ENV_PASSTHROUGH', '');
        const pane = workerPaneShellCommand();
        expect(pane.envFile).toBeNull();
        expect(pane.args.join(' ')).toContain('/usr/bin/env -i');
        expect(pane.args.join(' ')).not.toContain('OMC_PANE_ENV_FILE');
    });
});
//# sourceMappingURL=tmux-session.pane-env.test.js.map