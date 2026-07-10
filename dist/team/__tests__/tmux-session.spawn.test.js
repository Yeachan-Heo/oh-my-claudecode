import { beforeEach, describe, expect, it, vi } from 'vitest';
const mockedCalls = vi.hoisted(() => ({
    tmuxArgs: [],
    cmuxArgs: [],
    paneCapture: '',
    paneStatus: '0 zsh\n',
    echoOnLiteralSend: true,
    wrapLiteralCapture: false,
    insertWrapSpaces: false,
    enterSubmitsCommand: true,
    submitClearsAfterCaptures: 0,
    delayedSubmitCapturesRemaining: null,
    paneStatusAfterEnter: null,
    delayedSubmitReplacement: '',
    cmuxFailOnce: [],
    cmuxFailures: [],
}));
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    const execFileMock = vi.fn((_cmd, args, cb) => {
        mockedCalls.cmuxArgs.push(args);
        const command = args[0] ?? '';
        const failureIndex = mockedCalls.cmuxFailures.findIndex(failure => failure.command === command);
        if (failureIndex >= 0) {
            const [failure] = mockedCalls.cmuxFailures.splice(failureIndex, 1);
            const error = new Error(failure?.message ?? `cmux ${command} failed`);
            cb(error, '', failure?.message ?? `cmux ${command} failed`);
            return {};
        }
        const failIndex = mockedCalls.cmuxFailOnce.indexOf(command);
        if (failIndex >= 0) {
            mockedCalls.cmuxFailOnce.splice(failIndex, 1);
            cb(new Error(`cmux ${command} failed`), '', `cmux ${command} failed`);
            return {};
        }
        cb(null, '', '');
        return {};
    });
    const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
    execFileMock[promisifyCustom] = async (_cmd, args) => {
        mockedCalls.cmuxArgs.push(args);
        const command = args[0] ?? '';
        const failureIndex = mockedCalls.cmuxFailures.findIndex(failure => failure.command === command);
        if (failureIndex >= 0) {
            const [failure] = mockedCalls.cmuxFailures.splice(failureIndex, 1);
            throw new Error(failure?.message ?? `cmux ${command} failed`);
        }
        const failIndex = mockedCalls.cmuxFailOnce.indexOf(command);
        if (failIndex >= 0) {
            mockedCalls.cmuxFailOnce.splice(failIndex, 1);
            throw new Error(`cmux ${command} failed`);
        }
        return { stdout: '', stderr: '' };
    };
    return {
        ...actual,
        execFile: execFileMock,
    };
});
vi.mock('../../cli/tmux-utils.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        tmuxExec: vi.fn((args) => {
            mockedCalls.tmuxArgs.push(args);
            return '';
        }),
        tmuxExecAsync: vi.fn(async (args) => {
            mockedCalls.tmuxArgs.push(args);
            if (args[0] === 'capture-pane') {
                if (mockedCalls.delayedSubmitCapturesRemaining !== null) {
                    if (mockedCalls.delayedSubmitCapturesRemaining <= 0) {
                        mockedCalls.paneCapture = mockedCalls.delayedSubmitReplacement;
                        mockedCalls.delayedSubmitCapturesRemaining = null;
                        mockedCalls.delayedSubmitReplacement = '';
                    }
                    else {
                        mockedCalls.delayedSubmitCapturesRemaining -= 1;
                    }
                }
                const stdout = args.includes('-J')
                    ? mockedCalls.paneCapture.replace(/\n/g, mockedCalls.insertWrapSpaces ? ' ' : '')
                    : mockedCalls.paneCapture;
                return { stdout, stderr: '' };
            }
            if (args[0] === 'send-keys' && args.includes('-l') && mockedCalls.echoOnLiteralSend) {
                const literal = args[args.length - 1] ?? '';
                mockedCalls.paneCapture = mockedCalls.wrapLiteralCapture
                    ? `${literal.slice(0, 80)}\n${literal.slice(80)}`
                    : literal;
            }
            if (args[0] === 'send-keys' && args.at(-1) === 'Enter' && mockedCalls.enterSubmitsCommand) {
                const replacement = mockedCalls.paneCapture.includes('cursor-agent')
                    ? 'cursor-agent ready\n'
                    : '';
                if (mockedCalls.submitClearsAfterCaptures > 0) {
                    mockedCalls.delayedSubmitCapturesRemaining = mockedCalls.submitClearsAfterCaptures;
                    mockedCalls.delayedSubmitReplacement = replacement;
                }
                else {
                    mockedCalls.paneCapture = replacement;
                }
            }
            if (args[0] === 'send-keys' && args.at(-1) === 'Enter' && mockedCalls.paneStatusAfterEnter !== null) {
                mockedCalls.paneStatus = mockedCalls.paneStatusAfterEnter;
            }
            return { stdout: '', stderr: '' };
        }),
        tmuxCmdAsync: vi.fn(async (args) => {
            mockedCalls.tmuxArgs.push(args);
            if (args[0] === 'display-message' && args.includes('#{pane_dead} #{pane_current_command}')) {
                return { stdout: mockedCalls.paneStatus, stderr: '' };
            }
            return { stdout: '', stderr: '' };
        }),
    };
});
import { sendTeamPaneKey, spawnBridgeInSession, spawnWorkerInPane } from '../tmux-session.js';
describe('spawnWorkerInPane', () => {
    beforeEach(() => {
        vi.useRealTimers();
        mockedCalls.tmuxArgs = [];
        mockedCalls.cmuxArgs = [];
        mockedCalls.paneCapture = '';
        mockedCalls.paneStatus = '0 zsh\n';
        mockedCalls.echoOnLiteralSend = true;
        mockedCalls.wrapLiteralCapture = false;
        mockedCalls.insertWrapSpaces = false;
        mockedCalls.cmuxFailOnce = [];
        mockedCalls.cmuxFailures = [];
        vi.unstubAllEnvs();
        mockedCalls.enterSubmitsCommand = true;
        mockedCalls.submitClearsAfterCaptures = 0;
        mockedCalls.delayedSubmitCapturesRemaining = null;
        mockedCalls.delayedSubmitReplacement = '';
        mockedCalls.paneStatusAfterEnter = null;
    });
    it('uses argv-style launch with literal tmux send-keys', async () => {
        await spawnWorkerInPane('session:0', '%2', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: {
                OMC_TEAM_NAME: 'safe-team',
                OMC_TEAM_WORKER: 'safe-team/worker-1',
            },
            launchBinary: 'codex',
            launchArgs: ['--full-auto', '--model', 'gpt-5;touch /tmp/pwn'],
            cwd: '/tmp',
        });
        const literalSend = mockedCalls.tmuxArgs.find((args) => args[0] === 'send-keys' && args.includes('-l'));
        expect(literalSend).toBeDefined();
        const launchLine = literalSend?.[literalSend.length - 1] ?? '';
        expect(launchLine).toContain('exec "$@"');
        expect(launchLine).toContain("'--'");
        expect(launchLine).toContain("'gpt-5;touch /tmp/pwn'");
        expect(launchLine).not.toContain('exec codex --full-auto');
    });
    it('sends cmux worker command text to the target surface and submits with send-key-surface', async () => {
        vi.stubEnv('TMUX', '');
        vi.stubEnv('CMUX_SURFACE_ID', 'cmux-leader');
        await spawnWorkerInPane('cmux:workspace-1', 'cmux-worker-1', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: {
                OMC_TEAM_NAME: 'safe-team',
                OMC_TEAM_WORKER: 'safe-team/worker-1',
            },
            launchBinary: 'codex',
            launchArgs: ['--full-auto'],
            cwd: '/tmp',
        });
        expect(mockedCalls.tmuxArgs.some((args) => args[0] === 'send-keys')).toBe(false);
        expect(mockedCalls.cmuxArgs).toHaveLength(2);
        expect(mockedCalls.cmuxArgs[0]).toEqual(expect.arrayContaining(['send-surface', '--surface', 'cmux-worker-1']));
        expect(mockedCalls.cmuxArgs[0]?.[0]).toBe('send-surface');
        expect(mockedCalls.cmuxArgs[0]?.at(-1)).toContain('exec "$@"');
        expect(mockedCalls.cmuxArgs[1]).toEqual(['send-key-surface', '--surface', 'cmux-worker-1', 'enter']);
    });
    it('uses cmux send-key-surface semantics for Enter and control keys', async () => {
        vi.stubEnv('TMUX', '');
        vi.stubEnv('CMUX_SURFACE_ID', 'cmux-leader');
        await sendTeamPaneKey('cmux-worker-1', 'Enter');
        await sendTeamPaneKey('cmux-worker-1', 'Tab');
        await sendTeamPaneKey('cmux-worker-1', 'C-m');
        await sendTeamPaneKey('cmux-worker-1', 'C-u');
        expect(mockedCalls.tmuxArgs.some((args) => args[0] === 'send-keys')).toBe(false);
        expect(mockedCalls.cmuxArgs).toEqual([
            ['send-key-surface', '--surface', 'cmux-worker-1', 'enter'],
            ['send-key-surface', '--surface', 'cmux-worker-1', 'tab'],
            ['send-key-surface', '--surface', 'cmux-worker-1', 'C-m'],
            ['send-key-surface', '--surface', 'cmux-worker-1', 'C-u'],
        ]);
    });
    it('falls back to legacy cmux surface commands when current dialect is unavailable', async () => {
        vi.stubEnv('TMUX', '');
        vi.stubEnv('CMUX_SURFACE_ID', 'cmux-leader');
        mockedCalls.cmuxFailures = [
            { command: 'send-surface', message: 'error: unrecognized subcommand send-surface' },
            { command: 'send-key-surface', message: 'error: unrecognized subcommand send-key-surface' },
        ];
        await spawnWorkerInPane('cmux:workspace-1', 'cmux-worker-1', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: {
                OMC_TEAM_NAME: 'safe-team',
                OMC_TEAM_WORKER: 'safe-team/worker-1',
            },
            launchBinary: 'codex',
            launchArgs: ['--full-auto'],
            cwd: '/tmp',
        });
        expect(mockedCalls.cmuxArgs[0]?.[0]).toBe('send-surface');
        expect(mockedCalls.cmuxArgs[1]?.[0]).toBe('send');
        expect(mockedCalls.cmuxArgs[2]?.[0]).toBe('send-key-surface');
        expect(mockedCalls.cmuxArgs[3]).toEqual(['send-key', '--surface', 'cmux-worker-1', 'Enter']);
    });
    it('falls back for clap-style cmux surface option dialect errors', async () => {
        vi.stubEnv('TMUX', '');
        vi.stubEnv('CMUX_SURFACE_ID', 'cmux-leader');
        mockedCalls.cmuxFailures = [
            { command: 'send-surface', message: "error: Found argument '--surface' which wasn't expected" },
        ];
        await spawnWorkerInPane('cmux:workspace-1', 'cmux-worker-1', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: {
                OMC_TEAM_NAME: 'safe-team',
                OMC_TEAM_WORKER: 'safe-team/worker-1',
            },
            launchBinary: 'codex',
            launchArgs: ['--full-auto'],
            cwd: '/tmp',
        });
        expect(mockedCalls.cmuxArgs[0]?.[0]).toBe('send-surface');
        expect(mockedCalls.cmuxArgs[1]?.[0]).toBe('send');
        expect(mockedCalls.cmuxArgs[2]?.[0]).toBe('send-key-surface');
    });
    it('does not replay cmux worker command text after a non-dialect send failure', async () => {
        vi.stubEnv('TMUX', '');
        vi.stubEnv('CMUX_SURFACE_ID', 'cmux-leader');
        const secret = 'SECRET_TOKEN_SHOULD_NOT_LEAK';
        mockedCalls.cmuxFailures = [
            { command: 'send-surface', message: `cmux transport timed out after partial write --api-key ${secret}` },
        ];
        await expect(async () => {
            try {
                await spawnWorkerInPane('cmux:workspace-1', 'cmux-worker-1', {
                    teamName: 'safe-team',
                    workerName: 'worker-1',
                    envVars: {
                        OMC_TEAM_NAME: 'safe-team',
                        OMC_TEAM_WORKER: 'safe-team/worker-1',
                        SECRET_ENV: secret,
                    },
                    launchBinary: 'codex',
                    launchArgs: ['--full-auto', '--api-key', secret],
                    cwd: '/tmp',
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                expect(message).toContain('cmux command failed for current form: current=send-surface');
                expect(message).toContain('cmux transport timed out after partial write');
                expect(message).not.toContain(secret);
                expect(message).not.toContain('SECRET_ENV');
                expect(message).not.toContain('--api-key');
                throw error;
            }
        }).rejects.toThrow(/cmux command failed for current form/);
        expect(mockedCalls.cmuxArgs).toHaveLength(1);
        expect(mockedCalls.cmuxArgs[0]?.[0]).toBe('send-surface');
        expect(mockedCalls.cmuxArgs.some(args => args[0] === 'send')).toBe(false);
        expect(mockedCalls.cmuxArgs.some(args => args[0] === 'send-key-surface')).toBe(false);
    });
    it('redacts cmux command payloads when current and legacy dialects both fail', async () => {
        vi.stubEnv('TMUX', '');
        vi.stubEnv('CMUX_SURFACE_ID', 'cmux-leader');
        const secret = 'SECRET_TOKEN_SHOULD_NOT_LEAK';
        mockedCalls.cmuxFailures = [
            { command: 'send-surface', message: `error: unrecognized subcommand send-surface ${secret}` },
            { command: 'send', message: `legacy rejected command containing ${secret}` },
        ];
        await expect(async () => {
            try {
                await spawnWorkerInPane('cmux:workspace-1', 'cmux-worker-1', {
                    teamName: 'safe-team',
                    workerName: 'worker-1',
                    envVars: {
                        OMC_TEAM_NAME: 'safe-team',
                        OMC_TEAM_WORKER: 'safe-team/worker-1',
                        SECRET_ENV: secret,
                    },
                    launchBinary: 'codex',
                    launchArgs: ['--full-auto', '--api-key', secret],
                    cwd: '/tmp',
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                expect(message).toContain('cmux command failed for both current and legacy forms');
                expect(message).not.toContain(secret);
                expect(message).not.toContain('SECRET_ENV');
                expect(message).not.toContain('--api-key');
                expect(message).toContain('current=send-surface');
                expect(message).toContain('legacy=send');
                throw error;
            }
        }).rejects.toThrow(/cmux command failed for both current and legacy forms/);
    });
    it('uses current JS runtime when launching bridge-entry helpers', () => {
        spawnBridgeInSession('session:0', '/tmp/bridge-entry.js', '/tmp/bridge-config.json');
        const sendKeys = mockedCalls.tmuxArgs.find((args) => args[0] === 'send-keys');
        expect(sendKeys).toBeDefined();
        const launchLine = sendKeys?.[3] ?? '';
        expect(launchLine).toContain(process.execPath);
        expect(launchLine).toContain('/tmp/bridge-entry.js');
        expect(launchLine).toContain('--config');
        expect(launchLine).not.toMatch(/^node\s/);
    });
    it('fails before Enter when tmux does not echo the delivered start command', async () => {
        mockedCalls.paneCapture = '';
        mockedCalls.echoOnLiteralSend = false;
        await expect(spawnWorkerInPane('session:0', '%2', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: {
                OMC_TEAM_NAME: 'safe-team',
                OMC_TEAM_WORKER: 'safe-team/worker-1',
            },
            launchBinary: 'codex',
            launchArgs: ['--full-auto'],
            cwd: '/tmp',
        })).rejects.toThrow(/worker_start_delivery_unverified:worker-1:%2:/);
        const enterSend = mockedCalls.tmuxArgs.find((args) => args[0] === 'send-keys' && args.at(-1) === 'Enter');
        expect(enterSend).toBeUndefined();
    });
    it('verifies wrapped worker start commands with joined tmux capture before Enter', async () => {
        mockedCalls.wrapLiteralCapture = true;
        await spawnWorkerInPane('session:0', '%2', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: {
                OMC_TEAM_NAME: 'safe-team',
                OMC_TEAM_WORKER: 'safe-team/worker-1',
                OMC_TEAM_LONG_VALUE: 'x'.repeat(160),
            },
            launchBinary: 'codex',
            launchArgs: ['--full-auto', '--model', 'gpt-5.5', '--reasoning-effort', 'high'],
            cwd: '/tmp',
        });
        expect(mockedCalls.tmuxArgs).toContainEqual(['capture-pane', '-J', '-t', '%2', '-p', '-S', '-80']);
        const enterSend = mockedCalls.tmuxArgs.find((args) => args[0] === 'send-keys' && args.at(-1) === 'Enter');
        expect(enterSend).toBeDefined();
    });
    it('tolerates psmux capture-pane join spaces inserted at wrap boundaries before Enter', async () => {
        mockedCalls.wrapLiteralCapture = true;
        mockedCalls.insertWrapSpaces = true;
        await spawnWorkerInPane('session:0', '%2', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: {
                OMC_TEAM_NAME: 'safe-team',
                OMC_TEAM_WORKER: 'safe-team/worker-1',
                OMC_TEAM_LONG_VALUE: 'x'.repeat(160),
            },
            launchBinary: 'codex',
            launchArgs: ['--full-auto', '--model', 'gpt-5.5', '--reasoning-effort', 'high'],
            cwd: '/tmp',
        });
        expect(mockedCalls.tmuxArgs).toContainEqual(['capture-pane', '-J', '-t', '%2', '-p', '-S', '-80']);
        const enterSend = mockedCalls.tmuxArgs.find((args) => args[0] === 'send-keys' && args.at(-1) === 'Enter');
        expect(enterSend).toBeDefined();
    });
    it('verifies a single Cursor worker start command submits after Enter', async () => {
        await spawnWorkerInPane('session:0', '%2', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: {
                OMC_TEAM_NAME: 'safe-team',
                OMC_TEAM_WORKER: 'safe-team/worker-1',
            },
            launchBinary: 'cursor-agent',
            cwd: '/tmp',
        });
        const enterSend = mockedCalls.tmuxArgs.find((args) => args[0] === 'send-keys' && args.at(-1) === 'Enter');
        expect(enterSend).toBeDefined();
        expect(mockedCalls.paneCapture).toBe('cursor-agent ready\n');
    });
    it('waits for slow tmux alt-screen repaint before treating worker start submit as failed', async () => {
        vi.useFakeTimers();
        mockedCalls.submitClearsAfterCaptures = 6;
        const start = spawnWorkerInPane('session:0', '%2', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: {
                OMC_TEAM_NAME: 'safe-team',
                OMC_TEAM_WORKER: 'safe-team/worker-1',
            },
            launchBinary: 'claude',
            launchArgs: ['--dangerously-skip-permissions'],
            cwd: '/tmp',
        });
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(start).resolves.toBeUndefined();
        const submitVerificationCaptures = mockedCalls.tmuxArgs.filter((args) => args[0] === 'capture-pane' && args.includes('-J'));
        expect(submitVerificationCaptures.length).toBeGreaterThan(5);
        vi.useRealTimers();
    });
    it('accepts inline TUI worker submission when process leaves the ready shell but command remains in scrollback', async () => {
        mockedCalls.enterSubmitsCommand = false;
        mockedCalls.paneStatusAfterEnter = '0 codex\n';
        await expect(spawnWorkerInPane('session:0', '%2', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: {
                OMC_TEAM_NAME: 'safe-team',
                OMC_TEAM_WORKER: 'safe-team/worker-1',
            },
            launchBinary: 'codex',
            launchArgs: ['--full-auto'],
            cwd: '/tmp',
        })).resolves.toBeUndefined();
    });
    it('does not accept inline TUI worker submission when the pane is dead', async () => {
        mockedCalls.enterSubmitsCommand = false;
        mockedCalls.paneStatusAfterEnter = '1 codex\n';
        vi.stubEnv('OMC_TEAM_START_SUBMIT_TIMEOUT_MS', '200');
        await expect(spawnWorkerInPane('session:0', '%2', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: {
                OMC_TEAM_NAME: 'safe-team',
                OMC_TEAM_WORKER: 'safe-team/worker-1',
            },
            launchBinary: 'codex',
            launchArgs: ['--full-auto'],
            cwd: '/tmp',
        })).rejects.toThrow(/worker_start_submit_unverified:worker-1:%2:/);
    });
    it('fails loudly when a single Cursor worker start command remains unsubmitted after Enter', async () => {
        mockedCalls.enterSubmitsCommand = false;
        vi.stubEnv('OMC_TEAM_START_SUBMIT_TIMEOUT_MS', '200');
        await expect(spawnWorkerInPane('session:0', '%2', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: {
                OMC_TEAM_NAME: 'safe-team',
                OMC_TEAM_WORKER: 'safe-team/worker-1',
            },
            launchBinary: 'cursor-agent',
            cwd: '/tmp',
        })).rejects.toThrow(/worker_start_submit_unverified:worker-1:%2:/);
    });
    it('fails before send-keys when the target pane shell never becomes ready', async () => {
        mockedCalls.paneStatus = '1 zsh\n';
        await expect(spawnWorkerInPane('session:0', '%2', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: {
                OMC_TEAM_NAME: 'safe-team',
                OMC_TEAM_WORKER: 'safe-team/worker-1',
            },
            launchBinary: 'codex',
            launchArgs: ['--full-auto'],
            cwd: '/tmp',
        })).rejects.toThrow(/worker_start_shell_not_ready:worker-1:%2:/);
        expect(mockedCalls.tmuxArgs.some((args) => args[0] === 'send-keys' && args.includes('-l'))).toBe(false);
    });
    it('rejects invalid team names before command construction', async () => {
        await expect(spawnWorkerInPane('session:0', '%2', {
            teamName: 'Bad-Team',
            workerName: 'worker-1',
            envVars: { OMC_TEAM_NAME: 'Bad-Team' },
            launchBinary: 'codex',
            launchArgs: ['--full-auto'],
            cwd: '/tmp',
        })).rejects.toThrow('Invalid team name');
    });
    it('rejects invalid environment keys', async () => {
        await expect(spawnWorkerInPane('session:0', '%2', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: { 'BAD-KEY': 'x' },
            launchBinary: 'codex',
            cwd: '/tmp',
        })).rejects.toThrow('Invalid environment key');
    });
    it('rejects unsafe launchBinary values', async () => {
        await expect(spawnWorkerInPane('session:0', '%2', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: { OMC_TEAM_NAME: 'safe-team' },
            launchBinary: 'codex;touch /tmp/pwn',
            cwd: '/tmp',
        })).rejects.toThrow('Invalid launchBinary');
    });
});
//# sourceMappingURL=tmux-session.spawn.test.js.map