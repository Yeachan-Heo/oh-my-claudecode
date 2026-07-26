import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GRAPH_COMMAND_OPERATIONS,
  graphCommand,
  type GraphCommandRequest,
  type GraphCommandService,
} from '../graph.js';
import { sealGraphDescriptor } from '../../../graph/descriptor.js';
import { graphCommandService } from '../../../graph/runtime.js';
import { createInitialGraphState } from '../../../graph/runtime-types.js';
import { GraphStateStore } from '../../../graph/store.js';
import { forkJoinDescriptor } from '../../../graph/__tests__/fixtures.js';

function captureConsole() {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(' '));
  });
  const error = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.map(String).join(' '));
  });
  return { out, err, restore: () => { log.mockRestore(); error.mockRestore(); } };
}

function serviceReturning(result: unknown = { state: 'ok' }): {
  service: GraphCommandService;
  requests: GraphCommandRequest[];
} {
  const requests: GraphCommandRequest[] = [];
  return {
    requests,
    service: {
      async execute(request) {
        requests.push(request);
        return result;
      },
    },
  };
}

const HASH = 'a'.repeat(64);
const SESSION = ['--session-id', 'session-1'] as const;
const TRANSITION = ['--transition-id', 'transition-1'] as const;
const COMMON = [
  '--run-id', 'run-1',
  '--revision-id', 'revision-1',
  '--descriptor-hash', HASH,
  ...SESSION,
] as const;
const SEQUENCED = [...COMMON, '--expected-sequence', '7'] as const;
const DRIVER = ['--driver-id', 'driver-1'] as const;
const MUTATING_OPERATIONS = new Set([
  'create',
  'approve',
  'claim',
  'complete',
  'fail',
  'propose-patch',
  'approve-patch',
  'pause',
  'abandon',
  'resume',
  'resolve-join',
  'renew-claim',
  'recover-expired-claim',
  'record-late-claim-result',
  'release-attempt-for-retry',
  'resolve-reconciliation',
]);

const operationArgs: Record<(typeof GRAPH_COMMAND_OPERATIONS)[number], string[]> = {
  create: [
    '--goal', 'Extract payments',
    '--descriptor', '{"descriptor_version":1}',
    ...SESSION,
    ...DRIVER,
    ...TRANSITION,
  ],
  inspect: ['--run-id', 'run-1', ...SESSION],
  approve: [...COMMON, ...TRANSITION, '--approval', '{"approved":true,"reviewer":"human"}'],
  ready: [...SEQUENCED],
  claim: [...SEQUENCED, ...DRIVER, ...TRANSITION, '--limit', '3'],
  complete: [
    ...SEQUENCED,
    ...TRANSITION,
    '--claim', '{"lease_id":"lease-1"}',
    '--result', '{"outcome":"succeeded"}',
  ],
  fail: [
    ...SEQUENCED,
    ...TRANSITION,
    '--claim', '{"lease_id":"lease-1"}',
    '--result', '{"outcome":"failed"}',
  ],
  'propose-patch': [
    '--run-id', 'run-1',
    ...SESSION,
    '--base-revision-id', 'revision-1',
    '--base-descriptor-hash', HASH,
    '--expected-sequence', '7',
    ...TRANSITION,
    '--patch', '{"revision_id":"revision-2"}',
  ],
  'approve-patch': [
    '--run-id', 'run-1',
    ...SESSION,
    '--base-revision-id', 'revision-1',
    '--base-descriptor-hash', HASH,
    '--expected-sequence', '7',
    ...TRANSITION,
    '--approval', '{"approved":true}',
  ],
  status: ['--run-id', 'run-1', ...SESSION],
  pause: [...SEQUENCED, ...DRIVER, ...TRANSITION],
  abandon: [
    ...SEQUENCED,
    ...TRANSITION,
    '--confirmation', '{"run_id":"run-1","revision_id":"revision-1","abandon":true}',
  ],
  resume: [...COMMON, ...DRIVER, ...TRANSITION],
  'resolve-join': [
    ...SEQUENCED,
    ...TRANSITION,
    '--activation-id', 'act-join-1',
    '--identities', '{"next_activation_ids":{"join-to-verify":"act-verify"}}',
  ],
  'renew-claim': [
    ...SEQUENCED,
    ...TRANSITION,
    '--lease-id', 'lease-1',
    ...DRIVER,
    '--tracking-id', 'tool-1',
    '--tool-still-running', 'true',
    '--now', '2026-07-21T00:00:01.000Z',
  ],
  'recover-expired-claim': [
    ...SEQUENCED,
    ...TRANSITION,
    '--lease-id', 'lease-1',
    '--now', '2026-07-21T00:00:02.000Z',
    '--new-attempt-id', 'attempt-2',
    '--new-lease-id', 'lease-2',
    '--new-tracking-id', 'tool-2',
    ...DRIVER,
    '--reconciliation-id', 'reconciliation-1',
  ],
  'record-late-claim-result': [
    ...SEQUENCED,
    ...TRANSITION,
    '--lease-id', 'lease-1',
    '--attempt-id', 'attempt-1',
    '--recorded-at', '2026-07-21T00:00:03.000Z',
    '--summary', 'old result arrived after takeover',
  ],
  'release-attempt-for-retry': [
    ...SEQUENCED,
    ...TRANSITION,
    '--activation-id', 'act-1',
    '--attempt-id', 'attempt-1',
  ],
  'resolve-reconciliation': [
    ...SEQUENCED,
    ...TRANSITION,
    '--evidence', '{"kind":"human","ref":"resolution-1"}',
    '--resolved-at', '2026-07-21T00:00:04.000Z',
  ],
};

describe('omc graph CLI boundary', () => {
  let captured: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    captured = captureConsole();
    process.exitCode = 0;
  });

  afterEach(() => {
    captured.restore();
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  it('prints help without invoking a runtime service', async () => {
    const { service, requests } = serviceReturning();

    await graphCommand([], service);

    expect(captured.out.join('\n')).toMatch(/omc graph/);
    expect(captured.out.join('\n')).toMatch(/create.*approve.*claim/s);
    expect(captured.out.join('\n')).not.toMatch(/settle-session/);
    expect(requests).toEqual([]);
  });

  it.each(GRAPH_COMMAND_OPERATIONS)('strictly parses and delegates %s', async (operation) => {
    const { service, requests } = serviceReturning({ phase: 'running' });

    await graphCommand([operation, ...operationArgs[operation], '--json'], service);

    expect(process.exitCode).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ operation, cwd: process.cwd() });
    expect(requests[0].input.session_id).toBe('session-1');
    if (MUTATING_OPERATIONS.has(operation)) {
      expect(requests[0].input.transition_id).toBe('transition-1');
    } else {
      expect(requests[0].input).not.toHaveProperty('transition_id');
    }
    expect(JSON.parse(captured.out[0])).toMatchObject({
      ok: true,
      operation,
      result: { phase: 'running' },
    });
  });

  it('parses optional complete identities and forwards them unchanged', async () => {
    const { service, requests } = serviceReturning();
    const identities = { join_activation_id: 'run-1:act:join-build:resolved' };

    await graphCommand([
      'complete',
      ...operationArgs.complete,
      '--identities', JSON.stringify(identities),
    ], service);

    expect(process.exitCode).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].input.identities).toEqual(identities);
  });

  it('forwards complete identities through the CLI boundary so a fan-out join activates', async () => {
    const sessionId = 'session-cli-complete-identities';
    const worktree = await mkdtemp(join(tmpdir(), 'omc-graph-cli-runtime-'));
    const originalCwd = process.cwd();
    process.chdir(worktree);

    try {
      await mkdir(join(worktree, '.omc', 'state', 'sessions', sessionId), { recursive: true });
      const descriptor = sealGraphDescriptor(forkJoinDescriptor());
      const store = new GraphStateStore({ sessionId, worktreeRoot: worktree });
      const approvalActivationId = `${descriptor.run_id}:act:approval:entry`;
      store.create(createInitialGraphState({
        session_id: sessionId,
        control_nonce: 'nonce-cli-complete-identities',
        descriptor,
        status: 'running',
        created_at: '2026-07-26T00:00:00.000Z',
        projection: {
          activations: {
            [approvalActivationId]: {
              activation_id: approvalActivationId,
              node_id: 'approval',
              status: 'ready',
              attempt_no: 0,
              attempt_ids: [],
              traversal_owner_id: approvalActivationId,
            },
          },
          cohorts: {},
          branch_tokens: {},
          traversal_counts: {},
          committed_transitions: {},
          terminal_verification_activation_ids: [],
        },
        approval: {
          approved_at: '2026-07-26T00:00:00.000Z',
          evidence: { kind: 'human', ref: 'approval-cli' },
        },
      }));

      const execute = (operation: string, input: Record<string, unknown>) => graphCommandService.execute({
        operation: operation as GraphCommandRequest['operation'],
        cwd: process.cwd(),
        input,
      }) as Promise<{ result: Record<string, unknown> }>;
      const scope = {
        session_id: sessionId,
        run_id: descriptor.run_id,
        revision_id: descriptor.revision_id,
        descriptor_hash: descriptor.descriptor_hash,
      };
      const claim = async (expectedSequence: number, transitionId: string) => {
        const response = await execute('claim', {
          ...scope,
          expected_sequence: expectedSequence,
          driver_id: 'driver-cli',
          transition_id: transitionId,
          limit: 1,
        });
        return response.result.claims as Array<Record<string, unknown>>;
      };
      const complete = async (
        expectedSequence: number,
        transitionId: string,
        currentClaim: Record<string, unknown>,
        evidenceKind: 'human' | 'command',
      ) => execute('complete', {
        ...scope,
        expected_sequence: expectedSequence,
        transition_id: transitionId,
        claim: {
          lease_id: currentClaim.lease_id,
          activation_id: currentClaim.activation_id,
          attempt_id: currentClaim.attempt_id,
        },
        result: { outcome: 'succeeded', evidence_refs: [{ kind: evidenceKind, ref: transitionId }] },
      });

      const approvalClaim = (await claim(0, 'claim-approval'))[0];
      await complete(1, 'complete-approval', approvalClaim, 'human');
      const analyzeClaim = (await claim(2, 'claim-analyze'))[0];
      await complete(3, 'complete-analyze', analyzeClaim, 'command');
      const firstBranchClaim = (await claim(4, 'claim-branch-a'))[0];
      await complete(5, 'complete-branch-a', firstBranchClaim, 'command');
      const secondBranchClaim = (await claim(6, 'claim-branch-b'))[0];
      const joinActivationId = `${descriptor.run_id}:act:join-build:cli`;

      await graphCommand([
        'complete',
        '--run-id', descriptor.run_id,
        '--revision-id', descriptor.revision_id,
        '--descriptor-hash', descriptor.descriptor_hash,
        '--session-id', sessionId,
        '--expected-sequence', '7',
        '--transition-id', 'complete-branch-b-cli',
        '--claim', JSON.stringify({
          lease_id: secondBranchClaim.lease_id,
          activation_id: secondBranchClaim.activation_id,
          attempt_id: secondBranchClaim.attempt_id,
        }),
        '--result', '{"outcome":"succeeded","evidence_refs":[{"kind":"command","ref":"branch-b"}]}',
        '--identities', JSON.stringify({ join_activation_id: joinActivationId }),
      ], graphCommandService);

      expect(process.exitCode).toBe(0);
      expect(JSON.parse(captured.out[0])).toMatchObject({ ok: true, operation: 'complete' });
      expect(store.read()!.projection.activations[joinActivationId]).toMatchObject({
        activation_id: joinActivationId,
        status: 'ready',
      });
    } finally {
      process.chdir(originalCwd);
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it('parses JSON object flags from a file path', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omc-graph-cli-'));
    const original = process.cwd();
    process.chdir(cwd);
    try {
      await writeFile(join(cwd, 'descriptor.json'), '{"descriptor_version":1,"run_id":"run-1"}');
      const { service, requests } = serviceReturning();

      await graphCommand([
        'create',
        '--goal', 'Extract payments',
        '--descriptor', 'descriptor.json',
        ...SESSION,
        ...DRIVER,
        ...TRANSITION,
      ], service);

      expect(requests[0].input.descriptor).toEqual({ descriptor_version: 1, run_id: 'run-1' });
    } finally {
      process.chdir(original);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('delegates hidden session settlement with explicit session, driver, and transition scope', async () => {
    const { service, requests } = serviceReturning({ settled_lease_ids: ['lease-1'] });

    await graphCommand([
      'settle-session',
      ...SESSION,
      ...DRIVER,
      ...TRANSITION,
      '--json',
    ], service);

    expect(requests).toEqual([{
      operation: 'settle-session',
      cwd: process.cwd(),
      input: {
        session_id: 'session-1',
        driver_id: 'driver-1',
        transition_id: 'transition-1',
      },
    }]);
    expect(JSON.parse(captured.out[0])).toMatchObject({
      ok: true,
      operation: 'settle-session',
      result: { settled_lease_ids: ['lease-1'] },
    });
  });

  it('rejects hidden session settlement without explicit session scope', async () => {
    const { service, requests } = serviceReturning();

    await graphCommand(['settle-session', ...DRIVER, ...TRANSITION], service);

    expect(process.exitCode).toBe(1);
    expect(requests).toEqual([]);
    expect(JSON.parse(captured.err[0]).error).toMatch(/--session-id/);
  });

  it.each(GRAPH_COMMAND_OPERATIONS)('rejects a missing required flag for %s before delegation', async (operation) => {
    const { service, requests } = serviceReturning();
    const args = operationArgs[operation].slice(2);

    await graphCommand([operation, ...args], service);

    expect(process.exitCode).toBe(1);
    expect(requests).toEqual([]);
    expect(JSON.parse(captured.err[0])).toMatchObject({ ok: false, operation });
  });

  it('rejects unknown, duplicate, malformed JSON, and invalid numeric flags', async () => {
    const cases = [
      ['status', '--run-id', 'run-1', '--unknown', 'value'],
      ['status', '--run-id', 'run-1', ...SESSION, '--run-id', 'run-2'],
      ['create', '--goal', 'goal', '--descriptor', '{bad', ...SESSION, ...DRIVER, ...TRANSITION],
      ['claim', ...SEQUENCED, ...DRIVER, ...TRANSITION, '--limit', '0'],
    ];

    for (const args of cases) {
      captured.err.length = 0;
      process.exitCode = 0;
      const { service, requests } = serviceReturning();
      await graphCommand(args, service);
      expect(process.exitCode).toBe(1);
      expect(requests).toEqual([]);
      expect(() => JSON.parse(captured.err[0])).not.toThrow();
    }
  });

  it('rejects omitted session scope and mutating transition identity', async () => {
    const { service, requests } = serviceReturning();

    await graphCommand(['status', '--run-id', 'run-1'], service);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(captured.err[0]).error).toMatch(/--session-id/);

    captured.err.length = 0;
    process.exitCode = 0;
    await graphCommand(
      ['claim', ...SEQUENCED, ...DRIVER, '--limit', '3'],
      service,
    );
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(captured.err[0]).error).toMatch(/--transition-id/);
    expect(requests).toEqual([]);
  });

  it('bounds successful output and service error messages', async () => {
    const large = serviceReturning({ private_output: 'x'.repeat(100_000) });
    await graphCommand(['status', '--run-id', 'run-1', ...SESSION], large.service);
    expect(process.exitCode).toBe(1);
    expect(Buffer.byteLength(captured.err[0], 'utf8')).toBeLessThan(4_096);
    expect(JSON.parse(captured.err[0]).error).toMatch(/output exceeds/i);

    captured.err.length = 0;
    process.exitCode = 0;
    const failing: GraphCommandService = {
      async execute() {
        throw new Error('sensitive '.repeat(10_000));
      },
    };
    await graphCommand(['status', '--run-id', 'run-1', ...SESSION], failing);
    expect(process.exitCode).toBe(1);
    expect(Buffer.byteLength(captured.err[0], 'utf8')).toBeLessThan(4_096);
  });

  it('contains no process or in-session tool execution path', async () => {
    const source = await readFile(new URL('../graph.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/node:child_process|\bspawn\s*\(|\bexec(?:File)?\s*\(/);
    expect(source).not.toMatch(/Agent|AskUserQuestion|\bBash\b/);
  });

  it('ships an explicit-only persistent in-session driver contract', async () => {
    const skill = await readFile(
      new URL('../../../../skills/graph/SKILL.md', import.meta.url),
      'utf8',
    );

    expect(skill).toMatch(/name: graph/);
    expect(skill).not.toMatch(/^triggers:/m);
    expect(skill).toMatch(/\/oh-my-claudecode:graph <development goal>/);
    expect(skill).toMatch(/exact revision ID and descriptor SHA-256/);
    expect(skill).toMatch(/Agent\/Task surface/);
    expect(skill).toMatch(/permission-governed\s+Bash surface/);
    expect(skill).toMatch(/join.*deterministic scheduler/is);
    expect(skill).toMatch(/do\s+not busy-poll/i);
    expect(skill).toMatch(/normal user cancel means `pause`/i);
    expect(skill).toMatch(/Permanent `abandon` is separate/);
  });
});
