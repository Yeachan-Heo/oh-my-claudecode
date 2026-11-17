// Tests for the compaction cache cost diagnostic: synthetic transcripts and an explicit price table.
// The script runs with python3 -I through spawnSync; prices come from a --prices file written by the test.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', '..', 'tools', 'diagnostics', 'compaction_cache_cost.py');
const TO = '2026-11-15T00:00:00Z';
const DEPLOYED_AT = '2026-11-13T00:00:00Z';

// Prices per million tokens: test-model = input 1, output 5 (cache write 1 h 2, cache read 0.1);
// advisor-model = input 3, output 15; models starting with "sub-" are subscription models.
const PRICES = {
  models: {
    'test-model': { input_per_mtok: 1, output_per_mtok: 5 },
    'advisor-model': { input_per_mtok: 3, output_per_mtok: 15 },
  },
  subscription_prefixes: ['sub-'],
};

function newDir() {
  return mkdtempSync(join(tmpdir(), 'test-cache-cost-'));
}

function writeLines(path, lines, session) {
  if (session !== undefined) {
    for (const l of lines) l.sessionId = session;
  }
  writeFileSync(path, joinLines(lines));
}

function joinLines(lines) {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

let idCounter = 0;
function assistant(ts, model, usage, iterations) {
  idCounter += 1;
  const w = {
    type: 'assistant',
    timestamp: ts,
    requestId: `r${idCounter}`,
    uuid: `u${idCounter}`,
    message: { id: `m${idCounter}`, role: 'assistant', model, usage },
  };
  if (iterations !== undefined) usage.iterations = iterations;
  return w;
}

function usageOf(inp, cc, cr, out, w5m, w1h) {
  const u = { input_tokens: inp, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens: out };
  if (w5m !== undefined || w1h !== undefined) {
    u.cache_creation = { ephemeral_5m_input_tokens: w5m || 0, ephemeral_1h_input_tokens: w1h || 0 };
  }
  return u;
}

function boundary(ts, trigger) {
  idCounter += 1;
  return { type: 'system', subtype: 'compact_boundary', uuid: `b${idCounter}`, timestamp: ts, compactMetadata: { trigger: trigger || 'manual' } };
}

function compactRow(ts, session, agent, result) {
  return { event: 'compact', ts, session_id: session, agent_id: agent, trigger: 'plugin', result };
}

function newCase() {
  const dir = newDir();
  const prices = join(dir, 'prices.json');
  writeFileSync(prices, JSON.stringify(PRICES));
  const journal = join(dir, 'compaction.jsonl');
  writeFileSync(journal, '');
  return { dir, prices, journal };
}

function run(c, files, extra) {
  const args = ['-I', SCRIPT, '--compact', c.journal, '--prices', c.prices, '--deployed-at', DEPLOYED_AT, '--to', TO];
  for (const p of files) args.push('--transcript', p);
  if (extra) args.push(...extra);
  return spawnSync('python3', args, { encoding: 'utf8' });
}

function templateFields(w) {
  const fields = ['template', 'metric', 'script', 'generated_at', 'rule', 'period', 'n', 'model', 'trigger', 'control_arm', 'data_quality', 'results', 'min_support', 'caveats'];
  for (const p of fields) {
    expect(Object.prototype.hasOwnProperty.call(w, p), `missing template field: ${p}`).toBe(true);
  }
}

function assertNoNull(x, path) {
  if (x === null) throw new Error(`null in ${path}`);
  if (Array.isArray(x)) {
    for (const y of x) assertNoNull(y, path);
  } else if (typeof x === 'object') {
    for (const [k, v] of Object.entries(x)) assertNoNull(v, `${path}.${k}`);
  }
}

function resultJson(b) {
  expect(b.status, `exit code ${b.status}: ${b.stderr}`).toBe(0);
  return JSON.parse(b.stdout);
}

function wilsonLower(k, n) {
  const z = 1.959963984540054;
  if (k === 0) return 0;
  const p = k / n;
  return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n);
}

function dataQualityOfTranscripts(w) {
  return w.data_quality.find((x) => x.source.startsWith('transcripts'));
}

function sameTime(path, iso) {
  utimesSync(path, new Date(iso), new Date(iso));
}

describe('compaction_cache_cost', () => {
  it('a series without breaks; Cache Savings match the reference value', () => {
    const c = newCase();
    try {
      const file = join(c.dir, 'proj', 's1.jsonl');
      mkdirSync(dirname(file), { recursive: true });
      idCounter = 0;
      writeLines(file, [
        assistant('2026-11-14T10:00:00Z', 'test-model', usageOf(100, 12345, 0, 10, 12345)),
        assistant('2026-11-14T10:01:40Z', 'test-model', usageOf(100, 500, 12000, 10)),
        assistant('2026-11-14T10:02:20Z', 'test-model', usageOf(100, 500, 12500, 10)),
      ]);
      const w = resultJson(run(c, [file], ['--json']));
      templateFields(w);
      assertNoNull(w, 'report');
      expect(w.n.value).toBe(0);
      const breaks = w.results.filter((x) => x.name.startsWith('prefix breaks'));
      for (const z of breaks) {
        expect(z.numerator).toBe(0);
        expect(z.denominator).toBe(0);
      }
      const c1 = (100 + 12345) * 1 + 10 * 5;
      const f1 = 100 + 12345 * 1.25 + 0 * 0.1 + 10 * 5;
      const c2 = (100 + 500 + 12000) * 1 + 50;
      const f2 = 100 + 500 * 2 + 12000 * 0.1 + 50;
      const c3 = (100 + 500 + 12500) * 1 + 50;
      const f3 = 100 + 500 * 2 + 12500 * 0.1 + 50;
      const expected = (c1 - f1 + c2 - f2 + c3 - f3) / 1e6;
      expect(w.cache_savings_usd.total).toBe(expected.toFixed(4));
      expect(w.cache_savings_usd.main).toBe(expected.toFixed(4));
      expect(w.cache_savings_usd.subagent).toBe((0).toFixed(4));
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });

  it('a boundary, a call with cc 50000 and cr 2000: an after_compaction break, reference cost and recovery', () => {
    const c = newCase();
    try {
      const file = join(c.dir, 'proj', 's2.jsonl');
      mkdirSync(dirname(file), { recursive: true });
      idCounter = 0;
      writeLines(file, [
        assistant('2026-11-14T10:00:00Z', 'test-model', usageOf(100, 20000, 30000, 10, 20000)),
        boundary('2026-11-14T10:00:10Z', 'manual'),
        assistant('2026-11-14T10:01:00Z', 'test-model', usageOf(100, 50000, 2000, 10, 50000)),
      ]);
      const w = resultJson(run(c, [file], ['--json']));
      const row = w.results.find((x) => x.name === 'prefix breaks after a compaction');
      expect(row.numerator).toBe(1);
      expect(row.denominator).toBe(1);
      expect(w.rewrites.after_compaction.count).toBe(1);
      expect(w.rewrites.after_compaction.sum_usd).toBe((48000 * 1.15 / 1e6).toFixed(4));
      expect(w.first_turn_recovery['host-main']).toBe(Math.round((2000 / (100 + 50000 + 2000)) * 10000) / 10000);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });

  it('TTL break classes: after_ttl_gap (3600 and 300), other, ttl_unknown', () => {
    const c = newCase();
    try {
      const a = join(c.dir, 'proj', 'sa.jsonl');
      const bF = join(c.dir, 'proj', 'sb.jsonl');
      const cF = join(c.dir, 'proj', 'sc.jsonl');
      const d = join(c.dir, 'proj', 'sd.jsonl');
      for (const p of [a, bF, cF, d]) mkdirSync(dirname(p), { recursive: true });
      idCounter = 0;
      writeLines(a, [
        assistant('2026-11-14T08:00:00Z', 'test-model', usageOf(100, 10000, 0, 10, undefined, 10000)),
        assistant('2026-11-14T09:06:40Z', 'test-model', usageOf(100, 20000, 5000, 10)),
      ]);
      writeLines(bF, [
        assistant('2026-11-14T08:00:00Z', 'test-model', usageOf(100, 10000, 0, 10, 10000)),
        assistant('2026-11-14T08:06:40Z', 'test-model', usageOf(100, 20000, 5000, 10)),
      ]);
      writeLines(cF, [
        assistant('2026-11-14T08:00:00Z', 'test-model', usageOf(100, 10000, 0, 10, undefined, 10000)),
        assistant('2026-11-14T08:06:40Z', 'test-model', usageOf(100, 20000, 5000, 10)),
      ]);
      writeLines(d, [
        assistant('2026-11-14T08:00:00Z', 'test-model', usageOf(100, 10000, 0, 10)),
        assistant('2026-11-14T09:06:40Z', 'test-model', usageOf(100, 20000, 5000, 10)),
      ]);
      const w = resultJson(run(c, [a, bF, cF, d], ['--json']));
      expect(w.rewrites.after_ttl_gap.count).toBe(2);
      expect(w.rewrites.other.count).toBe(1);
      expect(w.rewrites.ttl_unknown.count).toBe(1);
      expect(w.rewrites.after_compaction.count).toBe(0);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });

  it('a call with an advisor: cost = thread model + advisor; no false break', () => {
    const c = newCase();
    try {
      const file = join(c.dir, 'proj', 's4.jsonl');
      mkdirSync(dirname(file), { recursive: true });
      idCounter = 0;
      const iterations = [
        { type: 'message', input_tokens: 200, cache_creation_input_tokens: 500, cache_read_input_tokens: 40000, output_tokens: 373 },
        { type: 'advisor_message', model: 'advisor-model', input_tokens: 137293, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 26997 },
        { type: 'message', input_tokens: 200, cache_creation_input_tokens: 500, cache_read_input_tokens: 40000, output_tokens: 373 },
      ];
      writeLines(file, [
        assistant('2026-11-14T10:00:00Z', 'test-model', usageOf(100, 500, 40000, 10)),
        assistant('2026-11-14T10:01:00Z', 'test-model', usageOf(400, 1000, 80000, 746), iterations),
      ]);
      const w = resultJson(run(c, [file], ['--json']));
      const costFirst = (100 + 500 * 2 + 40000 * 0.1 + 10 * 5) / 1e6;
      const costMain = (400 + 1000 * 2 + 80000 * 0.1 + 746 * 5) / 1e6;
      const costAdvisor = (137293 * 3 + 0 * 6 + 0 * 0.3 + 26997 * 15) / 1e6;
      const expected = costFirst + costMain + costAdvisor;
      expect(w.calls_cost_usd).toBe(expected.toFixed(4));
      const breaks = w.results.filter((x) => x.name.startsWith('prefix breaks'));
      for (const z of breaks) {
        expect(z.numerator + z.denominator).toBe(0);
      }
      expect(w.cache_loss.before_deployment.losses + w.cache_loss.from_deployment.losses).toBe(0);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });

  it('several rows of one call are counted once', () => {
    const c = newCase();
    try {
      const file = join(c.dir, 'proj', 's5.jsonl');
      mkdirSync(dirname(file), { recursive: true });
      idCounter = 0;
      const w1 = assistant('2026-11-14T10:00:00Z', 'test-model', usageOf(100, 0, 2000, 5));
      const w2 = assistant('2026-11-14T10:00:00Z', 'test-model', usageOf(100, 0, 2000, 0));
      w2.message.id = w1.message.id;
      w2.requestId = w1.requestId;
      writeLines(file, [w1, w2]);
      const w = resultJson(run(c, [file], ['--json']));
      const expected = (100 + 0 * 2 + 2000 * 0.1 + 5 * 5) / 1e6;
      expect(w.calls_cost_usd).toBe(expected.toFixed(4));
      expect(w.cache_loss.from_deployment.losses).toBe(0);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });

  it('two boundaries: turns_to_next, the median of turns, breakeven_turns, paid_back', () => {
    const c = newCase();
    try {
      const file = join(c.dir, 'proj', 's6.jsonl');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(c.journal, joinLines([
        compactRow('2026-11-14T10:05:10Z', 's6', null, 'jev'),
        compactRow('2026-11-14T10:08:50Z', 's6', null, 'jev'),
      ]));
      idCounter = 0;
      writeLines(file, [
        assistant('2026-11-14T10:00:00Z', 'test-model', usageOf(100, 10000, 0, 10, 10000)),
        assistant('2026-11-14T10:01:40Z', 'test-model', usageOf(100, 500, 10000, 10)),
        assistant('2026-11-14T10:03:20Z', 'test-model', usageOf(100, 500, 11000, 10)),
        assistant('2026-11-14T10:05:00Z', 'test-model', usageOf(60000, 500, 11000, 10)),
        boundary('2026-11-14T10:05:10Z', 'manual'),
        assistant('2026-11-14T10:06:40Z', 'test-model', usageOf(100, 800, 10400, 10, 800)),
        assistant('2026-11-14T10:08:20Z', 'test-model', usageOf(100, 500, 11200, 10)),
        boundary('2026-11-14T10:08:50Z', 'auto'),
        assistant('2026-11-14T10:10:00Z', 'test-model', usageOf(100, 1200, 3000, 10, 1200)),
        assistant('2026-11-14T10:11:40Z', 'test-model', usageOf(100, 500, 33000, 10)),
      ], 's6');
      const w = resultJson(run(c, [file], ['--json']));
      const paidBack = w.results.find((x) => x.name === 'jev-main: compactions paid back before the next one');
      expect(paidBack.numerator).toBe(1);
      expect(paidBack.denominator).toBe(2);
      const tm = w.turns_between_compactions['jev-main'];
      expect(tm.n).toBe(1);
      expect(tm.median).toBe(2);
      const costRewrite1 = (1100 * 1.15) / 1e6;
      const saving1 = (60200 * 0.1) / 1e6;
      const breakeven1 = costRewrite1 / saving1;
      const costRewrite2 = (8700 * 1.15) / 1e6;
      const saving2 = (7500 * 0.1) / 1e6;
      const breakeven2 = costRewrite2 / saving2;
      const breakevenMedian = Math.round(((breakeven1 + breakeven2) / 2) * 10000) / 10000;
      expect(w.breakeven_turns['jev-main']).toBe(breakevenMedian);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });

  it('cache loss: single, persistent, reset after a boundary, sides before/from the deployment', () => {
    const c = newCase();
    try {
      const dir = join(c.dir, 'proj');
      mkdirSync(dir, { recursive: true });
      idCounter = 0;
      const fa = join(dir, 'sa.jsonl');
      const fb = join(dir, 'sb.jsonl');
      const fc = join(dir, 'sc.jsonl');
      writeLines(fa, [
        assistant('2026-11-12T08:00:00Z', 'test-model', usageOf(100, 0, 10000, 10)),
        assistant('2026-11-12T08:01:00Z', 'test-model', usageOf(3000, 0, 0, 10)),
      ]);
      writeLines(fb, [
        assistant('2026-11-12T09:00:00Z', 'test-model', usageOf(100, 0, 5000, 10)),
        assistant('2026-11-12T09:01:00Z', 'test-model', usageOf(3000, 0, 0, 10)),
        assistant('2026-11-12T09:02:00Z', 'test-model', usageOf(3000, 0, 0, 10)),
        assistant('2026-11-12T09:03:00Z', 'test-model', usageOf(3000, 0, 0, 10)),
      ]);
      writeLines(fc, [
        assistant('2026-11-14T08:00:00Z', 'test-model', usageOf(100, 0, 10000, 10)),
        boundary('2026-11-14T08:00:10Z'),
        assistant('2026-11-14T08:01:00Z', 'test-model', usageOf(3000, 0, 0, 10)),
        assistant('2026-11-14T08:02:00Z', 'test-model', usageOf(100, 0, 9000, 10)),
        assistant('2026-11-14T08:03:00Z', 'test-model', usageOf(3000, 0, 0, 10)),
      ]);
      const w = resultJson(run(c, [fa, fb, fc], ['--json']));
      const before = w.cache_loss.before_deployment;
      const from = w.cache_loss.from_deployment;
      expect(before.sessions).toBe(2);
      expect(before.sessions_with_loss).toBe(2);
      expect(before.losses).toBe(2);
      expect(before.persistent_losses).toBe(1);
      expect(from.sessions).toBe(1);
      expect(from.sessions_with_loss).toBe(1);
      expect(from.losses).toBe(1);
      expect(from.persistent_losses).toBe(0);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });

  it('cache loss: a call below the minimum breaks the series of consecutive calls, the token sum still counts it', () => {
    const c = newCase();
    try {
      const dir = join(c.dir, 'proj');
      mkdirSync(dir, { recursive: true });
      idCounter = 0;
      const lossWith = (name, sizes) => {
        const file = join(dir, `${name}.jsonl`);
        writeLines(file, [
          assistant('2026-11-12T10:00:00Z', 'test-model', usageOf(100, 0, 10000, 10)),
          ...sizes.map((size, i) => assistant(`2026-11-12T10:0${i + 1}:00Z`, 'test-model', usageOf(size, 0, 0, 10))),
        ]);
        return file;
      };
      // 3000, 1000, 3000, 1000, 3000: three qualifying calls, never three in a row, far below 100000 tokens
      const separated = lossWith('separated', [3000, 1000, 3000, 1000, 3000]);
      // three qualifying calls in a row are a persistent loss
      const consecutive = lossWith('consecutive', [3000, 3000, 3000]);
      // 50000 + 1000 + 49500: no series, the sum of all uncached input since the event reaches 100000
      const heavy = lossWith('heavy', [50000, 1000, 49500]);
      const persistent = (file) => {
        const w = resultJson(run(c, [file], ['--json']));
        return [w.cache_loss.before_deployment.losses, w.cache_loss.before_deployment.persistent_losses];
      };
      expect(persistent(separated)).toEqual([1, 0]);
      expect(persistent(consecutive)).toEqual([1, 1]);
      expect(persistent(heavy)).toEqual([1, 1]);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });

  it('matching jev, fallback, host and a subagent by agent_id', () => {
    const c = newCase();
    try {
      const dir = join(c.dir, 'proj');
      const main = join(dir, 's8.jsonl');
      const sub = join(dir, 's8', 'subagents', 'agent-y.jsonl');
      mkdirSync(dirname(sub), { recursive: true });
      writeFileSync(c.journal, joinLines([
        compactRow('2026-11-14T10:00:10Z', 's8', null, 'jev'),
        compactRow('2026-11-14T11:00:10Z', 's8', null, 'fallback'),
        compactRow('2026-11-14T12:00:10Z', 's8', 'y', 'jev'),
      ]));
      idCounter = 0;
      writeLines(main, [
        boundary('2026-11-14T10:00:00Z', 'manual'),
        assistant('2026-11-14T10:01:00Z', 'test-model', usageOf(100, 0, 10000, 10)),
        boundary('2026-11-14T11:00:00Z', 'auto'),
        assistant('2026-11-14T11:01:00Z', 'test-model', usageOf(100, 0, 10000, 10)),
        boundary('2026-11-14T13:00:00Z', 'manual'),
        assistant('2026-11-14T13:01:00Z', 'test-model', usageOf(100, 0, 10000, 10)),
      ], 's8');
      writeLines(sub, [
        boundary('2026-11-14T12:00:00Z', 'manual'),
        assistant('2026-11-14T12:01:00Z', 'test-model', usageOf(100, 0, 10000, 10)),
      ], 's8');
      const w = resultJson(run(c, [main, sub], ['--json']));
      expect(w.compaction_cost['jev-main'].n).toBe(1);
      expect(w.compaction_cost['fallback-main'].n).toBe(1);
      expect(w.compaction_cost['host-main'].n).toBe(1);
      expect(w.compaction_cost['jev-subagent'].n).toBe(1);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });

  it('a model without a price and a subscription model are in the gaps and outside USD', () => {
    const c = newCase();
    try {
      const file = join(c.dir, 'proj', 's9.jsonl');
      mkdirSync(dirname(file), { recursive: true });
      idCounter = 0;
      writeLines(file, [
        assistant('2026-11-14T10:00:00Z', 'test-model', usageOf(100, 0, 20000, 10)),
        assistant('2026-11-14T10:01:00Z', 'mystery-model', usageOf(500, 0, 0, 10)),
        assistant('2026-11-14T10:02:00Z', 'sub-x', usageOf(700, 0, 0, 10)),
      ]);
      const w = resultJson(run(c, [file], ['--json']));
      const expected = (100 + 20000 * 0.1 + 50) / 1e6;
      expect(w.calls_cost_usd).toBe(expected.toFixed(4));
      const gaps = dataQualityOfTranscripts(w).gaps;
      expect(gaps.no_price).toBe(1);
      expect(gaps.subscription).toBe(1);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });

  it('complete fields, no null; insufficient data; Wilson with a denominator >= 30', () => {
    const c = newCase();
    try {
      const dir = join(c.dir, 'proj');
      mkdirSync(dir, { recursive: true });
      idCounter = 0;
      const files = [];
      for (let i = 0; i < 31; i += 1) {
        const p = join(dir, `w${i}.jsonl`);
        writeLines(p, [
          assistant(`2026-11-12T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`, 'test-model', usageOf(100, 0, 10000, 10)),
          assistant(`2026-11-12T11:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`, 'test-model', usageOf(3000, 0, 0, 10)),
        ]);
        files.push(p);
      }
      const w = resultJson(run(c, files, ['--json']));
      assertNoNull(w, 'report');
      templateFields(w);
      const loss = w.results.find((x) => x.name === 'sessions with a cache loss before the deployment');
      expect(loss.numerator).toBe(31);
      expect(loss.denominator).toBe(31);
      expect(loss.share).toBe(1);
      expect(loss.wilson_lower_95).toBe(Math.round(wilsonLower(31, 31) * 10000) / 10000);
      const lossFrom = w.results.find((x) => x.name === 'sessions with a cache loss from the deployment');
      expect(lossFrom.denominator).toBe(0);
      expect(lossFrom.share).toBe('insufficient data');
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });

  it('a missing --prices file: exit 2; --out to an existing file: exit 1', () => {
    const c = newCase();
    try {
      const dir = join(c.dir, 'proj');
      mkdirSync(dir, { recursive: true });
      idCounter = 0;
      const file = join(dir, 's11.jsonl');
      writeLines(file, [assistant('2026-11-14T10:00:00Z', 'test-model', usageOf(100, 0, 10000, 10))]);
      const bad = spawnSync('python3', ['-I', SCRIPT, '--compact', c.journal, '--prices', join(c.dir, 'missing.json'), '--deployed-at', DEPLOYED_AT, '--transcript', file], { encoding: 'utf8' });
      expect(bad.status).toBe(2);
      const target = join(c.dir, 'result.json');
      writeFileSync(target, 'x');
      const b1 = run(c, [file], ['--out', target]);
      expect(b1.status).toBe(1);
      const out = join(c.dir, 'new.json');
      const ok = run(c, [file], ['--out', out]);
      expect(ok.status).toBe(0);
      const saved = JSON.parse(readFileSync(out, 'utf8'));
      expect(saved.metric).toBe('cache-cost');
      expect(statSync(out).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });

  it('a boundary in the original and in a copy; the copy older by modification time; the jev-main unit from the original', () => {
    const c = newCase();
    try {
      const dir = join(c.dir, 'proj');
      mkdirSync(dir, { recursive: true });
      const orig = join(dir, 'orig.jsonl');
      const copy = join(dir, 'copy.jsonl');
      idCounter = 0;
      writeLines(orig, [
        boundary('2026-11-14T10:00:00Z', 'manual'),
        assistant('2026-11-14T10:01:00Z', 'test-model', usageOf(100, 0, 10000, 10)),
      ], 'S1');
      idCounter = 0;
      writeLines(copy, [
        boundary('2026-11-14T10:00:00Z', 'manual'),
      ], 'S2');
      sameTime(copy, '2026-11-01T00:00:00Z');
      writeFileSync(c.journal, joinLines([compactRow('2026-11-14T10:00:30Z', 'S1', null, 'jev')]));
      const w = resultJson(run(c, [copy, orig], ['--json', '--details']));
      expect(w.n.value).toBe(1);
      const j = w.units[0];
      expect(j.uuid).toBe('b1');
      expect(j.group).toBe('jev-main');
      expect(j.file.endsWith('orig.jsonl')).toBe(true);
      expect(j.files_with_boundary).toBe(2);
      expect(dataQualityOfTranscripts(w).gaps.boundaries_duplicated_from_copies).toBe(1);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });

  it('reversed modification times: the unit result is identical', () => {
    const c = newCase();
    try {
      const dir = join(c.dir, 'proj');
      mkdirSync(dir, { recursive: true });
      const orig = join(dir, 'orig.jsonl');
      const copy = join(dir, 'copy.jsonl');
      idCounter = 0;
      writeLines(orig, [
        boundary('2026-11-14T10:00:00Z', 'manual'),
        assistant('2026-11-14T10:01:00Z', 'test-model', usageOf(100, 0, 10000, 10)),
      ], 'S1');
      idCounter = 0;
      writeLines(copy, [
        boundary('2026-11-14T10:00:00Z', 'manual'),
      ], 'S2');
      sameTime(orig, '2026-11-01T00:00:00Z');
      writeFileSync(c.journal, joinLines([compactRow('2026-11-14T10:00:30Z', 'S1', null, 'jev')]));
      const w = resultJson(run(c, [orig, copy], ['--json', '--details']));
      const j = w.units[0];
      expect(j.group).toBe('jev-main');
      expect(j.file.endsWith('orig.jsonl')).toBe(true);
      expect(j.files_with_boundary).toBe(2);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });

  it('two files with the same uuid and no compact row: host, the file first by path', () => {
    const c = newCase();
    try {
      const dir = join(c.dir, 'proj');
      mkdirSync(dir, { recursive: true });
      const aa = join(dir, 'aaa.jsonl');
      const zz = join(dir, 'zzz.jsonl');
      idCounter = 0;
      writeLines(zz, [boundary('2026-11-14T10:00:00Z', 'manual')]);
      idCounter = 0;
      writeLines(aa, [boundary('2026-11-14T10:00:00Z', 'manual')]);
      sameTime(zz, '2026-11-01T00:00:00Z');
      const w = resultJson(run(c, [zz, aa], ['--json', '--details']));
      const j = w.units[0];
      expect(j.group).toBe('host-main');
      expect(j.file.endsWith('aaa.jsonl')).toBe(true);
      expect(j.files_with_boundary).toBe(2);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });

  it('the calls of the boundary file are copies from an earlier file; the unit counts its own file', () => {
    const c = newCase();
    try {
      const dir = join(c.dir, 'proj');
      mkdirSync(dir, { recursive: true });
      const earlier = join(dir, 'aearlier.jsonl');
      const bounded = join(dir, 'z-boundary.jsonl');
      idCounter = 1;
      writeLines(earlier, [
        assistant('2026-11-14T09:00:00Z', 'test-model', usageOf(100, 0, 20000, 10)),
      ]);
      idCounter = 0;
      writeLines(bounded, [
        boundary('2026-11-14T10:00:00Z', 'manual'),
        assistant('2026-11-14T10:01:00Z', 'test-model', usageOf(100, 0, 20000, 10)),
      ]);
      sameTime(earlier, '2026-11-01T00:00:00Z');
      const w = resultJson(run(c, [earlier, bounded], ['--json', '--details']));
      expect(w.n.value).toBe(1);
      expect(w.model['test-model']).toBe(1);
      expect(w.compaction_cost['host-main'].n).toBe(1);
      const j = w.units[0];
      expect(j.turns_to_next).toBe(1);
      expect(j.first_turn_recovery).toBe(Math.round((20000 / 20100) * 10000) / 10000);
      const expectedCost = ((100 + 20000 * 0.1 + 10 * 5) / 1e6).toFixed(4);
      expect(w.calls_cost_usd).toBe(expectedCost);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });

  it('a boundary without a call after it in the file', () => {
    const c = newCase();
    try {
      const dir = join(c.dir, 'proj');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 's18.jsonl');
      idCounter = 0;
      writeLines(file, [
        assistant('2026-11-14T09:00:00Z', 'test-model', usageOf(100, 0, 10000, 10)),
        boundary('2026-11-14T10:00:00Z', 'manual'),
      ]);
      const w = resultJson(run(c, [file], ['--json', '--details']));
      expect(w.n.value).toBe(1);
      const j = w.units[0];
      expect(j.model).toBe('no call after the boundary');
      expect(w.model).toEqual({ 'no call after the boundary': 1 });
      expect(j.first_turn_recovery).toBe('unavailable');
      expect(j.rewrite_cost_usd).toBe('0.0000');
      expect(j.turns_to_next).toBe(0);
      expect(j.segment_end).toBe('file_end');
      expect(w.compaction_cost['host-main'].n).toBe(1);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });

  it('one fallback compact row, two boundaries 80 s before and 30 s after; the order in the file does not matter', () => {
    const c = newCase();
    try {
      const file = join(c.dir, 'proj', 's19.jsonl');
      const file2 = join(c.dir, 'proj2', 's19.jsonl');
      mkdirSync(dirname(file), { recursive: true });
      mkdirSync(dirname(file2), { recursive: true });
      idCounter = 0;
      writeLines(file, [
        boundary('2026-11-14T10:00:00Z', 'manual'),
        boundary('2026-11-14T10:02:00Z', 'manual'),
      ], 'S9');
      idCounter = 0;
      const rows2 = [
        boundary('2026-11-14T10:02:00Z', 'manual'),
        boundary('2026-11-14T10:00:00Z', 'manual'),
      ];
      rows2[0].uuid = 'b2';
      rows2[1].uuid = 'b1';
      writeLines(file2, rows2, 'S9');
      writeFileSync(c.journal, joinLines([compactRow('2026-11-14T10:01:30Z', 'S9', null, 'fallback')]));
      const w = resultJson(run(c, [file], ['--json', '--details']));
      const groups = Object.fromEntries(w.units.map((x) => [x.uuid, x.group]));
      expect(groups.b1).toBe('host-main');
      expect(groups.b2).toBe('fallback-main');
      const w2 = resultJson(run(c, [file2], ['--json', '--details']));
      const groups2 = Object.fromEntries(w2.units.map((x) => [x.uuid, x.group]));
      expect(groups2.b1).toBe('host-main');
      expect(groups2.b2).toBe('fallback-main');
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });

  it('scanning with --projects (sorted by mtime) gives the same unit result and cost sum', () => {
    const c = newCase();
    try {
      const projects = join(c.dir, 'my-projects');
      const dir = join(projects, 'proj');
      mkdirSync(dir, { recursive: true });
      const orig = join(dir, 'orig.jsonl');
      const copy = join(dir, 'copy.jsonl');
      idCounter = 0;
      writeLines(orig, [
        boundary('2026-11-14T10:00:00Z', 'manual'),
        assistant('2026-11-14T10:01:00Z', 'test-model', usageOf(100, 0, 10001, 10)),
      ], 'S1');
      idCounter = 0;
      writeLines(copy, [
        boundary('2026-11-14T10:00:00Z', 'manual'),
      ], 'S2');
      sameTime(copy, '2026-11-01T00:00:00Z');
      writeFileSync(c.journal, joinLines([compactRow('2026-11-14T10:00:30Z', 'S1', null, 'jev')]));
      const b = spawnSync('python3', ['-I', SCRIPT, '--compact', c.journal, '--prices', c.prices, '--deployed-at', DEPLOYED_AT, '--to', TO, '--projects', projects, '--json', '--details'], { encoding: 'utf8' });
      const w = resultJson(b);
      const j = w.units[0];
      expect(j.group).toBe('jev-main');
      expect(j.file.endsWith('orig.jsonl')).toBe(true);
      expect(j.files_with_boundary).toBe(2);
      const expectedCost = ((100 + 10001 * 0.1 + 10 * 5) / 1e6).toFixed(4);
      expect(w.calls_cost_usd).toBe(expectedCost);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });

  it('a boundary before a boundary without calls: no double cost, zero in the turns between', () => {
    const c = newCase();
    try {
      const dir = join(c.dir, 'proj');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 's20.jsonl');
      idCounter = 0;
      writeLines(file, [
        assistant('2026-11-14T10:00:00Z', 'test-model', usageOf(100, 20000, 0, 10, 20000)),
        boundary('2026-11-14T10:01:00Z', 'manual'),
        boundary('2026-11-14T10:02:00Z', 'manual'),
        assistant('2026-11-14T10:03:00Z', 'test-model', usageOf(100, 2000, 999, 10, 2000)),
        assistant('2026-11-14T10:04:00Z', 'test-model', usageOf(100, 500, 3000, 10)),
      ]);
      const w = resultJson(run(c, [file], ['--json', '--details']));
      const byUuid = Object.fromEntries(w.units.map((x) => [x.uuid, x]));
      const b1 = byUuid.b2;
      const b2 = byUuid.b3;
      expect(b1.model).toBe('no call after the boundary');
      expect(b1.rewrite_cost_usd).toBe('0.0000');
      expect(b1.paid_back).toBe('unavailable');
      expect(b1.segment_end).toBe('next_boundary');
      expect(b2.segment_end).toBe('file_end');
      const expectedCostB2 = (19001 * 1.15 / 1e6).toFixed(4);
      expect(b2.rewrite_cost_usd).toBe(expectedCostB2);
      expect(w.rewrites.after_compaction.count).toBe(1);
      expect(w.rewrites.after_compaction.sum_usd).toBe(expectedCostB2);
      expect(w.compaction_cost['host-main'].n).toBe(2);
      expect(w.compaction_cost['host-main'].sum_usd).toBe(expectedCostB2);
      expect(w.turns_between_compactions['host-main']).toEqual({ n: 1, median: 0, quartiles: [0, 0, 0] });
      const paidBack = w.results.find((x) => x.name === 'host-main: compactions paid back before the next one');
      expect(paidBack.numerator).toBe(0);
      expect(paidBack.denominator).toBe(1);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });

  it('the next boundary after the end of the period: paid_back unavailable, outside the median of turns', () => {
    const c = newCase();
    try {
      const dir = join(c.dir, 'proj');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 's21.jsonl');
      idCounter = 0;
      writeLines(file, [
        assistant('2026-11-14T11:00:00Z', 'test-model', usageOf(100, 0, 20000, 10, 20000)),
        boundary('2026-11-14T11:01:00Z', 'manual'),
        assistant('2026-11-14T11:05:00Z', 'test-model', usageOf(100, 2000, 999, 10, 2000)),
        assistant('2026-11-14T11:30:00Z', 'test-model', usageOf(100, 500, 3000, 10)),
        assistant('2026-11-14T11:59:00Z', 'test-model', usageOf(100, 500, 3500, 10)),
        assistant('2026-11-14T12:30:00Z', 'test-model', usageOf(100, 500, 4000, 10)),
        assistant('2026-11-14T12:40:00Z', 'test-model', usageOf(100, 500, 4500, 10)),
        boundary('2026-11-14T13:00:00Z', 'manual'),
      ]);
      const w = resultJson(run(c, [file], ['--json', '--details', '--to', '2026-11-14T12:00:00Z', '--days', '1']));
      expect(w.n.value).toBe(1);
      const b1 = w.units[0];
      expect(b1.uuid).toBe('b2');
      expect(b1.segment_end).toBe('period_end');
      expect(b1.turns_to_next).toBe(3);
      expect(b1.paid_back).toBe('unavailable');
      expect(w.turns_between_compactions['host-main']).toEqual({ n: 0, median: 'unavailable', quartiles: 'unavailable' });
      const paidBack = w.results.find((x) => x.name === 'host-main: compactions paid back before the next one');
      expect(paidBack.numerator).toBe(0);
      expect(paidBack.denominator).toBe(0);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });

  it('file_end: paid_back decided, outside the median of turns', () => {
    const c = newCase();
    try {
      const dir = join(c.dir, 'proj');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 's22.jsonl');
      idCounter = 0;
      writeLines(file, [
        assistant('2026-11-14T10:00:00Z', 'test-model', usageOf(100, 0, 20000, 10, 20000)),
        boundary('2026-11-14T10:01:00Z', 'manual'),
        assistant('2026-11-14T10:05:00Z', 'test-model', usageOf(100, 2000, 999, 10, 2000)),
        assistant('2026-11-14T10:06:00Z', 'test-model', usageOf(100, 500, 3000, 10)),
      ]);
      const w = resultJson(run(c, [file], ['--json', '--details']));
      const b1 = w.units[0];
      expect(b1.segment_end).toBe('file_end');
      expect(b1.turns_to_next).toBe(2);
      expect(b1.paid_back).toBe(false);
      expect(w.turns_between_compactions['host-main']).toEqual({ n: 0, median: 'unavailable', quartiles: 'unavailable' });
      const paidBack = w.results.find((x) => x.name === 'host-main: compactions paid back before the next one');
      expect(paidBack.numerator).toBe(0);
      expect(paidBack.denominator).toBe(1);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });

  it('exit codes: no --compact and no --transcript file exit 2, a bad --out exit 1, no stack trace', () => {
    const c = newCase();
    try {
      const dir = join(c.dir, 'proj');
      mkdirSync(dir, { recursive: true });
      idCounter = 0;
      const file = join(dir, 's23.jsonl');
      writeLines(file, [assistant('2026-11-14T10:00:00Z', 'test-model', usageOf(100, 0, 10000, 10))]);
      const noCompact = spawnSync('python3', ['-I', SCRIPT, '--compact', join(c.dir, 'missing.jsonl'), '--prices', c.prices, '--deployed-at', DEPLOYED_AT, '--transcript', file], { encoding: 'utf8' });
      expect(noCompact.status).toBe(2);
      expect(noCompact.stderr.includes('no --compact file')).toBe(true);
      expect(noCompact.stderr.includes('Traceback')).toBe(false);
      const noTranscript = spawnSync('python3', ['-I', SCRIPT, '--compact', c.journal, '--prices', c.prices, '--deployed-at', DEPLOYED_AT, '--transcript', join(c.dir, 'missing.jsonl')], { encoding: 'utf8' });
      expect(noTranscript.status).toBe(2);
      expect(noTranscript.stderr.includes('no transcript file')).toBe(true);
      expect(noTranscript.stderr.includes('Traceback')).toBe(false);
      const badOut = run(c, [file], ['--out', join(c.dir, 'no-such-dir', 'result.json')]);
      expect(badOut.status).toBe(1);
      expect(badOut.stderr.length).toBeGreaterThan(0);
      expect(badOut.stderr.includes('Traceback')).toBe(false);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });

  it('bad transcript lines are counted in the transcripts entry', () => {
    const c = newCase();
    try {
      const dir = join(c.dir, 'proj');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 's24.jsonl');
      idCounter = 0;
      const good = [
        assistant('2026-11-14T10:00:00Z', 'test-model', usageOf(100, 0, 10000, 10)),
        assistant('2026-11-14T10:01:00Z', 'test-model', usageOf(100, 0, 10000, 10)),
      ];
      const body = JSON.stringify(good[0]) + '\n{truncated line\n[1,2]\n' + JSON.stringify(good[1]) + '\n';
      writeFileSync(file, body);
      const w = resultJson(run(c, [file], ['--json']));
      const entry = dataQualityOfTranscripts(w);
      expect(entry.rows).toBe(4);
      expect(entry.bad_lines).toBe(2);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });

  it('the cache loss denominator holds only sessions with a call in the period', () => {
    const c = newCase();
    try {
      const dir = join(c.dir, 'proj');
      mkdirSync(dir, { recursive: true });
      const old = join(dir, 'old.jsonl');
      const before = join(dir, 'before.jsonl');
      const from = join(dir, 'from.jsonl');
      idCounter = 0;
      writeLines(old, [
        assistant('2026-10-01T10:00:00Z', 'test-model', usageOf(100, 0, 10000, 10)),
        assistant('2026-10-01T10:01:00Z', 'test-model', usageOf(3000, 0, 0, 10)),
      ]);
      idCounter = 10;
      writeLines(before, [
        assistant('2026-11-08T10:00:00Z', 'test-model', usageOf(100, 0, 10000, 10)),
        assistant('2026-11-08T10:01:00Z', 'test-model', usageOf(3000, 0, 0, 10)),
      ]);
      idCounter = 20;
      writeLines(from, [
        assistant('2026-11-14T10:00:00Z', 'test-model', usageOf(100, 0, 10000, 10)),
        assistant('2026-11-14T10:01:00Z', 'test-model', usageOf(3000, 0, 0, 10)),
      ]);
      const w = resultJson(run(c, [old, before, from], ['--json', '--to', '2026-11-15T00:00:00Z']));
      expect(w.cache_loss.before_deployment.sessions).toBe(1);
      expect(w.cache_loss.before_deployment.losses).toBe(1);
      expect(w.cache_loss.from_deployment.sessions).toBe(1);
      expect(w.cache_loss.from_deployment.losses).toBe(1);
      expect(w.data_range).toBe('unavailable');
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });

  it('the price table: an invalid --prices file and a missing --deployed-at exit 2; without --prices USD figures are unavailable', () => {
    const c = newCase();
    try {
      const dir = join(c.dir, 'proj');
      mkdirSync(dir, { recursive: true });
      idCounter = 0;
      const file = join(dir, 's26.jsonl');
      writeLines(file, [
        assistant('2026-11-14T10:00:00Z', 'test-model', usageOf(100, 0, 20000, 10)),
        boundary('2026-11-14T10:01:00Z', 'manual'),
        assistant('2026-11-14T10:02:00Z', 'test-model', usageOf(100, 30000, 0, 10)),
      ]);
      const invalid = join(c.dir, 'invalid.json');
      writeFileSync(invalid, JSON.stringify({ models: { 'test-model': { input_per_mtok: 1 } } }));
      const bad = spawnSync('python3', ['-I', SCRIPT, '--compact', c.journal, '--prices', invalid, '--deployed-at', DEPLOYED_AT, '--transcript', file], { encoding: 'utf8' });
      expect(bad.status).toBe(2);
      expect(bad.stderr.includes('Traceback')).toBe(false);
      const notJson = join(c.dir, 'not-json.json');
      writeFileSync(notJson, '{oops');
      const bad2 = spawnSync('python3', ['-I', SCRIPT, '--compact', c.journal, '--prices', notJson, '--deployed-at', DEPLOYED_AT, '--transcript', file], { encoding: 'utf8' });
      expect(bad2.status).toBe(2);
      expect(bad2.stderr.includes('Traceback')).toBe(false);
      const noDeployed = spawnSync('python3', ['-I', SCRIPT, '--compact', c.journal, '--prices', c.prices, '--transcript', file], { encoding: 'utf8' });
      expect(noDeployed.status).toBe(2);
      const noPrices = spawnSync('python3', ['-I', SCRIPT, '--compact', c.journal, '--deployed-at', DEPLOYED_AT, '--to', TO, '--transcript', file, '--json', '--details'], { encoding: 'utf8' });
      const w = resultJson(noPrices);
      expect(w.calls_cost_usd).toBe('0.0000');
      expect(w.rewrites.after_compaction.count).toBe(1);
      expect(w.rewrites.after_compaction.sum_usd).toBe('unavailable');
      expect(w.units[0].rewrite_cost_usd).toBe('unavailable');
      expect(dataQualityOfTranscripts(w).gaps.no_price).toBe(2);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  });

  it('the 5-minute write is priced at 1.25 x input, a write without a TTL breakdown at the 1-hour price, reads at 0.10 x input', () => {
    const c = newCase();
    try {
      const dir = join(c.dir, 'proj');
      mkdirSync(dir, { recursive: true });
      idCounter = 0;
      const file = join(dir, 's27.jsonl');
      writeLines(file, [
        assistant('2026-11-14T10:00:00Z', 'test-model', usageOf(0, 1000000, 0, 0, 1000000, 0)),
        assistant('2026-11-14T10:01:00Z', 'test-model', usageOf(0, 1000000, 0, 0)),
        assistant('2026-11-14T10:02:00Z', 'test-model', usageOf(0, 0, 1000000, 0)),
      ]);
      const w = resultJson(run(c, [file], ['--json']));
      // 1.25 + 2.0 + 0.10 USD for 1 million tokens at the input price of 1 USD per million tokens
      expect(w.calls_cost_usd).toBe('3.3500');
      expect(dataQualityOfTranscripts(w).gaps.no_ttl_breakdown).toBe(1);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
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
    return spawnSync('python3', ['-I', SCRIPT, '--transcript', transcript, '--deployed-at', DEPLOYED_AT, '--to', TO, '--json'], { encoding: 'utf8', cwd, env });
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
