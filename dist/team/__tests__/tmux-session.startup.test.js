import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentStrictProcessStartIdentity } from '../team-owner-epoch.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';
const fixtureProcessStartIdentity = currentStrictProcessStartIdentity();
const supportsStrictTmuxFixture = fixtureProcessStartIdentity !== null
    && (process.platform === 'darwin' || process.platform === 'linux');
const fixtureTmuxServerIdentity = supportsStrictTmuxFixture
    ? {
        socket_path: '/tmp/omc-tmux-session-startup.sock',
        server_pid: process.pid,
        process_started_at: fixtureProcessStartIdentity,
    }
    : undefined;
function strictTmuxIdentity() {
    if (!fixtureTmuxServerIdentity)
        throw new Error('strict tmux fixture unsupported on this platform');
    return fixtureTmuxServerIdentity;
}
function guardedShellWords(command) {
    return [...command.matchAll(/'((?:[^']|'"'"')*)'/g)].map(match => match[1].replace(/'"'"'/g, "'"));
}
const strictTmuxIt = supportsStrictTmuxFixture ? it : it.skip;
const processMocks = vi.hoisted(() => ({
    isProcessIdentityLive: vi.fn(async () => 'live'),
}));
function stripTmuxIdentityPrefixes(args) {
    const socketPath = fixtureTmuxServerIdentity?.socket_path;
    let index = 0;
    while (socketPath && args[index] === '-S' && args[index + 1] === socketPath) {
        index += 2;
    }
    return [...args.slice(index)];
}
vi.mock('../../platform/process-utils.js', async (importOriginal) => ({
    ...await importOriginal(),
    isProcessIdentityLive: processMocks.isProcessIdentityLive,
}));
const tmuxState = vi.hoisted(() => ({
    args: [],
    captures: [],
    captureAt: null,
    sendTimes: [],
    paneStatus: '0 cmd\n',
    paneMode: '0\n',
    ownedPaneIds: '%2\n',
    livenessError: null,
    captureError: null,
    activeAttempt: null,
}));
vi.mock('../../cli/tmux-utils.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        tmuxExecAsync: vi.fn(async (args) => {
            tmuxState.args.push(args);
            const commandIndex = args[0] === '-S' ? 2 : 0;
            const command = args[commandIndex];
            if (command === 'kill-pane')
                tmuxState.paneStatus = '1 cmd\n';
            if (command === 'list-panes')
                return { stdout: tmuxState.ownedPaneIds, stderr: '' };
            if (command === 'capture-pane') {
                if (commandIndex === 2)
                    tmuxState.args.push(args.slice(commandIndex));
                if (tmuxState.captureError)
                    throw tmuxState.captureError;
                if (tmuxState.captureAt)
                    return { stdout: tmuxState.captureAt(), stderr: '' };
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
                        instance_id: spec.instance_id,
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
                            instance_id: spec.instance_id,
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
                    instance_id: attempt.instance_id,
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
                    instance_id: attempt.instance_id,
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
            const commandIndex = args[0] === '-S' ? 2 : 0;
            const command = args[commandIndex];
            if (command === 'display-message' && args.includes('#{pid}')) {
                return { stdout: `${process.pid}\n`, stderr: '' };
            }
            if (args.includes('#{pane_dead}')) {
                if (tmuxState.livenessError)
                    throw tmuxState.livenessError;
                return { stdout: tmuxState.paneStatus.startsWith('1') ? '1\n' : '0\n', stderr: '' };
            }
            if (args.includes('#{pane_dead} #{pane_current_command}')) {
                if (tmuxState.livenessError)
                    throw tmuxState.livenessError;
                return { stdout: tmuxState.paneStatus, stderr: '' };
            }
            if (args.includes('#{pane_in_mode}'))
                return { stdout: tmuxState.paneMode, stderr: '' };
            if (command === 'if-shell') {
                const success = args[commandIndex + 2] ?? '';
                const words = guardedShellWords(success);
                const nativeCommand = words[0];
                const syntheticArgs = words.slice(0, words.indexOf('display-message'));
                if (nativeCommand === 'send-keys') {
                    tmuxState.args.push(syntheticArgs);
                    tmuxState.sendTimes.push(Date.now());
                    if (syntheticArgs.includes('-l')) {
                        const commandText = syntheticArgs[syntheticArgs.indexOf('-l') + 1] ?? '';
                        const descriptorMatch = commandText.match(/OMC_WORKER_LAUNCH_SPEC_FILE='([^']+)'/);
                        if (descriptorMatch) {
                            const spec = JSON.parse(await readFile(descriptorMatch[1], 'utf8'));
                            tmuxState.activeAttempt = {
                                schema_version: spec.schema_version,
                                attempt_id: spec.attempt_id,
                                nonce: spec.nonce,
                                instance_id: spec.instance_id,
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
                    if (syntheticArgs.at(-1) === 'Enter' && tmuxState.activeAttempt) {
                        const attempt = tmuxState.activeAttempt;
                        await writeFile(attempt.ackPath, JSON.stringify({
                            schema_version: attempt.schema_version,
                            attempt_id: attempt.attempt_id,
                            nonce: attempt.nonce,
                            instance_id: attempt.instance_id,
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
                            instance_id: attempt.instance_id,
                            team_name: attempt.team_name,
                            worker_name: attempt.worker_name,
                            pane_id: attempt.pane_id,
                            provider: attempt.provider,
                            created_at: attempt.created_at,
                            kind: 'worker_launch_provider_started',
                            pid: process.pid,
                            process_start_identity: fixtureProcessStartIdentity,
                            written_at: new Date().toISOString(),
                        }), 'utf8');
                        tmuxState.activeAttempt = null;
                    }
                }
                const marker = success.match(/OMC_TMUX_GUARD_OK_[A-Za-z0-9_]+/)?.[0];
                return { stdout: marker ? `${marker}\n` : '', stderr: '' };
            }
            return { stdout: '', stderr: '' };
        }),
    };
});
import { deliverStartupInbox, adoptWorkerPaneOwnership, proveWorkerPaneOwnership, probeStartupPaneActivity, buildWorkerStartCommand, spawnWorkerInPane, spawnOwnedWorkerInPane, retryStartupInboxSubmit, injectToLeaderPane, sendToWorker, paneHasActiveTask, paneHasTrustPrompt, paneLooksReady, waitForStartupPaneReady, } from '../tmux-session.js';
import { paneLineLooksLikeIdlePrompt } from '../pane-readiness.js';
import { awaitWorkerLaunchAcknowledgement, prepareWorkerLaunchAttempt, } from '../worker-launch-ack.js';
let cwd = '';
let originalPlatform;
let fixtureEnvCaptured = false;
let originalHome;
let originalUserProfile;
let originalStateDir;
function isolateFixtureRoot(root) {
    if (!fixtureEnvCaptured) {
        originalHome = process.env.HOME;
        originalUserProfile = process.env.USERPROFILE;
        originalStateDir = process.env.OMC_STATE_DIR;
        fixtureEnvCaptured = true;
    }
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    delete process.env.OMC_STATE_DIR;
}
async function createFixture(prefix) {
    const root = await mkdtemp(join(tmpdir(), prefix));
    isolateFixtureRoot(root);
    return root;
}
function restoreFixtureEnv() {
    if (!fixtureEnvCaptured)
        return;
    if (originalHome === undefined)
        delete process.env.HOME;
    else
        process.env.HOME = originalHome;
    if (originalUserProfile === undefined)
        delete process.env.USERPROFILE;
    else
        process.env.USERPROFILE = originalUserProfile;
    if (originalStateDir === undefined)
        delete process.env.OMC_STATE_DIR;
    else
        process.env.OMC_STATE_DIR = originalStateDir;
    fixtureEnvCaptured = false;
    originalHome = undefined;
    originalUserProfile = undefined;
    originalStateDir = undefined;
}
beforeEach(() => {
    tmuxState.args = [];
    tmuxState.captures = [];
    tmuxState.captureAt = null;
    tmuxState.sendTimes = [];
    tmuxState.paneStatus = '0 cmd\n';
    tmuxState.paneMode = '0\n';
    tmuxState.ownedPaneIds = '%2\n';
    tmuxState.livenessError = null;
    tmuxState.captureError = null;
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
    restoreFixtureEnv();
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
        ...(fixtureTmuxServerIdentity ? { tmuxServerIdentity: fixtureTmuxServerIdentity } : {}),
    };
}
async function acceptedContext(provider) {
    cwd = await createFixture('startup-context-');
    const attempt = await prepareWorkerLaunchAttempt({
        cwd,
        teamName: 'startup-team',
        workerName: 'worker-1',
        instanceId: randomUUID(),
        paneId: '%2',
        provider,
        runtimeCliPath: '/runtime-cli.cjs',
    });
    await writeFile(attempt.ackPath, JSON.stringify({
        schema_version: attempt.schema_version,
        attempt_id: attempt.attempt_id,
        nonce: attempt.nonce,
        instance_id: attempt.instance_id,
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
async function markProviderExited(attempt) {
    const expected = JSON.parse(await readFile(attempt.expectedPath, 'utf8'));
    const processIdentity = {
        pid: 999_999,
        process_start_identity: process.platform === 'darwin' ? 'darwin:1:0' : `${process.platform}:1`,
        process_group_id: 999_999,
    };
    await writeFile(attempt.startedPath, JSON.stringify({
        ...expected,
        kind: 'worker_launch_provider_started',
        ...processIdentity,
        written_at: new Date().toISOString(),
    }));
    await writeFile(`${attempt.startedPath}.terminal`, JSON.stringify({
        ...expected,
        kind: 'worker_launch_provider_terminal',
        outcome: 'exit',
        cleanup_verified: true,
        child_reaped: true,
        ...processIdentity,
        written_at: new Date().toISOString(),
    }));
}
describe('worker pane startup safety', () => {
    it.each([
        ['legacy Codex prompt', undefined, '› ', true],
        ['legacy Claude prompt', undefined, '❯ ', true],
        ['legacy generic prompt', undefined, '> ', true],
        ['legacy Cursor arrow', undefined, '→ ', false],
        ['Cursor prompt', 'cursor', '→ ', true],
        ['Claude rejects Cursor arrow', 'claude', '→ ', false],
        ['Codex rejects Cursor arrow', 'codex', '→ ', false],
        ['Cursor rejects embedded arrow', 'cursor', 'completed → next', false],
        ['existing Gemini prompt behavior', 'gemini', '❯ ', true],
    ])('detects %s', (_name, provider, line, expected) => {
        expect(paneLineLooksLikeIdlePrompt(line, provider)).toBe(expected);
    });
    strictTmuxIt.each([
        ['cursor', '→ ', { ok: true }],
        ['claude', '→ ', { ok: false, reason: 'readiness_timeout' }],
        ['codex', '→ ', { ok: false, reason: 'readiness_timeout' }],
        ['cursor', 'completed → next', { ok: false, reason: 'readiness_timeout' }],
        ['claude', '❯ ', { ok: true }],
        ['codex', '› ', { ok: true }],
    ])('waits for the %s startup prompt without generic arrow matching', async (provider, capture, expected) => {
        const context = await acceptedContext(provider);
        tmuxState.captures = [capture];
        await expect(waitForStartupPaneReady(context, { timeoutMs: expected.ok ? 50 : 5, pollIntervalMs: 1 }))
            .resolves.toEqual(expected);
    });
    strictTmuxIt('rejects a Cursor prompt retained above its active-task stop marker', async () => {
        const context = await acceptedContext('cursor');
        tmuxState.captures = ['→ Plan, search, build anything\nWorking on the task\nctrl+c to stop'];
        await expect(waitForStartupPaneReady(context, { timeoutMs: 50, pollIntervalMs: 1 }))
            .resolves.toEqual({ ok: false, reason: 'pane_busy' });
    });
    strictTmuxIt.each([
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
            tmuxServerIdentity: strictTmuxIdentity(),
        }, {
            providerTarget: 'startup:0',
            leaderPaneId,
            reservedPaneIds,
            tmuxServerIdentity: strictTmuxIdentity(),
        });
        expect(result).toEqual({ ok: false, reason });
        expect(tmuxState.args).toEqual([]);
    });
    strictTmuxIt('adopts only panes proven inside the expected tmux target', async () => {
        const serverIdentityDependencies = {
            tmuxQuery: vi.fn(async (args) => {
                tmuxState.args.push(args);
                return { stdout: `${strictTmuxIdentity().server_pid}\n`, stderr: '' };
            }),
            processIdentity: vi.fn(() => strictTmuxIdentity().process_started_at),
            processObservation: vi.fn(() => 'matching'),
        };
        const owned = await adoptWorkerPaneOwnership({
            provider: 'tmux',
            providerTarget: 'startup:0',
            paneId: '%9',
            leaderPaneId: '%1',
            reservedPaneIds: [],
            tmuxServerIdentity: strictTmuxIdentity(),
            serverIdentityDependencies,
            dependencies: {
                serverIdentityDependencies,
                tmuxExec: vi.fn(async (args) => {
                    expect(args[0]).toBe('-S');
                    expect(args[1]).toBe(strictTmuxIdentity().socket_path);
                    expect(stripTmuxIdentityPrefixes(args)).toEqual([
                        'list-panes', '-t', '=startup:0', '-F', '#{pane_id}',
                    ]);
                    return { stdout: '%9\n', stderr: '' };
                }),
                cmuxExec: vi.fn(),
            },
        });
        expect(owned).toMatchObject({ ok: true, ownership: { paneId: '%9', providerTarget: 'startup:0', source: 'adopted' } });
        expect(tmuxState.args).toContainEqual([
            '-S', strictTmuxIdentity().socket_path, 'display-message', '-p', '#{pid}',
        ]);
        await expect(adoptWorkerPaneOwnership({
            provider: 'tmux',
            providerTarget: 'startup:0',
            paneId: '%9',
            leaderPaneId: '%1',
            reservedPaneIds: [],
            tmuxServerIdentity: strictTmuxIdentity(),
            serverIdentityDependencies,
            dependencies: {
                serverIdentityDependencies,
                tmuxExec: vi.fn(async (args) => {
                    expect(args[0]).toBe('-S');
                    expect(args[1]).toBe(strictTmuxIdentity().socket_path);
                    expect(stripTmuxIdentityPrefixes(args)).toEqual([
                        'list-panes', '-t', '=startup:0', '-F', '#{pane_id}',
                    ]);
                    return { stdout: '%8\n', stderr: '' };
                }),
                cmuxExec: vi.fn(),
            },
        })).resolves.toEqual({ ok: false, reason: 'pane_foreign' });
    });
    strictTmuxIt.each([
        ['wide visible command', 'node runtime-cli.cjs --worker-launch', undefined, 'codex'],
        ['narrow wrapped command', 'node runtime-\ncli.cjs --worker-\nlaunch', undefined, 'claude'],
        ['stale scrollback command', 'old launch command\n› ready', undefined, 'codex'],
        ['alternate-screen repaint', '\u001b[?1049h\u001b[2Jprovider ui', undefined, 'claude'],
        ['capture failure placeholder', '', undefined, 'codex'],
        ['ignored capture-pane -J', new Error('unknown option -- J'), undefined, 'claude'],
        ['in-session psmux', 'provider ui', '/tmp/psmux/default,11877,0', 'codex'],
    ])('accepts a stable Windows cmd wrapper independently of %s capture', async (_fixture, captured, tmuxEnv, provider) => {
        cwd = await createFixture('startup-stable-cmd-');
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
            instanceId: randomUUID(),
            paneId: '%2',
            provider,
            runtimeCliPath: 'C:\\Program Files\\omc\\runtime-cli.cjs',
        });
        tmuxState.activeAttempt = attempt;
        if (process.platform === 'win32') {
            const builderCommand = buildWorkerStartCommand({
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
            });
            expect(builderCommand).toContain('runtime-cli.cjs');
            expect(builderCommand).toContain('OMC_WORKER_LAUNCH_SPEC_FILE');
            expect(builderCommand).not.toContain('OMC_WORKER_LAUNCH_SPEC=');
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
            })).rejects.toThrow('worker_start_tmux_server_identity_missing');
            expect(tmuxState.args).toEqual([]);
            return;
        }
        await expect(spawnWorkerInPane('startup:0', '%2', {
            teamName: 'startup-team',
            workerName: 'worker-1',
            tmuxServerIdentity: strictTmuxIdentity(),
            instanceId: attempt.instance_id,
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
        const canonicalWrapperPath = join(getOmcRoot(cwd), 'state', 'team', 'startup-team', 'workers', 'worker-1', 'launch-attempts', attempt.attempt_id, 'launch.cmd');
        expect(launchSend?.at(-1)).toBe(relative(cwd, canonicalWrapperPath).replace(/\//g, '\\'));
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
        expect(tmuxState.args.some(args => args[0] === '-S' && args[2] === 'if-shell' && args[4]?.includes("'send-keys'"))).toBe(true);
        expect(tmuxState.paneStatus).toBe('0 cmd\n');
    });
    strictTmuxIt('POSIX supervised writer delivers an attempt-owned descriptor the runtime CLI accepts', async () => {
        cwd = await createFixture('startup-posix-descriptor-');
        const attempt = await prepareWorkerLaunchAttempt({
            cwd,
            teamName: 'startup-team',
            workerName: 'worker-1',
            instanceId: randomUUID(),
            paneId: '%2',
            provider: 'codex',
            runtimeCliPath: '/runtime-cli.cjs',
        });
        await expect(spawnWorkerInPane('startup:0', '%2', {
            teamName: 'startup-team',
            workerName: 'worker-1',
            tmuxServerIdentity: strictTmuxIdentity(),
            instanceId: attempt.instance_id,
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
        expect(descriptor.instance_id).toBe(attempt.instance_id);
        expect(descriptor.provider_argv).toEqual(['/usr/bin/codex', '--full-auto']);
        expect(tmuxState.args.some(args => args[0] === '-S' && args[2] === 'if-shell' && args[4]?.includes("'send-keys'"))).toBe(true);
        expect(Buffer.byteLength(cmd, 'utf8')).toBeLessThan(2_048);
        // POSIX delivery does not need the Windows-native post-enter capture pass;
        // readiness is proven through the ack/provider-start handoff instead.
        expect(tmuxState.args.some(args => args[0] === 'capture-pane')).toBe(false);
    });
    strictTmuxIt('clears an exact Codex directory selector before typing the inbox trigger', async () => {
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
        expect(tmuxState.args.filter(args => args[0] === 'send-keys' && args.at(-1) === 'Enter')).toHaveLength(3);
        expect(tmuxState.args.some(args => args[0] === 'send-keys' && args.at(-1) === 'C-m')).toBe(false);
    });
    strictTmuxIt('refuses Codex folder trust without selecting trust or delivering task text', async () => {
        const context = await acceptedContext('codex');
        const capture = [
            'Folder access', 'D:\\test\\repo',
            'Trust this folder? Codex can read, edit, and',
            'run files here, subject to your permission',
            'settings. Folder settings can run code',
            'automatically, even without a model request.',
            'Continue only if you trust these files. Your',
            'trust decision will be saved.',
            'Review the files in this folder before continuing.',
            'Folder settings may allow code to run automatically.',
            'Only proceed when you recognize and trust this project.',
            'Trust applies to the current workspace folder.',
            'The selected choice is saved for future sessions.',
            'You can quit now and inspect the folder first.',
            'Folder access may include reading project files.',
            'Folder access may include editing project files.',
            'Review any automated actions before granting access.',
            'Do not continue if the folder is unfamiliar.',
            'The trust decision should reflect your own judgment.',
            'You can return after reviewing the project contents.',
            'This prompt requires an explicit user decision.',
            '› 1. Trust and continue', '  2. Quit',
            'enter continue · esc quit',
        ].join('\n');
        tmuxState.captures = [capture];
        expect(paneHasTrustPrompt(capture, 'codex')).toBe(true);
        expect(paneLooksReady(capture, 'codex')).toBe(false);
        expect(paneHasActiveTask(capture, 'codex')).toBe(false);
        expect(paneHasTrustPrompt(capture, 'claude')).toBe(false);
        const partialCaptures = [
            ['› ready', 'Trust this folder?'].join('\n'),
            ['Trust this folder?', '› 1. Trust and continue'].join('\n'),
            ['Trust this folder?', '› 1. Trust and', 'continue'].join('\n'),
            ['Trust this folder?', '› 1. Trust and'].join('\n'),
            ['Trust this folder?', '› 1.'].join('\n'),
            ['Trust this folder?', '› 1'].join('\n'),
            ['Trust this folder?', '›'].join('\n'),
        ];
        for (const partialCapture of partialCaptures) {
            expect(paneHasTrustPrompt(partialCapture, 'codex')).toBe(true);
            expect(paneLooksReady(partialCapture, 'codex')).toBe(false);
            tmuxState.args = [];
            tmuxState.captures = [partialCapture];
            await expect(deliverStartupInbox(context, 'List files and report the result.')).resolves.toEqual({
                ok: false,
                reason: 'codex_workspace_untrusted',
            });
            expect(tmuxState.args.some(args => args.includes('send-keys'))).toBe(false);
            tmuxState.args = [];
            tmuxState.captures = [partialCapture];
            await expect(sendToWorker('', '%2', 'List files and report the result.', context.ownership.tmuxServerIdentity))
                .resolves.toBe(false);
            expect(tmuxState.args.some(args => args.includes('send-keys'))).toBe(false);
        }
        tmuxState.args = [];
        await expect(deliverStartupInbox(context, 'List files and report the result.')).resolves.toEqual({
            ok: false,
            reason: 'codex_workspace_untrusted',
        });
        await expect(sendToWorker('', '%2', 'List files and report the result.', context.ownership.tmuxServerIdentity))
            .resolves.toBe(false);
        expect(tmuxState.args.some(args => args.includes('send-keys'))).toBe(false);
        const staleCapture = [
            'Trust this folder?', '› 1. Trust and continue', '  2. Quit',
            '› ready',
        ].join('\n');
        expect(paneHasTrustPrompt(staleCapture, 'codex')).toBe(false);
        expect(paneLooksReady(staleCapture, 'codex')).toBe(true);
        const staleBarePromptCapture = [
            'Trust this folder?', '› 1. Trust and continue', '  2. Quit', '›',
        ].join('\n');
        expect(paneHasTrustPrompt(staleBarePromptCapture, 'codex')).toBe(false);
        expect(paneLooksReady(staleBarePromptCapture, 'codex')).toBe(true);
        const quitSelectedCapture = capture
            .replace('› 1. Trust and continue', '  1. Trust and continue')
            .replace('  2. Quit', '› 2. Quit');
        expect(paneHasTrustPrompt(quitSelectedCapture, 'codex')).toBe(true);
        expect(paneLooksReady(quitSelectedCapture, 'codex')).toBe(false);
        tmuxState.args = [];
        tmuxState.captures = [quitSelectedCapture];
        await expect(deliverStartupInbox(context, 'List files and report the result.')).resolves.toEqual({
            ok: false,
            reason: 'codex_workspace_untrusted',
        });
        expect(tmuxState.args.some(args => args.includes('send-keys'))).toBe(false);
    });
    strictTmuxIt('does not press Enter if Codex trust appears after direct text injection', async () => {
        const context = await acceptedContext('codex');
        const message = 'List files and report the result.';
        const trustSelector = [
            'Folder access', 'D:\\test\\repo',
            'Trust this folder? Codex can read, edit, and',
            'run files here, subject to your permission',
            'settings. Folder settings can run code',
            'automatically, even without a model request.',
            '› 1. Trust and continue', '  2. Quit',
        ].join('\n');
        tmuxState.args = [];
        tmuxState.captures = ['› ready\n', trustSelector];
        await expect(sendToWorker('', context.ownership.paneId, message, context.ownership.tmuxServerIdentity))
            .resolves.toBe(false);
        const literalInputs = tmuxState.args
            .filter(args => args[0] === 'send-keys' && args.includes('-l'))
            .map(args => args.at(-1));
        expect(literalInputs).toEqual([message]);
        expect(tmuxState.args.some(args => args[0] === 'send-keys' && args.at(-1) === 'Enter')).toBe(false);
    });
    strictTmuxIt('does not press startup Enter when Codex trust appears after trigger injection', async () => {
        const context = await acceptedContext('codex');
        const message = 'Read inbox.md, execute now.';
        const partialTrustSelector = ['Trust this folder?', '› 1. Trust and continue'].join('\n');
        tmuxState.args = [];
        tmuxState.captures = ['› ready\n', '› ready\n', partialTrustSelector];
        await expect(deliverStartupInbox(context, message)).resolves.toEqual({
            ok: false,
            reason: 'codex_workspace_untrusted',
        });
        const literalInputs = tmuxState.args
            .filter(args => args[0] === 'send-keys' && args.includes('-l'))
            .map(args => args.at(-1));
        expect(literalInputs).toEqual([message]);
        expect(tmuxState.args.filter(args => args[0] === 'send-keys' && args.at(-1) === 'Enter')).toHaveLength(0);
    });
    strictTmuxIt('rechecks Codex trust before the second startup Enter', async () => {
        const context = await acceptedContext('codex');
        const message = 'Read inbox.md, execute now.';
        const partialTrustSelector = ['Trust this folder?', '› 1. Trust and continue'].join('\n');
        tmuxState.args = [];
        tmuxState.captures = ['› ready\n', '› ready\n', '› ready\n', partialTrustSelector];
        await expect(deliverStartupInbox(context, message)).resolves.toEqual({
            ok: false,
            reason: 'codex_workspace_untrusted',
        });
        expect(tmuxState.args.filter(args => args[0] === 'send-keys' && args.at(-1) === 'Enter')).toHaveLength(1);
    });
    strictTmuxIt.each([
        ['Do you trust the files in this folder?', 'Yes, proceed'],
        ['Quick safety check: Is this a project you created or one you trust?', 'Yes, I trust this folder'],
        // Claude Code 2.1.310 wraps the question in a 59-column worker pane.
        ['Quick safety check: Is this a project you created or one\n you trust? (Like your own code, a well-known open source', 'Yes, I trust this folder'],
    ])('selects Yes in Claude Code’s new directory trust dialog before delivering the inbox (%s)', async (question, affirmativeChoice) => {
        const context = await acceptedContext('claude');
        tmuxState.captures = [
            `${question}\n❯ No, exit\n  ${affirmativeChoice}\n`,
            `${question}\n  No, exit\n❯ ${affirmativeChoice}\n`,
            '❯ ready\n',
        ];
        await expect(deliverStartupInbox(context, 'Read inbox.md, execute now.')).resolves.toEqual({
            ok: true,
            kind: 'attempted_unconfirmed',
        });
        const selectYesIndex = tmuxState.args.findIndex(args => args[0] === 'send-keys' && args.at(-1) === 'Down');
        const confirmYesIndex = tmuxState.args.findIndex((args, index) => index > selectYesIndex && args[0] === 'send-keys' && args.at(-1) === 'Enter');
        const inboxIndex = tmuxState.args.findIndex(args => args[0] === 'send-keys' && args.includes('-l') && args.at(-1) === 'Read inbox.md, execute now.');
        expect(selectYesIndex).toBeGreaterThanOrEqual(0);
        expect(confirmYesIndex).toBeGreaterThan(selectYesIndex);
        expect(inboxIndex).toBeGreaterThan(confirmYesIndex);
    });
    strictTmuxIt('presses Enter in Claude Code’s trust dialog only once the pane shows the affirmative choice focused', async () => {
        const context = await acceptedContext('claude');
        const question = 'Quick safety check: Is this a project you created or one you trust?';
        const frames = {
            no: `${question}\n❯ No, exit\n  Yes, I trust this folder\n`,
            yes: `${question}\n  No, exit\n❯ Yes, I trust this folder\n`,
            declined: `${question}\n❯ No, exit\n  Yes, I trust this folder\nClaude Code didn't start because this folder isn't trusted.\n`,
            trusted: '❯ \n',
        };
        // Hypothesis fitting the recorded failures: a busy Claude Code startup
        // reads the keys sent between two captures together and applies them
        // against the focus it drew before them.
        let focus = 'no';
        let applied = 0;
        tmuxState.captureAt = () => {
            const keys = tmuxState.args.slice(applied)
                .filter(args => args[0] === 'send-keys' && !args.includes('-l'))
                .map(args => args.at(-1));
            applied = tmuxState.args.length;
            const drawn = focus;
            for (const key of drawn === 'no' || drawn === 'yes' ? keys : []) {
                if (key === 'Enter') {
                    focus = drawn === 'yes' ? 'trusted' : 'declined';
                    break;
                }
                if (key === 'Down')
                    focus = 'yes';
            }
            return frames[focus];
        };
        await expect(deliverStartupInbox(context, 'Read inbox.md, execute now.')).resolves.toEqual({
            ok: true,
            kind: 'attempted_unconfirmed',
        });
        expect(focus).toBe('trusted');
    });
    strictTmuxIt('sends Down again when the first Down after the dialog draws is dropped', async () => {
        const context = await acceptedContext('claude');
        const question = 'Quick safety check: Is this a project you created or one you trust?';
        const frames = {
            no: `${question}\n❯ No, exit\n  Yes, I trust this folder\n`,
            yes: `${question}\n  No, exit\n❯ Yes, I trust this folder\n`,
            trusted: '❯ \n',
        };
        // Measured on Claude Code 2.1.328: a Down sent right after the dialog
        // first draws can be dropped. This pane drops the first Down.
        let focus = 'no';
        let applied = 0;
        let downs = 0;
        tmuxState.captureAt = () => {
            const keys = tmuxState.args.slice(applied)
                .filter(args => args[0] === 'send-keys' && !args.includes('-l'))
                .map(args => args.at(-1));
            applied = tmuxState.args.length;
            for (const key of keys) {
                if (key === 'Down' && ++downs > 1 && focus === 'no')
                    focus = 'yes';
                if (key === 'Enter' && focus === 'yes')
                    focus = 'trusted';
            }
            return frames[focus];
        };
        await expect(waitForStartupPaneReady(context, { timeoutMs: 3_000, attemptAlreadyFenced: true }))
            .resolves.toEqual({ ok: true });
        expect(focus).toBe('trusted');
        expect(downs).toBe(2);
    });
    const trustQuestion = 'Quick safety check: Is this a project you created or one you trust?';
    const readFrame = (path) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pane-frames', path), 'utf8');
    strictTmuxIt.each([
        ['Claude Code trust', () => ({
                no: `${trustQuestion}\n❯ No, exit\n  Yes, I trust this folder\n`,
                yes: `${trustQuestion}\n  No, exit\n❯ Yes, I trust this folder\n`,
                trusted: '❯ \n',
            })],
        ['the fullscreen renderer offer', () => ({
                no: readFrame('claude/2.1.328/fullscreen-renderer.txt'),
                yes: readFrame('claude/2.1.328/fullscreen-renderer-not-now-focused.txt'),
                trusted: readFrame('claude/2.1.328/idle-after-fullscreen-renderer.txt'),
            })],
    ])('reads the pane once more after answering %s at the last poll before the deadline', async (_, dialogFrames) => {
        const context = await acceptedContext('claude');
        const frames = dialogFrames();
        // The dialog first appears at 29,500 ms of a 30,000 ms wait and takes each key at once.
        let focus = 'no';
        let applied = 0;
        let startedAt = 0;
        tmuxState.captureAt = () => {
            for (const args of tmuxState.args.slice(applied)) {
                if (args[0] !== 'send-keys' || args.includes('-l'))
                    continue;
                if (args.at(-1) === 'Down' && focus === 'no')
                    focus = 'yes';
                if (args.at(-1) === 'Enter' && focus === 'yes')
                    focus = 'trusted';
            }
            applied = tmuxState.args.length;
            return Date.now() - startedAt < 29_500 ? 'Starting…\n' : frames[focus];
        };
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        try {
            startedAt = Date.now();
            const work = waitForStartupPaneReady(context, { timeoutMs: 30_000, pollIntervalMs: 250, attemptAlreadyFenced: true });
            let settled = false;
            void work.then(() => { settled = true; }, () => { settled = true; });
            while (!settled) {
                if (vi.getTimerCount() > 0)
                    await vi.advanceTimersToNextTimerAsync();
                else
                    await new Promise(resolveTick => setImmediate(resolveTick));
            }
            await expect(work).resolves.toEqual({ ok: true });
            expect(focus).toBe('trusted');
        }
        finally {
            vi.useRealTimers();
        }
    });
    strictTmuxIt('sends no key to an answered Claude trust dialog left above a live input prompt', async () => {
        const context = await acceptedContext('claude');
        const corpus = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pane-frames');
        const answered = readFileSync(join(corpus, 'claude/unversioned/trust-files-then-idle.txt'), 'utf8');
        // The user pressed Up: the live prompt now shows a history entry.
        tmuxState.captures = [answered, `${answered.trimEnd()} previous prompt from history\n`];
        await expect(waitForStartupPaneReady(context, { timeoutMs: 3_000, attemptAlreadyFenced: true }))
            .resolves.toEqual({ ok: false, reason: 'selector_persistent' });
        expect(tmuxState.args.filter(args => args[0] === 'send-keys')).toEqual([]);
    });
    strictTmuxIt('sends Down, not Enter, when only a stale line above the live trust dialog shows Yes focused', async () => {
        const context = await acceptedContext('claude');
        const live = 'Quick safety check: Is this a project you created or one you trust?\n❯ No, exit\n  Yes, I trust this folder\n';
        tmuxState.captures = [` ❯ Yes, I trust this folder\n${live}`, '❯ ready\n'];
        await deliverStartupInbox(context, 'Read inbox.md, execute now.');
        const keys = tmuxState.args.filter(args => args[0] === 'send-keys' && !args.includes('-l')).map(args => args.at(-1));
        expect(keys[0]).toBe('Down');
    });
    strictTmuxIt('waits for a new trust dialog below an answered one to draw its choices, then sends Down, then Enter', async () => {
        const context = await acceptedContext('claude');
        const corpus = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pane-frames');
        const answered = readFileSync(join(corpus, 'claude/2.1.328/trust-yes-focused.txt'), 'utf8');
        const live = readFileSync(join(corpus, 'claude/2.1.325/trust.txt'), 'utf8');
        const midDraw = live.slice(0, live.indexOf('Security guide') + 'Security guide'.length);
        const yesFocused = live.replace('❯ No, exit', '  No, exit').replace('  Yes, I trust this folder', '❯ Yes, I trust this folder');
        const stages = [`${answered}\n${midDraw}`, `${answered}\n${live}`, `${answered}\n${yesFocused}`];
        const keysAfterStage = stages.map(() => []);
        let stage = -1;
        let seen = 0;
        tmuxState.captureAt = () => {
            const sent = tmuxState.args.slice(seen).filter(args => args[0] === 'send-keys' && !args.includes('-l')).map(args => String(args.at(-1)));
            seen = tmuxState.args.length;
            if (stage >= 0 && stage < stages.length)
                keysAfterStage[stage].push(...sent);
            stage = Math.min(stage + 1, stages.length);
            return stages[stage] ?? '❯ ready\n';
        };
        await expect(deliverStartupInbox(context, 'Read inbox.md, execute now.')).resolves.toEqual({
            ok: true,
            kind: 'attempted_unconfirmed',
        });
        expect(keysAfterStage).toEqual([[], ['Down'], ['Enter']]);
    });
    strictTmuxIt('fails at once on Claude Code’s Bypass Permissions warning and sends it no key', async () => {
        const context = await acceptedContext('claude');
        const corpus = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pane-frames');
        tmuxState.captures = [readFileSync(join(corpus, 'claude/2.1.328/bypass-permissions.txt'), 'utf8')];
        await expect(deliverStartupInbox(context, 'Read inbox.md, execute now.')).resolves.toEqual({
            ok: false,
            reason: 'claude_bypass_permissions_consent_required',
        });
        expect(tmuxState.args.filter(args => args[0] === 'send-keys')).toEqual([]);
        expect(tmuxState.args.filter(args => args[0] === 'capture-pane')).toHaveLength(1);
    });
    strictTmuxIt.each(['bypass-permissions.txt', 'bypass-permissions-yes-focused.txt'].flatMap(file => [18, 39].map(cols => [file, cols])))('fails at once on %s wrapped to %i columns and sends it no key', async (file, cols) => {
        const context = await acceptedContext('claude');
        const corpus = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pane-frames');
        const recorded = readFileSync(join(corpus, 'claude/2.1.328', file), 'utf8');
        tmuxState.captures = [recorded.split('\n').flatMap(line => line.match(new RegExp(`.{1,${cols}}`, 'gu')) ?? ['']).join('\n')];
        await expect(deliverStartupInbox(context, 'Read inbox.md, execute now.')).resolves.toEqual({
            ok: false,
            reason: 'claude_bypass_permissions_consent_required',
        });
        expect(tmuxState.args.filter(args => args[0] === 'send-keys')).toEqual([]);
    });
    strictTmuxIt.each(['onboarding-theme.txt', 'onboarding-security-notes.txt'])('fails at once on Claude Code onboarding (%s) and sends it no key', async (file) => {
        const context = await acceptedContext('claude');
        const corpus = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pane-frames');
        tmuxState.captures = [readFileSync(join(corpus, 'claude/2.1.329', file), 'utf8')];
        await expect(deliverStartupInbox(context, 'Read inbox.md, execute now.')).resolves.toEqual({
            ok: false,
            reason: 'claude_onboarding_required',
        });
        expect(tmuxState.args.filter(args => args[0] === 'send-keys')).toEqual([]);
    });
    strictTmuxIt('fails with the onboarding reason when onboarding first shows at the check before the trigger is typed', async () => {
        const context = await acceptedContext('claude');
        const corpus = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pane-frames');
        tmuxState.captures = [
            readFileSync(join(corpus, 'claude/2.1.325/idle.txt'), 'utf8'),
            readFileSync(join(corpus, 'claude/2.1.329/onboarding-theme.txt'), 'utf8'),
        ];
        await expect(deliverStartupInbox(context, 'Read inbox.md, execute now.')).resolves.toEqual({
            ok: false,
            reason: 'claude_onboarding_required',
        });
        expect(tmuxState.args.filter(args => args[0] === 'send-keys')).toEqual([]);
    });
    // Only a Claude pane is read for Claude Code's first-run screens. Another
    // provider showing the same text is read by its own rules, as before them.
    strictTmuxIt('reads a gemini pane that shows the Bypass Permissions warning by gemini rules at every startup check', async () => {
        const message = 'Read inbox.md, execute now.';
        const warning = readFrame('claude/2.1.328/bypass-permissions-yes-focused.txt');
        const sentKeys = () => tmuxState.args.filter(args => args[0] === 'send-keys').map(args => String(args.at(-1)));
        tmuxState.captures = [warning];
        await expect(waitForStartupPaneReady(await acceptedContext('gemini'), { timeoutMs: 50, pollIntervalMs: 1, attemptAlreadyFenced: true }))
            .resolves.toEqual({ ok: true });
        expect(sentKeys()).toEqual([]);
        tmuxState.args = [];
        tmuxState.captures = ['> \n', warning];
        await expect(deliverStartupInbox(await acceptedContext('gemini'), message))
            .resolves.toEqual({ ok: true, kind: 'attempted_unconfirmed' });
        expect(sentKeys()).toEqual([message, 'Enter', 'Enter']);
        tmuxState.args = [];
        tmuxState.captures = [`> ${message}\n${warning}`];
        await expect(retryStartupInboxSubmit(await acceptedContext('gemini'), message, { attemptAlreadyFenced: true }))
            .resolves.toBe('resubmitted');
        expect(sentKeys()).toEqual(['Enter']);
    });
    // Enter resubmits the typed trigger only while no first-run screen is drawn
    // below it: on any of them Enter would answer the screen instead.
    strictTmuxIt.each([
        ['the Bypass Permissions warning focusing Yes, I accept', () => readFrame('claude/2.1.328/bypass-permissions-yes-focused.txt')],
        ['the fullscreen renderer offer', () => readFrame('claude/2.1.328/fullscreen-renderer.txt')],
        ['Claude Code onboarding', () => readFrame('claude/2.1.329/onboarding-security-notes.txt')],
        ['a first-run screen with only its footer on screen', () => '\n  Enter to confirm · Esc to cancel\n'],
    ])('does not resubmit with Enter while %s is drawn below the typed trigger', async (_, screen) => {
        const context = await acceptedContext('claude');
        tmuxState.captures = [`❯ Read inbox.md, execute now.\n${screen()}`];
        await expect(retryStartupInboxSubmit(context, 'Read inbox.md, execute now.', { attemptAlreadyFenced: true }))
            .resolves.toBe('unavailable');
        expect(tmuxState.args.filter(args => args[0] === 'send-keys')).toEqual([]);
    });
    strictTmuxIt('fails with the consent reason when the Bypass Permissions warning first shows at the check before the trigger is typed', async () => {
        const context = await acceptedContext('claude');
        const corpus = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pane-frames');
        tmuxState.captures = [
            readFileSync(join(corpus, 'claude/2.1.325/idle.txt'), 'utf8'),
            readFileSync(join(corpus, 'claude/2.1.328/bypass-permissions.txt'), 'utf8'),
        ];
        await expect(deliverStartupInbox(context, 'Read inbox.md, execute now.')).resolves.toEqual({
            ok: false,
            reason: 'claude_bypass_permissions_consent_required',
        });
        expect(tmuxState.args.filter(args => args[0] === 'send-keys')).toEqual([]);
    });
    // Only a first-run screen with an answer (the renderer offer, or one whose
    // choices are off screen) sends the check before the trigger back to the
    // wait. The bypass warning, onboarding and the folder trust dialog stop the
    // start on that one read, even when the next read would show an idle pane.
    strictTmuxIt.each([
        ['the Bypass Permissions warning', 'claude/2.1.328/bypass-permissions.txt', 'claude_bypass_permissions_consent_required'],
        ['Claude Code onboarding', 'claude/2.1.329/onboarding-theme.txt', 'claude_onboarding_required'],
        ['the folder trust dialog', 'claude/2.1.325/trust.txt', 'selector_persistent'],
    ])('stops on the one read of %s at the check before the trigger is typed', async (_, file, reason) => {
        const context = await acceptedContext('claude');
        const idle = readFrame('claude/2.1.325/idle.txt');
        tmuxState.captures = [idle, readFrame(file), idle];
        await expect(deliverStartupInbox(context, 'Read inbox.md, execute now.')).resolves.toEqual({ ok: false, reason });
        expect(tmuxState.args.filter(args => args[0] === 'send-keys')).toEqual([]);
        expect(tmuxState.args.filter(args => args[0] === 'capture-pane')).toHaveLength(2);
    });
    // Claude Code 2.1.330 was measured drawing its trust dialog and the bypass
    // warning over several captures, each partial frame on screen for about
    // 4 ms. No key goes out on a partial frame; once the whole screen is drawn
    // it is handled as before: the trust dialog gets Down then Enter, the
    // bypass warning no key at all.
    const v330 = (state) => readFrame(`claude/2.1.330/${state}.txt`);
    strictTmuxIt.each([
        ['trust-no-choice-partial', 'trust'],
        ['trust-yes-choice-partial', 'trust'],
        ['trust-body-partial', 'trust'],
        ['bypass-permissions-no-choices', 'bypass-permissions'],
        ['bypass-permissions-body-partial', 'bypass-permissions'],
    ])('sends no key on the recorded 2.1.330 frame %s, drawn before the whole %s screen', async (partial, whole) => {
        const context = await acceptedContext('claude');
        const frames = {
            partial: v330(partial),
            'trust': v330('trust'),
            'trust-yes-focused': v330('trust-yes-focused'),
            'bypass-permissions': v330('bypass-permissions'),
            idle: readFrame('claude/2.1.325/idle.txt'),
        };
        // `shown` is what the pane draws now; each key is charged to the frame the
        // last capture returned, the one the code decided on.
        let shown = 'partial';
        let lastReturned = null;
        let applied = 0;
        const keysSeenOn = [];
        const applyKeys = () => {
            const keys = tmuxState.args.slice(applied).filter(args => args[0] === 'send-keys').map(args => String(args.at(-1)));
            applied = tmuxState.args.length;
            for (const key of keys) {
                keysSeenOn.push([lastReturned, key]);
                if (key === 'Down' && shown === 'trust')
                    shown = 'trust-yes-focused';
                if (key === 'Enter' && shown === 'trust-yes-focused')
                    shown = 'idle';
            }
        };
        tmuxState.captureAt = () => {
            applyKeys();
            lastReturned = shown;
            if (shown === 'partial')
                shown = whole;
            return frames[lastReturned];
        };
        await deliverStartupInbox(context, 'Read inbox.md, execute now.');
        applyKeys();
        expect(keysSeenOn.filter(([frame]) => frame === 'partial')).toEqual([]);
    });
    strictTmuxIt('answers the whole recorded 2.1.330 trust dialog with Down then Enter, then delivers', async () => {
        const context = await acceptedContext('claude');
        const frames = { trust: v330('trust'), yes: v330('trust-yes-focused'), idle: readFrame('claude/2.1.325/idle.txt') };
        let shown = 'trust';
        let applied = 0;
        const keysSeenOn = [];
        tmuxState.captureAt = () => {
            const keys = tmuxState.args.slice(applied).filter(args => args[0] === 'send-keys').map(args => String(args.at(-1)));
            applied = tmuxState.args.length;
            for (const key of keys) {
                keysSeenOn.push([shown, key]);
                if (key === 'Down' && shown === 'trust')
                    shown = 'yes';
                if (key === 'Enter' && shown === 'yes')
                    shown = 'idle';
            }
            return frames[shown];
        };
        await expect(deliverStartupInbox(context, 'Read inbox.md, execute now.'))
            .resolves.toEqual({ ok: true, kind: 'attempted_unconfirmed' });
        expect(keysSeenOn.slice(0, 3)).toEqual([['trust', 'Down'], ['yes', 'Enter'], ['idle', 'Read inbox.md, execute now.']]);
        expect(tmuxState.args.filter(args => args[0] === 'send-keys').map(args => String(args.at(-1))))
            .toEqual(['Down', 'Enter', 'Read inbox.md, execute now.', 'Enter', 'Enter']);
    });
    strictTmuxIt('fails at once on the whole recorded 2.1.330 Bypass Permissions warning and sends it no key', async () => {
        const context = await acceptedContext('claude');
        tmuxState.captures = [v330('bypass-permissions')];
        await expect(deliverStartupInbox(context, 'Read inbox.md, execute now.')).resolves.toEqual({
            ok: false,
            reason: 'claude_bypass_permissions_consent_required',
        });
        expect(tmuxState.args.filter(args => args[0] === 'send-keys')).toEqual([]);
    });
    strictTmuxIt('sends no key to a renderer offer redrawn below an old one focused on Not now until the new copy draws its ❯', async () => {
        const context = await acceptedContext('claude');
        const offer = readFrame('claude/2.1.328/fullscreen-renderer.txt');
        const notNow = readFrame('claude/2.1.328/fullscreen-renderer-not-now-focused.txt');
        const frames = {
            partial: `${notNow}\n${offer.slice(0, offer.indexOf('❯ 1. Yes') + '❯ 1. Ye'.length)}\n`,
            unmarked: `${notNow}\n${offer.replace('❯ 1. Yes, try it', '  1. Yes, try it')}`,
            offered: `${notNow}\n${offer}`,
            notNow: `${notNow}\n${notNow}`,
            accepted: readFrame('claude/2.1.325/idle.txt'),
            dismissed: readFrame('claude/2.1.328/idle-after-fullscreen-renderer.txt'),
        };
        // The new copy is drawn halfway, then whole without its ❯, then with it.
        let shown = 'partial';
        let captures = 0;
        let applied = 0;
        const keysSeenOn = [];
        tmuxState.captureAt = () => {
            const keys = tmuxState.args.slice(applied).filter(args => args[0] === 'send-keys').map(args => String(args.at(-1)));
            applied = tmuxState.args.length;
            for (const key of keys) {
                keysSeenOn.push([shown, key]);
                if (key === 'Down' && shown === 'offered')
                    shown = 'notNow';
                if (key === 'Enter' && shown !== 'dismissed')
                    shown = shown === 'notNow' ? 'dismissed' : 'accepted';
            }
            captures++;
            if (captures === 2 && shown === 'partial')
                shown = 'unmarked';
            if (captures === 4 && shown === 'unmarked')
                shown = 'offered';
            return frames[shown];
        };
        await deliverStartupInbox(context, 'Read inbox.md, execute now.');
        expect(keysSeenOn.slice(0, 2)).toEqual([['offered', 'Down'], ['notNow', 'Enter']]);
        expect(shown).toBe('dismissed');
    });
    strictTmuxIt('answers a fullscreen renderer offer that first shows at the check before the trigger is typed, then delivers', async () => {
        const context = await acceptedContext('claude');
        const corpus = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pane-frames');
        const read = (file) => readFileSync(join(corpus, file), 'utf8');
        const frames = {
            idle: read('claude/2.1.325/idle.txt'),
            offered: read('claude/2.1.328/fullscreen-renderer.txt'),
            notNow: read('claude/2.1.328/fullscreen-renderer-not-now-focused.txt'),
            accepted: 'fullscreen renderer on\n',
            dismissed: read('claude/2.1.328/idle-after-fullscreen-renderer.txt'),
        };
        // Idle at the readiness wait, then the offer from the next capture on.
        let shown = 'idle';
        let captures = 0;
        let applied = 0;
        const keysSeenOn = [];
        tmuxState.captureAt = () => {
            if (++captures === 2)
                shown = 'offered';
            const keys = tmuxState.args.slice(applied)
                .filter(args => args[0] === 'send-keys')
                .map(args => String(args.at(-1)));
            applied = tmuxState.args.length;
            for (const key of keys) {
                keysSeenOn.push([shown, key]);
                if (key === 'Down' && shown === 'offered')
                    shown = 'notNow';
                if (key === 'Enter' && (shown === 'offered' || shown === 'notNow'))
                    shown = shown === 'notNow' ? 'dismissed' : 'accepted';
            }
            return frames[shown];
        };
        await expect(deliverStartupInbox(context, 'Read inbox.md, execute now.')).resolves.toEqual({
            ok: true,
            kind: 'attempted_unconfirmed',
        });
        expect(keysSeenOn.slice(0, 3)).toEqual([['offered', 'Down'], ['notNow', 'Enter'], ['dismissed', 'Read inbox.md, execute now.']]);
        expect(shown).toBe('dismissed');
    });
    // The wait answers a dialog seen at the check before the trigger is typed
    // once. A dialog still pending at the next check is not answered again: the
    // trigger is never typed and no key follows the first answer. The bypass
    // warning and onboarding keep their own reasons there too.
    strictTmuxIt.each([
        ['the renderer offer drawn again', () => readFrame('claude/2.1.328/fullscreen-renderer.txt'), 'selector_persistent'],
        ['a first-run screen with only its footer on screen', () => `${readFrame('claude/2.1.325/idle.txt').trimEnd()}\n\n  Enter to confirm · Esc to cancel\n`, 'selector_persistent'],
        ['the Bypass Permissions warning', () => readFrame('claude/2.1.328/bypass-permissions.txt'), 'claude_bypass_permissions_consent_required'],
        ['Claude Code onboarding', () => readFrame('claude/2.1.329/onboarding-theme.txt'), 'claude_onboarding_required'],
    ])('stops before typing the trigger when %s follows the answered renderer offer', async (_, pendingAgain, reason) => {
        const context = await acceptedContext('claude');
        const idle = readFrame('claude/2.1.325/idle.txt');
        const offer = readFrame('claude/2.1.328/fullscreen-renderer.txt');
        // Readiness wait, pre-input check, the retried wait (offer, Down, Not now,
        // Enter, dismissed), then the second pre-input check.
        tmuxState.captures = [
            idle,
            offer,
            offer,
            readFrame('claude/2.1.328/fullscreen-renderer-not-now-focused.txt'),
            readFrame('claude/2.1.328/idle-after-fullscreen-renderer.txt'),
            pendingAgain(),
        ];
        await expect(deliverStartupInbox(context, 'Read inbox.md, execute now.')).resolves.toEqual({ ok: false, reason });
        expect(tmuxState.args.filter(args => args[0] === 'send-keys').map(args => String(args.at(-1))))
            .toEqual(['Down', 'Enter']);
    });
    // A first-run screen can also draw after the trigger text is typed, when only
    // Enter is left to send. Enter would answer the dialog instead of submitting
    // the trigger, so delivery stops there and the dialog gets no key at all.
    const paneFrameCorpus = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pane-frames');
    const postInjectionDialogs = [
        ['the fullscreen renderer offer', 'claude/2.1.328/fullscreen-renderer.txt', 'selector_persistent'],
        ['Claude Code onboarding', 'claude/2.1.329/onboarding-theme.txt', 'claude_onboarding_required'],
        ['the Bypass Permissions warning', 'claude/2.1.328/bypass-permissions.txt', 'claude_bypass_permissions_consent_required'],
        ['the folder trust dialog', 'claude/2.1.328/trust-yes-focused.txt', 'selector_persistent'],
    ];
    strictTmuxIt.each(postInjectionDialogs.flatMap(([dialog, file, reason]) => [
        { dialog, stage: 'the first startup Enter', file, reason, enters: 0 },
        { dialog, stage: 'the second startup Enter', file, reason, enters: 1 },
    ]))('stops before $stage when $dialog draws after the trigger is typed, and sends it no key', async ({ file, reason, enters }) => {
        const context = await acceptedContext('claude');
        const message = 'Read inbox.md, execute now.';
        const idle = readFileSync(join(paneFrameCorpus, 'claude/2.1.325/idle.txt'), 'utf8');
        const idleUntilDialog = Array.from({ length: enters }, () => idle);
        // One capture for the readiness wait, one for the pre-input check, then
        // one before each Enter: the dialog draws before the Enter under test.
        tmuxState.captures = [idle, idle, ...idleUntilDialog, readFileSync(join(paneFrameCorpus, file), 'utf8')];
        await expect(deliverStartupInbox(context, message)).resolves.toEqual({ ok: false, reason });
        expect(tmuxState.args.filter(args => args[0] === 'send-keys').map(args => String(args.at(-1))))
            .toEqual([message, ...idleUntilDialog.map(() => 'Enter')]);
    });
    strictTmuxIt('stops before the first startup Enter when the renderer offer draws below the typed trigger', async () => {
        const context = await acceptedContext('claude');
        const message = 'Read inbox.md, execute now.';
        const idle = readFileSync(join(paneFrameCorpus, 'claude/2.1.325/idle.txt'), 'utf8');
        const offer = readFileSync(join(paneFrameCorpus, 'claude/2.1.328/fullscreen-renderer.txt'), 'utf8');
        tmuxState.captures = [idle, idle, `❯ ${message}\n${offer}`];
        await expect(deliverStartupInbox(context, message)).resolves.toEqual({
            ok: false,
            reason: 'selector_persistent',
        });
        expect(tmuxState.args.filter(args => args[0] === 'send-keys').map(args => String(args.at(-1))))
            .toEqual([message]);
    });
    strictTmuxIt('stops before the first startup Enter when only a first-run screen’s footer is on screen', async () => {
        const context = await acceptedContext('claude');
        const message = 'Read inbox.md, execute now.';
        const idle = readFileSync(join(paneFrameCorpus, 'claude/2.1.325/idle.txt'), 'utf8');
        tmuxState.captures = [idle, idle, `❯ ${message}\n\n  Enter to confirm · Esc to cancel\n`];
        await expect(deliverStartupInbox(context, message)).resolves.toEqual({
            ok: false,
            reason: 'selector_persistent',
        });
        expect(tmuxState.args.filter(args => args[0] === 'send-keys').map(args => String(args.at(-1))))
            .toEqual([message]);
    });
    strictTmuxIt('sends no key while only a first-run screen’s footer is on screen, then answers the offer once its choices show', async () => {
        const context = await acceptedContext('claude');
        const footerOnly = '\n  Enter to confirm · Esc to cancel\n';
        tmuxState.captures = [
            footerOnly,
            footerOnly,
            readFrame('claude/2.1.328/fullscreen-renderer.txt'),
            readFrame('claude/2.1.328/fullscreen-renderer-not-now-focused.txt'),
            readFrame('claude/2.1.328/idle-after-fullscreen-renderer.txt'),
        ];
        await expect(waitForStartupPaneReady(context, { timeoutMs: 5_000, attemptAlreadyFenced: true }))
            .resolves.toEqual({ ok: true });
        const captures = tmuxState.args.filter(args => args[0] === 'capture-pane' || args[0] === 'send-keys');
        expect(captures.map(args => args[0] === 'send-keys' ? String(args.at(-1)) : 'capture'))
            .toEqual(['capture', 'capture', 'capture', 'Down', 'capture', 'Enter', 'capture']);
    });
    strictTmuxIt('answers Claude Code’s fullscreen renderer offer with Not now, resending a dropped Down', async () => {
        const context = await acceptedContext('claude');
        const corpus = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pane-frames');
        const read = (file) => readFileSync(join(corpus, file), 'utf8');
        const frames = {
            offered: read('claude/2.1.328/fullscreen-renderer.txt'),
            notNow: read('claude/2.1.328/fullscreen-renderer-not-now-focused.txt'),
            accepted: 'fullscreen renderer on\n',
            dismissed: read('claude/2.1.328/idle-after-fullscreen-renderer.txt'),
        };
        // Drops the first Down, like Claude Code 2.1.328's trust dialog; Enter
        // confirms the choice focused when it arrives.
        let shown = 'offered';
        let applied = 0;
        let downs = 0;
        const keysSeenOn = [];
        tmuxState.captureAt = () => {
            const keys = tmuxState.args.slice(applied)
                .filter(args => args[0] === 'send-keys' && !args.includes('-l'))
                .map(args => String(args.at(-1)));
            applied = tmuxState.args.length;
            for (const key of keys) {
                keysSeenOn.push([shown, key]);
                if (key === 'Down' && ++downs > 1 && shown === 'offered')
                    shown = 'notNow';
                if (key === 'Enter' && (shown === 'offered' || shown === 'notNow'))
                    shown = shown === 'notNow' ? 'dismissed' : 'accepted';
            }
            return frames[shown];
        };
        await expect(waitForStartupPaneReady(context, { timeoutMs: 5_000, attemptAlreadyFenced: true }))
            .resolves.toEqual({ ok: true });
        expect(shown).toBe('dismissed');
        expect(keysSeenOn).toEqual([['offered', 'Down'], ['offered', 'Down'], ['notNow', 'Enter']]);
    });
    strictTmuxIt.each([
        ['Cursor workspace trust', 'Workspace Trust Required\nDo you trust the contents of this directory?\nPass --trust, --yolo, or -f to skip this prompt.\n'],
        ['Claude files trust', 'Do you trust the files in this folder?\n❯ No, exit\n  Yes, proceed\n'],
        ['Claude quick safety check', 'Quick safety check: Is this a project you created or one you trust?\n❯ No, exit\n  Yes, I trust this folder\n'],
        ['directory trust', 'Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit\n'],
        ['Codex hooks review', 'Hooks need review\n› 3. Continue without trusting\nPress enter to confirm or esc to go back\n'],
    ])('guarded direct send refuses to type into a %s prompt', async (_label, capture) => {
        const context = await acceptedContext('claude');
        const identity = context.ownership.tmuxServerIdentity;
        const senders = [
            () => sendToWorker('', '%2', 'List files and report the result.', identity),
            () => injectToLeaderPane('', '%1', 'List files and report the result.', identity),
        ];
        for (const send of senders) {
            tmuxState.args = [];
            tmuxState.captures = [capture];
            await expect(send()).resolves.toBe(false);
            expect(tmuxState.args.some(args => args[0] === 'capture-pane')).toBe(true);
            expect(tmuxState.args.some(args => args.includes('send-keys'))).toBe(false);
        }
    });
    strictTmuxIt('handles the exact Codex directory and hooks selectors in order before delivery', async () => {
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
    strictTmuxIt('fails closed when the selector persists after the narrow action', async () => {
        const context = await acceptedContext('codex');
        const selector = 'Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit\n';
        tmuxState.captures = [selector, selector];
        await expect(deliverStartupInbox(context, 'Read inbox.md, execute now.')).resolves.toEqual({
            ok: false,
            reason: 'selector_persistent',
        });
        expect(tmuxState.args.some(args => args.at(-1) === 'Read inbox.md, execute now.')).toBe(false);
    });
    strictTmuxIt('retries Enter only when the exact startup trigger is visibly pending', async () => {
        const context = await acceptedContext('claude');
        const message = 'Read inbox.md, execute now.';
        tmuxState.captures = [`❯ ${message}\n`];
        await expect(retryStartupInboxSubmit(context, message)).resolves.toBe('resubmitted');
        expect(tmuxState.args.some(args => args[0] === 'send-keys' && args.at(-1) === 'Enter')).toBe(true);
    });
    strictTmuxIt('reports an engaged pane instead of resubmitting when the worker is actively working', async () => {
        const context = await acceptedContext('claude');
        const message = 'Read inbox.md, execute now.';
        tmuxState.captures = [`> ${message}\n\n  ✻ Thinking…\n  (esc to interrupt at any time to stop)\n`];
        await expect(retryStartupInboxSubmit(context, message)).resolves.toBe('pane_busy');
        expect(tmuxState.args.some(args => args[0] === 'send-keys' && args.at(-1) === 'Enter')).toBe(false);
    });
    strictTmuxIt.each([
        ['codex', '› Read inbox.md\nesc to interrupt\n'],
        ['cursor', '→ Read inbox.md\nctrl+c to stop\n'],
    ])('probes a busy %s pane read-only without sending a key', async (provider, capture) => {
        const context = await acceptedContext(provider);
        tmuxState.captures = [capture];
        await expect(probeStartupPaneActivity(context)).resolves.toBe('busy');
        expect(tmuxState.args.some(args => args[0] === 'send-keys')).toBe(false);
    });
    strictTmuxIt.each([
        ['codex', 'idle', '› ready\n'],
        ['cursor', 'idle', '→ ready\n'],
        ['codex', 'dead', '› ready\n'],
        ['cursor', 'dead', '→ ready\n'],
    ])('does not classify a %s %s pane as engaged', async (provider, activity, capture) => {
        const context = await acceptedContext(provider);
        tmuxState.captures = [capture];
        if (activity === 'dead')
            tmuxState.paneStatus = '1 cmd\n';
        await expect(probeStartupPaneActivity(context)).resolves.toBe(activity);
        expect(tmuxState.args.some(args => args[0] === 'send-keys')).toBe(false);
    });
    strictTmuxIt.each(['codex', 'cursor'])('does not grant busy grace to a %s trust prompt with interrupt text', async (provider) => {
        const context = await acceptedContext(provider);
        tmuxState.captures = [
            'Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit\nesc to interrupt\nctrl+c to stop\n',
        ];
        await expect(probeStartupPaneActivity(context)).resolves.toBe('idle');
        expect(tmuxState.args.some(args => args[0] === 'send-keys')).toBe(false);
    });
    strictTmuxIt.each(['codex', 'cursor'])('classifies an unreadable %s pane as unknown without sending a key', async (provider) => {
        const context = await acceptedContext(provider);
        tmuxState.captureError = new Error('capture unavailable');
        await expect(probeStartupPaneActivity(context)).resolves.toBe('unknown');
        expect(tmuxState.args.some(args => args[0] === 'send-keys')).toBe(false);
    });
    strictTmuxIt.each(['codex', 'cursor'])('fails closed for a stale %s launch attempt before probing pane activity', async (provider) => {
        const context = await acceptedContext(provider);
        tmuxState.captures = ['→ Read inbox.md\nctrl+c to stop\n'];
        tmuxState.activeAttempt = null;
        await expect(probeStartupPaneActivity({
            ...context,
            attempt: { ...context.attempt, attempt_id: '00000000-0000-4000-8000-000000000000' },
        })).resolves.toBe('unknown');
        expect(tmuxState.args.some(args => args[0] === 'send-keys')).toBe(false);
    });
    strictTmuxIt.each(['codex', 'cursor'])('fails closed for %s copy mode without probing or sending a key', async (provider) => {
        const context = await acceptedContext(provider);
        tmuxState.captures = ['› Read inbox.md\nesc to interrupt\n'];
        tmuxState.paneMode = '1\n';
        await expect(probeStartupPaneActivity(context)).resolves.toBe('unknown');
        expect(tmuxState.args.some(args => args[0] === 'capture-pane')).toBe(false);
        expect(tmuxState.args.some(args => args[0] === 'send-keys')).toBe(false);
    });
    strictTmuxIt.each(['codex', 'cursor'])('fails closed for %s ownership mismatch without probing or sending a key', async (provider) => {
        const context = await acceptedContext(provider);
        tmuxState.captures = ['→ Read inbox.md\nctrl+c to stop\n'];
        await expect(probeStartupPaneActivity({
            ...context,
            ownership: { ...context.ownership, paneId: '%9' },
        })).resolves.toBe('unknown');
        expect(tmuxState.args.some(args => args[0] === 'capture-pane')).toBe(false);
        expect(tmuxState.args.some(args => args[0] === 'send-keys')).toBe(false);
    });
    strictTmuxIt.each(['codex', 'cursor'])('fails closed for a foreign %s pane without probing or sending a key', async (provider) => {
        const context = await acceptedContext(provider);
        tmuxState.captures = ['→ Read inbox.md\nctrl+c to stop\n'];
        tmuxState.ownedPaneIds = '%9\n';
        await expect(probeStartupPaneActivity(context)).resolves.toBe('unknown');
        expect(tmuxState.args.some(args => args[0] === 'capture-pane')).toBe(false);
        expect(tmuxState.args.some(args => args[0] === 'send-keys')).toBe(false);
    });
    strictTmuxIt.each(['codex', 'cursor'])('fails closed for %s unknown liveness without probing or sending a key', async (provider) => {
        const context = await acceptedContext(provider);
        tmuxState.captures = ['→ Read inbox.md\nctrl+c to stop\n'];
        tmuxState.livenessError = new Error('liveness unavailable');
        await expect(probeStartupPaneActivity(context)).resolves.toBe('unknown');
        expect(tmuxState.args.some(args => args[0] === 'capture-pane')).toBe(false);
        expect(tmuxState.args.some(args => args[0] === 'send-keys')).toBe(false);
    });
    strictTmuxIt('does not retry Enter for unrelated pane text', async () => {
        const context = await acceptedContext('claude');
        tmuxState.captures = ['❯ unrelated text\n'];
        await expect(retryStartupInboxSubmit(context, 'Read inbox.md, execute now.')).resolves.toBe('unavailable');
        expect(tmuxState.args.some(args => args[0] === 'send-keys' && args.at(-1) === 'Enter')).toBe(false);
    });
    strictTmuxIt('never sends a Gemini confirmation key without an evidence-backed Gemini selector', async () => {
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
    strictTmuxIt('does not send the Codex hooks selector key to Claude', async () => {
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
    strictTmuxIt('emits bounded redacted capture diagnostics and never treats failure as readiness', async () => {
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
    strictTmuxIt('retires an accepted launch but preserves the pane when provider cleanup is unverified', async () => {
        cwd = await createFixture('omc-startup-handoff-cleanup-');
        process.env.OMC_TEAM_START_ACK_TIMEOUT_MS = '50';
        processMocks.isProcessIdentityLive.mockResolvedValue('dead');
        await expect(spawnOwnedWorkerInPane('startup:0', ownership(), {
            teamName: 'startup-team',
            workerName: 'worker-1',
            instanceId: randomUUID(),
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
        const attemptsRoot = join(getOmcRoot(cwd), 'state', 'team', 'startup-team', 'workers', 'worker-1', 'launch-attempts');
        const files = await readdir(attemptsRoot, { recursive: true });
        expect(files.some(file => String(file).endsWith('decision.json.retired'))).toBe(true);
        expect(tmuxState.paneStatus).toBe('0 cmd\n');
        delete process.env.OMC_TEAM_START_ACK_TIMEOUT_MS;
    });
    it('refuses an owned worker launch without its immutable instance id', async () => {
        cwd = await createFixture('omc-startup-instance-id-');
        if (!supportsStrictTmuxFixture) {
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
            })).rejects.toThrow('worker_launch_tmux_server_identity_missing');
            expect(tmuxState.args).toEqual([]);
            return;
        }
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
        })).rejects.toThrow('worker_launch_instance_id_invalid');
        expect(tmuxState.args).toHaveLength(0);
    });
});
describe('startup input after the provider exits to a shell prompt', () => {
    const message = 'Read inbox.md, execute now.';
    const sendKeys = () => tmuxState.args.filter(args => args[0] === 'send-keys');
    strictTmuxIt.each(['❯ ', '$ '])('fails fast with provider_exited at a %j shell prompt without typing', async (prompt) => {
        const context = await acceptedContext('claude');
        await markProviderExited(context.attempt);
        tmuxState.captures = [prompt];
        const startedAt = Date.now();
        await expect(waitForStartupPaneReady(context, { timeoutMs: 3_000, pollIntervalMs: 1 }))
            .resolves.toEqual({ ok: false, reason: 'provider_exited' });
        expect(Date.now() - startedAt).toBeLessThan(1_000);
        await expect(deliverStartupInbox(context, message))
            .resolves.toEqual({ ok: false, reason: 'provider_exited' });
        expect(sendKeys()).toEqual([]);
    });
    strictTmuxIt('delivers at the same prompt when provider liveness is unknown', async () => {
        const context = await acceptedContext('claude');
        tmuxState.captures = ['❯ '];
        await expect(deliverStartupInbox(context, message))
            .resolves.toEqual({ ok: true, kind: 'attempted_unconfirmed' });
        expect(sendKeys().some(args => args.at(-1) === message)).toBe(true);
    });
    strictTmuxIt('does not resubmit Enter into the shell once the provider has exited', async () => {
        const context = await acceptedContext('claude');
        await markProviderExited(context.attempt);
        tmuxState.captures = [`❯ ${message}\n❯ `];
        await expect(retryStartupInboxSubmit(context, message)).resolves.toBe('unavailable');
        expect(sendKeys()).toEqual([]);
    });
    strictTmuxIt('reports a provider-exited pane as dead even when stale busy text remains', async () => {
        const context = await acceptedContext('codex');
        await markProviderExited(context.attempt);
        tmuxState.captures = ['› Read inbox.md\nesc to interrupt\n'];
        await expect(probeStartupPaneActivity(context)).resolves.toBe('dead');
        expect(sendKeys()).toEqual([]);
    });
});
describe('startup readiness wait set by OMC_TEAM_READY_TIMEOUT_MS', () => {
    const message = 'Read inbox.md, execute now.';
    const framesRoot = join(__dirname, 'fixtures', 'pane-frames', 'claude');
    let warnings = [];
    let savedReadyTimeout;
    beforeEach(() => {
        savedReadyTimeout = process.env.OMC_TEAM_READY_TIMEOUT_MS;
        delete process.env.OMC_TEAM_READY_TIMEOUT_MS;
        warnings = [];
        vi.spyOn(console, 'warn').mockImplementation((...args) => {
            warnings.push(args.map(String).join(' '));
        });
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        if (savedReadyTimeout === undefined)
            delete process.env.OMC_TEAM_READY_TIMEOUT_MS;
        else
            process.env.OMC_TEAM_READY_TIMEOUT_MS = savedReadyTimeout;
    });
    // Advance the fake clock only while the code under test sleeps, so file I/O
    // in the attempt checks never lets the deadline pass early.
    async function settleOnFakeClock(work) {
        let settled = false;
        void work.then(() => { settled = true; }, () => { settled = true; });
        while (!settled) {
            if (vi.getTimerCount() > 0)
                await vi.advanceTimersToNextTimerAsync();
            else
                await new Promise(resolve => setImmediate(resolve));
        }
        return work;
    }
    async function bannerThenIdle(bannerMs) {
        const banner = await readFile(join(framesRoot, 'unversioned', 'startup-banner-bypass.txt'), 'utf8');
        const idle = await readFile(join(framesRoot, '2.1.325', 'idle.txt'), 'utf8');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const startedAt = Date.now();
        tmuxState.captureAt = () => (Date.now() - startedAt < bannerMs ? banner : idle);
        return startedAt;
    }
    strictTmuxIt('waits out a 40s banner at 60000 and then sends the inbox once', async () => {
        const context = await acceptedContext('claude');
        process.env.OMC_TEAM_READY_TIMEOUT_MS = '60000';
        const startedAt = await bannerThenIdle(40_000);
        await expect(settleOnFakeClock(deliverStartupInbox(context, message)))
            .resolves.toEqual({ ok: true, kind: 'attempted_unconfirmed' });
        const literals = tmuxState.args.filter(args => args[0] === 'send-keys' && args.includes('-l'));
        expect(literals.map(args => args.at(-1))).toEqual([message]);
        expect(Math.min(...tmuxState.sendTimes) - startedAt).toBeGreaterThanOrEqual(40_000);
        expect(warnings).toEqual([]);
    });
    strictTmuxIt.each([
        [undefined, 30_000, 'OMC_TEAM_READY_TIMEOUT_MS unset (effective 30000ms'],
        ['abc', 30_000, 'OMC_TEAM_READY_TIMEOUT_MS=abc (effective 30000ms'],
        ['5000', 30_000, 'OMC_TEAM_READY_TIMEOUT_MS=5000 (effective 30000ms'],
        ['600000', 120_000, 'OMC_TEAM_READY_TIMEOUT_MS=600000 (effective 120000ms'],
    ])('times out a banner that never clears at the clamped wait for %j', async (raw, waitMs, note) => {
        const context = await acceptedContext('claude');
        if (raw !== undefined)
            process.env.OMC_TEAM_READY_TIMEOUT_MS = raw;
        const startedAt = await bannerThenIdle(Number.POSITIVE_INFINITY);
        await expect(settleOnFakeClock(deliverStartupInbox(context, message)))
            .resolves.toEqual({ ok: false, reason: 'readiness_timeout' });
        expect(Date.now() - startedAt).toBe(waitMs);
        expect(tmuxState.args.filter(args => args[0] === 'send-keys')).toEqual([]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(`timed out after ${waitMs}ms`);
        expect(warnings[0]).toContain(note);
    });
    strictTmuxIt('reports the timeout of the second wait when a first-run screen drawn at the check before the trigger never shows its choices', async () => {
        const context = await acceptedContext('claude');
        const idle = await readFile(join(framesRoot, '2.1.325', 'idle.txt'), 'utf8');
        tmuxState.captures = [idle, `${idle.trimEnd()}\n\n  Enter to confirm · Esc to cancel\n`];
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        await expect(settleOnFakeClock(deliverStartupInbox(context, message)))
            .resolves.toEqual({ ok: false, reason: 'readiness_timeout' });
        expect(tmuxState.args.filter(args => args[0] === 'send-keys')).toEqual([]);
        expect(warnings).toHaveLength(1);
    });
    strictTmuxIt('reports the wait the caller passed, not one recomputed from the variable', async () => {
        const context = await acceptedContext('claude');
        await bannerThenIdle(Number.POSITIVE_INFINITY);
        await expect(settleOnFakeClock(waitForStartupPaneReady(context, { timeoutMs: 50, pollIntervalMs: 1 })))
            .resolves.toEqual({ ok: false, reason: 'readiness_timeout' });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('timed out after 50ms; OMC_TEAM_READY_TIMEOUT_MS unset (effective 50ms;');
    });
});
//# sourceMappingURL=tmux-session.startup.test.js.map