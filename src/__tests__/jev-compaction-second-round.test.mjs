/* global setTimeout, clearTimeout */
/**
 * Tests for the second round in hooks/jev-compaction.mjs (OMC_JEV_COMPACT_BLOCKS=active with the token cascade): the results and the blocks Jev kept in one queue in the order of
 * Jev's ratings, the stop at the target, the owner's blocks last (OMC_JEV_COMPACT_OWNER_LAST), the question about a tie, the scan budget of the blocks and the trace of a block.
 * The calls of Jev are a fake `$.http.fetch`; no network.
 */

import { describe, expect, it } from 'vitest';

import { chooseByRank, reduceToLimit, register, traceHeader } from '../../hooks/jev-compaction.mjs';

const ACTIVE_ENV = { OMC_JEV: 'compaction:active', TYPESAFE_API_KEY: 'test-key', HOME: '/home/u' };
const BLOCKS = { ...ACTIVE_ENV, OMC_JEV_COMPACT_BLOCKS: 'active' };
const PASTES = '/home/u/.omc/state/jev/compaction-pastes/';
const SPOOL = '/home/u/.omc/state/jev/compaction-spool/';

// The text that carries the level a block is given: the word of its first line.
const LEVEL_WORDS = { ZERO: 0, ONE: 1, TWO: 2, THREE: 3 };
const levelOf = (text) => { const m = /\b(ZERO|ONE|TWO|THREE)\b/.exec(text); return m ? LEVEL_WORDS[m[1]] : 0; };

/**
 * A fake `$`. `answer(text, name)` gives the score of a question about a block (a number 0-3, or undefined for no answer); the questions about results are answered with 0.
 * `fail` makes the calls that carry blocks fail with the given status.
 */
function fakeDollar({ env, messages, api, answer = (text) => levelOf(text), resultScore = () => 0, tie, fail, refuseOver, seed = [], usageTokens = 190000 }) {
  const store = new Map(seed);
  const asked = [];
  const bodies = [];
  const ties = [];
  const $ = {
    env: { get: async (name) => env[name] },
    settings: { read: async () => undefined },
    fs: {
      read: async (p) => { if (!store.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return store.get(p); },
      exists: async (p) => store.has(p),
      stat: async (p) => { if (!store.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { kind: 'file', size: store.get(p).length, mtimeMs: Date.now(), isLink: false }; },
      write: async (p, text) => { store.set(p, text); },
      list: async (p) => [...store.keys()].filter((k) => k.startsWith(p)).map((k) => k.slice(p.length).split('/')[0]),
    },
    http: {
      fetch: async (url, init) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        const isBlocks = Boolean(body.state.blocks);
        const isTie = Boolean(body.state.items);
        if (isTie) {
          ties.push(body);
          if (tie?.fail) return { ok: false, status: tie.fail, headers: {}, text: JSON.stringify({ error: 'refused' }) };
          const out = {};
          for (const q of Object.keys(body.questions)) { const score = tie ? tie.answer(body.state.items[q], q) : undefined; out[q] = score === undefined ? { type: 'none' } : { type: 'score', score, confidence: 0.9 }; }
          return { ok: true, status: 200, headers: {}, text: JSON.stringify({ answers: out }) };
        }
        if (isBlocks && refuseOver && init.body.length > refuseOver) return { ok: false, status: 400, headers: {}, text: JSON.stringify({ error: 'too large' }) };
        if (isBlocks && fail) return { ok: false, status: fail, headers: {}, text: JSON.stringify({ error: 'refused' }) };
        const answers = {};
        for (const q of Object.keys(body.questions)) {
          if (isBlocks) {
            const text = body.state.blocks[q].text;
            asked.push(text);
            const score = answer(text, q);
            answers[q] = score === undefined ? { type: 'none' } : { type: 'score', score, confidence: 0.9 };
          } else answers[q] = { type: 'score', score: resultScore(Number(/RESULT-(\d+) /.exec(JSON.stringify(body.state.results?.[q] ?? ''))?.[1])), confidence: 0.9 };
        }
        return { ok: true, status: 200, headers: {}, text: JSON.stringify({ answers }) };
      },
    },
    clock: { after: (ms, fn) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; }, sleep: async () => { throw new Error('the module must not use $.clock.sleep'); } },
    session: {
      id: async () => 'sess-blocks',
      usage: async (o) => ({ context: { tokens: usageTokens, window: 200000, ...(o?.breakdown ? { breakdown: { rawMaxTokens: 200000, autoCompactThreshold: 167000 } } : {}) } }),
      messages: async (o) => (api && o?.as === 'api' ? api : messages),
      compact: async () => ({}),
    },
    ui: { log: () => {}, toast: () => {} },
  };
  const records = () => [...store.entries()].filter(([p]) => p.startsWith(SPOOL)).map(([, t]) => JSON.parse(t));
  const files = () => new Map([...store.entries()].filter(([p]) => p.startsWith(PASTES)));
  return { $, store, asked, bodies, ties, records, files };
}

function apiOf(messages) {
  const api = [];
  for (const m of messages) {
    const content = m.role === 'assistant'
      ? [...(m.text ? [{ type: 'text', text: m.text }] : []), ...m.toolUses.map((u) => ({ type: 'tool_use', id: u.tool_use_id, name: u.tool, input: u.input }))]
      : [...(m.toolResults || []).map((r) => ({ type: 'tool_result', tool_use_id: r.tool_use_id, content: r.text })), ...(m.text ? [{ type: 'text', text: m.text }] : [])];
    if (m.role === 'user' && api[api.length - 1]?.role === 'user') api[api.length - 1].content.push(...content); else api.push({ role: m.role, content });
  }
  return api;
}

const RESULT_CHARS = 5000;
const fill = (word, n) => `${word} `.repeat(Math.ceil(n / (word.length + 1))).slice(0, n).trim();
const frozen = (list) => list.map((x, k) => Object.freeze({ ...x, handle: `h${k}` }));

/**
 * A task, `steps` steps (an assistant text with a call, and the call's result of RESULT_CHARS characters) and a last request with its answer. `said(i)` is the text of step i; `asks(i)`
 * the owner's message that comes before step i (none when undefined).
 */
function session(steps, { said, asks = () => undefined } = {}) {
  const m = [{ role: 'user', text: 'Task: look at the notes and report.', toolUses: [] }];
  for (let i = 1; i <= steps; i++) {
    const ask = asks(i);
    if (ask) m.push({ role: 'user', text: ask, toolUses: [] }, { role: 'assistant', text: `Answer to the message ${i}.`, toolUses: [] });
    m.push({ role: 'assistant', text: said(i), toolUses: [{ tool_use_id: `t${i}`, tool: 'Bash', input: { command: `cat notes-${i}.txt` } }] });
    m.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${i}`, text: `RESULT-${i} ${'x'.repeat(RESULT_CHARS)}`, isError: false }] });
  }
  m.push({ role: 'user', text: 'Good, now sum up the results.', toolUses: [] }, { role: 'assistant', text: 'Summary: done.', toolUses: [] });
  return frozen(m);
}

async function compactRun(env, messages, options = {}) {
  const fake = fakeDollar({ env, messages, api: apiOf(messages), ...options });
  const handlers = {};
  register((event, hook) => { handlers[event] = hook; });
  const out = await handlers['session.compact'](fake.$, Object.freeze({ trigger: 'auto', messages }), async () => ({ messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }));
  return { ...fake, out, record: fake.records().find((r) => r.event === 'compact') };
}

const allText = (out) => (out?.messages ?? []).map((m) => m.text ?? '').join('\n');
const said = (i) => `Step ${i} note (${['ZERO', 'ONE', 'TWO', 'THREE'][i % 4]}) ${fill(`detail${i}`, 900)}`;


const CASCADE = (percent, extra = {}) => ({ ...BLOCKS, OMC_JEV_COMPACT_TARGET_PERCENT: String(percent), ...extra });
// An owner's message with the word of level 2 in front of every eighth step: five of them stand before the tail.
const ask = (i) => (i % 8 === 0 ? `Owner request ${i} (TWO) ${fill(`ask${i}`, 900)}` : undefined);
const ownersWhole = (out) => [8, 16, 24, 32, 40].filter((i) => allText(out).includes(fill(`ask${i}`, 200))).length;
const results06 = { resultScore: () => 0.6 };
// The target with TARGET_PERCENT 54 and 55 is 91 800 and 93 500 tokens (85 % of the share of the window): the second pass of the cascade leaves 99 058 above it.
const entry = (id, score, gain, more = {}) => ({ id, kind: 'block', score, gain, tokens: gain * 2, ...more });
const farDeadline = () => Date.now() + 60000;

describe('second round: the order of Jev and the stop at the target', () => {
  it('takes from the lowest score until the gains cover what has to come off, equal scores in the order of entry, nothing else orders them', () => {
    const list = [entry('a', 0.9, 500), entry('b', 0.1, 10), entry('c', 0.5, 300), entry('d', 0.1, 20), entry('e', 0.5, 1)];
    expect(chooseByRank(list, 25).chosen.map((x) => x.id)).toEqual(['b', 'd']);
    expect(chooseByRank(list, 31).chosen.map((x) => x.id)).toEqual(['b', 'd', 'c']);
    expect(chooseByRank(list, 331).chosen.map((x) => x.id)).toEqual(['b', 'd', 'c', 'e']);
    expect(chooseByRank(list, 0).chosen).toEqual([]);
    const pick = chooseByRank(list, 25);
    expect(pick).toMatchObject({ saved: 30, short: false, tie: undefined });
  });

  it('says short when every entry together does not cover the need, and a tie when the score at the edge of the choice stands behind it too', () => {
    expect(chooseByRank([entry('a', 0.1, 10), entry('b', 0.2, 10)], 100)).toMatchObject({ short: true, saved: 20 });
    const pick = chooseByRank([entry('a', 0.1, 10), entry('b', 0.5, 10), entry('c', 0.5, 10), entry('d', 0.5, 10)], 25);
    expect(pick.short).toBe(false);
    expect(pick.tie.group.map((x) => x.id)).toEqual(['b', 'c', 'd']);
    expect(pick.tie.below.map((x) => x.id)).toEqual(['a']);
    expect(pick.tie.restNeed).toBe(15);
    expect(chooseByRank([entry('a', 0.1, 10), entry('b', 0.5, 10), entry('c', 0.7, 10)], 15).tie).toBeUndefined();
  });

  it('puts the results and the blocks in one queue and stops at the goal; a removal is open only after its trace was taken, so it comes in the next round', async () => {
    const entries = [
      { id: 'w:x', kind: 'result', score: 0.1, gain: 10, tokens: 20, to: 'trace' },
      { id: 'w:x:drop', kind: 'result', score: 0.1, gain: 10, tokens: 20, to: 'drop', requires: 'w:x' },
      entry('b:y', 0.5, 4),
    ];
    const out = await reduceToLimit({ entries, pred: 1000, goal: 985, deadline: farDeadline() });
    expect(out.lowered.map((x) => x.id)).toEqual(['w:x', 'b:y', 'w:x:drop']);
    expect(out.f2.rounds.map((r) => r.chosen)).toEqual([2, 1]);
    expect(out.f2).toMatchObject({ predicted_before: 1000, to_remove_tokens: 15, predicted_after: 976, reason: 'goal_reached', lowered: { items: 3, by_kind: { result: 2, block: 1 } } });
    expect(out.f2.saved_by_stop).toEqual({ items: 0, tokens: 0 });
    const none = await reduceToLimit({ entries, pred: 900, goal: 985, deadline: farDeadline() });
    expect(none.lowered).toEqual([]);
    expect(none.f2.reason).toBe('below_goal');
  });

  it('starts no round past the deadline and says why it stopped', async () => {
    const entries = [entry('a', 0.1, 100)];
    expect((await reduceToLimit({ entries, pred: 1000, goal: 500, deadline: Date.now() })).f2).toMatchObject({ reason: 'deadline', rounds: [] });
    expect((await reduceToLimit({ entries, pred: 1000, goal: 500, deadline: farDeadline() })).f2).toMatchObject({ reason: 'no_items', predicted_after: 900 });
    const out = await reduceToLimit({ entries: [entry('a', 0.1, 100), entry('b', 0.9, 100)], pred: 1000, goal: 500, deadline: farDeadline() });
    expect(out.f2).toMatchObject({ reason: 'no_items', predicted_after: 800 });
  });

  it('puts a tie group to Jev once and chooses again on the answers; what stays tied is settled by the code in the order of entry', async () => {
    const entries = [entry('a', 0.5, 10), entry('b', 0.5, 10), entry('c', 0.5, 10), entry('d', 0.1, 10)];
    const asked = [];
    const answered = await reduceToLimit({
      entries: entries.map((x) => ({ ...x })), pred: 100, goal: 80, deadline: farDeadline(),
      askTie: async (group, restNeed) => { asked.push([group.map((x) => x.id), restNeed]); group.find((x) => x.id === 'c').score = 0.2; },
    });
    expect(asked).toEqual([[['a', 'b', 'c'], 10]]);
    expect(answered.lowered.map((x) => [x.id, x.by])).toEqual([['d', 'jev'], ['c', 'jev']]);
    const stayed = await reduceToLimit({ entries: entries.map((x) => ({ ...x })), pred: 100, goal: 80, deadline: farDeadline(), askTie: async () => {} });
    expect(stayed.lowered.map((x) => [x.id, x.by])).toEqual([['d', 'jev'], ['a', 'code']]);
    expect(stayed.f2.ties).toMatchObject({ asked: 1, groups: 1, group_items: 3, by_code: { items: 1 } });
    const broken = await reduceToLimit({ entries: entries.map((x) => ({ ...x })), pred: 100, goal: 80, deadline: farDeadline(), askTie: async () => { throw new Error('no answer'); } });
    expect(broken.lowered.map((x) => x.id)).toEqual(['d', 'a']);
    expect(broken.f2.ties).toMatchObject({ asked: 1, errors: 1, error: 'no answer' });
  });
});

describe('second round: the owner blocks last (OMC_JEV_COMPACT_OWNER_LAST)', () => {
  it('the entries marked late wait behind every other entry and come down only when nothing else is left', async () => {
    const entries = [entry('own', 0.0, 50, { late: true }), entry('other', 0.9, 50)];
    const one = await reduceToLimit({ entries, pred: 100, goal: 50, deadline: farDeadline() });
    expect(one.lowered.map((x) => x.id)).toEqual(['other']);
    expect(one.f2.late_owner_blocks).toEqual({ candidates: 1, lowered: 0 });
    const both = await reduceToLimit({ entries, pred: 100, goal: 0, deadline: farDeadline() });
    expect(both.lowered.map((x) => x.id)).toEqual(['other', 'own']);
    expect(both.f2.late_owner_blocks).toEqual({ candidates: 1, lowered: 1 });
    const plain = await reduceToLimit({ entries: [entry('own', 0.0, 50), entry('other', 0.9, 50)], pred: 100, goal: 50, deadline: farDeadline() });
    expect(plain.lowered.map((x) => x.id)).toEqual(['own']);
    expect(plain.f2.late_owner_blocks).toBeUndefined();
  });

  it('with the switch active the owner blocks that Jev kept stay word for word while other items can still come down; without it they come down in the order of the scores', async () => {
    const env = CASCADE(55);
    const plain = await compactRun(env, session(40, { said, asks: ask }), results06);
    const last = await compactRun({ ...env, OMC_JEV_COMPACT_OWNER_LAST: 'active' }, session(40, { said, asks: ask }), results06);
    expect(plain.record.f2.late_owner_blocks).toBeUndefined();
    expect(ownersWhole(plain.out)).toBeLessThan(5);
    expect(ownersWhole(last.out)).toBe(5);
    expect(last.record.f2.late_owner_blocks).toEqual({ candidates: 4, lowered: 0 });
    expect(last.record.f2.lowered.by_kind.block).toBeGreaterThan(0);
    expect(last.record.tokens_after_pred).toBeLessThanOrEqual(last.record.f2.goal_tokens);
  });
});

describe('second round: in a compaction (OMC_JEV_COMPACT_BLOCKS=active, the token cascade)', () => {
  it('lowers the results and the blocks Jev kept, in one pass of its own, and the prediction ends at the target', async () => {
    const run = await compactRun(CASCADE(54), session(40, { said, asks: ask }), results06);
    expect(run.record).toMatchObject({ result: 'jev', cascade_pass: 'F2' });
    const f2 = run.record.f2;
    expect(f2).toMatchObject({ mode: 'active', pass_a: 'short_or_trace', reason: 'goal_reached', reserve: { tokens: 0, pass: null } });
    expect(f2.predicted_after_a).toBeGreaterThan(f2.goal_tokens);
    expect(f2.lowered.by_kind.result).toBeGreaterThan(0);
    expect(f2.lowered.by_kind.block).toBeGreaterThan(0);
    expect(f2.executed_blocks_tokens).toBeGreaterThan(0);
    expect(run.record.tokens_after_pred).toBeLessThanOrEqual(f2.goal_tokens);
    expect(f2.predicted_after_a - run.record.tokens_after_pred).toBeGreaterThan(f2.to_remove_tokens);
  });

  it('a block of level 2 that comes down leaves a trace with its start and a file with its full text; the header names the directory once', async () => {
    const run = await compactRun(CASCADE(54), session(40, { said, asks: ask }), results06);
    const traces = allText(run.out).split('\n').filter((l) => /^\[block moved at compaction: \d+ chars in b\/[0-9a-f]{32}\.txt; start: "Step \d+ note \(TWO\)/.test(l));
    expect(traces.length).toBeGreaterThan(0);
    const saved = [...run.files()].filter(([path]) => path.endsWith('.txt')).map(([, text]) => text);
    for (const line of traces) {
      const n = Number(/Step (\d+) note/.exec(line)[1]);
      expect(saved).toContain(said(n));
      expect(allText(run.out)).not.toContain(said(n));
    }
    expect(run.out.messages[0].text).toBe(traceHeader(`${PASTES}sess-blocks`));
    expect(allText(run.out).split('compaction trace files:').length).toBe(2);
  });

  it('a level 3 block stays word for word while a lower score is left to come down, and the words of the owner are not touched without the switch for a goal the others reach', async () => {
    const run = await compactRun(CASCADE(56), session(40, { said, asks: ask }), results06);
    expect(run.record.f2.lowered.by_kind.block ?? 0).toBe(0);
    expect(ownersWhole(run.out)).toBe(5);
    for (const i of [3, 7, 11, 15]) expect(allText(run.out)).toContain(said(i));
  });

  it('no second round without the switch, and in shadow only a count in the record, with the conversation as before', async () => {
    const off = await compactRun({ ...CASCADE(54), OMC_JEV_COMPACT_BLOCKS: 'off' }, session(40, { said, asks: ask }), results06);
    const shadow = await compactRun({ ...CASCADE(54), OMC_JEV_COMPACT_BLOCKS: 'shadow' }, session(40, { said, asks: ask }), results06);
    expect(off.record.f2).toBeUndefined();
    expect(shadow.record.f2).toEqual({ mode: 'shadow', candidates: expect.objectContaining({ result: expect.any(Number), block: expect.any(Number) }) });
    expect(JSON.stringify(shadow.out.messages)).toBe(JSON.stringify(off.out.messages));
    expect(shadow.record.cascade_pass).toBe(off.record.cascade_pass);
    expect(shadow.record.tokens_after_pred).toBe(off.record.tokens_after_pred);
    expect(off.record.cascade_pass).not.toBe('F2');
    expect(allText(off.out)).not.toContain('compaction trace files:');
  });

  it('a prediction at or under the target after the second pass gives no round', async () => {
    const run = await compactRun(CASCADE(57), session(40, { said, asks: ask }), results06);
    expect(run.record.f2).toMatchObject({ mode: 'active', reason: 'below_goal', to_remove_tokens: 0 });
    expect(run.record.cascade_pass).toBe('short_or_trace');
  });

  it('puts a tie group to Jev once with the question of the second round, and the answers decide which blocks come down first', async () => {
    // Every block in the group has level 2; Jev rates the steps 2, 10, 18 ... low, the steps 6, 14 ... high and the rest between.
    const number = (item) => Number(/Step (\d+)/.exec(item.text ?? '')?.[1] ?? /Owner request (\d+)/.exec(item.text ?? '')?.[1]);
    const rate = (item) => (number(item) % 8 === 2 ? 0.1 : number(item) % 8 === 6 ? 0.9 : 0.5);
    const run = await compactRun(CASCADE(55), session(40, { said, asks: ask }), { ...results06, tie: { answer: rate } });
    expect(run.ties.length).toBeGreaterThan(0);
    const body = run.ties[0];
    expect(body.state.f2).toMatchObject({ tie_group: true, goal_tokens: run.record.f2.goal_tokens });
    expect(Object.values(body.questions)[0].instructions).toContain('f2.goal_tokens');
    expect(run.record.f2.ties).toMatchObject({ asked: 1, errors: 0 });
    const steps = [...allText(run.out).matchAll(/\[block moved at compaction: \d+ chars in b\/\w+\.txt; start: "Step (\d+) note \(TWO\)/g)].map((m) => Number(m[1]));
    const low = steps.filter((n) => n % 8 === 2).length;
    expect(low).toBeGreaterThan(0);
    expect(low).toBeGreaterThanOrEqual(steps.filter((n) => n % 8 === 6).length);
    expect(steps.filter((n) => n % 8 === 6).length).toBeLessThan(5);
  });

  it('a refused question about a tie does not break the compaction: the code settles the tie', async () => {
    const plain = await compactRun(CASCADE(55), session(40, { said, asks: ask }), results06);
    const refused = await compactRun(CASCADE(55), session(40, { said, asks: ask }), { ...results06, tie: { fail: 500 } });
    expect(refused.record.result).toBe('jev');
    expect(refused.record.f2.ties.asked).toBe(1);
    expect(refused.record.f2.lowered).toEqual(plain.record.f2.lowered);
  });
});

describe('the scan budget of the blocks', () => {
  const long = (i) => `Step ${i} note (TWO) ${fill(`detail${i}`, 1900)}`;
  it('checks up to 200 000 characters of blocks for a secret in one pass, and a block past that is left unasked', async () => {
    const within = await compactRun(BLOCKS, session(95, { said: long }));
    const past = await compactRun(BLOCKS, session(115, { said: long }));
    expect(within.record.blocks.verdicts.unchecked).toBe(0);
    expect(past.record.blocks.verdicts.unchecked).toBeGreaterThan(0);
    expect(past.record.blocks.verdicts.asked).toBeLessThan(past.record.blocks.verdicts.eligible);
  });
});
