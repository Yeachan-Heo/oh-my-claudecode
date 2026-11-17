import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', '..', 'tools', 'diagnostics', 'compaction_window_drops.py');

const TO = '2026-11-14T12:00:00Z';

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'test-window-drops-'));
}

function save(dir, name, lines) {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
  return path;
}

function call(mid, ts, window, opts = {}) {
  const usage = { input_tokens: window - 200, cache_read_input_tokens: 100, cache_creation_input_tokens: 100 };
  if (opts.usage) Object.assign(usage, opts.usage);
  const row = {
    type: 'assistant',
    timestamp: ts,
    sessionId: opts.session ?? 'S',
    uuid: 'u-' + mid,
    message: { id: mid, model: opts.model ?? 'claude-opus-5-5', usage, content: [] },
  };
  return JSON.stringify(row);
}

function req(rid, ts, opts = {}) {
  const row = {
    type: 'api-request',
    timestamp: ts,
    id: rid,
    querySource: opts.qs ?? 'repl_main_thread',
    keep: opts.keep ?? 0,
    tail: Array.from({ length: opts.tail ?? 0 }, (_x, i) => ({ x: i })),
    shapeHash: opts.sh ?? 'h1',
  };
  if (opts.base !== undefined) row.base = opts.base;
  if (opts.noKeep) delete row.keep;
  return JSON.stringify(row);
}
function boundary(ts, trigger = 'manual', pre = 300000) {
  return JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    timestamp: ts,
    compactMetadata: { trigger, preTokens: pre, postTokens: 100000 },
  });
}

function compact(ts, sid, agentId, result, trigger) {
  return JSON.stringify({ ts, event: 'compact', session_id: sid, agent_id: agentId, trigger, result });
}

function after(ts, sid, agentId, compactTs, tokens) {
  return JSON.stringify({ ts, event: 'after', session_id: sid, agent_id: agentId, compact_ts: compactTs, tokens_after_real: tokens });
}

function run(dir, files, opts = {}) {
  const argv = ['-I', SCRIPT, '--json', '--to', opts.to ?? TO, '--days', String(opts.days ?? 7), '--compact', join(dir, 'compaction.jsonl')];
  for (const f of files) argv.push('--transcript', f);
  if (opts.extra) argv.push(...opts.extra);
  const proc = spawnSync('python3', argv, { encoding: 'utf8' });
  let json = null;
  if (proc.status === 0 && proc.stdout.trim()) json = JSON.parse(proc.stdout);
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr, json };
}

function resultRow(report, name) {
  return report.results.find((w) => w.name === name);
}

function wilsonLower(k, n) {
  if (n <= 0) return null;
  if (k <= 0) return 0.0;
  const p = k / n;
  const z = 1.959963984540054;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const root = Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0.0, (p + z2 / (2 * n) - z * root) / denom);
}

function assertNoNull(value, path = '') {
  if (value === null) expect.fail('null in field: ' + path);
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoNull(v, path + '[' + i + ']'));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoNull(v, path + '.' + k);
  }
}
describe('compaction_window_drops.py', () => {
  it('module compaction confirmed by two readings, plugin trigger', () => {
    const dir = makeDir();
    try {
      const lines = [
        req('rq1', '2026-11-14T09:00:00Z', { base: 'rq0', keep: 2, tail: 3 }),
        call('msg_1', '2026-11-14T09:00:01Z', 300000, { session: 'S1' }),
        boundary('2026-11-14T09:05:00Z', 'manual', 300000),
        req('rq2', '2026-11-14T09:05:01Z', { base: null, keep: 0, tail: 5 }),
        call('msg_2', '2026-11-14T09:05:02Z', 100000, { session: 'S1' }),
      ];
      const file = save(dir, 'S1.jsonl', lines);
      save(dir, 'compaction.jsonl', [
        compact('2026-11-14T09:05:00.500Z', 'S1', null, 'jev', 'plugin'),
        after('2026-11-14T09:05:01Z', 'S1', null, '2026-11-14T09:05:00.500Z', 100000),
      ]);
      const run1 = run(dir, [file]);
      expect(run1.status).toBe(0);
      const r = run1.json;
      expect(r.n.value).toBe(1);
      const s = r.drops[0];
      expect(s.cause).toBe('module_compaction');
      expect(s.readings.confirmation).toBe('confirmed by two readings');
      expect(s.readings.boundary).toBe('yes');
      expect(s.readings.after).toBe('yes');
      expect(r.trigger).toEqual({ plugin: 1 });
      expect(r.model).toEqual({ 'claude-opus-5-5': 1 });
      expect(r.n.unit).toBe('window drop');
      expect(r.template).toBe('compaction-report/1');
      const templateFields = ['template', 'metric', 'script', 'generated_at', 'rule', 'period', 'n', 'model', 'trigger', 'control_arm', 'data_quality', 'results', 'min_support', 'caveats'];
      for (const field of templateFields) expect(field in r).toBe(true);
      expect(r.metric).toBe('window-drops');
      expect(r.min_support).toBe(30);
      expect(Array.isArray(r.caveats) && r.caveats.length >= 4).toBe(true);
      expect(r.period.from).toBe('2026-11-07T12:00:00Z');
      expect(r.period.to).toBe(TO);
      assertNoNull(r);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('host fallback without after and without a marker, one reading, compact_without_after gap', () => {
    const dir = makeDir();
    try {
      const lines = [
        req('rq1', '2026-11-14T09:00:00Z', { base: 'rq0', keep: 2, tail: 3 }),
        call('msg_1', '2026-11-14T09:00:01Z', 300000, { session: 'S2' }),
        req('rq2', '2026-11-14T09:10:00Z', { base: 'rq1', keep: 0, tail: 1 }),
        call('msg_2', '2026-11-14T09:10:01Z', 100000, { session: 'S2' }),
      ];
      const file = save(dir, 'S2.jsonl', lines);
      save(dir, 'compaction.jsonl', [compact('2026-11-14T09:05:00Z', 'S2', null, 'fallback', 'manual')]);
      const run1 = run(dir, [file]);
      expect(run1.status).toBe(0);
      const s = run1.json.drops[0];
      expect(run1.json.n.value).toBe(1);
      expect(s.cause).toBe('host_after_fallback');
      expect(s.readings.confirmation).toBe('one reading');
      expect(s.readings.prefix).toBe('broken');
      expect(run1.json.data_quality[0].gaps.compact_without_after).toBe(1);
      assertNoNull(run1.json);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('host boundary only, preTokens matching the window (+/-10%)', () => {
    const dir = makeDir();
    try {
      const lines = [
        req('rq1', '2026-11-14T09:00:00Z', { base: null, keep: 0, tail: 1 }),
        call('msg_1', '2026-11-09T09:00:01Z', 300000, { session: 'S3' }),
        boundary('2026-11-14T09:05:00Z', 'auto', 300000),
        req('rq2', '2026-11-14T09:05:01Z', { base: null, keep: 0, tail: 1 }),
        call('msg_2', '2026-11-14T09:05:02Z', 100000, { session: 'S3' }),
      ];
      const file = save(dir, 'S3.jsonl', lines);
      save(dir, 'compaction.jsonl', []);
      const run1 = run(dir, [file]);
      expect(run1.status).toBe(0);
      const r = run1.json;
      const s = r.drops[0];
      expect(s.cause).toBe('host');
      expect(s.readings.pretokens_match).toBe('yes');
      const row = resultRow(r, 'host: preTokens matching the window (+/-10%)');
      expect(row.numerator).toBe(1);
      expect(row.denominator).toBe(1);
      expect(row.share).toBe('insufficient data');
      expect(r.trigger.auto).toBe(1);
      assertNoNull(r);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('advisor trap: zero drops from iterations, 1 drop from main fields', () => {
    const dir = makeDir();
    try {
      const advisorUsage = {
        input_tokens: 400000,
        cache_read_input_tokens: 45000,
        cache_creation_input_tokens: 4500,
        iterations: [
          { type: 'message', input_tokens: 150000, cache_read_input_tokens: 5000, cache_creation_input_tokens: 1000 },
          { type: 'advisor_message', input_tokens: 137000 },
          { type: 'message', input_tokens: 150000, cache_read_input_tokens: 5500, cache_creation_input_tokens: 1000 },
        ],
      };
      const lines = [
        req('rq1', '2026-11-14T09:00:00Z', { base: 'rq0', keep: 2, tail: 3 }),
        call('msg_1', '2026-11-14T09:00:01Z', 150000, { session: 'S4' }),
        req('rq2', '2026-11-14T09:05:00Z', { base: 'rq1', keep: 5, tail: 1 }),
        call('msg_2', '2026-11-14T09:05:01Z', 156500, { session: 'S4', usage: advisorUsage }),
        req('rq3', '2026-11-14T09:10:00Z', { base: 'rq2', keep: 6, tail: 1 }),
        call('msg_3', '2026-11-14T09:10:01Z', 160000, { session: 'S4' }),
      ];
      const file = save(dir, 'S4.jsonl', lines);
      save(dir, 'compaction.jsonl', []);
      const run1 = run(dir, [file]);
      expect(run1.status).toBe(0);
      const r = run1.json;
      expect(r.n.value).toBe(0);
      expect(r.drops.length).toBe(0);
      expect(r.drops_from_main_fields).toBe(1);
      expect(r.model).toBe('unavailable');
      expect(r.trigger).toBe('unavailable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('continuous prefix without a marker: no_cut_prefix', () => {
    const dir = makeDir();
    try {
      const lines = [
        req('rq1', '2026-11-14T09:00:00Z', { base: 'rq0', keep: 2, tail: 3 }),
        call('msg_1', '2026-11-14T09:00:01Z', 300000, { session: 'S5' }),
        req('rq2', '2026-11-14T09:10:00Z', { base: 'rq1', keep: 5, tail: 1 }),
        call('msg_2', '2026-11-14T09:10:01Z', 100000, { session: 'S5' }),
      ];
      const file = save(dir, 'S5.jsonl', lines);
      save(dir, 'compaction.jsonl', []);
      const run1 = run(dir, [file]);
      expect(run1.status).toBe(0);
      const r = run1.json;
      const s = r.drops[0];
      expect(r.n.value).toBe(1);
      expect(s.cause).toBe('no_cut_prefix');
      expect(s.readings.prefix).toBe('continuous');
      expect(s.readings.shape_change).toBe('no');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('broken prefix, 3700 s gap: cut_without_marker, after_60min_gap', () => {
    const dir = makeDir();
    try {
      const lines = [
        req('rq1', '2026-11-14T09:00:00Z', { base: 'rq0', keep: 2, tail: 3 }),
        call('msg_1', '2026-11-14T09:00:01Z', 300000, { session: 'S6' }),
        req('rq2', '2026-11-14T10:01:40Z', { base: 'rq1', keep: 0, tail: 1 }),
        call('msg_2', '2026-11-14T10:01:41Z', 100000, { session: 'S6' }),
      ];
      const file = save(dir, 'S6.jsonl', lines);
      save(dir, 'compaction.jsonl', []);
      const run1 = run(dir, [file]);
      expect(run1.status).toBe(0);
      const s = run1.json.drops[0];
      expect(s.cause).toBe('cut_without_marker');
      expect(s.readings.after_60min_gap).toBe('yes');
      expect(s.readings.gap_s).toBe(3700);
      expect(s.readings.confirmation).toBe('no second reading');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no api-request rows: no_cause, prefix unavailable, gap counter', () => {
    const dir = makeDir();
    try {
      const lines = [
        call('msg_1', '2026-11-14T09:00:01Z', 300000, { session: 'S7' }),
        call('msg_2', '2026-11-14T09:10:01Z', 100000, { session: 'S7' }),
      ];
      const file = save(dir, 'S7.jsonl', lines);
      save(dir, 'compaction.jsonl', []);
      const run1 = run(dir, [file]);
      expect(run1.status).toBe(0);
      const r = run1.json;
      const s = r.drops[0];
      expect(s.cause).toBe('no_cause');
      expect(s.readings.prefix).toBe('unavailable');
      expect(r.data_quality[1].gaps.calls_without_api_request).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('side task: querySource change', () => {
    const dir = makeDir();
    try {
      const lines = [
        req('rq1', '2026-11-14T09:00:00Z', { base: 'rq0', keep: 1, tail: 1 }),
        call('msg_1', '2026-11-14T09:00:01Z', 300000, { session: 'S8' }),
        req('rq2', '2026-11-14T09:10:00Z', { base: 'rq1', keep: 3, tail: 0, qs: 'sdk' }),
        call('msg_2', '2026-11-14T09:10:01Z', 100000, { session: 'S8' }),
      ];
      const file = save(dir, 'S8.jsonl', lines);
      save(dir, 'compaction.jsonl', []);
      const run1 = run(dir, [file]);
      expect(run1.status).toBe(0);
      const s = run1.json.drops[0];
      expect(s.cause).toBe('side_task');
      expect(s.readings.query_source_current).toBe('sdk');
      expect(s.readings.query_source_previous).toBe('repl_main_thread');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('copied history and a from-scratch request: new_process confirmed', () => {
    const dir = makeDir();
    try {
      const fileA = save(dir, 'fileA.jsonl', [
        req('rq1', '2026-11-14T09:00:00Z', { base: 'rq0', keep: 2, tail: 3 }),
        call('msg_1', '2026-11-14T09:00:01Z', 200000, { session: 'S9' }),
        req('rq2', '2026-11-14T09:05:00Z', { base: 'rq1', keep: 5, tail: 2 }),
        call('msg_2', '2026-11-14T09:05:01Z', 390000, { session: 'S9' }),
      ]);
      const fileB = save(dir, 'fileB.jsonl', [
        call('msg_1', '2026-11-14T09:00:01Z', 200000, { session: 'S9' }),
        call('msg_2', '2026-11-14T09:05:01Z', 390000, { session: 'S9' }),
        req('rq3', '2026-11-14T09:10:00Z', { keep: 0, tail: 9 }),
        call('msg_3', '2026-11-14T09:10:01Z', 107000, { session: 'S9' }),
      ]);
      save(dir, 'compaction.jsonl', []);
      const run1 = run(dir, [fileA, fileB]);
      expect(run1.status).toBe(0);
      const r = run1.json;
      expect(r.n.value).toBe(1);
      const s = r.drops[0];
      expect(s.cause).toBe('new_process');
      expect(s.readings.confirmation).toBe('confirmed by two readings');
      expect(s.readings.copied_history).toBe('yes');
      expect(s.readings.built_from_scratch).toBe('yes');
      expect(s.file).toBe(fileB);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sessionId change within a file and a keep-0 request: new_process confirmed', () => {
    const dir = makeDir();
    try {
      const file = save(dir, 'S9b.jsonl', [
        req('rq1', '2026-11-14T09:00:00Z', { base: 'rq0', keep: 2, tail: 3 }),
        call('msg_1', '2026-11-14T09:00:01Z', 390000, { session: 'S9' }),
        req('rq2', '2026-11-14T09:10:00Z', { keep: 0, tail: 5 }),
        call('msg_2', '2026-11-14T09:10:01Z', 107000, { session: 'S9x' }),
      ]);
      save(dir, 'compaction.jsonl', []);
      const run1 = run(dir, [file]);
      expect(run1.status).toBe(0);
      const s = run1.json.drops[0];
      expect(s.cause).toBe('new_process');
      expect(s.readings.session_change).toBe('yes');
      expect(s.readings.confirmation).toBe('confirmed by two readings');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the same pair in copies counted once, drops_duplicated_from_copies = 1', () => {
    const dir = makeDir();
    try {
      const fileA = save(dir, 'fileA.jsonl', [
        call('msg_x', '2026-11-14T09:00:01Z', 300000, { session: 'S9a' }),
        call('msg_y', '2026-11-14T09:10:01Z', 100000, { session: 'S9a' }),
      ]);
      const fileB = save(dir, 'fileB.jsonl', [
        call('msg_x', '2026-11-14T09:00:01Z', 300000, { session: 'S9a' }),
        call('msg_y', '2026-11-14T09:10:01Z', 100000, { session: 'S9a' }),
      ]);
      save(dir, 'compaction.jsonl', []);
      const run1 = run(dir, [fileA, fileB]);
      expect(run1.status).toBe(0);
      const r = run1.json;
      expect(r.n.value).toBe(1);
      expect(r.data_quality[1].gaps.drops_duplicated_from_copies).toBe(1);
      expect(r.drops[0].file).toBe(fileA);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('continuous prefix with a shapeHash change: no_cut_shape_change', () => {
    const dir = makeDir();
    try {
      const file = save(dir, 'S9b-shape.jsonl', [
        req('rq1', '2026-11-14T09:00:00Z', { base: 'rq0', keep: 2, tail: 3, sh: 'h1' }),
        call('msg_1', '2026-11-14T09:00:01Z', 300000, { session: 'S9b' }),
        req('rq2', '2026-11-14T09:10:00Z', { base: 'rq1', keep: 5, tail: 1, sh: 'h2' }),
        call('msg_2', '2026-11-14T09:10:01Z', 100000, { session: 'S9b' }),
      ]);
      save(dir, 'compaction.jsonl', []);
      const run1 = run(dir, [file]);
      expect(run1.status).toBe(0);
      const s = run1.json.drops[0];
      expect(s.cause).toBe('no_cut_shape_change');
      expect(s.readings.shape_change).toBe('yes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('missing base in both requests gives broken; a request without keep gives no_cause', () => {
    const dir = makeDir();
    try {
      const fileA = save(dir, 'fileA9c.jsonl', [
        req('rq1', '2026-11-14T09:00:00Z', { keep: 2, tail: 1 }),
        call('msg_1', '2026-11-14T09:00:01Z', 300000, { session: 'S9c' }),
        req('rq2', '2026-11-14T09:10:00Z', { keep: 4, tail: 0 }),
        call('msg_2', '2026-11-14T09:10:01Z', 100000, { session: 'S9c' }),
      ]);
      save(dir, 'compaction.jsonl', []);
      const run1 = run(dir, [fileA]);
      expect(run1.status).toBe(0);
      const s = run1.json.drops[0];
      expect(s.readings.prefix).toBe('broken');
      expect(s.cause).toBe('cut_without_marker');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('request without keep: prefix unavailable, cause no_cause', () => {
    const dir = makeDir();
    try {
      const file = save(dir, 'S9c2.jsonl', [
        req('rq1', '2026-11-14T09:00:00Z', { base: 'rq0', keep: 2, tail: 3 }),
        call('msg_1', '2026-11-14T09:00:01Z', 300000, { session: 'S9c' }),
        req('rq2', '2026-11-14T09:10:00Z', { base: 'rq1', noKeep: true, sh: 'h9' }),
        call('msg_2', '2026-11-14T09:10:01Z', 100000, { session: 'S9c' }),
      ]);
      save(dir, 'compaction.jsonl', []);
      const run1 = run(dir, [file]);
      expect(run1.status).toBe(0);
      const s = run1.json.drops[0];
      expect(s.readings.prefix).toBe('unavailable');
      expect(s.cause).toBe('no_cause');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reverse check and compact_without_drop', () => {
    const dir = makeDir();
    try {
      const file = save(dir, 'S9d.jsonl', [
        req('rq1', '2026-11-14T09:00:00Z', { base: 'rq0', keep: 2, tail: 3 }),
        call('msg_1', '2026-11-14T09:00:01Z', 300000, { session: 'S9d' }),
        req('rq2', '2026-11-14T09:10:00Z', { base: 'rq1', keep: 5, tail: 1 }),
        call('msg_2', '2026-11-14T09:10:01Z', 350000, { session: 'S9d' }),
      ]);
      save(dir, 'compaction.jsonl', [
        compact('2026-11-14T09:05:00Z', 'S9d', null, 'jev', 'plugin'),
        after('2026-11-14T09:05:01Z', 'S9d', null, '2026-11-14T09:05:00Z', 320000),
      ]);
      const run1 = run(dir, [file]);
      expect(run1.status).toBe(0);
      const r = run1.json;
      expect(r.n.value).toBe(0);
      const control = resultRow(r, 'compact rows in period with a matched drop');
      expect(control.numerator).toBe(0);
      expect(control.denominator).toBe(1);
      expect(r.compact_without_drop.length).toBe(1);
      expect(r.compact_without_drop[0].ts).toBe('2026-11-14T09:05:00Z');
      expect(r.compact_without_drop[0].agent_id).toBe('unavailable');
      expect(r.control_arm.n).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a 15000-token drop at 7.5% does not pass the percent threshold (AND of thresholds)', () => {
    const dir = makeDir();
    try {
      const file = save(dir, 'S10.jsonl', [
        call('msg_1', '2026-11-14T09:00:01Z', 200000, { session: 'S10' }),
        call('msg_2', '2026-11-14T09:10:01Z', 185000, { session: 'S10' }),
        call('msg_3', '2026-11-14T09:20:01Z', 180000, { session: 'S10' }),
      ]);
      save(dir, 'compaction.jsonl', []);
      const run1 = run(dir, [file]);
      expect(run1.status).toBe(0);
      const r = run1.json;
      expect(r.n.value).toBe(0);
      expect(r.drops_from_main_fields).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('duplicate message.id counted once, synthetic and zero window skipped', () => {
    const dir = makeDir();
    try {
      const synthetic = JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-14T09:05:00Z',
        sessionId: 'S11',
        uuid: 'u-syn',
        message: { id: 'msg_syn', model: '<synthetic>', usage: { input_tokens: 250000 }, content: [] },
      });
      const file = save(dir, 'S11.jsonl', [
        call('msg_1', '2026-11-14T09:00:01Z', 300000, { session: 'S11' }),
        call('msg_1', '2026-11-14T09:00:01Z', 300000, { session: 'S11' }),
        synthetic,
        call('msg_zero', '2026-11-14T09:07:00Z', 0, { session: 'S11', usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
        call('msg_2', '2026-11-14T09:10:01Z', 100000, { session: 'S11' }),
      ]);
      save(dir, 'compaction.jsonl', []);
      const run1 = run(dir, [file]);
      expect(run1.status).toBe(0);
      const r = run1.json;
      expect(r.n.value).toBe(1);
      expect(r.data_quality[1].gaps.zero_window).toBe(1);
      expect(r.data_quality[1].gaps.calls_without_api_request).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('message without usage followed by same message ID with usage is counted', () => {
    const dir = makeDir();
    try {
      const withoutUsage = JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-14T09:00:01Z',
        sessionId: 'S14',
        uuid: 'u-no-usage',
        message: { id: 'msg_no_usage', model: 'claude-opus-5-5', content: [] },
      });
      const file = save(dir, 'S14.jsonl', [
        withoutUsage,
        call('msg_no_usage', '2026-11-14T09:00:02Z', 300000, { session: 'S14' }),
        call('msg_2', '2026-11-14T09:10:01Z', 100000, { session: 'S14' }),
      ]);
      save(dir, 'compaction.jsonl', []);
      const run1 = run(dir, [file]);
      expect(run1.status).toBe(0);
      const r = run1.json;
      // Both msg_no_usage (second occurrence with usage) and msg_2 should be counted: n=1 (drop between them)
      // msg_no_usage should be counted once it has usage, not skipped because of the first fragment
      expect(r.n.value).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a drop outside the period is not counted', () => {
    const dir = makeDir();
    try {
      const file = save(dir, 'S12.jsonl', [
        call('msg_1', '2026-11-01T09:00:01Z', 300000, { session: 'S12' }),
        call('msg_2', '2026-11-01T09:10:01Z', 100000, { session: 'S12' }),
      ]);
      save(dir, 'compaction.jsonl', []);
      const run1 = run(dir, [file]);
      expect(run1.status).toBe(0);
      expect(run1.json.n.value).toBe(0);
      expect(run1.json.model).toBe('unavailable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('subagent matched by agent_id; null does not match a subagent', () => {
    const dir = makeDir();
    try {
      const fileA = save(dir, join('S13', 'subagents', 'agent-aX1.jsonl'), [
        req('rq1', '2026-11-14T09:00:00Z', { base: null, keep: 0, tail: 1 }),
        call('msg_1', '2026-11-14T09:00:01Z', 300000, { session: 'S13' }),
        boundary('2026-11-14T09:05:00Z', 'manual', 300000),
        req('rq2', '2026-11-14T09:05:01Z', { base: null, keep: 0, tail: 1 }),
        call('msg_2', '2026-11-14T09:05:02Z', 100000, { session: 'S13' }),
      ]);
      save(dir, 'compaction.jsonl', [
        compact('2026-11-14T09:05:00.200Z', 'S13', 'aX1', 'jev', 'plugin'),
        after('2026-11-14T09:05:01Z', 'S13', 'aX1', '2026-11-14T09:05:00.200Z', 100000),
      ]);
      const run1 = run(dir, [fileA]);
      expect(run1.status).toBe(0);
      const s = run1.json.drops[0];
      expect(s.agent_id).toBe('aX1');
      expect(s.cause).toBe('module_compaction');
      expect(s.readings.journal).toBe('jev');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the same compact row with agent_id null does not match a subagent', () => {
    const dir = makeDir();
    try {
      const file = save(dir, join('S13b', 'subagents', 'agent-aX1.jsonl'), [
        req('rq1', '2026-11-14T09:00:00Z', { base: null, keep: 0, tail: 1 }),
        call('msg_1', '2026-11-14T09:00:01Z', 300000, { session: 'S13b' }),
        boundary('2026-11-14T09:05:00Z', 'manual', 300000),
        req('rq2', '2026-11-14T09:05:01Z', { base: null, keep: 0, tail: 1 }),
        call('msg_2', '2026-11-14T09:05:02Z', 100000, { session: 'S13b' }),
      ]);
      save(dir, 'compaction.jsonl', [
        compact('2026-11-14T09:05:00.200Z', 'S13b', null, 'jev', 'plugin'),
        after('2026-11-14T09:05:01Z', 'S13b', null, '2026-11-14T09:05:00.200Z', 100000),
      ]);
      const run1 = run(dir, [file]);
      expect(run1.status).toBe(0);
      const s = run1.json.drops[0];
      expect(s.cause).toBe('host');
      expect(s.readings.journal).toBe('none');
      const control = resultRow(run1.json, 'compact rows in period with a matched drop');
      expect(control.denominator).toBe(0);
      expect(control.numerator).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bad lines in the transcript and in compaction.jsonl counted in data quality', () => {
    const dir = makeDir();
    try {
      const file = save(dir, 'S14.jsonl', [
        'this-is-not-json{{',
        call('msg_1', '2026-11-14T09:00:01Z', 300000, { session: 'S14' }),
        call('msg_2', '2026-11-14T09:10:01Z', 100000, { session: 'S14' }),
      ]);
      save(dir, 'compaction.jsonl', ['[1, 2]', compact('2026-11-14T09:05:00Z', 'S14', null, 'jev', 'plugin')]);
      const run1 = run(dir, [file]);
      expect(run1.status).toBe(0);
      const r = run1.json;
      expect(r.data_quality[0].bad_lines).toBe(1);
      expect(r.data_quality[1].bad_lines).toBe(1);
      expect(r.data_quality[0].rows).toBe(2);
      expect(r.data_quality[1].rows).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('30 cut_without_marker drops, share and Wilson against the reference value', () => {
    const dir = makeDir();
    try {
      const lines = [];
      for (let i = 0; i < 31; i += 1) {
        const window = Math.round(200000 * Math.pow(0.9, i));
        const ts = '2026-11-14T09:00:0' + String(i % 10) + 'Z';
        lines.push(req('rq' + i, '2026-11-14T09:00:0' + String(i % 10) + 'Z', { base: null, keep: 5, tail: 0 }));
        lines.push(call('msg_' + i, ts, window, { session: 'S15' }));
      }
      const file = save(dir, 'S15.jsonl', lines);
      save(dir, 'compaction.jsonl', []);
      const run1 = run(dir, [file], { extra: ['--min-drop-tokens', '500', '--min-drop-percent', '5'] });
      expect(run1.status).toBe(0);
      const r = run1.json;
      expect(r.n.value).toBe(30);
      for (const s of r.drops) expect(s.cause).toBe('cut_without_marker');
      const row = resultRow(r, 'cause cut_without_marker');
      expect(row.denominator).toBe(30);
      expect(row.share).toBe(1);
      const reference = Math.round(wilsonLower(30, 30) * 10000) / 10000;
      expect(Math.abs(row.wilson_lower_95 - reference)).toBeLessThan(0.0001);
      const assigned8 = resultRow(r, 'drops with assigned cause including exclusion (classes 1-8)');
      expect(assigned8.numerator).toBe(30);
      expect(assigned8.share).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--out to an existing file exit 1; to a new file 0600; missing --compact exit 2', () => {
    const dir = makeDir();
    try {
      const file = save(dir, 'S16.jsonl', [
        call('msg_1', '2026-11-14T09:00:01Z', 300000, { session: 'S16' }),
        call('msg_2', '2026-11-14T09:10:01Z', 100000, { session: 'S16' }),
      ]);
      save(dir, 'compaction.jsonl', []);
      writeFileSync(join(dir, 'existing.json'), 'x', 'utf8');
      const base = ['-I', SCRIPT, '--json', '--to', TO, '--days', '7', '--compact', join(dir, 'compaction.jsonl'), '--transcript', file];
      const run1 = spawnSync('python3', [...base, '--out', join(dir, 'existing.json')], { encoding: 'utf8' });
      expect(run1.status).toBe(1);
      const run2 = spawnSync('python3', [...base, '--out', join(dir, 'out.json')], { encoding: 'utf8' });
      expect(run2.status).toBe(0);
      const stat = statSync(join(dir, 'out.json'));
      expect(stat.mode & 0o777).toBe(0o600);
      const saved = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));
      expect(saved.template).toBe('compaction-report/1');
      const run3 = spawnSync('python3', ['-I', SCRIPT, '--json', '--to', TO, '--days', '7', '--compact', join(dir, 'missing.jsonl'), '--transcript', file], { encoding: 'utf8' });
      expect(run3.status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('base different from id with matching keep: prefix broken, cause cut_without_marker', () => {
    const dir = makeDir();
    try {
      const file = save(dir, 'S17.jsonl', [
        req('rq1', '2026-11-14T09:00:00Z', { base: 'rq0', keep: 2, tail: 3 }),
        call('msg_1', '2026-11-14T09:00:01Z', 300000, { session: 'S17' }),
        req('rq2', '2026-11-14T09:10:00Z', { base: 'COMPLETELY-DIFFERENT', keep: 5, tail: 1 }),
        call('msg_2', '2026-11-14T09:10:01Z', 100000, { session: 'S17' }),
      ]);
      save(dir, 'compaction.jsonl', []);
      const run1 = run(dir, [file]);
      expect(run1.status).toBe(0);
      const s = run1.json.drops[0];
      expect(s.readings.prefix).toBe('broken');
      expect(s.cause).toBe('cut_without_marker');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a copy sorted before the original keeps the journal cause', () => {
    const dir = makeDir();
    try {
      const copy = save(dir, 'aaa-copy.jsonl', [
        req('rq1', '2026-11-14T09:00:00Z', { base: null, keep: 0, tail: 1 }),
        call('msg_1', '2026-11-14T09:00:01Z', 300000, { session: 'COPY' }),
        req('rq2', '2026-11-14T09:05:00Z', { base: null, keep: 0, tail: 1 }),
        call('msg_2', '2026-11-14T09:05:02Z', 100000, { session: 'COPY' }),
      ]);
      const orig = save(dir, 'zzz-original.jsonl', [
        req('rq1', '2026-11-14T09:00:00Z', { base: null, keep: 0, tail: 1 }),
        call('msg_1', '2026-11-14T09:00:01Z', 300000, { session: 'ORIG' }),
        boundary('2026-11-14T09:05:00Z', 'manual', 300000),
        req('rq2', '2026-11-09T09:05:01Z', { base: null, keep: 0, tail: 1 }),
        call('msg_2', '2026-11-14T09:05:02Z', 100000, { session: 'ORIG' }),
      ]);
      save(dir, 'compaction.jsonl', [
        compact('2026-11-14T09:05:01Z', 'ORIG', null, 'jev', 'plugin'),
        after('2026-11-14T09:05:02Z', 'ORIG', null, '2026-11-14T09:05:01Z', 100000),
      ]);
      const run1 = run(dir, [copy, orig]);
      expect(run1.status).toBe(0);
      const r = run1.json;
      expect(r.n.value).toBe(1);
      const s = r.drops[0];
      expect(s.cause).toBe('module_compaction');
      expect(s.readings.journal).toBe('jev');
      expect(s.file).toBe(orig);
      expect(r.arms.with_journal.module_compaction).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a skipped row closer than jev does not displace jev', () => {
    const dir = makeDir();
    try {
      const file = save(dir, 'S19.jsonl', [
        req('rq1', '2026-11-14T09:00:00Z', { base: null, keep: 0, tail: 1 }),
        call('msg_1', '2026-11-14T09:00:01Z', 300000, { session: 'S19' }),
        req('rq2', '2026-11-14T09:05:00Z', { base: null, keep: 0, tail: 1 }),
        call('msg_2', '2026-11-14T09:05:02Z', 100000, { session: 'S19' }),
      ]);
      save(dir, 'compaction.jsonl', [
        compact('2026-11-14T09:05:02Z', 'S19', null, 'skipped', 'plugin'),
        compact('2026-11-14T09:05:01Z', 'S19', null, 'jev', 'plugin'),
        after('2026-11-14T09:05:02Z', 'S19', null, '2026-11-14T09:05:01Z', 100000),
      ]);
      const run1 = run(dir, [file]);
      expect(run1.status).toBe(0);
      const s = run1.json.drops[0];
      expect(s.cause).toBe('module_compaction');
      expect(s.readings.journal).toBe('jev');
      expect(s.compact_ts).toBe('2026-11-14T09:05:01Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('one jev row with two adjacent drops goes only to the closer one', () => {
    const dir = makeDir();
    try {
      const file = save(dir, 'S20.jsonl', [
        req('rq1', '2026-11-14T09:00:00Z', { base: 'rq0', keep: 2, tail: 3 }),
        call('msg_1', '2026-11-14T09:00:01Z', 300000, { session: 'S20' }),
        req('rq2', '2026-11-14T09:05:00Z', { base: 'OTHER', keep: 0, tail: 1 }),
        call('msg_2', '2026-11-14T09:05:02Z', 100000, { session: 'S20' }),
        req('rq3', '2026-11-14T09:05:05Z', { base: 'OTHER', keep: 0, tail: 1 }),
        call('msg_3', '2026-11-14T09:05:07Z', 50000, { session: 'S20' }),
      ]);
      save(dir, 'compaction.jsonl', [
        compact('2026-11-14T09:05:01Z', 'S20', null, 'jev', 'plugin'),
        after('2026-11-14T09:05:02Z', 'S20', null, '2026-11-14T09:05:01Z', 100000),
      ]);
      const run1 = run(dir, [file]);
      expect(run1.status).toBe(0);
      const r = run1.json;
      expect(r.n.value).toBe(2);
      const s1 = r.drops.find((x) => x.ts === '2026-11-14T09:05:02Z');
      const s2 = r.drops.find((x) => x.ts === '2026-11-14T09:05:07Z');
      expect(s1.cause).toBe('module_compaction');
      expect(s2.cause).toBe('cut_without_marker');
      const control = resultRow(r, 'compact rows in period with a matched drop');
      expect(control.numerator).toBe(1);
      expect(control.denominator).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops_from_main_fields per pair without copy duplicates', () => {
    const dir = makeDir();
    try {
      const advisorUsage = {
        input_tokens: 400000,
        cache_read_input_tokens: 45000,
        cache_creation_input_tokens: 4500,
        iterations: [
          { type: 'message', input_tokens: 150000, cache_read_input_tokens: 5000, cache_creation_input_tokens: 1000 },
          { type: 'advisor_message', input_tokens: 137000 },
          { type: 'message', input_tokens: 150000, cache_read_input_tokens: 5500, cache_creation_input_tokens: 1000 },
        ],
      };
      const seqA = [
        req('rq1', '2026-11-14T09:00:00Z', { base: 'rq0', keep: 2, tail: 3 }),
        call('msg_1', '2026-11-14T09:00:01Z', 150000, { session: 'S21' }),
        req('rq2', '2026-11-14T09:05:00Z', { base: 'rq1', keep: 5, tail: 1 }),
        call('msg_2', '2026-11-14T09:05:01Z', 156500, { session: 'S21', usage: advisorUsage }),
        req('rq3', '2026-11-14T09:10:00Z', { base: 'rq2', keep: 6, tail: 1 }),
        call('msg_3', '2026-11-14T09:10:01Z', 160000, { session: 'S21' }),
      ];
      const fileA = save(dir, 'fileA.jsonl', seqA);
      const fileB = save(dir, 'fileB.jsonl', [
        call('msg_1', '2026-11-14T09:00:01Z', 150000, { session: 'S21' }),
        call('msg_2', '2026-11-14T09:05:01Z', 156500, { session: 'S21', usage: advisorUsage }),
        call('msg_3', '2026-11-14T09:10:01Z', 160000, { session: 'S21' }),
      ]);
      save(dir, 'compaction.jsonl', []);
      const run1 = run(dir, [fileA, fileB]);
      expect(run1.status).toBe(0);
      const r = run1.json;
      expect(r.drops_from_main_fields).toBe(1);
      expect(r.data_quality[1].gaps.drops_duplicated_from_copies).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--out without --json saves JSON, not text', () => {
    const dir = makeDir();
    try {
      const file = save(dir, 'S22.jsonl', [
        call('msg_1', '2026-11-14T09:00:01Z', 300000, { session: 'S22' }),
        call('msg_2', '2026-11-14T09:10:01Z', 100000, { session: 'S22' }),
      ]);
      save(dir, 'compaction.jsonl', []);
      const run1 = spawnSync('python3', ['-I', SCRIPT, '--to', TO, '--days', '7', '--compact', join(dir, 'compaction.jsonl'), '--transcript', file, '--out', join(dir, 'out.json')], { encoding: 'utf8' });
      expect(run1.status).toBe(0);
      const saved = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));
      expect(saved.template).toBe('compaction-report/1');
      expect(Array.isArray(saved.results)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('after row without tokens_after_real: gap 0, after reading yes, tokens unavailable', () => {
    const dir = makeDir();
    try {
      const file = save(dir, 'S23.jsonl', [
        req('rq1', '2026-11-14T09:00:00Z', { base: null, keep: 0, tail: 1 }),
        call('msg_1', '2026-11-14T09:00:01Z', 300000, { session: 'S23' }),
        boundary('2026-11-14T09:05:00Z', 'manual', 300000),
        req('rq2', '2026-11-14T09:05:00.500Z', { base: null, keep: 0, tail: 1 }),
        call('msg_2', '2026-11-14T09:05:02Z', 100000, { session: 'S23' }),
      ]);
      save(dir, 'compaction.jsonl', [
        compact('2026-11-14T09:05:00.500Z', 'S23', null, 'jev', 'plugin'),
        after('2026-11-14T09:05:01Z', 'S23', null, '2026-11-14T09:05:00.500Z'),
      ]);
      const run1 = run(dir, [file]);
      expect(run1.status).toBe(0);
      const r = run1.json;
      expect(r.data_quality[0].gaps.compact_without_after).toBe(0);
      const s = r.drops[0];
      expect(s.cause).toBe('module_compaction');
      expect(s.readings.after).toBe('yes');
      expect(s.readings.tokens_after_real).toBe('unavailable');
      expect(s.readings.confirmation).toBe('confirmed by two readings');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('period is the requested window, data_range is the min and max drop ts', () => {
    const dir = makeDir();
    try {
      const file = save(dir, 'S24.jsonl', [
        req('rq1', '2026-11-14T09:00:00Z', { base: 'rq0', keep: 2, tail: 3 }),
        call('msg_1', '2026-11-14T09:00:01.250Z', 300000, { session: 'S24' }),
        req('rq2', '2026-11-14T09:10:00Z', { base: 'OTHER', keep: 0, tail: 1 }),
        call('msg_2', '2026-11-14T09:10:01.750Z', 100000, { session: 'S24' }),
      ]);
      save(dir, 'compaction.jsonl', []);
      const run1 = run(dir, [file]);
      expect(run1.status).toBe(0);
      const r = run1.json;
      expect(r.period.from).toBe('2026-11-07T12:00:00Z');
      expect(r.period.to).toBe(TO);
      expect(r.data_range.from).toBe('2026-11-14T09:10:01.750Z');
      expect(r.data_range.to).toBe('2026-11-14T09:10:01.750Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('control arm n is the number of drops in a file without a compact row', () => {
    const dir = makeDir();
    try {
      const file = save(dir, 'S25.jsonl', [
        req('rq1', '2026-11-14T09:00:00Z', { base: 'rq0', keep: 2, tail: 3 }),
        call('msg_1', '2026-11-14T09:00:01Z', 300000, { session: 'S25' }),
        req('rq2', '2026-11-14T09:05:00Z', { base: 'OTHER', keep: 0, tail: 1 }),
        call('msg_2', '2026-11-14T09:05:01Z', 100000, { session: 'S25' }),
        req('rq3', '2026-11-14T09:10:00Z', { base: 'OTHER', keep: 0, tail: 1 }),
        call('msg_3', '2026-11-14T09:10:01Z', 50000, { session: 'S25' }),
      ]);
      save(dir, 'compaction.jsonl', []);
      const run1 = run(dir, [file]);
      expect(run1.status).toBe(0);
      const r = run1.json;
      expect(r.n.value).toBe(2);
      expect(r.control_arm.n).toBe(2);
      expect(r.arms.without_journal.cut_without_marker).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drop times literal from the row, with second fractions', () => {
    const dir = makeDir();
    try {
      const file = save(dir, 'S26.jsonl', [
        req('rq1', '2026-11-14T09:00:00Z', { base: 'rq0', keep: 2, tail: 3 }),
        call('msg_1', '2026-11-14T09:00:01.111Z', 300000, { session: 'S26' }),
        req('rq2', '2026-11-14T09:05:00Z', { base: 'OTHER', keep: 0, tail: 1 }),
        call('msg_2', '2026-11-14T09:05:02.999Z', 100000, { session: 'S26' }),
      ]);
      save(dir, 'compaction.jsonl', []);
      const run1 = run(dir, [file]);
      expect(run1.status).toBe(0);
      const s = run1.json.drops[0];
      expect(s.ts_prev).toBe('2026-11-14T09:00:01.111Z');
      expect(s.ts).toBe('2026-11-14T09:05:02.999Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('default journal path', () => {
  const journalRow = JSON.stringify({ ts: '2026-11-14T09:05:00Z', event: 'compact', session_id: 'S', agent_id: null, trigger: 'plugin', result: 'jev' });

  function runDefault(cwd, extraEnv) {
    const env = { ...process.env, ...extraEnv };
    if (!extraEnv.OMC_JEV_LOG_DIR) delete env.OMC_JEV_LOG_DIR;
    const transcript = join(cwd, 'transcript.jsonl');
    writeFileSync(transcript, '');
    return spawnSync('python3', ['-I', SCRIPT, '--transcript', transcript, '--to', TO, '--json'], { encoding: 'utf8', cwd, env });
  }

  function projectWithJournal(root, name) {
    const cwd = join(root, name);
    const logDir = join(cwd, '.omc', 'state', 'jev');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'compaction.jsonl'), journalRow + '\n');
    return { cwd, journal: join(logDir, 'compaction.jsonl') };
  }

  it('without OMC_JEV_LOG_DIR reads .omc/state/jev/compaction.jsonl under the current directory', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'test-default-journal-')));
    try {
      const { cwd, journal } = projectWithJournal(root, 'proj');
      const proc = runDefault(cwd, {});
      expect(proc.status, proc.stderr).toBe(0);
      expect(JSON.stringify(JSON.parse(proc.stdout))).toContain(JSON.stringify(journal).slice(1, -1));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('OMC_JEV_LOG_DIR wins over .omc/state/jev under the current directory', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'test-default-journal-')));
    try {
      const { cwd, journal } = projectWithJournal(root, 'proj');
      const envDir = join(root, 'env-dir');
      mkdirSync(envDir);
      const envJournal = join(envDir, 'compaction.jsonl');
      writeFileSync(envJournal, journalRow + '\n');
      const proc = runDefault(cwd, { OMC_JEV_LOG_DIR: envDir });
      expect(proc.status, proc.stderr).toBe(0);
      const text = JSON.stringify(JSON.parse(proc.stdout));
      expect(text).toContain(JSON.stringify(envJournal).slice(1, -1));
      expect(text).not.toContain(JSON.stringify(journal).slice(1, -1));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('without OMC_JEV_LOG_DIR and without a journal under the current directory exits 2', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'test-default-journal-')));
    try {
      const proc = runDefault(root, {});
      expect(proc.status).toBe(2);
      expect(proc.stderr).toContain(join(root, '.omc', 'state', 'jev', 'compaction.jsonl'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--help names the default journal and the OMC_STATE_DIR case', () => {
    const proc = spawnSync('python3', ['-I', SCRIPT, '--help'], { encoding: 'utf8' });
    expect(proc.status).toBe(0);
    expect(proc.stdout.replace(/\s+/g, ' ')).toContain('OMC_STATE_DIR');
  });
});
