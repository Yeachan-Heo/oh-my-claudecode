#!/usr/bin/env node
// Quota guard: reads the provider quota every 60 s (every 20 s from 85 %) with a fresh read, and writes the pool marker files.
// Window 5 h or week at or above the pause threshold: PAUSE marker (the pool starts no new workers, running ones continue).
// At or above the stop threshold: PAUSE and STOP markers, plus termination of running processes whose command line matches
// quota.stopPattern, together with their descendants (SIGTERM to the deepest descendants first, then the match; SIGKILL after
// OMC_PROVIDER_STOP_KILL_MS, default 10 s, for survivors that keep their start time). The guard, its ancestors and PID 1 are never signalled.
// Every signalled match is appended to aborted.tsv (time, pid, --settings file, cwd, session id for --resume).
// A read error or incomplete read leaves files and state unchanged. Below the pause threshold the markers are removed.
// The pool directory (quota.pool.dir or OMC_PROVIDER_POOL_DIR) and the stop pattern (quota.stopPattern or OMC_PROVIDER_STOP_PATTERN)
// have no defaults: without them the guard exits with code 2 and writes nothing.
// Option --once: one round and exit (for tests).
const { spawnSync } = require('node:child_process');
const { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, unlinkSync, utimesSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { loadProfile } = require('./lib/profile.cjs');
const { readKey } = require('./lib/settings.cjs');
const { mask } = require('./lib/redact.cjs');
const { quotaLevel, quotaUrl, readQuota, thresholds } = require('./lib/quota.cjs');
const { QUOTA_LEVELS } = require('./lib/vocab.cjs');

const NAME = 'provider-quota-guard';
const LOG_FILE = 'quota-guard.log';
const ABORTED_FILE = 'aborted.tsv';
const fail = (code, text) => { console.error(`${NAME}: ${text}`); process.exit(code); };
const timestamp = () => new Date().toLocaleString('sv-SE', { hour12: false }); // same format as `date '+%F %T'` (local machine time)
const touchFile = (p) => { const t = new Date(); if (existsSync(p)) utimesSync(p, t, t); else writeFileSync(p, ''); }; // like `touch`
const removeFile = (p) => { try { unlinkSync(p); } catch { /* already gone */ } };
const windowPercent = (l) => (l && typeof l.percentage === 'number' ? l.percentage : undefined);

// Kill delay between SIGTERM and SIGKILL (test variable OMC_PROVIDER_STOP_KILL_MS, default 10 s).
function killDelayFromEnv(env) {
  const v = env.OMC_PROVIDER_STOP_KILL_MS;
  if (v === undefined || v === '') return 10_000;
  const ms = Number(v);
  if (!Number.isFinite(ms) || ms < 0) throw new Error(`OMC_PROVIDER_STOP_KILL_MS has an invalid value (${v}); expected a number of ms >= 0`);
  return ms;
}

// Alive in the sense of "can still run": /proc/<pid>/stat state is not Z (zombie exists but no longer runs).
const isAlive = (pid) => { try { const st = readFileSync(`/proc/${pid}/stat`, 'utf8'); return st.slice(st.lastIndexOf(')') + 2, st.lastIndexOf(')') + 3) !== 'Z'; } catch { return false; } };

// Field of /proc/<pid>/stat by man proc numbering (state=3, ppid=4, starttime=22); unreadable or missing: null.
// The start time identifies a process when a SIGKILL is sent, so a recycled pid receives nothing.
const statField = (pid, nr) => { try { const st = readFileSync(`/proc/${pid}/stat`, 'utf8'); return st.slice(st.lastIndexOf(')') + 2).split(' ')[nr - 3]; } catch { return null; } };
const parentPid = (pid) => Number(statField(pid, 4)); // unreadable: Number(null) = 0, which ends the ancestor chain
const startTimeOf = (pid) => statField(pid, 22);

// Protected PIDs: the guard and all its ancestors (ppid chain up to and including PID 1; limit 4096 steps against loops).
// A match on an ancestor (wrapper, the session that started the guard) must not signal it, and the descendant walk never enters it.
function protectedPids() {
  const pids = new Set([1]);
  let p = process.pid;
  for (let i = 0; p > 0 && p !== 1 && i < 4096; i += 1) { pids.add(p); p = parentPid(p) || 0; }
  return pids;
}

// Command line of a process from /proc (NUL separators); process gone: ''.
const cmdlineOf = (pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { return ''; } };

// Matching works like `pgrep -f`: an extended regular expression on the full command line with NULs replaced by spaces, no anchors.
// An invalid pattern makes the process be skipped (no signal is the safe side).
const matchesPattern = (cmd, pattern) => { try { return new RegExp(pattern).test(cmd.replaceAll('\0', ' ')); } catch { return false; } };

// Single candidate check after pgrep: starttime, cmdline, starttime again, then the cmdline against the pattern.
// Readers are injected (production: /proc reads and matchesPattern). Returns { pid, cmd, start } or null (skipped).
function checkCandidate(pid, pattern, readers = {}) {
  const readStart = readers.starttime ?? startTimeOf;
  const readCmd = readers.cmdline ?? cmdlineOf;
  const matches = readers.matches ?? matchesPattern;
  const start = readStart(pid);
  const cmd = readCmd(pid);
  if (!cmd) return null; // process disappeared (cmdline of a dead or zombie process is empty)
  if (readStart(pid) !== start) return null; // pid reused by another process between the reads: skipped without a signal
  if (!matches(cmd, pattern)) return null; // pid taken between pgrep and the starttime read: the command line does not match, skipped
  return { pid, cmd, start };
}

// Working directory of a process from the /proc link; no access or process gone: ''.
const cwdOf = (pid) => { try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return ''; } };

// Descendants of a pid (without the pid itself), post-order (deepest first), from /proc/<pid>/task/*/children.
// Entries are {pid, start}; the start time of a child is read at the same moment as its children list,
// so the start time is the one of the moment the child was found. Visited pids stop loops and double counting.
// A read error on one thread keeps the other children and the process itself.
function descendantTree(pid, protectedSet = new Set(), readStart = startTimeOf) {
  const result = [];
  const walk = (entry, visited) => {
    const p = entry.pid;
    if (visited.has(p)) return;
    visited.add(p);
    let task;
    try { task = readdirSync(`/proc/${p}/task`); } catch { return; } // process gone (no /proc/<p>): no children and no entry
    const children = [];
    for (const tid of task) {
      let content;
      try { content = readFileSync(`/proc/${p}/task/${tid}/children`, 'utf8'); } catch { continue; } // thread gone: only this thread is skipped
      for (const c of content.trim().split(/\s+/)) {
        const d = Number(c);
        if (Number.isInteger(d) && d > 1 && !protectedSet.has(d)) children.push({ pid: d, start: readStart(d) });
        else if (protectedSet.has(d)) continue; // protected ancestor: the walk does not enter it
      }
    }
    for (const d of children) walk(d, visited);
    result.push({ pid: p, start: entry.start }); // post-order: leaves before the parent (p exists: its task directory was read); the root entry is removed by pop()
  };
  walk({ pid, start: null }, new Set());
  result.pop(); // without the pid itself
  return result;
}

// SIGTERM to entries {pid, start} only when the start time at sending equals the one recorded when the tree was collected.
// A pid with another start time, or gone, gets nothing and no error. A recorded start of null (unreadable at collection) gets no signal.
// Returns the number of signals sent. Kept as a separate step so tests can check the start time rule with a dummy process.
function sendSigterm(targets) {
  let sent = 0;
  for (const c of targets) {
    if (typeof c.start !== 'string' || startTimeOf(c.pid) !== c.start) continue; // undefined from a corrupt stat is skipped too
    try { process.kill(c.pid, 'SIGTERM'); sent += 1; } catch { /* gone in the meantime */ }
  }
  return sent;
}

// Stops every process matching the pattern together with its descendants. Returns the number of matching processes signalled.
function stopMatching(pattern, dir, env, inject = {}) {
  const killDelayMs = killDelayFromEnv(env); // validated before pgrep: a bad value must not follow any signal
  const send = inject.sendSigterm ?? sendSigterm;
  const r = spawnSync('pgrep', ['-f', '--', pattern], { encoding: 'utf8' }); // `--` before the pattern (a pattern starting with `-` would be an option)
  if (r.status !== 0 || !r.stdout) return 0; // 1: no match; 2 or 3: pgrep error
  const protectedSet = protectedPids();
  const settingsFromCmd = (cmd) => (cmd.replaceAll('\0', ' ').match(/--settings ([^ ]*)/) ?? [])[1] ?? '';
  const candidates = []; // {pid, cmd, start}: processes matching the pattern (without protected ancestors and dead ones)
  for (const line of r.stdout.trim().split('\n')) {
    const pid = Number(line);
    if (!Number.isInteger(pid) || pid < 2 || protectedSet.has(pid)) continue;
    // starttime read right after the pgrep match, then cmdline, then starttime again; the cmdline is matched to the pattern once more in code,
    // so a process taken by someone else between pgrep and the starttime read is skipped without a signal or an aborted.tsv row.
    const k = checkCandidate(pid, pattern);
    if (k) candidates.push(k);
  }
  // Deduplication: collect the trees of all candidates first, then drop candidates that are descendants of other candidates,
  // so the order of pgrep lines does not change the result.
  const trees = new Map(candidates.map((k) => [k.pid, descendantTree(k.pid, protectedSet)]));
  const targets = candidates.filter((k) => !candidates.some((other) => other.pid !== k.pid && trees.get(other.pid).some((w) => w.pid === k.pid)));
  let n = 0;
  let signals = 0; // total signals sent: without any signal there is no wait of killDelayMs and no SIGKILL pass
  let skipped = 0; // tree entries (targets and descendants) with an unreadable start time: no signal, no SIGKILL, logged
  const collected = []; // {pid, start} of targets and descendants that got SIGTERM; after killDelayMs, SIGKILL for survivors with the same start time
  const seen = new Set();
  for (const target of targets) {
    const pid = target.pid;
    const tree = trees.get(pid); // entries {pid, start} from the moment the tree was collected
    seen.add(pid);
    for (const d of tree) seen.add(d.pid);
    // command lines of descendants are read BEFORE the signals (afterwards they are gone)
    const descendants = tree.map((d) => ({ pid: d.pid, cmd: cmdlineOf(d.pid) }));
    // The --settings file for resuming is the ORIGINAL from the command line of the matching process (wrappers carry --settings in their
    // command line; a copy made for a child holds a secret and is working data). A child is queried only when the match has no --settings.
    let settingsCmd = target.cmd;
    const cwd = cwdOf(pid); // working directory column: the matching process
    let sessionCwd = cwd;
    if (!settingsFromCmd(settingsCmd)) {
      for (let i = descendants.length - 1; i >= 0; i--) {
        const u = settingsFromCmd(descendants[i].cmd);
        if (u) { settingsCmd = descendants[i].cmd; sessionCwd = cwdOf(descendants[i].pid) || sessionCwd; break; }
      }
    }
    const settings = settingsFromCmd(settingsCmd);
    const session = newestSession(sessionCwd, env);
    // SIGTERM (to descendants and the target) goes only to a pid whose start time at sending matches the one collected.
    // The counter of aborted targets grows only when the SIGTERM to the target was actually sent; the aborted.tsv row is written
    // only after that signal, because a session row for a session nobody stopped would make a wrong --resume.
    signals += send(tree); // post-order: deepest first
    const sentToTarget = send([{ pid, start: target.start }]);
    signals += sentToTarget;
    n += sentToTarget;
    if (sentToTarget > 0) { try { appendFileSync(join(dir, ABORTED_FILE), `${timestamp()}\t${pid}\t${settings}\t${cwd}\t${session}\n`); } catch { /* writing the record does not block the signals */ } }
    skipped += tree.filter((d) => typeof d.start !== 'string').length + (typeof target.start !== 'string' ? 1 : 0);
    collected.push({ pid, start: target.start }, ...tree);
  }
  if (skipped > 0) { try { appendFileSync(join(dir, LOG_FILE), `${timestamp()} skipped ${skipped} tree processes without a start time (no signal and no SIGKILL)\n`); } catch { /* log failure does not block the signals */ } }
  if (signals > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, killDelayMs); // blocking wait (the round is blocked anyway)
    // Descendants created while the signals were in flight (between SIGTERM and SIGKILL) are not in the collected tree: walk the
    // trees of surviving targets again before SIGKILL. Start times are compared, so a dead or reused pid gets nothing.
    const fresh = [];
    for (const entry of collected) {
      if (!isAlive(entry.pid) || statField(entry.pid, 22) !== entry.start) continue; // dead, or pid taken by another process
      const subtree = descendantTree(entry.pid, protectedSet);
      if (statField(entry.pid, 22) !== entry.start) continue; // pid taken during the walk: its descendants are not targets
      for (const d of subtree) {
        if (!seen.has(d.pid)) { seen.add(d.pid); fresh.push(d); } // d.start is the start time found at the first walk
      }
    }
    for (const entry of [...fresh, ...collected]) if (isAlive(entry.pid) && statField(entry.pid, 22) === entry.start) { try { process.kill(entry.pid, 'SIGKILL'); } catch { /* gone in the meantime */ } }
  }
  return n;
}

// Id of the session (newest .jsonl transcript in the working directory, as the coordinator's guard used it) for --resume; '' when there is none.
function newestSession(cwd, env) {
  if (!cwd) return '';
  const dir = join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', cwd.replaceAll(/[/.]/g, '-'));
  let list;
  try { list = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs })); } catch { return ''; }
  if (!list.length) return '';
  list.sort((a, b) => b.m - a.m);
  return list[0].f.replace(/\.jsonl$/, '');
}

// One round: key and quota (always a fresh read), level from the thresholds, pool markers, state file and log.
// A read error keeps the state and waits 60 s.
async function runRound(profile, env, previous) {
  const dir = profile.quota.pool.dir;
  const pattern = profile.quota.stopPattern;
  const markers = profile.quota.pool.markers;
  const logLine = (t) => appendFileSync(join(dir, LOG_FILE), `${timestamp()} ${t}\n`);
  const key = readKey(profile, env);
  const url = quotaUrl(profile, env);
  if (key.error || !url) { logLine('error or incomplete quota read, state unchanged'); return { waitMs: 60_000 }; }
  const quotaRead = await readQuota(profile, env, key.key, { fresh: true });
  if (quotaRead.error) { logLine('error or incomplete quota read, state unchanged'); return { waitMs: 60_000 }; }
  const limits = quotaRead.data?.data?.limits;
  const p5 = windowPercent(limits?.find((l) => l?.unit === 3));
  const week = windowPercent(limits?.find((l) => l?.unit === 6));
  if (p5 === undefined || week === undefined) { logLine('incomplete read (no 5 h or weekly window), state unchanged'); return { waitMs: 60_000 }; }
  const bounds = thresholds(profile);
  const level = quotaLevel(p5, week, bounds) ?? QUOTA_LEVELS.WORK;
  const pausePath = join(dir, markers.pause);
  const stop = join(dir, markers.stop);
  let aborted = 0;
  if (level === QUOTA_LEVELS.STOP) { touchFile(pausePath); touchFile(stop); aborted = stopMatching(pattern, dir, env); }
  else if (level === QUOTA_LEVELS.PAUSE) { touchFile(pausePath); removeFile(stop); }
  else { removeFile(pausePath); removeFile(stop); }
  writeFileSync(join(dir, markers.state), `${level} ${p5} ${week} ${timestamp()}\n`);
  if (level !== previous || aborted > 0) {
    logLine(`${previous ?? 'start'} -> ${level} (5 h window ${p5} %, week ${week} %, thresholds ${bounds.pause}/${bounds.stop})${aborted ? `, aborted runs: ${aborted} (see ${ABORTED_FILE})` : ''}`);
  }
  return { level, waitMs: Math.max(p5, week) >= 85 ? 20_000 : 60_000 };
}

function main() {
  let profile;
  try { profile = loadProfile(process.env).profile; } catch (e) { fail(e.exit ?? 2, mask(e.message)); }
  const dir = profile.quota.pool.dir;
  if (!dir) fail(2, 'no pool directory: set quota.pool.dir or OMC_PROVIDER_POOL_DIR (there is no default); nothing is written');
  const pattern = profile.quota.stopPattern;
  if (!pattern) fail(2, 'no stop pattern: set quota.stopPattern or OMC_PROVIDER_STOP_PATTERN (there is no default); nothing is written');
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) { fail(2, `pool directory cannot be created (${e.message}); state unchanged`); }

  const once = process.argv.includes('--once');
  let previous = null;
  try { previous = readFileSync(join(dir, profile.quota.pool.markers.state), 'utf8').trim().split(' ')[0] || null; } catch { /* no state from earlier rounds */ }
  const loop = async () => {
    let consecutiveErrors = 0;
    for (;;) {
      let result;
      try {
        result = await runRound(profile, process.env, previous);
        consecutiveErrors = 0;
      } catch (e) {
        // An exception ends nothing: the error goes to the log (also when the log itself fails), the loop waits 60 s and goes on.
        // After 5 consecutive errors the guard exits with code 1, so its absence is visible.
        consecutiveErrors += 1;
        try { appendFileSync(join(dir, LOG_FILE), `${timestamp()} round error (${mask(String(e?.message ?? e))}); continuing after 60 s (consecutive errors: ${consecutiveErrors}/5)\n`); } catch { /* log failure does not end the guard */ }
        if (once) fail(1, `round error (${mask(String(e?.message ?? e))}); one-round run (--once) aborted`);
        if (consecutiveErrors >= 5) fail(1, '5 consecutive round errors; guard stopped; the pool keeps its PAUSE and STOP markers as they are');
        await new Promise((r) => setTimeout(r, 60_000));
        continue;
      }
      if (result.level !== undefined) previous = result.level;
      if (once) return 0;
      await new Promise((r) => setTimeout(r, result.waitMs));
    }
  };
  loop().then((code) => process.exit(code), (e) => fail(1, `loop error (${e.message}); guard stopped`));
}

if (require.main === module) main();

module.exports = { runRound, stopMatching, sendSigterm, descendantTree, checkCandidate, newestSession, touchFile, removeFile, windowPercent }; // exports for tests
