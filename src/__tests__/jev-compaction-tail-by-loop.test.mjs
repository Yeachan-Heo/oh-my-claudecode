/**
 * Tests of OMC_JEV_COMPACT_TAIL_BY_LOOP of hooks/jev-compaction.mjs: with `active` the tail the compaction leaves alone is the open tool loop, not also the last rows.
 */

import { describe, expect, it } from 'vitest';

import { readConfig } from '../../hooks/jev-compaction.mjs';
import { ACTIVE_ENV, PASTES, agentRow, assistantRow, compactOnce, compactRecord, conversation, fakeDollar, filler, frozen, hostUsage, load, outcomeOfScenario, ownerRow, para, pastedTag, scenarios, textsOf, withRows } from './jev-compaction-tail-harness.mjs';

const SWITCH = { OMC_JEV_COMPACT_TAIL_BY_LOOP: 'active' };
const ON = { ...ACTIVE_ENV, ...SWITCH };
const askedResults = (run) => run.calls.fetch.filter((c) => c.body.state.results).flatMap((c) => Object.values(c.body.state.results));
const sent = (run) => JSON.stringify(run.calls.fetch.map((c) => c.body));
const written = (run) => [...run.files.values()].join('\n');
// A closed loop: `rows` stand after the last result, so they are among the last rows of the conversation.
const ending = (rows, n = 30, options) => frozen([...conversation(n, options).slice(0, -2), ...rows]);
/** One call and its result, as two rows. */
const step = (id, input, text, tool = 'Bash') => [
  { role: 'assistant', text: `Run ${id}.`, toolUses: [{ tool_use_id: id, tool, input }] },
  { role: 'user', text: '', toolResults: [{ tool_use_id: id, text, isError: false }] },
];

describe('TAIL_BY_LOOP: the switch', () => {
  it('only active turns it on, from the settings too', async () => {
    const get = async (env, settingsEnv) => (await readConfig(fakeDollar({ env, settingsEnv }).$)).tailByLoop;
    expect(await get(ACTIVE_ENV)).toBe(false);
    for (const value of ['active', ' active ']) expect(await get({ ...ACTIVE_ENV, OMC_JEV_COMPACT_TAIL_BY_LOOP: value }), value).toBe(true);
    for (const value of ['', '0', '1', 'true', 'on', 'Active', 'shadow', 'activ']) expect(await get({ ...ACTIVE_ENV, OMC_JEV_COMPACT_TAIL_BY_LOOP: value }), value).toBe(false);
    expect(await get(ACTIVE_ENV, SWITCH)).toBe(true);
  });

  it.each(scenarios())('$name: unset and values outside the list give the same answer, records, requests and files', async (scenario) => {
    const unset = await outcomeOfScenario(scenario);
    for (const value of ['', '0', '1', 'true', 'on', 'Active']) expect(await outcomeOfScenario(scenario, { OMC_JEV_COMPACT_TAIL_BY_LOOP: value }), value).toEqual(unset);
  });
});

describe('TAIL_BY_LOOP: what the compaction takes', () => {
  it('the results of the last rows are candidates at a turn boundary', async () => {
    const off = await compactOnce(withRows([]), { env: ACTIVE_ENV });
    const on = await compactOnce(withRows([]), { env: ON });
    expect(compactRecord(off).candidates).toBe(28);
    expect(askedResults(off)).toHaveLength(28);
    expect(compactRecord(on).candidates).toBe(30);
    expect(askedResults(on)).toHaveLength(30);
    expect(textsOf(on)).toContain('Summary: done.');
  });

  it('a result of the last rows that Jev scores low goes like an older one; without the switch it stays whole', async () => {
    const low = `RESULT-LOW ${'q'.repeat(3000)}`;
    const base = conversation(30).slice(0, -2).map((m) => (m.toolResults ? { ...m, toolResults: m.toolResults.map((r) => ({ ...r, text: `NEEDED ${r.text}` })) } : m));
    const messages = frozen([...base, ...step('low', { command: 'cat low.txt' }, low), assistantRow('Done.')]);
    const results = (run) => run.out.messages.flatMap((m) => (m.toolResults || []).map((r) => r.text));
    expect(results(await compactOnce(messages, { env: ACTIVE_ENV }))).toContain(low);
    const on = await compactOnce(messages, { env: ON });
    expect(compactRecord(on)).toMatchObject({ result: 'jev', candidates: 31 });
    expect(JSON.stringify(on.out.messages)).not.toContain(low);
  });

  it('the open tool loop keeps its handles and its results, and is no candidate', async () => {
    const last = `RESULT-OPEN ${'o'.repeat(3000)}`;
    const messages = ending([...step('open', { command: 'cat open.txt' }, last)]);
    const run = await compactOnce(messages, { env: ON });
    expect(compactRecord(run)).toMatchObject({ result: 'jev', kept_from: 2, candidates: 30 });
    // The call of the loop keeps its handle, as it does without the switch.
    expect(run.out.messages.at(-2).handle).toBe(messages.at(-2).handle);
    expect(run.out.messages.at(-1).toolResults[0].text).toBe(last);
    expect(sent(run)).not.toContain('RESULT-OPEN');
  });

  it('a conversation of three messages or more is compacted; without the switch it is too short', async () => {
    const four = frozen([ownerRow('Task: read the note.'), ...step('t1', { command: 'cat note.txt' }, `RESULT-1 ${'x'.repeat(4000)}`), assistantRow('Done.')]);
    expect(compactRecord(await compactOnce(four, { env: ACTIVE_ENV }))).toMatchObject({ result: 'fallback', reason: 'too_few_messages' });
    expect(compactRecord(await compactOnce(four, { env: ON }))).toMatchObject({ result: 'jev', candidates: 1 });
    const two = frozen([ownerRow('Task.'), assistantRow('Done.')]);
    expect(compactRecord(await compactOnce(two, { env: ON }))).toMatchObject({ reason: 'too_few_messages' });
    const three = frozen([ownerRow('Task.'), assistantRow('Working.'), assistantRow('Done.')]);
    expect(compactRecord(await compactOnce(three, { env: ON })).reason).toBe('too_few_results');
  });

  it('the own threshold counts the results of the last rows as removable', async () => {
    const env = { ...ACTIVE_ENV, OMC_JEV_COMPACT_AT_PERCENT: '50' };
    const usage = () => ({ context: { tokens: 75000, window: 100000 } });
    const messages = () => withRows([], 3, { chars: 30000 });
    const asked = async (extra) => {
      const fake = fakeDollar({ env: { ...env, ...extra }, messages: messages(), usage });
      await load()['turn.complete'](fake.$, Object.freeze({}), async () => ({}));
      return fake.calls.compact;
    };
    // Three results of 30000 characters: two of them stand among the last six rows.
    expect(await asked({})).toBe(0);
    expect(await asked(SWITCH)).toBe(1);
  });

  it('the own threshold leaves the results of the open loop out of its count', async () => {
    const env = { ...ON, OMC_JEV_COMPACT_AT_PERCENT: '50' };
    const messages = frozen([ownerRow('Task.'), assistantRow('One.'), assistantRow('Two.'), ...step('open', { command: 'cat big.txt' }, 'y'.repeat(90000))]);
    const fake = fakeDollar({ env, messages, usage: () => ({ context: { tokens: 75000, window: 100000 } }) });
    await load()['turn.complete'](fake.$, Object.freeze({}), async () => ({}));
    expect(fake.calls.compact).toBe(0);
  });

  it('the agent trim reaches a report among the last rows', async () => {
    const report = `Report 1: ${filler('Report of the work, tests passed, commit abc1234.', 600)}`;
    const base = conversation(30, { chars: 4000 });
    const messages = frozen([...base.slice(0, -2), ownerRow(agentRow('worker-1', report, 'report 1')), ...base.slice(-2)]);
    const env = { ...ACTIVE_ENV, OMC_JEV_COMPACT_AGENT_TRIM: '1' };
    const off = await compactOnce(messages, { env });
    expect(compactRecord(off).agent_trim).toMatchObject({ rows: 0, chars: 0 });
    expect(textsOf(off)).toContain('Another Claude session sent a message:\n<teammate-message');
    const on = await compactOnce(messages, { env: { ...env, ...SWITCH } });
    expect(compactRecord(on).agent_trim).toMatchObject({ rows: 1 });
    expect(textsOf(on)).not.toContain('Another Claude session sent a message:');
    expect(textsOf(on)).toContain(report);
  });

  it('the paste stage asks about a tag among the last rows, never about the newest message of the user', async () => {
    const tag = (word) => `Please check this.\n\n${pastedTag(filler(word, 2500))}\n\nThanks for it.`;
    const messages = ending([ownerRow(tag('alpha')), assistantRow('Read.'), ownerRow(tag('omega')), assistantRow('Read too.')]);
    const env = { ...ACTIVE_ENV, OMC_JEV_COMPACT_PASTES: 'active' };
    expect(compactRecord(await compactOnce(messages, { env })).pastes.asked).toBe(0);
    const on = await compactOnce(messages, { env: { ...env, ...SWITCH } });
    expect(compactRecord(on).pastes).toMatchObject({ asked: 1, moved: 1 });
    expect(textsOf(on)).toContain(filler('omega', 2500));
    expect(textsOf(on)).not.toContain(filler('alpha', 2500));
  });

  it('the blocks of the last rows are asked about', async () => {
    const block = para('lambda', 900);
    const messages = ending([assistantRow('Middle of the work.'), ownerRow(block), assistantRow('Noted.'), assistantRow('Done.')]);
    const env = { ...ACTIVE_ENV, OMC_JEV_COMPACT_BLOCKS: 'active' };
    const asked = (run) => run.blockRequests().flatMap((c) => Object.values(c.body.state.blocks).map((b) => b.text));
    expect(asked(await compactOnce(messages, { env }))).not.toContain(block);
    expect(asked(await compactOnce(messages, { env: { ...env, ...SWITCH } }))).toContain(block);
  });
});

describe('TAIL_BY_LOOP: secrets in the last rows do not leave', () => {
  const TOKEN = `ghp_${'Zq3Rt7Wm'.repeat(5)}`;
  const ENV_VALUE = 'value-of-the-env-file-4417';
  const PRIVATE_VALUE = 'text-of-the-private-folder-8823';
  const PASSWORD = 'quietriver-92x';
  const body = (head) => `${head}\n${'z'.repeat(3000)}`;
  const messages = () => ending([
    ...step('s-env', { command: 'cat .env' }, body(`ENVSTART ${ENV_VALUE}`)),
    ...step('s-private', { file_path: '/home/u/private/notes.txt' }, body(`PRIVATESTART ${PRIVATE_VALUE}`), 'Read'),
    ...step('s-token', { command: 'cat build.log' }, body(`TOKENSTART token: ${TOKEN}`)),
    ...step('s-word', { command: 'cat mail.txt' }, body(`WORDSTART the password is ${PASSWORD}`)),
    ...step('s-plain', { command: 'cat plain.txt' }, body('PLAINSTART nothing to hide')),
    assistantRow('Done.'),
  ]);
  const env = { ...ON, OMC_JEV_COMPACT_ARCHIVE: 'active', OMC_JEV_COMPACT_PRIVATE_PATHS: '/home/u/private', OMC_JEV_COMPACT_TARGET_PERCENT: '20' };

  it('a result of a secret or private path is not sent, a secret in a result is sent masked, and none of them goes to a file', async () => {
    const run = await compactOnce(messages(), { env, usage: hostUsage(150000) }, { trigger: 'manual' });
    expect(compactRecord(run)).toMatchObject({ result: 'jev', candidates: 35 });
    // The control: a plain result among the last rows is sent and archived.
    expect(sent(run)).toContain('PLAINSTART');
    expect(written(run)).toContain('PLAINSTART');
    // The calls of the secret and private paths are not asked about at all.
    for (const start of ['ENVSTART', 'PRIVATESTART']) expect(sent(run), start).not.toContain(start);
    // A secret inside a result is masked in the request.
    expect(sent(run)).toContain('TOKENSTART');
    expect(sent(run)).not.toContain(TOKEN);
    for (const value of [ENV_VALUE, PRIVATE_VALUE, TOKEN, PASSWORD]) expect(written(run), value).not.toContain(value);
    expect([...run.files.keys()].filter((p) => p.includes('/compaction-archive/') && /s-(env|private|token|word)/.test(p))).toEqual([]);
    expect(compactRecord(run).archive_skipped).toMatchObject({ secret: 2, secret_in_result: 2 });
  });

  it('a pasted tag and a block with a secret among the last rows stay where they are: no request, no file', async () => {
    const tag = pastedTag(`${filler('alpha', 1500)} token: ${TOKEN} ${filler('beta', 1500)}`);
    const block = `${filler('gamma', 700)} token: ${TOKEN}`;
    const rows = ending([ownerRow(`Please check this.\n\n${tag}\n\nThanks for it.`), assistantRow('Read.'), ownerRow(block), assistantRow('Noted.'), assistantRow('Done.')]);
    for (const extra of [{ OMC_JEV_COMPACT_PASTES: 'active' }, { OMC_JEV_COMPACT_BLOCKS: 'active' }]) {
      const run = await compactOnce(rows, { env: { ...ON, ...extra } });
      expect(compactRecord(run).result).toBe('jev');
      expect(sent(run)).not.toContain(TOKEN);
      expect(written(run)).not.toContain(TOKEN);
      expect(textsOf(run)).toContain(TOKEN);
      expect([...run.files.keys()].filter((p) => p.startsWith(PASTES) && p.endsWith('.txt') && run.files.get(p).includes('gamma gamma'))).toEqual([]);
    }
  });
});
