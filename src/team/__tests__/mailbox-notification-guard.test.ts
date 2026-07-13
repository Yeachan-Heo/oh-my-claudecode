import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  teamListMailbox,
  teamReadCanonicalMailboxMessageStrict,
  type StrictCanonicalMailboxMessageReadResult,
} from '../team-ops.js';
import type { TeamConfig, TeamDispatchRequest, TeamMailboxMessage } from '../types.js';
import type { StrictDispatchReadResult } from '../dispatch-queue.js';
import {
  evaluateMailboxNotificationGuard,
  mailboxNotificationSecurityTupleEquals,
  readCurrentMailboxNotificationGuard,
  type MailboxNotificationGuardInput,
  type MailboxNotificationGuardState,
  type MailboxTargetOwnership,
} from '../mailbox-notification-guard.js';

const teamName = 'dispatch-team';
const timestamp = '2026-07-13T00:00:00.000Z';
const input: MailboxNotificationGuardInput = {
  teamName,
  recipient: 'worker-1',
  requestId: 'request-1',
  messageId: 'message-1',
  triggerMessage: 'Read your mailbox and report progress.',
};

function request(overrides: Partial<TeamDispatchRequest> = {}): TeamDispatchRequest {
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

function message(overrides: Partial<TeamMailboxMessage> = {}): TeamMailboxMessage {
  return {
    message_id: input.messageId,
    from_worker: 'leader-fixed',
    to_worker: input.recipient,
    body: 'Continue.',
    created_at: timestamp,
    ...overrides,
  };
}

function config(overrides: Partial<TeamConfig> = {}): TeamConfig {
  return {
    name: teamName,
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

function strictDispatch(value: TeamDispatchRequest = request()): StrictDispatchReadResult {
  return { kind: 'valid', request: value };
}

function strictMailbox(value: TeamMailboxMessage = message()): StrictCanonicalMailboxMessageReadResult {
  return { kind: 'valid', message: value };
}

function owned(): MailboxTargetOwnership {
  return {
    kind: 'owned',
    provider: 'tmux',
    providerTarget: 'dispatch-session:0',
    paneId: '%9',
  };
}

function validState(overrides: Partial<MailboxNotificationGuardState> = {}): MailboxNotificationGuardState {
  return {
    config: config(),
    dispatch: strictDispatch(),
    mailbox: strictMailbox(),
    ownership: owned(),
    ...overrides,
  };
}

describe('teamReadCanonicalMailboxMessageStrict', () => {
  let cwd: string;

  async function writeMailbox(value: unknown, workerName = input.recipient): Promise<void> {
    const path = join(cwd, '.omc', 'state', 'team', teamName, 'mailbox', `${workerName}.json`);
    await mkdir(join(cwd, '.omc', 'state', 'team', teamName, 'mailbox'), { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
  }

  async function writeRawMailbox(raw: string, workerName = input.recipient): Promise<void> {
    const path = join(cwd, '.omc', 'state', 'team', teamName, 'mailbox', `${workerName}.json`);
    await mkdir(join(cwd, '.omc', 'state', 'team', teamName, 'mailbox'), { recursive: true });
    await writeFile(path, raw, 'utf8');
  }

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-mailbox-strict-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
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

    await writeMailbox({ worker: input.recipient, messages: [{ ...message(), body: 42 } as unknown as TeamMailboxMessage] });
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
  it('allows the deterministic canonical duplicate-worker target only when strict metadata agrees', () => {
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
    expect(evaluateMailboxNotificationGuard(input, validState({ ownership: { kind: 'foreign' } }))).toMatchObject({
      kind: 'suppress', reason: 'mailbox_target_foreign',
    });
    expect(evaluateMailboxNotificationGuard(input, validState({ ownership: { kind: 'unavailable' } }))).toMatchObject({
      kind: 'suppress', reason: 'mailbox_membership_unresolvable',
    });
  });

  it('compares named security fields while ignoring diagnostic-only dispatch changes', () => {
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
    if (first.kind !== 'allow' || diagnosticsOnly.kind !== 'allow') return;
    expect(mailboxNotificationSecurityTupleEquals(first.securityTuple, diagnosticsOnly.securityTuple)).toBe(true);
    expect(mailboxNotificationSecurityTupleEquals(first.securityTuple, {
      ...first.securityTuple,
      requestTriggerMessage: 'Different trigger.',
    })).toBe(false);

    const changedSecurity = evaluateMailboxNotificationGuard(input, validState({
      config: config({ tmux_session: 'other-session:0' }),
      ownership: { kind: 'owned', provider: 'tmux', providerTarget: 'other-session:0', paneId: '%9' },
    }));
    expect(changedSecurity.kind).toBe('allow');
    if (changedSecurity.kind !== 'allow') return;
    expect(mailboxNotificationSecurityTupleEquals(first.securityTuple, changedSecurity.securityTuple)).toBe(false);
  });

  it('performs strict current reads and an injected ownership check with zero marker or pane effects', async () => {
    const markMailbox = vi.fn();
    const markDispatch = vi.fn();
    const paneEffect = vi.fn();
    const readConfig = vi.fn(async () => config());
    const readStrictDispatchRequest = vi.fn(async () => strictDispatch());
    const readStrictMailboxMessage = vi.fn(async () => strictMailbox());
    const verifyProviderOwnership = vi.fn(async () => owned());

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
});
