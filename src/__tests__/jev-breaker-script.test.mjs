/* global process, setTimeout, clearTimeout */
/**
 * Tests for the opt-in shared Jev breaker and request limit
 * (scripts/lib/jev-breaker.mjs) on the script channel: the library itself,
 * scripts/jev-resolve.mjs in process and as concurrent child processes, and
 * the one-time outage notice in a real hook script (pre-tool-enforcer.mjs).
 *
 * .mjs so vitest picks it up without tsc typechecking the untyped scripts.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  BREAKER_MAX_SECONDS,
  POINT_PRIORITY,
  admitRequest,
  breakerSettings,
  classifyFailure,
  minuteKey,
  outageMessage,
  readBreaker,
  recordFailure,
  reserveRequest,
  retryAfterFromBody,
  retryAfterSeconds,
  thresholdFor,
} from '../../scripts/lib/jev-breaker.mjs';
import { resolveRequest, resolveRequestTimeoutMs } from '../../scripts/jev-resolve.mjs';
import { JUDGMENT_POINTS } from '../hooks/jev/points.ts';
import { resetJevResolverState, resolveJudgment } from '../hooks/jev/resolver.ts';

const root = join(fileURLToPath(import.meta.url), '..', '..', '..');
const NODE = process.execPath;
const RESOLVER = join(root, 'scripts', 'jev-resolve.mjs');
const ENFORCER = join(root, 'scripts', 'pre-tool-enforcer.mjs');

const tmp = mkdtempSync(join(tmpdir(), 'jev-breaker-test-'));
// Detached resolvers may still be closing files: retry the removal (Windows reports EPERM meanwhile).
const cleanups = [() => rmSync(tmp, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 })];
afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

const QUESTIONS = { slop_advisory: { type: 'noul', criteria: { yes: 'advisory', no: 'plain' } } };
const ENDPOINT = 'http://127.0.0.1:9/v1/systemone';
let caseDir = '';
let caseCount = 0;

beforeEach(() => {
  caseCount += 1;
  caseDir = join(tmp, 'case-' + caseCount);
  mkdirSync(caseDir, { recursive: true });
});

/** The parent environment without any Jev or TypeSafe variable, so a developer's own settings never leak in. */
function cleanParentEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('OMC_JEV') && !key.startsWith('TYPESAFE_')) env[key] = value;
  }
  return env;
}

function jevEnv(overrides = {}) {
  return {
    TYPESAFE_API_KEY: 'test-key',
    OMC_JEV: 'slop-warning,model-routing',
    OMC_JEV_LOG_DIR: join(caseDir, 'log'),
    OMC_JEV_BREAKER_DIR: join(caseDir, 'breaker'),
    OMC_JEV_ENDPOINT: ENDPOINT,
    ...overrides,
  };
}

function request(point = 'slop-warning') {
  return { point, state: { toolName: 'Bash' }, questions: QUESTIONS, heuristic: false };
}

function okResponse() {
  return { ok: true, status: 200, json: async () => ({ answers: { slop_advisory: { type: 'noul', noul: false, confidence: 0.9 } } }) };
}

/** A failed response whose body must never be read: the breaker classifies by status and headers only. */
function errorResponse(status, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: false,
    status,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    json: async () => { throw new Error('the body of a failed response must not be read'); },
    text: async () => { throw new Error('the body of a failed response must not be read'); },
  };
}

function countingFetch(handler) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return handler(calls.length);
  };
  return { fetchFn, calls };
}

function logRows(env) {
  const path = join(env.OMC_JEV_LOG_DIR, 'shadow.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

function settingsFor(env) {
  return breakerSettings(env, env.OMC_JEV_ENDPOINT, env.TYPESAFE_API_KEY);
}

/**
 * Run `body(dir)` so that a per-minute count stays inside one UTC minute: it
 * starts after waiting out the last seconds of a minute, and when the run
 * still crossed into the next minute it runs once more on fresh state.
 * Returns what the valid run returned; the caller asserts on it.
 */
async function inOneMinute(body, seconds = 10) {
  for (let attempt = 0; ; attempt += 1) {
    const left = 60_000 - (Date.now() % 60_000);
    if (left < seconds * 1000) await new Promise((resolve) => setTimeout(resolve, left + 50));
    const start = minuteKey();
    const result = await body(join(caseDir, 'attempt-' + attempt));
    if (minuteKey() === start || attempt === 1) return result;
  }
}

describe('jev-breaker library', () => {
  it('is off without OMC_JEV_BREAKER=1 and without a positive OMC_JEV_MAX_RPM', () => {
    expect(breakerSettings({}, ENDPOINT, 'k')).toBeUndefined();
    for (const value of ['0', '', ' ', '1.5', '-3', 'abc', '10rpm']) {
      expect(breakerSettings({ OMC_JEV_MAX_RPM: value }, ENDPOINT, 'k')).toBeUndefined();
    }
    for (const value of ['0', 'true', 'yes', '']) {
      expect(breakerSettings({ OMC_JEV_BREAKER: value }, ENDPOINT, 'k')).toBeUndefined();
    }
    expect(breakerSettings({ OMC_JEV_BREAKER: '1' }, ENDPOINT, 'k')).toMatchObject({ breaker: true, maxRpm: undefined });
    expect(breakerSettings({ OMC_JEV_MAX_RPM: ' 48 ' }, ENDPOINT, 'k')).toMatchObject({ breaker: false, maxRpm: 48 });
  });

  it('keeps one state directory per endpoint and key, without the key in the path', () => {
    const env = { OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: caseDir };
    const a = breakerSettings(env, ENDPOINT, 'secret-key-a').dir;
    expect(breakerSettings(env, ENDPOINT, 'secret-key-a').dir).toBe(a);
    expect(breakerSettings(env, ENDPOINT, 'secret-key-b').dir).not.toBe(a);
    expect(breakerSettings(env, 'https://other.example/v1/systemone', 'secret-key-a').dir).not.toBe(a);
    expect(a).not.toContain('secret-key-a');
    expect(a.startsWith(caseDir)).toBe(true);
  });

  it('classifies failures by HTTP status and missing response only', () => {
    const now = Date.parse('2026-11-09T12:00:00Z');
    expect(classifyFailure({ status: 429 }, now)).toEqual({ reason: 'http-429', opens: true, seconds: 60 });
    for (const status of [500, 502, 503, 504, 599]) {
      expect(classifyFailure({ status }, now)).toEqual({ reason: 'http-' + status, opens: true, seconds: 60 });
    }
    for (const status of [401, 402, 403]) {
      expect(classifyFailure({ status }, now)).toEqual({ reason: 'http-' + status, opens: true, seconds: 600 });
    }
    for (const status of [400, 404, 408, 409, 413, 422]) {
      expect(classifyFailure({ status }, now)).toBeUndefined();
    }
    expect(classifyFailure({ noResponse: true }, now)).toEqual({ reason: 'no-response', opens: false });
    expect(classifyFailure({}, now)).toBeUndefined();
    expect(classifyFailure(undefined, now)).toBeUndefined();
  });

  it('honors Retry-After in seconds or as an HTTP date, capped at 30 minutes', () => {
    const now = Date.parse('2026-11-09T12:00:00Z');
    expect(classifyFailure({ status: 429, retryAfter: '178' }, now).seconds).toBe(178);
    expect(classifyFailure({ status: 503, retryAfter: new Date(now + 90_000).toUTCString() }, now).seconds).toBe(90);
    expect(classifyFailure({ status: 402, retryAfter: '86400' }, now).seconds).toBe(BREAKER_MAX_SECONDS);
    expect(classifyFailure({ status: 429, retryAfter: 'soon' }, now).seconds).toBe(60);
    expect(retryAfterSeconds('0', now)).toBe(1);
    expect(retryAfterSeconds(new Date(now - 5000).toUTCString(), now)).toBe(1);
    expect(retryAfterSeconds(undefined, now)).toBeUndefined();
    expect(retryAfterSeconds('', now)).toBeUndefined();
    // Decimal seconds round up instead of being read as a year by a lenient date parser.
    expect(retryAfterSeconds('1.5', now)).toBe(2);
    expect(retryAfterSeconds('0.5', now)).toBe(1);
    expect(classifyFailure({ status: 429, retryAfter: '1.5' }, now).seconds).toBe(2);
    // Obsolete HTTP-date forms recipients must accept.
    expect(retryAfterSeconds('Monday, 09-Nov-26 12:02:00 GMT', now)).toBe(120);
    expect(retryAfterSeconds('Mon Nov  9 12:01:30 2026', now)).toBe(90);
    // Anything else falls back to the default.
    for (const value of ['-5', '2001', '1e3', '12:30', 'Nov 9 2026', '2026-11-09T12:05:00Z']) {
      expect([value, classifyFailure({ status: 429, retryAfter: value }, now).seconds]).toEqual([value, value === '2001' ? 1800 : 60]);
    }
  });

  it('gives every registered judgment point a priority', () => {
    const registered = Object.keys(JUDGMENT_POINTS);
    expect(Object.keys(POINT_PRIORITY).sort()).toEqual(registered.sort());
    for (const priority of Object.values(POINT_PRIORITY)) expect(['high', 'medium', 'low']).toContain(priority);
  });

  it('derives per-priority thresholds from the limit', () => {
    expect([thresholdFor(10, 'slop-warning'), thresholdFor(10, 'intent'), thresholdFor(10, 'model-routing')]).toEqual([6, 9, 10]);
    expect([thresholdFor(48, 'context-pruning'), thresholdFor(48, 'task-size'), thresholdFor(48, 'ralph-verdict')]).toEqual([29, 41, 48]);
    expect([thresholdFor(1, 'slop-warning'), thresholdFor(1, 'skill-trigger'), thresholdFor(1, 'loop-continuation')]).toEqual([1, 1, 1]);
    expect(thresholdFor(10, 'some-new-point')).toBe(9);
  });

  it('drops low-priority requests first and never lets a refused request take a slot', () => {
    const settings = breakerSettings({ OMC_JEV_MAX_RPM: '10', OMC_JEV_BREAKER_DIR: caseDir }, ENDPOINT, 'k');
    const now = Date.parse('2026-11-09T12:00:10Z');
    const low = Array.from({ length: 8 }, () => reserveRequest(settings, 'slop-warning', now).ok);
    expect(low.filter(Boolean).length).toBe(6);
    const medium = Array.from({ length: 4 }, () => reserveRequest(settings, 'intent', now).ok);
    expect(medium).toEqual([true, true, true, false]);
    const high = Array.from({ length: 3 }, () => reserveRequest(settings, 'model-routing', now).ok);
    expect(high).toEqual([true, false, false]);
    expect(reserveRequest(settings, 'slop-warning', now)).toEqual({ ok: false, priority: 'low', count: 10, threshold: 6, limit: 10 });
    // A new minute starts from zero.
    expect(reserveRequest(settings, 'slop-warning', now + 60_000).ok).toBe(true);
  });

  it('removes counters older than ten minutes when a new minute starts', () => {
    const settings = breakerSettings({ OMC_JEV_MAX_RPM: '5', OMC_JEV_BREAKER_DIR: caseDir }, ENDPOINT, 'k');
    const start = Date.parse('2026-11-09T12:00:10Z');
    reserveRequest(settings, 'intent', start);
    reserveRequest(settings, 'intent', start + 5 * 60_000);
    reserveRequest(settings, 'intent', start + 11 * 60_000);
    const minutes = readdirSync(settings.dir).filter((name) => name.startsWith('rpm-')).sort();
    expect(minutes).toEqual(['rpm-' + minuteKey(start + 5 * 60_000), 'rpm-' + minuteKey(start + 11 * 60_000)]);
  });

  it('opens on three requests without a response within a minute, not on two or on old ones', () => {
    const settings = breakerSettings({ OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: caseDir }, ENDPOINT, 'k');
    const now = Date.parse('2026-11-09T12:00:00Z');
    const noResponse = classifyFailure({ noResponse: true });
    expect(recordFailure(settings, noResponse, now - 120_000)).toBeUndefined();
    expect(recordFailure(settings, noResponse, now)).toBeUndefined();
    expect(recordFailure(settings, noResponse, now + 1000)).toBeUndefined();
    const opened = recordFailure(settings, noResponse, now + 2000);
    expect(opened).toMatchObject({ reason: 'no-response', until: now + 2000 + 60_000 });
  });

  it('counts three concurrent missing responses whose times are appended out of order, also across a minute', () => {
    const noResponse = classifyFailure({ noResponse: true });
    // Three processes read their clock in the order 1, 2, 3 but append in the order 3, 2, 1.
    for (const base of [Date.parse('2026-11-09T12:00:10Z'), Date.parse('2026-11-09T12:00:59.900Z')]) {
      const settings = breakerSettings({ OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: join(caseDir, 'at-' + base) }, ENDPOINT, 'k');
      expect(recordFailure(settings, noResponse, base + 200)).toBeUndefined();
      expect(recordFailure(settings, noResponse, base + 100)).toBeUndefined();
      // The breaker closes a minute after the newest of the three failures, not of the opener's own (earlier) clock.
      expect(recordFailure(settings, noResponse, base)).toMatchObject({ reason: 'no-response', until: base + 200 + 60_000 });
    }
  });

  it('does not count missing responses more than a minute apart, in whatever order they are appended', () => {
    const settings = breakerSettings({ OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: caseDir }, ENDPOINT, 'k');
    const noResponse = classifyFailure({ noResponse: true });
    const base = Date.parse('2026-11-09T12:00:00Z');
    expect(recordFailure(settings, noResponse, base + 90_000)).toBeUndefined();
    expect(recordFailure(settings, noResponse, base + 40_000)).toBeUndefined();
    expect(recordFailure(settings, noResponse, base)).toBeUndefined();
    expect(readBreaker(settings, base + 90_000)).toBeUndefined();
  });

  it('ignores a recorded time more than a few seconds ahead of the clock: it neither counts nor moves the window', () => {
    const settings = breakerSettings({ OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: caseDir }, ENDPOINT, 'k');
    const noResponse = classifyFailure({ noResponse: true });
    const base = Date.parse('2026-11-09T12:00:10Z');
    mkdirSync(settings.dir, { recursive: true });
    writeFileSync(join(settings.dir, 'noresp-' + minuteKey(base)), String(base + 30_000) + '\n');
    expect(recordFailure(settings, noResponse, base)).toBeUndefined();
    expect(recordFailure(settings, noResponse, base + 1000)).toBeUndefined();
    expect(recordFailure(settings, noResponse, base + 2000)).toMatchObject({ reason: 'no-response' });
  });

  it('never shortens an open breaker and keeps the start of one outage', () => {
    const settings = breakerSettings({ OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: caseDir }, ENDPOINT, 'k');
    const now = Date.parse('2026-11-09T12:00:00Z');
    const first = recordFailure(settings, classifyFailure({ status: 402 }), now);
    expect(first).toEqual({ until: now + 600_000, reason: 'http-402', since: now });
    // A shorter one leaves it as it is.
    expect(recordFailure(settings, classifyFailure({ status: 429 }), now + 1000)).toEqual(first);
    // Expired and opened again within 15 minutes: the same outage.
    const again = recordFailure(settings, classifyFailure({ status: 429 }), now + 600_000 + 5 * 60_000);
    expect(again.since).toBe(now);
    // Much later: a new outage.
    const later = recordFailure(settings, classifyFailure({ status: 429 }), now + 3 * 3_600_000);
    expect(later.since).toBe(now + 3 * 3_600_000);
  });

  it('ignores an expired, corrupt or far-future breaker file (fail-open)', () => {
    const settings = breakerSettings({ OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: caseDir }, ENDPOINT, 'k');
    mkdirSync(settings.dir, { recursive: true });
    const now = Date.now();
    const write = (text) => writeFileSync(join(settings.dir, 'breaker.json'), text);
    write(JSON.stringify({ until: now - 1000, reason: 'http-429', since: now - 61_000 }));
    expect(readBreaker(settings, now)).toBeUndefined();
    write('{not json');
    expect(readBreaker(settings, now)).toBeUndefined();
    expect(admitRequest(settings, 'slop-warning', now)).toEqual({});
    write(JSON.stringify({ until: now + 24 * 3_600_000, reason: 'http-429', since: now }));
    expect(readBreaker(settings, now)).toBeUndefined();
    write(JSON.stringify({ until: now + 60_000, reason: 'http-429', since: now }));
    expect(readBreaker(settings, now)).toEqual({ until: now + 60_000, reason: 'http-429', since: now });
    // Without OMC_JEV_BREAKER the same open file is not read.
    expect(readBreaker({ ...settings, breaker: false }, now)).toBeUndefined();
  });

  it('describes the outage in one line, never naming a time before the breaker closes', () => {
    const until = new Date(2026, 10, 9, 14, 32).getTime();
    expect(outageMessage({ until, reason: 'http-429', since: until - 60_000 }))
      .toBe('[OMC] Jev requests paused until 14:32 (HTTP 429); hooks decide without Jev until then.');
    expect(outageMessage({ until: until + 45_000, reason: 'http-503', since: until - 60_000 })).toContain('until 14:33 (HTTP 503)');
    expect(outageMessage({ until, reason: 'no-response', since: until - 60_000 })).toContain('(no response from the Jev endpoint)');
  });

  it('keeps the later end when a concurrent opener wrote an earlier one', () => {
    const settings = breakerSettings({ OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: caseDir }, ENDPOINT, 'k');
    const now = Date.parse('2026-11-09T12:00:00Z');
    recordFailure(settings, classifyFailure({ status: 402 }), now);
    // Another process that read the file before this opener landed replaces it with its own 60 s breaker.
    writeFileSync(join(settings.dir, 'breaker.json'), JSON.stringify({ until: now + 60_000, reason: 'http-429', since: now }));
    expect(recordFailure(settings, classifyFailure({ status: 402 }), now + 100)).toMatchObject({ until: now + 100 + 600_000, reason: 'http-402', since: now });
  });

  it('writes its end again when a concurrent opener replaces the file right after its write', async () => {
    // A long pause (the field is for tests only) so that the other process surely lands inside it, however loaded the machine is.
    const settings = { ...breakerSettings({ OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: caseDir }, ENDPOINT, 'k'), settleMs: 1000 };
    mkdirSync(settings.dir, { recursive: true });
    const file = join(settings.dir, 'breaker.json');
    const now = Date.now();
    // The other opener read the (then missing) file before ours was written: it waits for the file and replaces
    // it with its own, earlier end, as a process that lost the race between its read and its write does.
    const script = join(caseDir, 'other-opener.mjs');
    writeFileSync(script, [
      "import { existsSync, writeFileSync } from 'node:fs';",
      'const file = ' + JSON.stringify(file) + ';',
      'const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
      "console.log('ready');",
      'while (!existsSync(file)) pause(1);',
      'for (;;) {',
      '  try {',
      '    writeFileSync(file, JSON.stringify({ until: ' + (now + 60_000) + ", reason: 'http-429', since: " + now + ' }));',
      '    break;',
      '  } catch {',
      '    pause(2);',
      '  }',
      '}',
    ].join('\n'));
    const child = spawn(NODE, [script], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    const exited = new Promise((resolve) => child.on('close', resolve));
    await new Promise((resolve) => child.stdout.once('data', resolve));
    const opened = recordFailure(settings, classifyFailure({ status: 402 }, now), now);
    await exited;
    expect(opened).toMatchObject({ until: now + 600_000, reason: 'http-402' });
    // Not just the returned state: the file itself keeps the longer end after the other opener has finished.
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ until: now + 600_000, reason: 'http-402' });
  }, 30_000);

  it('pauses 50 ms after a write before it reads the breaker back', () => {
    const settings = breakerSettings({ OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: caseDir }, ENDPOINT, 'k');
    const started = Date.now();
    expect(recordFailure(settings, classifyFailure({ status: 429 }), Date.now())).toMatchObject({ reason: 'http-429' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    // An open breaker that is not extended is not written again, so no pause.
    const again = Date.now();
    recordFailure(settings, classifyFailure({ status: 429 }), Date.now());
    expect(Date.now() - again).toBeLessThan(45);
  });

  // A child process that opens the breaker with node:fs patched before the library loads (`patch` is the body of a function that gets
  // `fs`); it prints {opened} as JSON.
  function openInChild(name, patch, status, extraEnv = {}) {
    const dir = join(caseDir, 'breaker');
    const script = join(caseDir, name + '.mjs');
    writeFileSync(script, [
      "import fs from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      '(' + patch + ')(fs);',
      'syncBuiltinESMExports();',
      'const lib = await import(' + JSON.stringify(pathToFileURL(join(root, 'scripts', 'lib', 'jev-breaker.mjs')).href) + ');',
      // A hook deadline counted from here, after the library has loaded (TEST_DEADLINE_IN_MS).
      'if (process.env.TEST_DEADLINE_IN_MS) process.env.OMC_JEV_HOOK_DEADLINE = String(Date.now() + Number(process.env.TEST_DEADLINE_IN_MS));',
      'const settings = lib.breakerSettings({ ...process.env, OMC_JEV_BREAKER: "1", OMC_JEV_BREAKER_DIR: ' + JSON.stringify(dir) + ' }, ' + JSON.stringify(ENDPOINT) + ', "k");',
      'const opened = lib.recordFailure(settings, lib.classifyFailure({ status: ' + status + ' }));',
      'console.log(JSON.stringify({ opened: opened ?? null }));',
    ].join('\n'));
    return new Promise((resolve, reject) => {
      const child = spawn(NODE, [script], { env: { ...cleanParentEnv(), ...extraEnv }, windowsHide: true });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', () => {
        try {
          resolve(JSON.parse(stdout.trim().split('\n').pop()));
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  it('does not write over a breaker file it cannot read: a shorter breaker never replaces a longer one it could not see', async () => {
    const settings = breakerSettings({ OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: join(caseDir, 'breaker') }, ENDPOINT, 'k');
    const now = Date.now();
    const longer = recordFailure(settings, classifyFailure({ status: 402 }), now);
    expect(longer).toMatchObject({ reason: 'http-402' });
    // Every read of breaker.json fails with EPERM (Windows: a rename landing, a scanner holding the file), however often it is retried.
    const child = await openInChild('unreadable', String((fs) => {
      const read = fs.readFileSync;
      fs.readFileSync = function (path, ...rest) {
        if (String(path).endsWith('breaker.json')) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        return read.call(this, path, ...rest);
      };
    }), 429);
    expect(child.opened).toBeNull();
    expect(JSON.parse(readFileSync(join(settings.dir, 'breaker.json'), 'utf8'))).toEqual(longer);
  }, 30_000);

  it('treats a breaker file that does not parse as a write in progress for a second, then as corrupt', () => {
    const settings = breakerSettings({ OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: caseDir }, ENDPOINT, 'k');
    mkdirSync(settings.dir, { recursive: true });
    const file = join(settings.dir, 'breaker.json');
    writeFileSync(file, '');
    // Fresh: a writer without the lock is replacing it in place; it may hold a longer breaker, so nothing is written over it.
    expect(recordFailure(settings, classifyFailure({ status: 429 }))).toBeUndefined();
    expect(readFileSync(file, 'utf8')).toBe('');
    expect(readBreaker(settings)).toBeUndefined();
    // A minute old: corrupt, no breaker; it is replaced.
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
    expect(recordFailure(settings, classifyFailure({ status: 429 }))).toMatchObject({ reason: 'http-429' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ reason: 'http-429' });
  });

  it('an opener held up between its read and its write does not shorten a breaker opened meanwhile', async () => {
    const settings = breakerSettings({ OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: join(caseDir, 'breaker') }, ENDPOINT, 'k');
    const holding = join(caseDir, 'holding');
    // The other process (429, 60 s) has read the missing file and is held up for 300 ms right before its rename lands.
    const other = openInChild('held-up', String((fs) => {
      const rename = fs.renameSync;
      let held = false;
      fs.renameSync = function (from, to, ...rest) {
        if (!held && String(to).endsWith('breaker.json')) {
          held = true;
          fs.writeFileSync(process.env.TEST_HOLDING, '');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
        }
        return rename.call(this, from, to, ...rest);
      };
    }), 429, { TEST_HOLDING: holding });
    const started = Date.now();
    while (!existsSync(holding)) {
      if (Date.now() - started > 20_000) throw new Error('the other opener never got to its write');
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const opened = recordFailure(settings, classifyFailure({ status: 402 }));
    const child = await other;
    expect(opened).toMatchObject({ reason: 'http-402' });
    // The other opener returns what it read in its second round: ours, or its own when it got the lock back first (then ours replaced it).
    expect(['http-402', 'http-429']).toContain(child.opened?.reason);
    expect(JSON.parse(readFileSync(join(settings.dir, 'breaker.json'), 'utf8'))).toMatchObject({ reason: 'http-402', until: opened.until });
    expect(existsSync(join(settings.dir, 'breaker.json.lock'))).toBe(false);
  }, 30_000);

  it('waits for the lock only until shortly before the hook kills the resolver; a stale or released lock is taken over and removed', () => {
    const settings = breakerSettings({ OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: caseDir }, ENDPOINT, 'k');
    mkdirSync(settings.dir, { recursive: true });
    const lock = join(settings.dir, 'breaker.json.lock');
    // A live holder: the resolver gives up before the kill (OMC_JEV_HOOK_DEADLINE is the kill less 100 ms) and writes nothing.
    writeFileSync(lock, JSON.stringify({ token: 'live', ts: Date.now() }));
    const started = Date.now();
    const underHook = breakerSettings({ OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: caseDir, OMC_JEV_HOOK_DEADLINE: String(started + 200) }, ENDPOINT, 'k');
    expect(recordFailure(underHook, classifyFailure({ status: 429 }))).toBeUndefined();
    // Not the full wait of 1.5 s.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(existsSync(join(settings.dir, 'breaker.json'))).toBe(false);
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('live');
    // The holder died two seconds ago: its lock is taken over, and no lock is left after the write.
    writeFileSync(lock, JSON.stringify({ token: 'dead', ts: Date.now() - 2000 }));
    expect(recordFailure(settings, classifyFailure({ status: 429 }))).toMatchObject({ reason: 'http-429' });
    expect(existsSync(lock)).toBe(false);
    // The compaction module cannot remove files and marks its lock released: removed as well.
    writeFileSync(lock, JSON.stringify({ token: 'module', ts: Date.now(), released: true }));
    expect(recordFailure(settings, classifyFailure({ status: 402 }))).toMatchObject({ reason: 'http-402' });
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(settings.dir).filter((name) => name.includes('.lock'))).toEqual([]);
  });

  it('removes a stale lock only while it is the lock it judged: a lock another opener created in the meantime stays', async () => {
    const settings = breakerSettings({ OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: join(caseDir, 'breaker') }, ENDPOINT, 'k');
    mkdirSync(settings.dir, { recursive: true });
    const lock = join(settings.dir, 'breaker.json.lock');
    writeFileSync(lock, JSON.stringify({ token: 'dead', ts: Date.now() - 2000 }));
    // Between judging the stale lock and moving it away, this process is held up while another opener removes it and takes the lock.
    const child = await openInChild('aba', String((fs) => {
      const rename = fs.renameSync;
      let swapped = false;
      fs.renameSync = function (from, to, ...rest) {
        if (!swapped && String(from).endsWith('breaker.json.lock') && String(to).endsWith('.removed')) {
          swapped = true;
          fs.rmSync(from);
          fs.writeFileSync(from, JSON.stringify({ token: 'other', ts: Date.now() }), { flag: 'wx' });
        }
        return rename.call(this, from, to, ...rest);
      };
      // Under a hook that kills it 0.5 s after the library has loaded, so it gives up before the other opener's lock goes stale.
    }), 429, { TEST_DEADLINE_IN_MS: '500' });
    // The other opener's lock is back in place and this opener, which never held the lock, wrote nothing.
    expect(child.opened).toBeNull();
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('other');
    expect(existsSync(join(settings.dir, 'breaker.json'))).toBe(false);
  }, 30_000);

  it('puts a displaced newer lock back by a copy when the hard link fails for another reason than EEXIST: the only lock is not lost', async () => {
    const settings = breakerSettings({ OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: join(caseDir, 'breaker') }, ENDPOINT, 'k');
    mkdirSync(settings.dir, { recursive: true });
    const lock = join(settings.dir, 'breaker.json.lock');
    writeFileSync(lock, JSON.stringify({ token: 'dead', ts: Date.now() - 2000 }));
    // As above, another opener takes the lock between the judgement and the move; and the file system has no hard links (EPERM).
    const child = await openInChild('nolink', String((fs) => {
      const rename = fs.renameSync;
      let swapped = false;
      fs.renameSync = function (from, to, ...rest) {
        if (!swapped && String(from).endsWith('breaker.json.lock') && String(to).endsWith('.removed')) {
          swapped = true;
          fs.rmSync(from);
          fs.writeFileSync(from, JSON.stringify({ token: 'other', ts: Date.now() }), { flag: 'wx' });
        }
        return rename.call(this, from, to, ...rest);
      };
      fs.linkSync = function () {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      };
    }), 429, { TEST_DEADLINE_IN_MS: '500' });
    expect(child.opened).toBeNull();
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('other');
    expect(existsSync(join(settings.dir, 'breaker.json'))).toBe(false);
  }, 30_000);

  it('does not create the lock once the hook deadline has passed: no lock left to hold the others back, nothing written', async () => {
    const settings = breakerSettings({ OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: join(caseDir, 'breaker') }, ENDPOINT, 'k');
    // The deadline of the hook (and its kill margin) is over before the opener starts: a free lock must not be created.
    const child = await openInChild('late', String(() => {}), 429, { TEST_DEADLINE_IN_MS: '-1000' });
    expect(child.opened).toBeNull();
    expect(existsSync(join(settings.dir, 'breaker.json'))).toBe(false);
    expect(existsSync(join(settings.dir, 'breaker.json.lock'))).toBe(false);
  }, 30_000);

  it('removes temp files of a killed write after five minutes, not earlier', () => {
    const settings = breakerSettings({ OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: caseDir }, ENDPOINT, 'k');
    mkdirSync(settings.dir, { recursive: true });
    const stale = join(settings.dir, '.breaker.json.tmp.stale');
    const fresh = join(settings.dir, '.breaker.json.tmp.fresh');
    writeFileSync(stale, '{');
    writeFileSync(fresh, '{');
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(stale, old, old);
    recordFailure(settings, classifyFailure({ status: 429 }), Date.now());
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('reads a retry time from a 429 body only as a fallback behind the header, with the same ceiling', () => {
    expect(retryAfterFromBody('Rate limit exceeded. Retry after ~178s')).toBe(178);
    expect(retryAfterFromBody('retry after 30 seconds')).toBe(30);
    expect(retryAfterFromBody('{"error":"slow down","detail":"Retry-After: 12 s"}')).toBe(12);
    expect(retryAfterFromBody('retry_after: 1.5 sec')).toBe(2);
    expect(retryAfterFromBody('retry after 0 s')).toBe(1);
    // Other text, other units, no number, not a string.
    expect(retryAfterFromBody('Too many requests')).toBeUndefined();
    expect(retryAfterFromBody('retry after 5 minutes')).toBeUndefined();
    expect(retryAfterFromBody('retry after 30')).toBeUndefined();
    expect(retryAfterFromBody('retry afterwards 30 s')).toBeUndefined();
    expect(retryAfterFromBody('x'.repeat(2500) + ' retry after 30 s')).toBeUndefined();
    expect(retryAfterFromBody(undefined)).toBeUndefined();
    const now = Date.parse('2026-11-09T12:00:00Z');
    expect(classifyFailure({ status: 429, body: 'retry after ~45s' }, now)).toEqual({ reason: 'http-429', opens: true, seconds: 45 });
    expect(classifyFailure({ status: 429, retryAfter: '20', body: 'retry after ~45s' }, now).seconds).toBe(20);
    expect(classifyFailure({ status: 429, retryAfter: 'soon', body: 'retry after ~45s' }, now).seconds).toBe(45);
    expect(classifyFailure({ status: 429, body: 'retry after 99999 s' }, now).seconds).toBe(BREAKER_MAX_SECONDS);
    expect(classifyFailure({ status: 429, body: 'nothing useful' }, now).seconds).toBe(60);
    // Only a 429 looks at a body.
    expect(classifyFailure({ status: 503, body: 'retry after ~45s' }, now).seconds).toBe(60);
    expect(classifyFailure({ status: 402, body: 'retry after ~45s' }, now).seconds).toBe(600);
  });
});

describe('request timeout under a hook deadline', () => {
  it('shortens the timeout to the deadline given by the hook, not below 200 ms, only with OMC_JEV_BREAKER=1', () => {
    const now = 1_000_000;
    const base = { OMC_JEV_TIMEOUT_MS: '2000' };
    expect(resolveRequestTimeoutMs({ ...base, OMC_JEV_BREAKER: '1', OMC_JEV_HOOK_DEADLINE: String(now + 700) }, now)).toBe(700);
    expect(resolveRequestTimeoutMs({ ...base, OMC_JEV_BREAKER: '1', OMC_JEV_HOOK_DEADLINE: String(now + 9000) }, now)).toBe(2000);
    expect(resolveRequestTimeoutMs({ ...base, OMC_JEV_BREAKER: '1', OMC_JEV_HOOK_DEADLINE: String(now + 50) }, now)).toBe(200);
    expect(resolveRequestTimeoutMs({ ...base, OMC_JEV_BREAKER: '1', OMC_JEV_HOOK_DEADLINE: String(now - 5000) }, now)).toBe(200);
    for (const bad of ['', 'soon', '0', '-5', 'NaN']) {
      expect(resolveRequestTimeoutMs({ ...base, OMC_JEV_BREAKER: '1', OMC_JEV_HOOK_DEADLINE: bad }, now)).toBe(2000);
    }
    expect(resolveRequestTimeoutMs({ ...base, OMC_JEV_BREAKER: '1' }, now)).toBe(2000);
    // Without the breaker (also with only a request limit) the variable is not read.
    expect(resolveRequestTimeoutMs({ ...base, OMC_JEV_HOOK_DEADLINE: String(now + 700) }, now)).toBe(2000);
    expect(resolveRequestTimeoutMs({ ...base, OMC_JEV_MAX_RPM: '5', OMC_JEV_HOOK_DEADLINE: String(now + 700) }, now)).toBe(2000);
  });

  it('a request that has not answered by the deadline ends there and counts as no response', async () => {
    const env = jevEnv({ OMC_JEV_BREAKER: '1', OMC_JEV_TIMEOUT_MS: '20000', OMC_JEV_HOOK_DEADLINE: String(Date.now() + 1500) });
    const hangs = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const started = Date.now();
    const result = await resolveRequest(request(), env, hangs);
    const took = Date.now() - started;
    expect(result.mode).toBe('degraded');
    expect(took).toBeGreaterThanOrEqual(1400);
    expect(took).toBeLessThan(6000);
    expect(logRows(env).map((row) => row.mode)).toEqual(['degraded']);
    expect(readdirSync(settingsFor(env).dir).filter((name) => name.startsWith('noresp-'))).toHaveLength(1);
  }, 30_000);

  it('a request cut shorter than a second by the deadline (a slow start) is not counted as a missing response', async () => {
    const env = jevEnv({ OMC_JEV_BREAKER: '1', OMC_JEV_TIMEOUT_MS: '20000', OMC_JEV_HOOK_DEADLINE: String(Date.now() + 400) });
    const hangs = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const result = await resolveRequest(request(), env, hangs);
    expect(result.mode).toBe('degraded');
    expect(logRows(env).map((row) => row.mode)).toEqual(['degraded']);
    const dir = settingsFor(env).dir;
    expect(existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith('noresp-')) : []).toEqual([]);
  }, 30_000);
});

describe('resolveRequest with the shared breaker and limit', () => {
  it('without OMC_JEV_BREAKER and OMC_JEV_MAX_RPM: every request goes out, no state files, no new fields', async () => {
    const env = jevEnv();
    const { fetchFn, calls } = countingFetch((n) => (n === 1 ? errorResponse(429, { 'Retry-After': '120' }) : okResponse()));
    const first = await resolveRequest(request(), env, fetchFn);
    const second = await resolveRequest(request(), env, fetchFn);
    expect(calls).toHaveLength(2);
    expect(Object.keys(first).sort()).toEqual(['answer', 'answers', 'confidence', 'durationMs', 'mode']);
    expect(first.mode).toBe('degraded');
    expect(second.mode).toBe('shadow');
    expect(existsSync(env.OMC_JEV_BREAKER_DIR)).toBe(false);
    const rows = logRows(env);
    expect(rows.map((row) => row.mode)).toEqual(['degraded', 'shadow']);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['answers', 'confidence', 'durationMs', 'heuristic', 'jev', 'mode', 'point', 'state', 'ts'].filter((key) => key !== 'confidence' || row.confidence !== undefined));
    }
  });

  it('a 429 opens the breaker for Retry-After; later requests send nothing and end as circuit-open', async () => {
    const env = jevEnv({ OMC_JEV_BREAKER: '1' });
    const { fetchFn, calls } = countingFetch(() => errorResponse(429, { 'Retry-After': '120' }));
    const before = Date.now();
    const first = await resolveRequest(request(), env, fetchFn);
    expect(first.mode).toBe('degraded');
    expect(first.breaker).toMatchObject({ reason: 'http-429' });
    expect(first.breaker.until).toBeGreaterThanOrEqual(before + 120_000);
    expect(first.breaker.until).toBeLessThanOrEqual(Date.now() + 120_000);
    for (let i = 0; i < 5; i += 1) {
      const held = await resolveRequest(request(i % 2 ? 'model-routing' : 'slop-warning'), env, fetchFn);
      expect(held).toMatchObject({ mode: 'circuit-open', answer: null, answers: null, breaker: { reason: 'http-429' } });
    }
    expect(calls).toHaveLength(1);
    const rows = logRows(env);
    expect(rows.map((row) => row.mode)).toEqual(['degraded', 'circuit-open', 'circuit-open', 'circuit-open', 'circuit-open', 'circuit-open']);
    expect(rows[1]).toMatchObject({ point: 'slop-warning', reason: 'http-429', jev: null, answers: null, heuristic: false, state: { toolName: 'Bash' } });
    expect(new Date(rows[1].until).getTime()).toBe(first.breaker.until);
  });

  it('a 429 without a usable Retry-After takes the retry time from its body; the header wins; other statuses and an off breaker read no body', async () => {
    const withBody = (status, text, headers = {}) => {
      const response = errorResponse(status, headers);
      response.reads = 0;
      response.text = async () => { response.reads += 1; return text; };
      return response;
    };
    const open = async (envOverrides, response) => {
      const env = jevEnv(envOverrides);
      const before = Date.now();
      const { fetchFn } = countingFetch(() => response);
      const result = await resolveRequest(request(), env, fetchFn);
      return { result, seconds: result.breaker ? Math.round((result.breaker.until - before) / 1000) : undefined };
    };
    let { seconds } = await open({ OMC_JEV_BREAKER: '1' }, withBody(429, 'Rate limited. Retry after ~45s'));
    expect(seconds).toBe(45);
    // The header wins and the body is not even read.
    const withHeader = withBody(429, 'retry after ~45s', { 'Retry-After': '20' });
    ({ seconds } = await open({ OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: join(caseDir, 'b2') }, withHeader));
    expect(seconds).toBe(20);
    expect(withHeader.reads).toBe(0);
    // No time in the body: the default minute. An unreadable body: the same.
    ({ seconds } = await open({ OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: join(caseDir, 'b3') }, withBody(429, '{"error":"slow down"}')));
    expect(seconds).toBe(60);
    ({ seconds } = await open({ OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: join(caseDir, 'b4') }, errorResponse(429)));
    expect(seconds).toBe(60);
    // A ceiling of 30 minutes, as for the header.
    ({ seconds } = await open({ OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: join(caseDir, 'b5') }, withBody(429, 'retry after 99999 s')));
    expect(seconds).toBe(BREAKER_MAX_SECONDS);
    // Another status: no body read. A request limit alone (no breaker): no body read.
    const server = withBody(503, 'retry after ~45s');
    ({ seconds } = await open({ OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: join(caseDir, 'b6') }, server));
    expect(seconds).toBe(60);
    expect(server.reads).toBe(0);
    const limitOnly = withBody(429, 'retry after ~45s');
    const { result } = await open({ OMC_JEV_MAX_RPM: '100', OMC_JEV_BREAKER_DIR: join(caseDir, 'b7') }, limitOnly);
    expect(result.breaker).toBeUndefined();
    expect(limitOnly.reads).toBe(0);
  });

  it('opens on 401, 402, 403 and 5xx, not on other 4xx or an invalid body', async () => {
    for (const [status, opens] of [[401, true], [402, true], [403, true], [500, true], [503, true], [400, false], [404, false], [422, false]]) {
      const env = jevEnv({ OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: join(caseDir, 'breaker-' + status) });
      const { fetchFn, calls } = countingFetch(() => errorResponse(status));
      await resolveRequest(request(), env, fetchFn);
      const next = await resolveRequest(request(), env, fetchFn);
      expect([status, next.mode]).toEqual([status, opens ? 'circuit-open' : 'degraded']);
      expect(calls).toHaveLength(opens ? 1 : 2);
    }
    const env = jevEnv({ OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: join(caseDir, 'breaker-invalid') });
    const { fetchFn, calls } = countingFetch(() => ({ ok: true, status: 200, json: async () => ({ nope: true }) }));
    for (let i = 0; i < 4; i += 1) expect((await resolveRequest(request(), env, fetchFn)).mode).toBe('degraded');
    expect(calls).toHaveLength(4);
  });

  it('counts network errors and timeouts as no response: the third within a minute opens the breaker', async () => {
    const env = jevEnv({ OMC_JEV_BREAKER: '1', OMC_JEV_TIMEOUT_MS: '50' });
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      if (calls === 2) return new Promise(() => {}); // never answers: the 50 ms timeout fires
      throw new TypeError('fetch failed');
    };
    expect((await resolveRequest(request(), env, fetchFn)).breaker).toBeUndefined();
    expect((await resolveRequest(request(), env, fetchFn)).breaker).toBeUndefined();
    const third = await resolveRequest(request(), env, fetchFn);
    expect(third.breaker).toMatchObject({ reason: 'no-response' });
    expect((await resolveRequest(request(), env, fetchFn)).mode).toBe('circuit-open');
    expect(calls).toBe(3);
  });

  it('another key is not held back by the breaker of the first one', async () => {
    const env = jevEnv({ OMC_JEV_BREAKER: '1' });
    const { fetchFn, calls } = countingFetch((n) => (n === 1 ? errorResponse(401) : okResponse()));
    await resolveRequest(request(), env, fetchFn);
    expect((await resolveRequest(request(), env, fetchFn)).mode).toBe('circuit-open');
    expect((await resolveRequest(request(), { ...env, TYPESAFE_API_KEY: 'new-key' }, fetchFn)).mode).toBe('shadow');
    expect(calls).toHaveLength(2);
  });

  it('OMC_JEV_MAX_RPM holds back low-priority points first and logs them as cap', async () => {
    const { env, low, high, calls } = await inOneMinute(async (dir) => {
      const env = jevEnv({ OMC_JEV_MAX_RPM: '10', OMC_JEV_BREAKER_DIR: join(dir, 'breaker'), OMC_JEV_LOG_DIR: join(dir, 'log') });
      const { fetchFn, calls } = countingFetch(() => okResponse());
      const low = [];
      for (let i = 0; i < 8; i += 1) low.push((await resolveRequest(request('slop-warning'), env, fetchFn)).mode);
      const high = [];
      for (let i = 0; i < 5; i += 1) high.push((await resolveRequest(request('model-routing'), env, fetchFn)).mode);
      return { env, low, high, calls };
    });
    expect(low.filter((mode) => mode === 'shadow')).toHaveLength(6);
    expect(low.filter((mode) => mode === 'cap')).toHaveLength(2);
    expect(high).toEqual(['shadow', 'shadow', 'shadow', 'shadow', 'cap']);
    expect(calls).toHaveLength(10);
    const capRow = logRows(env).find((row) => row.mode === 'cap');
    expect(capRow).toMatchObject({ point: 'slop-warning', reason: 'rpm', priority: 'low', rpm: { count: 6, threshold: 6, limit: 10 }, jev: null });
    // The limit alone never opens the breaker on a failure.
    const failing = countingFetch(() => errorResponse(429));
    await resolveRequest(request('model-routing'), { ...env, OMC_JEV_MAX_RPM: '1000' }, failing.fetchFn);
    await resolveRequest(request('model-routing'), { ...env, OMC_JEV_MAX_RPM: '1000' }, failing.fetchFn);
    expect(failing.calls).toHaveLength(2);
    expect(existsSync(join(settingsFor({ ...env, OMC_JEV_MAX_RPM: '1000' }).dir, 'breaker.json'))).toBe(false);
  });

  it('shares the breaker with the TS resolver in both directions', async () => {
    const names = ['TYPESAFE_API_KEY', 'OMC_JEV', 'OMC_JEV_LOG_DIR', 'OMC_JEV_BREAKER_DIR', 'OMC_JEV_ENDPOINT', 'OMC_JEV_BREAKER'];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const env = jevEnv({ OMC_JEV_BREAKER: '1' });
    try {
      for (const name of names) process.env[name] = env[name];
      resetJevResolverState();
      const judge = (fetchFn) => resolveJudgment({ point: 'model-routing', state: { task: 'x' }, questions: QUESTIONS, twin: () => false, fetchFn });
      // Opened by the script channel, honored by the TS resolver.
      expect((await resolveRequest(request('model-routing'), env, async () => errorResponse(503))).breaker).toMatchObject({ reason: 'http-503' });
      const tsCalls = countingFetch(() => okResponse());
      expect((await judge(tsCalls.fetchFn)).mode).toBe('circuit-open');
      expect(tsCalls.calls).toHaveLength(0);
      // Opened by the TS resolver (another key, so another scope), honored by the script channel.
      process.env.TYPESAFE_API_KEY = 'second-key';
      await judge(async () => errorResponse(402));
      const scriptCalls = countingFetch(() => okResponse());
      expect((await resolveRequest(request(), { ...env, TYPESAFE_API_KEY: 'second-key' }, scriptCalls.fetchFn)).mode).toBe('circuit-open');
      expect(scriptCalls.calls).toHaveLength(0);
    } finally {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
      resetJevResolverState();
    }
  });

  it('a module that cannot write its state never blocks a request', async () => {
    const blocked = join(caseDir, 'not-a-directory');
    writeFileSync(blocked, 'x');
    const env = jevEnv({ OMC_JEV_BREAKER: '1', OMC_JEV_MAX_RPM: '1', OMC_JEV_BREAKER_DIR: blocked });
    const { fetchFn, calls } = countingFetch(() => errorResponse(429));
    for (let i = 0; i < 3; i += 1) expect((await resolveRequest(request(), env, fetchFn)).mode).toBe('degraded');
    expect(calls).toHaveLength(3);
  });
});

/** A stub System One endpoint that counts requests; `respond` picks the status, headers and an optional delay. */
async function startStub(respond) {
  let count = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      count += 1;
      const { status, headers = {}, delayMs = 0, body: replyBody } = respond(count, body);
      setTimeout(() => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(status === 200
          ? JSON.stringify({ answers: { slop_advisory: { type: 'noul', noul: false, confidence: 0.9 } } })
          : replyBody ?? JSON.stringify({ error: 'stub ' + status }));
      }, delayMs);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return { endpoint: 'http://127.0.0.1:' + server.address().port + '/v1/systemone', count: () => count };
}

function runResolver(input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [RESOLVER], { env: { ...cleanParentEnv(), ...env }, cwd: caseDir, windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', () => {
      try {
        resolve(JSON.parse(stdout.trim().split('\n').pop()));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

describe('shared between processes', () => {
  it('after one 429, ten concurrent resolver processes send no request', async () => {
    const stub = await startStub(() => ({ status: 429, headers: { 'Retry-After': '120' } }));
    const env = jevEnv({ OMC_JEV_BREAKER: '1', OMC_JEV_ENDPOINT: stub.endpoint, OMC_JEV_TIMEOUT_MS: '5000' });
    const first = await runResolver(request(), env);
    expect(first).toMatchObject({ mode: 'degraded', breaker: { reason: 'http-429' } });
    const results = await Promise.all(Array.from({ length: 10 }, () => runResolver(request(), env)));
    expect(results.map((result) => result.mode)).toEqual(Array(10).fill('circuit-open'));
    expect(stub.count()).toBe(1);
  }, 60_000);

  it('a 429 body with a retry time reaches the breaker through a real HTTP response', async () => {
    const stub = await startStub(() => ({ status: 429, body: JSON.stringify({ error: 'rate limited, retry after ~45s' }) }));
    const env = jevEnv({ OMC_JEV_BREAKER: '1', OMC_JEV_ENDPOINT: stub.endpoint, OMC_JEV_TIMEOUT_MS: '5000' });
    const before = Date.now();
    const first = await runResolver(request(), env);
    expect(first).toMatchObject({ mode: 'degraded', breaker: { reason: 'http-429' } });
    expect(Math.round((first.breaker.until - before) / 1000)).toBe(45);
  }, 60_000);

  it('a very large 429 body is read only as far as the first 2000 characters', async () => {
    const stub = await startStub(() => ({ status: 429, body: 'rate limited, retry after ~45s ' + 'x'.repeat(5_000_000) }));
    const env = jevEnv({ OMC_JEV_BREAKER: '1', OMC_JEV_ENDPOINT: stub.endpoint, OMC_JEV_TIMEOUT_MS: '10000' });
    const before = Date.now();
    const first = await runResolver(request(), env);
    expect(Math.round((first.breaker.until - before) / 1000)).toBe(45);
    // The phrase beyond the first 2000 characters is not looked at.
    const late = await startStub(() => ({ status: 429, body: 'x'.repeat(2500) + ' retry after ~45s' }));
    const lateEnv = jevEnv({ OMC_JEV_BREAKER: '1', OMC_JEV_ENDPOINT: late.endpoint, OMC_JEV_TIMEOUT_MS: '10000', OMC_JEV_BREAKER_DIR: join(caseDir, 'late') });
    const second = await runResolver(request(), lateEnv);
    expect(Math.round((second.breaker.until - Date.now()) / 1000)).toBeGreaterThanOrEqual(58);
    expect(Math.round((second.breaker.until - Date.now()) / 1000)).toBeLessThanOrEqual(60);
  }, 60_000);

  it('a limit of 10 lets exactly 10 of 30 concurrent processes send their request', async () => {
    const { modes, sent } = await inOneMinute(async (dir) => {
      const stub = await startStub(() => ({ status: 200 }));
      const env = jevEnv({
        OMC_JEV_MAX_RPM: '10',
        OMC_JEV_ENDPOINT: stub.endpoint,
        OMC_JEV_TIMEOUT_MS: '5000',
        OMC_JEV_BREAKER_DIR: join(dir, 'breaker'),
        OMC_JEV_LOG_DIR: join(dir, 'log'),
      });
      const modes = [];
      for (let wave = 0; wave < 3; wave += 1) {
        const results = await Promise.all(Array.from({ length: 10 }, () => runResolver(request('model-routing'), env)));
        modes.push(...results.map((result) => result.mode));
      }
      return { modes, sent: stub.count() };
    }, 25);
    expect(modes.filter((mode) => mode === 'shadow')).toHaveLength(10);
    expect(modes.filter((mode) => mode === 'cap')).toHaveLength(20);
    expect(sent).toBe(10);
  }, 180_000);

  it('concurrent failures with different block times leave the longest one', async () => {
    // Every request is in flight before the first answer, so the openers race.
    const stub = await startStub((n) => ({ status: n % 2 ? 402 : 429, delayMs: 3000 }));
    const env = jevEnv({ OMC_JEV_BREAKER: '1', OMC_JEV_ENDPOINT: stub.endpoint, OMC_JEV_TIMEOUT_MS: '10000' });
    const before = Date.now();
    await Promise.all(Array.from({ length: 8 }, () => runResolver(request(), env)));
    expect(stub.count()).toBeGreaterThanOrEqual(2);
    const state = readBreaker(settingsFor(env));
    expect(state.reason).toBe('http-402');
    expect(state.until).toBeGreaterThanOrEqual(before + 600_000);
  }, 60_000);
});

function makeGitTemp(prefix) {
  const directory = mkdtempSync(join(tmp, prefix));
  execFileSync('git', ['init'], { cwd: directory, stdio: 'pipe' });
  return directory;
}

let lastHookStdout = '';
let lastHookStderr = '';

/** Run the hook asynchronously: a synchronous run would freeze the stub server in this process. */
function runEnforcer(sessionId, env, agentId) {
  const cwd = makeGitTemp('enforcer-');
  const home = join(cwd, '.test-home');
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [ENFORCER], {
      cwd,
      windowsHide: true,
      env: {
        ...cleanParentEnv(),
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        NODE_ENV: 'test',
        DISABLE_OMC: '',
        OMC_SKIP_HOOKS: '',
        OMC_STATE_DIR: '',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('hook timed out')); }, 20_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      lastHookStdout = stdout;
      lastHookStderr = stderr;
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify({
      cwd,
      session_id: sessionId,
      ...(agentId ? { agent_id: agentId } : {}),
      tool_name: 'Task',
      toolInput: {
        subagent_type: 'oh-my-claudecode:executor',
        description: 'Implement a fallback',
        prompt: 'Add a workaround if the normal architecture is hard.',
      },
    }));
  });
}

async function waitForRows(env, count) {
  for (let i = 0; i < 200; i += 1) {
    const rows = logRows(env);
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return logRows(env);
}

function openBreakerFile(env, seconds = 300) {
  const settings = breakerSettings({ ...env, OMC_JEV_BREAKER: '1' }, env.OMC_JEV_ENDPOINT, env.TYPESAFE_API_KEY);
  mkdirSync(settings.dir, { recursive: true });
  const now = Date.now();
  const state = { until: now + seconds * 1000, reason: 'http-429', since: now };
  writeFileSync(join(settings.dir, 'breaker.json'), JSON.stringify(state));
  return state;
}

describe('outage notice in a hook script', () => {
  it('shows one systemMessage per session and outage; the rest of the output is unchanged', async () => {
    const env = jevEnv({ OMC_JEV: 'slop-warning', OMC_JEV_BREAKER: '1' });
    const state = openBreakerFile(env);
    const first = await runEnforcer('session-a', env);
    expect(first.systemMessage).toBe(outageMessage(state));
    expect(first.hookSpecificOutput.additionalContext).toContain('SLOP WARNING');
    // The hook's pretty-printed output stays pretty-printed, and stderr carries the notice once.
    expect(lastHookStdout.startsWith('{\n  "')).toBe(true);
    expect(lastHookStderr.split(outageMessage(state)).length - 1).toBe(1);
    const again = await runEnforcer('session-a', env);
    expect(again.systemMessage).toBeUndefined();
    const withoutNotice = { ...first };
    delete withoutNotice.systemMessage;
    expect(again).toEqual(withoutNotice);
    expect((await runEnforcer('session-b', env)).systemMessage).toBe(outageMessage(state));
    // The resolver held the requests back and logged them.
    const rows = await waitForRows(env, 3);
    expect(rows.map((row) => row.mode)).toEqual(['circuit-open', 'circuit-open', 'circuit-open']);
  }, 60_000);

  it('a hook inside a subagent neither shows nor uses up the notice of its session', async () => {
    const env = jevEnv({ OMC_JEV: 'slop-warning', OMC_JEV_BREAKER: '1' });
    const state = openBreakerFile(env);
    // Subagents share the session id; their output does not reach the user.
    const inAgent = await runEnforcer('session-a', env, 'agent-1');
    expect(inAgent.systemMessage).toBeUndefined();
    expect(lastHookStderr).not.toContain('Jev requests paused');
    // The main thread of the same session still gets it, once.
    expect((await runEnforcer('session-a', env)).systemMessage).toBe(outageMessage(state));
    expect((await runEnforcer('session-a', env)).systemMessage).toBeUndefined();
    expect((await runEnforcer('session-a', env, 'agent-2')).systemMessage).toBeUndefined();
  }, 60_000);

  it('without OMC_JEV_BREAKER an open breaker file changes nothing', async () => {
    const env = jevEnv({ OMC_JEV: 'slop-warning' });
    openBreakerFile(env);
    const output = await runEnforcer('session-a', env);
    expect(output.systemMessage).toBeUndefined();
    const rows = await waitForRows(env, 1);
    expect(rows.map((row) => row.mode)).toEqual(['degraded']); // the request went out (unreachable stub endpoint)
  }, 60_000);

  it('active mode: the request that opens the breaker shows the notice in the same hook output', async () => {
    const stub = await startStub(() => ({ status: 503, headers: { 'Retry-After': '30' } }));
    const env = jevEnv({ OMC_JEV: 'slop-warning:active', OMC_JEV_BREAKER: '1', OMC_JEV_ENDPOINT: stub.endpoint, OMC_JEV_TIMEOUT_MS: '5000' });
    const first = await runEnforcer('session-a', env);
    expect(first.systemMessage).toMatch(/^\[OMC\] Jev requests paused until \d\d:\d\d \(HTTP 503\); hooks decide without Jev until then\.$/);
    expect((await runEnforcer('session-a', env)).systemMessage).toBeUndefined();
    expect(stub.count()).toBe(1);
  }, 60_000);

  it('active mode with an open breaker: no request, no wait for the resolver, no missing-response count', async () => {
    const stub = await startStub(() => ({ status: 200, delayMs: 8000 }));
    const env = jevEnv({ OMC_JEV: 'slop-warning:active', OMC_JEV_BREAKER: '1', OMC_JEV_ENDPOINT: stub.endpoint, OMC_JEV_TIMEOUT_MS: '100' });
    const state = openBreakerFile(env);
    for (const session of ['session-a', 'session-b', 'session-c', 'session-d']) {
      const output = await runEnforcer(session, env);
      expect(output.hookSpecificOutput.additionalContext).toContain('SLOP WARNING');
    }
    const rows = await waitForRows(env, 4);
    expect(rows.map((row) => row.mode)).toEqual(['circuit-open', 'circuit-open', 'circuit-open', 'circuit-open']);
    expect(stub.count()).toBe(0);
    const settings = settingsFor(env);
    expect(readdirSync(settings.dir).filter((name) => name.startsWith('noresp-'))).toEqual([]);
    expect(readBreaker(settings)).toEqual(state);
  }, 90_000);

  it('works when the hook runs in a worker thread (as run.cjs runs UserPromptSubmit hooks)', async () => {
    const env = jevEnv({ OMC_JEV: 'intent', OMC_JEV_BREAKER: '1' });
    const state = openBreakerFile(env);
    const shadowUrl = pathToFileURL(join(root, 'scripts', 'lib', 'jev-shadow.mjs')).href;
    writeFileSync(join(caseDir, 'worker.mjs'), [
      "import { recordJevShadow, setJevSessionId } from " + JSON.stringify(shadowUrl) + ";",
      "setJevSessionId('worker-session');",
      "recordJevShadow({ point: 'intent', state: { prompt: 'x' }, questions: { intent: { type: 'noul', criteria: { yes: 'a', no: 'b' } } }, heuristic: false });",
      "console.log(JSON.stringify({ continue: true }));",
    ].join('\n'));
    writeFileSync(join(caseDir, 'runner.mjs'), [
      "import { Worker } from 'node:worker_threads';",
      "new Worker(new URL('./worker.mjs', import.meta.url)).on('exit', (code) => { process.exitCode = code; });",
    ].join('\n'));
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(NODE, [join(caseDir, 'runner.mjs')], { cwd: caseDir, env: { ...cleanParentEnv(), ...env }, windowsHide: true });
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', () => resolve(out));
    });
    expect(JSON.parse(stdout)).toEqual({ continue: true, systemMessage: outageMessage(state) });
    // The background resolver held the call back and logged it.
    expect((await waitForRows(env, 1)).map((row) => row.mode)).toEqual(['circuit-open']);
  }, 60_000);
});

describe('active hook and its resolver process', () => {
  /**
   * A preload for node (NODE_OPTIONS) that acts only in the resolver process: it
   * records the deadline variable it was given and then returns at once, hangs,
   * or exits with a code, as TEST_RESOLVER_MODE says.
   */
  function writePreload() {
    const preload = join(caseDir, 'resolver-preload.cjs');
    writeFileSync(preload, [
      "const fs = require('node:fs');",
      "if (process.argv[1] && /jev-resolve[.]mjs$/.test(process.argv[1])) {",
      "  fs.writeFileSync(process.env.TEST_RESOLVER_SEEN, JSON.stringify({ deadline: process.env.OMC_JEV_HOOK_DEADLINE ?? null, at: Date.now() }));",
      "  const mode = process.env.TEST_RESOLVER_MODE;",
      "  if (mode === 'hang') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);",
      "  if (mode === 'exit3') process.exit(3);",
      "  if (mode === 'delay') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.TEST_RESOLVER_DELAY_MS));",
      "  if (mode === 'linger') setInterval(() => {}, 1000);",
      "}",
    ].join('\n'));
    return preload.split('\\').join('/');
  }

  function preloadEnv(mode, overrides = {}) {
    return jevEnv({
      OMC_JEV: 'slop-warning:active',
      OMC_JEV_BREAKER: '1',
      OMC_JEV_TIMEOUT_MS: '1000',
      NODE_OPTIONS: '--require ' + writePreload(),
      TEST_RESOLVER_SEEN: join(caseDir, 'seen.json'),
      TEST_RESOLVER_MODE: mode,
      ...overrides,
    });
  }

  it('gives the resolver the moment it will be killed, less 100 ms, only with OMC_JEV_BREAKER=1', async () => {
    const env = preloadEnv('pass');
    const before = Date.now();
    await runEnforcer('session-a', env);
    const after = Date.now();
    const seen = JSON.parse(readFileSync(env.TEST_RESOLVER_SEEN, 'utf8'));
    // kill time = spawn + OMC_JEV_TIMEOUT_MS (1000) + 500 ms buffer, less 100 ms
    expect(Number(seen.deadline)).toBeGreaterThanOrEqual(before + 1400);
    expect(Number(seen.deadline)).toBeLessThanOrEqual(after + 1400);
    rmSync(env.TEST_RESOLVER_SEEN);
    await runEnforcer('session-b', { ...env, OMC_JEV_BREAKER: '' });
    expect(JSON.parse(readFileSync(env.TEST_RESOLVER_SEEN, 'utf8')).deadline).toBeNull();
  }, 60_000);

  it('a resolver killed after the hook limit leaves a degraded row with how it ended, and no missing-response count', async () => {
    const env = preloadEnv('hang');
    const output = await runEnforcer('session-a', env);
    expect(output.hookSpecificOutput.additionalContext).toContain('SLOP WARNING'); // the twin decided
    const rows = await waitForRows(env, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ point: 'slop-warning', mode: 'degraded', reason: 'resolver-timeout' });
    expect(rows[0].spawn_error).toBeUndefined();
    expect(rows[0].exit_status).toBeUndefined();
    expect(rows[0].exit_signal).toBe('SIGTERM');
    expect(typeof rows[0].durationMs).toBe('number');
    expect(rows[0]).not.toHaveProperty('state'); // no request content
    const stateDir = settingsFor(env).dir;
    expect(existsSync(stateDir) ? readdirSync(stateDir).filter((name) => name.startsWith('noresp-')) : []).toEqual([]);
  }, 60_000);

  it('a resolver that exits with a code leaves a degraded row with exit_status', async () => {
    const env = preloadEnv('exit3');
    await runEnforcer('session-a', env);
    const rows = await waitForRows(env, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ point: 'slop-warning', mode: 'degraded', reason: 'resolver-exit', exit_status: 3 });
    expect(rows[0].exit_signal).toBeUndefined();
    expect(rows[0].spawn_error).toBeUndefined();
  }, 60_000);

  it('a resolver started while the breaker was open stays in shadow mode when the breaker has closed before it asks for admission', async () => {
    const stub = await startStub(() => ({ status: 200 }));
    // The breaker is open for 4 s; the resolver starts 5.5 s after the hook has seen it open.
    const env = preloadEnv('delay', { OMC_JEV_ENDPOINT: stub.endpoint, TEST_RESOLVER_DELAY_MS: '5500' });
    openBreakerFile(env, 4);
    const output = await runEnforcer('session-a', env);
    expect(output.hookSpecificOutput.additionalContext).toContain('SLOP WARNING'); // the twin decided, the hook did not wait
    const rows = await waitForRows(env, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ point: 'slop-warning', mode: 'shadow' });
    expect(rows[0].jev).not.toBeNull(); // the request went out, and its answer is not used as an active decision
    expect(stub.count()).toBe(1);
  }, 60_000);

  it('a failed response whose body never ends does not keep the resolver alive: the hook gets its result at once, with one row', async () => {
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(503, { 'Retry-After': '120', 'Content-Type': 'application/json' });
        res.write('{"error":'); // the body never ends
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }));
    const env = jevEnv({
      OMC_JEV: 'slop-warning:active',
      OMC_JEV_BREAKER: '1',
      OMC_JEV_TIMEOUT_MS: '5000',
      OMC_JEV_ENDPOINT: 'http://127.0.0.1:' + server.address().port + '/v1/systemone',
    });
    const before = Date.now();
    const output = await runEnforcer('session-a', env);
    expect(Date.now() - before).toBeLessThan(5000); // the hook does not wait for its kill at 5.5 s
    const rows = logRows(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ point: 'slop-warning', mode: 'degraded' });
    expect(rows[0]).not.toHaveProperty('reason');
    expect(output.systemMessage).toContain('HTTP 503'); // the breaker it opened is announced in the same output
  }, 60_000);

  it('a resolver that printed its result but does not end leaves one row, and its result is used', async () => {
    const stub = await startStub(() => ({ status: 503, headers: { 'Retry-After': '120' } }));
    const env = preloadEnv('linger', { OMC_JEV_ENDPOINT: stub.endpoint, OMC_JEV_TIMEOUT_MS: '1500' });
    const output = await runEnforcer('session-a', env);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const rows = logRows(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ point: 'slop-warning', mode: 'degraded' });
    expect(rows[0]).not.toHaveProperty('reason'); // the resolver's own row, not a resolver-timeout row of the hook
    expect(output.systemMessage).toContain('HTTP 503');
  }, 60_000);

  it('without OMC_JEV_BREAKER the hook writes no row for a killed or failed resolver', async () => {
    const env = preloadEnv('exit3', { OMC_JEV_BREAKER: '' });
    await runEnforcer('session-a', env);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(logRows(env)).toEqual([]);
  }, 60_000);
});
