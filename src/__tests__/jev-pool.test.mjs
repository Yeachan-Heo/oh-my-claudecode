/**
 * Opt-in agent pool (OMC_JEV_POOL=1): the library scripts/lib/jev-pool.mjs, the PreToolUse refusal
 * of Agent and Task calls in scripts/pre-tool-enforcer.mjs, and the SubagentStart, SubagentStop and
 * PostToolUseFailure hook scripts that commit or release the reservations.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  agentLimit,
  commitAgent,
  countAlive,
  countOccupied,
  countSessions,
  refusalText,
  releaseAgent,
  releaseAgentByToolUseId,
  reserveAgent,
  sessionLimit,
} from '../../scripts/lib/jev-pool.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLEANUPS = [];
const LIMIT_40 = { OMC_JEV_POOL_MAX_AGENTS: '40' };
const TTL_PENDING_MS = 2 * 60_000;
const TTL_ALIVE_MS = 24 * 3_600_000;

afterAll(() => {
  for (const path of CLEANUPS.splice(0)) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A temp directory still held by the OS is left for the OS.
    }
  }
});

function makeDir(prefix = 'jev-pool-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  CLEANUPS.push(dir);
  return dir;
}

function poolFiles(dir) {
  const folder = join(dir, 'pool-agents');
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((name) => name.endsWith('.json'));
}

function rows(dir, name = 'pool.jsonl') {
  const path = join(dir, name);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function reserveAlive(dir, sessionId, now, toolUseId) {
  expect(reserveAgent({ dir, sessionId, toolUseId, now, env: {} }).ok).toBe(true);
  expect(commitAgent(dir, sessionId, now + 1)).toBe(true);
}

describe('agent pool limits', () => {
  it('defaults to no limit (0) and reads the two variables; a value that is not an integer keeps the default', () => {
    expect(agentLimit({})).toBe(0);
    expect(sessionLimit({})).toBe(0);
    expect(agentLimit({ OMC_JEV_POOL_MAX_AGENTS: '40' })).toBe(40);
    expect(sessionLimit({ OMC_JEV_POOL_MAX_SESSIONS: '12' })).toBe(12);
    expect(agentLimit({ OMC_JEV_POOL_MAX_AGENTS: 'many' })).toBe(0);
    expect(agentLimit({ OMC_JEV_POOL_MAX_AGENTS: '-1' })).toBe(0);
    expect(sessionLimit({ OMC_JEV_POOL_MAX_SESSIONS: '1.5' })).toBe(0);
  });

  it('keeps the pool without a limit: 45 reservations pass when no limit is set', () => {
    const dir = makeDir();
    for (let i = 0; i < 45; i++) {
      expect(reserveAgent({ dir, sessionId: `s-${i}`, now: 1_000 + i, env: {} }).ok).toBe(true);
    }
    expect(countOccupied(dir, 1_100)).toBe(45);
  });
});

describe('reservation, commit and release (reserveSubagentSpawn pattern)', () => {
  it('a reservation takes its slot at once (pending and alive together), commit makes it alive, release is FIFO and pending is the fallback', () => {
    const dir = makeDir();
    expect(countAlive(dir)).toBe(0);
    expect(countOccupied(dir)).toBe(0);
    const r = reserveAgent({ dir, sessionId: 's1', toolUseId: 't1', subagentType: 'mechanik', now: 1_000_000, env: {} });
    expect(r.ok).toBe(true);
    expect(countOccupied(dir, 1_000_001)).toBe(1);
    expect(countAlive(dir, 1_000_001)).toBe(0);
    expect(commitAgent(dir, 's1', 1_000_002)).toBe(true);
    expect(countAlive(dir, 1_000_003)).toBe(1);
    expect(countOccupied(dir, 1_000_003)).toBe(1);
    reserveAgent({ dir, sessionId: 's1', now: 1_000_004, env: {} });
    expect(releaseAgent(dir, 's1', 1_000_005)).toBe(true);
    expect(countAlive(dir, 1_000_006)).toBe(0);
    expect(countOccupied(dir, 1_000_006)).toBe(1);
    expect(releaseAgent(dir, 's1', 1_000_007)).toBe(true);
    expect(countOccupied(dir, 1_000_008)).toBe(0);
    expect(releaseAgent(dir, 's1', 1_000_009)).toBe(false);
    expect(commitAgent(dir, '')).toBe(false);
    expect(releaseAgent(dir, '')).toBe(false);
  });

  it('10 failed starts leave no leaked slots (release and TTL)', () => {
    const dir = makeDir();
    for (let i = 0; i < 10; i++) {
      expect(reserveAgent({ dir, sessionId: `s-${i}`, now: 2_000_000 + i, env: {} }).ok).toBe(true);
      expect(releaseAgent(dir, `s-${i}`, 2_000_000 + i + 1)).toBe(true);
    }
    expect(countOccupied(dir, 2_000_100)).toBe(0);
    for (let i = 0; i < 10; i++) {
      expect(reserveAgent({ dir, sessionId: `st-${i}`, toolUseId: `tu-${i}`, now: 3_000_000 + i, env: {} }).ok).toBe(true);
      expect(releaseAgentByToolUseId(dir, `tu-${i}`, 3_000_000 + i + 1)).toBe(true);
    }
    expect(countOccupied(dir, 3_000_011)).toBe(0);
    for (let i = 0; i < 10; i++) {
      expect(reserveAgent({ dir, sessionId: `tt-${i}`, now: 4_000_000 + i, env: {} }).ok).toBe(true);
    }
    expect(countOccupied(dir, 4_000_010 + TTL_PENDING_MS + 1)).toBe(0);
  });

  it('TTL: a pending reservation expires after 2 minutes, an alive one after 24 hours; a corrupt file is not counted', () => {
    const dir = makeDir();
    reserveAgent({ dir, sessionId: 'sp', now: 3_000_000, env: {} });
    reserveAgent({ dir, sessionId: 'sz', now: 3_000_001, env: {} });
    commitAgent(dir, 'sz', 3_000_002);
    writeFileSync(join(dir, 'pool-agents', 'broken.json'), '{ not json');
    expect(countAlive(dir, 3_000_003)).toBe(1);
    expect(countOccupied(dir, 3_000_000 + TTL_PENDING_MS + 1)).toBe(1);
    expect(countOccupied(dir, 3_000_002 + TTL_ALIVE_MS + 1)).toBe(0);
    expect(countAlive(dir)).toBe(0);
  });
});

describe('ceiling of agents', () => {
  it('refuses the 41st reservation at 40/40 and writes no file', () => {
    const dir = makeDir();
    for (let i = 0; i < 40; i++) {
      expect(reserveAgent({ dir, sessionId: `s-${i}`, now: 4_000_000, env: LIMIT_40 }).ok).toBe(true);
      expect(commitAgent(dir, `s-${i}`, 4_000_001)).toBe(true);
    }
    expect(countAlive(dir, 4_000_002)).toBe(40);
    const r = reserveAgent({ dir, sessionId: 's-41', now: 4_000_003, env: LIMIT_40 });
    expect(r).toEqual({ ok: false, alive: 40, occupied: 40, limit: 40 });
    expect(poolFiles(dir)).toHaveLength(40);
    expect(refusalText(40, 40)).toContain('40/40');
    expect(refusalText(40, 40)).toContain('Do not delegate further: do the work yourself with the tools you have');
  });

  it('38 alive and 2 pending at 40: the 41st is refused, and after the pending TTL the next one passes', () => {
    const dir = makeDir();
    for (let i = 0; i < 38; i++) {
      reserveAgent({ dir, sessionId: `s-${i}`, now: 5_000_000, env: LIMIT_40 });
      commitAgent(dir, `s-${i}`, 5_000_001);
    }
    expect(countOccupied(dir, 5_000_002)).toBe(38);
    expect(reserveAgent({ dir, sessionId: 'o-1', now: 5_000_003, env: LIMIT_40 }).ok).toBe(true);
    expect(reserveAgent({ dir, sessionId: 'o-2', now: 5_000_004, env: LIMIT_40 }).ok).toBe(true);
    expect(reserveAgent({ dir, sessionId: 'o-3', now: 5_000_005, env: LIMIT_40 }).ok).toBe(false);
    expect(countOccupied(dir, 5_000_006)).toBe(40);
    expect(countOccupied(dir, 5_000_004 + TTL_PENDING_MS + 1)).toBe(38);
    expect(reserveAgent({ dir, sessionId: 'o-4', now: 5_000_004 + TTL_PENDING_MS + 2, env: LIMIT_40 }).ok).toBe(true);
  });
});

describe('session counter', () => {
  function counter(json, exitCode = 0) {
    const script = join(makeDir('jev-pool-counter-'), 'counter.mjs');
    const text = typeof json === 'string' ? json : JSON.stringify(json);
    writeFileSync(script, `process.stdout.write(${JSON.stringify(text)}); process.exit(${exitCode});\n`);
    return { OMC_JEV_POOL_SESSION_COUNTER: `node ${script}` };
  }

  it('counts arrays, agents and sessions objects, and reports read errors instead of a count', () => {
    expect(countSessions({ env: { ...process.env, ...counter(Array.from({ length: 20 }, (_, i) => ({ id: i }))) } })).toEqual({ sessions: 20 });
    expect(countSessions({ env: { ...process.env, ...counter({ agents: [{}, {}, {}] }) } })).toEqual({ sessions: 3 });
    expect(countSessions({ env: { ...process.env, ...counter({ sessions: [{}, {}] }) } })).toEqual({ sessions: 2 });
    expect(countSessions({ env: { ...process.env, ...counter('not json') } }).error).toBe('not JSON');
    expect(countSessions({ env: { ...process.env, ...counter('[]', 1) } }).error).toBe('exit 1');
    expect(countSessions({ env: { ...process.env, OMC_JEV_POOL_SESSION_COUNTER: 'no-such-command-xyz' } }).error).toContain('ENOENT');
  });

  it('skips headless claude -p and --print processes by their exact arguments; positions without pid or with an unreadable cmdline count', () => {
    const positions = [];
    const cmdlines = {};
    let pid = 100;
    const add = (args) => {
      positions.push({ id: `p${pid}`, pid, kind: 'interactive' });
      cmdlines[pid] = ['claude', ...args].join('\0');
      pid += 1;
    };
    for (let i = 0; i < 14; i++) add(['--bg', '--name', `tor-${i}`]);
    for (let i = 0; i < 5; i++) add(['-p', 'do something']);
    add(['--print', 'do something']);
    positions.push({ id: 'no-pid-1', pid: null, kind: 'background', state: 'blocked' });
    positions.push({ id: 'no-pid-2', pid: null, kind: 'background', state: 'blocked' });
    positions.push({ id: 'unreadable', pid: 999_999 });
    const readCmdline = (path) => {
      const found = /\/proc\/(\d+)\//.exec(path)[1];
      if (!(Number(found) in cmdlines)) throw new Error('ENOENT');
      return cmdlines[Number(found)];
    };
    const env = { ...process.env, ...counter(positions) };
    expect(countSessions({ env, readCmdline })).toEqual({ sessions: 17 });

    const twoPositions = [{ pid: 500 }, { pid: 501 }];
    const twoCmdlines = { 500: ['claude', '-pX', 'x'].join('\0'), 501: ['claude', '/path/with/-p/file', 'x'].join('\0') };
    const env2 = { ...process.env, ...counter(twoPositions) };
    expect(countSessions({ env: env2, readCmdline: (path) => twoCmdlines[/\/proc\/(\d+)\//.exec(path)[1]] })).toEqual({ sessions: 2 });
  });
});

/** Runs one of the hook scripts with the given stdin and environment; the cwd is a temp project. */
function runHook(script, input, extraEnv, cwd) {
  const home = makeDir('jev-pool-home-');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OMC_|TYPESAFE_|CLAUDE|ANTHROPIC_|DISABLE_OMC|CODEX)/i.test(key)));
  Object.assign(env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), OMC_JEV_QUIET: '1' }, extraEnv);
  return spawnSync(process.execPath, [join(ROOT, 'scripts', script)], { cwd, input: JSON.stringify(input), env, encoding: 'utf8', timeout: 60_000 });
}

function projectDir() {
  const dir = join(makeDir('jev-pool-project-'), 'project');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function preToolUse(cwd, logDir, extraEnv, toolName = 'Agent', toolInput = { subagent_type: 'mechanik', prompt: 'Check the risks.' }) {
  return runHook('pre-tool-enforcer.mjs', { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, session_id: 'session-pool', tool_use_id: 'tool-1', cwd }, { OMC_JEV_LOG_DIR: logDir, ...extraEnv }, cwd);
}

describe('PreToolUse refusal with OMC_JEV_POOL=1', () => {
  it('refuses Agent and Task at 40/40 with the count and the do-it-yourself text, logs a deny row and reserves nothing', () => {
    const cwd = projectDir();
    const logDir = makeDir();
    for (let i = 0; i < 40; i++) reserveAlive(logDir, `s-${i}`, Date.now());
    const run = preToolUse(cwd, logDir, { OMC_JEV_POOL: '1', OMC_JEV_POOL_MAX_AGENTS: '40' });
    expect(run.status).toBe(0);
    const output = JSON.parse(run.stdout);
    const reason = output?.hookSpecificOutput?.permissionDecisionReason ?? '';
    expect(output?.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(reason).toContain('[AGENT POOL]');
    expect(reason).toContain('40/40');
    expect(reason).toContain('Do not delegate further: do the work yourself with the tools you have');
    const last = rows(logDir).at(-1);
    expect(last).toMatchObject({ decision: 'deny', alive: 40, occupied: 40, limit: 40, point: 'pool-agents' });
    expect(poolFiles(logDir)).toHaveLength(40);

    const task = preToolUse(cwd, logDir, { OMC_JEV_POOL: '1', OMC_JEV_POOL_MAX_AGENTS: '40' }, 'Task');
    expect(JSON.parse(task.stdout)?.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('allows the call on an empty pool, logs an allow row and creates one pending reservation', () => {
    const cwd = projectDir();
    const logDir = makeDir();
    const run = preToolUse(cwd, logDir, { OMC_JEV_POOL: '1', OMC_JEV_POOL_MAX_AGENTS: '40' });
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain('[AGENT POOL]');
    expect(rows(logDir).at(-1)).toMatchObject({ decision: 'allow', alive: 0, occupied: 0, limit: 40 });
    expect(poolFiles(logDir)).toHaveLength(1);
  });

  it('a read error of the pool state fails open: exit 0, no refusal, an unreadable row', () => {
    const cwd = projectDir();
    const logDir = makeDir();
    writeFileSync(join(logDir, 'pool-agents'), 'not a directory');
    const run = preToolUse(cwd, logDir, { OMC_JEV_POOL: '1', OMC_JEV_POOL_MAX_AGENTS: '40' });
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain('[AGENT POOL]');
    expect(rows(logDir).at(-1)).toMatchObject({ decision: 'unreadable', alive: null });
  });

  it('without OMC_JEV_POOL nothing changes: no refusal at 40 alive, no row, no reservation', () => {
    const cwd = projectDir();
    const logDir = makeDir();
    for (let i = 0; i < 40; i++) reserveAlive(logDir, `s-${i}`, Date.now());
    const run = preToolUse(cwd, logDir, { OMC_JEV_POOL_MAX_AGENTS: '40' });
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain('[AGENT POOL]');
    expect(existsSync(join(logDir, 'pool.jsonl'))).toBe(false);
    expect(poolFiles(logDir)).toHaveLength(40);
  });

  it('OMC_JEV_POOL=off is not the switch: only 1 enables the pool', () => {
    const cwd = projectDir();
    const logDir = makeDir();
    for (let i = 0; i < 40; i++) reserveAlive(logDir, `s-${i}`, Date.now());
    const run = preToolUse(cwd, logDir, { OMC_JEV_POOL: 'off', OMC_JEV_POOL_MAX_AGENTS: '40' });
    expect(run.stdout).not.toContain('[AGENT POOL]');
    expect(existsSync(join(logDir, 'pool.jsonl'))).toBe(false);
  });
});

describe('event hooks with OMC_JEV_POOL=1', () => {
  it('SubagentStart commits the pending reservation and SubagentStop releases the alive one', () => {
    const cwd = projectDir();
    const logDir = makeDir();
    reserveAgent({ dir: logDir, sessionId: 'session-a', now: Date.now(), env: {} });
    const start = runHook('jev-pool-start.mjs', { hook_event_name: 'SubagentStart', session_id: 'session-a', cwd }, { OMC_JEV_POOL: '1', OMC_JEV_LOG_DIR: logDir }, cwd);
    expect(start.status).toBe(0);
    expect(JSON.parse(start.stdout)).toEqual({ continue: true, suppressOutput: true });
    expect(countAlive(logDir)).toBe(1);
    const stop = runHook('jev-pool-stop.mjs', { hook_event_name: 'SubagentStop', session_id: 'session-a', cwd }, { OMC_JEV_POOL: '1', OMC_JEV_LOG_DIR: logDir }, cwd);
    expect(stop.status).toBe(0);
    expect(countAlive(logDir)).toBe(0);
  });

  it('PostToolUseFailure releases the reservation of the failed call by tool_use_id, pending or alive', () => {
    const cwd = projectDir();
    const logDir = makeDir();
    reserveAgent({ dir: logDir, sessionId: 'session-f', toolUseId: 'tool-f1', now: Date.now(), env: {} });
    expect(countOccupied(logDir)).toBe(1);
    const failure = runHook('jev-pool-failure.mjs', { hook_event_name: 'PostToolUseFailure', session_id: 'session-f', tool_use_id: 'tool-f1', cwd }, { OMC_JEV_POOL: '1', OMC_JEV_LOG_DIR: logDir }, cwd);
    expect(failure.status).toBe(0);
    expect(countOccupied(logDir)).toBe(0);
    reserveAgent({ dir: logDir, sessionId: 'session-f2', toolUseId: 'tool-f2', now: Date.now(), env: {} });
    commitAgent(logDir, 'session-f2');
    const failure2 = runHook('jev-pool-failure.mjs', { hook_event_name: 'PostToolUseFailure', session_id: 'session-f2', tool_use_id: 'tool-f2', cwd }, { OMC_JEV_POOL: '1', OMC_JEV_LOG_DIR: logDir }, cwd);
    expect(failure2.status).toBe(0);
    expect(countOccupied(logDir)).toBe(0);
    expect(releaseAgentByToolUseId(logDir, 'no-such-tool')).toBe(false);
  });

  it('the event hooks change nothing without OMC_JEV_POOL', () => {
    const cwd = projectDir();
    const logDir = makeDir();
    reserveAgent({ dir: logDir, sessionId: 'session-off', toolUseId: 'tool-off', now: Date.now(), env: {} });
    const start = runHook('jev-pool-start.mjs', { hook_event_name: 'SubagentStart', session_id: 'session-off', cwd }, { OMC_JEV_LOG_DIR: logDir }, cwd);
    expect(start.status).toBe(0);
    expect(countAlive(logDir)).toBe(0);
    expect(countOccupied(logDir)).toBe(1);
    const failure = runHook('jev-pool-failure.mjs', { hook_event_name: 'PostToolUseFailure', session_id: 'session-off', tool_use_id: 'tool-off', cwd }, { OMC_JEV_LOG_DIR: logDir }, cwd);
    expect(failure.status).toBe(0);
    expect(countOccupied(logDir)).toBe(1);
  });
});
