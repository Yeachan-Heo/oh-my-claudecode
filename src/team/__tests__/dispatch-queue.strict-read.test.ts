import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  patchPendingDispatchReason,
  readDispatchRequest,
  readDispatchRequestStrict,
  type TeamDispatchRequest,
} from '../dispatch-queue.js';

const teamName = 'strict-team';
const timestamp = '2026-07-13T00:00:00.000Z';

function request(overrides: Partial<TeamDispatchRequest> = {}): TeamDispatchRequest {
  return {
    request_id: 'request-1',
    kind: 'mailbox',
    team_name: teamName,
    to_worker: 'worker-1',
    worker_index: 1,
    pane_id: '%9',
    trigger_message: 'Read the mailbox.',
    message_id: 'message-1',
    transport_preference: 'transport_direct',
    fallback_allowed: true,
    status: 'pending',
    attempt_count: 0,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

describe('readDispatchRequestStrict', () => {
  let cwd: string;

  async function writeStore(value: unknown): Promise<string> {
    const path = join(cwd, '.omc', 'state', 'team', teamName, 'dispatch', 'requests.json');
    await mkdir(join(cwd, '.omc', 'state', 'team', teamName, 'dispatch'), { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
    return path;
  }

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-dispatch-strict-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('returns a fresh valid exact mailbox request', async () => {
    const raw = { ...request(), extra_future_field: 'preserved' };
    await writeStore([raw]);

    const result = await readDispatchRequestStrict(teamName, 'request-1', cwd);

    expect(result).toMatchObject({ kind: 'valid', request: request() });
    if (result.kind === 'valid') {
      expect(result.request).not.toBe(raw);
      expect((result.request as unknown as Record<string, unknown>).extra_future_field).toBeUndefined();
    }
  });

  it('distinguishes a missing store, malformed JSON, and non-array JSON', async () => {
    await expect(readDispatchRequestStrict(teamName, 'request-1', cwd)).resolves.toEqual({ kind: 'store_missing' });

    const path = await writeStore([]);
    await writeFile(path, '{not json', 'utf8');
    await expect(readDispatchRequestStrict(teamName, 'request-1', cwd)).resolves.toEqual({
      kind: 'malformed_store', cause: 'json',
    });

    await writeStore({ request: request() });
    await expect(readDispatchRequestStrict(teamName, 'request-1', cwd)).resolves.toEqual({
      kind: 'malformed_store', cause: 'non_array',
    });
  });

  it('fails closed for every malformed row and required field type', async () => {
    await writeStore([null]);
    await expect(readDispatchRequestStrict(teamName, 'request-1', cwd)).resolves.toEqual({
      kind: 'malformed_row', rowIndex: 0, field: '$',
    });

    await writeStore([{ ...request(), fallback_allowed: 'true' }]);
    await expect(readDispatchRequestStrict(teamName, 'request-1', cwd)).resolves.toEqual({
      kind: 'malformed_row', rowIndex: 0, field: 'fallback_allowed',
    });

    await writeStore([{ ...request(), request_id: ' request-1 ' }]);
    await expect(readDispatchRequestStrict(teamName, 'request-1', cwd)).resolves.toEqual({
      kind: 'malformed_row', rowIndex: 0, field: 'request_id',
    });

    await writeStore([{ ...request(), worker_index: 1.5 }]);
    await expect(readDispatchRequestStrict(teamName, 'request-1', cwd)).resolves.toEqual({
      kind: 'malformed_row', rowIndex: 0, field: 'worker_index',
    });
  });

  it('does not use compatibility team rewriting or status defaulting', async () => {
    const legacyLike = { ...request(), team_name: 'foreign-team', status: 'not-a-status' };
    await writeStore([legacyLike]);

    await expect(readDispatchRequestStrict(teamName, 'request-1', cwd)).resolves.toEqual({
      kind: 'team_mismatch', rowIndex: 0,
    });
    await expect(readDispatchRequest(teamName, 'request-1', cwd)).resolves.toMatchObject({
      team_name: teamName,
      status: 'pending',
    });

    await writeStore([{ ...request(), status: 'not-a-status' }]);
    await expect(readDispatchRequestStrict(teamName, 'request-1', cwd)).resolves.toEqual({
      kind: 'invalid_status', rowIndex: 0,
    });
  });

  it('rejects invalid kinds and mailbox rows without a message ID', async () => {
    await writeStore([{ ...request(), kind: 'unknown' }]);
    await expect(readDispatchRequestStrict(teamName, 'request-1', cwd)).resolves.toEqual({
      kind: 'invalid_kind', rowIndex: 0,
    });

    await writeStore([{ ...request(), message_id: undefined }]);
    await expect(readDispatchRequestStrict(teamName, 'request-1', cwd)).resolves.toEqual({
      kind: 'malformed_row', rowIndex: 0, field: 'message_id',
    });

    await writeStore([request({ kind: 'inbox', message_id: undefined })]);
    await expect(readDispatchRequestStrict(teamName, 'request-1', cwd)).resolves.toEqual({
      kind: 'invalid_kind', rowIndex: 0,
    });
  });

  it('rejects duplicate target IDs, unrelated duplicate IDs, and missing targets', async () => {
    await writeStore([request(), request({ updated_at: '2026-07-13T00:01:00.000Z' })]);
    await expect(readDispatchRequestStrict(teamName, 'request-1', cwd)).resolves.toEqual({
      kind: 'duplicate_request_id', requestId: 'request-1', rowIndexes: [0, 1],
    });

    await writeStore([
      request(),
      request({ request_id: 'other', message_id: 'message-2' }),
      request({ request_id: 'other', message_id: 'message-3' }),
    ]);
    await expect(readDispatchRequestStrict(teamName, 'request-1', cwd)).resolves.toEqual({
      kind: 'ambiguous_request', rowIndexes: [1, 2],
    });

    await writeStore([request()]);
    await expect(readDispatchRequestStrict(teamName, 'missing-request', cwd)).resolves.toEqual({ kind: 'request_missing' });
  });

  it('patches only one current pending request and preserves delivery markers', async () => {
    const path = await writeStore([request()]);

    await expect(patchPendingDispatchReason(teamName, 'request-1', 'mailbox_target_foreign', cwd)).resolves.toMatchObject({
      kind: 'patched',
      request: { status: 'pending', last_reason: 'mailbox_target_foreign' },
    });
    const stored = JSON.parse(await readFile(path, 'utf8')) as TeamDispatchRequest[];
    expect(stored[0]).toMatchObject({ status: 'pending', last_reason: 'mailbox_target_foreign' });
    expect(stored[0]?.notified_at).toBeUndefined();
    expect(stored[0]?.delivered_at).toBeUndefined();
    expect(stored[0]?.failed_at).toBeUndefined();

    await writeStore([request({ status: 'notified', notified_at: '2026-07-13T00:02:00.000Z' })]);
    await expect(patchPendingDispatchReason(teamName, 'request-1', 'ignored', cwd)).resolves.toMatchObject({
      kind: 'not_pending', request: { status: 'notified' },
    });
  });

  it('does not mutate ambiguous or invalid stores just to record a reason', async () => {
    const invalidPath = await writeStore([{ ...request(), attempt_count: -1 }]);
    const invalidBefore = await readFile(invalidPath, 'utf8');
    await expect(patchPendingDispatchReason(teamName, 'request-1', 'must-not-write', cwd)).resolves.toMatchObject({
      kind: 'unsafe', read: { kind: 'malformed_row', field: 'attempt_count' },
    });
    await expect(readFile(invalidPath, 'utf8')).resolves.toBe(invalidBefore);

    const duplicatePath = await writeStore([request(), request()]);
    const duplicateBefore = await readFile(duplicatePath, 'utf8');
    await expect(patchPendingDispatchReason(teamName, 'request-1', 'must-not-write', cwd)).resolves.toMatchObject({
      kind: 'unsafe', read: { kind: 'duplicate_request_id' },
    });
    await expect(readFile(duplicatePath, 'utf8')).resolves.toBe(duplicateBefore);
  });
});
