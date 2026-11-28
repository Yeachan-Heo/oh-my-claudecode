/* global setTimeout */
/**
 * Tests of OMC_JEV_COMPACT_OWNER_TAIL (and its CROSS_SESSION, AGENTS and OVERFLOW options) of hooks/jev-compaction.mjs: the newest message of the user and the text of
 * the answers after it stay word for word in any compaction. The only fake of the Jev side is the stub of $.http.fetch (the level of a block is the marker LV3, LV2 or
 * LV1 in its text, none is level 0).
 */

import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import * as mod from '../../hooks/jev-compaction.mjs';
import { ACTIVE_ENV, CASCADE, PASTES, agentRow, apiOf, assistantRow, compactOnce, compactRecord, conversation, fakeDollar, filler, frozen, hostUsage, jevAnswers, load, okResponse, outcomeOfScenario, ownerRow, para, pastedTag, scenarios, textsOf, until, withRows } from './jev-compaction-tail-harness.mjs';

const { OWNER_TAIL_SKIP, isOwnerTailRow, listTokens, ownerTailProtected, ownerTailTiers, ownerTailViolations, readConfig, seriesContext, seriesItems } = mod;
const RATE_SIG_OF_TEST = 0.2575; // the rate of one character of thinking, a signature or redacted data
const STAGES = { ...ACTIVE_ENV, OMC_JEV_COMPACT_BLOCKS: 'active', OMC_JEV_COMPACT_JEV_STAGES: 'active', OMC_JEV_COMPACT_TAIL_BY_LOOP: 'active' };
const SWITCH = { OMC_JEV_COMPACT_OWNER_TAIL: 'active' };
const ON = { ...STAGES, ...SWITCH };
const OPTIONS_SET = { OMC_JEV_COMPACT_OWNER_TAIL_CROSS_SESSION: 'on', OMC_JEV_COMPACT_OWNER_TAIL_AGENTS: 'active', OMC_JEV_COMPACT_OWNER_TAIL_OVERFLOW: 'keep' };
const CROSS = (text) => `<cross-session-message from="track-1">${text}</cross-session-message>`;

const pathOf = (text) => `${PASTES}/${createHash('sha256').update(text).digest('hex').slice(0, 32)}.txt`;
const movedFiles = (run) => [...run.files.keys()].filter((p) => p.startsWith(`${PASTES}/`) && p.endsWith('.txt'));
const textWith = (run, part) => run.out.messages.find((m) => typeof m.text === 'string' && m.text.includes(part))?.text;
// `rows` after the last result of `n` call/result pairs: the conversation ends with a closed loop.
const ending = (rows, n = 30, options) => frozen([...conversation(n, options).slice(0, -2), ...rows]);
const cfgOf = (env) => readConfig(fakeDollar({ env }).$);
const turnEnd = (fake) => load()['turn.complete'](fake.$, Object.freeze({}), async () => ({}));

describe('OWNER_TAIL: the switch and its options', () => {
  const get = async (extra) => { const c = await cfgOf({ ...ACTIVE_ENV, ...extra }); return [c.ownerTail, c.ownerTailCrossSession, c.ownerTailAgents, c.ownerTailOverflow]; };

  it('only active turns the switch on; cross session is fallback unless on or off (any case); agents only with active; overflow keep or the old boundary', async () => {
    expect(await get({})).toEqual([false, 'fallback', false, 'revert']);
    expect(await get({ OMC_JEV_COMPACT_OWNER_TAIL: 'active', OMC_JEV_COMPACT_OWNER_TAIL_CROSS_SESSION: 'ON', OMC_JEV_COMPACT_OWNER_TAIL_AGENTS: 'active', OMC_JEV_COMPACT_OWNER_TAIL_OVERFLOW: 'keep' })).toEqual([true, 'on', true, 'keep']);
    expect(await get({ OMC_JEV_COMPACT_OWNER_TAIL_CROSS_SESSION: ' Off ' })).toEqual([false, 'off', false, 'revert']);
    for (const value of ['1', 'true', 'on', 'Active', 'activ', '']) expect((await get({ OMC_JEV_COMPACT_OWNER_TAIL: value }))[0], value).toBe(false);
    for (const value of ['', 'maybe', '1', 'fallback']) expect((await get({ OMC_JEV_COMPACT_OWNER_TAIL_CROSS_SESSION: value }))[1], value).toBe('fallback');
    for (const value of ['', '1', 'on', 'true', 'Active']) expect((await get({ OMC_JEV_COMPACT_OWNER_TAIL_AGENTS: value }))[2], value).toBe(false);
    for (const value of ['', '1', 'yes', 'Keep', 'revert']) expect((await get({ OMC_JEV_COMPACT_OWNER_TAIL_OVERFLOW: value }))[3], value).toBe('revert');
  });

  it('the options are read from the settings too', async () => {
    const fake = fakeDollar({ env: ACTIVE_ENV, settingsEnv: { ...SWITCH, ...OPTIONS_SET } });
    const c = await readConfig(fake.$);
    expect([c.ownerTail, c.ownerTailCrossSession, c.ownerTailAgents, c.ownerTailOverflow]).toEqual([true, 'on', true, 'keep']);
  });

  it.each(scenarios())('$name: unset and values outside the list give the same answer, records, requests and files, also with every option set', async (scenario) => {
    const unset = await outcomeOfScenario(scenario);
    for (const record of unset.records) for (const key of ['owner_tail', 'owner_tail_applied', 'owner_tail_tier']) expect(record).not.toHaveProperty(key);
    expect(await outcomeOfScenario(scenario, OPTIONS_SET), 'the options alone').toEqual(unset);
    for (const value of ['', '0', '1', 'true', 'on', 'Active']) expect(await outcomeOfScenario(scenario, { ...OPTIONS_SET, OMC_JEV_COMPACT_OWNER_TAIL: value }), value).toEqual(unset);
  });

  it.each(Object.keys(OPTIONS_SET))('%s: with the switch on, a value outside its list is the same as no value', async (name) => {
    const rows = [ownerRow('Q small'), assistantRow(para('omega', 420000)), ownerRow(CROSS('done')), assistantRow('ok')];
    const run = async (extra) => {
      const out = await compactOnce(ending(rows), { env: { ...ON, ...CASCADE, ...extra }, usage: hostUsage(150000) }, { trigger: 'manual' });
      return { out: out.out, tail: compactRecord(out).owner_tail, requests: out.calls.fetch.length };
    };
    const plain = await run({});
    for (const value of ['', 'x', 'yes', '1']) expect(await run({ [name]: value }), value).toEqual(plain);
  });
});

describe('OWNER_TAIL: what is protected', () => {
  // A closed loop: after the newest message of the user the model answered; the older conversation holds blocks too. The blocks of an answer are long enough for the
  // trace of a direct reply (its first and last 120 characters) to be shorter than the text.
  const QUESTION = [para('alpha', 700), para('beta', 700)].join('\n\n');
  const ANSWER = [para('gamma', 1500), para('delta', 1500)].join('\n\n');
  const OLD = [para('epsilon', 700), para('zeta', 700)].join('\n\n');
  const withOld = () => frozen([...conversation(30).slice(0, 1), ownerRow(OLD), assistantRow('Noted.'), ...conversation(30).slice(1, -2), ownerRow(QUESTION), assistantRow(ANSWER)]);

  it('the blocks of the newest message and of the answer stay word for word and Jev is not asked about them; older rows still go', async () => {
    const off = await compactOnce(withOld(), { env: STAGES });
    expect(textsOf(off)).not.toContain(para('alpha', 700));
    expect(textsOf(off)).not.toContain(para('gamma', 1500));
    const on = await compactOnce(withOld(), { env: ON });
    expect(textWith(on, 'alpha')).toBe(QUESTION);
    expect(textWith(on, 'gamma')).toBe(ANSWER);
    expect(textsOf(on)).not.toContain(para('epsilon', 700));
    expect(movedFiles(on)).toEqual([pathOf(OLD)]); // neighbouring blocks of one verdict are one trace and one file
    expect(on.blockRequests().flatMap((c) => Object.values(c.body.state.blocks).map((b) => b.text))).not.toContain(para('alpha', 700));
    const record = compactRecord(on);
    expect(record).toMatchObject({ result: 'jev', owner_tail_applied: true, owner_tail_tier: 0, owner_tail: { boundary: 'owner', overflow: false, violations: 0, protected_rows: 2, goal_yielded: false, rows: 2 } });
    expect(record.owner_tail.from_idx).toBe(withOld().length - 2);
    expect(record.owner_tail.tokens).toBeGreaterThan(1000);
    expect(JSON.stringify(record)).not.toContain('alpha');
  });

  it('the text of the answers stays when the answer is several rows around calls; the calls and results after the message are compacted', async () => {
    const [a1, a2] = [para('eta', 1500), para('theta', 1500)];
    const messages = frozen([
      ...conversation(30).slice(0, -2),
      ownerRow('Please do the work.'),
      { role: 'assistant', text: a1, toolUses: [{ tool_use_id: 'z1', tool: 'Bash', input: { command: 'ls' } }] },
      { role: 'user', text: '', toolResults: [{ tool_use_id: 'z1', text: `RESULT-Z ${'x'.repeat(3000)}`, isError: false }] },
      assistantRow(a2),
    ]);
    const on = await compactOnce(messages, { env: { ...ON, ...CASCADE } });
    expect(textsOf(on)).toContain(a1);
    expect(textsOf(on)).toContain(a2);
    expect(JSON.stringify(on.out.messages)).not.toContain('RESULT-Z');
    expect(compactRecord(on).owner_tail).toMatchObject({ protected_rows: 3, boundary: 'owner', violations: 0 });
    const off = await compactOnce(messages, { env: STAGES });
    expect(textsOf(off)).not.toContain(a1);
    expect(textsOf(off)).not.toContain(a2);
  });

  it('in the middle of a tool loop the open loop keeps its handles and the text of the turn before it stays', async () => {
    const a1 = para('iota', 1500);
    const messages = frozen([
      ...conversation(30).slice(0, -2),
      ownerRow('Work on it.'),
      { role: 'assistant', text: a1, toolUses: [{ tool_use_id: 'z1', tool: 'Bash', input: { command: 'ls' } }] },
      { role: 'user', text: '', toolResults: [{ tool_use_id: 'z1', text: `RESULT-Z ${'x'.repeat(3000)}`, isError: false }] },
      { role: 'assistant', text: 'Now the call.', toolUses: [{ tool_use_id: 'open', tool: 'Bash', input: { command: 'ls' } }] },
    ]);
    const on = await compactOnce(messages, { env: ON });
    expect(textsOf(on)).toContain(a1);
    expect(compactRecord(on)).toMatchObject({ result: 'jev', kept_from: 1, owner_tail_applied: true });
    expect(on.out.messages.at(-1).handle).toBe(`h${messages.length - 1}`);
    expect(textsOf(await compactOnce(messages, { env: STAGES }))).not.toContain(a1);
  });
});

describe('OWNER_TAIL: the stages that rewrite rows leave the protected rows alone', () => {
  // A message the user typed during a tool turn, in the envelope of the host.
  const steered = (words) => `<system-reminder>\nThe user sent a new message while you were working:\n${words}\n\nIMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.\n</system-reminder>`;
  const unchanged = (run, text) => {
    expect(compactRecord(run)).toMatchObject({ result: 'jev', owner_tail_applied: true, owner_tail: { violations: 0 } });
    expect(textsOf(run)).toContain(text);
  };

  it('a pasted tag of the newest message of the user is not moved, though a later row with results carries a message of the user', async () => {
    const message = `Please check this.\n\n${pastedTag(filler('alpha', 2500))}\n\nThanks for it.`;
    const messages = ending([
      ownerRow(message), { role: 'assistant', text: 'Reading.', toolUses: [{ tool_use_id: 'z1', tool: 'Bash', input: { command: 'ls' } }] },
      { role: 'user', text: steered('and the log too'), toolResults: [{ tool_use_id: 'z1', text: 'listing', isError: false }] },
      assistantRow('Done.'),
    ]);
    const env = { ...ACTIVE_ENV, OMC_JEV_COMPACT_TAIL_BY_LOOP: 'active', OMC_JEV_COMPACT_PASTES: 'active' };
    expect(textsOf(await compactOnce(messages, { env }))).not.toContain(message);
    const on = await compactOnce(messages, { env: { ...env, ...SWITCH } });
    unchanged(on, message);
    expect(on.calls.fetch.filter((c) => c.body.questions.pasted)).toHaveLength(0);
  });

  it('a long reply after the newest message of the user is not moved, though messages typed during tool turns and later rows push the limit of the replies past it', async () => {
    const reply = para('kappa', 3000);
    const call = (id) => ({ role: 'assistant', text: 'Working.', toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command: 'ls' } }] });
    const result = (id) => ({ role: 'user', text: '', toolResults: [{ tool_use_id: id, text: 'listing', isError: false }] });
    const rows = [ownerRow('Please start.'), assistantRow('First.'), assistantRow(reply), assistantRow('Last of the first answer.')];
    for (let k = 1; k <= 6; k++) rows.push(call(`q${k}`), result(`q${k}`), { role: 'user', text: `Stop hook feedback: continue ${k}` }, assistantRow(`Continuing ${k}.`));
    const messages = ending(rows);
    // The API form also holds what the user typed during the tool turns q1 to q3, which no row shows.
    const api = apiOf(messages);
    for (const id of ['q1', 'q2', 'q3']) {
      const at = api.findIndex((a) => a.content.some((b) => b.type === 'tool_result' && b.tool_use_id === id));
      api[at].content.push({ type: 'text', text: steered(`steer ${id}`) });
    }
    const env = { ...ACTIVE_ENV, OMC_JEV_COMPACT_TAIL_BY_LOOP: 'active', OMC_JEV_COMPACT_LONG_REPLIES: 'active' };
    const off = await compactOnce(messages, { env, api });
    expect(compactRecord(off).replies.moved).toBe(1);
    const on = await compactOnce(messages, { env: { ...env, ...SWITCH }, api });
    unchanged(on, reply);
    expect(compactRecord(on).replies.moved).toBe(0);
  });

  it('the agent trim leaves the protected message of another session as it is, while it trims the reports around it', async () => {
    const cross = CROSS('{"type":"idle_notification","from":"track-1","idleReason":"available"}');
    const rows = [ownerRow(cross), assistantRow('Noted.')];
    for (let k = 0; k < 7; k++) rows.push(ownerRow(agentRow(`worker-${k}`, `Report ${k}: ${filler('tests passed.', 600)}`)), assistantRow(`Read ${k}.`));
    const messages = ending(rows);
    const env = { ...ACTIVE_ENV, OMC_JEV_COMPACT_TAIL_BY_LOOP: 'active', OMC_JEV_COMPACT_AGENT_TRIM: 'active', OMC_JEV_COMPACT_OWNER_TAIL_CROSS_SESSION: 'on' };
    const on = await compactOnce(messages, { env: { ...env, ...SWITCH } });
    unchanged(on, cross);
    expect(compactRecord(on).agent_trim.rows).toBeGreaterThan(0);
    expect(compactRecord(on).owner_tail.boundary).toBe('cross_session');
  });

  it('a protected row is no place for a series: seriesContext fixes it and its traces give no item', async () => {
    const cfg = await cfgOf(ON);
    const traces = [1, 2, 3].map((n) => `[compacted] Read(file-${n}.txt) - result of ${1000 + n} chars removed`).join('\n');
    const rows = frozen([ownerRow('Task.'), assistantRow('First.'), assistantRow(`Findings.\n${traces}`), assistantRow('Last.'), ...Array.from({ length: 10 }, (_, k) => (k % 2 ? assistantRow(`tail ${k}`) : ownerRow(`tail ${k}`)))]);
    const series = (extra) => {
      const c = { ...cfg, ...extra };
      const ctx = seriesContext(c, rows, apiOf(rows), rows.length);
      return { ctx, items: seriesItems(c, rows, ctx, 'sess-1') };
    };
    expect(series({}).ctx.fixed.has(2)).toBe(false);
    expect(series({}).items).toHaveLength(1);
    expect(series({ ownerProtected: new Set([2]) }).ctx.fixed.has(2)).toBe(true);
    expect(series({ ownerProtected: new Set([2]) }).items).toHaveLength(0);
  });
});

describe('OWNER_TAIL: the goal, the overflow and the boundaries', () => {
  const big = (chars) => para('omega', chars);
  const go = (rows, env, tokens, event, n = 30, chars = 3000) => compactOnce(ending(rows, n, { chars }), { env: { ...ON, ...CASCADE, ...env }, usage: hostUsage(tokens) }, event);
  const manual = { trigger: 'manual' };

  it('protected text over the goal moves the goal up to the prefix and the text (goal_yielded); text that fits leaves the goal as it is', async () => {
    const q = `Q ${big(120000)}`;
    const yielded = await go([ownerRow(q), assistantRow('ok')], {}, 150000, manual, 30, 12000);
    const record = compactRecord(yielded);
    expect(record).toMatchObject({ result: 'jev', owner_tail: { goal_yielded: true, overflow: false } });
    expect(record.cascade_target_tokens).toBe(record.owner_tail.tokens);
    expect(textsOf(yielded)).toContain(q);
    const off = compactRecord(await go([ownerRow(q), assistantRow('ok')], { OMC_JEV_COMPACT_OWNER_TAIL: undefined }, 150000, manual, 30, 12000));
    expect(off.cascade_target_tokens).toBeLessThan(record.cascade_target_tokens);
    const fits = compactRecord(await go([ownerRow('Q small'), assistantRow('ok')], {}, 150000, manual, 30, 12000));
    expect(fits.owner_tail.goal_yielded).toBe(false);
    expect(fits.cascade_target_tokens).toBe(off.cascade_target_tokens);
  });

  it('overflow, default: protected text that alone is over the floor bound is not protected, and the record says so', async () => {
    const run = await go([ownerRow('Q small'), assistantRow(big(420000))], {}, 200000, undefined, 40, 4000);
    expect(compactRecord(run)).toMatchObject({ result: 'jev', owner_tail_applied: false, owner_tail: { overflow: true, boundary: 'old', goal_yielded: false } });
    expect(compactRecord(run)).not.toHaveProperty('owner_tail_tier');
  });

  it('overflow, keep: the text stays whole, with the goal up to it, and a floor over the bound no longer hands the compaction to the summary', async () => {
    const rows = [ownerRow('Q small'), assistantRow(big(420000))];
    const keep = { OMC_JEV_COMPACT_OWNER_TAIL_OVERFLOW: 'keep' };
    const kept = await go(rows, keep, 200000, undefined, 40, 4000);
    expect(compactRecord(kept)).toMatchObject({ result: 'jev', owner_tail_applied: true, owner_tail_tier: 0, owner_tail: { overflow: true, boundary: 'owner', goal_yielded: true } });
    expect(textsOf(kept)).toContain(big(420000));
    expect(compactRecord(await go(rows, {}, 205000, undefined, 40, 4000))).toMatchObject({ result: 'fallback', reason: 'floor_above_threshold', owner_tail: { overflow: true } });
    expect(compactRecord(await go(rows, keep, 205000, undefined, 40, 4000))).toMatchObject({ result: 'jev', owner_tail_applied: true });
  });

  it('overflow, keep: text over the threshold itself is not kept', async () => {
    const rows = [ownerRow('Q small'), assistantRow(big(900000))];
    const run = await go(rows, { OMC_JEV_COMPACT_OWNER_TAIL_OVERFLOW: 'keep' }, 150000, manual);
    expect(compactRecord(run)).toMatchObject({ owner_tail_applied: false, owner_tail: { overflow: true, boundary: 'old' } });
  });

  it('overflow, keep, with blocks to move: the gate after the plan that hands a plan over the bound to the summary is off too', async () => {
    const old = Array.from({ length: 20 }, (_, k) => para(`old${k}`, 3000)).join('\n\n');
    const rows = [ownerRow(old), assistantRow('Noted.'), ownerRow('Q small'), assistantRow(big(420000))];
    const keep = await go(rows, { OMC_JEV_COMPACT_OWNER_TAIL_OVERFLOW: 'keep' }, 205000, undefined, 40, 4000);
    expect(compactRecord(keep).floor_blocks_tokens).toBeGreaterThan(0);
    expect(compactRecord(keep)).toMatchObject({ result: 'jev', owner_tail_applied: true });
    expect(compactRecord(keep)).not.toHaveProperty('floor_after_agents');
  });

  it('the text from the message of the user overflows and the one from the newest message of another session fits: that boundary is used', async () => {
    const rows = [ownerRow('Q small'), assistantRow(big(420000)), ownerRow(CROSS('done')), assistantRow('ok')];
    expect(compactRecord(await go(rows, {}, 150000, manual))).toMatchObject({ owner_tail_applied: true, owner_tail_tier: 1, owner_tail: { boundary: 'cross_session', overflow: false, protected_rows: 2, rows: 2 } });
    expect(compactRecord(await go(rows, { OMC_JEV_COMPACT_OWNER_TAIL_CROSS_SESSION: 'on' }, 150000, manual))).toMatchObject({ owner_tail_applied: true, owner_tail_tier: 0, owner_tail: { boundary: 'cross_session', overflow: false } });
    expect(compactRecord(await go(rows, { OMC_JEV_COMPACT_OWNER_TAIL_CROSS_SESSION: 'off' }, 150000, manual))).toMatchObject({ owner_tail_applied: false, owner_tail: { boundary: 'old', overflow: true, protected_rows: 3 } });
  });

  it('both boundaries overflow: no protection; with keep the last boundary stays', async () => {
    const rows = [ownerRow('Q small'), assistantRow(big(420000)), ownerRow(CROSS('done')), assistantRow(big(420000))];
    expect(compactRecord(await go(rows, {}, 150000, manual))).toMatchObject({ owner_tail_applied: false, owner_tail: { boundary: 'old', overflow: true } });
    expect(compactRecord(await go(rows, { OMC_JEV_COMPACT_OWNER_TAIL_OVERFLOW: 'keep' }, 150000, manual))).toMatchObject({ owner_tail_applied: true, owner_tail_tier: 1, owner_tail: { boundary: 'cross_session', overflow: true } });
  });

  const blocks = () => Array.from({ length: 24 }, (_, k) => para(`blk${k}`, 2500)).join('\n\n');
  const floorRows = () => [ownerRow('Q small'), assistantRow(blocks()), ownerRow(CROSS('done')), assistantRow('ok')];

  it('the floor with the protected text is over the bound: the compaction is decided again with the next boundary, not handed to the summary', async () => {
    const run = await go(floorRows(), {}, 175000, manual);
    expect(compactRecord(run)).toMatchObject({ result: 'jev', owner_tail_applied: true, owner_tail_tier: 1, owner_tail: { boundary: 'cross_session', overflow: false } });
    expect(textsOf(run)).not.toContain(blocks());
    expect(textsOf(run)).toContain('ok');
    expect(run.seen).toHaveLength(0);
    const alone = await go(floorRows(), { OMC_JEV_COMPACT_OWNER_TAIL_CROSS_SESSION: 'off' }, 175000, manual);
    expect(compactRecord(alone)).toMatchObject({ result: 'jev', owner_tail_applied: false, owner_tail: { overflow: true, boundary: 'old' } });
    expect(compactRecord(await go(floorRows(), {}, 165000, manual))).toMatchObject({ result: 'jev', owner_tail_tier: 0, owner_tail: { boundary: 'owner' } });
  });

  it('the answer to the user stays after the messages of other sessions (fallback and off); with on the boundary moves behind it', async () => {
    const answer = [para('sigma', 1500), para('tau', 1500)].join('\n\n');
    const rows = [ownerRow('Question for the coordinator.'), assistantRow(answer), ownerRow(CROSS('track report one')), assistantRow('Noted.')];
    for (const value of [undefined, 'off']) {
      const run = await go(rows, { OMC_JEV_COMPACT_OWNER_TAIL_CROSS_SESSION: value }, 130000);
      expect(textsOf(run), String(value)).toContain(answer);
      expect(compactRecord(run).owner_tail).toMatchObject({ boundary: 'owner', protected_rows: 3 });
    }
    const on = await go(rows, { OMC_JEV_COMPACT_OWNER_TAIL_CROSS_SESSION: 'on' }, 130000);
    expect(textsOf(on)).not.toContain(answer);
    expect(compactRecord(on).owner_tail).toMatchObject({ boundary: 'cross_session', protected_rows: 2 });
  });

  it('the host is read as often as with the switch off: the reads for the window are made once, before the stages', async () => {
    const count = async (extra) => (await go([ownerRow('Q small'), assistantRow('ok')], extra, 150000, manual)).calls.usage;
    expect(await count({})).toBe(await count({ OMC_JEV_COMPACT_OWNER_TAIL: undefined }));
  });
});

describe('OWNER_TAIL: the decision is repeated down to no protection', () => {
  // Two boundaries, each with a long answer after it: the message of the user, then the one of another session. With a higher count of the host the floor is over
  // the bound with the first boundary, then also with the second, and the third decision protects nothing.
  const answer = (word) => Array.from({ length: 20 }, (_, k) => para(`${word}${k}`, 3000)).join('\n\n');
  const run = async (tokens) => {
    const rows = [ownerRow('Q small'), assistantRow(answer('omega')), ownerRow(CROSS('done')), assistantRow(answer('psi'))];
    return compactRecord(await compactOnce(ending(rows), { env: { ...ON, ...CASCADE }, usage: hostUsage(tokens) }, { trigger: 'manual' }));
  };

  it('takes the first boundary, the next one, then none, when the floor is over the bound with each boundary whose text fits it', async () => {
    expect(await run(150000)).toMatchObject({ result: 'jev', owner_tail_applied: true, owner_tail_tier: 0, owner_tail: { boundary: 'owner', overflow: false } });
    expect(await run(175000)).toMatchObject({ result: 'jev', owner_tail_applied: true, owner_tail_tier: 1, owner_tail: { boundary: 'cross_session', overflow: false } });
    expect(await run(190000)).toMatchObject({ result: 'jev', owner_tail_applied: false, owner_tail: { boundary: 'old', overflow: true } });
  });
});

describe('OWNER_TAIL: the usage of every request, also of the decisions that were given up', () => {
  // The write of the block files fails, so the plan stays over the bound after the questions were asked: the compaction is decided again for each boundary.
  const run = (extra) => {
    const old = Array.from({ length: 24 }, (_, k) => para(`old${k}`, 3000)).join('\n\n');
    const rows = [ownerRow(old), assistantRow('Noted.'), ownerRow('Q small'), assistantRow(para('omega', 60000)), ownerRow(CROSS('done')), assistantRow(para('psi', 30000))];
    let n = 0;
    const respond = (body) => okResponse({ answers: jevAnswers(body), usage: { input_tokens: 100 + ++n, output_tokens: 7, ...(n === 1 ? { cost_usd: 0.001 } : {}) }, model: 'jev-x' });
    return compactOnce(ending(rows, 30, { chars: 4000 }), { env: { ...ON, ...CASCADE, OMC_JEV_COMPACT_JEV_USAGE: '1', ...extra }, usage: hostUsage(190000), respond, failWrite: (p) => p.startsWith(PASTES) && p.endsWith('.txt') }, { trigger: 'manual' });
  };

  it('the record has one entry per request sent, those of the given up decisions marked abandoned', async () => {
    const out = await run({});
    const record = compactRecord(out);
    const scoring = out.calls.fetch.filter((c) => c.body.state.results).length;
    expect(scoring).toBeGreaterThan(1);
    expect(record.jev_usage).toHaveLength(out.calls.fetch.length);
    expect(new Set(record.jev_usage.map((entry) => entry.input_tokens)).size).toBe(out.calls.fetch.length);
    const given = record.jev_usage.filter((entry) => entry.abandoned);
    expect(given.length).toBeGreaterThan(0);
    // The entries of the last decision stand first, parallel to jev_ms.
    expect(record.jev_usage.slice(0, record.jev_ms?.length ?? 0).some((entry) => entry.abandoned || entry.purpose)).toBe(false);
    expect(record.jev_usage.slice(-given.length)).toEqual(given);
    // Only the first request, of a given up decision, carried a cost.
    expect(record.cost_basis).toBe('reported');
  });

  it('without the usage switch the record gains no field when the compaction is decided again', async () => {
    const record = compactRecord(await run({ OMC_JEV_COMPACT_JEV_USAGE: undefined }));
    expect(record).toHaveProperty('owner_tail');
    expect(record).not.toHaveProperty('jev_usage');
    expect(record).not.toHaveProperty('cost_basis');
  });
});

describe('OWNER_TAIL: what counts as a message of the user', () => {
  const rows = {
    owner: { role: 'user', text: 'Please fix the build.' },
    paste: { role: 'user', text: 'see <pasted_content id="1">log text</pasted_content> thanks' },
    stopHook: { role: 'user', text: 'Stop hook feedback: keep going' },
    meta: { role: 'user', text: 'words of a hook', isMeta: true },
    result: { role: 'user', text: 'words next to a result', toolResults: [{ tool_use_id: 'a', text: 'r' }] },
    reminder: { role: 'user', text: '<system-reminder>\nsomething\n</system-reminder>' },
    command: { role: 'user', text: '<command-name>/compact</command-name>' },
    trace: { role: 'user', text: '[compacted] Bash(ls) - result of 5 chars removed' },
    agent: { role: 'user', text: agentRow('w1', 'report') },
    note: { role: 'user', text: '<task-notification>done</task-notification>' },
    blank: { role: 'user', text: '   ' },
    assistant: { role: 'assistant', text: 'Hello' },
    cross: { role: 'user', text: CROSS('hi') },
  };
  const classes = async (extra) => { const cfg = await cfgOf({ ...ACTIVE_ENV, ...SWITCH, ...extra }); return Object.keys(rows).filter((k) => isOwnerTailRow(rows[k], cfg)); };

  it('the words of the user, also a paste; a row of a hook or the host, a result, a command, a trace, an agent, a notification or the assistant is not; another session only with on', async () => {
    expect(await classes({})).toEqual(['owner', 'paste']);
    expect(await classes({ OMC_JEV_COMPACT_OWNER_TAIL_CROSS_SESSION: 'off' })).toEqual(['owner', 'paste']);
    expect(await classes({ OMC_JEV_COMPACT_OWNER_TAIL_CROSS_SESSION: 'on' })).toEqual(['owner', 'paste', 'cross']);
    expect(await classes({ OMC_JEV_COMPACT_HOOK_ROW_PREFIXES: 'Please' })).toEqual(['paste']);
  });

  it('while the blocks act, a row that is only a moved block or the header of the trace files holds no words of the user', async () => {
    const moved = { role: 'user', text: '[block moved at compaction: 40 chars in b/ab12.txt]' };
    const header = { role: 'user', text: '[compaction trace files: b/ = /tmp/x/blocks]' };
    const withBlocks = await cfgOf({ ...ACTIVE_ENV, ...SWITCH, OMC_JEV_COMPACT_BLOCKS: 'active' });
    expect([moved, header].map((row) => isOwnerTailRow(row, withBlocks))).toEqual([false, false]);
    const without = await cfgOf({ ...ACTIVE_ENV, ...SWITCH });
    expect([moved, header].map((row) => isOwnerTailRow(row, without))).toEqual([true, true]);
  });

  it('the boundary is the last such row; the message of another session is a second tier only with fallback and only after it', async () => {
    const list = [rows.owner, rows.assistant, rows.stopHook, rows.agent, rows.cross, rows.assistant, rows.note];
    const tiers = async (messages, extra = {}) => ownerTailTiers(messages, await cfgOf({ ...ACTIVE_ENV, ...SWITCH, ...extra }));
    expect(await tiers(list)).toEqual([0, 4]);
    expect(await tiers(list, { OMC_JEV_COMPACT_OWNER_TAIL_CROSS_SESSION: 'off' })).toEqual([0]);
    expect(await tiers(list, { OMC_JEV_COMPACT_OWNER_TAIL_CROSS_SESSION: 'on' })).toEqual([4]);
    expect(await tiers([rows.assistant, rows.stopHook])).toEqual([]);
    expect(await tiers([rows.assistant, rows.cross, rows.assistant])).toEqual([1]);
    expect(await tiers([rows.cross, rows.owner, rows.assistant])).toEqual([1]);
  });

  it('the protected rows are the boundary row and every assistant row with text after it', () => {
    const list = [rows.owner, { role: 'assistant', text: 'A1', toolUses: [{ tool_use_id: 't', tool: 'Bash', input: {} }] }, { role: 'user', text: '', toolResults: [{ tool_use_id: 't', text: 'r' }] }, { role: 'assistant', text: '  ' }, { role: 'assistant', text: 'A2' }];
    expect(ownerTailProtected(list, 0)).toEqual({ rows: [0, 1, 4], user: rows.owner.text, texts: ['A1', 'A2'] });
  });
});

describe('OWNER_TAIL: a subagent and a conversation with one message of the user', () => {
  const shape = () => ending([assistantRow('Result of the subagent.')]); // the prompt of the parent is the one row with words of a user
  const run = (env, event) => compactOnce(shape(), { env: { ...ON, ...env } }, event);

  it('a subagent has no owner tail by default; with the option its prompt counts and everything it wrote is protected', async () => {
    const dflt = compactRecord(await run({}, { agentId: 'sub-1' }));
    expect(dflt).toMatchObject({ owner_tail_applied: false, owner_tail: { from_idx: null, rows: 0, boundary: 'old', protected_rows: 0, overflow: false } });
    const on = compactRecord(await run({ OMC_JEV_COMPACT_OWNER_TAIL_AGENTS: 'active' }, { agentId: 'sub-1' }));
    expect(on).toMatchObject({ owner_tail_applied: true, owner_tail_tier: 0, owner_tail: { from_idx: 0, boundary: 'owner', protected_rows: 32, overflow: false } });
  });

  it('an automatic compaction of a subagent with the token cascade reads its window early and ends with Jev', async () => {
    const env = { ...ON, ...CASCADE };
    const event = { agentId: 'sub-1' };
    const off = await compactOnce(shape(), { env: { ...env, OMC_JEV_COMPACT_OWNER_TAIL: undefined }, usage: hostUsage(150000) }, event);
    expect(compactRecord(off)).toMatchObject({ result: 'jev' });
    for (const extra of [{}, { OMC_JEV_COMPACT_OWNER_TAIL_AGENTS: 'active' }]) {
      const out = await compactOnce(shape(), { env: { ...env, ...extra }, usage: hostUsage(150000) }, event);
      expect(compactRecord(out).result, JSON.stringify(compactRecord(out))).toBe('jev');
      expect(compactRecord(out)).not.toHaveProperty('error');
      expect(out.seen).toHaveLength(0);
    }
  });

  it('the early window of a subagent follows the estimate of its API form with the thinking in it', async () => {
    const env = { ...ON, ...CASCADE, OMC_JEV_COMPACT_OWNER_TAIL_AGENTS: 'active' };
    const messages = () => ending([assistantRow(para('omega', 250000))], 30, { chars: 1500 });
    const plain = apiOf(messages());
    // 40000 characters of thinking and signature on the first assistant message widen the window of the subagent: the protected answer is over the bound without them.
    const thinking = plain.map((a, k) => (k === 1 ? { ...a, content: [{ type: 'thinking', thinking: 'T'.repeat(20000), signature: 'S'.repeat(20000) }, ...a.content] } : a));
    const event = { agentId: 'sub-1' };
    const usage = hostUsage(150000);
    const without = compactRecord(await compactOnce(messages(), { env, usage, api: plain }, event));
    const withIt = compactRecord(await compactOnce(messages(), { env, usage, api: thinking }, event));
    expect(without).toMatchObject({ sig_chars_total: 0, owner_tail_applied: false, owner_tail: { overflow: true, boundary: 'old' } });
    expect(withIt).toMatchObject({ sig_chars_total: 40000, owner_tail_applied: true, owner_tail: { overflow: false, boundary: 'owner', protected_rows: 32 } });
    expect(listTokens(thinking) + RATE_SIG_OF_TEST * 40000).toBeGreaterThan(listTokens(plain));
  });

  it('the main loop of the same shape is not protected (the whole conversation would be), also with the option', async () => {
    for (const env of [{}, { OMC_JEV_COMPACT_OWNER_TAIL_AGENTS: 'active' }]) {
      const record = compactRecord(await run(env));
      expect(record).toMatchObject({ owner_tail_applied: false, owner_tail: { from_idx: 0, boundary: 'old', overflow: false } });
      expect(record).not.toHaveProperty('owner_tail_tier');
    }
  });

  it('the main loop of a conversation with a later message of the user is protected without the option', async () => {
    expect(compactRecord(await compactOnce(withRows([]), { env: ON }))).toMatchObject({ owner_tail_applied: true, owner_tail: { boundary: 'owner', protected_rows: 2 } });
  });
});

describe('OWNER_TAIL: the check after the build', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const tmp = mkdtempSync(join(tmpdir(), 'jev-owner-tail-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  let count = 0;
  // A copy of the module whose build changes a protected answer: the check has no natural trigger, it guards against later changes of the stages.
  async function patched(change) {
    const dir = join(tmp, `m${++count}`);
    mkdirSync(join(dir, 'hooks'), { recursive: true });
    cpSync(join(root, 'scripts', 'lib'), join(dir, 'scripts', 'lib'), { recursive: true });
    const text = readFileSync(join(root, 'hooks', 'jev-compaction.mjs'), 'utf8');
    const out = change(text);
    if (out === text) throw new Error('the patch of the module changed nothing');
    writeFileSync(join(dir, 'hooks', 'jev-compaction.mjs'), out);
    return import(pathToFileURL(join(dir, 'hooks', 'jev-compaction.mjs')).href);
  }
  const ROW = "const text = [m.text || '', ...traces].filter(Boolean).join('\\n');";
  const change = (text) => text.replace(ROW, ROW.replace(".join('\\n')", ".join('\\n').replace('FINAL ANSWER', 'CHANGED ANSWER')"));
  const rows = () => ending([ownerRow('Please finish.'), assistantRow('FINAL ANSWER is here.')]);

  it('names each protected element that is gone; a delivered block after the message and a trace after an answer are no change', () => {
    const prot = { rows: [0, 1, 2], user: 'The words', texts: ['first answer', 'second answer'] };
    const user = (text) => ({ role: 'user', text, toolUses: [], toolResults: [] });
    const asst = (text) => ({ role: 'assistant', text, toolUses: [] });
    expect(ownerTailViolations([user('The words'), asst('first answer'), asst('second answer')], prot)).toEqual([]);
    expect(ownerTailViolations([user('The words\n<system-reminder>delivered</system-reminder>'), asst('first answer\n[compacted] Bash(ls) - result removed'), asst('xx second answer')], prot)).toEqual([]);
    expect(ownerTailViolations([user('The'), asst('first answer'), asst('second answer')], prot)).toEqual(['owner_text']);
    expect(ownerTailViolations([user('The words'), asst('first answer')], prot)).toEqual(['assistant_text']);
    expect(ownerTailViolations([user('The words'), asst('second answer'), asst('first answer')], prot)).toEqual(['assistant_text']);
    expect(ownerTailViolations([asst('first answer second answer')], prot)).toEqual(['owner_text']);
    expect(ownerTailViolations([{ role: 'user', text: 'The words', toolResults: [{ tool_use_id: 't', text: 'r' }] }, asst('first answer'), asst('second answer')], prot)).toEqual(['owner_text']);
  });

  it('a protected text that came out changed leaves the conversation as it was: a skip, no summary of the host, the record names the element without its text', async () => {
    const broken = await patched(change);
    for (const trigger of ['manual', 'auto', 'plugin']) {
      const out = await compactOnce(rows(), { env: ON, mod: broken }, { trigger });
      expect(out.out, trigger).toEqual({ skip: expect.stringContaining(OWNER_TAIL_SKIP) });
      expect(out.seen, trigger).toHaveLength(0);
      expect(compactRecord(out), trigger).toMatchObject({ result: 'fallback', reason: 'owner_tail_changed', owner_tail_violations: ['assistant_text'], owner_tail: { violations: 1 } });
      expect(JSON.stringify(compactRecord(out))).not.toContain('FINAL ANSWER');
    }
  });

  it('in shadow mode the summary of the host runs, and with the switch off there is no check', async () => {
    const broken = await patched(change);
    const shadow = await compactOnce(rows(), { env: { ...ON, OMC_JEV: 'compaction' }, mod: broken });
    expect(shadow.seen).toHaveLength(1);
    const off = await compactOnce(rows(), { env: STAGES, mod: broken });
    expect(textsOf(off)).toContain('CHANGED ANSWER');
    expect(compactRecord(off)).toMatchObject({ result: 'jev' });
  });

  it('one API message with a text and a call for rows around a result is found in the joined group', async () => {
    const messages = frozen([
      ...conversation(30).slice(0, -2),
      ownerRow('Please finish.'),
      { role: 'assistant', text: 'FINAL ANSWER part one.', toolUses: [{ tool_use_id: 'z1', tool: 'Bash', input: { command: 'ls' } }] },
      { role: 'user', text: '', toolResults: [{ tool_use_id: 'z1', text: `RESULT-Z ${'x'.repeat(3000)}`, isError: false }] },
      { role: 'assistant', text: 'FINAL ANSWER part two.', toolUses: [] },
    ]);
    const out = await compactOnce(messages, { env: ON });
    expect(compactRecord(out)).toMatchObject({ result: 'jev', owner_tail: { violations: 0, protected_rows: 3 } });
    expect(textsOf(out)).toContain('FINAL ANSWER part two.');
  });
});

describe('OWNER_TAIL: the own request and the small cut', () => {
  const env = { ...ON, OMC_JEV_COMPACT_AT_PERCENT: '60' };
  const highUsage = () => ({ context: { tokens: 130000, window: 200000 } });

  it('the own request that is answered with the skip of the owner tail is recorded with its own reason', async () => {
    const reasonOf = async (compactResult) => {
      const handlers = load();
      const fake = fakeDollar({ env, messages: conversation(40, { chars: 4000 }), usage: highUsage, compactResult });
      for (let k = 0; k < 7; k++) await handlers['turn.complete'](fake.$, { isAborted: false }, async () => 'ok');
      expect(await until(() => fake.records().some((r) => r.event === 'own_threshold'))).toBe(true);
      return fake.records().find((r) => r.event === 'own_threshold').reason;
    };
    expect(await reasonOf({ skip: `${OWNER_TAIL_SKIP} a protected text came out changed, nothing replaced` })).toBe('owner_tail_changed');
    expect(await reasonOf({ skip: 'vetoed by another mod' })).toBe('host_skipped');
  });

  it('a manual cut under the smallest one of the host goes to the summary without the owner tail and is made by the module with it', async () => {
    const run = (extra) => compactOnce(withRows([], 30, { chars: 1900 }), { env: { ...STAGES, ...CASCADE, OMC_JEV_COMPACT_HOST_HANDOFF: '1', ...extra }, usage: highUsage }, { trigger: 'manual' });
    expect(compactRecord(await run({}))).toMatchObject({ result: 'fallback', reason: 'cut_below_host_min' });
    expect(compactRecord(await run(SWITCH))).toMatchObject({ result: 'jev', owner_tail_applied: true });
  });
});

describe('OWNER_TAIL: the plans made outside the compaction (the pass that fills the verdicts, the estimate of the own threshold)', () => {
  const BLK = [para('pi', 700, 'LV1'), para('tau', 700, 'LV3'), para('rho', 700)].join('\n\n');
  const base = { ...STAGES, ...CASCADE, OMC_JEV_COMPACT_AT_PERCENT: '50' };

  it('Jev is not asked about the blocks of a protected row, and the host is read as often as with the switch off', async () => {
    const go = async (extra) => {
      const fake = fakeDollar({ env: { ...base, ...extra }, messages: withRows([ownerRow('Earlier question without blocks.')], 30, { chars: 4000, last: BLK }), usage: hostUsage(150000) });
      await turnEnd(fake);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return fake;
    };
    const off = await go({});
    const on = await go(SWITCH);
    // The newest message of the user holds three blocks: asked without the switch, protected with it.
    expect(off.blockRequests().flatMap((c) => Object.keys(c.body.state.blocks))).toHaveLength(3);
    expect(on.blockRequests()).toHaveLength(0);
    expect(on.records().find((r) => r.event === 'verdicts_fill')).toMatchObject({ eligible: 0 });
    expect(on.calls.compact).toBe(1);
    expect(on.calls.usage).toBe(off.calls.usage);
  });

  it('the estimate of the own threshold counts nothing from the blocks of a protected row', async () => {
    const big = Array.from({ length: 16 }, (_, k) => para(`w${k}`, 3000)).join('\n\n');
    const usage = () => ({ context: { tokens: 75000, window: 100000 } });
    const go = async (extra) => {
      const fake = fakeDollar({ env: { ...base, OMC_JEV_COMPACT_OWN_THRESHOLD: '1', ...extra }, messages: withRows([], 30, { chars: 150, last: big }), usage });
      await turnEnd(fake);
      return fake;
    };
    expect((await go({})).calls.compact).toBe(1);
    expect((await go(SWITCH)).calls.compact).toBe(0);
  });
});
