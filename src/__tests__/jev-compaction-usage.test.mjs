/* global setTimeout */
/**
 * Tests of OMC_JEV_COMPACT_JEV_USAGE of hooks/jev-compaction.mjs: the usage and the model of every request to Jev in the records of the module.
 */

import { describe, expect, it } from 'vitest';

import { readConfig } from '../../hooks/jev-compaction.mjs';
import { ACTIVE_ENV, CASCADE, PASTES, assistantRow, compactOnce, compactRecord, fakeDollar, filler, hostUsage, jevAnswers, load, okResponse, outcomeOfScenario, ownerRow, para, pastedTag, scenarios, until, withRows, frozen, moduleCopy } from './jev-compaction-tail-harness.mjs';

const USAGE = { OMC_JEV_COMPACT_JEV_USAGE: '1' };
const SECOND_ROUND = { ...ACTIVE_ENV, OMC_JEV_COMPACT_BLOCKS: 'active', OMC_JEV_COMPACT_TARGET_PERCENT: '55' };

// Jev's double with a model and a usage on every answer; `cost(body)` adds a cost to the usage of an answer, `fail(body)` refuses a request, `extra` replaces fields of
// the answer. The scoring of the results is answered with 0.6 and a tie with 0.5 (a tie of equal levels needs results kept at a middling score).
const metered = ({ cost, fail, extra = {} } = {}) => {
  let n = 0;
  return (body) => {
    if (fail?.(body)) return { ok: false, status: 500, headers: {}, text: JSON.stringify({ error: 'refused' }) };
    const answers = body.state?.results ? Object.fromEntries(Object.keys(body.questions).map((q) => [q, { type: 'score', score: 0.6, confidence: 0.9 }])) : jevAnswers(body);
    const paid = cost?.(body);
    return okResponse({ answers, usage: { input_tokens: 100 + ++n, output_tokens: 7, ...(paid === undefined ? {} : { cost_usd: paid }) }, model: 'jev-x', ...extra });
  };
};
// Forty steps with a block of level 1, 2 or 3 in the text of each (a tie among the blocks of level 2) and a request of the user of level 2 before every eighth step.
const session = () => {
  const rows = [{ role: 'user', text: 'Task: look at the notes and report.' }];
  for (let i = 1; i <= 40; i++) {
    if (i % 8 === 0) rows.push(ownerRow(`Request ${i} (LV2) ${filler(`ask${i}`, 900)}`), assistantRow(`Answer to the message ${i}.`));
    rows.push({ role: 'assistant', text: `Step ${i} note (${['', 'LV1', 'LV2', 'LV3'][i % 4]}) ${filler(`detail${i}`, 900)}`, toolUses: [{ tool_use_id: `t${i}`, tool: 'Bash', input: { command: `cat notes-${i}.txt` } }] });
    rows.push({ role: 'user', text: '', toolResults: [{ tool_use_id: `t${i}`, text: `RESULT-${i} ${'x'.repeat(5000)}`, isError: false }] });
  }
  rows.push(ownerRow('Good, now sum up the results.'), assistantRow('Summary: done.'));
  return frozen(rows);
};
const high = hostUsage(190000);

describe('JEV_USAGE: the switch', () => {
  it('only 1 and active turn it on, from the settings too', async () => {
    const get = async (env, settingsEnv) => (await readConfig(fakeDollar({ env, settingsEnv }).$)).jevUsage;
    expect(await get(ACTIVE_ENV)).toBe(false);
    for (const value of ['1', 'active', ' active ']) expect(await get({ ...ACTIVE_ENV, OMC_JEV_COMPACT_JEV_USAGE: value }), value).toBe(true);
    for (const value of ['', '0', 'off', 'true', 'on', 'Active', 'shadow']) expect(await get({ ...ACTIVE_ENV, OMC_JEV_COMPACT_JEV_USAGE: value }), value).toBe(false);
    expect(await get(ACTIVE_ENV, USAGE)).toBe(true);
  });

  it.each(scenarios())('$name: unset and values outside the list give the same answer, records, requests and files, with no usage field', async (scenario) => {
    const unset = await outcomeOfScenario(scenario);
    for (const record of unset.records) {
      expect(record).not.toHaveProperty('jev_usage');
      expect(record).not.toHaveProperty('cost_basis');
    }
    for (const value of ['', '0', 'off', 'true', 'Active']) expect(await outcomeOfScenario(scenario, { OMC_JEV_COMPACT_JEV_USAGE: value }), value).toEqual(unset);
  });

  it('with the switch the requests, the answer to the host and the files are those of the switch off', async () => {
    const run = (extra) => compactOnce(session(), { env: { ...SECOND_ROUND, ...extra }, respond: metered(), usage: high });
    const off = await run({});
    const on = await run(USAGE);
    expect(on.out).toEqual(off.out);
    expect(on.calls.fetch.map((c) => c.body)).toEqual(off.calls.fetch.map((c) => c.body));
  });

});

describe('JEV_USAGE: every request to Jev has an entry', () => {
  it('records the model and the tokens of the scoring requests, parallel to jev_ms, with no cost', async () => {
    const run = await compactOnce(withRows([], 50), { env: { ...ACTIVE_ENV, ...USAGE }, respond: metered() });
    const record = compactRecord(run);
    expect(run.calls.fetch.length).toBeGreaterThan(1);
    expect(record.jev_usage).toHaveLength(run.calls.fetch.length);
    expect(record.jev_usage).toHaveLength(record.jev_ms.length);
    expect(record.jev_usage[0]).toEqual({ model: 'jev-x', input_tokens: expect.any(Number), output_tokens: 7, cost_usd: null });
    expect(new Set(record.jev_usage.map((entry) => entry.input_tokens)).size).toBe(record.jev_usage.length);
    expect(record.cost_basis).toBe('unknown');
  });

  it('the questions about blocks and about a tie follow the scoring entries, each with its purpose', async () => {
    const run = await compactOnce(session(), { env: { ...SECOND_ROUND, ...USAGE }, respond: metered(), usage: high });
    const record = compactRecord(run);
    const ties = run.calls.fetch.filter((c) => c.body.state?.items).length;
    expect(ties).toBeGreaterThan(0);
    expect(run.blockRequests().length).toBeGreaterThan(0);
    expect(record.jev_usage).toHaveLength(run.calls.fetch.length);
    expect(record.jev_ms.length).toBeGreaterThan(0);
    for (const entry of record.jev_usage.slice(0, record.jev_ms.length)) expect(entry).not.toHaveProperty('purpose');
    const purposes = record.jev_usage.slice(record.jev_ms.length).map((entry) => entry.purpose);
    expect(purposes.filter((p) => p === 'blocks')).toHaveLength(run.blockRequests().length);
    expect(purposes.filter((p) => p === 'second_round')).toHaveLength(ties);
    expect(purposes).toHaveLength(run.blockRequests().length + ties);
  });

  it('the question about a pasted tag adds an entry with the purpose pastes', async () => {
    const rows = [ownerRow(`Please check the report below.\n\n${pastedTag(filler('alpha', 3000))}\n\nThanks.`), ownerRow('Next.')];
    const run = await compactOnce(withRows(rows), { env: { ...ACTIVE_ENV, ...USAGE, OMC_JEV_COMPACT_PASTES: 'active' }, respond: metered() });
    expect(run.calls.fetch.filter((c) => c.body.questions.pasted)).toHaveLength(1);
    expect(compactRecord(run).jev_usage.map((entry) => entry.purpose)).toEqual([undefined, 'pastes']);
  });

  it.each([
    ['a question about a block', (body) => Boolean(body.state?.blocks)],
    ['the scoring of the results', (body) => Boolean(body.state?.results)],
    ['a question about a tie', (body) => Boolean(body.state?.items)],
  ])('an answer with a cost makes the cost basis reported, when only %s carries it', async (_label, carries) => {
    const run = await compactOnce(session(), { env: { ...SECOND_ROUND, ...USAGE }, respond: metered({ cost: (body) => (carries(body) ? 0.002 : undefined) }), usage: high });
    expect(run.calls.fetch.some((c) => carries(c.body))).toBe(true);
    expect(compactRecord(run).cost_basis).toBe('reported');
    for (const entry of compactRecord(run).jev_usage) expect(entry.cost_usd).toBeNull();
  });

  it('a request that failed counts too: its entry has no data (null), never 0', async () => {
    const run = await compactOnce(session(), { env: { ...SECOND_ROUND, ...USAGE }, respond: metered({ fail: (body) => Boolean(body.state?.blocks) }), usage: high });
    const asked = run.blockRequests().length;
    expect(asked).toBeGreaterThan(0);
    const failed = compactRecord(run).jev_usage.filter((entry) => entry.purpose === 'blocks');
    expect(failed).toHaveLength(asked);
    for (const entry of failed) expect(entry).toEqual({ model: null, input_tokens: null, output_tokens: null, cost_usd: null, purpose: 'blocks' });
  });

  it.each([
    ['no usage', undefined],
    ['a negative count', { input_tokens: -1, output_tokens: 3 }],
    ['a count that is text', { input_tokens: '11', output_tokens: 3 }],
    ['one count only', { input_tokens: 11 }],
    ['a list', [11, 3]],
  ])('%s is no data', async (_label, usage) => {
    const run = await compactOnce(withRows([]), { env: { ...ACTIVE_ENV, ...USAGE }, respond: metered({ extra: { usage } }) });
    expect(compactRecord(run).jev_usage[0]).toEqual({ model: 'jev-x', input_tokens: null, output_tokens: null, cost_usd: null });
  });
});

describe('JEV_USAGE: the model name is text of the server', () => {
  const modelOf = async (model) => {
    const run = await compactOnce(withRows([]), { env: { ...ACTIVE_ENV, ...USAGE }, respond: metered({ extra: { model } }) });
    return compactRecord(run).jev_usage[0].model;
  };

  it('is cut to 100 characters on one line', async () => {
    const model = await modelOf(`jev\n${'m '.repeat(500)}`);
    expect(model).toHaveLength(100);
    expect(model.startsWith('jev m m')).toBe(true);
    expect(model).not.toContain('\n');
  });

  it('goes through the mask before it is cut, a secret across the cut included', async () => {
    const token = `ghp_${'A1b2C3d4'.repeat(5)}`;
    expect(await modelOf(`model ${token}`)).not.toContain(token.slice(4, 20));
    const across = await modelOf(`${'m '.repeat(42)}${token}`);
    expect(across).not.toContain('A1b2C3d4');
    expect(across.length).toBeLessThanOrEqual(100);
  });

  it('goes through the mask of a series too, which knows keys the shared mask leaves', async () => {
    // Made-up keys, put together here, too short for the rule of the shared mask on long strings.
    for (const parts of [['gsk_', 'AbCdEfGh', '12345678', 'IjKlMnOp'], ['xai-', 'AbCdEfGh', '12345678', 'IjKlMn'], ['ASIA', 'QWER5TYU', 'IOP7ASDF']]) {
      const key = parts.join('');
      const model = await modelOf(`served by ${key}`);
      expect(model, parts[0]).not.toContain(parts[1]);
      expect(model, parts[0]).toContain('served by ');
    }
  });

  it('is null when the answer names none or something that is no text', async () => {
    for (const model of [undefined, 7, { name: 'x' }, null]) expect(await modelOf(model), String(JSON.stringify(model))).toBeNull();
  });
});

describe('JEV_USAGE: the passes that fill the verdicts', () => {
  const blocks = [para('pi', 700, 'LV1'), para('tau', 700, 'LV3'), para('rho', 700)].join('\n\n');
  const messages = () => withRows([ownerRow(blocks)], 30, { chars: 4000 });
  const env = { ...ACTIVE_ENV, OMC_JEV_COMPACT_BLOCKS: 'active' };
  const turnEnd = (handlers, fake) => handlers['turn.complete'](fake.$, Object.freeze({}), async () => ({}));
  // The pass in the background runs with the configuration an earlier turn read, so from the second turn on.
  const twoTurns = async (fake) => { const handlers = load(); await turnEnd(handlers, fake); await turnEnd(handlers, fake); };

  it('the pass before the own request puts what its questions used into its record', async () => {
    const fake = fakeDollar({ env: { ...env, ...USAGE, OMC_JEV_COMPACT_AT_PERCENT: '50', ...CASCADE }, messages: messages(), usage: hostUsage(150000), respond: metered() });
    await turnEnd(load(), fake);
    const fill = fake.records().find((r) => r.event === 'verdicts_fill');
    expect(fake.blockRequests().length).toBeGreaterThan(0);
    expect(fill.jev_usage).toEqual(fake.blockRequests().map(() => ({ model: 'jev-x', input_tokens: expect.any(Number), output_tokens: 7, cost_usd: null, purpose: 'blocks' })));
    expect(fill.cost_basis).toBe('unknown');
  });

  it('a pass in the background that asked writes a record of its own; with the switch off it writes none', async () => {
    const on = fakeDollar({ env: { ...env, ...USAGE }, messages: messages(), respond: metered() });
    await twoTurns(on);
    expect(await until(() => on.records().some((r) => r.event === 'verdicts_fill'))).toBe(true);
    const fill = on.records().find((r) => r.event === 'verdicts_fill');
    expect(fill).toMatchObject({ point: 'compaction', background: true, session_id: 'sess-1', agent_id: null, asked: 3 });
    expect(fill.jev_usage).toHaveLength(on.blockRequests().length);
    expect(fill.jev_usage[0]).toMatchObject({ model: 'jev-x', purpose: 'blocks' });
    const off = fakeDollar({ env, messages: messages(), respond: metered() });
    await twoTurns(off);
    expect(await until(() => [...off.files.keys()].filter((p) => p.includes('/verdict-block-')).length === 3)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(off.records()).toEqual([]);
  });

  it('a pass in the background that asks nothing writes no record, also with the switch', async () => {
    const fake = fakeDollar({ env: { ...env, ...USAGE }, messages: withRows([]), respond: metered() });
    await twoTurns(fake);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.blockRequests()).toHaveLength(0);
    expect(fake.records()).toEqual([]);
  });
});

describe('JEV_USAGE: the exception path (the entries of the requests still open)', () => {
  // In this module no natural exception can fire with a request in flight (the harness comment of moduleCopy names the reasons), so each throw is injected
  // into a copy of the module at an anchored line, which must match exactly once. Without the fix the record is written before the entries of the requests
  // that went out are added, so every test here fails on the base module.
  const slowMetered = ({ kinds = [], ms = 60 } = {}) => {
    let n = 0;
    return async (body) => {
      const answers = body.state?.results ? Object.fromEntries(Object.keys(body.questions).map((q) => [q, { type: 'score', score: 0.6, confidence: 0.9 }])) : jevAnswers(body);
      const payload = okResponse({ answers, usage: { input_tokens: 100 + ++n, output_tokens: 7 }, model: 'jev-x' });
      if (kinds.includes('scoring') && body.state?.results) await new Promise((resolve) => setTimeout(resolve, ms));
      if (kinds.includes('pastes') && body.questions?.pasted) await new Promise((resolve) => setTimeout(resolve, ms));
      if (kinds.includes('blocks') && body.state?.blocks) await new Promise((resolve) => setTimeout(resolve, ms));
      if (kinds.includes('ties') && body.state?.items) await new Promise((resolve) => setTimeout(resolve, ms));
      return payload;
    };
  };

  // The scoring loop throws while building the second batch: the first one is still open, the drain waits for its answer.
  it('an exception while the second batch is being built keeps the entry of the first, still open', async () => {
    const mod = await moduleCopy(
      'for (let b = 0; b * BATCH < asked.length; b++) {',
      "\n    if (b === 1) throw new Error('injected: the second batch never went out');",
    );
    const run = await compactOnce(withRows([], 60), { env: { ...ACTIVE_ENV, ...USAGE }, mod, respond: slowMetered({ kinds: ['scoring'], ms: 40 }) });
    const record = compactRecord(run);
    expect(record.reason).toBe('exception');
    expect(record.jev_usage).toHaveLength(1);
    expect(record.jev_usage[0]).toEqual({ model: 'jev-x', input_tokens: 101, output_tokens: 7, cost_usd: null });
    expect(record.jev_ms).toHaveLength(1);
  });

  // The scoring entries are added in one step after every answer is collected; a throw at that point keeps all of them, in batch order.
  it('an exception after the answers are collected but before the entries are added keeps all of them, in batch order', async () => {
    const mod = await moduleCopy(
      'record.jev_ms = results.map((r) => r.ms);',
      "  throw new Error('injected: the answers are in, the entries are not added');",
      true,
    );
    const run = await compactOnce(withRows([], 60), { env: { ...ACTIVE_ENV, ...USAGE }, mod, respond: slowMetered() });
    const record = compactRecord(run);
    expect(record.reason).toBe('exception');
    expect(record.jev_usage).toHaveLength(run.calls.fetch.length);
    expect(record.jev_ms).toHaveLength(run.calls.fetch.length);
    expect(record.jev_usage.map((entry) => entry.input_tokens)).toEqual([101, 102]);
    expect(record.jev_usage[1]).not.toHaveProperty('purpose');
  });

  // The paste question goes out next to the scoring requests; a throw before the answers are collected keeps its entry too, with real usage of the
  // answer that arrived after the throw.
  it('an exception with a paste question still open keeps its entry with the purpose pastes', async () => {
    const mod = await moduleCopy(
      'const [results, , blockAsked] = await Promise.all([Promise.all(runs), pasted?.asks, blocksAsk]);',
      "  await new Promise((resolve) => setTimeout(resolve, 20)); throw new Error('injected: the paste answer is still open');",
      true,
    );
    const rows = [ownerRow(`Please check the report below.\n\n${pastedTag(filler('alpha', 3000))}\n\nThanks.`), ownerRow('Next.')];
    const run = await compactOnce(withRows(rows), { env: { ...ACTIVE_ENV, ...USAGE, OMC_JEV_COMPACT_PASTES: 'active' }, mod, respond: slowMetered({ kinds: ['pastes'], ms: 60 }) });
    const record = compactRecord(run);
    const pastes = run.calls.fetch.filter((c) => c.body.questions?.pasted).length;
    expect(pastes).toBe(1);
    expect(record.reason).toBe('exception');
    expect(record.jev_usage).toHaveLength(run.calls.fetch.length);
    expect(record.jev_usage.filter((entry) => entry.purpose === 'pastes')).toHaveLength(pastes);
    expect(record.jev_usage.find((entry) => entry.purpose === 'pastes').input_tokens).not.toBeNull();
  });

  // The questions about blocks go out next to the scoring requests; a throw before the answers are collected keeps their entries, each with its purpose.
  it('an exception with block questions still open keeps their entries with the purpose blocks', async () => {
    const mod = await moduleCopy(
      'const [results, , blockAsked] = await Promise.all([Promise.all(runs), pasted?.asks, blocksAsk]);',
      "  await new Promise((resolve) => setTimeout(resolve, 20)); throw new Error('injected: the block answers are still open');",
      true,
    );
    const run = await compactOnce(session(), { env: { ...SECOND_ROUND, ...USAGE }, mod, respond: slowMetered({ kinds: ['blocks'], ms: 60 }), usage: high });
    const record = compactRecord(run);
    const blocks = run.blockRequests().length;
    expect(blocks).toBeGreaterThan(0);
    expect(record.reason).toBe('exception');
    expect(record.jev_usage).toHaveLength(run.calls.fetch.length);
    expect(record.jev_usage.filter((entry) => entry.purpose === 'blocks')).toHaveLength(blocks);
    expect(record.jev_usage.filter((entry) => entry.purpose === 'blocks').every((entry) => entry.input_tokens !== null)).toBe(true);
    expect(record.jev_ms).toHaveLength(run.calls.fetch.length - blocks);
  });

  // The questions of the second round are answered one by one; a worker that throws before its entry is added leaves the entries of the requests still
  // open missing, but the decision goes on as before (the round catches the error).
  it('an exception in the second round keeps the entries of the requests still open, the decision unchanged', async () => {
    const mod = await moduleCopy(
      "noteJevUsage(cfg, 'second_round', r);",
      "      throw new Error('injected: the tie answers are still open');",
      true,
    );
    const run = await compactOnce(session(), { env: { ...SECOND_ROUND, ...USAGE }, mod, respond: slowMetered({ kinds: ['ties'], ms: 50 }), usage: high });
    const record = compactRecord(run);
    const ties = run.calls.fetch.filter((c) => c.body.state?.items).length;
    expect(ties).toBeGreaterThan(0);
    expect(record.result).toBe('jev');
    expect(record.jev_usage).toHaveLength(run.calls.fetch.length);
    expect(record.jev_usage.filter((entry) => entry.purpose === 'second_round')).toHaveLength(ties);
    expect(record.jev_usage.filter((entry) => entry.purpose === 'second_round').every((entry) => entry.input_tokens !== null)).toBe(true);
  });

  // Without the usage switch the exception changes nothing: no entry is added, no record gains a field, and the answer and the requests are the ones of
  // the same run with the switch (the drain adds record fields only).
  it('without the switch an exception adds no field and changes nothing in the answer or the requests', async () => {
    const mod = await moduleCopy(
      'const [results, , blockAsked] = await Promise.all([Promise.all(runs), pasted?.asks, blocksAsk]);',
      "  await new Promise((resolve) => setTimeout(resolve, 20)); throw new Error('injected: the paste answer is still open');",
      true,
    );
    const rows = [ownerRow(`Please check the report below.\n\n${pastedTag(filler('alpha', 3000))}\n\nThanks.`), ownerRow('Next.')];
    const run = (extra) => compactOnce(withRows(rows), { env: { ...ACTIVE_ENV, OMC_JEV_COMPACT_PASTES: 'active', ...extra }, mod, respond: slowMetered({ kinds: ['pastes'], ms: 60 }) });
    const off = await run({});
    const on = await run(USAGE);
    expect(compactRecord(off)).not.toHaveProperty('jev_usage');
    expect(compactRecord(off)).not.toHaveProperty('cost_basis');
    expect(on.out).toEqual(off.out);
    expect(on.calls.fetch.map((c) => c.body)).toEqual(off.calls.fetch.map((c) => c.body));
  });

  // A pass in the background: a worker that throws before its entry is added leaves the entries of the requests still open missing; the pass still
  // writes its verdicts_fill record with them.
  it('a pass in the background keeps the entries of the requests still open in its verdicts_fill record', async () => {
    const mod = await moduleCopy(
      "noteJevUsage(cfg, 'blocks', r);",
      "      throw new Error('injected: the block answers are still open');",
      true,
    );
    const blocksText = [para('pi', 700, 'LV1'), para('tau', 700, 'LV3'), para('rho', 700)].join('\n\n');
    const messages = () => withRows([ownerRow(blocksText)], 30, { chars: 4000 });
    const bgEnv = { ...ACTIVE_ENV, OMC_JEV_COMPACT_BLOCKS: 'active' };
    const turnEnd = (handlers, fake) => handlers['turn.complete'](fake.$, Object.freeze({}), async () => ({}));
    const twoTurns = async (fake) => { const handlers = load(mod); await turnEnd(handlers, fake); await turnEnd(handlers, fake); };
    const fake = fakeDollar({ env: { ...bgEnv, ...USAGE }, messages: messages(), respond: slowMetered({ kinds: ['blocks'], ms: 40 }), usage: hostUsage(150000) });
    await twoTurns(fake);
    expect(await until(() => fake.records().some((r) => r.event === 'verdicts_fill'))).toBe(true);
    const fill = fake.records().find((r) => r.event === 'verdicts_fill');
    const blocks = fake.blockRequests().length;
    expect(blocks).toBeGreaterThan(0);
    expect(fill.jev_usage).toHaveLength(blocks);
    expect(fill.jev_usage.every((entry) => entry.purpose === 'blocks')).toBe(true);
    expect(fill.jev_usage.every((entry) => entry.input_tokens !== null)).toBe(true);
  });

  // The decision is repeated (the owner tail, the floor over the bound with the first boundary): the entries of the given up decisions stay marked
  // `abandoned`, and the entries of the final decision, whose requests are still open at the throw, join without the mark.
  const TAIL_ENV = { ...ACTIVE_ENV, OMC_JEV_COMPACT_BLOCKS: 'active', OMC_JEV_COMPACT_JEV_STAGES: 'active', OMC_JEV_COMPACT_TAIL_BY_LOOP: 'active', OMC_JEV_COMPACT_OWNER_TAIL: 'active' };
  const cross = (text) => `<cross-session-message from="track-1">${text}</cross-session-message>`;
  const ending = (rows) => {
    const base = withRows([], 30, { chars: 4000 });
    return frozen([...base.slice(0, -2), ...rows]);
  };

  it('an exception in a repeated decision keeps the entries of the final decision and the given up ones marked abandoned', async () => {
    const mod = await moduleCopy(
      'const [results, , blockAsked] = await Promise.all([Promise.all(runs), pasted?.asks, blocksAsk]);',
      "  if (cfg.ownerTailDemote === 1) { await new Promise((resolve) => setTimeout(resolve, 20)); throw new Error('injected: the answers of the final decision are still open'); }",
      true,
    );
    const old = Array.from({ length: 24 }, (_, k) => para(`old${k}`, 3000)).join('\n\n');
    const replyA = para('omega', 60000);
    const replyB = para('psi', 30000);
    const rows = [ownerRow(old), assistantRow('Noted.'), ownerRow('Q small'), assistantRow(replyA), ownerRow(cross('done')), assistantRow(replyB)];
    const run = await compactOnce(ending(rows), {
      env: { ...TAIL_ENV, ...CASCADE, ...USAGE },
      mod,
      usage: hostUsage(190000),
      respond: slowMetered(),
      failWrite: (p) => p.startsWith(PASTES) && p.endsWith('.txt'),
    }, { trigger: 'manual' });
    const record = compactRecord(run);
    const given = record.jev_usage.filter((entry) => entry.abandoned);
    expect(given.length).toBeGreaterThan(0);
    expect(record.reason).toBe('exception');
    expect(record.jev_usage).toHaveLength(run.calls.fetch.length);
    expect(record.jev_usage.slice(-given.length)).toEqual(given);
    expect(record.jev_usage.slice(0, record.jev_ms?.length ?? 0).some((entry) => entry.abandoned)).toBe(false);
  });
});
