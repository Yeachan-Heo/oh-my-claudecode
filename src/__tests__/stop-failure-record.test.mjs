/**
 * Tests for the StopFailure hook (scripts/stop-failure-record.mjs, opt-in
 * OMC_JEV_STOP_FAILURE=1). The hook runs as Claude Code runs it: a node
 * subprocess reading the hook input from stdin, state dir in a temp dir, one
 * lane per test. Cases follow the hook test the port is based on: all known
 * error codes fall into their class, unknown and missing fall back to
 * unknown; the .error.json record keeps the contract fields, the 300-char
 * trims, an ISO ts and the file modes; prompt_id is recorded only when the
 * payload carries it; errors.jsonl lines keep the JSONL fields, parallel
 * calls append cleanly; session ids are sanitized and never escape the state
 * dir; rotation moves the log to errors.jsonl.1; a symlinked log or state dir
 * and a held lock never block the hook, and every input error passes through
 * with code 0; with the switch off nothing is written.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { afterEach, describe, expect, it } from 'vitest';

import { acquireStateFileLockAtPathSync, releaseStateFileLockSync } from '../../scripts/lib/atomic-write.mjs';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const HOOK = join(ROOT, 'scripts', 'stop-failure-record.mjs');

const ERROR_CODES = [
  'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required',
  'billing_error', 'rate_limit', 'overloaded', 'invalid_request', 'model_not_found',
  'server_error', 'unknown', 'max_output_tokens', 'cloud_credential_error',
];
const EXPECTED_CLASSES = {
  transient: ['rate_limit', 'overloaded', 'server_error'],
  config: [
    'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold',
    'verification_required', 'billing_error', 'cloud_credential_error', 'model_not_found',
  ],
  task: ['invalid_request', 'max_output_tokens'],
  unknown: ['unknown', 'some_new_code_outside_the_list'],
};

let lane;

const laneOf = (name) => {
  if (!lane) lane = mkdtempSync(join(tmpdir(), 'stop-failure-'));
  const dir = join(lane, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** Run the hook the way Claude Code runs it: stdin JSON, temp state dir. */
const run = (data, stateDir, extraEnv = {}, rawInput) => spawnSync(process.execPath, [HOOK], {
  input: rawInput !== undefined ? rawInput : JSON.stringify({
    session_id: 's-sfr',
    transcript_path: '/never/opened/transcript.jsonl',
    cwd: '/tmp/project',
    hook_event_name: 'StopFailure',
    ...data,
  }),
  encoding: 'utf8',
  env: { ...process.env, OMC_JEV_STOP_FAILURE: '1', OMC_JEV_STOP_FAILURE_DIR: stateDir, ...extraEnv },
});

const readError = (state, session) => {
  const path = join(state, session + '.error.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
};

const jsonlRows = (state) => {
  const path = join(state, 'errors.jsonl');
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  if (!text.trim()) return [];
  return text.trimEnd().split('\n').map((row) => JSON.parse(row));
};

describe('stop-failure-record hook', () => {
  it('classifies every known code into its class; unknown, missing and non-string fall back to unknown', () => {
    const state = join(laneOf('classification'), 'state');
    const check = (error, expectedClass, id) => {
      const r = run({ session_id: id, error }, state);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      const record = readError(state, id);
      expect(record, 'missing record for ' + id).toBeTruthy();
      expect(record.errorClass).toBe(expectedClass);
    };
    for (const [className, codes] of Object.entries(EXPECTED_CLASSES)) {
      for (const code of codes) check(code, className, 's-' + code);
    }
    check(123, 'unknown', 's-nonstring');
    check(null, 'unknown', 's-null');
    const rMissing = run({ session_id: 's-no-error' }, state);
    expect(rMissing.status).toBe(0);
    expect(readError(state, 's-no-error').errorClass).toBe('unknown');
    const covered = new Set(Object.values(EXPECTED_CLASSES).flat());
    for (const code of ERROR_CODES) expect(covered.has(code), 'missing code ' + code).toBe(true);
  });

  it('.error.json: contract fields, 300-char trims, ISO ts, file modes, atomic replace', () => {
    const state = join(laneOf('contract'), 'state');
    const details = 'D'.repeat(500) + 'END-DETAILS';
    const message = 'A'.repeat(400) + 'TAIL-MARKER-SFR';
    const r = run({
      session_id: 's-contract',
      error: 'billing_error',
      error_details: details,
      last_assistant_message: message,
    }, state);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
    expect(existsSync(state)).toBe(true);
    const dirMode = lstatSync(state).mode & 0o777;
    expect(dirMode).toBe(0o700);
    const filePath = join(state, 's-contract.error.json');
    const fileMode = lstatSync(filePath).mode & 0o777;
    expect(fileMode).toBe(0o600);
    const record = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
    expect(record.session_id).toBe('s-contract');
    expect(record.error).toBe('billing_error');
    expect(record.errorClass).toBe('config');
    expect(record.details).toHaveLength(300);
    expect(record.details).toBe(details.slice(0, 300));
    expect(record.tail).toBe(message.slice(-300));
    expect(record.tail).toHaveLength(300);
    expect(readdirSync(state).some((n) => n.endsWith('.tmp'))).toBe(false);
    const r2 = run({ session_id: 's-contract', error: 'rate_limit' }, state);
    expect(r2.status).toBe(0);
    expect(JSON.parse(readFileSync(filePath, 'utf8')).errorClass).toBe('transient');
  });

  it('prompt_id: recorded when the payload carries it, key absent when it does not', () => {
    const state = join(laneOf('prompt-id'), 'state');
    const r = run({ session_id: 's-pid', error: 'rate_limit', prompt_id: 'prompt-sfr-1' }, state);
    expect(r.status).toBe(0);
    expect(readError(state, 's-pid').prompt_id).toBe('prompt-sfr-1');
    const rows = jsonlRows(state);
    expect(rows).toHaveLength(1);
    expect(rows[0].prompt_id).toBe('prompt-sfr-1');
    const r2 = run({ session_id: 's-pid2', error: 'rate_limit' }, state);
    expect(r2.status).toBe(0);
    expect('prompt_id' in readError(state, 's-pid2')).toBe(false);
    expect(jsonlRows(state)[1].prompt_id).toBeUndefined();
  });

  it('errors.jsonl: contract fields; five parallel calls append clean lines', async () => {
    const state = join(laneOf('jsonl'), 'state');
    const r = run({ session_id: 's-jsonl', error: 'overloaded' }, state);
    expect(r.status).toBe(0);
    const rows = jsonlRows(state);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(['error', 'errorClass', 'session_id', 'ts']);
    expect(rows[0].session_id).toBe('s-jsonl');
    expect(rows[0].error).toBe('overloaded');
    expect(rows[0].errorClass).toBe('transient');
    expect(rows[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => new Promise((resolve) => {
      const child = spawn(process.execPath, [HOOK], {
        env: { ...process.env, OMC_JEV_STOP_FAILURE: '1', OMC_JEV_STOP_FAILURE_DIR: state },
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('close', (code) => resolve({ code, stdout }));
      child.stdin.write(JSON.stringify({
        session_id: 's-parallel',
        transcript_path: '/never/opened/transcript.jsonl',
        cwd: '/tmp/project',
        hook_event_name: 'StopFailure',
        error: 'rate_limit',
      }));
      child.stdin.end();
    })));
    expect(results.every((w) => w.code === 0)).toBe(true);
    expect(results.every((w) => w.stdout === '')).toBe(true);
    const parallelRows = jsonlRows(state);
    expect(parallelRows).toHaveLength(6);
    expect(parallelRows.filter((row) => row.session_id === 's-parallel')).toHaveLength(5);
  });

  it('session id sanitization: 9 vectors, the file never escapes the state dir', () => {
    const laneDir = laneOf('sanitization');
    const state = join(laneDir, 'state');
    const cases = [
      ['3f2a9c1e-0b7d-4e5a-9c1f-2b3c4d5e6f70', '3f2a9c1e-0b7d-4e5a-9c1f-2b3c4d5e6f70'],
      ['a/b..c', 'a_b__c'],
      ['a/../../etc', 'a_______etc'],
      ['X.error', 'X_error'],
      ['', 'no-session'],
      [null, 'no-session'],
      ['x'.repeat(300), 'x'.repeat(200)],
      ['x$(touch p)', 'x__touch_p_'],
      ['a\u0000b', 'a_b'],
    ];
    for (const [input, expected] of cases) {
      const data = { session_id: input, error: 'rate_limit' };
      if (input === null) delete data.session_id;
      const r = run(data, state);
      expect(r.status).toBe(0);
      expect(existsSync(join(state, expected + '.error.json')), 'file for ' + JSON.stringify(input)).toBe(true);
      expect(JSON.parse(readFileSync(join(state, expected + '.error.json'), 'utf8')).session_id).toBe(expected);
    }
    expect(readdirSync(laneDir).sort()).toEqual(['state']);
  });

  it('lone surrogate in error_details: both records written and readable', () => {
    const state = join(laneOf('surrogate'), 'state');
    const r = run({ session_id: 's-surrogate', error: 'billing_error', error_details: '\ud800' }, state);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(readError(state, 's-surrogate')).toBeTruthy();
    expect(jsonlRows(state).length).toBeGreaterThanOrEqual(1);
  });

  it('session id of 300 chars: file named 200 x + .error.json', () => {
    const state = join(laneOf('long-id'), 'state');
    const r = run({ session_id: 'x'.repeat(300), error: 'rate_limit' }, state);
    expect(r.status).toBe(0);
    expect(existsSync(join(state, 'x'.repeat(200) + '.error.json'))).toBe(true);
  });

  it('rotation: errors.jsonl above OMC_JEV_STOP_FAILURE_MAX_B moves to errors.jsonl.1 before the append', () => {
    const state = join(laneOf('rotation'), 'state');
    mkdirSync(state, { recursive: true });
    const rows = [];
    for (let i = 0; i < 20; i += 1) {
      rows.push(JSON.stringify({ ts: new Date().toISOString(), session_id: 's-r' + i, error: 'rate_limit', errorClass: 'transient' }));
    }
    writeFileSync(join(state, 'errors.jsonl'), rows.join('\n') + '\n');
    const r = run({ session_id: 's-r-new', error: 'rate_limit' }, state, { OMC_JEV_STOP_FAILURE_MAX_B: '1000' });
    expect(r.status).toBe(0);
    expect(existsSync(join(state, 'errors.jsonl.1'))).toBe(true);
    expect(jsonlRows(state)).toHaveLength(1);
    const old = readFileSync(join(state, 'errors.jsonl.1'), 'utf8').trimEnd().split('\n');
    expect(old).toHaveLength(20);
    expect(JSON.parse(old[0]).session_id).toBe('s-r0');
  });

  it('a writer that waits for the lock appends to the journal as it is after the rotation, never through a descriptor opened before it', async () => {
    const state = join(laneOf('rotation-race'), 'state');
    mkdirSync(state, { recursive: true });
    const rows = [];
    for (let i = 0; i < 20; i += 1) {
      rows.push(JSON.stringify({ ts: new Date().toISOString(), session_id: 's-old' + i, error: 'rate_limit', errorClass: 'transient' }));
    }
    writeFileSync(join(state, 'errors.jsonl'), rows.join('\n') + '\n');
    const markers = { held: join(state, 'a-holds-the-lock'), waiting: join(state, 'b-is-waiting') };
    const module = pathToFileURL(join(ROOT, 'scripts', 'stop-failure-record.mjs')).href;
    const lockModule = pathToFileURL(join(ROOT, 'scripts', 'lib', 'atomic-write.mjs')).href;
    const record = (id) => `{ ts: new Date().toISOString(), session_id: ${JSON.stringify(id)}, error: 'rate_limit', errorClass: 'transient' }`;
    const pause = (ms) => `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});`;
    const until = (path) => `for (let i = 0; i < 500 && !existsSync(${JSON.stringify(path)}); i++) { ${pause(20)} }`;
    // A holds the lock, lets B start, and appends with the rotation (the journal is over the threshold) while B waits for the lock.
    const holder = `
      import { existsSync, writeFileSync } from 'node:fs';
      import { withStateFileLockAtPathSync } from ${JSON.stringify(lockModule)};
      import { appendErrorsJsonl } from ${JSON.stringify(module)};
      withStateFileLockAtPathSync(${JSON.stringify(join(state, 'errors.jsonl.lock'))}, () => {
        writeFileSync(${JSON.stringify(markers.held)}, '1');
        ${until(markers.waiting)}
        ${pause(500)} // B has had time to open the journal, if it opens it before the lock
        appendErrorsJsonl(${JSON.stringify(state)}, ${record('s-a')}, 1000);
      }, true);
    `;
    const waiter = `
      import { existsSync, writeFileSync } from 'node:fs';
      import { appendErrorsJsonl } from ${JSON.stringify(module)};
      ${until(markers.held)}
      writeFileSync(${JSON.stringify(markers.waiting)}, '1');
      appendErrorsJsonl(${JSON.stringify(state)}, ${record('s-b')}, 1000);
    `;
    const exits = [holder, waiter].map((code) => new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' });
      child.on('exit', resolve);
    }));
    expect(await Promise.all(exits)).toEqual([0, 0]);
    // A rotated the old journal and appended its row to the new file; B's row follows it in the new file and is not in the archive
    expect(jsonlRows(state).map((row) => row.session_id)).toEqual(['s-a', 's-b']);
    const archive = readFileSync(join(state, 'errors.jsonl.1'), 'utf8').trimEnd().split('\n').map((row) => JSON.parse(row).session_id);
    expect(archive).toHaveLength(20);
    expect(archive.every((id) => id.startsWith('s-old'))).toBe(true);
  }, 30_000);

  it('a symlinked errors.jsonl is refused (O_NOFOLLOW): the target stays untouched, .error.json is written, code 0', () => {
    const laneDir = laneOf('symlink-log');
    const state = join(laneDir, 'state');
    mkdirSync(state, { recursive: true });
    const target = join(laneDir, 'target.jsonl');
    writeFileSync(target, 'untouched\n');
    symlinkSync(target, join(state, 'errors.jsonl'));
    const r = run({ session_id: 's-sym-log', error: 'rate_limit' }, state);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr.split('\n').filter((l) => l.trim()).length).toBeLessThanOrEqual(1);
    expect(readFileSync(target, 'utf8')).toBe('untouched\n');
    expect(readError(state, 's-sym-log')?.error).toBe('rate_limit');
  });

  it('a held errors.jsonl lock: the append is skipped after about a second, .error.json is written, code 0; a free lock appends', () => {
    const state = join(laneOf('lock-held'), 'state');
    mkdirSync(state, { recursive: true });
    const held = acquireStateFileLockAtPathSync(join(state, 'errors.jsonl.lock'), 50, true);
    expect(held).toBeTruthy();
    const started = Date.now();
    let r;
    try {
      r = run({ session_id: 's-lock', error: 'rate_limit' }, state);
    } finally {
      releaseStateFileLockSync(held);
    }
    const elapsed = Date.now() - started;
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(elapsed).toBeLessThan(4000);
    expect(readError(state, 's-lock')?.error).toBe('rate_limit');
    expect(jsonlRows(state)).toHaveLength(0);
    const after = run({ session_id: 's-lock-free', error: 'rate_limit' }, state);
    expect(after.status).toBe(0);
    expect(jsonlRows(state).map((row) => row.session_id)).toEqual(['s-lock-free']);
  });

  it('the time limit: a stdin that never closes ends the hook with code 0 after about 4 s, quiet', async () => {
    const state = join(laneOf('time-limit'), 'state');
    const started = Date.now();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [HOOK], { env: { ...process.env, OMC_JEV_STOP_FAILURE: '1', OMC_JEV_STOP_FAILURE_DIR: state } });
      let stdout = '';
      let stderr = '';
      const guard = setTimeout(() => { child.kill(); reject(new Error('the hook did not end by itself')); }, 15_000);
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (code) => { clearTimeout(guard); resolve({ code, stdout, stderr }); });
      child.stdin.write('{"session_id":"s-open"'); // an unfinished object; the pipe stays open
    });
    const elapsed = Date.now() - started;
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr.split('\n').filter((l) => l.trim()).length).toBeLessThanOrEqual(1);
    expect(elapsed).toBeGreaterThanOrEqual(3500);
    expect(elapsed).toBeLessThan(10_000);
    expect(existsSync(state)).toBe(false);
  }, 30_000);

  it('a symlinked state dir: nothing written, code 0', () => {
    const laneDir = laneOf('symlink-dir');
    const target = join(laneDir, 'target');
    mkdirSync(target, { recursive: true });
    const state = join(laneDir, 'state');
    symlinkSync(target, state);
    const r = run({ session_id: 's-sym', error: 'rate_limit' }, state);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(readdirSync(target).length).toBe(0);
    expect(readdirSync(target).every((n) => !n.endsWith('.tmp'))).toBe(true);
  });

  it('fail-open: bad JSON, another event, a file as state dir: code 0, quiet', () => {
    const laneDir = laneOf('fail-open');
    const stateBad = join(laneDir, 'state-bad');
    const rBad = run({}, stateBad, {}, '{bad-json-sfr');
    expect(rBad.status).toBe(0);
    expect(rBad.stdout).toBe('');
    expect(rBad.stderr.split('\n').filter((l) => l.trim()).length).toBeLessThanOrEqual(1);
    const stateOther = join(laneDir, 'state-other');
    const rOther = run({ hook_event_name: 'Stop' }, stateOther);
    expect(rOther.status).toBe(0);
    expect(rOther.stdout).toBe('');
    expect(existsSync(stateOther)).toBe(false);
    const fileAsState = join(laneDir, 'file-as-state');
    writeFileSync(fileAsState, 'x');
    const rFile = run({ session_id: 's-file', error: 'rate_limit' }, fileAsState);
    expect(rFile.status).toBe(0);
    expect(rFile.stdout).toBe('');
    expect(rFile.stderr.split('\n').filter((l) => l.trim()).length).toBeLessThanOrEqual(1);
  });

  it('with the switch off nothing is written', () => {
    const state = join(laneOf('default-off'), 'state');
    const r = run({ session_id: 's-off', error: 'rate_limit' }, state, { OMC_JEV_STOP_FAILURE: '' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(existsSync(state)).toBe(false);
  });

  it('closed stdin: code 0, quiet', () => {
    const state = join(laneOf('closed-stdin'), 'state');
    const closed = spawnSync('/bin/sh', ['-c', 'exec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(HOOK) + ' <&-'], {
      encoding: 'utf8',
      env: { ...process.env, OMC_JEV_STOP_FAILURE: '1', OMC_JEV_STOP_FAILURE_DIR: state },
    });
    expect(closed.status).toBe(0);
    expect(closed.stdout.split('\n').filter((l) => l.trim()).length).toBeLessThanOrEqual(1);
    expect(closed.stderr.split('\n').filter((l) => l.trim()).length).toBeLessThanOrEqual(1);
  });
});

describe('stop-failure-record random contract', () => {
  it('80 random inputs with a fixed seed: code 0, empty stdout, never an allow decision, time under 5 s', { timeout: 240_000 }, () => {
    const mulberry32 = (seed) => {
      let a = seed >>> 0;
      return () => {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 14), 1 | a)) ^ t;
        return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
      };
    };
    const laneDir = laneOf('random-contract');
    const state = join(laneDir, 'state');
    const randomText = (length, rnd) => {
      const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _"\'`$();&\\/*{}\n';
      let result = '';
      for (let i = 0; i < length; i += 1) result += alphabet[Math.floor(rnd() * alphabet.length)];
      return result;
    };
    const generators = [
      (rnd) => ({
        session_id: 's-rand-' + Math.floor(rnd() * 1000),
        error: ERROR_CODES[Math.floor(rnd() * ERROR_CODES.length)],
        ...(rnd() < 0.3 ? { prompt_id: 'p-' + Math.floor(rnd() * 100) } : {}),
        ...(rnd() < 0.5 ? { error_details: randomText(Math.floor(rnd() * 800), rnd) } : {}),
        ...(rnd() < 0.5 ? { last_assistant_message: randomText(Math.floor(rnd() * 800), rnd) } : {}),
      }),
      (rnd) => ({ session_id: '../../etc/rand/' + Math.floor(rnd() * 100) + '/..\\hack', error: ERROR_CODES[Math.floor(rnd() * ERROR_CODES.length)] }),
      (rnd) => {
        const data = { error: ERROR_CODES[Math.floor(rnd() * ERROR_CODES.length)] };
        if (rnd() < 0.5) data.session_id = 42;
        return data;
      },
      (rnd) => ({ session_id: 's-rand-bad-' + Math.floor(rnd() * 1000), error: rnd() < 0.5 ? 'unknown_new_code_' + Math.floor(rnd() * 100) : randomText(8, rnd) }),
      (rnd) => ({ session_id: 's-rand-foreign', error: ERROR_CODES[Math.floor(rnd() * ERROR_CODES.length)], foreign_field: randomText(40, rnd), last_assistant_message: 77 }),
      (rnd) => ({ hook_event_name: ['Stop', 'PreToolUse', 'PostToolUse', 'SessionStart'][Math.floor(rnd() * 4)], session_id: 's-rand-event', error: ERROR_CODES[Math.floor(rnd() * ERROR_CODES.length)] }),
    ];
    let maxMs = 0;
    for (let i = 0; i < 80; i += 1) {
      const rnd = mulberry32(20261116 + i);
      const data = generators[Math.floor(rnd() * generators.length)](rnd);
      const badJson = rnd() < 0.1;
      const start = process.hrtime.bigint();
      const r = run(data, state, {}, badJson ? '{not-json-sfr-' + i : undefined);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      maxMs = Math.max(maxMs, ms);
      expect(r.status, 'exit 0 for case ' + i + ': ' + r.stderr).toBe(0);
      expect(r.stdout.split('\n').filter((l) => l.trim()).length).toBeLessThanOrEqual(1);
      expect(r.stdout.includes('allow')).toBe(false);
      expect(r.stderr.split('\n').filter((l) => l.trim()).length).toBeLessThanOrEqual(1);
      expect(ms, 'time under 5 s (case ' + i + ')').toBeLessThan(5000);
    }
    expect(maxMs).toBeLessThan(5000);
  });
});

afterEach(() => {
  if (lane) {
    try {
      rmSync(lane, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // a temp lane that cannot be removed now is left to the OS
    }
  }
  lane = null;
});

describe('default state directory', () => {
  it('falls back to the home directory when the state root cannot be resolved', () => {
    const home = laneOf('home');
    const pluginRoot = laneOf('plugin');
    mkdirSync(join(pluginRoot, 'dist', 'lib'), { recursive: true });
    writeFileSync(join(pluginRoot, 'dist', 'lib', 'worktree-paths.js'), "export function getOmcRoot() { throw new Error('unresolvable'); }\n");
    const source = `import { resolveStateDir } from ${JSON.stringify(pathToFileURL(HOOK).href)};`
      + ' process.stdout.write(await resolveStateDir({}, process.cwd()));';
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_ROOT: pluginRoot },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(join(home, '.omc', 'state', 'jev'));
  });
});
