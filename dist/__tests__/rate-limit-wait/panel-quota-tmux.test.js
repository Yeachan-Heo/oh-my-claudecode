/**
 * Tests for the tmux adapter of the panel quota wait (panelQuotaTmux in tmux-detector.ts).
 * tmux is replaced by the mocked tmux-utils wrappers; no tmux server is started.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { panelQuotaTmux, sendToPane, sendToPaneOutcome } from '../../features/rate-limit-wait/tmux-detector.js';
vi.mock('../../cli/tmux-utils.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, tmuxExec: vi.fn(), tmuxSpawn: vi.fn() };
});
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, readdirSync: vi.fn(() => []), lstatSync: vi.fn() };
});
vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, execFileSync: vi.fn() };
});
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { tmuxExec, tmuxSpawn } from '../../cli/tmux-utils.js';
const PANE = { id: '%7', session: 'omc-team-a', windowIndex: 0, paneIndex: 1 };
describe('panelQuotaTmux adapter', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(tmuxSpawn).mockReturnValue({ status: 0 });
    });
    it('listPanes maps the tmux pane list to pane points', () => {
        vi.mocked(tmuxExec).mockReturnValueOnce('4100:1795000000 omc-team-a:0.1 %7 1 team title\n');
        const panes = panelQuotaTmux.listPanes();
        expect(panes).toEqual([expect.objectContaining({ id: '%7', session: 'omc-team-a', windowIndex: 0, paneIndex: 1, server: '4100:1795000000' })]);
        expect(vi.mocked(tmuxExec).mock.calls[0][0][3]).toMatch(/^#\{pid\}:#\{start_time\} /);
    });
    it('listPanes returns null when a line carries no server value: the binding cannot be made', () => {
        vi.mocked(tmuxExec).mockReturnValueOnce(': omc-team-a:0.1 %7 1 team title\n');
        expect(panelQuotaTmux.listPanes()).toBeNull();
        vi.mocked(tmuxExec).mockReturnValueOnce('omc-team-a:0.1 %7 1 team title\n');
        expect(panelQuotaTmux.listPanes()).toBeNull();
    });
    it('listPanes returns null, not an empty list, when the inventory cannot be read', () => {
        vi.mocked(tmuxExec).mockImplementationOnce(() => { throw new Error('no server running'); });
        expect(panelQuotaTmux.listPanes()).toBeNull();
        vi.mocked(tmuxSpawn).mockReturnValue({ status: 1 });
        expect(panelQuotaTmux.listPanes()).toBeNull();
    });
    describe('private tmux endpoints of detached teams', () => {
        const SOCKET = '/tmp/o-1k-lz9x2b-1a2b3c4d.sock';
        const ownSocket = { isSocket: () => true, uid: process.getuid?.() };
        const noServer = () => Object.assign(new Error('no server running on /tmp/tmux-0/default'), { status: 1 });
        const onPrivate = { ...PANE, socket: SOCKET };
        beforeEach(() => {
            vi.mocked(tmuxExec).mockReset();
            vi.mocked(readdirSync).mockReset();
            vi.mocked(lstatSync).mockReset();
            vi.mocked(readdirSync).mockReturnValue(['o-1k-lz9x2b-1a2b3c4d.sock', 'o-not-a-socket-name', 'unrelated.sock']);
            vi.mocked(lstatSync).mockReturnValue(ownSocket);
        });
        it('listPanes lists a private endpoint when there is no default server, and the pane carries its socket', () => {
            vi.mocked(tmuxExec)
                .mockImplementationOnce(() => { throw noServer(); })
                .mockReturnValueOnce('4100:1795000000 omc-team-a:0.1 %7 1 team title\n');
            const panes = panelQuotaTmux.listPanes();
            expect(panes).toEqual([expect.objectContaining({ id: '%7', server: '4100:1795000000', socket: SOCKET })]);
            expect(vi.mocked(tmuxExec).mock.calls[1][0].slice(0, 3)).toEqual(['-S', SOCKET, 'list-panes']);
            expect(vi.mocked(tmuxExec).mock.calls, 'only the endpoint with the team name pattern is asked').toHaveLength(2);
        });
        it('a socket that is not the own user\'s or not a socket is not asked', () => {
            vi.mocked(lstatSync).mockReturnValue({ isSocket: () => true, uid: (process.getuid?.() ?? 0) + 1 });
            vi.mocked(tmuxExec).mockImplementationOnce(() => { throw noServer(); });
            expect(panelQuotaTmux.listPanes()).toBeNull();
            expect(vi.mocked(tmuxExec).mock.calls).toHaveLength(1);
        });
        it('a socket file left behind by an exited server adds nothing and does not make the inventory unreadable', () => {
            vi.mocked(tmuxExec)
                .mockReturnValueOnce('4100:1795000000 omc-team-a:0.1 %7 1 team title\n')
                .mockImplementationOnce(() => { throw Object.assign(new Error('error connecting to /tmp/o-1k-lz9x2b-1a2b3c4d.sock (Connection refused)'), { status: 1 }); });
            const panes = panelQuotaTmux.listPanes();
            expect(panes).toEqual([expect.objectContaining({ id: '%7' })]);
            expect(panes?.[0].socket).toBeUndefined();
        });
        describe('the socket directory is read entry by entry', () => {
            const OTHER = '/tmp/o-2m-lzaaaa-5e6f7a8b.sock';
            const failure = (code) => Object.assign(new Error(code), { code });
            const LIST_A = '4100:1795000000 omc-team-a:0.1 %7 1 team title\n';
            const LIST_B = '4200:1795000001 omc-team-b:0.1 %3 1 team title\n';
            it('an entry that disappears after the directory was read is skipped and the later sockets are still listed', () => {
                vi.mocked(readdirSync).mockReturnValue(['o-1k-lz9x2b-1a2b3c4d.sock', 'o-2m-lzaaaa-5e6f7a8b.sock']);
                vi.mocked(lstatSync).mockReset();
                vi.mocked(lstatSync).mockImplementationOnce(() => { throw failure('ENOENT'); }).mockReturnValueOnce(ownSocket);
                vi.mocked(tmuxExec).mockReturnValueOnce(LIST_A).mockReturnValueOnce(LIST_B);
                const panes = panelQuotaTmux.listPanes();
                expect(panes?.map((pane) => pane.socket)).toEqual([undefined, OTHER]);
                expect(panes?.map((pane) => pane.id)).toEqual(['%7', '%3']);
            });
            it('an entry that cannot be examined makes the inventory unreadable, not shorter', () => {
                vi.mocked(lstatSync).mockReset();
                vi.mocked(lstatSync).mockImplementationOnce(() => { throw failure('EACCES'); });
                vi.mocked(tmuxExec).mockReturnValueOnce(LIST_A);
                expect(panelQuotaTmux.listPanes()).toBeNull();
            });
            it('a directory that cannot be read makes the inventory unreadable; a missing directory has no endpoints', () => {
                vi.mocked(readdirSync).mockReset();
                vi.mocked(readdirSync).mockImplementationOnce(() => { throw failure('EACCES'); });
                vi.mocked(tmuxExec).mockReturnValueOnce(LIST_A);
                expect(panelQuotaTmux.listPanes()).toBeNull();
                vi.mocked(readdirSync).mockReset();
                vi.mocked(readdirSync).mockImplementationOnce(() => { throw failure('ENOENT'); });
                vi.mocked(tmuxExec).mockReturnValueOnce(LIST_A);
                expect(panelQuotaTmux.listPanes()).toEqual([expect.objectContaining({ id: '%7' })]);
            });
        });
        describe('the tmux server that the daemon itself was started from', () => {
            const AMBIENT = '/tmp/ambient/tmux-socket';
            const LIST_AMBIENT = '4300:1795000002 omc-team-c:0.1 %9 1 team title\n';
            afterEach(() => { vi.unstubAllEnvs(); });
            it('is listed although its socket does not have the team name pattern, and the pane carries its socket', () => {
                vi.stubEnv('TMUX', `${AMBIENT},4300,0`);
                vi.mocked(readdirSync).mockReturnValue([]);
                vi.mocked(tmuxExec)
                    .mockImplementationOnce(() => { throw noServer(); })
                    .mockReturnValueOnce(LIST_AMBIENT);
                const panes = panelQuotaTmux.listPanes();
                expect(panes).toEqual([expect.objectContaining({ id: '%9', server: '4300:1795000002', socket: AMBIENT })]);
                expect(vi.mocked(tmuxExec).mock.calls[1][0].slice(0, 3)).toEqual(['-S', AMBIENT, 'list-panes']);
            });
            it('is not listed twice when it is the default server or a private endpoint that is listed anyway', () => {
                vi.stubEnv('TMUX', `${AMBIENT},4100,0`);
                vi.mocked(readdirSync).mockReturnValue([]);
                vi.mocked(tmuxExec).mockReturnValue('4100:1795000000 omc-team-a:0.1 %7 1 team title\n');
                const panes = panelQuotaTmux.listPanes();
                expect(vi.mocked(tmuxExec).mock.calls, 'the ambient endpoint is asked as well').toHaveLength(2);
                expect(panes?.filter((pane) => pane.id === '%7')).toHaveLength(1);
                expect(panes?.[0].socket).toBeUndefined();
            });
            it('that is not running adds nothing, and a value that is not an absolute socket path is ignored', () => {
                vi.mocked(readdirSync).mockReturnValue([]);
                vi.stubEnv('TMUX', `${AMBIENT},4300,0`);
                vi.mocked(tmuxExec)
                    .mockReturnValueOnce('4100:1795000000 omc-team-a:0.1 %7 1 team title\n')
                    .mockImplementationOnce(() => { throw Object.assign(new Error(`error connecting to ${AMBIENT} (No such file or directory)`), { status: 1 }); });
                expect(panelQuotaTmux.listPanes()).toEqual([expect.objectContaining({ id: '%7' })]);
                vi.mocked(tmuxExec).mockReset();
                vi.stubEnv('TMUX', 'relative/socket,4300,0');
                vi.mocked(tmuxExec).mockReturnValueOnce('4100:1795000000 omc-team-a:0.1 %7 1 team title\n');
                expect(panelQuotaTmux.listPanes()).toEqual([expect.objectContaining({ id: '%7' })]);
                expect(vi.mocked(tmuxExec).mock.calls).toHaveLength(1);
            });
            it('that cannot be read makes the inventory unreadable', () => {
                vi.stubEnv('TMUX', `${AMBIENT},4300,0`);
                vi.mocked(readdirSync).mockReturnValue([]);
                vi.mocked(tmuxExec)
                    .mockReturnValueOnce('4100:1795000000 omc-team-a:0.1 %7 1 team title\n')
                    .mockImplementationOnce(() => { throw Object.assign(new Error('spawnSync tmux ETIMEDOUT'), { code: 'ETIMEDOUT' }); });
                expect(panelQuotaTmux.listPanes()).toBeNull();
            });
        });
        it('a connection failure that does not say there is no server is not an absent server: the inventory is unreadable', () => {
            vi.mocked(tmuxExec)
                .mockReturnValueOnce('4100:1795000000 omc-team-a:0.1 %7 1 team title\n')
                .mockImplementationOnce(() => { throw Object.assign(new Error('error connecting to /tmp/o-1k-lz9x2b-1a2b3c4d.sock (Permission denied)'), { status: 1 }); });
            expect(panelQuotaTmux.listPanes()).toBeNull();
        });
        it('an endpoint that cannot be read makes the inventory unreadable', () => {
            vi.mocked(tmuxExec)
                .mockReturnValueOnce('4100:1795000000 omc-team-a:0.1 %7 1 team title\n')
                .mockImplementationOnce(() => { throw Object.assign(new Error('spawnSync tmux ETIMEDOUT'), { code: 'ETIMEDOUT' }); });
            expect(panelQuotaTmux.listPanes()).toBeNull();
        });
        it('capture, the provider check and the keys go to the endpoint of the pane', () => {
            vi.mocked(tmuxExec).mockReturnValue('0 4242 node\n');
            panelQuotaTmux.capture(onPrivate, 15);
            expect(panelQuotaTmux.providerRunning(onPrivate)).toBe(true);
            expect(panelQuotaTmux.sendContinue(onPrivate)).toBe('delivered');
            const calls = vi.mocked(tmuxExec).mock.calls.map((call) => call[0]);
            expect(calls).toHaveLength(4);
            for (const args of calls)
                expect(args.slice(0, 2), `a call went to the default server: ${args.join(' ')}`).toEqual(['-S', SOCKET]);
            expect(calls.map((args) => args[2])).toEqual(['capture-pane', 'display-message', 'send-keys', 'send-keys']);
        });
    });
    describe('commands are bound to the server run that listed the pane', () => {
        const SERVER = '4100:1795000000';
        const GUARD = `#{==:#{pid}:#{start_time},${SERVER}}`;
        const listed = { ...PANE, server: SERVER };
        // What a server prints when the guard does not hold: the marker that the call carries as its else branch.
        const markerOf = (args) => String(args[args.length - 1]).replace('display-message -p ', '');
        const refuse = (args) => `${markerOf(args)}\n`;
        beforeEach(() => {
            vi.mocked(tmuxExec).mockReset();
        });
        it('capture, the provider check and each key are run under a guard on the listed pid and start time', () => {
            vi.mocked(tmuxExec).mockReturnValue('0 4242 node\n');
            panelQuotaTmux.capture(listed, 15);
            expect(panelQuotaTmux.providerRunning(listed)).toBe(true);
            expect(panelQuotaTmux.sendContinue(listed)).toBe('delivered');
            const calls = vi.mocked(tmuxExec).mock.calls.map((call) => call[0]);
            expect(calls.map((args) => args.slice(0, 3))).toEqual(Array(4).fill(['if-shell', '-F', GUARD]));
            expect(calls.map((args) => args[3])).toEqual([
                'capture-pane -t %7 -p -S -15',
                'display-message -t %7 -p "#{pane_dead} #{pane_pid} #{pane_current_command}"',
                'send-keys -t %7 -l continue',
                'send-keys -t %7 Enter',
            ]);
        });
        it('a server that is not the listed one: nothing is read, and no key is typed', () => {
            vi.mocked(tmuxExec).mockImplementation((args) => refuse(args));
            expect(panelQuotaTmux.capture(listed, 15)).toBeNull();
            expect(panelQuotaTmux.providerRunning(listed)).toBeNull();
            vi.mocked(tmuxExec).mockClear();
            expect(panelQuotaTmux.sendContinue(listed)).toBe('not_attempted');
            expect(vi.mocked(tmuxExec).mock.calls, 'the Enter was sent after a refused text').toHaveLength(1);
        });
        it('a server that changes between the text and the Enter: the text may sit in the old pane, so the outcome is unconfirmed', () => {
            vi.mocked(tmuxExec).mockReturnValueOnce('').mockImplementationOnce((args) => refuse(args));
            expect(panelQuotaTmux.sendContinue(listed)).toBe('unconfirmed');
        });
        it('a server value that is not a pid and start time is never trusted: nothing is run', () => {
            const odd = { ...PANE, server: '4100:1795000000;x' };
            expect(panelQuotaTmux.capture(odd, 15)).toBeNull();
            expect(panelQuotaTmux.providerRunning(odd)).toBeNull();
            expect(panelQuotaTmux.sendContinue(odd)).toBe('not_attempted');
            expect(vi.mocked(tmuxExec)).not.toHaveBeenCalled();
        });
    });
    describe('providerIdentity', () => {
        it('is the foreground process group of the pane terminal and the start time of its leader', () => {
            vi.mocked(tmuxExec).mockReset();
            vi.mocked(execFileSync).mockReset();
            vi.mocked(tmuxExec).mockReturnValueOnce('0 4242\n');
            vi.mocked(execFileSync).mockReturnValueOnce(' 5151\n').mockReturnValueOnce('Tue Nov 24 10:00:00 2026\n');
            expect(panelQuotaTmux.providerIdentity?.(PANE)).toBe('5151:Tue Nov 24 10:00:00 2026');
            expect(vi.mocked(execFileSync).mock.calls.map((call) => call[1])).toEqual([['-o', 'tpgid=', '-p', '4242'], ['-o', 'lstart=', '-p', '5151']]);
        });
        it('the start time is read with a fixed timezone and locale, so a daemon restarted under another environment reads the same text', () => {
            vi.mocked(tmuxExec).mockReset();
            vi.mocked(execFileSync).mockReset();
            vi.mocked(tmuxExec).mockReturnValueOnce('0 4242\n');
            vi.mocked(execFileSync).mockReturnValueOnce(' 5151\n').mockReturnValueOnce('Tue Nov 24 10:00:00 2026\n');
            vi.stubEnv('TZ', 'Pacific/Honolulu');
            vi.stubEnv('LANG', 'pl_PL.UTF-8');
            vi.stubEnv('LC_ALL', 'pl_PL.UTF-8');
            try {
                panelQuotaTmux.providerIdentity?.(PANE);
            }
            finally {
                vi.unstubAllEnvs();
            }
            const lstart = vi.mocked(execFileSync).mock.calls.find((call) => call[1].includes('lstart='));
            const env = lstart?.[2]?.env;
            expect(env, 'the lookup runs with its own environment').toBeDefined();
            expect(env?.TZ).toBe('UTC');
            expect(env?.LC_ALL).toBe('C');
            expect(env?.LANG).toBe('C');
        });
        it('a start time that cannot be read is not an empty start time: a timeout, a missing ps or a signal give null, and a leader that is gone gives the group alone', () => {
            const ask = (failure) => {
                vi.mocked(tmuxExec).mockReset();
                vi.mocked(execFileSync).mockReset();
                vi.mocked(tmuxExec).mockReturnValueOnce('0 4242\n');
                vi.mocked(execFileSync).mockReturnValueOnce(' 5151\n').mockImplementationOnce(() => { throw failure; });
                return panelQuotaTmux.providerIdentity?.(PANE) ?? null;
            };
            expect(ask(Object.assign(new Error('spawnSync ps ETIMEDOUT'), { code: 'ETIMEDOUT', status: null, signal: 'SIGTERM' }))).toBeNull();
            expect(ask(Object.assign(new Error('spawnSync ps ENOENT'), { code: 'ENOENT', status: null }))).toBeNull();
            expect(ask(Object.assign(new Error('killed'), { status: null, signal: 'SIGKILL' }))).toBeNull();
            expect(ask(Object.assign(new Error('Command failed: ps'), { status: 1, stdout: '' }))).toBe('5151:');
        });
        it('is null for a dead pane, a terminal without a foreground group, and when ps fails', () => {
            const ask = (status, ps) => {
                vi.mocked(tmuxExec).mockReset();
                vi.mocked(execFileSync).mockReset();
                vi.mocked(tmuxExec).mockReturnValueOnce(status);
                if (ps instanceof Error)
                    vi.mocked(execFileSync).mockImplementationOnce(() => { throw ps; });
                else
                    vi.mocked(execFileSync).mockReturnValueOnce(ps);
                return panelQuotaTmux.providerIdentity?.(PANE) ?? null;
            };
            expect(ask('1 4242\n', ' 5151\n')).toBeNull();
            expect(ask('0 4242\n', ' -1\n')).toBeNull();
            expect(ask('0 4242\n', new Error('ps: not found'))).toBeNull();
        });
    });
    it('providerRunning is false for a dead pane, true for a foreground command that is not a shell, null when unknown', () => {
        const ask = (output) => {
            vi.mocked(tmuxExec).mockReset();
            vi.mocked(execFileSync).mockReset();
            if (output instanceof Error)
                vi.mocked(tmuxExec).mockImplementationOnce(() => { throw output; });
            else
                vi.mocked(tmuxExec).mockReturnValueOnce(output);
            return panelQuotaTmux.providerRunning(PANE);
        };
        expect(ask('0 4242 node\n')).toBe(true);
        expect(ask('0 4242 claude\n')).toBe(true);
        expect(ask('1 4242 node\n')).toBe(false);
        expect(ask('1 4242 bash\n')).toBe(false);
        expect(ask('0 4242 \n')).toBeNull();
        expect(ask(new Error("can't find pane"))).toBeNull();
        expect(vi.mocked(execFileSync), 'ps is asked only when a shell is in the foreground').not.toHaveBeenCalled();
        vi.mocked(tmuxExec).mockReset();
        vi.mocked(tmuxExec).mockReturnValueOnce('0 4242 node\n');
        panelQuotaTmux.providerRunning(PANE);
        expect(vi.mocked(tmuxExec).mock.calls[0][0]).toEqual(['display-message', '-t', '%7', '-p', '#{pane_dead} #{pane_pid} #{pane_current_command}']);
    });
    it('providerRunning with a shell as the pane command: the shell at its own prompt means the provider exited, a wrapper script in the foreground means it runs', () => {
        const ask = (command, ps) => {
            vi.mocked(tmuxExec).mockReset();
            vi.mocked(execFileSync).mockReset();
            vi.mocked(tmuxExec).mockReturnValueOnce(`0 4242 ${command}\n`);
            if (ps instanceof Error)
                vi.mocked(execFileSync).mockImplementationOnce(() => { throw ps; });
            else
                vi.mocked(execFileSync).mockReturnValueOnce(ps);
            return panelQuotaTmux.providerRunning(PANE);
        };
        // pgid and tpgid of the shell: equal at its prompt, different while another job holds the terminal.
        expect(ask('bash', ' 4242  4242\n'), 'the shell at its prompt').toBe(false);
        expect(ask('-zsh', ' 4242  4242\n'), 'a login shell at its prompt').toBe(false);
        expect(ask('bash', ' 4242  5151\n'), 'a wrapper script that runs the provider').toBe(true);
        expect(ask('bash', ' 4242    -1\n'), 'no controlling terminal').toBeNull();
        expect(ask('bash', 'garbage\n')).toBeNull();
        expect(ask('bash', new Error('ps: not found'))).toBeNull();
        expect(vi.mocked(execFileSync).mock.calls[0][0]).toBe('ps');
        expect(vi.mocked(execFileSync).mock.calls[0][1]).toEqual(['-o', 'pgid=,tpgid=', '-p', '4242']);
    });
    it('capture returns the pane screen read with capture-pane', () => {
        vi.mocked(tmuxExec).mockReturnValueOnce('working...\nAPI Error: 429 {"error":{"code":1308}}\n');
        const screen = panelQuotaTmux.capture(PANE, 15);
        expect(screen).toContain('"code":1308');
        expect(vi.mocked(tmuxExec).mock.calls[0][0]).toEqual(expect.arrayContaining(['capture-pane', '-t', '%7']));
    });
    it('sendContinue sends the text and then Enter to the same pane', () => {
        vi.mocked(tmuxExec).mockReturnValue('');
        expect(panelQuotaTmux.sendContinue(PANE)).toBe('delivered');
        const calls = vi.mocked(tmuxExec).mock.calls.map((call) => call[0]);
        expect(calls).toContainEqual(['send-keys', '-t', '%7', '-l', 'continue']);
        expect(calls).toContainEqual(['send-keys', '-t', '%7', 'Enter']);
    });
    describe('the three outcomes of typing text into a pane', () => {
        const exited = (status) => Object.assign(new Error(`Command failed: tmux (status ${status})`), { status, signal: null });
        const timedOut = () => Object.assign(new Error('spawnSync tmux ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM', status: null });
        const sendKeysCalls = () => vi.mocked(tmuxExec).mock.calls.map((call) => call[0]).filter((args) => args[0] === 'send-keys');
        beforeEach(() => {
            vi.spyOn(console, 'error').mockImplementation(() => { });
        });
        it('the text went in and the Enter failed: unconfirmed, because the text sits in the pane', () => {
            vi.mocked(tmuxExec).mockReturnValueOnce('').mockImplementationOnce(() => { throw exited(1); });
            expect(panelQuotaTmux.sendContinue(PANE)).toBe('unconfirmed');
            expect(sendKeysCalls()).toEqual([['send-keys', '-t', '%7', '-l', 'continue'], ['send-keys', '-t', '%7', 'Enter']]);
        });
        it('the text went in and the Enter timed out: unconfirmed', () => {
            vi.mocked(tmuxExec).mockReturnValueOnce('').mockImplementationOnce(() => { throw timedOut(); });
            expect(panelQuotaTmux.sendContinue(PANE)).toBe('unconfirmed');
        });
        it('the text call timed out: unconfirmed, and no Enter follows', () => {
            vi.mocked(tmuxExec).mockImplementationOnce(() => { throw timedOut(); });
            expect(panelQuotaTmux.sendContinue(PANE)).toBe('unconfirmed');
            expect(sendKeysCalls()).toHaveLength(1);
        });
        it('the text call died of a signal or failed in a way tmux does not report: unconfirmed', () => {
            vi.mocked(tmuxExec).mockImplementationOnce(() => { throw Object.assign(new Error('killed'), { status: null, signal: 'SIGKILL' }); });
            expect(panelQuotaTmux.sendContinue(PANE)).toBe('unconfirmed');
            vi.mocked(tmuxExec).mockReset();
            vi.mocked(tmuxExec).mockImplementationOnce(() => { throw new Error('unexpected'); });
            expect(panelQuotaTmux.sendContinue(PANE)).toBe('unconfirmed');
        });
        it('tmux refuses the text (exit status 1) or does not start: not attempted, and no Enter follows', () => {
            vi.mocked(tmuxExec).mockImplementationOnce(() => { throw exited(1); });
            expect(panelQuotaTmux.sendContinue(PANE)).toBe('not_attempted');
            expect(sendKeysCalls()).toHaveLength(1);
            vi.mocked(tmuxExec).mockReset();
            vi.mocked(tmuxExec).mockImplementationOnce(() => { throw Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }); });
            expect(panelQuotaTmux.sendContinue(PANE)).toBe('not_attempted');
        });
        it('a failure before any key (tmux missing, herdr pane, malformed pane id): not attempted, nothing is sent', () => {
            vi.mocked(tmuxSpawn).mockReturnValue({ status: 1 });
            expect(sendToPaneOutcome('%7', 'continue')).toBe('not_attempted');
            vi.mocked(tmuxSpawn).mockReturnValue({ status: 0 });
            expect(sendToPaneOutcome('w1:p2', 'continue')).toBe('not_attempted');
            expect(sendToPaneOutcome('%7; rm -rf /', 'continue')).toBe('not_attempted');
            expect(sendKeysCalls()).toHaveLength(0);
        });
        it('the text without Enter is delivered when the text call succeeds', () => {
            vi.mocked(tmuxExec).mockReturnValue('');
            expect(sendToPaneOutcome('%7', 'continue', false)).toBe('delivered');
            expect(sendKeysCalls()).toEqual([['send-keys', '-t', '%7', '-l', 'continue']]);
        });
        it('sendToPane keeps its boolean: true only when the text and the Enter both went in', () => {
            vi.mocked(tmuxExec).mockReturnValue('');
            expect(sendToPane('%7', 'continue')).toBe(true);
            vi.mocked(tmuxExec).mockReset();
            vi.mocked(tmuxExec).mockReturnValueOnce('').mockImplementationOnce(() => { throw exited(1); });
            expect(sendToPane('%7', 'continue')).toBe(false);
            vi.mocked(tmuxExec).mockReset();
            vi.mocked(tmuxExec).mockImplementationOnce(() => { throw exited(1); });
            expect(sendToPane('%7', 'continue')).toBe(false);
            vi.mocked(tmuxExec).mockReset();
            vi.mocked(tmuxExec).mockImplementationOnce(() => { throw timedOut(); });
            expect(sendToPane('%7', 'continue')).toBe(false);
        });
    });
});
//# sourceMappingURL=panel-quota-tmux.test.js.map