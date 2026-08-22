import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const processMocks = vi.hoisted(() => ({
    isProcessIdentityLive: vi.fn(async () => 'live'),
}));
vi.mock('../../platform/process-utils.js', async (importOriginal) => ({
    ...await importOriginal(),
    isProcessIdentityLive: processMocks.isProcessIdentityLive,
}));
const tmuxState = vi.hoisted(() => ({
    args: [],
    captures: [],
    paneStatus: '0 cmd\n',
    activeAttempt: null,
}));
vi.mock('../../cli/tmux-utils.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        tmuxExecAsync: vi.fn(async (args) => {
            tmuxState.args.push(args);
            if (args[0] === 'kill-pane')
                tmuxState.paneStatus = '1 cmd\n';
            if (args[0] === 'list-panes')
                return { stdout: '%2\n', stderr: '' };
            if (args[0] === 'capture-pane') {
                const next = tmuxState.captures.length > 1 ? tmuxState.captures.shift() : tmuxState.captures[0];
                if (next instanceof Error)
                    throw next;
                return { stdout: next ?? '', stderr: '' };
            }
            if (args[0] === 'send-keys' && args.includes('-l')) {
                const command = String(args.at(-1) ?? '');
                const descriptorMatch = command.match(/OMC_WORKER_LAUNCH_SPEC_FILE='([^']+)'/);
                if (descriptorMatch) {
                    // Supervised launches (issue #3655) deliver the attempt-owned
                    // descriptor by path; the runtime CLI reads it from disk.
                    const spec = JSON.parse(await readFile(descriptorMatch[1], 'utf8'));
                    tmuxState.activeAttempt = {
                        schema_version: spec.schema_version,
                        attempt_id: spec.attempt_id,
                        nonce: spec.nonce,
                        team_name: spec.team_name,
                        worker_name: spec.worker_name,
                        pane_id: spec.pane_id,
                        provider: spec.provider,
                        created_at: spec.created_at,
                        currentPath: spec.current_path,
                        expectedPath: spec.expected_path,
                        ackPath: spec.ack_path,
                        decisionPath: spec.decision_path,
                        startedPath: spec.started_path,
                        transportOwnerPath: spec.transport_owner_path,
                        bootstrapDescriptorPath: spec.bootstrap_descriptor_path,
                        wrapperPath: spec.wrapper_path,
                        transportCleanupCompletePath: spec.transport_cleanup_complete_path,
                        runtimeCliPath: '/runtime-cli.js',
                        context: spec.context,
                    };
                }
                else {
                    const encoded = command.match(/OMC_WORKER_LAUNCH_SPEC_B64(?:=|=")'?([A-Za-z0-9+/=]+)/)?.[1];
                    const raw = command.match(/OMC_WORKER_LAUNCH_SPEC='([^']+)'/)?.[1];
                    if (encoded || raw) {
                        const spec = JSON.parse(encoded ? Buffer.from(encoded, 'base64').toString('utf8') : raw);
                        tmuxState.activeAttempt = {
                            schema_version: spec.schema_version,
                            attempt_id: spec.attempt_id,
                            nonce: spec.nonce,
                            team_name: spec.team_name,
                            worker_name: spec.worker_name,
                            pane_id: spec.pane_id,
                            provider: spec.provider,
                            created_at: spec.created_at,
                            currentPath: spec.current_path,
                            expectedPath: spec.expected_path,
                            ackPath: spec.ack_path,
                            decisionPath: spec.decision_path,
                            startedPath: spec.started_path,
                            transportOwnerPath: spec.transport_owner_path,
                            bootstrapDescriptorPath: spec.bootstrap_descriptor_path,
                            wrapperPath: spec.wrapper_path,
                            transportCleanupCompletePath: spec.transport_cleanup_complete_path,
                            runtimeCliPath: '/runtime-cli.js',
                            context: spec.context,
                        };
                    }
                }
            }
            if (args[0] === 'send-keys' && args.at(-1) === 'Enter' && tmuxState.activeAttempt) {
                const attempt = tmuxState.activeAttempt;
                await writeFile(attempt.ackPath, JSON.stringify({
                    schema_version: attempt.schema_version,
                    attempt_id: attempt.attempt_id,
                    nonce: attempt.nonce,
                    team_name: attempt.team_name,
                    worker_name: attempt.worker_name,
                    pane_id: attempt.pane_id,
                    provider: attempt.provider,
                    created_at: attempt.created_at,
                    kind: 'worker_launch_ack',
                    written_at: new Date().toISOString(),
                }), 'utf8');
                await writeFile(attempt.startedPath, JSON.stringify({
                    schema_version: attempt.schema_version,
                    attempt_id: attempt.attempt_id,
                    nonce: attempt.nonce,
                    team_name: attempt.team_name,
                    worker_name: attempt.worker_name,
                    pane_id: attempt.pane_id,
                    provider: attempt.provider,
                    created_at: attempt.created_at,
                    kind: 'worker_launch_provider_started',
                    pid: process.pid,
                    process_start_identity: 'test:provider-start',
                    written_at: new Date().toISOString(),
                }), 'utf8');
                tmuxState.activeAttempt = null;
            }
            return { stdout: '', stderr: '' };
        }),
        tmuxCmdAsync: vi.fn(async (args) => {
            tmuxState.args.push(args);
            if (args.includes('#{pane_dead} #{pane_current_command}')) {
                return { stdout: tmuxState.paneStatus, stderr: '' };
            }
            if (args.includes('#{pane_in_mode}'))
                return { stdout: '0\n', stderr: '' };
            return { stdout: '', stderr: '' };
        }),
    };
});
import { deliverStartupInbox, adoptWorkerPaneOwnership, proveWorkerPaneOwnership, spawnWorkerInPane, spawnOwnedWorkerInPane, retryStartupInboxSubmit, } from '../tmux-session.js';
import { awaitWorkerLaunchAcknowledgement, prepareWorkerLaunchAttempt, } from '../worker-launch-ack.js';
let cwd = '';
let originalPlatform;
beforeEach(() => {
    tmuxState.args = [];
    tmuxState.captures = [];
    tmuxState.paneStatus = '0 cmd\n';
    tmuxState.activeAttempt = null;
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    processMocks.isProcessIdentityLive.mockResolvedValue('live');
});
afterEach(async () => {
    if (originalPlatform)
        Object.defineProperty(process, 'platform', originalPlatform);
    delete process.env.MSYSTEM;
    delete process.env.MINGW_PREFIX;
    delete process.env.COMSPEC;
    delete process.env.TMUX;
    delete process.env.OMC_TEAM_START_ACK_TIMEOUT_MS;
    if (cwd)
        await rm(cwd, { recursive: true, force: true });
    cwd = '';
});
function ownership(paneId = '%2') {
    return {
        provider: 'tmux',
        providerTarget: 'startup:0',
        paneId,
        splitTarget: '%1',
        leaderPaneId: '%1',
        reservedPaneIds: [],
        source: 'split',
    };
}
async function acceptedContext(provider) {
    cwd = await mkdtemp(join(tmpdir(), 'startup-context-'));
    const attempt = await prepareWorkerLaunchAttempt({
        cwd,
        teamName: 'startup-team',
        workerName: 'worker-1',
        paneId: '%2',
        provider,
        runtimeCliPath: '/runtime-cli.cjs',
    });
    await writeFile(attempt.ackPath, JSON.stringify({
        schema_version: attempt.schema_version,
        attempt_id: attempt.attempt_id,
        nonce: attempt.nonce,
        team_name: attempt.team_name,
        worker_name: attempt.worker_name,
        pane_id: attempt.pane_id,
        provider: attempt.provider,
        created_at: attempt.created_at,
        kind: 'worker_launch_ack',
        written_at: new Date().toISOString(),
    }), 'utf8');
    await awaitWorkerLaunchAcknowledgement(attempt, { timeoutMs: 100, pollIntervalMs: 5 });
    return { ownership: ownership(), attempt, provider };
}
describe('worker pane startup safety', () => {
    it.each([
        ['leader_alias', '%1', '%1', []],
        ['split_target_alias', '%3', '%1', []],
        ['reserved_worker_alias', '%4', '%1', ['%4']],
    ])('rejects %s before pane mutation', (reason, paneId, leaderPaneId, reservedPaneIds) => {
        const result = proveWorkerPaneOwnership({
            commandSucceeded: true,
            provider: 'tmux',
            splitTarget: reason === 'split_target_alias' ? paneId : '%9',
            direction: 'right',
            rawOutput: `${paneId}\n`,
            stderr: '',
            paneId,
        }, { providerTarget: 'startup:0', leaderPaneId, reservedPaneIds });
        expect(result).toEqual({ ok: false, reason });
        expect(tmuxState.args).toEqual([]);
    });
    it('adopts only panes proven inside the expected tmux target', async () => {
        const owned = await adoptWorkerPaneOwnership({
            provider: 'tmux',
            providerTarget: 'startup:0',
            paneId: '%9',
            leaderPaneId: '%1',
            reservedPaneIds: [],
            dependencies: {
                tmuxExec: vi.fn(async (args) => {
                    expect(args).toEqual(['list-panes', '-t', 'startup:0', '-F', '#{pane_id}']);
                    return { stdout: '%9\n', stderr: '' };
                }),
                cmuxExec: vi.fn(),
            },
        });
        expect(owned).toMatchObject({ ok: true, ownership: { paneId: '%9', providerTarget: 'startup:0', source: 'adopted' } });
        await expect(adoptWorkerPaneOwnership({
            provider: 'tmux',
            providerTarget: 'startup:0',
            paneId: '%9',
            leaderPaneId: '%1',
            reservedPaneIds: [],
            dependencies: {
                tmuxExec: vi.fn(async (args) => {
                    expect(args).toEqual(['list-panes', '-t', 'startup:0', '-F', '#{pane_id}']);
                    return { stdout: '%8\n', stderr: '' };
                }),
                cmuxExec: vi.fn(),
            },
        })).resolves.toEqual({ ok: false, reason: 'pane_foreign' });
    });
    it.each([
        ['wide visible command', 'node runtime-cli.cjs --worker-launch', undefined, 'codex'],
        ['narrow wrapped command', 'node runtime-\ncli.cjs --worker-\nlaunch', undefined, 'claude'],
        ['stale scrollback command', 'old launch command\n› ready', undefined, 'codex'],
        ['alternate-screen repaint', '\u001b[?1049h\u001b[2Jprovider ui', undefined, 'claude'],
        ['capture failure placeholder', '', undefined, 'codex'],
        ['ignored capture-pane -J', new Error('unknown option -- J'), undefined, 'claude'],
        ['in-session psmux', 'provider ui', '/tmp/psmux/default,11877,0', 'codex'],
    ])('accepts a stable Windows cmd wrapper independently of %s capture', async (_fixture, captured, tmuxEnv, provider) => {
        cwd = await mkdtemp(join(tmpdir(), 'startup-stable-cmd-'));
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        process.env.COMSPEC = 'cmd.exe';
        if (tmuxEnv)
            process.env.TMUX = tmuxEnv;
        else
            delete process.env.TMUX;
        tmuxState.captures = [captured];
        const attempt = await prepareWorkerLaunchAttempt({
            cwd,
            teamName: 'startup-team',
            workerName: 'worker-1',
            paneId: '%2',
            provider,
            runtimeCliPath: 'C:\\Program Files\\omc\\runtime-cli.cjs',
        });
        tmuxState.activeAttempt = attempt;
        await expect(spawnWorkerInPane('startup:0', '%2', {
            teamName: 'startup-team',
            workerName: 'worker-1',
            envVars: { OMC_TEAM_WORKER: 'startup-team/worker-1' },
            launchBinary: provider === 'codex'
                ? 'C:\\Program Files\\Codex\\codex.exe'
                : 'C:\\Program Files\\Claude\\claude.exe',
            launchArgs: ['--full-auto'],
            cwd,
            provider,
            launchAttempt: attempt,
        })).resolves.toBeUndefined();
        const launchSend = tmuxState.args.find(args => args[0] === 'send-keys' && args.includes('-l'));
        expect(launchSend?.at(-1)).toMatch(/^\.omc\\state\\team\\startup-team\\workers\\worker-1\\launch-attempts\\[0-9a-f-]+\\launch\.cmd$/);
        expect(launchSend?.at(-1)).not.toContain('cmd.exe');
        expect(launchSend?.at(-1)).not.toContain('OMC_TEAM_WORKER');
        expect(launchSend?.at(-1)).not.toContain('Codex');
        expect(launchSend?.at(-1)).not.toContain('Claude');
        const literalIndex = tmuxState.args.indexOf(launchSend);
        const enterIndex = tmuxState.args.findIndex(args => args[0] === 'send-keys' && args.at(-1) === 'Enter');
        expect(literalIndex).toBeGreaterThanOrEqual(0);
        expect(enterIndex).toBeGreaterThan(literalIndex);
        expect(launchSend).toEqual(['send-keys', '-t', '%2', '-l', launchSend?.at(-1)]);
        expect(tmuxState.args[enterIndex]).toEqual(['send-keys', '-t', '%2', 'Enter']);
        expect(tmuxState.args.some(args => args[0] === 'capture-pane')).toBe(true);
        expect(tmuxState.args.some(args => args.includes('#{pane_dead} #{pane_current_command}'))).toBe(true);
        expect(tmuxState.paneStatus).toBe('0 cmd\n');
    });
    it('POSIX supervised writer delivers an attempt-owned descriptor the runtime CLI accepts', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'startup-posix-descriptor-'));
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        const attempt = await prepareWorkerLaunchAttempt({
            cwd,
            teamName: 'startup-team',
            workerName: 'worker-1',
            paneId: '%2',
            provider: 'codex',
            runtimeCliPath: '/runtime-cli.cjs',
        });
        await expect(spawnWorkerInPane('startup:0', '%2', {
            teamName: 'startup-team',
            workerName: 'worker-1',
            envVars: { OMC_TEAM_WORKER: 'startup-team/worker-1' },
            launchBinary: '/usr/bin/codex',
            launchArgs: ['--full-auto'],
            cwd,
            provider: 'codex',
            launchAttempt: attempt,
        })).resolves.toBeUndefined();
        const launchSend = tmuxState.args.find(args => args[0] === 'send-keys' && args.includes('-l'));
        const cmd = String(launchSend?.at(-1) ?? '');
        // The delivered command references the attempt-owned descriptor by path;
        // the bootstrap spec never travels inline (issue #3655).
        expect(cmd).toContain("OMC_WORKER_LAUNCH_SPEC_FILE='");
        expect(cmd).not.toContain('OMC_WORKER_LAUNCH_SPEC=');
        expect(cmd).not.toContain('--full-auto');
        const descriptorPath = cmd.match(/OMC_WORKER_LAUNCH_SPEC_FILE='([^']+)'/)?.[1];
        expect(descriptorPath).toBe(attempt.bootstrapDescriptorPath);
        const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
        expect(descriptor.attempt_id).toBe(attempt.attempt_id);
        expect(descriptor.provider_argv).toEqual(['/usr/bin/codex', '--full-auto']);
        expect(Buffer.byteLength(cmd, 'utf8')).toBeLessThan(2_048);
        // POSIX delivery does not need the Windows-native post-enter capture pass;
        // readiness is proven through the ack/provider-start handoff instead.
        expect(tmuxState.args.some(args => args[0] === 'capture-pane')).toBe(false);
    });
    it('clears an exact Codex directory selector before typing the inbox trigger', async () => {
        const context = await acceptedContext('codex');
        tmuxState.captures = [
            'Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit\n',
            '› ready\n',
        ];
        await expect(deliverStartupInbox(context, 'Read inbox.md, execute now.')).resolves.toEqual({
            ok: true,
            kind: 'attempted_unconfirmed',
        });
        const literalInputs = tmuxState.args
            .filter(args => args[0] === 'send-keys' && args.includes('-l'))
            .map(args => args.at(-1));
        expect(literalInputs).toEqual(['1', 'Read inbox.md, execute now.']);
        expect(tmuxState.args.findIndex(args => args.at(-1) === '1'))
            .toBeLessThan(tmuxState.args.findIndex(args => args.at(-1) === 'Read inbox.md, execute now.'));
    });
    it('handles the exact Codex directory and hooks selectors in order before delivery', async () => {
        const context = await acceptedContext('codex');
        tmuxState.captures = [
            'Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit\n',
            'Hooks need review\n› 3. Continue without trusting\nPress enter to confirm or esc to go back\n',
            '› ready\n',
        ];
        await expect(deliverStartupInbox(context, 'Read inbox.md, execute now.')).resolves.toEqual({
            ok: true,
            kind: 'attempted_unconfirmed',
        });
        const literalInputs = tmuxState.args
            .filter(args => args[0] === 'send-keys' && args.includes('-l'))
            .map(args => args.at(-1));
        expect(literalInputs).toEqual(['1', '3', 'Read inbox.md, execute now.']);
    });
    it('fails closed when the selector persists after the narrow action', async () => {
        const context = await acceptedContext('codex');
        const selector = 'Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit\n';
        tmuxState.captures = [selector, selector];
        await expect(deliverStartupInbox(context, 'Read inbox.md, execute now.')).resolves.toEqual({
            ok: false,
            reason: 'selector_persistent',
        });
        expect(tmuxState.args.some(args => args.at(-1) === 'Read inbox.md, execute now.')).toBe(false);
    });
    it('retries Enter only when the exact startup trigger is visibly pending', async () => {
        const context = await acceptedContext('claude');
        const message = 'Read inbox.md, execute now.';
        tmuxState.captures = [`❯ ${message}\n`];
        await expect(retryStartupInboxSubmit(context, message)).resolves.toBe(true);
        expect(tmuxState.args.some(args => args[0] === 'send-keys' && args.at(-1) === 'Enter')).toBe(true);
    });
    it('does not retry Enter for unrelated pane text', async () => {
        const context = await acceptedContext('claude');
        tmuxState.captures = ['❯ unrelated text\n'];
        await expect(retryStartupInboxSubmit(context, 'Read inbox.md, execute now.')).resolves.toBe(false);
        expect(tmuxState.args.some(args => args[0] === 'send-keys' && args.at(-1) === 'Enter')).toBe(false);
    });
    it('never sends a Gemini confirmation key without an evidence-backed Gemini selector', async () => {
        const context = await acceptedContext('gemini');
        tmuxState.captures = [
            'Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit\n',
        ];
        await expect(deliverStartupInbox(context, 'Read inbox.md, execute now.')).resolves.toEqual({
            ok: false,
            reason: 'selector_unsupported',
        });
        expect(tmuxState.args.some(args => args.at(-1) === '1')).toBe(false);
        expect(tmuxState.args.some(args => args.at(-1) === 'Read inbox.md, execute now.')).toBe(false);
    });
    it('does not send the Codex hooks selector key to Claude', async () => {
        const context = await acceptedContext('claude');
        tmuxState.captures = [
            'Hooks need review\n› 3. Continue without trusting\nPress enter to confirm or esc to go back\n',
        ];
        await expect(deliverStartupInbox(context, 'Read inbox.md, execute now.')).resolves.toEqual({
            ok: false,
            reason: 'selector_unsupported',
        });
        expect(tmuxState.args.some(args => args.at(-1) === '3')).toBe(false);
    });
    it('emits bounded redacted capture diagnostics and never treats failure as readiness', async () => {
        const context = await acceptedContext('codex');
        const secret = 'SUPERSECRET_VALUE';
        const jsonSecret = 'JSON_ONLY_SECRET';
        tmuxState.captures = [new Error(`capture failed --api-key ${secret} Bearer ${secret} {"provider_argv":["codex","--token","${jsonSecret}"]}`)];
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        await expect(deliverStartupInbox(context, 'Read inbox.md, execute now.')).resolves.toEqual({
            ok: false,
            reason: 'capture_failed',
        });
        const diagnostic = stderr.mock.calls.map(call => String(call[0])).join('');
        expect(diagnostic).toContain('pane capture failed operation=startup-readiness pane=%2');
        expect(diagnostic).not.toContain(secret);
        expect(diagnostic).not.toContain(jsonSecret);
        expect(diagnostic.length).toBeLessThan(500);
        stderr.mockRestore();
    });
    it('retires an accepted launch but preserves the pane when provider cleanup is unverified', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-startup-handoff-cleanup-'));
        process.env.OMC_TEAM_START_ACK_TIMEOUT_MS = '50';
        processMocks.isProcessIdentityLive.mockResolvedValue('dead');
        await expect(spawnOwnedWorkerInPane('startup:0', ownership(), {
            teamName: 'startup-team',
            workerName: 'worker-1',
            envVars: {},
            launchArgs: ['--version'],
            launchBinary: '/usr/bin/codex',
            cwd,
            provider: 'codex',
            launchBootstrapPath: '/runtime-cli.js',
            launchStateCwd: cwd,
            launchContext: { kind: 'initial' },
        })).rejects.toThrow('worker_launch_cleanup_unverified');
        expect(tmuxState.args).not.toContainEqual(['kill-pane', '-t', '%2']);
        const attemptsRoot = join(cwd, '.omc/state/team/startup-team/workers/worker-1/launch-attempts');
        const files = await readdir(attemptsRoot, { recursive: true });
        expect(files.some(file => String(file).endsWith('decision.json.retired'))).toBe(true);
        expect(tmuxState.paneStatus).toBe('0 cmd\n');
        delete process.env.OMC_TEAM_START_ACK_TIMEOUT_MS;
    });
});
//# sourceMappingURL=tmux-session.startup.test.js.map