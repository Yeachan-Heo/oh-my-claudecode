/* global setTimeout, clearTimeout */
/**
 * Tests for the verdicts of Jev on blocks of text in hooks/jev-compaction.mjs (OMC_JEV_COMPACT_BLOCKS=off|shadow|active, off when unset): the blocks of the rows before the
 * tail are rated on four levels, level 3 and 2 stay word for word, level 1 and 0 go to a file and leave a trace. The calls of Jev are a fake `$.http.fetch`; no network.
 */

import { describe, expect, it } from 'vitest';

import { blockTrace, register, splitBlocks, traceHeader } from '../../hooks/jev-compaction.mjs';

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
function fakeDollar({ env, messages, api, answer = (text) => levelOf(text), fail, refuseOver, seed = [] }) {
  const store = new Map(seed);
  const asked = [];
  const bodies = [];
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
        if (isBlocks && refuseOver && init.body.length > refuseOver) return { ok: false, status: 400, headers: {}, text: JSON.stringify({ error: 'too large' }) };
        if (isBlocks && fail) return { ok: false, status: fail, headers: {}, text: JSON.stringify({ error: 'refused' }) };
        const answers = {};
        for (const q of Object.keys(body.questions)) {
          if (isBlocks) {
            const text = body.state.blocks[q].text;
            asked.push(text);
            const score = answer(text, q);
            answers[q] = score === undefined ? { type: 'none' } : { type: 'score', score, confidence: 0.9 };
          } else answers[q] = { type: 'score', score: 0, confidence: 0.9 };
        }
        return { ok: true, status: 200, headers: {}, text: JSON.stringify({ answers }) };
      },
    },
    clock: { after: (ms, fn) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; }, sleep: async () => { throw new Error('the module must not use $.clock.sleep'); } },
    session: {
      id: async () => 'sess-blocks',
      usage: async (o) => ({ context: { tokens: 190000, window: 200000, ...(o?.breakdown ? { breakdown: { rawMaxTokens: 200000, autoCompactThreshold: 167000 } } : {}) } }),
      messages: async (o) => (api && o?.as === 'api' ? api : messages),
      compact: async () => ({}),
    },
    ui: { log: () => {}, toast: () => {} },
  };
  const records = () => [...store.entries()].filter(([p]) => p.startsWith(SPOOL)).map(([, t]) => JSON.parse(t));
  const files = () => new Map([...store.entries()].filter(([p]) => p.startsWith(PASTES)));
  return { $, store, asked, bodies, records, files };
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

const textOf = (out, needle) => (out?.messages ?? []).map((m) => m.text ?? '').find((t) => t.includes(needle));
const lineOf = (out, needle) => allText(out).split('\n').find((l) => l.includes(needle));
const allText = (out) => (out?.messages ?? []).map((m) => m.text ?? '').join('\n');
const said = (i) => `Step ${i} note (${['ZERO', 'ONE', 'TWO', 'THREE'][i % 4]}) ${fill(`detail${i}`, 900)}`;

describe('blocks of text: the blocks of a text and the trace', () => {
  it('splits paragraphs, closed fenced code blocks and closed pasted tags; traces and blank lines are no block', () => {
    const text = ['First paragraph', 'with two lines.', '', '```js', 'const a = 1;', '', 'const b = 2;', '```', '', '<pasted_content id="p1">', 'pasted', '', 'text', '</pasted_content>', '[block moved at compaction: 10 chars, full text in /x/y.txt]', 'Last one.'].join('\n');
    const blocks = splitBlocks(text).map((b) => ({ kind: b.kind, text: text.slice(b.start, b.end) }));
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'text', 'tag']);
    expect(blocks[0].text).toBe('First paragraph\nwith two lines.');
    expect(blocks[1].text).toBe('```js\nconst a = 1;\n\nconst b = 2;\n```');
    expect(blocks[2].text.startsWith('<pasted_content')).toBe(true);
  });

  it('leaves the whole paragraph with a trace line in it out of the blocks, the text above and below the trace line included, and cuts at the blank line', () => {
    const trace = '[block moved at compaction: 10 chars, full text in /x/y.txt]';
    const call = '[compacted] Bash(ls) - result of 3 chars removed';
    const text = `Above the trace.\n${trace}\nBelow the trace.\n\nSeparate one.\n${call}\n\nSeparate two.\n\n${call}\n${call}`;
    expect(splitBlocks(text).map((b) => text.slice(b.start, b.end))).toEqual(['Separate two.']);
    const fenced = `Lead line.\n${call}\n\`\`\`js\nconst a = 1;\n\`\`\`\n\nTail.`;
    expect(splitBlocks(fenced).map((b) => fenced.slice(b.start, b.end))).toEqual(['```js\nconst a = 1;\n```', 'Tail.']);
  });

  it('reads the lines of an unclosed fence as an ordinary paragraph', () => {
    const text = 'Before.\n\n```js\nconst a = 1;\n\nafter the fence line';
    expect(splitBlocks(text).map((b) => text.slice(b.start, b.end))).toEqual(['Before.', '```js\nconst a = 1;', 'after the fence line']);
  });

  it('writes the length in characters and the letter and name of the file; level 1 adds the first 60 characters, a direct reply its first and last ones', () => {
    const text = `${'a'.repeat(59)}b${'c'.repeat(200)}\n"quote"`;
    expect(blockTrace(text.length, text, 'b/abc.txt')).toBe(`[block moved at compaction: ${text.length} chars in b/abc.txt]`);
    expect(traceHeader('/s/p')).toBe('[compaction trace files: b/ = /s/p]');
    const start = blockTrace(text.length, text, 'b/abc.txt', 'start');
    expect(start).toContain(`; start: "${'a'.repeat(59)}b"]`);
    expect(start.includes('cc')).toBe(false);
    expect(blockTrace(text.length, text, 'b/abc.txt', 'floor')).toContain('; end: ');
    expect(blockTrace(text.length, text, 'b/abc.txt', 'start', true).startsWith('[agent message moved at compaction, not from the user: b/abc.txt')).toBe(true);
  });
});

describe('blocks of text: the verdicts carried out (OMC_JEV_COMPACT_BLOCKS=active)', () => {
  it('leaves level 3 and 2 word for word, moves level 1 with its start and level 0 bare, the full text in a file under the pastes directory', async () => {
    const run = await compactRun(BLOCKS, session(40, { said }));
    expect(run.out?.messages).toBeTruthy();
    expect(run.record.blocks).toMatchObject({ mode: 'active', installed: true });
    const zero = said(4);
    const one = said(5);
    const two = said(2);
    const three = said(3);
    // the steps in the tail are not asked about, the early ones are
    expect(run.asked).toContain(zero);
    expect(allText(run.out)).toContain(two);
    expect(allText(run.out)).toContain(three);
    expect(allText(run.out)).not.toContain(zero);
    expect(allText(run.out)).not.toContain(one);
    const traceZero = lineOf(run.out, `[block moved at compaction: ${zero.length} chars in b/`);
    expect(traceZero).toBeTruthy();
    expect(traceZero).not.toContain(PASTES);
    // the directory stands once, in the header that opens the result
    expect(run.out.messages[0].text).toBe(traceHeader(`${PASTES}sess-blocks`));
    expect(allText(run.out).split(traceHeader(`${PASTES}sess-blocks`)).length).toBe(2);
    expect(traceZero).not.toContain('; start: ');
    const traceOne = lineOf(run.out, `; start: "Step 5 note (ONE)`);
    expect(traceOne.endsWith(`; start: ${JSON.stringify(one.slice(0, 60))}]`)).toBe(true);
    const saved = [...run.files()].filter(([p]) => p.endsWith('.txt'));
    expect(saved.map(([, t]) => t)).toContain(zero);
    expect(saved.map(([, t]) => t)).toContain(one);
    expect(saved.map(([, t]) => t)).not.toContain(two);
    for (const [p] of saved) expect(p).toMatch(/\/sess-blocks\/[0-9a-f]{32}\.txt$/);
  });

  it('writes a verdict file per block with its level, and the level is the answer of Jev from 0 to 3', async () => {
    const run = await compactRun(BLOCKS, session(40, { said }));
    const verdicts = [...run.files()].filter(([p]) => p.includes('/verdict-block-')).map(([, t]) => JSON.parse(t));
    expect(verdicts.length).toBeGreaterThan(8);
    expect(new Set(verdicts.map((v) => v.level))).toEqual(new Set([0, 1, 2, 3]));
    for (const v of verdicts) expect(v).toMatchObject({ kind: 'block', question_version: expect.any(String), settings: expect.any(String) });
    expect(run.record.blocks.levels.reduce((a, b) => a + b, 0)).toBeGreaterThan(8);
  });

  it('a direct reply (the first reply after the owner message) keeps its start and its end in the trace, whatever the level', async () => {
    const run = await compactRun(BLOCKS, session(40, { said }));
    const trace = lineOf(run.out, `; start: "Step 1 note (ONE)`);
    expect(trace).toBeTruthy();
    expect(trace).toContain(`; start: ${JSON.stringify(said(1).slice(0, 120))}`);
    expect(trace).toContain(`; end: ${JSON.stringify(said(1).slice(-120))}`);
  });

  it('keeps the rows of the tail untouched: the six last rows are not asked about and stay word for word', async () => {
    const messages = session(40, { said: (i) => `Step ${i} (ZERO) ${fill(`detail${i}`, 900)}` });
    const run = await compactRun(BLOCKS, messages);
    for (const i of [39, 40]) expect(allText(run.out)).toContain(`Step ${i} (ZERO)`);
    expect(allText(run.out)).not.toContain('Step 3 (ZERO)');
    expect(run.asked.some((t) => t.startsWith('Step 39 ') || t.startsWith('Step 40 '))).toBe(false);
    expect(run.asked.some((t) => t.startsWith('Step 3 '))).toBe(true);
    expect(run.asked.some((t) => t.startsWith('Step 38 '))).toBe(true);
  });

  it('asks about the owner words and the assistant text before the tail and carries the verdicts out the same way', async () => {
    const asks = (i) => (i % 6 === 0 ? `Owner message ${i} (ZERO): ${fill(`wish${i}`, 900)}` : undefined);
    const run = await compactRun(BLOCKS, session(40, { said: (i) => `Step ${i} (TWO) ${fill(`detail${i}`, 900)}`, asks }));
    expect(run.asked.some((t) => t.startsWith('Owner message 6 '))).toBe(true);
    expect(allText(run.out)).not.toContain('Owner message 6 (ZERO)');
    expect(allText(run.out)).toContain('Step 6 (TWO)');
    const trace = textOf(run.out, '[block moved at compaction: ');
    expect(trace).toBeTruthy();
  });

  it('keeps the words of the owner at level 2 and 3 word for word', async () => {
    const asks = (i) => (i % 6 === 0 ? `Owner message ${i} (${i % 12 === 0 ? 'THREE' : 'TWO'}): ${fill(`wish${i}`, 900)}` : undefined);
    const run = await compactRun(BLOCKS, session(40, { said: (i) => `Step ${i} (ZERO) ${fill(`detail${i}`, 900)}`, asks }));
    expect(allText(run.out)).toContain('Owner message 6 (TWO)');
    expect(allText(run.out)).toContain('Owner message 12 (THREE)');
    expect(allText(run.out)).not.toContain('Step 6 (ZERO)');
  });

  it('a block with no answer, and a request that Jev refuses, leave the block word for word', async () => {
    const none = await compactRun(BLOCKS, session(40, { said }), { answer: () => undefined });
    expect(allText(none.out)).toContain(said(4));
    expect(allText(none.out)).not.toContain('[block moved at compaction: ');
    expect(none.record.blocks.no_verdict).toBeGreaterThan(0);
    const refused = await compactRun(BLOCKS, session(40, { said }), { fail: 500 });
    expect(allText(refused.out)).toContain(said(4));
    expect(allText(refused.out)).not.toContain('[block moved at compaction: ');
    expect(refused.record.blocks.verdicts.ask.failed).toBeGreaterThan(0);
    expect([...refused.files()].filter(([p]) => p.includes('/verdict-block-'))).toHaveLength(0);
  });

  it('an answer outside 0 to 3 is no verdict', async () => {
    for (const bad of [-1, 4, 3.5]) {
      const run = await compactRun(BLOCKS, session(40, { said }), { answer: () => bad });
      expect(allText(run.out)).not.toContain('[block moved at compaction: ');
      expect([...run.files()].filter(([p]) => p.includes('/verdict-block-'))).toHaveLength(0);
    }
  });

  it('an answer that is not a whole level (0.4, 0.5, 1.2 or a negative one) is no verdict and the block stays word for word, while the whole levels 0 to 3 are carried out', async () => {
    for (const bad of [0.4, 0.5, 1.2, -0.5]) {
      const run = await compactRun(BLOCKS, session(40, { said }), { answer: () => bad });
      expect(allText(run.out), String(bad)).not.toContain('[block moved at compaction: ');
      expect(allText(run.out), String(bad)).toContain(said(4));
      expect([...run.files()].filter(([p]) => p.includes('/verdict-block-')), String(bad)).toHaveLength(0);
      expect(run.record.blocks.no_verdict, String(bad)).toBeGreaterThan(0);
    }
    for (const whole of [0, 1, 2, 3]) {
      const run = await compactRun(BLOCKS, session(40, { said }), { answer: () => whole });
      const verdicts = [...run.files()].filter(([p]) => p.includes('/verdict-block-')).map(([, t]) => JSON.parse(t).level);
      expect(verdicts.length, String(whole)).toBeGreaterThan(8);
      expect(new Set(verdicts), String(whole)).toEqual(new Set([whole]));
      expect(allText(run.out).includes('[block moved at compaction: '), String(whole)).toBe(whole < 2);
    }
  });

  it('asks about a block once: a second compaction reads the verdict files and sends no question about blocks', async () => {
    const messages = session(40, { said });
    const first = fakeDollar({ env: BLOCKS, messages, api: apiOf(messages) });
    const handlers = {};
    register((event, hook) => { handlers[event] = hook; });
    const go = () => handlers['session.compact'](first.$, Object.freeze({ trigger: 'auto', messages }), async () => ({ messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }));
    await go();
    const before = first.asked.length;
    expect(before).toBeGreaterThan(8);
    await go();
    expect(first.asked.length).toBe(before);
  });

  it('a verdict file made under another wording of the question, or of another level of detail, is none: its block is asked again', async () => {
    const first = await compactRun(BLOCKS, session(40, { said }));
    const files = [...first.files()].filter(([p]) => p.includes('/verdict-block-'));
    expect(files.length).toBeGreaterThan(8);
    const old = files.map(([p, t]) => [p, JSON.stringify({ ...JSON.parse(t), question_version: 'previous' })]);
    const again = await compactRun(BLOCKS, session(40, { said }), { seed: old });
    expect(again.asked.length).toBe(first.asked.length);
    const same = await compactRun(BLOCKS, session(40, { said }), { seed: files });
    expect(same.asked).toHaveLength(0);
    expect(allText(same.out)).toBe(allText(first.out));
    const torn = await compactRun(BLOCKS, session(40, { said }), { seed: files.map(([p]) => [p, '{not json']) });
    expect(torn.asked.length).toBe(first.asked.length);
  });

  it('a block that names a private path, or that masking changes, is never sent to Jev and stays word for word', async () => {
    const private_ = (i) => (i === 4 ? `Step 4 note (ZERO) read /srv/clients/plan.txt ${fill('detail4', 900)}` : said(i));
    const masked = (i) => (i === 8 ? `Step 8 note (ZERO) key sk-ant-api03-${'A1b2C3d4'.repeat(8)} ${fill('detail8', 900)}` : said(i));
    const one = await compactRun({ ...BLOCKS, OMC_JEV_COMPACT_PRIVATE_PATHS: '/srv/clients' }, session(40, { said: private_ }));
    expect(one.asked.some((t) => t.includes('/srv/clients'))).toBe(false);
    expect(allText(one.out)).toContain('read /srv/clients/plan.txt');
    expect(allText(one.out)).toContain('[block moved at compaction: ');
    const two = await compactRun(BLOCKS, session(40, { said: masked }));
    expect(two.asked.some((t) => t.includes('sk-ant-api03'))).toBe(false);
    expect(allText(two.out)).toContain('sk-ant-api03');
    expect(allText(two.out)).toContain('[block moved at compaction: ');
  });

  it('OMC_JEV_COMPACT_VERDICTS=off asks nothing', async () => {
    const run = await compactRun({ ...BLOCKS, OMC_JEV_COMPACT_VERDICTS: 'off' }, session(40, { said }));
    expect(run.asked).toHaveLength(0);
    expect(allText(run.out)).not.toContain('[block moved at compaction: ');
  });

  it('OMC_JEV_COMPACT_BLOCK_QUESTIONS=shared states the wording of the question once in the state of a request', async () => {
    const full = await compactRun(BLOCKS, session(40, { said }));
    const shared = await compactRun({ ...BLOCKS, OMC_JEV_COMPACT_BLOCK_QUESTIONS: 'shared' }, session(40, { said }));
    const withBlocks = (run) => run.bodies.find((b) => b.state.blocks);
    expect(withBlocks(full).state.block_assessment).toBeUndefined();
    expect(withBlocks(shared).state.block_assessment.levels).toHaveLength(4);
    expect(JSON.stringify(withBlocks(shared).questions).length).toBeLessThan(JSON.stringify(withBlocks(full).questions).length);
    expect(allText(shared.out)).toContain(said(2));
  });

  it('OMC_JEV_COMPACT_WINDOW_CHARS bounds a request in bytes: a smaller window gives more requests, each below it', async () => {
    const wide = await compactRun(BLOCKS, session(40, { said }));
    const narrow = await compactRun({ ...BLOCKS, OMC_JEV_COMPACT_WINDOW_CHARS: '8000' }, session(40, { said }));
    const count = (run) => run.bodies.filter((b) => b.state.blocks).length;
    expect(count(narrow)).toBeGreaterThan(count(wide));
    for (const b of narrow.bodies.filter((x) => x.state.blocks)) expect(JSON.stringify(b).length).toBeLessThanOrEqual(8000);
  });

  it('a request the endpoint refuses as too large (400) is asked again in half the window, and the verdicts come', async () => {
    const run = await compactRun(BLOCKS, session(40, { said }), { refuseOver: 12000 });
    expect(run.record.blocks.verdicts.ask.reduced).toBeGreaterThan(0);
    expect(run.record.blocks.verdicts.ask.answered).toBeGreaterThan(8);
    const sizes = run.bodies.filter((b) => b.state.blocks).map((b) => JSON.stringify(b).length);
    expect(sizes.some((n) => n > 12000)).toBe(true);
    expect(allText(run.out)).toContain('[block moved at compaction: ');
  });

  it('a block above the window goes to Jev in consecutive parts of one item, and its level is the highest of its parts', async () => {
    const big = (i) => (i === 2 ? `Step 2 (ZERO) ${fill('long', 20000)}\nTHREE in a later part` : said(i));
    const run = await compactRun({ ...BLOCKS, OMC_JEV_COMPACT_WINDOW_CHARS: '8000' }, session(40, { said: big }), { answer: (text) => (/Step 2 \(ZERO\)/.test(text) ? 0 : levelOf(text)) });
    const parts = run.bodies.flatMap((b) => Object.values(b.state.blocks ?? {})).filter((x) => x.part);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((x) => x.part.nr)).toEqual(parts.map((_, k) => k + 1));
    expect(parts[0].part.of).toBe(parts.length);
    expect(allText(run.out)).toContain('Step 2 (ZERO) ');
  });
});

describe('blocks of text: the switch', () => {
  const asBefore = (run) => JSON.stringify(run.out?.messages ?? null);

  it('without the variable, or with any value but shadow and active, the compaction asks nothing about blocks and is the same', async () => {
    const base = await compactRun(ACTIVE_ENV, session(40, { said }));
    expect(base.asked).toHaveLength(0);
    expect(base.record.blocks).toBeUndefined();
    for (const value of ['off', '', 'yes', '1', 'true']) {
      const run = await compactRun({ ...ACTIVE_ENV, OMC_JEV_COMPACT_BLOCKS: value }, session(40, { said }));
      expect(run.asked).toHaveLength(0);
      expect(run.record.blocks).toBeUndefined();
      expect(asBefore(run)).toBe(asBefore(base));
    }
  });

  it('shadow asks, counts and writes the verdict files, but the window is the same as with the switch off and no text moves', async () => {
    const base = await compactRun(ACTIVE_ENV, session(40, { said }));
    const run = await compactRun({ ...ACTIVE_ENV, OMC_JEV_COMPACT_BLOCKS: 'shadow' }, session(40, { said }));
    expect(run.asked.length).toBeGreaterThan(8);
    expect(run.record.blocks).toMatchObject({ mode: 'shadow' });
    expect(run.record.blocks.installed).toBe(false);
    expect(run.record.blocks.moved).toBeGreaterThan(0);
    expect(asBefore(run)).toBe(asBefore(base));
    expect([...run.files()].filter(([p]) => p.endsWith('.txt'))).toHaveLength(0);
    expect([...run.files()].filter(([p]) => p.includes('/verdict-block-')).length).toBeGreaterThan(8);
  });

  it('reads the value in any case', async () => {
    const run = await compactRun({ ...ACTIVE_ENV, OMC_JEV_COMPACT_BLOCKS: 'ACTIVE' }, session(40, { said }));
    expect(run.record.blocks.mode).toBe('active');
  });

  it('with the point itself in shadow no question about blocks is sent and none moves', async () => {
    const run = await compactRun({ ...BLOCKS, OMC_JEV: 'compaction' }, session(40, { said }));
    expect(run.asked).toHaveLength(0);
    expect(run.record.blocks).toMatchObject({ mode: 'shadow', moved: 0, installed: false });
    expect(allText(run.out)).toBe('SUMMARY');
  });
});

describe('blocks of text: a row that opens with a moved block', () => {
  it('is no message of the user, so none of its words is put to Jev, whether the blocks act or only count', async () => {
    const asks = (i) => (i === 3 ? `[block moved at compaction: 900 chars in b/x.txt]\nKeep OWNERWORDS ${fill('owner', 600)}` : undefined);
    for (const blocks of ['active', 'shadow']) {
      const run = await compactRun({ ...ACTIVE_ENV, OMC_JEV_COMPACT_BLOCKS: blocks }, session(40, { said, asks }));
      expect(run.asked.length, blocks).toBeGreaterThan(0);
      expect(run.asked.some((text) => text.includes('OWNERWORDS')), blocks).toBe(false);
    }
    const words = await compactRun({ ...ACTIVE_ENV, OMC_JEV_COMPACT_BLOCKS: 'active' }, session(40, { said, asks: (i) => (i === 3 ? `Keep OWNERWORDS ${fill('owner', 600)}` : undefined) }));
    expect(words.asked.some((text) => text.includes('OWNERWORDS'))).toBe(true);
  });
});

describe('blocks of text: the header of the trace files', () => {
  const HEADER_OPEN = '[compaction trace files: ';
  const header = traceHeader(`${PASTES}sess-blocks`);

  it('a message of the user that opens with the words of the header and goes on is kept whole in the middle of the session', async () => {
    const asks = (i) => (i === 6 ? `${HEADER_OPEN}my note: MIDWORDS (THREE) ${fill('wish', 600)}` : undefined);
    const run = await compactRun(BLOCKS, session(40, { said, asks }));
    expect(allText(run.out)).toContain(`${HEADER_OPEN}my note: MIDWORDS (THREE) wish`);
    expect(run.out.messages[0].text).toBe(header);
    expect(allText(run.out).split(header).length).toBe(2);
  });

  it('a newest message of the user that opens with the words of the header and goes on is kept whole', async () => {
    const tailed = session(40, { said }).map((m, i, all) => (i === all.length - 2 ? { ...m, text: `${HEADER_OPEN}b/ = /my/dir] and then TAILWORDS` } : m));
    const run = await compactRun(BLOCKS, tailed);
    expect(allText(run.out)).toContain(`${HEADER_OPEN}b/ = /my/dir] and then TAILWORDS`);
    expect(run.out.messages[0].text).toBe(header);
  });

  it('with the verdicts off the verdict files that exist still move blocks, and the result opens with the header that names their directory', async () => {
    const first = await compactRun(BLOCKS, session(40, { said }));
    const files = [...first.files()].filter(([p]) => p.includes('/verdict-block-'));
    expect(files.length).toBeGreaterThan(8);
    const run = await compactRun({ ...BLOCKS, OMC_JEV_COMPACT_VERDICTS: 'off' }, session(40, { said }), { seed: files });
    expect(run.asked).toHaveLength(0);
    expect(allText(run.out)).toContain('[block moved at compaction: ');
    expect(run.out.messages[0].text).toBe(header);
    expect(allText(run.out).split(header).length).toBe(2);
    expect(allText(run.out)).toBe(allText(first.out));
  });

  it('the header of an earlier compaction, the whole generated row, is replaced by the new one', async () => {
    const earlier = [{ role: 'user', text: traceHeader('/earlier/dir'), toolUses: [] }, ...session(40, { said })];
    const run = await compactRun(BLOCKS, earlier);
    expect(run.out.messages[0].text).toBe(header);
    expect(allText(run.out)).not.toContain('/earlier/dir');
    expect(allText(run.out).split(HEADER_OPEN).length).toBe(2);
  });
});

describe('blocks of text: the stages that decide by fixed lengths (OMC_JEV_COMPACT_JEV_STAGES)', () => {
  const replies = { OMC_JEV_COMPACT_LONG_REPLIES: 'active', OMC_JEV_COMPACT_PASTES: 'active' };
  const longReply = (i) => `Step ${i} (ZERO) ${fill(`reply${i}`, 6000)}`;

  it('with the blocks active and the switch set, the stage of long replies does not run: the verdicts decide', async () => {
    const without = await compactRun({ ...BLOCKS, ...replies }, session(40, { said: longReply }));
    const withStages = await compactRun({ ...BLOCKS, ...replies, OMC_JEV_COMPACT_JEV_STAGES: 'active' }, session(40, { said: longReply }));
    expect(withStages.record.jev_stages).toEqual({ applied: true });
    expect(withStages.record.replies).toBeUndefined();
    expect(allText(withStages.out)).not.toContain(longReply(2));
    expect(withStages.record.blocks.moved).toBeGreaterThan(10);
    expect(without.record.jev_stages).toBeUndefined();
    expect(without.record.replies).toBeTruthy();
  });

  it('with the blocks switch off the option changes nothing and leaves no trace in the record; with shadow it says it was not applied', async () => {
    const off = await compactRun({ ...ACTIVE_ENV, ...replies }, session(40, { said: longReply }));
    for (const blocks of [undefined, 'off', 'bogus']) {
      const set = await compactRun({ ...ACTIVE_ENV, ...replies, ...(blocks === undefined ? {} : { OMC_JEV_COMPACT_BLOCKS: blocks }), OMC_JEV_COMPACT_JEV_STAGES: 'active' }, session(40, { said: longReply }));
      expect(set.record, String(blocks)).not.toHaveProperty('jev_stages');
      expect(Object.keys(set.record).sort(), String(blocks)).toEqual(Object.keys(off.record).sort());
      expect(set.record.replies).toBeTruthy();
      expect(JSON.stringify(set.out?.messages)).toBe(JSON.stringify(off.out?.messages));
    }
    const shadow = await compactRun({ ...ACTIVE_ENV, ...replies, OMC_JEV_COMPACT_BLOCKS: 'shadow', OMC_JEV_COMPACT_JEV_STAGES: 'active' }, session(40, { said: longReply }));
    expect(shadow.record.jev_stages).toEqual({ applied: false });
    expect(shadow.record.replies).toBeTruthy();
  });
});

describe('blocks of text: the verdicts asked before they are needed', () => {
  const OWN = { ...BLOCKS, OMC_JEV_COMPACT_AT_PERCENT: '60' };
  const waitFor = async (check) => { for (let k = 0; k < 200 && !check(); k++) await new Promise((resolve) => { setTimeout(resolve, 10); }); };

  async function turns(env, messages, count, tokens = 190000) {
    const fake = fakeDollar({ env, messages, api: apiOf(messages) });
    fake.$.session.usage = async (o) => ({ context: { tokens, window: 200000, ...(o?.breakdown ? { breakdown: { rawMaxTokens: 200000, autoCompactThreshold: 167000 } } : {}) } });
    const handlers = {};
    register((event, hook) => { handlers[event] = hook; });
    const compacts = [];
    fake.$.session.compact = async () => { compacts.push(true); return {}; };
    for (let k = 0; k < count; k++) await handlers['turn.complete'](fake.$, { isAborted: false }, async () => 'ok');
    return { ...fake, handlers, compacts };
  }

  it('the end of a turn asks about the blocks that lived a turn, in the background, and writes the verdict files; nothing is compacted', async () => {
    const run = await turns({ ...BLOCKS, OMC_JEV_COMPACT_AT_PERCENT: '95' }, session(40, { said }), 2, 20000);
    await waitFor(() => [...run.files()].some(([p]) => p.includes('/verdict-block-')));
    const verdicts = [...run.files()].filter(([p]) => p.includes('/verdict-block-'));
    expect(verdicts.length).toBeGreaterThan(8);
    expect(run.asked.length).toBe(verdicts.length);
    expect(run.compacts).toHaveLength(0);
    expect([...run.files()].filter(([p]) => p.endsWith('.txt'))).toHaveLength(0);
  });

  it('asks nothing in the background with the switch off, shadow of the point, or the verdicts off', async () => {
    for (const env of [{ ...ACTIVE_ENV }, { ...BLOCKS, OMC_JEV: 'compaction' }, { ...BLOCKS, OMC_JEV_COMPACT_VERDICTS: 'off' }]) {
      const run = await turns({ ...env, OMC_JEV_COMPACT_AT_PERCENT: '95' }, session(40, { said }), 2, 20000);
      await new Promise((resolve) => { setTimeout(resolve, 60); });
      expect(run.asked).toHaveLength(0);
    }
  });

  it('the module own request to compact finds the verdicts asked first, and says what came of it in a verdicts_fill record', async () => {
    const run = await turns(OWN, session(40, { said }), 1);
    const fill = run.records().find((r) => r.event === 'verdicts_fill');
    expect(run.compacts.length).toBe(1);
    expect(fill).toMatchObject({ rows: expect.any(Number), blocks: expect.any(Number), asked: expect.any(Number) });
    expect(fill.asked).toBeGreaterThan(8);
    expect([...run.files()].filter(([p]) => p.includes('/verdict-block-'))).toHaveLength(fill.asked);
  });
});
