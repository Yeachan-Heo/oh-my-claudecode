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
//                                         {ts, state, session_id, tool_use_id, subagent_type}.
//                                         "pending" is the reservation before the start; the
//                                         SubagentStart hook commits it to "alive", the
//                                         SubagentStop hook releases it, and the
//                                         PostToolUseFailure hook releases it by tool_use_id
//                                         (a start that failed after the allow). A pending
//                                         reservation expires after 2 minutes (a start that never
//                                         happened), an alive one after 24 hours (a lost
//                                         SubagentStop). Expired and corrupt files are swept on
//                                         every read. The ceiling counts pending and alive
//                                         together, so a reservation takes its slot from the
//                                         moment of the allow and N parallel calls at the limit
//                                         do not all pass.
//   pool.jsonl                            one row per Agent/Task call: {ts, point: "pool-agents",
//                                         alive, pending, occupied, limit, decision:
//                                         allow|deny|unreadable}, rotated like shadow.jsonl.
//
// Limits: OMC_JEV_POOL_MAX_AGENTS and OMC_JEV_POOL_MAX_SESSIONS, positive integers or 0.
// 0 (the default) means no limit, so enabling the pool alone changes no refusal. A value that
// is not an integer keeps the default.
//
// Fail-open: a read or write error never refuses a call and never breaks a hook. The decision
// is then `unreadable`, the call goes through without a reservation, and the row is logged.
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { resolveJevLogMaxBytes, rotateJevLog } from '../jev-resolve.mjs';
import { resolveOmcStateRoot } from './state-root.mjs';
import { withStateFileLockAtPathSync } from './atomic-write.mjs';

export const DEFAULT_SESSION_LIMIT = 0;
export const DEFAULT_AGENT_LIMIT = 0;

const RESERVATION_DIR = 'pool-agents';
export const PENDING_TTL_MS = 2 * 60_000;
export const ALIVE_TTL_MS = 24 * 3_600_000;

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

/** The pool as read from pool-agents/: {pending: [...], alive: [...]} of {name, path, ts, state, sessionId, toolUseId}. Sweeps expired and corrupt files on the way. */
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
 * refuses without writing a file, otherwise it creates the pending reservation (O_EXCL). The caller
 * has already passed the pool check; this is the second, race-tolerant look. Returns
 * {ok: false, alive, occupied, limit} on a refusal and {ok: true, file, alive, occupied, limit}
 * on a reservation. Throws on a file error (the caller fails open).
 * The check and reservation are atomic under a shared lock to prevent overallocation.
 */
export function reserveAgent({ dir, sessionId, toolUseId, subagentType, now = Date.now(), env = process.env }) {
  const limit = agentLimit(env);
  let result = { ok: false, alive: 0, occupied: 0, limit };

  // Hold a shared lock across the check and reservation to prevent race conditions
  const lockResult = withStateFileLockAtPathSync(
    join(dir, '.pool.lock'),
    () => {
      const alive = countAlive(dir, now);
      const occupied = alive + readPool(dir, now).pending.length;
      if (limit > 0 && occupied >= limit) {
        result = { ok: false, alive, occupied, limit };
        return;
      }
      mkdirSync(join(dir, RESERVATION_DIR), { recursive: true });
      const file = `${now}-${Math.random().toString(36).slice(2, 10)}.json`;
      const fd = openSync(join(dir, RESERVATION_DIR, file), 'wx'); // never overwrites a reservation of another call
      try {
        writeFileSync(fd, JSON.stringify({ ts: now, state: 'pending', session_id: sessionId || null, tool_use_id: toolUseId || null, subagent_type: subagentType || null }) + '\n', 'utf8');
      } finally {
        closeSync(fd);
      }
      result = { ok: true, file, alive, occupied, limit };
    },
    true, // requireExclusive
    50, // attempts
    2000, // busyTimeoutMs
    3000, // processProbeTimeoutMs
    5000, // overallTimeoutMs - 5 seconds should be plenty for a quick check+write
  );
  
  // If lock acquisition failed, fail open by allowing the call with no reservation (Codex P2 finding).
  // This prevents treating lock failures as pool-full refusals, which would cause spurious denials.
  if (lockResult && !lockResult.acquired) {
    return { ok: true, file: null, alive: 0, occupied: 0, limit, untracked: true };
  }
  
  return result;
}

/** Commit the newest pending reservation of the session (SubagentStart): the agent started. False when there is none. */
export function commitAgent(dir, sessionId, now = Date.now()) {
  if (!sessionId) return false;
  try {
    const pool = readPool(dir, now);
    const pendingOfSession = pool.pending.filter((entry) => entry.sessionId === sessionId).sort((a, b) => b.ts - a.ts); // the newest pending one
    for (const entry of pendingOfSession) {
      const aliveName = entry.path.replace(/\.json$/, '.alive.json');
      const record = JSON.parse(readFileSync(entry.path, 'utf8')); // reread, keep the unknown fields
      try {
        renameSync(entry.path, aliveName); // the atomic rename is the claim: a concurrent twin gets ENOENT and takes the next pending one
      } catch {
        continue; // another process claimed this one in the meantime
      }
      record.ts = now; // the alive TTL counts from the start
      record.state = 'alive';
      const tmp = `${aliveName}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      writeFileSync(tmp, JSON.stringify(record) + '\n', 'utf8');
      renameSync(tmp, aliveName); // only the claimant gets here
      return true;
    }
    return false;
  } catch {
    return false; // a commit that fails is never an error of the caller
  }
}

/** Release the oldest alive reservation of the session (SubagentStop); without one, the oldest pending one. False when there is none. */
export function releaseAgent(dir, sessionId, now = Date.now()) {
  if (!sessionId) return false;
  try {
    // Serialize the read + delete under a lock to prevent concurrent SubagentStop hooks from selecting and deleting the same reservation.
    // Without this, multiple callers can all report success even when only one file is actually deleted (Codex P1 finding).
    let result = false;
    withStateFileLockAtPathSync(
      join(dir, '.pool.lock'),
      () => {
        const pool = readPool(dir, now);
        const alive = pool.alive.filter((entry) => entry.sessionId === sessionId).sort((a, b) => a.ts - b.ts); // FIFO, the usual order of the stops
        if (alive.length) {
          rmSync(alive[0].path, { force: true });
          result = true;
          return;
        }
        const pending = pool.pending.filter((entry) => entry.sessionId === sessionId).sort((a, b) => a.ts - b.ts); // a stop without a registered start
        if (pending.length) {
          rmSync(pending[0].path, { force: true });
          result = true;
          return;
        }
      },
      true, // requireExclusive: serialize all operations
      50, // attempts
      2000, // busyTimeoutMs
      3000, // processProbeTimeoutMs
      5000, // overallTimeoutMs
    );
    return result;
  } catch {
    return false;
  }
}

/** Release the reservation of one exact call (PostToolUseFailure, by the tool_use_id of the failed Agent/Task call): pending or alive. False when there is none. */
export function releaseAgentByToolUseId(dir, toolUseId, now = Date.now()) {
  if (!toolUseId) return false;
  try {
    // Serialize the read + delete under a lock to prevent concurrent releases from both succeeding when only one file exists.
    // This ensures the pool capacity is correctly tracked (Codex P1 finding).
    let released = false;
    withStateFileLockAtPathSync(
      join(dir, '.pool.lock'),
      () => {
        const pool = readPool(dir, now);
        const hits = [...pool.alive, ...pool.pending].filter((entry) => entry.toolUseId === toolUseId);
        for (const entry of hits) {
          try { rmSync(entry.path, { force: true }); released = true; } catch { /* best effort */ }
        }
      },
      true, // requireExclusive: serialize all operations
      50, // attempts
      2000, // busyTimeoutMs
      3000, // processProbeTimeoutMs
      5000, // overallTimeoutMs
    );
    return released;
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
    if (Array.isArray(data)) {
      let sessions = 0;
      for (const item of data) {
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
    if (data && typeof data === 'object') {
      for (const key of ['agents', 'sessions']) if (Array.isArray(data[key])) return { sessions: data[key].length };
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
export async function handlePoolEvent({ event, sessionId, toolUseId, cwd, env = process.env, now = Date.now() }) {
  if (!poolEnabled(env)) return false;
  try {
    const omcRoot = await resolveOmcStateRoot(cwd || process.cwd());
    const dir = poolDir(env, join(omcRoot, 'state'));
    if (event === 'SubagentStart') return commitAgent(dir, sessionId, now);
    if (event === 'SubagentStop') return releaseAgent(dir, sessionId, now);
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
    ...options,
  });
}
