import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { teamListMailbox, teamReadCanonicalMailboxMessageStrict, } from '../team-ops.js';
import { evaluateMailboxNotificationGuard, mailboxNotificationSecurityTupleEquals, readCurrentMailboxNotificationGuard, } from '../mailbox-notification-guard.js';
function isolateFixtureRoot(root) {
    const home = process.env.HOME;
    const userProfile = process.env.USERPROFILE;
    const stateDir = process.env.OMC_STATE_DIR;
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    delete process.env.OMC_STATE_DIR;
    return () => {
        if (home === undefined)
            delete process.env.HOME;
        else
            process.env.HOME = home;
        if (userProfile === undefined)
            delete process.env.USERPROFILE;
        else
            process.env.USERPROFILE = userProfile;
        if (stateDir === undefined)
            delete process.env.OMC_STATE_DIR;
        else
            process.env.OMC_STATE_DIR = stateDir;
    };
}
const teamName = 'dispatch-team';
const timestamp = '2026-07-13T00:00:00.000Z';
const instanceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const supportsStrictTmuxFixture = process.platform === 'darwin' || process.platform === 'linux';
const tmuxServerIdentity = supportsStrictTmuxFixture ? {
    socket_path: '/tmp/dispatch-session.sock',
    server_pid: 4242,
    process_started_at: process.platform === 'linux'
        ? 'linux:fixture:4242'
        : 'darwin:4242:123456',
} : undefined;
// Deliberately malformed evidence for fail-closed cases; never used as
// positive authority (including on unsupported platforms).
const malformedServerPidIdentity = {
    socket_path: '/tmp/dispatch-session.sock',
    server_pid: 0,
    process_started_at: 'darwin:4242:123456',
};
const malformedServerStartIdentity = {
    socket_path: '/tmp/dispatch-session.sock',
    server_pid: 4242,
    process_started_at: 'malformed',
};
function strictTmuxIdentity() {
    if (!tmuxServerIdentity)
        throw new Error('strict tmux fixture unsupported on this platform');
    return tmuxServerIdentity;
}
const input = {
    teamName,
    recipient: 'worker-1',
    requestId: 'request-1',
    messageId: 'message-1',
    triggerMessage: 'Read your mailbox and report progress.',
};
function request(overrides = {}) {
    return {
        request_id: input.requestId,
        kind: 'mailbox',
        team_name: teamName,
        to_worker: input.recipient,
        worker_index: 1,
        pane_id: '%9',
        trigger_message: input.triggerMessage,
        message_id: input.messageId,
        transport_preference: 'transport_direct',
        fallback_allowed: true,
        status: 'pending',
        attempt_count: 0,
        created_at: timestamp,
        updated_at: timestamp,
        ...overrides,
    };
}
function message(overrides = {}) {
    return {
        message_id: input.messageId,
        from_worker: 'leader-fixed',
        to_worker: input.recipient,
        body: 'Continue.',
        created_at: timestamp,
        ...overrides,
    };
}
function config(overrides = {}) {
    const configuredSession = overrides.tmux_session;
    const defaultServerIdentity = configuredSession?.startsWith('cmux:')
        ? undefined
        : tmuxServerIdentity;
    return {
        name: teamName,
        instance_id: instanceId,
        ...(defaultServerIdentity ? { tmux_server_identity: defaultServerIdentity } : {}),
        task: 'dispatch',
        agent_type: 'claude',
        worker_launch_mode: 'interactive',
        worker_count: 1,
        max_workers: 20,
        workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%9' }],
        created_at: timestamp,
        tmux_session: 'dispatch-session:0',
        next_task_id: 2,
        leader_pane_id: '%0',
        hud_pane_id: null,
        resize_hook_name: null,
        resize_hook_target: null,
        ...overrides,
    };
}
function strictDispatch(value = request()) {
    return { kind: 'valid', request: value };
}
function strictMailbox(value = message()) {
    return { kind: 'valid', message: value };
}
function owned() {
    if (!tmuxServerIdentity)
        return { kind: 'unavailable' };
    return {
        kind: 'owned',
        provider: 'tmux',
        providerTarget: 'dispatch-session:0',
        paneId: '%9',
        tmuxServerIdentity,
    };
}
function validState(overrides = {}) {
    return {
        config: config(),
        dispatch: strictDispatch(),
        mailbox: strictMailbox(),
        ownership: owned(),
        ...overrides,
    };
}
describe('teamReadCanonicalMailboxMessageStrict', () => {
    let cwd;
    let restoreFixtureEnv;
    async function writeMailbox(value, workerName = input.recipient) {
        const path = join(cwd, '.omc', 'state', 'team', teamName, 'mailbox', `${workerName}.json`);
        await mkdir(join(cwd, '.omc', 'state', 'team', teamName, 'mailbox'), { recursive: true });
        await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
    }
    async function writeRawMailbox(raw, workerName = input.recipient) {
        const path = join(cwd, '.omc', 'state', 'team', teamName, 'mailbox', `${workerName}.json`);
        await mkdir(join(cwd, '.omc', 'state', 'team', teamName, 'mailbox'), { recursive: true });
        await writeFile(path, raw, 'utf8');
    }
    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-mailbox-strict-'));
        restoreFixtureEnv = isolateFixtureRoot(cwd);
    });
    afterEach(async () => {
        const restore = restoreFixtureEnv;
        restoreFixtureEnv = undefined;
        try {
            restore?.();
        }
        finally {
            await rm(cwd, { recursive: true, force: true });
        }
    });
    it('never falls back to legacy JSONL while compatibility reads still do', async () => {
        const legacyPath = join(cwd, '.omc', 'state', 'team', teamName, 'mailbox', 'worker-1.jsonl');
        await mkdir(join(cwd, '.omc', 'state', 'team', teamName, 'mailbox'), { recursive: true });
        await writeFile(legacyPath, `${JSON.stringify({
            id: input.messageId,
            from: 'leader-fixed',
            to: input.recipient,
            body: 'Continue.',
            createdAt: timestamp,
        })}\n`, 'utf8');
        await expect(teamReadCanonicalMailboxMessageStrict(teamName, input.recipient, input.messageId, cwd)).resolves.toEqual({
            kind: 'store_missing',
        });
        await expect(teamListMailbox(teamName, input.recipient, cwd)).resolves.toMatchObject([
            { message_id: input.messageId, to_worker: input.recipient },
        ]);
    });
    it('distinguishes malformed stores, owner mismatch, malformed messages, missing, and duplicates', async () => {
        await writeRawMailbox('{not-json');
        await expect(teamReadCanonicalMailboxMessageStrict(teamName, input.recipient, input.messageId, cwd)).resolves.toEqual({
            kind: 'malformed_store', cause: 'json',
        });
        await writeMailbox({ worker: input.recipient, messages: {} });
        await expect(teamReadCanonicalMailboxMessageStrict(teamName, input.recipient, input.messageId, cwd)).resolves.toEqual({
            kind: 'malformed_store', cause: 'messages_non_array',
        });
        await writeMailbox({ worker: 'other-worker', messages: [message()] });
        await expect(teamReadCanonicalMailboxMessageStrict(teamName, input.recipient, input.messageId, cwd)).resolves.toEqual({
            kind: 'wrong_owner',
        });
        await writeMailbox({ worker: input.recipient, messages: [{ ...message(), body: 42 }] });
        await expect(teamReadCanonicalMailboxMessageStrict(teamName, input.recipient, input.messageId, cwd)).resolves.toEqual({
            kind: 'malformed_message', messageIndex: 0, field: 'body',
        });
        await writeMailbox({ worker: input.recipient, messages: [message({ message_id: 'other-message' })] });
        await expect(teamReadCanonicalMailboxMessageStrict(teamName, input.recipient, input.messageId, cwd)).resolves.toEqual({
            kind: 'message_missing',
        });
        await writeMailbox({ worker: input.recipient, messages: [message(), message()] });
        await expect(teamReadCanonicalMailboxMessageStrict(teamName, input.recipient, input.messageId, cwd)).resolves.toEqual({
            kind: 'duplicate_message_id', messageId: input.messageId, messageIndexes: [0, 1],
        });
    });
    it('rejects recipient mismatch and replay, then returns a fresh exact canonical message', async () => {
        await writeMailbox({ worker: input.recipient, messages: [message({ to_worker: 'worker-2' })] });
        await expect(teamReadCanonicalMailboxMessageStrict(teamName, input.recipient, input.messageId, cwd)).resolves.toEqual({
            kind: 'recipient_mismatch', messageIndex: 0,
        });
        await writeMailbox({ worker: input.recipient, messages: [message({ notified_at: '2026-07-13T00:01:00.000Z' })] });
        await expect(teamReadCanonicalMailboxMessageStrict(teamName, input.recipient, input.messageId, cwd)).resolves.toMatchObject({
            kind: 'replay_suppressed', marker: 'notified_at',
        });
        await writeMailbox({ worker: input.recipient, messages: [message()] });
        await expect(teamReadCanonicalMailboxMessageStrict(teamName, input.recipient, input.messageId, cwd)).resolves.toMatchObject({
            kind: 'valid', message: message(),
        });
    });
});
describe('mailbox notification guard', () => {
    it.skipIf(!supportsStrictTmuxFixture)('allows the deterministic canonical duplicate-worker target only when strict metadata agrees', () => {
        const duplicateConfig = config({
            workers: [
                { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
                { name: 'worker-1', index: 0, role: 'executor', assigned_tasks: [], pane_id: '%9' },
            ],
        });
        const result = evaluateMailboxNotificationGuard(input, validState({ config: duplicateConfig }));
        expect(result).toMatchObject({ kind: 'allow', target: { paneId: '%9', recipientRole: 'worker' } });
        const mismatched = evaluateMailboxNotificationGuard(input, validState({
            config: duplicateConfig,
            dispatch: strictDispatch(request({ pane_id: '%foreign' })),
        }));
        expect(mismatched).toMatchObject({
            kind: 'suppress', reason: 'mailbox_target_metadata_mismatch',
        });
    });
    it('maps every strict evidence and provider failure to a stable pre-effect reason', () => {
        expect(evaluateMailboxNotificationGuard(input, validState({ config: null }))).toMatchObject({
            kind: 'suppress', reason: 'mailbox_team_unavailable',
        });
        expect(evaluateMailboxNotificationGuard(input, validState({ config: config({ name: 'other-team' }) }))).toMatchObject({
            kind: 'suppress', reason: 'mailbox_team_identity_mismatch',
        });
        expect(evaluateMailboxNotificationGuard(input, validState({ config: config({ workers: [] }) }))).toMatchObject({
            kind: 'suppress', reason: 'mailbox_target_missing',
        });
        expect(evaluateMailboxNotificationGuard(input, validState({
            dispatch: { kind: 'malformed_row', rowIndex: 0, field: 'status' },
        }))).toMatchObject({ kind: 'suppress', reason: 'mailbox_dispatch_store_invalid' });
        expect(evaluateMailboxNotificationGuard(input, validState({
            dispatch: { kind: 'duplicate_request_id', requestId: input.requestId, rowIndexes: [0, 1] },
        }))).toMatchObject({ kind: 'suppress', reason: 'mailbox_request_ambiguous' });
        expect(evaluateMailboxNotificationGuard(input, validState({
            dispatch: strictDispatch(request({ status: 'notified' })),
        }))).toMatchObject({ kind: 'suppress', reason: 'mailbox_request_not_pending' });
        expect(evaluateMailboxNotificationGuard(input, validState({
            dispatch: strictDispatch(request({ trigger_message: 'Different trigger.' })),
        }))).toMatchObject({ kind: 'suppress', reason: 'mailbox_request_identity_mismatch' });
        expect(evaluateMailboxNotificationGuard(input, validState({
            mailbox: { kind: 'replay_suppressed', message: message({ notified_at: timestamp }), marker: 'notified_at' },
        }))).toMatchObject({ kind: 'suppress', reason: 'mailbox_replay_suppressed' });
        const foreignState = supportsStrictTmuxFixture
            ? validState({ ownership: { kind: 'foreign' } })
            : validState({
                config: config({
                    tmux_session: 'cmux:workspace-1',
                    workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: 'surface-worker-1' }],
                }),
                dispatch: strictDispatch(request({ pane_id: 'surface-worker-1' })),
                ownership: { kind: 'foreign' },
            });
        expect(evaluateMailboxNotificationGuard(input, foreignState)).toMatchObject({
            kind: 'suppress', reason: 'mailbox_target_foreign',
        });
        expect(evaluateMailboxNotificationGuard(input, validState({ ownership: { kind: 'unavailable' } }))).toMatchObject({
            kind: 'suppress', reason: 'mailbox_membership_unresolvable',
        });
        const mismatchedOwnershipState = supportsStrictTmuxFixture
            ? validState({
                ownership: {
                    kind: 'owned',
                    provider: 'tmux',
                    providerTarget: 'dispatch-session:0',
                    paneId: '%9',
                    tmuxServerIdentity: { ...strictTmuxIdentity(), server_pid: 4343 },
                },
            })
            : validState({
                config: config({
                    tmux_session: 'cmux:workspace-1',
                    workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: 'surface-worker-1' }],
                }),
                dispatch: strictDispatch(request({ pane_id: 'surface-worker-1' })),
                ownership: {
                    kind: 'owned',
                    provider: 'cmux',
                    providerTarget: 'cmux:workspace-1',
                    paneId: 'surface-worker-1',
                    tmuxServerIdentity: undefined,
                },
            });
        expect(evaluateMailboxNotificationGuard(input, mismatchedOwnershipState)).toMatchObject({
            kind: 'suppress', reason: 'mailbox_provider_mismatch',
        });
    });
    it('defers tmux effects when immutable instance or server proof is absent or malformed', () => {
        for (const override of [
            { instance_id: undefined },
            { instance_id: 'not-an-instance-id' },
            { tmux_server_identity: undefined },
            { tmux_server_identity: malformedServerPidIdentity },
            { tmux_server_identity: malformedServerStartIdentity },
        ]) {
            const result = evaluateMailboxNotificationGuard(input, validState({
                config: config(override),
            }));
            expect(result).toMatchObject({
                kind: 'suppress',
                reason: 'mailbox_membership_unresolvable',
                safePendingRequest: request(),
            });
        }
    });
    it('requires an instance UUID for CMUX while never attaching a fake tmux identity', () => {
        const cmuxTarget = {
            kind: 'owned',
            provider: 'cmux',
            providerTarget: 'cmux:workspace-1',
            paneId: 'surface-worker-1',
        };
        const result = evaluateMailboxNotificationGuard(input, validState({
            config: config({
                tmux_session: 'cmux:workspace-1',
                workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: 'surface-worker-1' }],
            }),
            dispatch: strictDispatch(request({ pane_id: 'surface-worker-1' })),
            ownership: cmuxTarget,
        }));
        expect(result).toMatchObject({
            kind: 'allow',
            target: {
                provider: 'cmux',
                providerTarget: 'cmux:workspace-1',
                paneId: 'surface-worker-1',
            },
        });
        if (result.kind !== 'allow')
            return;
        expect(result.target.tmuxServerIdentity).toBeUndefined();
        expect(result.securityTuple.configTmuxServerSocketPath).toBeUndefined();
        expect(result.securityTuple.configTmuxServerPid).toBeUndefined();
        expect(result.securityTuple.configTmuxServerProcessStartedAt).toBeUndefined();
        expect(evaluateMailboxNotificationGuard(input, validState({
            config: config({
                tmux_session: 'cmux:workspace-1',
                instance_id: undefined,
                workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: 'surface-worker-1' }],
            }),
            dispatch: strictDispatch(request({ pane_id: 'surface-worker-1' })),
            ownership: cmuxTarget,
        }))).toMatchObject({
            kind: 'suppress',
            reason: 'mailbox_membership_unresolvable',
        });
        expect(evaluateMailboxNotificationGuard(input, validState({
            config: config({
                tmux_session: 'cmux:workspace-1',
                workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: 'surface-worker-1' }],
            }),
            dispatch: strictDispatch(request({ pane_id: 'surface-worker-1' })),
            ownership: {
                ...cmuxTarget,
                tmuxServerIdentity,
            },
        }))).toMatchObject({
            kind: 'suppress',
            reason: 'mailbox_provider_mismatch',
        });
    });
    it.skipIf(!supportsStrictTmuxFixture)('compares named security fields while ignoring diagnostic-only dispatch changes', () => {
        const identity = strictTmuxIdentity();
        const first = evaluateMailboxNotificationGuard(input, validState());
        const diagnosticsOnly = evaluateMailboxNotificationGuard(input, validState({
            dispatch: strictDispatch(request({
                attempt_count: 3,
                updated_at: '2026-07-13T00:03:00.000Z',
                last_reason: 'mailbox_membership_unresolvable',
            })),
        }));
        expect(first.kind).toBe('allow');
        expect(diagnosticsOnly.kind).toBe('allow');
        if (first.kind !== 'allow' || diagnosticsOnly.kind !== 'allow')
            return;
        expect(mailboxNotificationSecurityTupleEquals(first.securityTuple, diagnosticsOnly.securityTuple)).toBe(true);
        expect(mailboxNotificationSecurityTupleEquals(first.securityTuple, {
            ...first.securityTuple,
            requestTriggerMessage: 'Different trigger.',
        })).toBe(false);
        expect(mailboxNotificationSecurityTupleEquals(first.securityTuple, {
            ...first.securityTuple,
            configInstanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        })).toBe(false);
        expect(mailboxNotificationSecurityTupleEquals(first.securityTuple, {
            ...first.securityTuple,
            configTmuxServerSocketPath: '/tmp/other.sock',
        })).toBe(false);
        expect(mailboxNotificationSecurityTupleEquals(first.securityTuple, {
            ...first.securityTuple,
            configTmuxServerPid: 4243,
        })).toBe(false);
        expect(mailboxNotificationSecurityTupleEquals(first.securityTuple, {
            ...first.securityTuple,
            configTmuxServerProcessStartedAt: process.platform === 'linux'
                ? 'linux:fixture:4243'
                : 'darwin:4242:123457',
        })).toBe(false);
        const changedSecurity = evaluateMailboxNotificationGuard(input, validState({
            config: config({ tmux_session: 'other-session:0' }),
            ownership: {
                kind: 'owned',
                provider: 'tmux',
                providerTarget: 'other-session:0',
                paneId: '%9',
                tmuxServerIdentity: identity,
            },
        }));
        expect(changedSecurity.kind).toBe('allow');
        if (changedSecurity.kind !== 'allow')
            return;
        expect(mailboxNotificationSecurityTupleEquals(first.securityTuple, changedSecurity.securityTuple)).toBe(false);
    });
    it.skipIf(!supportsStrictTmuxFixture)('performs strict current reads and an injected ownership check with zero marker or pane effects', async () => {
        const identity = strictTmuxIdentity();
        const markMailbox = vi.fn();
        const markDispatch = vi.fn();
        const paneEffect = vi.fn();
        const readConfig = vi.fn(async () => config());
        const readStrictDispatchRequest = vi.fn(async () => strictDispatch());
        const readStrictMailboxMessage = vi.fn(async () => strictMailbox());
        const verifyProviderOwnership = vi.fn(async (target) => {
            expect(target.tmuxServerIdentity).toEqual(identity);
            return owned();
        });
        const result = await readCurrentMailboxNotificationGuard(input, '/unused', {
            readConfig,
            readStrictDispatchRequest,
            readStrictMailboxMessage,
            verifyProviderOwnership,
        });
        expect(result).toMatchObject({ kind: 'allow', target: { paneId: '%9' } });
        expect(readStrictDispatchRequest).toHaveBeenCalledWith(teamName, input.requestId, '/unused');
        expect(readStrictMailboxMessage).toHaveBeenCalledWith(teamName, input.recipient, input.messageId, '/unused');
        expect(verifyProviderOwnership).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%9' }));
        expect(markMailbox).not.toHaveBeenCalled();
        expect(markDispatch).not.toHaveBeenCalled();
        expect(paneEffect).not.toHaveBeenCalled();
    });
    it.skipIf(!supportsStrictTmuxFixture)('keeps the persisted target snapshot stable when ownership probing mutates its argument', async () => {
        const identity = strictTmuxIdentity();
        const readConfig = vi.fn(async () => config());
        const readStrictDispatchRequest = vi.fn(async () => strictDispatch());
        const readStrictMailboxMessage = vi.fn(async () => strictMailbox());
        const verifyProviderOwnership = vi.fn(async (target) => {
            target.tmuxServerIdentity.server_pid = 9001;
            return owned();
        });
        const result = await readCurrentMailboxNotificationGuard(input, '/unused', {
            readConfig,
            readStrictDispatchRequest,
            readStrictMailboxMessage,
            verifyProviderOwnership,
        });
        expect(result).toMatchObject({
            kind: 'allow',
            target: { tmuxServerIdentity: identity },
            securityTuple: {
                configTmuxServerPid: identity.server_pid,
            },
        });
        expect(readConfig).toHaveBeenCalledOnce();
    });
    it('does not invoke an ownership probe that could fill missing historical proof', async () => {
        const verifyProviderOwnership = vi.fn(async () => owned());
        const result = await readCurrentMailboxNotificationGuard(input, '/unused', {
            readConfig: vi.fn(async () => config({ tmux_server_identity: undefined })),
            readStrictDispatchRequest: vi.fn(async () => strictDispatch()),
            readStrictMailboxMessage: vi.fn(async () => strictMailbox()),
            verifyProviderOwnership,
        });
        expect(result).toMatchObject({
            kind: 'suppress',
            reason: 'mailbox_membership_unresolvable',
        });
        expect(verifyProviderOwnership).not.toHaveBeenCalled();
    });
});
//# sourceMappingURL=mailbox-notification-guard.test.js.map