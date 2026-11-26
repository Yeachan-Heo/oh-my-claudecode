/**
 * Tests for the opt-in low scope of the shared Jev breaker
 * (OMC_JEV_BREAKER_TIMEOUT_LOW=1 in scripts/lib/jev-breaker.mjs): requests
 * without a response of low-priority points open a breaker that holds back
 * only low-priority points, the openings log, since_all, and the quiet
 * outage notice. Without the variable the behavior is unchanged.
 *
 * .mjs so vitest picks it up without tsc typechecking the untyped scripts.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  admitRequest,
  breakerCovers,
  breakerSettings,
  claimOutageNotice,
  classifyFailure,
  noticeWanted,
  openingsDirOf,
  readBreaker,
  recordFailure,
} from '../../scripts/lib/jev-breaker.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'jev-breaker-low-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let base = '';
let count = 0;
beforeEach(() => {
  count += 1;
  base = join(tmp, 'case-' + count);
  mkdirSync(base, { recursive: true });
});

const settingsOf = (extra = {}) => breakerSettings({ OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: base, ...extra }, 'http://127.0.0.1:9/v1', 'key');
const lowSettings = () => settingsOf({ OMC_JEV_BREAKER_TIMEOUT_LOW: '1' });
const NO_RESPONSE = { reason: 'no-response', opens: false };
const openings = (settings) => {
  const dir = openingsDirOf(settings);
  return existsSync(dir) ? readdirSync(dir).sort().map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8'))) : [];
};
const readState = (settings) => JSON.parse(readFileSync(join(settings.dir, 'breaker.json'), 'utf8'));
const timeouts = (settings, points, t0 = Date.now()) => {
  let last;
  points.forEach((point, index) => {
    last = recordFailure(settings, NO_RESPONSE, t0 + index * 100, point);
  });
  return last;
};

describe('breaker low scope for missing responses', () => {
  it('is off without the variable: three no-response failures of a low point hold back every point, nothing is logged', () => {
    const settings = settingsOf();
    expect(settings.timeoutLow).toBe(false);
    timeouts(settings, ['slop-warning', 'slop-warning', 'slop-warning']);
    const state = readState(settings);
    expect(state.reason).toBe('no-response');
    expect('scope' in state).toBe(false);
    expect('since_all' in state).toBe(false);
    expect(openings(settings)).toEqual([]);
    expect(admitRequest(settings, 'model-routing').skip?.mode).toBe('circuit-open');
    expect(noticeWanted({ reason: 'no-response', since: 1, until: 2 })).toBe(false);
    expect(claimOutageNotice(settings, 'session', readBreaker(settings, Date.now()))).toEqual(expect.any(String));
  });

  it('three missing responses of a low point in a minute hold back low points only (scope low), logged once', () => {
    const settings = lowSettings();
    const t0 = Date.now();
    timeouts(settings, ['slop-warning', 'slop-warning', 'slop-warning'], t0);
    const state = readState(settings);
    expect(state.reason).toBe('no-response');
    expect(state.scope).toBe('low');
    const rows = openings(settings);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'no-response', scope: 'low', seconds: 60, until: state.until, since: state.since });
    expect(admitRequest(settings, 'slop-warning').skip?.mode).toBe('circuit-open');
    expect(admitRequest(settings, 'slop-warning').skip?.breaker.scope).toBe('low');
    for (const point of ['model-routing', 'task-size', 'skill-trigger', 'loop-continuation']) {
      expect(admitRequest(settings, point).skip).toBeUndefined();
    }
    expect(openings(settings)).toHaveLength(1);
  });

  it('three missing responses of a high point in a minute hold back every point (no scope)', () => {
    const settings = lowSettings();
    timeouts(settings, ['model-routing', 'model-routing', 'model-routing']);
    const state = readState(settings);
    expect(state.reason).toBe('no-response');
    expect('scope' in state).toBe(false);
    expect(openings(settings)).toHaveLength(1);
    expect(openings(settings)[0].scope).toBe('all');
    for (const point of ['slop-warning', 'model-routing', 'task-size']) {
      expect(admitRequest(settings, point).skip?.mode).toBe('circuit-open');
    }
  });

  it('mixed failures: two low and one high give scope low; the third high one widens it to every point', () => {
    const settings = lowSettings();
    const t0 = Date.now();
    timeouts(settings, ['slop-warning', 'slop-warning', 'model-routing'], t0);
    const low = readState(settings);
    expect(low.scope).toBe('low');
    recordFailure(settings, NO_RESPONSE, t0 + 300, 'model-routing');
    expect(readState(settings).scope).toBe('low');
    expect(openings(settings)).toHaveLength(1);
    recordFailure(settings, NO_RESPONSE, t0 + 400, 'model-routing');
    const wide = readState(settings);
    expect('scope' in wide).toBe(false);
    expect(wide.reason).toBe('no-response');
    expect(wide.until).toBeGreaterThanOrEqual(low.until);
    expect(wide.since).toBe(low.since);
    const rows = openings(settings);
    expect(rows).toHaveLength(2);
    expect(rows[0].scope).toBe('low');
    expect(rows[1].scope).toBe('all');
  });

  it('a low opening never narrows or extends an open breaker of every point', () => {
    const settings = lowSettings();
    const t0 = Date.now();
    recordFailure(settings, { reason: 'http-429', opens: true, seconds: 20 }, t0 - 1000);
    const before = readState(settings);
    timeouts(settings, ['slop-warning', 'slop-warning', 'slop-warning'], t0);
    const after = readState(settings);
    expect('scope' in after).toBe(false);
    expect(after.reason).toBe('http-429');
    expect(after.until).toBe(before.until);
  });

  it('an opening for every point widens an open low scope and keeps its later end; since_all starts at the widening', () => {
    const settings = lowSettings();
    const t = Date.now();
    timeouts(settings, ['slop-warning', 'slop-warning', 'slop-warning'], t);
    const low = readBreaker(settings, t + 1000);
    expect(low.scope).toBe('low');
    expect('since_all' in low).toBe(false);
    recordFailure(settings, { reason: 'http-503', opens: true, seconds: 10 }, t + 1000);
    const wide = readBreaker(settings, t + 2000);
    expect('scope' in wide).toBe(false);
    expect(wide.until).toBe(low.until);
    expect(wide.since).toBe(low.since);
    expect(wide.since_all).toBe(t + 1000);
  });

  it('missing responses that only extend an open breaker of another reason leave its reason', () => {
    const settings = lowSettings();
    const t = Date.now();
    recordFailure(settings, { reason: 'http-503', opens: true, seconds: 20 }, t - 1000);
    timeouts(settings, ['model-routing', 'model-routing', 'model-routing'], t);
    const state = readBreaker(settings, t);
    expect(state.reason).toBe('http-503');
    expect('scope' in state).toBe(false);
  });

  it('since_all keeps the start of a chain of openings less than 15 minutes apart; a longer gap starts a new one', () => {
    const settings = lowSettings();
    const t = Date.now() - 40 * 60_000;
    const open = (at) => recordFailure(settings, { reason: 'http-429', opens: true, seconds: 60 }, at);
    open(t);
    open(t + 10 * 60_000);
    const a = readBreaker(settings, t + 10 * 60_000);
    open(t + 30 * 60_000);
    const b = readBreaker(settings, t + 30 * 60_000);
    expect(a.since_all).toBe(t);
    expect(b.since_all).toBe(t + 30 * 60_000);
    expect(b.since).toBe(t + 30 * 60_000);
  });

  it('classifies no-response as a failure that does not open the breaker by itself', () => {
    expect(classifyFailure({ noResponse: true })).toEqual(NO_RESPONSE);
  });
});

describe('breakerCovers and noticeWanted', () => {
  it('scope low covers only low points; a breaker without scope covers every point', () => {
    const low = { until: 2, reason: 'no-response', since: 1, scope: 'low' };
    expect(breakerCovers(low, 'slop-warning') && breakerCovers(low, 'learner-extraction') && breakerCovers(low, 'context-pruning')).toBe(true);
    expect(breakerCovers(low, 'model-routing') || breakerCovers(low, 'compaction') || breakerCovers(low, 'task-size') || breakerCovers(low, 'unknown') || breakerCovers(low, undefined)).toBe(false);
    expect(breakerCovers({ until: 2, reason: 'http-429', since: 1 }, 'model-routing')).toBe(true);
    expect(breakerCovers({ until: 2, reason: 'no-response', since: 1 }, 'model-routing')).toBe(true);
    expect(breakerCovers(undefined, 'slop-warning')).toBe(false);
  });

  it('a notice only for reasons other than no-response and for no-response longer than ten minutes', () => {
    const now = Date.now();
    const min = 60_000;
    expect(noticeWanted({ reason: 'no-response', since: now - min, until: now + min })).toBe(false);
    expect(noticeWanted({ reason: 'no-response', since: now - 9 * min, until: now + min })).toBe(false);
    expect(noticeWanted({ reason: 'no-response', since: now - 9 * min, until: now + min + 1000 })).toBe(true);
    expect(noticeWanted({ reason: 'no-response', since: now - 30 * min, until: now + min })).toBe(true);
    expect(noticeWanted({ reason: 'no-response', scope: 'low', since: now - 30 * min, until: now + min })).toBe(false);
    expect(noticeWanted({ reason: 'no-response', since: now - 30 * min, since_all: now - 2 * min, until: now + min })).toBe(false);
    expect(noticeWanted({ reason: 'no-response', since: now - 30 * min, since_all: now - 12 * min, until: now + min })).toBe(true);
    expect(noticeWanted({ reason: 'http-503', scope: 'low', since: now - 1000, until: now + min })).toBe(true);
    for (const reason of ['http-429', 'http-401', 'http-402', 'http-403', 'http-500', 'http-503', 'http-418', '']) {
      expect(noticeWanted({ reason, since: now - 1000, until: now + min })).toBe(true);
    }
    expect(noticeWanted(undefined)).toBe(false);
  });

  it('the outage notice of a short no-response outage is not claimed with the variable and is claimed again once it is long', () => {
    const settings = lowSettings();
    const now = Date.now();
    const shortOutage = { reason: 'no-response', since: now - 60_000, until: now + 60_000 };
    expect(claimOutageNotice(settings, 'session-a', shortOutage, now)).toBeUndefined();
    const longOutage = { reason: 'no-response', since: now - 30 * 60_000, until: now + 60_000 };
    expect(claimOutageNotice(settings, 'session-a', longOutage, now)).toEqual(expect.any(String));
  });
});
