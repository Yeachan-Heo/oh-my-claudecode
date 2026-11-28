/* global setTimeout */
/**
 * Tests of OMC_JEV_COMPACT_JEV_USAGE of hooks/jev-compaction.mjs: the usage and the model of every request to Jev in the records of the module.
 */

import { describe, expect, it } from 'vitest';

import { readConfig } from '../../hooks/jev-compaction.mjs';
import { ACTIVE_ENV, CASCADE, assistantRow, compactOnce, compactRecord, fakeDollar, filler, hostUsage, jevAnswers, load, okResponse, outcomeOfScenario, ownerRow, para, pastedTag, scenarios, until, withRows, frozen } from './jev-compaction-tail-harness.mjs';

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
