/**
 * Tests for the opt-in sub-switches of the Jev delivery guard's daily computation
 * (OMC_JEV_GUARD_EFFORT, OMC_JEV_GUARD_USE_MARKER, OMC_JEV_GUARD_TIMEOUTS_ALARM in
 * scripts/lib/jev-delivery-guard.mjs). Without them the daily result is unchanged.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  TIMEOUTS_ALERT_MINUTES,
  TIMEOUTS_ALERT_OPENINGS,
  computeDelivery,
  countOpenings,
  deliveryMessage,
  levelFromScore,
  timeoutsMessage,
} from '../../scripts/lib/jev-delivery-guard.mjs';

const NOW = Date.now();
const HOUR = 3600 * 1000;
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();

let root;
let configDir;
let logDir;
let breakerDir;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jev-guard-switches-'));
  configDir = join(root, 'claude');
  logDir = join(root, 'log');
  breakerDir = join(root, 'breaker');
  mkdirSync(join(configDir, 'projects', 'proj', 'sess', 'subagents'), { recursive: true });
  mkdirSync(logDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const decision = (id, tier, score, ms = NOW - 3 * HOUR) => JSON.stringify({ ts: iso(ms), point: 'model-routing', mode: 'active', tool_use_id: id, answers: { 'model-tier': { choice: tier }, effort: { score } } });
const applied = (id, source, ms = NOW - 3 * HOUR) => JSON.stringify({ ts: iso(ms), point: 'model-routing', tool_use_id: id, applied: { model: { source } } });
const meta = (id, fields) => writeFileSync(join(configDir, 'projects', 'proj', 'sess', 'subagents', `agent-${id}.meta.json`), JSON.stringify({ toolUseId: id, ...fields }));
const opening = (ms, fields) => {
  mkdirSync(join(breakerDir, 'openings'), { recursive: true });
  writeFileSync(join(breakerDir, 'openings', `${ms}-x.json`), JSON.stringify({ ts: ms, scope: 'all', seconds: 60, until: ms + 60_000, since: ms, ...fields }));
};

function writeLogs() {
  writeFileSync(join(logDir, 'shadow.jsonl'), [
    decision('a1', 'opus', 2), // high effort wanted -> delivered with model and effort
    decision('a2', 'opus', 2), // model right, effort wrong
    decision('a3', 'sonnet', 1), // a named agent: the model only
    decision('a4', 'opus', 4), // a `use` marker call
    decision('a5', 'opus', 'x'), // no numeric score: left out with the effort check
  ].join('\n') + '\n');
  writeFileSync(join(logDir, 'applied.jsonl'), [applied('a4', 'marker'), applied('a1', 'model')].join('\n') + '\n');
  meta('a1', { model: 'opus', effort: 'high' });
  meta('a2', { model: 'opus', effort: 'low' });
  meta('a3', { model: 'sonnet', name: 'worker-1' });
  meta('a4', { model: 'opus', effort: 'low' });
  meta('a5', { model: 'opus', effort: 'low' });
}

describe('levelFromScore', () => {
  it('rounds to the nearest level, a half to the even one, and caps it', () => {
    expect(levelFromScore(0)).toBe('low');
    expect(levelFromScore(0.4)).toBe('low');
    expect(levelFromScore(0.5)).toBe('low');
    expect(levelFromScore(1.5)).toBe('high');
    expect(levelFromScore(2.5)).toBe('high');
    expect(levelFromScore(3.6)).toBe('max');
    expect(levelFromScore(9)).toBe('max');
    expect(levelFromScore(4, 'xhigh')).toBe('xhigh');
    expect(levelFromScore(4, 'nonsense')).toBe('max');
  });
});

describe('daily result without the switches', () => {
  it('compares the model only and adds none of the new fields', async () => {
    writeLogs();
    const result = await computeDelivery({ logDir, configDir, now: NOW, env: {} });
    expect(result).toMatchObject({ decisions: 5, withAgent: 5, delivered: 5 });
    for (const field of ['markerDecisions', 'namedAgents', 'namedModelMatching', 'breakerOpenings', 'breakerHeldMinutes']) {
      expect(field in result).toBe(false);
    }
    expect(deliveryMessage({ ...result, interruptedAgentHooks: 0, deliveredPercent: 100 })).toBeNull();
  });

  it('reads the breaker openings only with the alarm switch', async () => {
    opening(NOW - 2 * HOUR, { reason: 'no-response' });
    const result = await computeDelivery({ logDir, configDir, now: NOW, env: { OMC_JEV_BREAKER_DIR: breakerDir } });
    expect('breakerOpenings' in result).toBe(false);
  });
});

describe('OMC_JEV_GUARD_EFFORT', () => {
  it('compares model and effort, counts a named agent apart, and leaves a decision without a score out', async () => {
    writeLogs();
    const result = await computeDelivery({ logDir, configDir, now: NOW, env: { OMC_JEV_GUARD_EFFORT: '1' } });
    expect(result.decisions).toBe(4);
    expect(result.namedAgents).toBe(1);
    expect(result.namedModelMatching).toBe(1);
    expect(result.withAgent).toBe(3);
    expect(result.delivered).toBe(1);
    expect(result.deliveredPercent).toBe(33);
    const message = deliveryMessage({ ...result, interruptedAgentHooks: 0 });
    expect(message).toContain('1 of 3 Jev model and effort decisions reached the agent');
    expect(message).toContain('Named calls (the model only; the effort may not reach them): 1 of 1.');
  });
});

describe('OMC_JEV_GUARD_USE_MARKER', () => {
  it('leaves the decisions of marker calls out of the share', async () => {
    writeLogs();
    writeFileSync(join(logDir, 'applied.jsonl'), [applied('a4', 'marker'), applied('a2', 'model')].join('\n') + '\n');
    meta('a4', { model: 'haiku' });
    const result = await computeDelivery({ logDir, configDir, now: NOW, env: { OMC_JEV_GUARD_USE_MARKER: '1' } });
    expect(result.markerDecisions).toBe(1);
    expect(result.withAgent).toBe(4);
    expect(result.delivered).toBe(4);
    expect('namedAgents' in result).toBe(false);
    const message = deliveryMessage({ ...result, interruptedAgentHooks: 1 });
    expect(message).toContain('such as forceInherit,');
  });

  it('is fail-open when applied.jsonl is absent or has no marker rows', async () => {
    writeLogs();
    rmSync(join(logDir, 'applied.jsonl'));
    const result = await computeDelivery({ logDir, configDir, now: NOW, env: { OMC_JEV_GUARD_USE_MARKER: '1' } });
    expect(result.markerDecisions).toBe(0);
    expect(result.withAgent).toBe(5);
  });
});

describe('OMC_JEV_GUARD_TIMEOUTS_ALARM', () => {
  const env = () => ({ OMC_JEV_GUARD_TIMEOUTS_ALARM: '1', OMC_JEV_BREAKER_DIR: breakerDir });

  it('counts openings by no-response, all-point ones apart, other reasons apart, and the union of their time', async () => {
    const since = NOW - 24 * HOUR;
    opening(NOW - 5 * HOUR, { reason: 'no-response', scope: 'low', until: NOW - 5 * HOUR + 60_000 });
    opening(NOW - 5 * HOUR + 30_000, { reason: 'no-response', until: NOW - 5 * HOUR + 90_000 }); // overlaps the first
    opening(NOW - 3 * HOUR, { reason: 'http-429' });
    opening(NOW - 2 * HOUR, { reason: 'no-response', scope: 'panel' }); // a breaker of one point: not counted
    opening(since - 10 * MIN, { reason: 'no-response', until: since + 5 * MIN }); // began before the window, reaches into it
    const out = countOpenings(join(breakerDir, 'openings'), since, NOW);
    expect(out).toMatchObject({ timeouts: 2, timeoutsAll: 1, other: 1 });
    expect(out.minutes).toBe(6.5);
    const result = await computeDelivery({ logDir, configDir, now: NOW, env: env() });
    expect(result).toMatchObject({ breakerOpenings: 2, breakerOpeningsAll: 1, breakerOpeningsOther: 1, breakerHeldMinutes: 6.5 });
  });

  it('alarms above the thresholds only', () => {
    const base = { windowHours: 24 };
    expect(timeoutsMessage({ ...base, breakerOpenings: TIMEOUTS_ALERT_OPENINGS, breakerHeldMinutes: TIMEOUTS_ALERT_MINUTES })).toBeNull();
    expect(timeoutsMessage({ ...base })).toBeNull();
    const many = timeoutsMessage({ ...base, breakerOpenings: TIMEOUTS_ALERT_OPENINGS + 1, breakerHeldMinutes: 3 });
    expect(many).toContain(`opened the Jev breaker ${TIMEOUTS_ALERT_OPENINGS + 1} times`);
    expect(timeoutsMessage({ ...base, breakerOpenings: 1, breakerHeldMinutes: TIMEOUTS_ALERT_MINUTES + 1 })).toContain('min of held-back requests');
    const message = deliveryMessage({ ...base, interruptedAgentHooks: 0, deliveredPercent: 100, breakerOpenings: 50, breakerHeldMinutes: 5 });
    expect(message).toContain('opened the Jev breaker 50 times');
    expect(message).not.toContain('PreToolUse:Agent hooks interrupted');
  });

  it('removes openings older than 7 days only when asked to prune', () => {
    opening(NOW - 8 * 24 * HOUR, { reason: 'no-response' });
    const dir = join(breakerDir, 'openings');
    countOpenings(dir, NOW - 24 * HOUR, NOW);
    expect(existsSync(join(dir, `${NOW - 8 * 24 * HOUR}-x.json`))).toBe(true);
    countOpenings(dir, NOW - 24 * HOUR, NOW, { prune: true, wall: NOW });
    expect(existsSync(join(dir, `${NOW - 8 * 24 * HOUR}-x.json`))).toBe(false);
  });
});
