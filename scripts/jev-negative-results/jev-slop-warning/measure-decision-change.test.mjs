// Run with: node --test scripts/jev-negative-results/jev-slop-warning/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appliedChange, measure, noulOf } from './measure-decision-change.mjs';
import { generate } from './make-synthetic-log.mjs';

test('recomputed and applied counts agree with the generator at the same threshold', () => {
  const { shadow, applied, expected } = generate({ rows: 8000, seed: 7, threshold: 0.8 });
  const result = measure({ shadow, applied, threshold: 0.8 });
  assert.equal(result.activeAnswered, expected.active);
  assert.equal(result.rowsByMode.breaker ?? 0, expected.breaker);
  assert.equal(result.applied.added, expected.added);
  assert.equal(result.applied.removed, expected.removed);
  assert.equal(result.recomputedFromShadow[0.8].added, expected.added);
  assert.equal(result.recomputedFromShadow[0.8].removed, expected.removed);
});

test('a lower threshold changes more decisions', () => {
  const { shadow, applied } = generate({ rows: 8000, seed: 7 });
  const { recomputedFromShadow: rc } = measure({ shadow, applied });
  assert.ok(rc[0.5].changed >= rc[0.7].changed);
  assert.ok(rc[0.7].changed >= rc[0.8].changed);
});

test('day filter honours the timezone offset', () => {
  const shadow = [{ ts: '2026-01-14T23:30:00Z', point: 'slop-warning', mode: 'active', heuristic: false, jev: { noul: 0.1 }, durationMs: 1 }];
  assert.equal(measure({ shadow, applied: [], day: '2026-01-14' }).activeAnswered, 1);
  assert.equal(measure({ shadow, applied: [], day: '2026-01-15', tzOffsetHours: 1 }).activeAnswered, 1);
  assert.equal(measure({ shadow, applied: [], day: '2026-01-15' }).activeAnswered, 0);
});

test('both applied.jsonl shapes are read; other fields are not needed', () => {
  assert.deepEqual(appliedChange({ applied: { action: { from: 'none', to: 'warn', noul: 0.9 } } }), { from: false, to: true, tool: '(not logged)', noul: 0.9 });
  assert.deepEqual(appliedChange({ applied: { tool: 'Bash', warning: { from: true, to: false }, noul: 0.2 } }), { from: true, to: false, tool: 'Bash', noul: 0.2 });
  assert.equal(appliedChange({ applied: { model: 'x' } }), undefined);
  assert.equal(noulOf({ jev: { noul: true } }), 1);
  assert.equal(noulOf({ jev: {} }), undefined);
});
