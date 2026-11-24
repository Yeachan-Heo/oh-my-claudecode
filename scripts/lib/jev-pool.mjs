// Shared agent pool for the Jev hooks (opt-in): a machine-wide ceiling on the number of
// agents, enforced with hard refusals of Agent/Task calls in PreToolUse, with a reservation per
// allowed call (the reserveSubagentSpawn pattern). A ceiling on the number of main sessions is
// read here too (sessionLimit, countSessions) but is enforced only by the session launcher
// (scripts/jev-session.mjs), not by the Agent/Task refusal. Enabled only with OMC_JEV_POOL=1; with the variable unset nothing here runs
// (the SubagentStart, SubagentStop and PostToolUseFailure hooks do not even import this module).
//
// The state lives in the Jev log directory (OMC_JEV_LOG_DIR, else state/jev under the state root;
// set OMC_JEV_LOG_DIR to share one pool between projects):
//   pool-agents/<epoch ms>-<random>.json  one reservation per allowed Agent/Task call:
//                                         {ts, state, session_id, tool_use_id, subagent_type[, label][, agent_id]}.
//                                         "pending" is the reservation before the start; the
//                                         SubagentStart hook commits it to "alive" (it takes the pending
//                                         reservation of the session whose subagent_type is the type
//                                         that started and whose label (the name or description of the
//                                         call) is the one the start carries, else one of that type, else
//                                         the oldest one, and records the agent_id),
//                                         the SubagentStop hook releases it (by agent_id, else the oldest
//                                         alive one of the session), and the PostToolUseFailure hook
//                                         releases it by tool_use_id (a start that failed after the
//                                         allow). A pending reservation expires after 2 minutes (a start
//                                         that never happened), an alive one after 24 hours (a lost
//                                         SubagentStop). Expired and corrupt files are swept on every
//                                         read. The ceiling counts pending and alive together, so a
//                                         reservation takes its slot from the moment of the allow and N
//                                         parallel calls at the limit do not all pass.
//   pool-sessions/<epoch ms>-<random>.json one reservation per session launch in flight (see
//                                         reserveSession): the launcher takes it before the Jev query
//                                         and the start and removes it when it is done.
//   .pool.lock                            every read-modify-write of the reservations (reserve, commit,
//                                         release, the session reservation) runs under this one lock,
//                                         with a wait budget under a second: the hooks that release
//                                         have a 3 s manifest timeout, and a lock wait blocks their
//                                         event loop, so a wait that does not end in time fails open
//                                         (below), never a long stall.
//   pool.jsonl                            one row per Agent/Task call: {ts, point: "pool-agents",
//                                         alive, pending, occupied, limit, decision:
//                                         allow|deny|unreadable}, rotated like shadow.jsonl.
//
// Limits: OMC_JEV_POOL_MAX_AGENTS and OMC_JEV_POOL_MAX_SESSIONS, positive integers or 0.
// 0 (the default) means no limit, so enabling the pool alone changes no refusal. A value that
// is not an integer keeps the default.
//
// Fail-open: a read or write error never refuses a call and never breaks a hook, and neither does a
// lock that is not obtained in time: the call goes through without a reservation (an untracked call),
// the decision is `unreadable` when the state could not be read, and the row is logged. A capacity
// refusal is only ever a count over the limit that was read under the lock.
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { resolveJevLogMaxBytes, resolveJevTimeoutMs, rotateJevLog } from '../jev-resolve.mjs';
import { resolveOmcStateRoot } from './state-root.mjs';
import { withStateFileLockAtPathSync } from './atomic-write.mjs';

export const DEFAULT_SESSION_LIMIT = 0;
export const DEFAULT_AGENT_LIMIT = 0;

const RESERVATION_DIR = 'pool-agents';
const SESSION_RESERVATION_DIR = 'pool-sessions';
export const PENDING_TTL_MS = 2 * 60_000;
export const ALIVE_TTL_MS = 24 * 3_600_000;
// A session launch lasts up to the two start attempts of the launcher (120 s each) plus the Jev query; a reservation of a launcher that died expires after this.
export const SESSION_PENDING_TTL_MS = 5 * 60_000;
// A launch with a longer Jev query timeout (OMC_JEV_TIMEOUT_MS) lasts longer: the two starts, the query with the 10 s the resolver gets to start and finish, and a margin of 30 s.
export const sessionPendingTtlMs = (env = process.env) => Math.max(SESSION_PENDING_TTL_MS, 2 * 120_000 + resolveJevTimeoutMs(env, 10_000) + 30_000);
// Wait budget of the pool lock (ms). The lock wait is synchronous: it must end well inside the 1 s cap of the hook step and the 3 s hook timeout.
// A caller can pass a longer budget (options.lockBudgetMs) where no hook timeout applies, as the tests of many concurrent callers do.
const LOCK_BUSY_MS = 300;
const LOCK_PROBE_MS = 300;
const LOCK_BUDGET_MS = 700;

/**
 * Runs fn under the pool lock. Returns true when fn ran (also when only the release of the lock failed afterwards: the
 * results fn left in its closure are valid), false when the lock was not obtained in the budget (fn did not run).
 * An error thrown by fn propagates after the lock is released.
 */
function underPoolLock(dir, fn, budgetMs = LOCK_BUDGET_MS) {
  const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : LOCK_BUDGET_MS;
  const lock = withStateFileLockAtPathSync(join(dir, '.pool.lock'), fn, true, Math.ceil(budget / 8), LOCK_BUSY_MS, LOCK_PROBE_MS, budget);
  return lock.acquired === true || lock.callbackRan === true;
}

const readLimit = (env, name, fallback) => {
  const raw = String(env?.[name] ?? '').trim();
  return /^[0-9]{1,6}$/.test(raw) ? Number(raw) : fallback;
};

export const sessionLimit = (env = process.env) => readLimit(env, 'OMC_JEV_POOL_MAX_SESSIONS', DEFAULT_SESSION_LIMIT);
export const agentLimit = (env = process.env) => readLimit(env, 'OMC_JEV_POOL_MAX_AGENTS', DEFAULT_AGENT_LIMIT);

/** The pool is opt-in: only OMC_JEV_POOL=1 enables it. */
export const poolEnabled = (env = process.env) => String(env?.OMC_JEV_POOL ?? '').trim() === '1';

/** The directory of the pool state and of pool.jsonl: OMC_JEV_LOG_DIR, else state/jev under the state directory (the rule of shadow.jsonl). */
export function poolDir(env, stateDir) {
  return env?.OMC_JEV_LOG_DIR || join(stateDir, 'jev');
}

/** The pool as read from pool-agents/: {pending: [...], alive: [...]} of {name, path, ts, state, sessionId, toolUseId, agentId, subagentType, label}. Sweeps expired and corrupt files on the way. */
function readPool(dir, now) {
  const folder = join(dir, RESERVATION_DIR);
  let names;
  try {
    names = readdirSync(folder);
  } catch (error) {
    if (error?.code === 'ENOENT') return { pending: [], alive: [] }; // no directory means an empty pool, not a read error
    throw error; // EACCES and the like is a read error (fail-open in the callers)
  }
  const pending = [];
  const alive = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(folder, name);
    let record;
    try {
      record = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // A corrupt or unreadable file is not counted. It is removed once its mtime is past the alive TTL.
      let mtimeMs = 0;
      try { mtimeMs = statSync(path).mtimeMs; } catch { continue; }
      if (mtimeMs < now - ALIVE_TTL_MS) { try { rmSync(path, { force: true }); } catch { /* best effort */ } }
      continue;
    }
    if (!record || typeof record !== 'object' || (record.state !== 'pending' && record.state !== 'alive') || !Number.isFinite(record.ts)) continue; // a foreign file is not counted
    const entry = {
      name,
      path,
      ts: record.ts,
      state: record.state,
      sessionId: typeof record.session_id === 'string' ? record.session_id : null,
      toolUseId: typeof record.tool_use_id === 'string' ? record.tool_use_id : null,
      agentId: typeof record.agent_id === 'string' ? record.agent_id : null,
      subagentType: typeof record.subagent_type === 'string' ? record.subagent_type : null,
      label: typeof record.label === 'string' ? record.label : null,
    };
    const expired = record.state === 'pending' ? record.ts < now - PENDING_TTL_MS : record.ts < now - ALIVE_TTL_MS;
    if (expired) {
      try { rmSync(path, { force: true }); } catch { /* swept on a later read */ }
      continue;
    }
    (record.state === 'pending' ? pending : alive).push(entry);
  }
  return { pending, alive };
}

/** Number of alive agents of the pool. Throws on a read error. */
export function countAlive(dir, now = Date.now()) {
  return readPool(dir, now).alive.length;
}

/** The pool occupancy: pending and alive together, which is what the ceiling compares. Throws on a read error. */
export function countOccupied(dir, now = Date.now()) {
  const pool = readPool(dir, now);
  return pool.alive.length + pool.pending.length;
}

/** The pool with pending reservations too, for the log row and the commit and release searches. */
export function readPoolState(dir, now = Date.now()) {
  return readPool(dir, now);
}

/**
 * Reserve an agent slot before the start. Counts pending and alive together; at the limit it
 * refuses without writing a file, otherwise it creates the pending reservation (O_EXCL). The check
 * and the creation run under the pool lock, so parallel callers at the last free slot get one
 * reservation. Returns {ok: false, alive, occupied, limit} on a refusal (a count over the limit read
 * under the lock), {ok: true, file, alive, occupied, limit} on a reservation, and
 * {ok: true, file: null, untracked: true, ...} when the lock was not obtained in time (fail-open:
 * not a refusal). Throws on a file error (the caller fails open).
 */
export function reserveAgent({ dir, sessionId, toolUseId, subagentType, label, now = Date.now(), env = process.env, lockBudgetMs }) {
  const limit = agentLimit(env);
  let result = null;
  const ran = underPoolLock(dir, () => {
    const pool = readPool(dir, now);
    const alive = pool.alive.length;
    const occupied = alive + pool.pending.length;
    if (limit > 0 && occupied >= limit) {
      result = { ok: false, alive, occupied, limit };
      return;
    }
    mkdirSync(join(dir, RESERVATION_DIR), { recursive: true });
    const file = `${now}-${Math.random().toString(36).slice(2, 10)}.json`;
    const fd = openSync(join(dir, RESERVATION_DIR, file), 'wx'); // never overwrites a reservation of another call
    try {
      writeFileSync(fd, JSON.stringify({ ts: now, state: 'pending', session_id: sessionId || null, tool_use_id: toolUseId || null, subagent_type: subagentType || null, ...(label ? { label: String(label).slice(0, 200) } : {}) }) + '\n', 'utf8');
    } finally {
      closeSync(fd);
    }
    result = { ok: true, file, alive, occupied, limit };
  }, lockBudgetMs);
  if (!ran || !result) return { ok: true, file: null, alive: 0, occupied: 0, limit, untracked: true };
  return result;
}

const baseType = (type) => String(type ?? '').trim().toLowerCase().replace(/^[^:]+:/, '');

/**
 * Commit a pending reservation of the session (SubagentStart): the agent started. The reservation is the oldest pending
 * one of the session whose subagent_type is the type that started (the namespace before ":" and the letter case do not
 * count) and whose label is the name or description the start carries, else the oldest of that type, else the oldest
 * pending one of the session. Calls of one type and label are interchangeable, so no reservation can be told from the
 * others: they commit in the order of their reservations. The agent_id of the start is recorded on it, so that the
 * SubagentStop of this agent releases exactly this reservation. The selection and the rewrite run under the pool lock,
 * so concurrent starts of one session commit distinct reservations. False when there is none or the lock was not obtained.
 */
export function commitAgent(dir, sessionId, now = Date.now(), start = {}) {
  if (!sessionId) return false;
  try {
    let committed = false;
    underPoolLock(dir, () => {
      const pending = readPool(dir, now).pending.filter((entry) => entry.sessionId === sessionId).sort((a, b) => a.ts - b.ts); // the oldest first
      const type = baseType(start.agentType);
      const label = start.label ? String(start.label).slice(0, 200) : '';
      const ofType = type ? pending.filter((candidate) => baseType(candidate.subagentType) === type) : [];
      const entry = (label && ofType.find((candidate) => candidate.label === label)) || ofType[0] || pending[0];
      if (!entry) return;
      const record = JSON.parse(readFileSync(entry.path, 'utf8')); // reread, keep the unknown fields
      record.ts = now; // the alive TTL counts from the start
      record.state = 'alive';
      if (typeof start.agentId === 'string' && start.agentId) record.agent_id = start.agentId.slice(0, 200);
      const tmp = `${entry.path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      writeFileSync(tmp, JSON.stringify(record) + '\n', 'utf8');
      renameSync(tmp, entry.path); // one atomic replace: a reader that does not take the lock sees pending or alive, both count
      committed = true;
    }, start.lockBudgetMs);
    return committed;
  } catch {
    return false; // a commit that fails is never an error of the caller
  }
}

/**
 * Release the reservation of a stopped agent (SubagentStop). With an agent_id: the alive reservation that carries it; else the
 * oldest alive reservation of the session that carries no agent_id (a start that was not recorded with its id); else the oldest
 * pending one of the session (the start of this agent was not committed in time). An alive reservation of another agent is
 * never released for a stop that names its own agent. Without an agent_id the stops are in the order of the starts: the oldest
 * alive one of the session (the ones without an id first), then the oldest pending one. The selection and the removal run
 * under the pool lock, so concurrent stops release distinct reservations. False when there is none or the lock was not obtained.
 */
export function releaseAgent(dir, sessionId, now = Date.now(), stop = {}) {
  if (!sessionId) return false;
  try {
    let released = false;
    underPoolLock(dir, () => {
      const pool = readPool(dir, now);
      const aliveOfSession = pool.alive.filter((entry) => entry.sessionId === sessionId).sort((a, b) => a.ts - b.ts); // FIFO, the usual order of the stops
      const pending = pool.pending.filter((entry) => entry.sessionId === sessionId).sort((a, b) => a.ts - b.ts); // a stop without a registered start
      const agentId = typeof stop.agentId === 'string' ? stop.agentId : '';
      const withoutId = aliveOfSession.find((candidate) => !candidate.agentId);
      const entry = agentId
        ? aliveOfSession.find((candidate) => candidate.agentId === agentId) || withoutId || pending[0]
        : withoutId || aliveOfSession[0] || pending[0];
      if (!entry) return;
      rmSync(entry.path, { force: true });
      released = true;
    }, stop.lockBudgetMs);
    return released;
  } catch {
    return false;
  }
}

/** Release the reservation of one exact call (PostToolUseFailure, by the tool_use_id of the failed Agent/Task call): pending or alive. False when there is none. */
export function releaseAgentByToolUseId(dir, toolUseId, now = Date.now(), options = {}) {
  if (!toolUseId) return false;
  try {
    let released = false;
    underPoolLock(dir, () => {
      const pool = readPool(dir, now);
      for (const entry of [...pool.alive, ...pool.pending].filter((candidate) => candidate.toolUseId === toolUseId)) {
        try { rmSync(entry.path, { force: true }); released = true; } catch { /* best effort */ }
      }
    }, options.lockBudgetMs);
    return released;
  } catch {
    return false;
  }
}

/**
 * The session launcher's reservation (scripts/jev-session.mjs): a launch in flight takes a slot of its own, so that two
 * launchers that both counted the sessions before either has started do not both pass the ceiling. Under the pool
 * lock it counts the launches in flight (reservations younger than sessionPendingTtlMs) and refuses at
 * `counted + inFlight >= limit`; otherwise it creates the reservation. `counted` is the number of running sessions the
 * caller read from the session counter (before the lock, the counter command is slow). A limit of 0 reserves
 * nothing. Returns {ok: false, inFlight} on a refusal and {ok: true, file, inFlight} on a reservation (file is null with
 * no limit, and with the lock not obtained in time: fail-open). Throws on a file error (the caller fails open).
 */
export function reserveSession({ dir, counted, limit, sessionId, now = Date.now(), env = process.env, lockBudgetMs }) {
  if (!(limit > 0)) return { ok: true, file: null, inFlight: 0 };
  const ttlMs = sessionPendingTtlMs(env);
  let result = null;
  const ran = underPoolLock(dir, () => {
    const folder = join(dir, SESSION_RESERVATION_DIR);
    let names = [];
    try { names = readdirSync(folder); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    let inFlight = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const path = join(folder, name);
      let ts = 0;
      try { ts = JSON.parse(readFileSync(path, 'utf8'))?.ts; } catch { try { ts = statSync(path).mtimeMs; } catch { continue; } }
      if (!Number.isFinite(ts) || ts < now - ttlMs) { try { rmSync(path, { force: true }); } catch { /* swept later */ } continue; }
      inFlight += 1;
    }
    if (counted + inFlight >= limit) {
      result = { ok: false, inFlight };
      return;
    }
    mkdirSync(folder, { recursive: true });
    const file = `${now}-${Math.random().toString(36).slice(2, 10)}.json`;
    const fd = openSync(join(folder, file), 'wx');
    try {
      writeFileSync(fd, JSON.stringify({ ts: now, session_id: sessionId || null, pid: process.pid }) + '\n', 'utf8');
    } finally {
      closeSync(fd);
    }
    result = { ok: true, file, inFlight };
  }, lockBudgetMs);
  if (!ran || !result) return { ok: true, file: null, inFlight: 0 };
  return result;
}

/** Removes the reservation of a launch that is over (started or failed). Never throws. */
export function releaseSession(dir, file) {
  if (!file || !/^[0-9]+-[a-z0-9]+\.json$/.test(file)) return false;
  try {
    rmSync(join(dir, SESSION_RESERVATION_DIR, file), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** One row of pool.jsonl. A failing log never breaks the hook. */
export function writePoolRow(dir, row, env = process.env) {
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'pool.jsonl');
    rotateJevLog(path, resolveJevLogMaxBytes(env));
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), point: 'pool-agents', ...row }) + '\n', 'utf8');
  } catch { /* the log is advisory */ }
}

/** The refusal text: the caller must not delegate further and does the work with its own tools. */
export const refusalText = (occupied, limit) =>
  `Agent pool is full (${occupied}/${limit}). Do not delegate further: do the work yourself with the tools you have. A slot frees up when the running agents finish.`;

/**
 * Count the main sessions: the output of the counter command (OMC_JEV_POOL_SESSION_COUNTER, default
 * `claude agents --json`, which lists interactive and background sessions but no subagents).
 * Processes started as `claude -p` or `--print` do not count as sessions; they belong to the agent
 * pool. A position is recognised as headless by the exact arguments of its process
 * (`/proc/<pid>/cmdline`, NUL-separated; a substring match is not enough). A position without a
 * `pid`, or with an unreadable cmdline, counts (overcounting is safer than letting a call through).
 * The /proc read goes through an injectable function so a test can pass a fake.
 * A missing command, a non-zero exit or an unknown output shape is a read error ({error}), never a refusal.
 */
export function countSessions({ env = process.env, readCmdline = readFileSync } = {}) {
  const command = String(env?.OMC_JEV_POOL_SESSION_COUNTER ?? 'claude agents --json').trim() || 'claude agents --json';
  const parts = command.split(/\s+/);
  let result;
  try {
    result = spawnSync(parts[0], parts.slice(1), { encoding: 'utf8', timeout: 10_000, env });
  } catch (error) {
    return { error: `command: ${String(error?.code || error?.message || error).slice(0, 80)}` };
  }
  if (result.error) return { error: `command: ${String(result.error.code || result.error.message).slice(0, 80)}` };
  if (result.status !== 0) return { error: `exit ${result.status}` };
  try {
    const data = JSON.parse(result.stdout);
    // The three supported shapes: a top-level array, or an object with an `agents` or a `sessions` array; one counting rule for all.
    const positions = Array.isArray(data) ? data : data && typeof data === 'object' ? [data.agents, data.sessions].find(Array.isArray) : undefined;
    if (positions) {
      let sessions = 0;
      for (const item of positions) {
        const pid = item && typeof item === 'object' ? item.pid : undefined;
        if (!(typeof pid === 'number' && Number.isInteger(pid) && pid > 0)) { sessions += 1; continue; } // no pid: counts
        let cmdline;
        try { cmdline = readCmdline(`/proc/${pid}/cmdline`, 'utf8'); } catch { sessions += 1; continue; } // unreadable: counts
        const args = String(cmdline).split('\0');
        if (args.includes('-p') || args.includes('--print')) continue; // headless `claude -p`: the agent pool, not sessions
        sessions += 1;
      }
      return { sessions };
    }
    return { error: 'unknown output format' };
  } catch {
    return { error: 'not JSON' };
  }
}

/**
 * The handler of the pool events: the SubagentStart commit, the SubagentStop release of the
 * session and the PostToolUseFailure release by tool_use_id. Disabled pool and every error are a
 * no-op (fail-open). Returns true when the state changed.
 */
export async function handlePoolEvent({ event, sessionId, toolUseId, agentId, agentType, label, cwd, env = process.env, now = Date.now() }) {
  if (!poolEnabled(env)) return false;
  try {
    const omcRoot = await resolveOmcStateRoot(cwd || process.cwd());
    const dir = poolDir(env, join(omcRoot, 'state'));
    if (event === 'SubagentStart') return commitAgent(dir, sessionId, now, { agentId, agentType, label });
    if (event === 'SubagentStop') return releaseAgent(dir, sessionId, now, { agentId });
    if (event === 'PostToolUseFailure') return releaseAgentByToolUseId(dir, toolUseId, now);
  } catch { return false; }
  return false;
}

/**
 * Runs the pool handler for a parsed hook event object, as read once by the hook that calls this
 * (scripts/subagent-tracker.mjs and scripts/post-tool-use-failure.mjs, which import this module
 * only when OMC_JEV_POOL=1). A value that is not an object is a no-op. Returns true when the
 * state changed.
 */
export async function handlePoolHookEvent(data, options = {}) {
  if (!data || typeof data !== 'object') return false;
  const text = (value) => (typeof value === 'string' ? value : '');
  return handlePoolEvent({
    event: text(data.hook_event_name),
    sessionId: text(data.session_id),
    cwd: text(data.cwd),
    toolUseId: text(data.tool_use_id),
    agentId: text(data.agent_id),
    agentType: text(data.agent_type),
    label: text(data.name) || text(data.description),
    ...options,
  });
}
