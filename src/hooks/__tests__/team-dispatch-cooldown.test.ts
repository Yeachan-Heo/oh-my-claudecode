import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { drainPendingTeamDispatch, type InjectionResult } from '../team-dispatch-hook.js';
import type { TeamDispatchRequest } from '../../team/dispatch-queue.js';

// Regression coverage for the #3224 "dispatch gap": issue/trigger cooldowns
// must only be stamped once a dispatch is actually delivered. Stamping on
// failure (or before an unconfirmed retry) gated legitimate re-dispatch for
// the cooldown window and stranded the worker.

const TEAM = 'dispatch-cooldown-team';

let root: string;
let stateDir: string;
let logsDir: string;
let teamDir: string;
let savedEnv: NodeJS.ProcessEnv;

function makeRequest(overrides: Partial<TeamDispatchRequest> = {}): TeamDispatchRequest {
  const now = new Date().toISOString();
  return {
    request_id: `req-${Math.random().toString(16).slice(2, 10)}`,
    kind: 'inbox',
    team_name: TEAM,
    to_worker: 'worker-1',
    worker_index: 1,
    pane_id: '%1',
    trigger_message: 'work item',
    transport_preference: 'hook_preferred_with_fallback',
    fallback_allowed: true,
    status: 'pending',
    attempt_count: 0,
    created_at: now,
    updated_at: now,
    ...overrides,
  } as TeamDispatchRequest;
}

async function writeRequests(requests: TeamDispatchRequest[]): Promise<void> {
  await writeFile(join(teamDir, 'dispatch', 'requests.json'), JSON.stringify(requests, null, 2));
}

async function readRequests(): Promise<TeamDispatchRequest[]> {
  return JSON.parse(await readFile(join(teamDir, 'dispatch', 'requests.json'), 'utf8'));
}

async function readIssueCooldownKeys(): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(join(teamDir, 'dispatch', 'issue-cooldown.json'), 'utf8'));
    return Object.keys(parsed?.by_issue ?? {});
  } catch {
    return [];
  }
}

async function drain(injector: (request: TeamDispatchRequest) => Promise<InjectionResult>) {
  return drainPendingTeamDispatch({
    cwd: root,
    stateDir,
    logsDir,
    maxPerTick: 10,
    injector: async (request) => injector(request as unknown as TeamDispatchRequest),
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'omc-dispatch-cooldown-'));
  stateDir = join(root, 'state');
  logsDir = join(root, 'logs');
  teamDir = join(stateDir, 'team', TEAM);
  await mkdir(join(teamDir, 'dispatch'), { recursive: true });
  await writeFile(join(teamDir, 'config.json'), JSON.stringify({ tmux_session: 'sess' }));

  savedEnv = { ...process.env };
  delete process.env.OMC_TEAM_WORKER;
  // Keep both cooldowns active and large so any stamped cooldown would gate.
  process.env.OMC_TEAM_DISPATCH_ISSUE_COOLDOWN_MS = '600000';
  process.env.OMC_TEAM_DISPATCH_TRIGGER_COOLDOWN_MS = '600000';
});

afterEach(async () => {
  process.env = savedEnv;
  await rm(root, { recursive: true, force: true });
});

describe('drainPendingTeamDispatch cooldown stamping', () => {
  it('stamps the issue cooldown on a successful dispatch and dedups same-issue requests', async () => {
    await writeRequests([
      makeRequest({ request_id: 'a', trigger_message: 'Resolve ABC-100 now' }),
      makeRequest({ request_id: 'b', trigger_message: 'Resolve ABC-100 again' }),
    ]);

    const calls: string[] = [];
    const result = await drain(async (request) => {
      calls.push(request.request_id);
      return { ok: true, reason: 'tmux_injected' };
    });

    // First delivered, second gated by the freshly-stamped issue cooldown.
    expect(calls).toEqual(['a']);
    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(await readIssueCooldownKeys()).toContain('ABC-100');

    const requests = await readRequests();
    expect(requests.find((r) => r.request_id === 'a')?.status).toBe('notified');
    expect(requests.find((r) => r.request_id === 'b')?.status).toBe('pending');
  });

  it('does not stamp the issue cooldown when dispatch fails, so re-dispatch is not gated', async () => {
    await writeRequests([
      makeRequest({ request_id: 'a', trigger_message: 'Resolve ABC-200 now' }),
      makeRequest({ request_id: 'b', trigger_message: 'Resolve ABC-200 again' }),
    ]);

    const calls: string[] = [];
    const result = await drain(async (request) => {
      calls.push(request.request_id);
      return { ok: false, reason: 'missing_tmux_target' };
    });

    // The failed first request must NOT poison the issue: the second still
    // reaches the injector instead of being skipped for the cooldown window.
    expect(calls).toEqual(['a', 'b']);
    expect(result.failed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(await readIssueCooldownKeys()).not.toContain('ABC-200');
  });

  it('does not self-gate an unconfirmed dispatch awaiting retry', async () => {
    await writeRequests([makeRequest({ request_id: 'a', trigger_message: 'Resolve ABC-300 now' })]);

    let calls = 0;
    const injector = async (): Promise<InjectionResult> => {
      calls += 1;
      return { ok: true, reason: 'tmux_send_keys_unconfirmed' };
    };

    const first = await drain(injector);
    expect(calls).toBe(1);
    expect(first.skipped).toBe(1);
    // Still pending for retry and not gated by a stamped cooldown.
    expect((await readRequests())[0]?.status).toBe('pending');
    expect(await readIssueCooldownKeys()).not.toContain('ABC-300');

    // Next tick must re-attempt the unconfirmed request rather than skip it.
    const second = await drain(injector);
    expect(calls).toBe(2);
    expect(second.skipped).toBe(1);
    expect((await readRequests())[0]?.status).toBe('pending');
  });
});
