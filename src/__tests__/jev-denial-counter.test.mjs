/**
 * Opt-in denial counter (OMC_JEV_DENIAL_COUNTER=1): the library scripts/lib/jev-denial-counter.mjs and
 * its wiring into the PreToolUse refusals of scripts/pre-tool-enforcer.mjs (agent pool deny as the source).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  denialK,
  denialKey,
  denialMarker,
  denialSessionMax,
  denialWindowMs,
  keyHash,
  registerDenial,
  writeDenialRow,
} from '../../scripts/lib/jev-denial-counter.mjs';
import { refusalText, reserveAgent } from '../../scripts/lib/jev-pool.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLEANUPS = [];
const T0 = 1_000_000;
const MIN_WINDOW_MS = 120_000;

afterAll(() => {
  for (const path of CLEANUPS.splice(0)) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A temp directory still held by the OS is left for the OS.
    }
  }
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'denial-counter-'));
  CLEANUPS.push(dir);
  return dir;
}

function setup(extraEnv = {}) {
  const root = tempDir();
  const logDir = join(root, 'jev');
  return { stateDir: join(root, 'state'), logDir, env: { OMC_JEV_LOG_DIR: logDir, ...extraEnv } };
}

function deny(ctx, now, { pkg = `msg-${now}`, guard = 'agent-pool', reason = 'pool is full', sessionId = 's1', agentId = '', env } = {}) {
  return registerDenial({
    stateDir: ctx.stateDir,
    sessionId,
    agentId,
    guard,
    reason,
    call: { packageKey: pkg, toolName: 'Agent', toolUseId: `tu-${now}` },
    env: env ?? ctx.env,
    now,
  });
}

function journal(logDir) {
  const path = join(logDir, 'denials.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function stateFile(stateDir, sessionId = 's1', file = 'denials-main.json') {
  return join(stateDir, 'sessions', sessionId, file);
}

describe('denial counter: tunables and keys', () => {
  it('keeps the default for values that are not positive integers', () => {
    expect(denialK({})).toBe(3);
    expect(denialK({ OMC_JEV_DENIAL_K: '5' })).toBe(5);
    expect(denialK({ OMC_JEV_DENIAL_K: '0' })).toBe(3);
    expect(denialK({ OMC_JEV_DENIAL_K: 'many' })).toBe(3);
    expect(denialWindowMs({ OMC_JEV_DENIAL_WINDOW_S: '30' })).toBe(30_000);
    expect(denialWindowMs({})).toBe(MIN_WINDOW_MS);
    expect(denialSessionMax({ OMC_JEV_DENIAL_SESSION_MAX: '-2' })).toBe(20);
  });

  it('normalizes UUIDs, times and temp paths out of the key', () => {
    const a = denialKey('g', 'id 123e4567-e89b-12d3-a456-426614174000 at 2026-11-15T10:00:00Z in /tmp/x.txt');
    const b = denialKey('g', 'id 00000000-0000-4000-8000-000000000000 at 2026-11-16T11:22:33Z in /temp/y.txt');
    expect(a).toBe(b);
    expect(denialKey('g', 'a')).not.toBe(denialKey('h', 'a'));
  });

  it('writes the marker with the 16-hex hash of the key and #0 when the number is unknown', () => {
    const key = denialKey('g', 'reason');
    expect(keyHash(key)).toMatch(/^[0-9a-f]{16}$/);
    expect(denialMarker(key, 2)).toBe(`[denial ${keyHash(key)} #2]`);
    expect(denialMarker(key, null)).toBe(`[denial ${keyHash(key)} #0]`);
  });
});

describe('denial counter: escalation and windows', () => {
  it('reminds at k, blocks at k+2, and resets the windowed count after the window', () => {
    const ctx = setup();
    const r1 = deny(ctx, T0);
    expect(r1).toMatchObject({ n: 1, degree: 0, release: false, state: 'ok', text: '' });
    expect(deny(ctx, T0 + 1_000).n).toBe(2);
    const r3 = deny(ctx, T0 + 2_000);
    expect(r3).toMatchObject({ n: 3, degree: 1, action: 'escalation-1' });
    expect(r3.text).toContain('[DENIAL COUNTER] The same denial of guard agent-pool has come 3 times');
    const r4 = deny(ctx, T0 + 3_000);
    expect(r4).toMatchObject({ n: 4, degree: 1, action: null, text: expect.stringContaining('[DENIAL COUNTER]') });
    const r5 = deny(ctx, T0 + 4_000);
    expect(r5).toMatchObject({ n: 5, degree: 2, action: 'escalation-2' });
    expect(r5.text).toContain('[DENIAL COUNTER: BLOCK]');
    const after = deny(ctx, T0 + 4_000 + MIN_WINDOW_MS + 1_000);
    expect(after).toMatchObject({ n: 1, degree: 0, text: '' });
  });

  it('counts one attempt per model response: the same package moves no counter', () => {
    const ctx = setup();
    expect(deny(ctx, T0, { pkg: 'msg-A' }).n).toBe(1);
    expect(deny(ctx, T0 + 100, { pkg: 'msg-A' })).toMatchObject({ n: 1, sessionCount: 1 });
    expect(deny(ctx, T0 + 200, { pkg: 'msg-A' })).toMatchObject({ n: 1, sessionCount: 1 });
    expect(deny(ctx, T0 + 300, { pkg: 'msg-B' })).toMatchObject({ n: 2, sessionCount: 2 });
  });

  it('without a package key, same-key denials less than 2 s apart form one package', () => {
    const ctx = setup();
    expect(deny(ctx, T0, { pkg: null }).n).toBe(1);
    expect(deny(ctx, T0 + 1_500, { pkg: null }).n).toBe(1);
    expect(deny(ctx, T0 + 6_500, { pkg: null }).n).toBe(2);
  });

  it('starts a missing state file fresh at n=1 without an escalation', () => {
    const ctx = setup();
    expect(existsSync(stateFile(ctx.stateDir))).toBe(false);
    expect(deny(ctx, T0)).toMatchObject({ n: 1, state: 'ok', degree: 0 });
  });
});

describe('denial counter: broken state', () => {
  it('treats an unreadable (truncated JSON) state as a crossed threshold for one call, then restarts', () => {
    const ctx = setup();
    mkdirSync(join(ctx.stateDir, 'sessions', 's1'), { recursive: true });
    writeFileSync(stateFile(ctx.stateDir), '{"version":1,"keys":{');
    const broken = deny(ctx, T0);
    expect(broken).toMatchObject({ n: null, degree: 2, release: false, action: 'state-broken', state: 'broken' });
    expect(broken.text).toContain('Counter state unreadable (broken); the threshold is treated as crossed.');
    expect(deny(ctx, T0 + 1_000, { pkg: 'msg-next' })).toMatchObject({ n: 2, state: 'ok' });
  });

  it('treats a state of the wrong shape as nan', () => {
    const ctx = setup();
    mkdirSync(join(ctx.stateDir, 'sessions', 's1'), { recursive: true });
    writeFileSync(stateFile(ctx.stateDir), JSON.stringify({ version: 1, keys: [], sessionCounts: {} }));
    expect(deny(ctx, T0)).toMatchObject({ n: null, degree: 2, state: 'nan', action: 'state-nan' });
  });

  it('treats a non-number windowed count inside a valid file as nan and restarts the entry', () => {
    const ctx = setup();
    const key = denialKey('agent-pool', 'pool is full');
    deny(ctx, T0);
    const path = stateFile(ctx.stateDir);
    const state = JSON.parse(readFileSync(path, 'utf8'));
    state.keys[keyHash(key)].n = 'x';
    writeFileSync(path, JSON.stringify(state));
    expect(deny(ctx, T0 + 1_000, { pkg: 'msg-x' })).toMatchObject({ n: null, degree: 2, state: 'nan' });
  });
});

describe('denial counter: session ceiling and release', () => {
  it('never resets the per-guard session count and hardens the text at the ceiling', () => {
    const ctx = setup({ OMC_JEV_DENIAL_SESSION_MAX: '3' });
    deny(ctx, T0, { reason: 'a' });
    deny(ctx, T0 + 1_000, { reason: 'b' });
    const third = deny(ctx, T0 + 2_000, { reason: 'c' });
    expect(third).toMatchObject({ sessionCount: 3, degree: 2, action: 'deny-storm', release: false });
    expect(third.text).toContain('[DENIAL COUNTER: SESSION CEILING] Guard agent-pool has denied 3 times');
  });

  it('releases only the /goal guard in a main session with OMC_JEV_DENIAL_RELEASE=1', () => {
    const ctx = setup({ OMC_JEV_DENIAL_SESSION_MAX: '2', OMC_JEV_DENIAL_RELEASE: '1' });
    const goal = { guard: 'ultragoal-goal', sessionId: 'rel-1' };
    expect(deny(ctx, T0, { ...goal, reason: 'a' }).release).toBe(false);
    const released = deny(ctx, T0 + 1_000, { ...goal, reason: 'b' });
    expect(released).toMatchObject({ release: true, action: 'release', degree: 0, text: '' });
    expect(deny(ctx, T0 + 2_000, { ...goal, reason: 'c', pkg: 'msg-c' })).toMatchObject({ release: true });
    expect(journal(ctx.logDir).some((row) => row.kind === 'release' && row.result === 'passed')).toBe(true);
  });

  it('never releases the missing-goal guard, a subagent, or any guard without the release switch', () => {
    const ctx = setup({ OMC_JEV_DENIAL_SESSION_MAX: '2', OMC_JEV_DENIAL_RELEASE: '1' });
    for (const [i, extra] of [
      [0, { guard: 'ultragoal-goal-missing', sessionId: 'rel-2' }],
      [1, { guard: 'ultragoal-goal', agentId: 'sub-1', sessionId: 'rel-3' }],
      [2, { guard: 'agent-pool', sessionId: 'rel-4' }],
    ]) {
      deny(ctx, T0 + i * 10_000, { ...extra, reason: 'a' });
      const second = deny(ctx, T0 + i * 10_000 + 1_000, { ...extra, reason: 'b', pkg: `msg-${i}` });
      expect(second.release).toBe(false);
      expect(second.action).toBe('deny-storm');
    }
    const off = setup({ OMC_JEV_DENIAL_SESSION_MAX: '2' });
    deny(off, T0, { guard: 'ultragoal-goal', reason: 'a' });
    expect(deny(off, T0 + 1_000, { guard: 'ultragoal-goal', reason: 'b', pkg: 'msg-off' }).release).toBe(false);
  });
});

describe('denial counter: state and journal', () => {
  it('keeps hashes in the state file, never the denial text', () => {
    const ctx = setup();
    deny(ctx, T0, { reason: 'secret-token-abc123 in the command text' });
    const raw = readFileSync(stateFile(ctx.stateDir), 'utf8');
    expect(raw).not.toContain('secret-token');
    expect(raw).toContain(keyHash(denialKey('agent-pool', 'secret-token-abc123 in the command text')));
  });

  it('keeps at most 64 entries per state map', () => {
    const ctx = setup({ OMC_JEV_DENIAL_SESSION_MAX: '1000' });
    for (let i = 0; i < 70; i++) deny(ctx, T0 + i * 200_000, { reason: `distinct ${i}` });
    const state = JSON.parse(readFileSync(stateFile(ctx.stateDir), 'utf8'));
    expect(Object.keys(state.keys).length).toBe(64);
    expect(Object.keys(state.actions).length).toBeLessThanOrEqual(64);
  });

  it('writes a decision row and an outcome row that references it', () => {
    const ctx = setup();
    deny(ctx, T0, { pkg: 'msg-1' });
    deny(ctx, T0 + 1_000, { pkg: 'msg-2' });
    deny(ctx, T0 + 2_000, { pkg: 'msg-3' });
    const rows = journal(ctx.logDir);
    const decision = rows.find((row) => row.kind === 'denial' && row.action === 'escalation-1');
    expect(decision).toMatchObject({ guard: 'agent-pool', n: 3, degree: 1, result: 'denied', point: 'denial', key: keyHash(denialKey('agent-pool', 'pool is full')) });
    expect(rows.find((row) => row.kind === 'outcome' && row.ref === decision.id)).toBeTruthy();
  });

  it('shortens a row that would exceed 2000 characters and flags it', () => {
    const ctx = setup();
    const id = writeDenialRow({ kind: 'denial', huge: 'y'.repeat(3_000) }, ctx.logDir);
    const [row] = journal(ctx.logDir);
    expect(id).toBe(row.id);
    expect(row.truncated).toBe(true);
    expect(JSON.stringify(row).length).toBeLessThanOrEqual(2000);
  });

  it('rotates denials.jsonl past 1.5 MB before the next row', () => {
    const ctx = setup();
    mkdirSync(ctx.logDir, { recursive: true });
    const path = join(ctx.logDir, 'denials.jsonl');
    writeFileSync(path, 'x'.repeat(1_600_000) + '\n');
    writeDenialRow({ kind: 'denial', guard: 'agent-pool' }, ctx.logDir);
    expect(statSync(path).size).toBeLessThan(1_000);
    expect(readdirSync(ctx.logDir).some((name) => /^denials-.*\.jsonl$/.test(name))).toBe(true);
  });
});

describe('denial counter: switch off in the hook', () => {
  it('keeps the agent pool refusal text unchanged and writes no counter files', () => {
    for (const value of [undefined, '0', 'true']) {
      const run = runPoolDeny({ OMC_JEV_DENIAL_COUNTER: value }, `off-${value ?? 'unset'}`);
      expect(run.permissionDecision).toBe('deny');
      expect(run.reason).toBe(`[AGENT POOL] ${refusalText(1, 1)}`);
      expect(listRecursive(run.home).some((name) => name.includes('denials-'))).toBe(false);
      expect(existsSync(join(run.logDir, 'denials.jsonl'))).toBe(false);
    }
  });
});

describe('denial counter: switch on in the hook', () => {
  it('appends the marker, which joins the journal row, and escalates at the third distinct response', () => {
    const sid = 'hook-escalate';
    const { logDir, reasons } = runPoolSequence({ OMC_JEV_DENIAL_COUNTER: '1' }, sid, 3);
    const poolReason = `[AGENT POOL] ${refusalText(1, 1)}`;
    const hash = keyHash(denialKey('agent-pool', poolReason));
    expect(reasons[0]).toContain(`[denial ${hash} #1]`);
    expect(reasons[0]).not.toContain('[DENIAL COUNTER]');
    expect(reasons[2]).toContain(`[denial ${hash} #3]`);
    expect(reasons[2]).toContain('[DENIAL COUNTER] The same denial of guard agent-pool has come 3 times');
    expect(journal(logDir).some((row) => row.action === 'escalation-1' && row.key === hash)).toBe(true);
  });

  it('adds the three common sentences only with OMC_JEV_DENIAL_TEXTS=1', () => {
    const plain = runPoolSequence({ OMC_JEV_DENIAL_COUNTER: '1' }, 'hook-texts-off', 3).reasons[2];
    expect(plain).not.toContain('Action NOT performed');
    expect(plain).not.toContain('Do not repeat the same call: do independent work or change the plan.');
    const texts = runPoolSequence({ OMC_JEV_DENIAL_COUNTER: '1', OMC_JEV_DENIAL_TEXTS: '1' }, 'hook-texts-on', 1).reasons[0];
    expect(texts).toContain('Action NOT performed: do not write that it succeeded.');
    expect(texts).toContain('Do not repeat the same call: do independent work or change the plan.');
    expect(texts).toContain('Use the existing result and change the plan.');
  });
});

describe('denial counter: /goal guard in the hook', () => {
  const GOAL = 'cel testowy pozycji T2.2 hook';
  const GOAL_DENIAL = `[ULTRAGOAL /GOAL REQUIRED] Active ultragoal state requires the matching Claude /goal before tools run; no active Claude /goal snapshot was visible to the hook.`;

  /** One Read call under an active ultragoal state with no visible /goal: the missing-goal denial. */
  function runGoalDeny(extraEnv, sid, i) {
    const root = tempDir();
    const home = join(root, 'home');
    const cwd = join(root, 'proj');
    mkdirSync(cwd, { recursive: true });
    const sessions = join(home, '.omc', 'state', 'sessions', sid);
    mkdirSync(sessions, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(join(sessions, 'ultragoal-state.json'), JSON.stringify({ wersja: 1, active: true, session_id: sid, project_path: cwd, claude_goal_objective: GOAL, started_at: now, updated_at: now }));
    const transcript = join(root, `transcript-${i}.jsonl`);
    writeFileSync(transcript, `{"type":"assistant","message":{"id":"goal-msg-${i}","content":[]}}\n`);
    return runHook(home, cwd, { ...extraEnv, OMC_JEV_LOG_DIR: join(root, 'jev') }, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: join(cwd, 'a.txt') },
      session_id: sid,
      tool_use_id: `goal-tool-${i}`,
      transcript_path: transcript,
      cwd,
    });
  }

  it('switch off: the /goal refusal text is unchanged (no marker, no counter files)', () => {
    const run = runGoalDeny({}, 'goal-off', 1);
    expect(run.permissionDecision).toBe('deny');
    expect(run.reason).toBe(`${GOAL_DENIAL} Activate /goal with the ultragoal objective, or set ALLOW_ULTRAGOAL_WITHOUT_GOAL=1 to bypass this guard intentionally. Expected objective: ${GOAL}`);
  });

  it('counter on, texts off: the marker and the common sentences stay off; the /goal text keeps the activate sentence', () => {
    const run = runGoalDeny({ OMC_JEV_DENIAL_COUNTER: '1' }, 'goal-counter', 1);
    expect(run.reason).toContain('Activate /goal with the ultragoal objective');
    expect(run.reason).toMatch(/\[denial [0-9a-f]{16} #1\]/);
    expect(run.reason).not.toContain('Action NOT performed');
    expect(run.reason).not.toContain('End this step');
  });

  it('texts on: the /goal refusal ends with the BLOCKED line and the three common sentences', () => {
    const run = runGoalDeny({ OMC_JEV_DENIAL_COUNTER: '1', OMC_JEV_DENIAL_TEXTS: '1' }, 'goal-texts', 1);
    expect(run.reason).not.toContain('Activate /goal');
    expect(run.reason).toContain('End this step without the call: end your turn with a line `BLOCKED: <reason, at least 20 characters>`.');
    expect(run.reason).toContain('Action NOT performed: do not write that it succeeded.');
    expect(run.reason).toContain('Use the existing result and change the plan.');
  });
});

// --- hook helpers -------------------------------------------------------------------------------

function listRecursive(dir) {
  try {
    return readdirSync(dir, { recursive: true }).map(String);
  } catch {
    return [];
  }
}

function runHook(home, cwd, env, input) {
  const hookEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    OMC_JEV_QUIET: '1',
    OMC_JEV_POOL: '1',
    OMC_JEV_POOL_MAX_AGENTS: '1',
    ...env,
  };
  for (const name of ['OMC_JEV_DENIAL_COUNTER', 'OMC_JEV_DENIAL_TEXTS', 'OMC_JEV_DENIAL_RELEASE']) {
    if (env[name] === undefined) delete hookEnv[name];
  }
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'pre-tool-enforcer.mjs')], {
    cwd,
    input: JSON.stringify(input),
    env: hookEnv,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const out = JSON.parse(String(result.stdout || '{}'));
  return {
    status: result.status,
    permissionDecision: out.hookSpecificOutput?.permissionDecision,
    reason: out.hookSpecificOutput?.permissionDecisionReason ?? '',
  };
}

/** One Agent call against a full pool (limit 1, one reserved slot), with a fresh session and its own transcript. */
function runPoolDeny(extraEnv, sid) {
  const root = tempDir();
  const home = join(root, 'home');
  const cwd = join(root, 'proj');
  const logDir = join(root, 'jev');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  reserveAgent({ dir: logDir, sessionId: 'other-session', now: Date.now(), env: {} });
  const transcript = join(root, 'transcript.jsonl');
  writeFileSync(transcript, '{"type":"assistant","message":{"id":"msg-only","content":[]}}\n');
  const run = runHook(home, cwd, { ...extraEnv, OMC_JEV_LOG_DIR: logDir }, {
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'executor', prompt: 'x' },
    session_id: sid,
    tool_use_id: 'tool-1',
    transcript_path: transcript,
    cwd,
  });
  return { ...run, home, logDir };
}

/** Several Agent calls of one session, each in its own model response (its own transcript message id). */
function runPoolSequence(extraEnv, sid, count) {
  const root = tempDir();
  const home = join(root, 'home');
  const cwd = join(root, 'proj');
  const logDir = join(root, 'jev');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  reserveAgent({ dir: logDir, sessionId: 'other-session', now: Date.now(), env: {} });
  const reasons = [];
  for (let i = 1; i <= count; i++) {
    const transcript = join(root, `transcript-${i}.jsonl`);
    writeFileSync(transcript, `{"type":"assistant","message":{"id":"msg-${i}","content":[]}}\n`);
    const run = runHook(home, cwd, { ...extraEnv, OMC_JEV_LOG_DIR: logDir }, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'executor', prompt: 'x' },
      session_id: sid,
      tool_use_id: `tool-${i}`,
      transcript_path: transcript,
      cwd,
    });
    reasons.push(run.reason);
  }
  return { logDir, reasons, home };
}
