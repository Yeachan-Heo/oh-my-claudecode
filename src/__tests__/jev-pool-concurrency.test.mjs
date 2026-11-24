/**
 * Concurrency and identity of the agent pool and of the session reservation (scripts/lib/jev-pool.mjs).
 * Many processes call the library at the same moment on one pool directory: the reservations, the commits at
 * SubagentStart, the releases at SubagentStop and PostToolUseFailure and the session reservations of the launcher
 * must each act on distinct entries and never admit more than the ceiling. The window between the read of the pool and
 * the write that follows it is widened (the listing of the pool directory waits a moment), so a read-modify-write
 * outside the pool lock fails these tests. The identity tests check which reservation a start or a stop takes.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { URL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commitAgent,
  countAlive,
  countOccupied,
  readPoolState,
  releaseAgent,
  releaseAgentByToolUseId,
  reserveAgent,
  reserveSession,
} from '../../scripts/lib/jev-pool.mjs';

const MODULE_URL = new URL('../../scripts/lib/jev-pool.mjs', import.meta.url).href;
const STATE_LOCK_URL = new URL('../../scripts/lib/state-lock.mjs', import.meta.url).href;
const LIMIT_40 = { OMC_JEV_POOL_MAX_AGENTS: '40' };
const LONG_BUDGET_MS = 60_000; // the hook budget does not apply to a test of many callers

const directories = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function tempDir(prefix = 'jev-pool-concurrency-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

function poolFiles(dir) {
  const folder = join(dir, 'pool-agents');
  return existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith('.json')) : [];
}

function poolRecords(dir) {
  return poolFiles(dir).map((name) => JSON.parse(readFileSync(join(dir, 'pool-agents', name), 'utf8')));
}

/**
 * Runs `body` (the source of an async function of `pool`, `dir` and `index`) in `count` child processes that start
 * together, and returns what each returned. The listing of the pool directories waits 20 ms in every child.
 */
async function inParallel(dir, count, body) {
  const children = [];
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const list = fs.readdirSync;
    fs.readdirSync = (path, ...rest) => {
      const names = list(path, ...rest);
      if (/pool-(agents|sessions)$/.test(String(path))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      return names;
    };
    syncBuiltinESMExports();
    const pool = await import(${JSON.stringify(MODULE_URL)});
    const dir = ${JSON.stringify(dir)};
    process.once('message', async ({ index }) => {
      const value = await (async () => { ${body} })();
      process.send({ value }, () => process.disconnect());
    });
    process.send('ready');
  `;
  try {
    const workers = Array.from({ length: count }, () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      children.push(child);
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      let value;
      const ready = new Promise((resolve, reject) => {
        child.on('message', (message) => {
          if (message === 'ready') resolve();
          else value = message.value;
        });
        child.on('error', reject);
        child.on('exit', (code) => { if (code !== 0) reject(new Error(stderr)); });
      });
      const done = new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve(value) : reject(new Error(stderr))));
      });
      return { child, ready, done };
    });
    await Promise.all(workers.map((worker) => worker.ready));
    workers.forEach((worker, index) => worker.child.send({ index }));
    return await Promise.all(workers.map((worker) => worker.done));
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
  }
}

function fill(dir, count, { commit = false, sessionId = 'session' } = {}) {
  for (let index = 0; index < count; index++) {
    expect(reserveAgent({ dir, sessionId, toolUseId: `call-${index}`, subagentType: 'helper', env: LIMIT_40 }).ok).toBe(true);
    if (commit) expect(commitAgent(dir, sessionId, Date.now(), { agentType: 'helper', agentId: `agent-${index}` })).toBe(true);
  }
}

describe('concurrent callers of the pool', () => {
  it('give the last free slot to exactly one of eight reservations', async () => {
    const dir = tempDir();
    fill(dir, 39);
    const results = await inParallel(dir, 8, `
      return pool.reserveAgent({ dir, sessionId: 'racer', toolUseId: 'race-' + index, env: { OMC_JEV_POOL_MAX_AGENTS: '40' }, lockBudgetMs: ${LONG_BUDGET_MS} });
    `);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(7);
    expect(countOccupied(dir)).toBe(40);
  }, 60_000);

  it('commit eight distinct pending reservations for eight concurrent SubagentStart hooks of one session', async () => {
    const dir = tempDir();
    fill(dir, 8);
    const results = await inParallel(dir, 8, `
      return pool.commitAgent(dir, 'session', Date.now(), { agentType: 'helper', agentId: 'agent-' + index, lockBudgetMs: ${LONG_BUDGET_MS} });
    `);
    expect(results.filter(Boolean)).toHaveLength(8);
    expect(countAlive(dir)).toBe(8);
    expect(poolRecords(dir).map((record) => record.agent_id).sort()).toEqual(Array.from({ length: 8 }, (_, index) => `agent-${index}`));
  }, 60_000);

  it.each(['pending', 'alive'])('release eight distinct %s slots for eight concurrent SubagentStop hooks at capacity 40', async (state) => {
    const dir = tempDir();
    fill(dir, 40, { commit: state === 'alive' });
    expect(countOccupied(dir)).toBe(40);
    expect(reserveAgent({ dir, sessionId: 'overflow', env: LIMIT_40 }).ok).toBe(false);
    const results = await inParallel(dir, 8, `return pool.releaseAgent(dir, 'session', Date.now(), { lockBudgetMs: ${LONG_BUDGET_MS} });`);
    expect(results.filter(Boolean)).toHaveLength(8);
    expect(poolFiles(dir)).toHaveLength(32);
    expect(countOccupied(dir)).toBe(32);
  }, 60_000);

  it('report one release for eight concurrent failures of the same tool call', async () => {
    const dir = tempDir();
    expect(reserveAgent({ dir, sessionId: 'session', toolUseId: 'same-call', env: LIMIT_40 }).ok).toBe(true);
    const results = await inParallel(dir, 8, `return pool.releaseAgentByToolUseId(dir, 'same-call', Date.now(), { lockBudgetMs: ${LONG_BUDGET_MS} });`);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(countOccupied(dir)).toBe(0);
  }, 60_000);

  it('admit one launch at a session ceiling of 1 for eight launchers that counted zero sessions', async () => {
    const dir = tempDir();
    const results = await inParallel(dir, 8, `return pool.reserveSession({ dir, counted: 0, limit: 1, lockBudgetMs: ${LONG_BUDGET_MS} });`);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok).every((result) => result.inFlight === 1)).toBe(true);
    // a ceiling of 3 with one running session leaves two launches
    const dir3 = tempDir();
    const results3 = await inParallel(dir3, 8, `return pool.reserveSession({ dir, counted: 1, limit: 3, lockBudgetMs: ${LONG_BUDGET_MS} });`);
    expect(results3.filter((result) => result.ok)).toHaveLength(2);
  }, 60_000);
});

describe('session reservation', () => {
  it('counts the launches in flight until they are released, and has no effect without a limit', () => {
    const dir = tempDir();
    expect(reserveSession({ dir, counted: 0, limit: 0 })).toEqual({ ok: true, file: null, inFlight: 0 });
    const first = reserveSession({ dir, counted: 0, limit: 2 });
    const second = reserveSession({ dir, counted: 0, limit: 2 });
    expect(first.ok && second.ok).toBe(true);
    expect(reserveSession({ dir, counted: 0, limit: 2 })).toMatchObject({ ok: false, inFlight: 2 });
    rmSync(join(dir, 'pool-sessions', first.file));
    expect(reserveSession({ dir, counted: 0, limit: 2 }).ok).toBe(true);
    // a launch that died leaves a reservation that expires after 5 minutes
    const later = Date.now() + 6 * 60_000;
    expect(reserveSession({ dir, counted: 0, limit: 2, now: later })).toMatchObject({ ok: true, inFlight: 0 });
  });
});

describe('session reservation lifetime', () => {
  it('lasts as long as a launch can: two starts of 120 s plus the Jev query, so a longer OMC_JEV_TIMEOUT_MS keeps the reservation counted', () => {
    const dir = tempDir();
    const env = { OMC_JEV_TIMEOUT_MS: '120000' };
    expect(reserveSession({ dir, counted: 0, limit: 1, env }).ok).toBe(true);
    const aged = Date.now() + 6 * 60_000; // beyond the 5 minutes of a default launch, within 2 * 120 s + 120 s
    expect(reserveSession({ dir, counted: 0, limit: 1, env, now: aged })).toMatchObject({ ok: false, inFlight: 1 });
    expect(reserveSession({ dir, counted: 0, limit: 1, env, now: Date.now() + 2 * 120_000 + 120_000 + 60_000 })).toMatchObject({ ok: true, inFlight: 0 });
  });
});

describe('which reservation a start and a stop take', () => {
  it('commits the reservation of the type that started, and the start of the other type finds its own', () => {
    const dir = tempDir();
    const now = Date.now();
    reserveAgent({ dir, sessionId: 'session', toolUseId: 'call-a', subagentType: 'oh-my-claudecode:executor', now, env: {} });
    reserveAgent({ dir, sessionId: 'session', toolUseId: 'call-b', subagentType: 'oh-my-claudecode:planner', now: now + 1, env: {} });
    // B starts first: it takes the reservation of its own call, not the oldest and not the newest by chance
    expect(commitAgent(dir, 'session', now + 2, { agentType: 'oh-my-claudecode:planner', agentId: 'agent-b' })).toBe(true);
    const byCall = () => Object.fromEntries(poolRecords(dir).map((record) => [record.tool_use_id, record]));
    expect(byCall()['call-b']).toMatchObject({ state: 'alive', agent_id: 'agent-b' });
    expect(byCall()['call-a']).toMatchObject({ state: 'pending' });
    // B's call then fails: only B's reservation goes, A's pending one stays and the pool still counts A
    expect(releaseAgentByToolUseId(dir, 'call-b', now + 3)).toBe(true);
    expect(countOccupied(dir, now + 3)).toBe(1);
    expect(commitAgent(dir, 'session', now + 4, { agentType: 'executor', agentId: 'agent-a' })).toBe(true); // namespace and case do not count
    expect(byCall()['call-a']).toMatchObject({ state: 'alive', agent_id: 'agent-a' });
  });

  it('tells two calls of one type apart by the name or description the start carries back', () => {
    const dir = tempDir();
    const now = Date.now();
    reserveAgent({ dir, sessionId: 'session', toolUseId: 'call-1', subagentType: 'helper', label: 'check the risks', now, env: {} });
    reserveAgent({ dir, sessionId: 'session', toolUseId: 'call-2', subagentType: 'helper', label: 'write the summary', now: now + 1, env: {} });
    // the second call starts first: it takes its own reservation, then the first call takes the one that is left
    expect(commitAgent(dir, 'session', now + 2, { agentType: 'helper', agentId: 'agent-2', label: 'write the summary' })).toBe(true);
    const byCall = () => Object.fromEntries(poolRecords(dir).map((record) => [record.tool_use_id, record]));
    expect(byCall()['call-2']).toMatchObject({ state: 'alive', agent_id: 'agent-2' });
    expect(byCall()['call-1']).toMatchObject({ state: 'pending' });
    // the second call fails after its start: the reservation of the first stays pending and keeps its slot
    expect(releaseAgentByToolUseId(dir, 'call-2', now + 3)).toBe(true);
    expect(byCall()['call-1']).toMatchObject({ state: 'pending' });
    expect(commitAgent(dir, 'session', now + 4, { agentType: 'helper', agentId: 'agent-1', label: 'check the risks' })).toBe(true);
    expect(byCall()['call-1']).toMatchObject({ state: 'alive', agent_id: 'agent-1' });
    // a label nobody reserved falls back to the type
    reserveAgent({ dir, sessionId: 'session', toolUseId: 'call-3', subagentType: 'helper', label: 'x', now: now + 5, env: {} });
    expect(commitAgent(dir, 'session', now + 6, { agentType: 'helper', agentId: 'agent-3', label: 'another label' })).toBe(true);
    expect(byCall()['call-3']).toMatchObject({ state: 'alive', agent_id: 'agent-3' });
  });

  it('commits the oldest pending reservation when the type is unknown or twice reserved, and only of the same session', () => {
    const dir = tempDir();
    const now = Date.now();
    reserveAgent({ dir, sessionId: 'other', toolUseId: 'call-o', subagentType: 'helper', now, env: {} });
    reserveAgent({ dir, sessionId: 'session', toolUseId: 'call-1', subagentType: 'helper', now: now + 1, env: {} });
    reserveAgent({ dir, sessionId: 'session', toolUseId: 'call-2', subagentType: 'helper', now: now + 2, env: {} });
    expect(commitAgent(dir, 'session', now + 3, { agentType: 'helper', agentId: 'agent-1' })).toBe(true);
    const state = readPoolState(dir, now + 3);
    expect(state.alive.map((entry) => entry.toolUseId)).toEqual(['call-1']);
    expect(commitAgent(dir, 'session', now + 4, { agentType: 'not-reserved' })).toBe(true); // no type match: the oldest pending one
    expect(readPoolState(dir, now + 4).pending.map((entry) => entry.toolUseId)).toEqual(['call-o']);
    expect(commitAgent(dir, 'session', now + 5)).toBe(false); // none left in this session
  });

  it('releases the alive reservation of the stopped agent, then one without an agent id, then the oldest', () => {
    const dir = tempDir();
    const now = Date.now();
    fill(dir, 3);
    commitAgent(dir, 'session', now + 1, { agentType: 'helper', agentId: 'agent-1' });
    commitAgent(dir, 'session', now + 2, { agentType: 'helper' }); // a start recorded without an agent id
    commitAgent(dir, 'session', now + 3, { agentType: 'helper', agentId: 'agent-3' });
    // the stop of agent-3 releases its own reservation, though two older ones are alive
    expect(releaseAgent(dir, 'session', now + 4, { agentId: 'agent-3' })).toBe(true);
    expect(poolRecords(dir).map((record) => record.agent_id ?? null).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(['agent-1', null]);
    // a stop that carries an id nobody recorded takes the reservation that has none
    expect(releaseAgent(dir, 'session', now + 5, { agentId: 'agent-x' })).toBe(true);
    expect(poolRecords(dir).map((record) => record.agent_id)).toEqual(['agent-1']);
    // a stop without an id takes the oldest alive one
    expect(releaseAgent(dir, 'session', now + 6)).toBe(true);
    expect(poolFiles(dir)).toHaveLength(0);
    expect(releaseAgent(dir, 'session', now + 7)).toBe(false);
  });
});

describe('a stop whose own start was not committed', () => {
  it('releases the pending reservation of the session and never the alive one of another agent', () => {
    const dir = tempDir();
    const now = Date.now();
    reserveAgent({ dir, sessionId: 'session', toolUseId: 'call-1', subagentType: 'helper', now, env: {} });
    reserveAgent({ dir, sessionId: 'session', toolUseId: 'call-2', subagentType: 'helper', now: now + 1, env: {} });
    expect(commitAgent(dir, 'session', now + 2, { agentType: 'helper', agentId: 'agent-1' })).toBe(true); // agent-2's start missed the lock budget
    // the stop of agent-2 finds no alive reservation of its own: its pending one goes, agent-1 keeps its slot
    expect(releaseAgent(dir, 'session', now + 3, { agentId: 'agent-2' })).toBe(true);
    expect(poolRecords(dir)).toMatchObject([{ state: 'alive', agent_id: 'agent-1' }]);
    // with nothing pending and no unrecorded alive one, the stop of an unknown agent releases nothing
    expect(releaseAgent(dir, 'session', now + 4, { agentId: 'agent-3' })).toBe(false);
    expect(poolRecords(dir)).toHaveLength(1);
    // a stop without an agent id still takes the oldest alive reservation
    expect(releaseAgent(dir, 'session', now + 5)).toBe(true);
    expect(poolFiles(dir)).toHaveLength(0);
  });
});

describe('a pool lock that is not obtained', () => {
  /** A child process that holds the pool lock of `dir` for `holdMs`; resolves once the lock is held. */
  async function holdLock(dir, holdMs) {
    const marker = join(dir, 'held');
    const script = `
      import { writeFileSync } from 'node:fs';
      import { withStateFileLockAtPathSync } from ${JSON.stringify(STATE_LOCK_URL)};
      withStateFileLockAtPathSync(${JSON.stringify(join(dir, '.pool.lock'))}, () => {
        writeFileSync(${JSON.stringify(marker)}, 'held');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});
      }, true);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    for (let waited = 0; !existsSync(marker) && waited < 10_000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(marker)).toBe(true);
    return { child, exited };
  }

  it('is a state failure and never a capacity refusal: reserve fails open, commit and release report nothing done, within the budget', async () => {
    const dir = tempDir();
    fill(dir, 40);
    const before = poolFiles(dir).sort();
    const holder = await holdLock(dir, 30_000);
    try {
      const timed = (call) => {
        const started = Date.now();
        const result = call();
        return { result, ms: Date.now() - started };
      };
      // the pool is full (40 of 40), but nobody could read it under the lock: this is not a refusal at 40/40
      const reserve = timed(() => reserveAgent({ dir, sessionId: 'session', toolUseId: 'late', env: LIMIT_40 }));
      expect(reserve.result).toMatchObject({ ok: true, file: null, untracked: true });
      expect(timed(() => commitAgent(dir, 'session', Date.now(), { agentType: 'helper', agentId: 'agent-late' })).result).toBe(false);
      expect(timed(() => releaseAgent(dir, 'session', Date.now(), { agentId: 'agent-late' })).result).toBe(false);
      expect(timed(() => releaseAgentByToolUseId(dir, 'call-0')).result).toBe(false);
      const session = timed(() => reserveSession({ dir, counted: 5, limit: 1 }));
      expect(session.result).toMatchObject({ ok: true, file: null });
      // each wait ends at the 0.7 s budget, with room for a loaded machine; none runs on towards the 3 s hook timeout
      expect(Math.max(reserve.ms, session.ms)).toBeLessThan(2500);
      expect(poolFiles(dir).sort()).toEqual(before);
    } finally {
      holder.child.kill();
      await holder.exited;
    }
    // with the lock free again the same calls act normally: at 40 of 40 the reservation is refused
    expect(reserveAgent({ dir, sessionId: 'session', toolUseId: 'late', env: LIMIT_40 }).ok).toBe(false);
  }, 30_000);
});
