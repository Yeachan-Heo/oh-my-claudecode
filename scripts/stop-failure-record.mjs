#!/usr/bin/env node
/* global process */
/**
 * StopFailure hook that records the session's last API error.
 *
 * Opt-in (OMC_JEV_STOP_FAILURE=1; off by default). Claude Code sends the
 * StopFailure event when a session ended with an error instead of a normal
 * Stop; the hook records the error code and its class so API-failure data
 * (rate limits, billing errors, misconfiguration) is available outside the
 * session. The hook is write-only: exit code 0 always, empty stdout, nothing
 * blocked or warned (an error lets the session pass through).
 *
 * Input: the JSON object on stdin (StopFailure): the common hook fields
 * (session_id, transcript_path, cwd) plus error (one of the known error
 * codes), error_details and last_assistant_message (optional strings). The
 * only data source is stdin; the only directory the hook uses is its own
 * state directory (transcript_path is never opened).
 *
 * Error classes: a code is transient (the session can resume), configuration
 * (the account or settings need a person; the session alone cannot fix it),
 * task-content (the call's content is at fault) or unknown (anything else,
 * including a missing or non-string error field).
 *
 * Records:
 *   <session error file>              the session's current error, replaced
 *                                     atomically (temp file with mode 0600 in
 *                                     the same directory, then renamed over;
 *                                     the temp file is removed on failure).
 *                                     The path comes from the canonical session
 *                                     path helper (resolveSessionStatePathsForHook
 *                                     of lib/state-root.mjs):
 *                                     <state root>/state/sessions/<session>/error.json,
 *                                     resolved at the hook boundary and passed to
 *                                     writeErrorJson. With OMC_JEV_STOP_FAILURE_DIR
 *                                     set it is <that dir>/<session>.error.json.
 *                                     A session id the helper does not accept has
 *                                     no error file; errors.jsonl still gets its line.
 *   <state dir>/errors.jsonl          one line per failure: ts, session_id,
 *                                     error, errorClass and prompt_id when
 *                                     the payload carries it, appended as one
 *                                     write on a descriptor opened with
 *                                     O_APPEND and O_NOFOLLOW (a symlink in
 *                                     place of the file is refused), under an
 *                                     exclusive lock (errors.jsonl.lock) that
 *                                     is retried for up to 1 s; without the
 *                                     lock in that time the append is skipped
 *                                     (a lost append costs nothing, the
 *                                     .error.json exists anyway). When the
 *                                     file passes the rotation threshold
 *                                     (checked under the lock) it is moved to
 *                                     errors.jsonl.1 (one copy) before the
 *                                     append.
 *
 * The state directory (the one of errors.jsonl) is created with mode 0700 and
 * checked (lstat): it must be a directory (not a symlink) owned by the current
 * user; wider modes are reduced with chmod to 0700. A failure here means
 * nothing is written.
 *
 * Environment:
 *   OMC_JEV_STOP_FAILURE           "1" enables the hook; anything else keeps
 *                                  it off (default).
 *   OMC_JEV_STOP_FAILURE_DIR       state directory of errors.jsonl and of
 *                                  the <session>.error.json files; default: the
 *                                  Jev log directory (OMC_JEV_LOG_DIR, else the
 *                                  state root's state/jev) for errors.jsonl,
 *                                  and the session state path for the error file.
 *   OMC_JEV_STOP_FAILURE_MAX_B     errors.jsonl rotation threshold in bytes
 *                                  (default 1048576).
 *
 * Fail-open: every error (bad JSON, missing fields, a write error, the time
 * limit of 4 s) ends the hook with code 0 and at most one stderr line; the
 * session flows on.
 */

import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { withStateFileLockAtPathSync } from './lib/atomic-write.mjs';
import { readStdin } from './lib/stdin.mjs';
import { resolveOmcStateRoot, resolveSessionStatePathsForHook } from './lib/state-root.mjs';

/** Error codes per class: transient, configuration, task-content. Anything else is unknown. */
export const ERROR_CLASSES = {
  transient: new Set(['rate_limit', 'overloaded', 'server_error']),
  config: new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'billing_error', 'cloud_credential_error', 'model_not_found']),
  task: new Set(['invalid_request', 'max_output_tokens']),
};
export const UNKNOWN_CLASS = 'unknown';
export const RECORD_LIMIT_CHARS = 300;
/** Longest wait for the errors.jsonl lock; after it the append is skipped. */
export const APPEND_LOCK_MAX_MS = 1000;
/** Time limit of the whole hook; after it the hook passes through with code 0. */
export const TIME_LIMIT_MS = 4000;
const APPEND_LOCK_ATTEMPTS = 100; // retries of 10 ms inside the lock helper; the deadline above ends them first
const APPEND_LOCK_SQLITE_TIMEOUT_MS = 500;
const APPEND_LOCK_PROBE_TIMEOUT_MS = 500;

export const stopFailureEnabled = (env = process.env) => String(env.OMC_JEV_STOP_FAILURE ?? '').trim() === '1';

/** OMC_JEV_STOP_FAILURE_MAX_B: a positive integer, else the 1 MiB default. */
export function rotationThresholdOf(env = process.env) {
  const value = Number(String(env.OMC_JEV_STOP_FAILURE_MAX_B ?? '').trim());
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1_048_576;
}

/** The session id cleaned for file names: characters outside [A-Za-z0-9_-] become "_", at most 200 characters; empty or non-string = "no-session". */
export function cleanSessionId(sid) {
  if (typeof sid !== 'string') return 'no-session';
  return sid.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 200) || 'no-session';
}

/** The error's class by the ERROR_CLASSES map; a non-string or an unknown code is "unknown". */
export function classifyError(error) {
  if (typeof error === 'string') {
    for (const [className, codes] of Object.entries(ERROR_CLASSES)) {
      if (codes.has(error)) return className;
    }
  }
  return UNKNOWN_CLASS;
}

/** First `limit` characters of a string; a non-string is empty. */
export function headOf(text, limit = RECORD_LIMIT_CHARS) {
  return typeof text === 'string' ? text.slice(0, limit) : '';
}

/** Last `limit` characters of a string; a non-string is empty. */
export function tailOf(text, limit = RECORD_LIMIT_CHARS) {
  return typeof text === 'string' ? text.slice(-limit) : '';
}

/** The hook's state directory: OMC_JEV_STOP_FAILURE_DIR, else the Jev log directory. */
export async function resolveStateDir(env = process.env, cwd = process.cwd()) {
  const fromEnv = String(env.OMC_JEV_STOP_FAILURE_DIR ?? '').trim();
  if (fromEnv) return fromEnv;
  if (String(env.OMC_JEV_LOG_DIR ?? '').trim()) return String(env.OMC_JEV_LOG_DIR).trim();
  try {
    const root = await resolveOmcStateRoot(cwd);
    return join(root, 'state', 'jev');
  } catch {
    try { return join(homedir(), '.omc', 'state', 'jev'); } catch { return '.omc/state/jev'; }
  }
}

const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/; // the pattern of the canonical session path helper

/**
 * The file of the session's current error, resolved at the hook boundary: <OMC_JEV_STOP_FAILURE_DIR>/<session>.error.json when that
 * variable is set (the session id cleaned for a file name), otherwise the session state path of the canonical helper (file name
 * error.json) for the session id as the payload gives it. A missing session id, one the helper does not accept, or a helper that
 * throws gives '' (no error file).
 */
export async function resolveErrorPath(env, cwd, dir, data) {
  if (String(env.OMC_JEV_STOP_FAILURE_DIR ?? '').trim()) return join(dir, cleanSessionId(data.session_id) + '.error.json');
  const session = data.session_id;
  if (typeof session !== 'string' || !SESSION_ID_PATTERN.test(session)) return '';
  try {
    return (await resolveSessionStatePathsForHook(cwd, 'stop-failure', session, { fileName: 'error.json' })).writePath || '';
  } catch {
    return '';
  }
}

/**
 * Create the state directory (mode 0700) and check it: a directory (not a
 * symlink), owned by the current user, wider modes reduced to 0700. Throws
 * when the directory is not usable for records.
 */
export function prepareStateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory()) throw new Error('state dir is not a directory (a symlink or a file)');
  if (process.getuid && info.uid !== process.getuid()) throw new Error('state dir is not owned by the current user');
  if (info.mode & 0o077) chmodSync(dir, 0o700);
}

/** The record of the session's current error: ts, session_id, error, errorClass, details (first 300), tail (last 300), prompt_id when present. */
export function errorRecord(data, session) {
  const record = {
    ts: new Date().toISOString(),
    session_id: session,
    error: typeof data.error === 'string' ? data.error : '',
    errorClass: classifyError(data.error),
    details: headOf(data.error_details),
    tail: tailOf(data.last_assistant_message),
  };
  if (typeof data.prompt_id === 'string') record.prompt_id = data.prompt_id;
  return record;
}

/** Atomically replace the error file at `path`: temp file 0600 in the same directory, renamed over; the temp file is removed on failure. */
export function writeErrorJson(path, record) {
  const dir = dirname(path);
  const temp = join(dir, record.session_id + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp');
  try {
    mkdirSync(dir, { recursive: true });
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(record), 'utf8');
      closeSync(fd);
    } catch (error) {
      try { closeSync(fd); } catch { /* closed */ }
      try { rmSync(temp, { force: true }); } catch { /* best effort */ }
      throw error;
    }
    renameSync(temp, path);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* already moved or gone */ }
    throw error;
  }
  return path;
}

/** The JSONL line fields of errors.jsonl: ts, session_id, error, errorClass and prompt_id when the record has it. */
export function jsonlRowOf(record) {
  const row = { ts: record.ts, session_id: record.session_id, error: record.error, errorClass: record.errorClass };
  if ('prompt_id' in record) row.prompt_id = record.prompt_id;
  return row;
}

/** errors.jsonl: O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW (the last where the platform has it), mode 0600. */
function openErrorsLog(path) {
  const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW = 0 } = constants;
  return openSync(path, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o600);
}

/**
 * Append one line to errors.jsonl under an exclusive lock (errors.jsonl.lock,
 * retried for up to APPEND_LOCK_MAX_MS) and rotate it first when the file
 * passed the threshold: checked under the lock, the file is moved to
 * errors.jsonl.1 (one copy) and reopened, so the fresh file carries only the
 * new line. Returns true when the line was appended and false when the lock
 * was not obtained in time (the line is then skipped). A symlink in place of
 * the file is refused (O_NOFOLLOW) and throws.
 */
export function appendErrorsJsonl(dir, record, threshold) {
  const path = join(dir, 'errors.jsonl');
  const line = JSON.stringify(jsonlRowOf(record)) + '\n';
  let fd = -1;
  try {
    const result = withStateFileLockAtPathSync(
      `${path}.lock`,
      () => {
        // Open the journal after acquiring the lock to prevent stale file descriptors after rotation
        fd = openErrorsLog(path);
        try {
          if (statSync(path).size > threshold) {
            renameSync(path, path + '.1');
            closeSync(fd);
            fd = openErrorsLog(path);
          }
          writeSync(fd, line);
        } finally {
          if (fd >= 0) closeSync(fd);
          fd = -1;
        }
      },
      true,
      APPEND_LOCK_ATTEMPTS,
      APPEND_LOCK_SQLITE_TIMEOUT_MS,
      APPEND_LOCK_PROBE_TIMEOUT_MS,
      APPEND_LOCK_MAX_MS,
    );
    return result.acquired || Boolean(result.callbackRan);
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

// --- main ---------------------------------------------------------------------

export async function main(argv, stdin, env = process.env, cwd = process.cwd()) {
  let data;
  try {
    data = JSON.parse(stdin);
  } catch {
    return 0;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 0;
  if (data.hook_event_name !== 'StopFailure') return 0;
  if (!stopFailureEnabled(env)) return 0;
  try {
    const session = cleanSessionId(data.session_id);
    const dir = await resolveStateDir(env, cwd);
    prepareStateDir(dir);
    const record = errorRecord(data, session);
    const errorPath = await resolveErrorPath(env, cwd, dir, data);
    if (errorPath) writeErrorJson(errorPath, record);
    appendErrorsJsonl(dir, record, rotationThresholdOf(env));
  } catch (error) {
    try {
      console.error('[stop-failure-record] passing through after an error: ' + (error && error.name ? error.name : 'Error'));
    } catch {
      // stderr itself failed
    }
  }
  return 0;
}

/* istanbul ignore next */
if (process.argv[1] && /stop-failure-record\.mjs$/.test(process.argv[1])) {
  // The hook's own time limit, armed before stdin is read (an input that never closes ends here too):
  // the hook ends with code 0 and one stderr line.
  setTimeout(() => {
    try {
      console.error('[stop-failure-record] passing through after an error: TimeLimit');
    } catch {
      // stderr itself failed
    }
    process.exit(0);
  }, TIME_LIMIT_MS).unref();
  readStdin(TIME_LIMIT_MS)
    .catch(() => '') // closed stdin: an empty input, the JSON error path
    .then((stdin) => main(process.argv.slice(2), stdin))
    .then(
      () => process.exit(0),
      () => process.exit(0),
    );
}
