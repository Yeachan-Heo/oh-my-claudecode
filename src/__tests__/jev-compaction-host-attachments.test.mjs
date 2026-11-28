/* global performance */
/**
 * Tests of OMC_JEV_COMPACT_HOST_ATTACHMENTS of hooks/jev-compaction.mjs: the user rows of text lose their handle, so the attachments the host keeps in their groups
 * (instructions, lists, the text of used skills, hook contexts) do not come back, and the advisor's reminder is rebuilt with its row. The only fake of the Jev side is
 * the stub of $.http.fetch.
 */

import { describe, expect, it } from 'vitest';

import * as mod from '../../hooks/jev-compaction.mjs';
import { ACTIVE_ENV, CASCADE, PASTES, apiOf, assistantRow, compactOnce, compactRecord, conversation, fakeDollar, frozen, hostUsage, load, okResponse, outcomeOf, ownerRow, para, withRows } from './jev-compaction-tail-harness.mjs';

const { listTokens, readConfig, traceHeader } = mod;
const SWITCH = { OMC_JEV_COMPACT_HOST_ATTACHMENTS: '1' };
const HA = { ...ACTIVE_ENV, ...SWITCH };
const PREDICT = { ...HA, ...CASCADE };
const reminder = (text) => `<system-reminder>\n${text}\n</system-reminder>`;
const INSTR = reminder(`Codebase and user instructions are shown below. Be sure to adhere to these instructions.\n\nContents of /x/notes.md: ${para('rule', 4000)}`);
const SKILLS = reminder(`The following skills are available for use with the Skill tool:\n\n- a: ${para('desc', 2000)}`);
const INVOKED = reminder(`The following skills were invoked EARLIER in this session:\n\n### Skill: demo\n${para('body', 1500)}`);
const ADVISOR = reminder('# Advisor Tool\nYou have access to an advisor.');
const FRAME = (text) => `Another Claude session sent a message while you were working:\n<cross-session-message from="track-1">${text}</cross-session-message>`;
const rate = (...texts) => Math.round(0.43 * texts.reduce((n, t) => n + t.length, 0));

/** The API form of the conversation with the text blocks `extras[i]` after the content of row i (where the host writes the attachments of a group). */
function apiWith(messages, extras = {}) {
  const api = [];
  messages.forEach((m, i) => {
    const content = [...apiOf([m])[0].content, ...(extras[i] || []).map((text) => ({ type: 'text', text }))];
    const last = api[api.length - 1];
    if (m.role === 'user' && last?.role === 'user') last.content.push(...content);
    else api.push({ role: m.role, content });
  });
  return api;
}
// 0 user (the task), 1 assistant, 2 user, 3 assistant, 4 user, then 30 call/result pairs and a closed loop.
const rows = () => withRows([assistantRow('First answer.'), ownerRow('Second question'), assistantRow('Second answer.'), ownerRow('Third question')], 30);
const EXTRAS = { 0: [INSTR], 2: [SKILLS, INVOKED] };
async function run(env, { messages = rows(), extras = EXTRAS, api, event, usage } = {}) {
  return compactOnce(messages, { env, api: api ?? apiWith(messages, extras), ...(usage ? { usage } : {}) }, event);
}
const row = (r, text) => r.out.messages.find((m) => m.role === 'user' && typeof m.text === 'string' && m.text.startsWith(text));
// The conversation ends with the user's line right after the last result: an open loop from the last assistant message.
const openLoop = () => frozen([...conversation(30).slice(0, -2), ownerRow('Please fix it.')]);

describe('HOST_ATTACHMENTS: the switch', () => {
  it('only 1 or true (any case) turns the switch on, also from the settings', async () => {
    const get = async (env, settingsEnv) => (await readConfig(fakeDollar({ env, settingsEnv }).$)).hostAttachments;
    expect(await get(ACTIVE_ENV)).toBe(false);
    for (const value of ['1', 'true', 'TRUE', ' 1 ']) expect(await get({ ...ACTIVE_ENV, OMC_JEV_COMPACT_HOST_ATTACHMENTS: value }), value).toBe(true);
    for (const value of ['0', '', 'active', 'on', 'yes', 'off']) expect(await get({ ...ACTIVE_ENV, OMC_JEV_COMPACT_HOST_ATTACHMENTS: value }), value).toBe(false);
    expect(await get(ACTIVE_ENV, SWITCH)).toBe(true);
  });

  const SCENARIOS = [
    ['attachments after rows of text', ACTIVE_ENV, undefined],
    ['an advisor reminder', ACTIVE_ENV, { extras: { ...EXTRAS, 4: [ADVISOR] } }],
    ['the token cascade', { ...ACTIVE_ENV, ...CASCADE }, { event: { trigger: 'manual' }, usage: hostUsage(150000) }],
    ['a delivered message', ACTIVE_ENV, { extras: { 2: [INSTR, FRAME('Hello from the track.')] } }],
    ['a cut API form', ACTIVE_ENV, { messages: withRows([], 2100), extras: {} }],
  ];
  it.each(SCENARIOS)('%s: unset and values outside the list give the same answer, records, requests and files, with no attachment field', async (_, env, options = {}) => {
    const cut = options.messages && apiWith(options.messages).slice(-2000);
    const go = async (extra) => outcomeOf(await run({ ...env, ...extra }, { ...options, ...(cut ? { api: cut } : {}) }));
    const unset = await go({});
    const record = unset.records.find((r) => r.event === 'compact');
    expect(record.result).toBe('jev');
    for (const key of Object.keys(record)) expect(key).not.toMatch(/^(attachments_|advisor_|rebuilt_user)/);
    for (const value of ['', '0', 'off', 'active', 'on', 'yes']) expect(await go({ OMC_JEV_COMPACT_HOST_ATTACHMENTS: value }), JSON.stringify(value)).toEqual(unset);
  });
});

describe('HOST_ATTACHMENTS: the user rows of text lose their handle and the old attachments of the host do not come back', () => {
  it('with the switch on every user row of text before the tail is built from its text without its handle, and the rows of text keep their words', async () => {
    const r = await run(HA);
    expect(compactRecord(r)).toMatchObject({ result: 'jev', rebuilt_user: 3 }); // the three rows; the closing request is the newest message
    for (const text of ['Task:', 'Second question', 'Third question']) {
      expect(row(r, text), text).toBeDefined();
      expect(row(r, text).handle, text).toBeUndefined();
    }
    expect(row(r, 'Task:').text).toBe('Task: review the notes and count the lines.');
    expect(r.out.messages.find((m) => m.text === 'First answer.').handle).toBeUndefined(); // an assistant row before the tail is rebuilt as always
  });

  it('the attachments written after the rows are counted as taken off, by kind, with what the host announces again', async () => {
    const record = compactRecord(await run(HA));
    expect(record).toMatchObject({ attachments_dropped: 3, attachments_kinds: { instructions: 1, skill_listing: 1, invoked_skills: 1 }, attachments_skills: ['demo'], attachments_back: 0, advisor_blocks: 0 });
    expect(record.attachments_dropped_tokens).toBe(rate(INSTR, SKILLS, INVOKED));
    expect(record.attachments_kinds_tokens.instructions).toBe(rate(INSTR));
    expect(record.attachments_resent_tokens).toBe(rate(INSTR, SKILLS)); // the host announces the instructions and the list again, never the used skills
  });

  it('without the API form nothing is taken off: the rows keep their handles and the record says null', async () => {
    const r = await run(HA, { api: 'not a list', messages: rows() });
    expect(compactRecord(r)).toMatchObject({ result: 'jev', attachments_dropped: null, rebuilt_user: 0 });
    expect(row(r, 'Second question').handle).toBe('h2');
  });

  it('the prediction counts what the attachments give back, less what the host announces again', async () => {
    const options = { event: { trigger: 'manual' } };
    const off = compactRecord(await run({ ...PREDICT, OMC_JEV_COMPACT_HOST_ATTACHMENTS: '0' }, options));
    const on = compactRecord(await run(PREDICT, options));
    const gone = on.attachments_dropped_tokens - on.attachments_resent_tokens;
    expect(gone).toBe(rate(INVOKED));
    expect(off.tokens_after_pred - on.tokens_after_pred).toBeGreaterThan(gone - 2);
    expect(off.tokens_after_pred - on.tokens_after_pred).toBeLessThan(gone + 2);
  });

  it('a row with [Image #N], a /goal record or a turn with an image keeps its handle, and its attachments come back', async () => {
    const messages = withRows([assistantRow('First answer.'), ownerRow('Look at [Image #1] please'), assistantRow('Seen.'), ownerRow('<command-name>/goal</command-name> finish all'), assistantRow('Goal set.'), ownerRow('Plain row')], 30);
    const r = await run(HA, { messages, extras: { 0: [INSTR], 2: [SKILLS], 4: [INVOKED] } });
    expect(row(r, 'Look at').handle).toBe('h2');
    expect(row(r, '<command-name>/goal').handle).toBe('h4');
    expect(row(r, 'Plain row').handle).toBeUndefined();
    expect(row(r, 'Task:').handle).toBeUndefined();
    const record = compactRecord(r);
    expect(record).toMatchObject({ rebuilt_user: 2, attachments_dropped: 1, attachments_back: 2 });
    expect(record.attachments_back_tokens).toBe(rate(SKILLS, INVOKED));
    const withImage = apiWith(rows(), { 2: [SKILLS] }).map((a, k) => (k === 2 ? { ...a, content: [...a.content, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] } : a));
    const image = await run(HA, { api: withImage });
    expect(row(image, 'Second question').handle).toBe('h2');
    expect(compactRecord(image)).toMatchObject({ attachments_dropped: 0, attachments_back: 1 });
  });

  it('a user row of text inside the open loop keeps its handle', async () => {
    const r = await run(HA, { messages: openLoop(), extras: {} });
    expect(row(r, 'Please fix it.').handle).toBeDefined();
    expect(compactRecord(r)).toMatchObject({ result: 'jev', rebuilt_user: 1 });
    expect(row(r, 'Task:').handle).toBeUndefined();
  });

  it('a message delivered after the text of a rebuilt row goes into the row in its envelope; with the switch off the row keeps its handle', async () => {
    const extras = { 2: [INSTR, FRAME('Hello from the track.')] };
    const on = await run(HA, { extras });
    expect(row(on, 'Second question').text).toMatch(/^Second question\n<system-reminder id="jev-1">/);
    expect(row(on, 'Second question').text).toContain('Hello from the track.');
    expect(compactRecord(on)).toMatchObject({ rebuilt_user: 3, queued_other: 1, attachments_kinds: { instructions: 1 } }); // the message is no attachment
    const off = await run(ACTIVE_ENV, { extras });
    expect(row(off, 'Second question').handle).toBe('h2');
    expect(row(off, 'Second question').text).not.toContain('Hello from the track.');
  });

  it('the envelopes a rebuilt row of text gets for its deliveries come on top of the prediction', async () => {
    const options = (extras) => ({ extras, event: { trigger: 'manual' } });
    const without = compactRecord(await run(PREDICT, options({})));
    const withFrame = compactRecord(await run(PREDICT, options({ 2: [FRAME('Hello from the track.')] })));
    expect(withFrame.queued_other).toBe(1);
    const growth = withFrame.tokens_after_pred - without.tokens_after_pred;
    expect(growth).toBeGreaterThan(10);
    expect(growth).toBeLessThan(40);
  });

  it('an attachment folded into the content of a rebuilt result row is counted as taken off and not predicted twice', async () => {
    const messages = rows();
    const plain = apiWith(messages, {});
    const folded = plain.map((a) => ({ ...a, content: a.content.map((b) => (b.type === 'tool_result' && b.tool_use_id === 't1' ? { ...b, content: `${b.content}\n\n${INVOKED}` } : b)) }));
    const without = compactRecord(await run(PREDICT, { messages, api: plain, event: { trigger: 'manual' } }));
    const withFold = compactRecord(await run(PREDICT, { messages, api: folded, event: { trigger: 'manual' } }));
    expect(withFold).toMatchObject({ attachments_dropped: 1, attachments_kinds: { invoked_skills: 1 } });
    expect(without.attachments_dropped).toBe(0);
    expect(withFold.tokens_after_pred).toBe(without.tokens_after_pred);
  });

  it('an envelope of the module is no attachment, and an escaped opener is read as the row it shows', async () => {
    const messages = withRows([assistantRow('First answer.'), ownerRow('<system-reminder>\nmy pasted note\n</system-reminder>')], 30);
    const own = '<system-reminder id="jev-1">\nsome carried text\n</system-reminder id="jev-1">';
    const api = apiWith(messages, { 0: [own] });
    const pasted = (b) => b.text?.startsWith('<system-reminder>\nmy pasted');
    const escaped = api.map((a) => ({ ...a, content: a.content.map((b) => (a.role === 'user' && pasted(b) ? { ...b, text: b.text.replace('<system-reminder>', '&lt;system-reminder>') } : b)) }));
    expect(compactRecord(await run(HA, { messages, api: escaped }))).toMatchObject({ attachments_dropped: 0 });
    // The assistant message before the turn cannot be placed, so the bounds of the turn come from the row found through the escaped opener.
    const lost = escaped.map((a) => (a.role === 'assistant' && a.content.some((b) => b.text === 'First answer.') ? { ...a, content: [{ type: 'text', text: 'Another text' }] } : a));
    const found = await run(HA, { messages, api: lost });
    expect(row(found, '<system-reminder>\nmy pasted').handle).toBeUndefined();
    expect(row(found, 'Task:').handle).toBeUndefined();
  });

  it('each kind of attachment is told by the first line the host renders it with, and is announced again or not as the kind says', async () => {
    const kinds = {
      instructions: 'Codebase and user instructions are shown below.\nx', instructions_reread: 'Instruction files were re-read after the change.',
      session_context: "As you answer the user's questions, you can use the following context:\nx", skill_listing: 'New skills discovered in /x:\n- a',
      agent_listing: 'New agent types are now available for the Agent tool:\n- a', deferred_tools: 'The following tools just became available:\n- a',
      mcp_instructions: '# MCP Server Instructions\n\n## a', environment: '# Environment\nYou have been invoked in', environment_update: '# Environment update\nx',
      model: 'You are powered by the model named M.', language: '# Language\nAlways respond in English.', date: "Today's date is 2000-01-01.",
      date_change: 'The date has changed. Today is 2000-01-02.', advisor_tool: '# Advisor Tool\nx', auto_mode: 'While auto mode is active, x',
      remote_session_change: 'From here on, do not add attribution lines x', invoked_skills: 'The following skills were invoked EARLIER in this session:\n\n### Skill: s\nx',
      file: 'Called the Read tool with the following input: {}', compact_file_reference: 'Note: /x/a.ts was read before the last conversation was summarized, but it is too large',
      hook_session_start: 'SessionStart:compact hook additional context: x', hook_context: 'UserPromptSubmit hook additional context: x', task_status: 'Background shell abc finished.',
      edited_file: 'Note: /x/a.ts changed on disk since you last read it', nested_memory: 'Contents of /x/notes.md:\nx',
      image_paths: 'The 2 attached images, in display order, are also saved at /x', host_reminder: "The task tools haven't been used recently.",
    };
    const record = compactRecord(await run(HA, { extras: { 0: Object.values(kinds).map(reminder) } }));
    expect(record.attachments_kinds).toEqual(Object.fromEntries(Object.keys(kinds).map((kind) => [kind, 1])));
    // Announced again: the kinds the host rebuilds from its settings, the lists whose entries do not come back and the hooks of the session start.
    const again = ['instructions', 'session_context', 'environment', 'model', 'language', 'date', 'advisor_tool', 'auto_mode', 'remote_session_change', 'skill_listing', 'agent_listing', 'deferred_tools', 'mcp_instructions', 'hook_session_start'];
    expect(record.attachments_resent_tokens).toBe(rate(...again.map((kind) => reminder(kinds[kind]))));
    expect(record.attachments_skills).toEqual(['s']);
  });

  it('the second wording of the deferred tools and of the reminders of the host is read as its kind', async () => {
    const lines = ['Definitions of the following tools were loaded earlier:\n- a', 'The following deferred tools are no longer available:\n- b', '<total_tokens> 5 tokens left', "The user's message contains /check"];
    const record = compactRecord(await run(HA, { extras: { 0: lines.map(reminder) } }));
    expect(record.attachments_kinds).toEqual({ deferred_tools: 2, host_reminder: 2 });
  });

  it('of what comes back with a kept row the host announces only what is still missing', async () => {
    const listed = reminder(`The following skills are available for use with the Skill tool:\n\n- a: ${para('desc', 3000)}`);
    const added = reminder(`New skills discovered in /x/skills:\n\n- b: ${para('desc', 500)}`);
    const session = reminder(`SessionStart:compact hook additional context: ${para('note', 800)}`);
    const messages = withRows([assistantRow('First answer.'), ownerRow('Look at [Image #1] please'), assistantRow('Seen.'), ownerRow('Plain row'), assistantRow('Third answer.')], 30);
    const record = compactRecord(await run(HA, { messages, extras: { 2: [added, INSTR, session], 4: [listed, INSTR, session] } }));
    expect(record).toMatchObject({ rebuilt_user: 2, attachments_dropped: 3, attachments_back: 3 });
    // The list: the entries that did not come back. The instructions: nothing, as one came back. The session hook: again, whatever came back.
    expect(record.attachments_resent_tokens).toBe(Math.round(0.43 * (listed.length - added.length + session.length)));
  });

  it('a skill loaded as a meta text is counted with the last segment of its directory', async () => {
    const record = compactRecord(await run(HA, { extras: { 0: ['Base directory for this skill: /x/skills/review-notes/\n\n# Review notes', 'A hook continues the turn.'] } }));
    expect(record).toMatchObject({ attachments_kinds: { skill_text: 1, meta: 1 }, attachments_skills: ['review-notes'] });
  });
});

describe('HOST_ATTACHMENTS: a row the host flags isMeta', () => {
  // A row of a hook with no known prefix stands between the question of the user, with its answer, and the open loop.
  const QUESTION = 'Real question: fix the parser.';
  const NOTE = 'Keep going until the tests pass.';
  const flagged = () => frozen([
    ...conversation(30).slice(0, -2),
    ownerRow(`${QUESTION}\n\n<pasted_content id="1">${para('log', 3000)}</pasted_content>\n\n${para('detail', 300)}`),
    assistantRow('FINAL ANSWER is here.'),
    { role: 'user', text: NOTE, isMeta: true },
    { role: 'assistant', text: 'Working.', toolUses: [{ tool_use_id: 'z1', tool: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', text: '', toolResults: [{ tool_use_id: 'z1', text: 'a.ts b.ts', isError: false }] },
  ]);

  it('keeps its handle and its flag through two compactions, so the next one still protects the message of the user', async () => {
    const env = { ...HA, OMC_JEV_COMPACT_OWNER_TAIL: 'active' };
    const messages = flagged();
    const at = messages.findIndex((m) => m.text === NOTE);
    const first = await run(env, { messages, extras: { [at]: [INSTR] } });
    expect(compactRecord(first)).toMatchObject({ result: 'jev', owner_tail: { boundary: 'owner', violations: 0 }, attachments_back: 1 });
    expect(row(first, NOTE)).toMatchObject({ handle: `h${at}`, isMeta: true });
    const again = frozen(first.out.messages.map((m) => ({ ...m })));
    const second = await run(env, { messages: again, extras: {} });
    expect(compactRecord(second)).toMatchObject({ result: 'jev', owner_tail: { boundary: 'owner', violations: 0, protected_rows: 3 } });
    expect(again[compactRecord(second).owner_tail.from_idx].text.startsWith(QUESTION)).toBe(true);
    expect(row(second, NOTE).isMeta).toBe(true);
  });

  it('is not the newest message of the user for the paste stage of the next compaction', async () => {
    const stages = { ...HA, OMC_JEV_COMPACT_TAIL_BY_LOOP: 'active', OMC_JEV_COMPACT_PASTES: 'active', OMC_JEV_COMPACT_PASTE_MIN_CHARS: '400', OMC_JEV_COMPACT_PASTE_YES: '0.7' };
    const first = await run(HA, { messages: flagged(), extras: {} });
    const again = frozen(first.out.messages.map((m) => ({ ...m })));
    const second = await run(stages, { messages: again, extras: {} });
    // The paste of the newest message of the user stays, as that message does.
    expect(row(second, QUESTION).text).toContain('<pasted_content id="1">');
    expect(compactRecord(second).pastes).toMatchObject({ tags: 0 });
  });

  it('as the carrier of the advisor reminder it cannot be rebuilt: the compaction goes to the summary', async () => {
    const messages = flagged();
    const at = messages.findIndex((m) => m.text === NOTE);
    expect(compactRecord(await run(HA, { messages, extras: { [at]: [ADVISOR] } }))).toMatchObject({ result: 'fallback', reason: 'advisor_meta_row' });
  });
});

describe('HOST_ATTACHMENTS: the newest message of the user', () => {
  const FILE = reminder('Called the Read tool with the following input: {"file_path":"/x/a.ts"}');
  const HOOK = reminder('UserPromptSubmit hook additional context: use the project rules.');
  const DATE = reminder("Today's date is 2000-01-01.");
  const ASKED = 'Fix the bug in @src/a.ts please.';
  // The message the open loop works on stands before it; an older message of the user stands at row 0.
  const working = (...after) => frozen([
    ...conversation(30).slice(0, -2),
    ownerRow(ASKED),
    ...after,
    { role: 'assistant', text: 'Working.', toolUses: [{ tool_use_id: 'z1', tool: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', text: '', toolResults: [{ tool_use_id: 'z1', text: 'a.ts b.ts', isError: false }] },
  ]);
  const NEWEST = 61;

  it.each([
    ['alone', {}],
    ['with the owner tail and the tail by the open loop', { OMC_JEV_COMPACT_OWNER_TAIL: 'active', OMC_JEV_COMPACT_TAIL_BY_LOOP: 'active' }],
  ])('keeps its handle, so its files and hook contexts come back, %s; older rows lose theirs', async (_, extra) => {
    const r = await run({ ...HA, ...extra }, { messages: working(), extras: { 0: [INVOKED], [NEWEST]: [FILE, HOOK] } });
    expect(row(r, ASKED).handle).toBe(`h${NEWEST}`);
    expect(row(r, 'Task:').handle).toBeUndefined();
    expect(compactRecord(r)).toMatchObject({ result: 'jev', rebuilt_user: 1, attachments_kinds: { invoked_skills: 1 }, attachments_back: 2 });
    expect(compactRecord(r).attachments_back_tokens).toBe(rate(FILE, HOOK));
  });

  it('keeps the handles of the rows after it in its turn, the one the attachments are counted with among them', async () => {
    const monitor = '<ci-monitor-event>the build is red</ci-monitor-event>';
    const messages = working(ownerRow(monitor));
    const r = await run(HA, { messages, extras: { [NEWEST + 1]: [FILE] } });
    expect(row(r, ASKED).handle).toBe(`h${NEWEST}`);
    expect(row(r, monitor).handle).toBe(`h${NEWEST + 1}`);
    expect(compactRecord(r)).toMatchObject({ attachments_dropped: 0, attachments_back: 1 });
  });

  it('is the newest row with words of the user: a later row of a hook is rebuilt like an older one', async () => {
    const hook = 'Stop hook feedback: keep going';
    const messages = frozen([...conversation(30).slice(0, -2), ownerRow(ASKED), assistantRow('Done.'), ownerRow(hook), assistantRow('Going on.')]);
    const r = await run(HA, { messages, extras: { [NEWEST]: [FILE], [NEWEST + 2]: [HOOK] } });
    expect(row(r, ASKED).handle).toBe(`h${NEWEST}`);
    expect(row(r, hook).handle).toBeUndefined();
    expect(compactRecord(r)).toMatchObject({ attachments_kinds: { hook_context: 1 }, attachments_back: 1 });
  });

  it('is rebuilt for the advisor reminder only when the host announces again every attachment of its turn', async () => {
    const lossless = await run(HA, { messages: working(), extras: { [NEWEST]: [ADVISOR, DATE] } });
    expect(compactRecord(lossless)).toMatchObject({ result: 'jev', advisor_blocks: 1, attachments_dropped: 2 });
    expect(row(lossless, ASKED).handle).toBeUndefined();
    const lossy = await run(HA, { messages: working(), extras: { [NEWEST]: [ADVISOR, FILE] } });
    expect(compactRecord(lossy)).toMatchObject({ result: 'fallback', reason: 'advisor_newest_row' });
  });
});

describe('HOST_ATTACHMENTS: the advisor', () => {
  it('a reminder in the turn of a row of text rebuilds that row; the record counts the reminders', async () => {
    const r = await run(HA, { extras: { 2: [ADVISOR] } });
    expect(compactRecord(r)).toMatchObject({ result: 'jev', advisor_blocks: 1, attachments_kinds: { advisor_tool: 1 } });
    expect(row(r, 'Second question').handle).toBeUndefined();
  });

  it('each of the three forms is one reminder and rebuilds the row of its turn; a quoted look-alike is none', async () => {
    const forms = [ADVISOR, reminder('The advisor tool is available; the advisor instructions announced earlier apply.'), reminder('The advisor tool is no longer available; disregard the earlier advisor instructions.')];
    for (const form of forms) {
      const r = await run(HA, { extras: { 2: [form] } });
      expect(compactRecord(r), form).toMatchObject({ result: 'jev', advisor_blocks: 1 });
      expect(row(r, 'Second question').handle).toBeUndefined();
    }
    expect(compactRecord(await run(HA, { extras: { 2: ['<system-reminder># Advisor Tool</system-reminder>'] } }))).toMatchObject({ advisor_blocks: 0 });
  });

  it('a /goal record in a turn keeps every row of that turn and hands an advisor reminder of it to the summary', async () => {
    const messages = withRows([assistantRow('First answer.'), ownerRow('<command-name>/goal</command-name> finish all'), ownerRow('Plain after the goal')], 30);
    const plain = await run(HA, { messages, extras: {} });
    expect(row(plain, '<command-name>/goal').handle).toBe('h2');
    expect(row(plain, 'Plain after the goal').handle).toBe('h3');
    expect(row(plain, 'Task:').handle).toBeUndefined();
    expect(compactRecord(await run(HA, { messages, extras: { 3: [ADVISOR] } }))).toMatchObject({ result: 'fallback', reason: 'advisor_command' });
  });

  it('a carrier that cannot be rebuilt without a loss hands the compaction to the summary: image, /goal record, open loop, cut form', async () => {
    const withImage = apiWith(rows(), { 2: [ADVISOR] }).map((a, k) => (k === 2 ? { ...a, content: [...a.content, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] } : a));
    expect(compactRecord(await run(HA, { api: withImage }))).toMatchObject({ result: 'fallback', reason: 'advisor_image' });
    const goal = withRows([assistantRow('First answer.'), ownerRow('<command-name>/goal</command-name> finish')], 30);
    expect(compactRecord(await run(HA, { messages: goal, extras: { 2: [ADVISOR] } }))).toMatchObject({ result: 'fallback', reason: 'advisor_command' });
    expect(compactRecord(await run(HA, { messages: openLoop(), extras: { 61: [ADVISOR] } }))).toMatchObject({ result: 'fallback', reason: 'advisor_in_tail' });
    const long = withRows([], 2100); // more rows than a cut form can show
    expect(compactRecord(await run(HA, { messages: long, api: apiWith(long).slice(-2000) }))).toMatchObject({ result: 'fallback', reason: 'advisor_form_cut' });
  });

  it('with the switch off an advisor reminder blocks nothing', async () => {
    const record = compactRecord(await run(ACTIVE_ENV, { extras: { 2: [ADVISOR] } }));
    expect(record.result).toBe('jev');
    expect(record).not.toHaveProperty('advisor_blocks');
  });
});

describe('HOST_ATTACHMENTS with the other switches', () => {
  it('a protected row of the owner tail stays word for word when it is rebuilt, with a delivered message after it', async () => {
    // The newest message of the user is rebuilt only for the advisor, when its turn holds nothing that would be lost.
    const messages = frozen([...conversation(30).slice(0, -2), ownerRow('Please finish it.'), assistantRow('FINAL ANSWER is here.')]);
    const at = messages.length - 2;
    const r = await run({ ...HA, OMC_JEV_COMPACT_OWNER_TAIL: 'active' }, { messages, extras: { 0: [INSTR], [at]: [ADVISOR, FRAME('Status of the track.')] } });
    expect(compactRecord(r)).toMatchObject({ result: 'jev', owner_tail_applied: true, owner_tail: { violations: 0, from_idx: at }, rebuilt_user: 2 });
    const owner = row(r, 'Please finish it.');
    expect(owner.handle).toBeUndefined();
    expect(owner.text).toMatch(/^Please finish it\.\n<system-reminder id="jev-1">/);
    expect(r.out.messages.some((m) => m.text?.includes('FINAL ANSWER is here.'))).toBe(true);
  });

  it('with series of traces the attachments go, and neither a request nor a file holds the made-up key of an attachment or of a trace', async () => {
    const key = ['gsk_', 'a1B2c3D4', 'e5F6g7H8', 'i9J0k1L2'].join('');
    const skill = reminder(`The following skills were invoked EARLIER in this session:\n\n### Skill: demo\nUse the key ${key} for the call.`);
    const traces = (word) => Array.from({ length: 6 }, (_, k) => `[compacted] Bash(echo ${k === 3 ? word : `note-${k}`}) - result of ${1000 + k} chars removed`).join('\n');
    // Jev keeps every block and result and rates every series of traces 0, so the series come down in the second round.
    const level = (body, q) => (body.state.items ? (body.state.items[q].kind === 'trace_series' ? 0 : 3) : body.state.blocks ? 3 : 0.6);
    const respond = (body) => okResponse({ answers: Object.fromEntries(Object.keys(body.questions).map((q) => [q, { type: 'score', score: level(body, q), confidence: 0.9 }])) });
    const compact = async (word) => {
      const list = [ownerRow('Task: look at the notes and report.')];
      for (let i = 1; i <= 40; i++) {
        const extra = i === 3 ? `\n\n${traces(word)}` : i === 7 ? `\n\n${traces('control')}` : '';
        list.push({ role: 'assistant', text: `Step ${i} note ${`detail${i} `.repeat(100)}${extra}`, toolUses: [{ tool_use_id: `t${i}`, tool: 'Bash', input: { command: `cat notes-${i}.txt` } }] });
        list.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${i}`, text: `RESULT-${i} ${'x'.repeat(5000)}`, isError: false }] });
      }
      list.push(ownerRow('Second question'), assistantRow('Summary: done.'));
      const messages = frozen(list);
      const env = { ...HA, OMC_JEV_COMPACT_BLOCKS: 'active', OMC_JEV_COMPACT_TARGET_PERCENT: '60' };
      const r = await compactOnce(messages, { env, api: apiWith(messages, { 0: [skill] }), respond, usage: hostUsage(190000) });
      expect(compactRecord(r)).toMatchObject({ result: 'jev', attachments_dropped: 1, attachments_kinds: { invoked_skills: 1 } });
      return { sent: r.calls.fetch.map((c) => c.init.body).join('\n'), written: [...r.files.values()].join('\n') };
    };
    const plain = await compact('plain-word');
    for (const text of [plain.sent, plain.written]) expect(text).toContain('echo plain-word'); // the series is asked about and written
    const masked = await compact(key);
    for (const text of [masked.sent, masked.written]) {
      expect(text).toContain('echo control'); // the series without a key still leaves
      expect(text).not.toContain(key.slice(4));
    }
  });

  it('with the verdicts on blocks, the thinking and the attachments come off the predictions once each', async () => {
    const env = { ...HA, OMC_JEV_COMPACT_BLOCKS: 'active', OMC_JEV_COMPACT_JEV_STAGES: 'active', OMC_JEV_COMPACT_TAIL_BY_LOOP: 'active', ...CASCADE };
    const paragraphs = Array.from({ length: 20 }, (_, k) => para(`word${k}`, 3000)).join('\n\n');
    const messages = withRows([ownerRow(paragraphs), assistantRow('First answer.'), ownerRow('Second question'), assistantRow('Second answer.')], 30, { chars: 4000 });
    const plain = apiWith(messages, { 0: [INSTR], 3: [SKILLS, INVOKED] });
    let chars = 0;
    const thinking = plain.map((a, k) => {
      if (a.role !== 'assistant') return a;
      const block = { type: 'thinking', thinking: 'T'.repeat(300 + k), signature: 'S'.repeat(700) };
      chars += block.thinking.length + block.signature.length;
      return { ...a, content: [block, ...a.content] };
    });
    const go = async (api) => compactOnce(messages, { env, api, usage: hostUsage(190000) });
    const without = compactRecord(await go(plain));
    const withThinking = compactRecord(await go(thinking));
    for (const record of [without, withThinking]) {
      expect(record).toMatchObject({ result: 'jev', blocks: { installed: true }, attachments_dropped: 3 });
      expect(record.floor_blocks_tokens).toBeGreaterThan(10000);
    }
    const removed = 0.2575 * chars; // RATE_SIG of the module
    expect(Math.abs(without.floor_pred - withThinking.floor_pred - removed)).toBeLessThanOrEqual(1);
    expect(Math.abs(without.tokens_after_pred - withThinking.tokens_after_pred - removed)).toBeLessThanOrEqual(1);
    expect(without.attachments_dropped_tokens).toBe(withThinking.attachments_dropped_tokens);
    // The accounting of the record is the other way to the same number; the prediction counts the header of the trace files, the accounting does not.
    const config = await readConfig(fakeDollar({ env }).$);
    const header = config.rates.RATE_TRACE * traceHeader(PASTES).length;
    expect(Math.abs(withThinking.tokens_after + header - withThinking.tokens_after_pred)).toBeLessThanOrEqual(2);
    expect(listTokens(thinking, config.rates)).toBeGreaterThan(listTokens(plain, config.rates));
  });
});

describe('HOST_ATTACHMENTS: the names of used skills in the record', () => {
  const used = (...names) => reminder(`The following skills were invoked EARLIER in this session:\n\n${names.map((name) => `### Skill: ${name}\nbody`).join('\n\n')}`);
  const loaded = (directory) => `Base directory for this skill: ${directory}\n\nDo the steps.`;
  const namesOf = async (texts, env = HA) => compactRecord(await run(env, { extras: { 2: texts } })).attachments_skills;

  it('masks a key in a name and cuts a long name', async () => {
    const key = ['gsk_', 'a1B2c3D4', 'e5F6g7H8', 'i9J0k1L2'].join('');
    const temporary = ['ASIA', 'QWER5TYU', 'IOP7ASDF'].join(''); // only the mask of a series knows this prefix
    const names = await namesOf([used(`deploy ${key}`, `sync ${temporary}`, 'n'.repeat(5000)), loaded(`/x/skills/run-${key}`)]);
    expect(names).toHaveLength(4);
    expect(JSON.stringify(names)).not.toContain(key.slice(4));
    expect(JSON.stringify(names)).not.toContain(temporary.slice(4));
    expect(names).toContain('n'.repeat(80));
    expect(names.some((name) => name.startsWith('deploy '))).toBe(true);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(80);
  });

  it('leaves out a name or a skill directory that names a private path of the list or a secret path', async () => {
    const env = { ...HA, OMC_JEV_COMPACT_PRIVATE_PATHS: '/x/clients,vault-notes' };
    const texts = [
      used('demo', 'read vault-notes', 'open /home/u/.ssh/id_rsa'),
      loaded('/x/clients/acme/skills/billing'),
      loaded('C:\\x\\clients\\skills\\drive'),
      loaded('/x/Clients/skills/audit'),
      loaded('/x/skills/pdf'),
    ];
    expect(await namesOf(texts, env)).toEqual(['demo', 'pdf']);
    expect(await namesOf(texts)).toEqual(['demo', 'read vault-notes', 'billing', 'drive', 'audit', 'pdf']);
  });

  it('records the last part of a skill directory written with either slash, and at most 50 names', async () => {
    expect(await namesOf([loaded('C:\\Users\\someone\\.claude\\skills\\sheet\\'), loaded('/x/skills/slides//')])).toEqual(['sheet', 'slides']);
    const many = Array.from({ length: 60 }, (_, k) => `skill-${k}`);
    expect(await namesOf([used(...many)])).toEqual(many.slice(0, 50));
  });

  it('reads a skill directory that is a long run of slashes in linear time', async () => {
    const t0 = performance.now();
    const names = await namesOf([loaded(`${'/'.repeat(100_000)}tail`)]);
    expect(performance.now() - t0).toBeLessThan(2500);
    expect(names).toEqual(['tail']);
  });
});

describe('HOST_ATTACHMENTS: the estimate of the own threshold', () => {
  // Whether the end of a turn asks the host for a compaction.
  const asks = async (env, messages, extras, usage) => {
    const fake = fakeDollar({ env, messages, api: apiWith(messages, extras), usage });
    await load()['turn.complete'](fake.$, Object.freeze({ isAborted: false }), async () => ({}));
    return fake.calls.compact;
  };

  it('counts the attachments that go in the floor it checks before it asks', async () => {
    // The results alone cut less than the 30 % of the tokens that the skip of the own request asks for.
    const env = { ...ACTIVE_ENV, OMC_JEV_COMPACT_AT_PERCENT: '60', OMC_JEV_COMPACT_TARGET_PERCENT: '80', OMC_JEV_COMPACT_OWN_THRESHOLD: '1' };
    const usage = () => ({ context: { tokens: 165000, window: 200000 } });
    const messages = withRows([], 30, { chars: 3300 });
    const context = reminder(`UserPromptSubmit hook additional context: ${para('note', 40_000)}`);
    expect(await asks(env, messages, { 0: [context] }, usage)).toBe(0);
    expect(await asks({ ...env, ...SWITCH }, messages, { 0: [context] }, usage)).toBe(1);
    // Attachments that come back with the newest message of the user give nothing.
    expect(await asks({ ...env, ...SWITCH }, messages, { [messages.length - 2]: [context] }, usage)).toBe(0);
  });

  it('counts the envelopes of the rows of text it rebuilds, as the compaction does', async () => {
    // Many short rows of text, each with a delivered message: rebuilt, each carries it in an envelope, and the results then cut too little.
    const env = { ...ACTIVE_ENV, OMC_JEV_COMPACT_AT_PERCENT: '60' };
    const usage = () => ({ context: { tokens: 9000, window: 10000 } });
    const messages = withRows(Array.from({ length: 100 }, (_, k) => [assistantRow(para(`a${k}`, 600)), ownerRow(`Step ${k}.`)]).flat(), 10, { chars: 5200 });
    const extras = Object.fromEntries(Array.from({ length: 100 }, (_, k) => [2 * k + 2, [FRAME(`Status ${k}.`)]]));
    expect(await asks(env, messages, extras, usage)).toBe(1);
    expect(await asks({ ...env, ...SWITCH }, messages, extras, usage)).toBe(0);
    const compaction = compactRecord(await compactOnce(messages, { env: { ...env, ...SWITCH }, api: apiWith(messages, extras), usage }));
    expect(compaction).toMatchObject({ result: 'fallback', reason: 'too_few_results' });
  });
});

describe('HOST_ATTACHMENTS: linear time', () => {
  // Every text of the API form is read for attachments, so an opener that no line closes may not cost the length of the text again.
  it.each([
    ['reminders', '<system-reminder>\n', 60_000],
    ['reminders of the advisor', '\n\n<system-reminder>\n# Advisor Tool\n', 30_000],
  ])('a block full of openers of %s without a closing line is read in linear time', async (_, opener, count) => {
    const junk = `Note.${opener.repeat(count)}`;
    const t0 = performance.now();
    const r = await run(HA, { extras: { 2: [junk] } });
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(compactRecord(r)).toMatchObject({ result: 'jev', advisor_blocks: 0, attachments_dropped: 1, attachments_kinds: { meta: 1 } });
  });
});
