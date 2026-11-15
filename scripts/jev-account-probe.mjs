#!/usr/bin/env node
/* global process, console, Buffer */
/**
 * Account payment alarm probe for the Jev endpoint (HTTP 402). Facts from local state files only
 * (breaker files and Jev logs): no network, no keys.
 *
 *   node scripts/jev-account-probe.mjs [--state-dir <dir>] [--log-dir <dir>] [--alarm-file <file>] [--json] [--now <epoch ms>]
 *
 * The endpoint has no balance endpoint or balance headers, so the probe reads the traces of a 402 left in local files:
 *   <state>/<scope>/breaker.json  the shared breaker {until, reason, since[, since_all]} (scripts/lib/jev-breaker.mjs);
 *                       it is never deleted, only overwritten by the next opening; after Jev is back the old one stays
 *                       with `until` in the past. One directory per endpoint and key.
 *   <state>/openings/<ms>-*.json  one file per opening of the breaker {ts, reason, ...}; a 402 has reason "http-402"
 *                       (written with OMC_JEV_BREAKER_TIMEOUT_LOW=1).
 *   shadow.jsonl        the Jev request log: a row with `jev` (an object) is a successful Jev answer; a row with error.status
 *                       402 is the 402 itself (written even with the breaker off); a row with mode "breaker" is a request
 *                       the open breaker held back, not an answer.
 *   compact.jsonl       a second trace of a successful answer: a row with a numeric `jev_noul`, or an event "compact" with
 *                       result "jev" (the compaction module asks Jev itself).
 * The alarm holds when rule A or rule B holds:
 *   A  the last 402 of the last 24 h (the latest of the breaker openings with reason http-402 and the shadow.jsonl rows with
 *      an error 402) has no successful Jev answer after it (needs a readable answer log; an older 402 without an answer is
 *      an unused Jev, not a payment alarm);
 *   B  a breaker.json has reason "http-402" and `until` in the future (at most 30 min + 1 min ahead; further is a broken
 *      file, as in the breaker library).
 * Alarm file: one line "<epoch s of the write> <text>"; while the alarm lasts the file is rewritten on EVERY run (a fresh
 * time) so that a reader can ignore a file older than 30 minutes (a dead probe does not hold an old alarm). No alarm: the
 * file is removed. <alarm dir>/account-probe.jsonl gets a row only when the alarm state changes (no rotation; it grows only
 * on a change, so slowly).
 * Directories: <state> = --state-dir, else OMC_JEV_BREAKER_DIR, else ~/.omc/state/jev/breaker; logs (shadow.jsonl,
 * compact.jsonl) from --log-dir, else OMC_JEV_LOG_DIR, else ~/.omc/state/jev; the alarm file is --alarm-file, else
 * <state>/account-alarm.txt.
 * Exit codes: 0 no alarm, 3 alarm, 2 read error (a broken breaker.json, an unreadable directory); a read error leaves an
 * existing alarm file alone.
 */
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const BREAKER_MAX_MS = 1800_000;
const SLACK_MS = 60_000;
const TAIL_START = 4 << 20;
const TAIL_MAX = 256 << 20;
const RULE_A_MAX_MS = 24 * 3600_000; // rule A only for a 402 of the last 24 h

function parseArgs(argv) {
  const result = { json: false, stateDir: null, logDir: null, alarmFile: null, now: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') result.json = true;
    else if (argv[i] === '--state-dir' && argv[i + 1]) result.stateDir = argv[++i];
    else if (argv[i] === '--log-dir' && argv[i + 1]) result.logDir = argv[++i];
    else if (argv[i] === '--alarm-file' && argv[i + 1]) result.alarmFile = argv[++i];
    else if (argv[i] === '--now' && /^\d+$/.test(argv[i + 1] ?? '')) result.now = Number(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return result;
}

/** A JSON file: undefined when it is absent; throws when it cannot be read or parsed. */
function readJsonFile(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
  return JSON.parse(text);
}

/** JSONL rows from the end of a file (the last `bytes` bytes, the first partial line dropped); fromStart: read from the file start. Unparsable lines are skipped. */
function tail(path, bytes) {
  let fd;
  try { fd = openSync(path, 'r'); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    let lines = buffer.subarray(0, read).toString('utf8').split('\n');
    if (start > 0) lines = lines.slice(1);
    const rows = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { const row = JSON.parse(line); if (row && typeof row === 'object') rows.push(row); } catch { /* a partial or damaged line */ }
    }
    return { rows, fromStart: start === 0 };
  } finally { closeSync(fd); }
}

const toMs = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };

/** A log read from its end until its oldest row reaches the last known 402 (or the whole file). null: no such file. */
function scan(path, known402, collect) {
  for (let bytes = TAIL_START; ; bytes *= 4) {
    const result = tail(path, bytes);
    if (!result) return null;
    const oldest = result.rows.map((row) => toMs(row.ts)).find((t) => t !== null);
    if (result.fromStart || bytes >= TAIL_MAX || (known402 !== null && oldest !== undefined && oldest <= known402)) {
      for (const row of result.rows) collect(row);
      return true;
    }
  }
}

function local(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const iso = (t) => (t === null ? null : new Date(t).toISOString());

/** The breaker.json of every endpoint directory under the state directory; a broken one throws (read error). */
function readBreakers(stateDir) {
  const breakers = [];
  let names = [];
  try { names = readdirSync(stateDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  for (const name of names) {
    const breaker = readJsonFile(join(stateDir, name, 'breaker.json'));
    if (breaker === undefined) continue;
    if (breaker === null || typeof breaker !== 'object' || Array.isArray(breaker)) throw new Error(`${name}/breaker.json is not an object`);
    breakers.push(breaker);
  }
  return breakers;
}

export function probe(argv, env = process.env) {
  const args = parseArgs(argv);
  const now = args.now ?? Date.now();
  const defaultLogDir = join(homedir(), '.omc', 'state', 'jev');
  const stateDir = args.stateDir ?? env.OMC_JEV_BREAKER_DIR ?? join(defaultLogDir, 'breaker');
  const logDir = args.logDir ?? env.OMC_JEV_LOG_DIR ?? defaultLogDir;
  const alarmFile = args.alarmFile ?? join(stateDir, 'account-alarm.txt');

  const breakers = readBreakers(stateDir); // a throw is a read error (exit 2)

  let last402 = null;
  const times402 = [];
  let openingNames = [];
  try { openingNames = readdirSync(join(stateDir, 'openings')).filter((n) => n.endsWith('.json')).sort().slice(-200); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  for (const name of openingNames) {
    let opening;
    try { opening = readJsonFile(join(stateDir, 'openings', name)); } catch { continue; } // a single broken opening file does not stop the probe
    if (opening && String(opening.reason) === 'http-402' && Number.isFinite(opening.ts)) { last402 = Math.max(last402 ?? 0, opening.ts); times402.push(opening.ts); }
  }

  let lastSuccess = null;
  const success = (t) => { if (t !== null) lastSuccess = Math.max(lastSuccess ?? 0, t); };
  const shadowLog = scan(join(logDir, 'shadow.jsonl'), last402, (row) => {
    const t = toMs(row.ts);
    if (t === null) return;
    if (row.error && row.error.status === 402) { last402 = Math.max(last402 ?? 0, t); times402.push(t); }
    else if (row.jev && typeof row.jev === 'object') success(t);
  });
  const compactLog = scan(join(logDir, 'compact.jsonl'), last402, (row) => {
    if (Number.isFinite(row.jev_noul) || (row.event === 'compact' && row.result === 'jev')) success(toMs(row.ts));
  });
  const readableLog = shadowLog === true || compactLog === true;

  const openBreaker = breakers
    .filter((b) => b.reason === 'http-402' && Number.isFinite(b.until) && b.until > now && b.until <= now + BREAKER_MAX_MS + SLACK_MS)
    .sort((a, b) => b.until - a.until)[0];
  const breaker402 = openBreaker !== undefined;
  const ruleA = readableLog && last402 !== null && now - last402 <= RULE_A_MAX_MS && (lastSuccess === null || lastSuccess <= last402);
  const alarm = breaker402 || ruleA;
  // Start of the current error: the earliest 402 after the last successful answer (with an open breaker also its `since`).
  const afterSuccess = times402.filter((t) => lastSuccess === null || t > lastSuccess);
  if (breaker402 && Number.isFinite(openBreaker.since)) afterSuccess.push(openBreaker.since);
  const from = afterSuccess.length ? Math.min(...afterSuccess) : null;
  const line = alarm
    ? `Jev account: payment error 402 since ${from === null ? 'an unknown time' : local(from)} (last ${last402 === null ? 'unknown' : local(last402)}), ${breaker402 ? `request breaker until ${local(openBreaker.until)}` : 'the breaker has expired, but Jev has not answered since'}. Top up the account of the Jev endpoint.`
    : null;
  return {
    alarm, rule: alarm ? (breaker402 ? 'B' : 'A') : null, line, alarmFile, stateDir, logDir,
    last402: iso(last402), lastSuccess: iso(lastSuccess), from: iso(from), breakerUntil: breaker402 ? iso(openBreaker.until) : null,
    logReadable: readableLog, now: iso(now),
  };
}

/** Output files: the alarm file written or removed, a probe row only when the alarm state changes. */
export function writeOutputs(result) {
  const probeLog = join(dirname(result.alarmFile), 'account-probe.jsonl');
  let previous = false;
  try {
    const lines = readFileSync(probeLog, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length) previous = JSON.parse(lines[lines.length - 1]).alarm === true;
  } catch { /* no file or a damaged last line: the previous state is no alarm */ }
  if (result.alarm) {
    mkdirSync(dirname(result.alarmFile), { recursive: true });
    // The write time in the content (epoch s), refreshed on every run: a reader ignores a file older than 30 minutes.
    const temp = `${result.alarmFile}.${process.pid}.tmp`;
    writeFileSync(temp, `${Math.floor(Date.parse(result.now) / 1000)} ${result.line}\n`, 'utf8');
    renameSync(temp, result.alarmFile);
  } else if (existsSync(result.alarmFile)) rmSync(result.alarmFile, { force: true });
  if (result.alarm !== previous) {
    mkdirSync(dirname(probeLog), { recursive: true });
    appendFileSync(probeLog, `${JSON.stringify({ ts: result.now, alarm: result.alarm, rule: result.rule, last402: result.last402, lastSuccess: result.lastSuccess })}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = probe(process.argv.slice(2));
    writeOutputs(result);
    if (process.argv.includes('--json')) console.log(JSON.stringify(result));
    else console.log(result.alarm ? `ALARM: ${result.line}` : 'ok: no account payment alarm for the Jev endpoint');
    process.exit(result.alarm ? 3 : 0);
  } catch (error) {
    console.error(`jev-account-probe: read error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
