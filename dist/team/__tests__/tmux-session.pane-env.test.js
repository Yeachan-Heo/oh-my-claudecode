import { spawnSync } from 'child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmuxCmdAsync } from '../../cli/tmux-utils.js';
import { resolveRuntimeCliPath } from '../runtime-owner-client.js';
import { currentStrictProcessStartIdentity } from '../team-owner-epoch.js';
import { splitTeamWorkerPaneWithEvidence, workerPaneShellCommand } from '../tmux-session.js';
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});
vi.mock('../../cli/tmux-utils.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, tmuxCmdAsync: vi.fn() };
});
vi.mock('../runtime-owner-client.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, resolveRuntimeCliPath: vi.fn() };
});
const SECRET = 'issue-4230-secret-sentinel';
const posix = process.platform !== 'win32';
const strictProcessStartedAt = currentStrictProcessStartIdentity();
describe.skipIf(!posix || !strictProcessStartedAt)('split worker pane env-file-cleanup', () => {
    const identity = {
        socket_path: '/tmp/omc-pane-env-test.sock',
        server_pid: process.pid,
        process_started_at: strictProcessStartedAt,
    };
    const dependencies = {
        tmuxQuery: async () => ({ stdout: `${process.pid}\n`, stderr: '' }),
        processIdentity: () => strictProcessStartedAt,
        processObservation: () => 'matching',
    };
    function writtenEnvFile() {
        const writes = vi.mocked(writeFileSync).mock.calls.filter(([, body]) => typeof body === 'string' && body.includes('export OMC_4230_TOKEN='));
        expect(writes).toHaveLength(1);
        return String(writes[0][0]);
    }
    function expectEnvFileWritten() {
        const envFile = writtenEnvFile();
        expect(existsSync(envFile)).toBe(true);
        expect(readFileSync(envFile, 'utf8')).toBe(`export OMC_4230_TOKEN='${SECRET}'\n`);
    }
    beforeEach(() => {
        vi.mocked(writeFileSync).mockClear();
        vi.mocked(tmuxCmdAsync).mockReset();
        vi.mocked(resolveRuntimeCliPath).mockReset().mockReturnValue(process.execPath);
        vi.stubEnv('OMC_TEAM_WORKER_ENV_PASSTHROUGH', 'OMC_4230_TOKEN');
        vi.stubEnv('OMC_4230_TOKEN', SECRET);
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        for (const [path, body] of vi.mocked(writeFileSync).mock.calls) {
            if (typeof body === 'string' && body.includes('export OMC_4230_TOKEN=')) {
                rmSync(dirname(String(path)), { recursive: true, force: true });
            }
        }
        vi.mocked(writeFileSync).mockClear();
        vi.mocked(tmuxCmdAsync).mockReset();
        vi.mocked(resolveRuntimeCliPath).mockReset();
    });
    it('discards the env-passthrough file when the guarded split is not_executed', async () => {
        vi.mocked(tmuxCmdAsync).mockImplementation(async (args) => {
            expect(args).toEqual(expect.arrayContaining(['if-shell']));
            const splitCommand = args.find(arg => arg.includes('split-window'));
            expect(splitCommand).toContain('OMC_PANE_ENV_FILE=');
            expect(splitCommand).toContain(writtenEnvFile());
            expectEnvFileWritten();
            const failureMarker = args.at(-1).match(/OMC_TMUX_GUARD_FAIL_OMC_TMUX_GUARD_OK_[A-Za-z0-9_]+/)?.[0];
            expect(failureMarker).toBeDefined();
            return { stdout: `${failureMarker}\n`, stderr: '' };
        });
        const result = await splitTeamWorkerPaneWithEvidence('%732', 'right', '/tmp', 'tmux', identity, dependencies);
        expect(tmuxCmdAsync).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ commandSucceeded: false, paneId: null, stderr: '' });
        expect(result.rawOutput).toContain('OMC_TMUX_GUARD_FAIL_');
        expect(existsSync(writtenEnvFile())).toBe(false);
        expect(existsSync(dirname(writtenEnvFile()))).toBe(false);
    });
    it('discards the env-passthrough file when guarded split preparation throws', async () => {
        // Command transport rejections become outcome=unknown and retain the file.
        // A guard preparation exception reaches runPaneCreationCommand's catch.
        let envContentsBeforeThrow;
        vi.mocked(resolveRuntimeCliPath).mockImplementation(() => {
            envContentsBeforeThrow = readFileSync(writtenEnvFile(), 'utf8');
            throw new Error('guard runtime unavailable');
        });
        const result = await splitTeamWorkerPaneWithEvidence('%732', 'down', '/tmp', 'tmux', identity, dependencies);
        expect(envContentsBeforeThrow).toBe(`export OMC_4230_TOKEN='${SECRET}'\n`);
        expect(resolveRuntimeCliPath).toHaveBeenCalledTimes(1);
        expect(tmuxCmdAsync).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            commandSucceeded: false,
            paneId: null,
            stderr: 'tmux_server_guard_runtime_path_unavailable',
        });
        expect(existsSync(writtenEnvFile())).toBe(false);
        expect(existsSync(dirname(writtenEnvFile()))).toBe(false);
    });
});
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