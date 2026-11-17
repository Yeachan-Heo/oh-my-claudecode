/* global process */
/**
 * Tests for the account payment alarm probe (scripts/jev-account-probe.mjs): it reads the breaker files and the Jev
 * logs of a temporary state and prints/writes an alarm for a 402 without a later successful Jev answer. No network.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const PROBE = join(fileURLToPath(import.meta.url), '..', '..', '..', 'scripts', 'jev-account-probe.mjs');
const MIN = 60_000;
const NOW = Date.now();
const iso = (t) => new Date(t).toISOString();

const root = mkdtempSync(join(tmpdir(), 'jev-account-probe-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let count = 0;
/** A fresh state directory (breaker files) and log directory. */
function fixture() {
  count += 1;
  const dir = join(root, `case-${count}`);
  const state = join(dir, 'breaker');
  const logs = join(dir, 'logs');
  mkdirSync(state, { recursive: true });
  mkdirSync(logs, { recursive: true });
  return { state, logs, alarm: join(state, 'account-alarm.txt'), probeLog: join(state, 'account-probe.jsonl') };
}
const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };
const appendRows = (path, rows) => { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, rows.map((row) => `${JSON.stringify(row)}\n`).join('')); };
const opening = (f, ts, extra = {}) => writeJson(join(f.state, 'openings', `${ts}-test.json`), { ts, reason: 'http-402', scope: 'all', seconds: 600, until: ts + 10 * MIN, since: ts, ...extra });
const breaker = (f, state, scope = 'abcdef0123456789') => writeJson(join(f.state, scope, 'breaker.json'), state);
const success = (t) => ({ ts: iso(t), point: 'model-routing', mode: 'active', jev: { type: 'noul', noul: 0.2 }, durationMs: 200 });
const skipped = (t) => ({ ts: iso(t), point: 'model-routing', mode: 'breaker', reason: 'http-402', durationMs: 0 });
const error402 = (t) => ({ ts: iso(t), point: 'learner-extraction', mode: 'degraded', jev: null, error: { status: 402, kind: 'http-402', retry_s: 600 }, durationMs: 250 });
const probeRows = (f) => (existsSync(f.probeLog) ? readFileSync(f.probeLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function run(f, extra = [], env = {}) {
  const clean = { ...process.env };
  delete clean.OMC_JEV_LOG_DIR;
  delete clean.OMC_JEV_BREAKER_DIR;
  const result = spawnSync(process.execPath, [PROBE, '--state-dir', f.state, '--log-dir', f.logs, ...extra], { env: { ...clean, ...env }, encoding: 'utf8' });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

describe('account probe', () => {
  it('rule B: an open breaker with reason http-402 gives exit 3 and an alarm file with a fresh write time', () => {
    const f = fixture();
    breaker(f, { until: NOW + 5 * MIN, reason: 'http-402', since: NOW - 20 * MIN, since_all: NOW - 20 * MIN });
    opening(f, NOW - 5 * MIN, { since: NOW - 20 * MIN });
    const result = run(f);
    expect(result.code).toBe(3);
    const text = readFileSync(f.alarm, 'utf8');
    expect(text.split('\n').filter(Boolean)).toHaveLength(1);
    expect(text).toMatch(/^\d{10} Jev account: payment error 402/);
    expect(Math.abs(Number(text.split(' ')[0]) - Math.floor(Date.now() / 1000))).toBeLessThan(30);
    expect(probeRows(f)).toHaveLength(1);
    expect(probeRows(f)[0]).toMatchObject({ alarm: true, rule: 'B' });
  });

  it('a breaker with another reason, an expired 402, or an end further than 31 minutes ahead gives no alarm', () => {
    for (const state of [
      { until: NOW + 5 * MIN, reason: 'http-429', since: NOW - MIN },
      { until: NOW - 5 * MIN, reason: 'http-402', since: NOW - 20 * MIN },
      { until: NOW + 40 * MIN, reason: 'http-402', since: NOW - MIN },
    ]) {
      const f = fixture();
      breaker(f, state);
      expect(run(f).code).toBe(0);
      expect(existsSync(f.alarm)).toBe(false);
    }
  });

  it('refreshes the write time on every run of a lasting alarm and writes a probe row only on a change', () => {
    const f = fixture();
    breaker(f, { until: NOW + 5 * MIN, reason: 'http-402', since: NOW - 20 * MIN });
    run(f, ['--now', String(NOW)]);
    run(f, ['--now', String(NOW + 2 * MIN)]);
    expect(Number(readFileSync(f.alarm, 'utf8').split(' ')[0])).toBe(Math.floor((NOW + 2 * MIN) / 1000));
    expect(probeRows(f)).toHaveLength(1);
  });

  it('a successful answer after the 402 clears the alarm, removes the file and writes a second probe row', () => {
    const f = fixture();
    opening(f, NOW - 30 * MIN);
    appendRows(join(f.logs, 'shadow.jsonl'), [skipped(NOW - 20 * MIN)]);
    expect(run(f).code).toBe(3);
    appendRows(join(f.logs, 'shadow.jsonl'), [success(NOW - 5 * MIN)]);
    expect(run(f).code).toBe(0);
    expect(existsSync(f.alarm)).toBe(false);
    expect(probeRows(f).map((row) => row.alarm)).toEqual([true, false]);
  });

  it('a trace of a successful answer in compact.jsonl also clears the alarm', () => {
    for (const row of [{ ts: iso(NOW - 5 * MIN), jev_noul: 0.3 }, { ts: iso(NOW - 5 * MIN), event: 'compact', result: 'jev' }]) {
      const f = fixture();
      opening(f, NOW - 30 * MIN);
      appendRows(join(f.logs, 'shadow.jsonl'), [skipped(NOW - 20 * MIN)]);
      appendRows(join(f.logs, 'compact.jsonl'), [row]);
      expect(run(f).code).toBe(0);
    }
  });

  it('rule A: an expired breaker and only held-back requests after the 402 give exit 3', () => {
    const f = fixture();
    opening(f, NOW - 30 * MIN);
    appendRows(join(f.logs, 'shadow.jsonl'), [skipped(NOW - 25 * MIN), skipped(NOW - 10 * MIN)]);
    const result = run(f, ['--json']);
    expect(result.code).toBe(3);
    expect(JSON.parse(result.out)).toMatchObject({ alarm: true, rule: 'A' });
  });

  it('a successful answer before the 402 does not clear the alarm, and a 402 only in shadow.jsonl alarms too', () => {
    const f = fixture();
    appendRows(join(f.logs, 'shadow.jsonl'), [success(NOW - 40 * MIN), error402(NOW - 30 * MIN)]);
    expect(run(f).code).toBe(3);
  });

  it('rotated archives of the logs count: a 402 or an answer that sits in an archive still decides the alarm', () => {
    const stamp = (t) => new Date(t).toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');
    // the 402 is only in shadow.jsonl, which rotates after the breaker has expired; a held-back request lands in the new file
    const held = fixture();
    appendRows(join(held.logs, `shadow-${stamp(NOW - 10 * MIN)}-4242.jsonl`), [error402(NOW - 30 * MIN), skipped(NOW - 20 * MIN)]);
    appendRows(join(held.logs, 'shadow.jsonl'), [skipped(NOW - 5 * MIN)]);
    expect(run(held).code).toBe(3);
    expect(existsSync(held.alarm)).toBe(true);
    // an answer in an archive that is newer than the 402 clears it, whether the 402 is in the live file or in an older archive
    const answered = fixture();
    appendRows(join(answered.logs, `shadow-${stamp(NOW - 20 * MIN)}-4242.jsonl`), [error402(NOW - 30 * MIN)]);
    appendRows(join(answered.logs, `shadow-${stamp(NOW - 10 * MIN)}-4243.jsonl`), [success(NOW - 15 * MIN)]);
    appendRows(join(answered.logs, 'shadow.jsonl'), [skipped(NOW - 5 * MIN)]);
    expect(run(answered).code).toBe(0);
    // a compact.jsonl archive carries the answer too
    const compact = fixture();
    appendRows(join(compact.logs, 'shadow.jsonl'), [error402(NOW - 30 * MIN)]);
    appendRows(join(compact.logs, `compact-${stamp(NOW - 10 * MIN)}-77.jsonl`), [{ ts: iso(NOW - 15 * MIN), jev_noul: 0.3 }]);
    expect(run(compact).code).toBe(0);
    // an archive rotated more than two days ago holds nothing that can matter and is not read; another name is never read
    const old = fixture();
    appendRows(join(old.logs, 'shadow.jsonl'), [skipped(NOW - 5 * MIN)]);
    appendRows(join(old.logs, `shadow-${stamp(NOW - 3 * 24 * 3600_000)}-1.jsonl`), [error402(NOW - 3 * 24 * 3600_000 - MIN)]);
    appendRows(join(old.logs, `denials-${stamp(NOW - 10 * MIN)}-1.jsonl`), [error402(NOW - 30 * MIN)]);
    expect(run(old).code).toBe(0);
  });

  it('a 402 without a readable answer log and without an open breaker is no evidence: exit 0', () => {
    const f = fixture();
    opening(f, NOW - 30 * MIN);
    expect(run(f).code).toBe(0);
  });

  it('rule A holds for a 402 of the last 24 hours only', () => {
    const old = fixture();
    opening(old, NOW - 25 * 3600_000);
    appendRows(join(old.logs, 'shadow.jsonl'), [skipped(NOW - 24 * 3600_000 + 5 * MIN)]);
    expect(run(old).code).toBe(0);
    const recent = fixture();
    opening(recent, NOW - 23 * 3600_000);
    appendRows(join(recent.logs, 'shadow.jsonl'), [skipped(NOW - 22 * 3600_000)]);
    expect(run(recent).code).toBe(3);
  });

  it('no files: exit 0 and no output files', () => {
    const f = fixture();
    expect(run(f).code).toBe(0);
    expect(existsSync(f.alarm)).toBe(false);
    expect(existsSync(f.probeLog)).toBe(false);
  });

  it('a broken breaker.json gives exit 2 and leaves an existing alarm file alone', () => {
    const f = fixture();
    breaker(f, { until: NOW + 5 * MIN, reason: 'http-402', since: NOW - MIN }, 'aaaaaaaaaaaaaaaa');
    expect(run(f).code).toBe(3);
    const before = readFileSync(f.alarm, 'utf8');
    breaker(f, '{not json', 'bbbbbbbbbbbbbbbb');
    const result = run(f);
    expect(result.code).toBe(2);
    expect(result.err).toContain('read error');
    expect(readFileSync(f.alarm, 'utf8')).toBe(before);
  });

  it('--alarm-file moves the alarm file and the probe log; OMC_JEV_LOG_DIR and OMC_JEV_BREAKER_DIR are the defaults', () => {
    const f = fixture();
    const alarm = join(root, `elsewhere-${count}`, 'alarm.txt');
    opening(f, NOW - 30 * MIN);
    appendRows(join(f.logs, 'shadow.jsonl'), [skipped(NOW - 10 * MIN)]);
    const result = spawnSync(process.execPath, [PROBE, '--alarm-file', alarm], { env: { ...process.env, OMC_JEV_BREAKER_DIR: f.state, OMC_JEV_LOG_DIR: f.logs }, encoding: 'utf8' });
    expect(result.status).toBe(3);
    expect(existsSync(alarm)).toBe(true);
    expect(existsSync(join(dirname(alarm), 'account-probe.jsonl'))).toBe(true);
    expect(existsSync(f.alarm)).toBe(false);
  });

  it('reads a log longer than the first read window and still reaches a successful answer after the 402', () => {
    const f = fixture();
    opening(f, NOW - 60 * MIN);
    const rows = [success(NOW - 50 * MIN)];
    for (let i = 0; i < 30_000; i += 1) rows.push({ ts: iso(NOW - 40 * MIN + i), point: 'slop-warning', mode: 'active', jev: { type: 'noul', noul: 0.1 }, pad: 'x'.repeat(180) });
    appendRows(join(f.logs, 'shadow.jsonl'), rows);
    expect(run(f).code).toBe(0);
  });
});
