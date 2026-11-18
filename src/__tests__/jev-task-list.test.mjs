/**
 * Task-list storage and hooks: the state hook (PostToolUse), the batch hook, the
 * storage library (scripts/lib/jev-task-list.mjs). Every case runs the real
 * scripts in a temporary HOME and log directory; no network. The MCP tool and
 * the registry opt-in are covered in task-list-tool.test.ts.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { taskListTool } from '../tools/task-list-tools.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPTS = join(ROOT, 'scripts');
const HOOKS = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
const LIST_TOOL = 'mcp__plugin_oh-my-claudecode_t__task_list';
const TOTAL_MS = 120_000;

let TMP;
let DOM;
let LOGS;
let L;
let counter = 0;
const TRANSCRIPT = () => join(TMP, 'transcript.jsonl');

beforeAll(async () => {
  TMP = mkdtempSync(join(tmpdir(), 'omc-task-list-'));
  DOM = join(TMP, 'home');
  LOGS = join(TMP, 'logs');
  mkdirSync(DOM, { recursive: true });
  L = await import(pathToFileURL(join(SCRIPTS, 'lib', 'jev-task-list.mjs')).href);
});

afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

/** Environment of a hook process: opt-in on, log directory in the temporary directory. */
function envFor(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OMC_|DISABLE_OMC|TYPESAFE_|ANTHROPIC_|CLAUDE)/i.test(k)));
  Object.assign(env, { HOME: DOM, USERPROFILE: DOM, OMC_TASK_LIST: '1', OMC_TASK_LIST_LOG_DIR: LOGS });
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function run(argv, input, env = envFor()) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, argv, { cwd: TMP, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const guard = setTimeout(() => { child.kill(); fail(new Error(`${argv.join(' ')}: timeout`)); }, 30_000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(guard);
      let json = null;
      try { json = JSON.parse(stdout.trim().split('\n').pop()); } catch { /* stays null */ }
      done({ code, stdout, stderr, json });
    });
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}
const hook = (script, input, env) => run([join(SCRIPTS, script)], input, env);
// The same way hooks/hooks.json starts the state hook: through the runner.
const hookViaRunner = (script, input, env) => run([join(SCRIPTS, 'run.cjs'), join(SCRIPTS, script)], input, env);
const stan = (sid, tool, input, extra = {}) => hook('jev-task-list-state.mjs', postToolUse(sid, tool, input, extra));

const session = () => `test-task-list-${process.pid}-${++counter}`;
const listFile = (sid, key) => join(LOGS, 'lists', sid, `${key}.json`);
const readListFile = (sid, key) => (existsSync(listFile(sid, key)) ? JSON.parse(readFileSync(listFile(sid, key), 'utf8')) : null);
const listOf = (sid, key) => readListFile(sid, key);
const logRows = (name) => {
  const p = join(LOGS, name);
  return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
};
const eventFiles = (sid, key) => {
  const d = join(LOGS, 'lists', sid, `${key}.events`);
  return existsSync(d) ? readdirSync(d) : [];
};
const shape = (items) => items?.map(({ id, content, status, note }) => ({
  ...(id !== undefined ? { id } : {}),
  content,
  status,
  ...(note !== undefined ? { note } : {}),
}));
const statuses = (items) => items.map((x) => x.status).join(',');

function postToolUse(sid, tool_name, tool_input, extra = {}) {
  counter += 1;
  return {
    session_id: sid,
    transcript_path: TRANSCRIPT(),
    cwd: TMP,
    hook_event_name: 'PostToolUse',
    tool_name,
    tool_input,
    tool_use_id: `toolu_${counter}`,
    tool_response: { content: [{ type: 'text', text: 'ok' }] },
    ...extra,
  };
}

function batch(sid, names, extra = {}) {
  return {
    session_id: sid,
    transcript_path: TRANSCRIPT(),
    cwd: TMP,
    hook_event_name: 'PostToolBatch',
    tool_calls: names.map((x) => (typeof x === 'string' ? { tool_name: x, tool_input: {}, tool_use_id: `toolu_${++counter}`, tool_response: 'ok' } : x)),
    ...extra,
  };
}

describe('task list: state hook (PostToolUse)', () => {
  it('a subagent list call through the runner writes <agent_id>.json, not the main list', async () => {
    const sid = session();
    const w = await hookViaRunner('jev-task-list-state.mjs', postToolUse(sid, LIST_TOOL, {
      items: [
        { content: 'Step 1', status: 'in_progress', note: 'Reading the plan to learn the scope.' },
        { content: 'Step 2', status: 'pending' },
      ],
    }, { agent_id: 'a1b2', agent_type: 'oh-my-claudecode:executor' }));
    expect(w.code).toBe(0);
    expect(w.json).toEqual({ continue: true, suppressOutput: true });
    const l = listOf(sid, 'a1b2');
    expect(l.agent).toBe('a1b2');
    expect(l.agent_type).toBe('oh-my-claudecode:executor');
    expect(l.tool).toBe(LIST_TOOL);
    expect(l.updates).toBe(1);
    expect(shape(l.items)).toEqual([
      { content: 'Step 1', status: 'in_progress', note: 'Reading the plan to learn the scope.' },
      { content: 'Step 2', status: 'pending' },
    ]);
    expect(existsSync(listFile(sid, 'main'))).toBe(false);
  });

  it('advance, done and start move the list; a note stays while the same task stays in progress', async () => {
    const sid = session();
    const a = { agent_id: 'ag1' };
    await stan(sid, LIST_TOOL, { items: [{ content: 'A', status: 'in_progress', note: 'n1' }, { content: 'B', status: 'pending' }, { content: 'C', status: 'pending' }] }, a);
    await stan(sid, LIST_TOOL, { items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }, { content: 'C', status: 'pending' }] }, a);
    expect(listOf(sid, 'ag1').items[0].note).toBe('n1');
    await stan(sid, LIST_TOOL, { advance: true }, a);
    expect(statuses(listOf(sid, 'ag1').items)).toBe('completed,in_progress,pending');
    await stan(sid, LIST_TOOL, { done: [2], start: 3 }, a);
    const after = listOf(sid, 'ag1');
    expect(statuses(after.items)).toBe('completed,completed,in_progress');
    expect(after.updates).toBe(4);
    await stan(sid, LIST_TOOL, { advance: true }, a);
    expect(listOf(sid, 'ag1').items.every((x) => x.status === 'completed')).toBe(true);
  });

  it('an invalid call and tools outside the list change nothing', async () => {
    const sid = session();
    await stan(sid, LIST_TOOL, { items: [{ content: 'A', status: 'pending' }] }, { agent_id: 'ag2' });
    for (const [tool, input] of [[LIST_TOOL, {}], [LIST_TOOL, { items: [] }], [LIST_TOOL, { items: [{ content: 'X', status: 'bad' }] }], ['Bash', { command: 'ls' }], ['Read', { file_path: 'a.ts' }]]) {
      await stan(sid, tool, input, { agent_id: 'ag2' });
    }
    expect(listOf(sid, 'ag2').updates).toBe(1);
    expect(listOf(sid, 'ag2').items).toHaveLength(1);
  });

  it('the desktop copy of the tool name and items sent as JSON text are accepted', async () => {
    const sid = session();
    await stan(sid, 'mcp__t__task_list', { items: JSON.stringify([{ content: 'Z', status: 'in_progress' }]) }, { agent_id: 'ag3' });
    expect(listOf(sid, 'ag3')?.items?.[0]?.content).toBe('Z');
  });

  it('update_plan and wrap_up in the main thread write main.json', async () => {
    const sid = session();
    await stan(sid, 'mcp__ccd_turn__update_plan', { items: [{ content: 'Plan 1', status: 'in_progress' }, { content: 'Plan 2', status: 'pending' }], scope: 'first_task' }, { prompt_id: 'p1' });
    const first = listOf(sid, 'main');
    expect(first.items).toHaveLength(2);
    expect(first.prompt_id).toBe('p1');
    expect(first.items[0].note).toBeUndefined();
    await stan(sid, 'mcp__ccd_turn__update_plan', { advance: true });
    expect(statuses(listOf(sid, 'main').items)).toBe('completed,in_progress');
    await stan(sid, 'mcp__ccd_turn__wrap_up', { recap: 'done' });
    expect(listOf(sid, 'main').items.every((x) => x.status === 'completed')).toBe(true);
  });

  it('TaskCreate with text and object results; TaskUpdate of another agent\'s task moves nothing; a reused number stays with the first creator', async () => {
    const sid = session();
    await stan(sid, 'TaskCreate', { subject: 'TEST task list 7', description: 'description 7' }, { agent_id: 'ag4', tool_response: 'Task #7 created successfully: TEST task list 7' });
    await stan(sid, 'TaskCreate', { subject: 'Task 8' }, { agent_id: 'ag4', tool_response: { task: { id: '8', subject: 'Task 8' } } });
    let l = listOf(sid, 'ag4');
    expect(shape(l.items)).toEqual([
      { id: '7', content: 'TEST task list 7', status: 'pending', note: 'description 7' },
      { id: '8', content: 'Task 8', status: 'pending' },
    ]);
    await stan(sid, 'TaskUpdate', { taskId: '7', status: 'completed' }, { agent_id: 'ag5', tool_response: 'Updated task #7 status' });
    expect(existsSync(listFile(sid, 'ag5'))).toBe(false);
    expect(listOf(sid, 'ag4').items[0].status).toBe('pending');
    // the first creator keeps the claim of a task number for the session: a later claim of the same number is refused
    await stan(sid, 'TaskCreate', { subject: 'Taken 7' }, { agent_id: 'ag5', tool_response: 'Task #7 created successfully: Taken 7' });
    expect(existsSync(listFile(sid, 'ag5'))).toBe(false);
    expect(listOf(sid, 'ag4').items[0].content).toBe('TEST task list 7');
    await stan(sid, 'TaskUpdate', { taskId: '7', status: 'in_progress', description: 'note 7' }, { agent_id: 'ag4' });
    await stan(sid, 'TaskUpdate', { taskId: '8', status: 'deleted' }, { agent_id: 'ag4' });
    l = listOf(sid, 'ag4');
    expect(l.items).toHaveLength(1);
    expect(l.items[0].status).toBe('in_progress');
    expect(l.items[0].note).toBe('note 7');
    await stan(sid, 'TaskCreate', { subject: 'No number' }, { agent_id: 'ag4', tool_response: 'something else' });
    expect(listOf(sid, 'ag4').items).toHaveLength(1);
  });

  it('TodoWrite replaces the list', async () => {
    const sid = session();
    await stan(sid, 'TodoWrite', { todos: [{ content: 'T1', status: 'in_progress', activeForm: 'Doing T1' }, { content: 'T2', status: 'pending', activeForm: 'x' }] }, { agent_id: 'ag6' });
    expect(listOf(sid, 'ag6').items.map((x) => `${x.content}:${x.status}`).join(',')).toBe('T1:in_progress,T2:pending');
  });

  it('a key-like string is masked; a bad session id and a bad agent id write nothing outside the lists', async () => {
    const sid = session();
    const key = `sk-ant-${'a1B2c3D4e5'.repeat(3)}`;
    await stan(sid, LIST_TOOL, { items: [{ content: `Check ${key}`, status: 'in_progress', note: `token=${key}` }] }, { agent_id: 'ag7' });
    const text = readFileSync(listFile(sid, 'ag7'), 'utf8');
    expect(text).not.toContain(key.slice(7));
    expect(text).toContain('***');
    await stan('../escape', LIST_TOOL, { items: [{ content: 'A', status: 'pending' }] }, { agent_id: 'ag8' });
    await stan(sid, LIST_TOOL, { items: [{ content: 'A', status: 'pending' }] }, { agent_id: '../ag9' });
    expect(existsSync(join(LOGS, 'escape'))).toBe(false);
    expect(existsSync(join(LOGS, 'lists', 'escape'))).toBe(false);
    expect(existsSync(listFile(sid, 'main'))).toBe(false);
    expect(readdirSync(join(LOGS, 'lists', sid)).some((f) => /^___ag9-[0-9a-f]{10}\.json$/.test(f))).toBe(true);
  });

  it('OMC_SKIP_HOOKS=task-list and DISABLE_OMC=1 switch the write off', async () => {
    const sid = session();
    for (const env of [{ OMC_SKIP_HOOKS: 'task-list' }, { DISABLE_OMC: '1' }]) {
      const w = await hook('jev-task-list-state.mjs', postToolUse(sid, LIST_TOOL, { items: [{ content: 'A', status: 'pending' }] }, { agent_id: 'ag10' }), envFor(env));
      expect(w.json?.continue).toBe(true);
    }
    expect(existsSync(listFile(sid, 'ag10'))).toBe(false);
  });

  it('opt-in: without OMC_TASK_LIST=1 the hook writes nothing and still answers quietly', async () => {
    const sid = session();
    const offLogs = join(TMP, 'off-logs');
    const w = await hook('jev-task-list-state.mjs', postToolUse(sid, LIST_TOOL, { items: [{ content: 'A', status: 'pending' }] }, { agent_id: 'off1' }), envFor({ OMC_TASK_LIST: undefined, OMC_TASK_LIST_LOG_DIR: offLogs }));
    expect(w.code).toBe(0);
    expect(w.json).toEqual({ continue: true, suppressOutput: true });
    expect(existsSync(offLogs)).toBe(false);
  });

  it('the hook fails open on malformed input', async () => {
    for (const input of ['', 'not json', '[]']) {
      const w = await hook('jev-task-list-state.mjs', input);
      expect(w.code).toBe(0);
      expect(w.json).toEqual({ continue: true, suppressOutput: true });
    }
  });
});

describe('task list: batch hook (not registered)', () => {
  it('writes one row per batch for the main thread and a subagent, through the runner', async () => {
    const sid = session();
    const a = await hookViaRunner('jev-task-list-batch.mjs', batch(sid, ['Read', 'Grep'], { prompt_id: 'p1' }));
    const b = await hookViaRunner('jev-task-list-batch.mjs', batch(sid, ['Bash'], { agent_id: 'ab1', agent_type: 'oh-my-claudecode:executor' }));
    expect(a.code).toBe(0);
    expect(b.json).toEqual({ continue: true, suppressOutput: true });
    const rows = logRows('batches.jsonl').filter((x) => x.session_id === sid);
    expect(rows).toHaveLength(2);
    expect(rows[0].agent_id).toBeNull();
    expect(rows[0].n).toBe(2);
    expect(rows[0].tools.join(',')).toBe('Read,Grep');
    expect(rows[1].agent_id).toBe('ab1');
    expect(rows[1].agent_type).toBe('oh-my-claudecode:executor');
    expect(rows[1].n).toBe(1);
    expect(Number.isInteger(rows[1].ms)).toBe(true);
  });

  it('empty and malformed input do not fail', async () => {
    for (const input of ['', 'not json', '[]']) {
      const w = await hook('jev-task-list-batch.mjs', input);
      expect(w.code).toBe(0);
      expect(w.json).toEqual({ continue: true, suppressOutput: true });
    }
  });

  it('opt-in: without OMC_TASK_LIST=1 no row is written', async () => {
    const sid = session();
    await hook('jev-task-list-batch.mjs', batch(sid, ['Read']), envFor({ OMC_TASK_LIST: undefined }));
    expect(logRows('batches.jsonl').some((x) => x.session_id === sid)).toBe(false);
  });
});

describe('task list: storage library', () => {
  it('the state hook is not registered in hooks/hooks.json; the matcher shown in docs/HOOKS.md names exactly the list tools', () => {
    expect(JSON.stringify(HOOKS)).not.toContain('jev-task-list-state');
    const doc = readFileSync(join(ROOT, 'docs', 'HOOKS.md'), 'utf8');
    const section = doc.slice(doc.indexOf('#### Task List'));
    const snippet = JSON.parse(section.match(/```json\n([\s\S]*?)\n```/)[1]);
    const entry = snippet.hooks.PostToolUse[0];
    expect([...entry.matcher.split('|')].sort()).toEqual([...L.LIST_TOOL_NAMES].sort());
    expect(entry.hooks[0].timeout).toBe(3);
    expect(entry.hooks[0].command).toBe('node "<plugin-root>/scripts/run.cjs" "<plugin-root>/scripts/jev-task-list-state.mjs"');
    expect(L.LIST_TOOL_NAMES.every((name) => L.isListTool(name))).toBe(true);
  });

  it('the batch hook is not registered in hooks/hooks.json', () => {
    const text = JSON.stringify(HOOKS);
    expect(text).not.toContain('jev-task-list-batch');
    expect(text).not.toContain('PostToolBatch');
  });

  it('task-list.jsonl and batches.jsonl are rotated above 50 MB before the next row is appended', () => {
    const dir = mkdtempSync(join(TMP, 'rotate-'));
    const env = { OMC_TASK_LIST_LOG_DIR: dir };
    const rowsOf = (name) => readFileSync(join(dir, name), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    for (const name of ['task-list.jsonl', 'batches.jsonl']) {
      const stem = name.replace(/\.jsonl$/, '');
      const rotatedOf = () => readdirSync(dir).filter((file) => new RegExp(`^${stem}-\\d{8}-\\d{6}-\\d+\\.jsonl$`).test(file));
      // A sparse file at exactly the limit is kept: only a larger file is rotated.
      writeFileSync(join(dir, name), '{"old":1}\n');
      truncateSync(join(dir, name), L.LOG_MAX_BYTES);
      L.logRow(name, { event: 'at-limit' }, env);
      expect(rotatedOf()).toEqual([]);
      expect(statSync(join(dir, name)).size).toBeGreaterThan(L.LOG_MAX_BYTES);
      // The file now exceeds the limit: it moves aside whole and the next row starts a new file.
      L.logRow(name, { event: 'rotated' }, env);
      const rotated = rotatedOf();
      expect(rotated).toHaveLength(1);
      expect(statSync(join(dir, rotated[0])).size).toBeGreaterThan(L.LOG_MAX_BYTES);
      expect(rowsOf(name).map((row) => row.event)).toEqual(['rotated']);
      // The new file is small again: no further rotation.
      L.logRow(name, { event: 'after' }, env);
      expect(rotatedOf()).toEqual(rotated);
      expect(rowsOf(name).map((row) => row.event)).toEqual(['rotated', 'after']);
    }
  });

  it('isListTool: update_plan and wrap_up count only in the main thread', () => {
    expect(L.isListTool('mcp__ccd_turn__update_plan')).toBe(true);
    expect(L.isListTool('mcp__ccd_turn__update_plan', 'ag7')).toBe(false);
    expect(L.isListTool(LIST_TOOL, 'ag7')).toBe(true);
    expect(L.isListTool('Read')).toBe(false);
  });

  it('a subagent update_plan or wrap_up does not write a list', async () => {
    const sid = session();
    await stan(sid, 'mcp__ccd_turn__update_plan', { items: [{ content: 'A', status: 'in_progress' }] }, { agent_id: 'r7' });
    await stan(sid, 'mcp__ccd_turn__wrap_up', { recap: 'x' }, { agent_id: 'r7' });
    expect(existsSync(listFile(sid, 'r7'))).toBe(false);
    expect(existsSync(listFile(sid, 'main'))).toBe(false);
  });

  // Armored blocks are assembled at run time so no literal key header sits in the source.
  const armored = (dashes, label, body, pad = '') => {
    const bar = '-'.repeat(dashes);
    return `${bar}${pad}BEGIN ${label}${pad}${bar}\n${body}\n${bar}${pad}END ${label}${pad}${bar}`;
  };

  it('masking keeps task names and masks key, token and secret values only', async () => {
    const sid = session();
    const keep = ['File task-list-recovery-2026-11-10 to fix', 'Passed: 26 tests', 'tokens: 5 items', 'Key monkey=3 and task-list-abcdefghij'];
    const hide = [
      ['api_key=abcdef123456', 'abcdef123456'],
      [`ghp_${'a1'.repeat(10)}`, 'a1a1a1a1a1a1'],
      ['Bearer abcdefgh12345678', 'abcdefgh12345678'],
      ['AUTH_TOKEN: "xyz-secret-1"', 'xyz-secret-1'],
      ['db.password=Pass123', 'Pass123'],
      [`sk-ant-${'Q9'.repeat(8)}`, 'Q9Q9Q9Q9'],
      [armored(5, 'RSA PRIVATE KEY', 'MIIabc'), 'MIIabc'],
      [armored(5, 'PGP PRIVATE KEY BLOCK', 'SECRETPGPLIST'), 'SECRETPGPLIST'],
      [armored(4, 'SSH2 ENCRYPTED PRIVATE KEY', 'SECRETSSH2LIST', ' '), 'SECRETSSH2LIST'],
    ];
    const items = [...keep, ...hide.map(([c]) => c)].map((content) => ({ content, status: 'pending' }));
    await stan(sid, LIST_TOOL, { items: [{ content: 'Current', status: 'in_progress', note: 'Passed: 26 tests, secret_key=hidden999' }, ...items] }, { agent_id: 'r1' });
    const l = listOf(sid, 'r1');
    for (const c of keep) expect(l.items.some((x) => x.content === c)).toBe(true);
    const text = JSON.stringify(l);
    for (const [, secret] of hide) expect(text).not.toContain(secret);
    expect(l.items[0].note).toBe('Passed: 26 tests, secret_key=***');
  });

  it('an agent_id outside the safe pattern gets its own key; "main" and a missing id map as stated', async () => {
    const sid = session();
    await stan(sid, LIST_TOOL, { items: [{ content: 'A', status: 'pending' }] }, { agent_id: '../ag9' });
    await stan(sid, LIST_TOOL, { items: [{ content: 'B', status: 'pending' }] }, { agent_id: 'main' });
    expect(existsSync(listFile(sid, 'main'))).toBe(false);
    const files = readdirSync(join(LOGS, 'lists', sid)).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(2);
    expect(files.some((f) => /^___ag9-[0-9a-f]{10}\.json$/.test(f))).toBe(true);
    expect(files.some((f) => /^main-[0-9a-f]{10}\.json$/.test(f))).toBe(true);
    expect(L.agentKey({})).toBe('main');
    expect(L.agentKey({ agent_id: '' })).toBe('main');
    expect(L.agentKey({ agent_id: 'abc_1' })).toBe('abc_1');
    expect(L.agentKey({ agent_id: '../x' })).not.toBe(L.agentKey({ agent_id: '/.x' }));
  });

  it('dot session ids are refused', async () => {
    for (const sid of ['.', '..', '.hidden']) await stan(sid, LIST_TOOL, { items: [{ content: 'A', status: 'pending' }] });
    expect(existsSync(join(LOGS, 'lists', 'main.json'))).toBe(false);
    expect(existsSync(join(LOGS, 'lists', '.hidden'))).toBe(false);
  });

  it('a stale lock (over 60 s) is taken over only for the fold; a fresh foreign lock makes the event wait and logs lock_timeout', async () => {
    const sid = session();
    await stan(sid, LIST_TOOL, { items: [{ content: 'A', status: 'pending' }] }, { agent_id: 'r2' });
    const lock = `${listFile(sid, 'r2')}.lock`;
    writeFileSync(lock, 'old-token');
    const recent = new Date(Date.now() - 10_000);
    utimesSync(lock, recent, recent);
    await stan(sid, LIST_TOOL, { items: [{ content: 'B', status: 'pending' }] }, { agent_id: 'r2' });
    expect(listOf(sid, 'r2').items[0].content).toBe('A');
    expect(existsSync(lock)).toBe(true);
    expect(L.readList(sid, 'r2', envFor()).items[0].content).toBe('B');
    const long = new Date(Date.now() - 120_000);
    utimesSync(lock, long, long);
    await stan(sid, LIST_TOOL, { items: [{ content: 'B', status: 'pending' }] }, { agent_id: 'r2' });
    expect(listOf(sid, 'r2').items[0].content).toBe('B');
    expect(existsSync(lock)).toBe(false);
    writeFileSync(lock, 'foreign-token');
    const started = Date.now();
    await stan(sid, LIST_TOOL, { items: [{ content: 'C', status: 'pending' }] }, { agent_id: 'r2' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
    expect(listOf(sid, 'r2').items[0].content).toBe('B');
    expect(readFileSync(lock, 'utf8')).toBe('foreign-token');
    expect(logRows('task-list.jsonl').some((x) => x.event === 'lock_timeout' && x.file === 'r2.json')).toBe(true);
    rmSync(lock, { force: true });
  }, TOTAL_MS);

  it('advance, done and start without a list write nothing; an unreadable file survives advance but a replacing call overwrites it', async () => {
    const sid = session();
    for (const input of [{ advance: true }, { done: [1] }, { start: 1 }]) await stan(sid, LIST_TOOL, input, { agent_id: 'r3' });
    expect(existsSync(listFile(sid, 'r3'))).toBe(false);
    writeFileSync(listFile(sid, 'r3'), '{ broken');
    await stan(sid, LIST_TOOL, { advance: true }, { agent_id: 'r3' });
    await stan(sid, 'TaskCreate', { subject: 'X' }, { agent_id: 'r3', tool_response: 'Task #301 created successfully: X' });
    expect(readFileSync(listFile(sid, 'r3'), 'utf8')).toBe('{ broken');
    await stan(sid, LIST_TOOL, { items: [{ content: 'New', status: 'pending' }] }, { agent_id: 'r3' });
    expect(listOf(sid, 'r3').items[0].content).toBe('New');
  });

  it('more than 50 items keep the newest and count the dropped ones; a new task at 50 keeps itself', async () => {
    const sid = session();
    await stan(sid, 'TodoWrite', { todos: Array.from({ length: 55 }, (_, i) => ({ content: `T${i + 1}`, status: 'pending', activeForm: 'x' })) }, { agent_id: 'r8' });
    const l = listOf(sid, 'r8');
    expect(l.items).toHaveLength(50);
    expect(l.items[0].content).toBe('T6');
    expect(l.items[49].content).toBe('T55');
    expect(l.dropped).toBe(5);
    await stan(sid, 'TaskCreate', { subject: 'New 51' }, { agent_id: 'r8', tool_response: 'Task #851 created successfully: New 51' });
    const m = listOf(sid, 'r8');
    expect(m.items).toHaveLength(50);
    expect(m.items[49].content).toBe('New 51');
    expect(m.dropped).toBe(1);
  });

  it('start leaves exactly one task in progress; done keeps its own status', async () => {
    const sid = session();
    const a = { agent_id: 'r9' };
    await stan(sid, LIST_TOOL, { items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }, { content: 'C', status: 'pending' }] }, a);
    await stan(sid, LIST_TOOL, { start: 2 }, a);
    expect(statuses(listOf(sid, 'r9').items)).toBe('pending,in_progress,pending');
    await stan(sid, LIST_TOOL, { done: [2], start: 3 }, a);
    expect(statuses(listOf(sid, 'r9').items)).toBe('pending,completed,in_progress');
  });

  it('a note moves only to the same task still in progress; a note is dropped when the task is pending or completed', async () => {
    const sid = session();
    const a = { agent_id: 'r10' };
    await stan(sid, LIST_TOOL, { items: [{ content: 'A', status: 'in_progress', note: 'nA' }, { content: 'B', status: 'pending' }] }, a);
    await stan(sid, LIST_TOOL, { items: [{ content: 'A', status: 'pending' }, { content: 'B', status: 'in_progress', note: 'nB' }] }, a);
    expect(listOf(sid, 'r10').items[0].note).toBeUndefined();
    expect(listOf(sid, 'r10').items[1].note).toBe('nB');
    await stan(sid, LIST_TOOL, { advance: true }, a);
    expect(listOf(sid, 'r10').items.every((x) => x.note === undefined)).toBe(true);
    await stan(sid, LIST_TOOL, { items: [{ content: 'C', status: 'completed', note: 'nC' }] }, a);
    expect(listOf(sid, 'r10').items[0].note).toBeUndefined();
  });

  it('the main thread and a subagent in one session keep separate lists', async () => {
    const sid = session();
    await stan(sid, 'mcp__ccd_turn__update_plan', { items: [{ content: 'Main', status: 'in_progress' }] }, { prompt_id: 'p1' });
    await stan(sid, LIST_TOOL, { items: [{ content: 'Agent', status: 'in_progress' }] }, { agent_id: 'r12' });
    await stan(sid, 'mcp__ccd_turn__update_plan', { items: [{ content: 'Main 2', status: 'pending' }] }, { prompt_id: 'p1' });
    expect(listOf(sid, 'main').items[0].content).toBe('Main 2');
    expect(listOf(sid, 'r12').items[0].content).toBe('Agent');
  });

  it('ten parallel TaskCreate calls of one agent give ten tasks', async () => {
    const sid = session();
    await Promise.all(Array.from({ length: 10 }, (_, i) => stan(sid, 'TaskCreate', { subject: `Parallel ${i}` }, { agent_id: 'r11', tool_response: `Task #${900 + i} created successfully: Parallel ${i}` })));
    await hook('jev-task-list-batch.mjs', batch(sid, ['Read'], { agent_id: 'r11', agent_type: 'oh-my-claudecode:executor' }));
    const l = listOf(sid, 'r11');
    expect(l.items).toHaveLength(10);
    expect(new Set(l.items.map((x) => x.id)).size).toBe(10);
    expect(l.updates).toBe(10);
  }, TOTAL_MS);

  it('the batch row carries the time of the whole hook process', async () => {
    const sid = session();
    const ag = { agent_id: 'r14', agent_type: 'helper' };
    for (let i = 0; i < 4; i += 1) await hook('jev-task-list-batch.mjs', batch(sid, ['Read', 'Read', 'Read'], ag));
    const rows = logRows('batches.jsonl').filter((x) => x.session_id === sid);
    expect(rows).toHaveLength(4);
    expect(rows.every((x) => Number.isInteger(x.ms) && x.ms > 0 && x.agent === 'r14' && !('panel' in x))).toBe(true);
  });

  it('a task that does not change the list leaves no file and no event', async () => {
    const sid = session();
    await stan(sid, 'TaskUpdate', { taskId: '9999', status: 'completed' }, { agent_id: 'o4' });
    await stan(sid, LIST_TOOL, { advance: true }, { agent_id: 'o4' });
    expect(existsSync(listFile(sid, 'o4'))).toBe(false);
    expect(eventFiles(sid, 'o4')).toHaveLength(0);
    expect(L.readList(sid, 'o4', envFor())).toBeNull();
  });

  it('the event file keeps masked text, also for items sent as JSON text', async () => {
    const sid = session();
    const lock = `${listFile(sid, 'o5')}.lock`;
    mkdirSync(join(LOGS, 'lists', sid), { recursive: true });
    writeFileSync(lock, 'foreign');
    await stan(sid, LIST_TOOL, { items: JSON.stringify([{ content: 'Key api_key=SECRET123 in the file', status: 'pending' }]) }, { agent_id: 'o5' });
    const files = eventFiles(sid, 'o5');
    const text = files.map((f) => readFileSync(join(LOGS, 'lists', sid, 'o5.events', f), 'utf8')).join('');
    rmSync(lock, { force: true });
    expect(files).toHaveLength(1);
    expect(text).not.toContain('SECRET123');
    expect(L.readList(sid, 'o5', envFor()).items[0].content).toContain('api_key=***');
  });

  it('a reader folding before a locked write sees the same list as the file after it', async () => {
    const sid = session();
    const a = { agent_id: 'o2' };
    await stan(sid, LIST_TOOL, { items: [{ content: 'A', status: 'in_progress', note: 'n' }, { content: 'B', status: 'pending' }] }, a);
    await stan(sid, 'TaskCreate', { subject: 'C' }, { ...a, tool_response: 'Task #2001 created successfully: C' });
    await stan(sid, 'TaskUpdate', { taskId: '2001', status: 'in_progress' }, a);
    await stan(sid, LIST_TOOL, { advance: true }, a);
    const before = listOf(sid, 'o2');
    // an event written without the lock (the lock is held by a foreign process): a reader sees it at once, the file after the next fold
    const lock = `${listFile(sid, 'o2')}.lock`;
    writeFileSync(lock, 'foreign');
    const s = await stan(sid, LIST_TOOL, { done: [2] }, a);
    const reader = L.readList(sid, 'o2', envFor());
    const fileBefore = listOf(sid, 'o2');
    rmSync(lock, { force: true });
    const saved = L.syncList(sid, 'o2', envFor());
    const file = listOf(sid, 'o2');
    const strip = (r) => JSON.stringify({ ...r, folded: undefined, updated: undefined });
    expect(s.code).toBe(0);
    expect(JSON.stringify(fileBefore.items)).toBe(JSON.stringify(before.items));
    expect(reader.updates).toBe(before.updates + 1);
    expect(strip(reader)).toBe(strip(file));
    expect(strip(saved)).toBe(strip(file));
    expect(eventFiles(sid, 'o2')).toHaveLength(0);
    expect(file.items.find((x) => x.content === 'B').status).toBe('completed');
    expect(file.items).toHaveLength(3);
  }, TOTAL_MS);

  it('retention: 600 events are folded by one locked write that keeps all 600 names; the next fold trims them to 500', async () => {
    const sid = session();
    const dir = join(LOGS, 'lists', sid, 'o3.events');
    mkdirSync(dir, { recursive: true });
    const t = Date.now();
    for (let i = 0; i < 600; i += 1) {
      const ev = { ts: new Date(t + i).toISOString(), pid: 1, id: 'abcd0000', session_id: sid, tool_name: 'TaskCreate', tool_input: { subject: `R ${i}` }, agent_type: null, tool_use_id: `toolu_r${i}`, prompt_id: null, task_id: String(3000 + i) };
      writeFileSync(join(dir, `${String(t + i).padStart(13, '0')}-1-${i.toString(16).padStart(8, '0')}.json`), JSON.stringify(ev));
    }
    const reader = L.readList(sid, 'o3', envFor());
    const saved = L.syncList(sid, 'o3', envFor());
    const file = listOf(sid, 'o3');
    expect(reader.items).toHaveLength(50);
    expect(reader.dropped).toBe(1);
    expect(reader.updates).toBe(600);
    expect(reader.items.at(-1).id).toBe('3599');
    expect(file.updates).toBe(600);
    expect(file.folded).toHaveLength(600);
    expect(readdirSync(dir)).toHaveLength(0);
    expect(saved.items.at(-1).id).toBe('3599');
    await stan(sid, 'TaskCreate', { subject: 'After' }, { agent_id: 'o3', tool_response: 'Task #3600 created successfully: After' });
    const next = listOf(sid, 'o3');
    expect(next.updates).toBe(601);
    expect(next.items.at(-1).id).toBe('3600');
    expect(next.folded).toHaveLength(500);
    expect(readdirSync(dir)).toHaveLength(0);
  }, TOTAL_MS);

  it('under CPU load, 10 and 30 parallel TaskCreate calls of one agent all land, three runs each', async () => {
    const { spawn: spawnBusy } = await import('node:child_process');
    const busy = Array.from({ length: 8 }, () => spawnBusy(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore', windowsHide: true }));
    const report = [];
    let baseId = 1000;
    try {
      for (const count of [10, 30]) {
        for (let run = 0; run < 3; run += 1) {
          const sid = session();
          baseId += 100;
          const started = Date.now();
          await Promise.all(Array.from({ length: count }, (_, i) => stan(sid, 'TaskCreate', { subject: `Load ${i}` }, { agent_id: 'o1', tool_response: `Task #${baseId + i} created successfully: Load ${i}` })));
          const reader = L.readList(sid, 'o1', envFor());
          await hook('jev-task-list-batch.mjs', batch(sid, ['Read'], { agent_id: 'o1', agent_type: 'oh-my-claudecode:executor' }));
          const file = listOf(sid, 'o1');
          const ok = (l) => l?.items?.length === count && new Set(l.items.map((x) => x.id)).size === count && l.updates === count;
          expect(ok(reader), `reader ${count}/${run}`).toBe(true);
          expect(ok(file) && eventFiles(sid, 'o1').length === 0, `file ${count}/${run}`).toBe(true);
          report.push(`${count}:${file.items.length}/${count} (${Date.now() - started} ms)`);
        }
      }
    } finally {
      for (const p of busy) p.kill();
    }
    expect(report).toHaveLength(6);
  }, TOTAL_MS);
});

describe('task list: masking of quoted credentials and its cost', () => {
  const mask = (text) => L.maskListText(text);

  it('masks the whole value of a quoted credential, quoted field names included', () => {
    const cases = [
      ['Configure {"api_key":"plain-secret-value"}', 'Configure {"api_key":"***"}'],
      ['{"password":"correct horse battery staple"}', '{"password":"***"}'],
      ['{ "token" : "x y, z; w" , "name": "keep me"}', '{ "token" : "***" , "name": "keep me"}'],
      ["db_pass = 'a b c' rest", "db_pass = '***' rest"],
      ['pwd="a\\"b c" tail', 'pwd="***" tail'],
      ['password: "never closed and more', 'password: "***'],
      ['AUTH_TOKEN: "xyz-secret-1"', 'AUTH_TOKEN: "***"'],
      ['status:password=abc', 'status:password=***'],
      ['--api-key=abc and secret.key: v', '--api-key=*** and secret.key: ***'],
    ];
    for (const [input, expected] of cases) expect(mask(input), input).toBe(expected);
  });

  it('leaves task names and other quoted text alone, and masking twice changes nothing more', () => {
    for (const keep of ['Passed: 26 tests', 'tokens: 5 items', 'Key monkey=3 and task-list-abcdefghij', '{"name": "pass the key to Bob"}', 'password=""']) {
      expect(mask(keep), keep).toBe(keep);
    }
    for (const text of ['{"password":"a b c"}', 'x_secret_y = \'p q\'', 'token=abc password: "d e" Bearer abcdefgh12345678']) {
      expect(mask(mask(text)), text).toBe(mask(text));
    }
  });

  it('costs time linear in the length of the text: shapes that made the name rule square its input', () => {
    const shapes = {
      'a-a-': (n) => 'a-'.repeat(n / 2),
      'a.a.': (n) => 'a.'.repeat(n / 2),
      'x_x_': (n) => 'x_'.repeat(n / 2),
      'a=a=': (n) => 'a='.repeat(n / 2),
      'key=" ': (n) => 'key="'.repeat(n / 5),
      'unclosed': (n) => `password: "${'x'.repeat(n)}`,
    };
    for (const [name, make] of Object.entries(shapes)) {
      const text = make(200_000);
      const start = performance.now();
      mask(text);
      const ms = performance.now() - start;
      // a linear pass takes a few milliseconds; the square of 200 000 characters took minutes
      expect(ms, `${name}: ${Math.round(ms)} ms`).toBeLessThan(2000);
    }
  });
});

describe('task list: what an event keeps, and the journal cleanup', () => {
  const env = () => envFor();
  const call = (sid, tool, input, extra = {}, now = Date.now()) => L.recordListCall(postToolUse(sid, tool, input, extra), env(), now);
  const eventText = (sid, key) => eventFiles(sid, key).map((f) => readFileSync(join(LOGS, 'lists', sid, `${key}.events`, f), 'utf8')).join('');

  it('a TodoWrite of 150 tasks with a 1 MiB task keeps the newest 50, counts 100 dropped, and leaves no unreadable event', () => {
    const sid = session();
    const todos = Array.from({ length: 150 }, (_, i) => ({ content: i === 120 ? 'x'.repeat(1024 * 1024) : `Task ${i + 1}`, status: 'pending' }));
    const saved = call(sid, 'TodoWrite', { todos });
    expect(saved?.items).toHaveLength(50);
    expect(saved.items[0].content).toBe('Task 101');
    expect(saved.items[49].content).toBe('Task 150');
    expect(saved.dropped).toBe(100);
    const big = saved.items.find((x) => x.content.startsWith('xxxx'));
    expect(big.content).toHaveLength(500);
    expect(big.content.endsWith('…')).toBe(true);
    expect(eventFiles(sid, 'main')).toHaveLength(0);
    expect(statSync(listFile(sid, 'main')).size).toBeLessThan(L.RECORD_MAX_BYTES);
    expect(L.readList(sid, 'main', env()).items.map((x) => x.content)).toEqual(saved.items.map((x) => x.content));
  });

  it('a list of 50 tasks with the longest texts, in three-byte characters, stays far below the size the reader accepts', () => {
    const sid = session();
    const items = Array.from({ length: 50 }, (_, i) => ({ content: '€'.repeat(5000) + i, status: 'in_progress', note: '€'.repeat(5000) }));
    call(sid, LIST_TOOL, { items }, { agent_id: 'w1', agent_type: 'a'.repeat(5000), prompt_id: 'p'.repeat(5000) });
    const file = listFile(sid, 'w1');
    expect(statSync(file).size).toBeLessThan(L.RECORD_MAX_BYTES / 4);
    const record = readListFile(sid, 'w1');
    expect(record.items).toHaveLength(50);
    expect(record.agent_type).toHaveLength(200);
    expect(record.prompt_id).toHaveLength(200);
  });

  it('an event that would outgrow the reader is refused with a log row and no file', () => {
    const sid = session();
    // 600 000 task numbers are not shortened by any rule and serialize to about 1.2 MB
    const saved = call(sid, LIST_TOOL, { done: Array.from({ length: 600_000 }, () => 1) }, { agent_id: 'big' });
    expect(saved).toBeNull();
    expect(eventFiles(sid, 'big')).toHaveLength(0);
    expect(existsSync(listFile(sid, 'big'))).toBe(false);
    expect(logRows('task-list.jsonl').some((x) => x.event === 'event_too_large')).toBe(true);
  });

  it('the strings of a log row are cut to 200 characters, also inside a list', () => {
    L.logRow('batches.jsonl', { session_id: 's'.repeat(5000), agent_type: 'a'.repeat(5000), tools: ['T'.repeat(5000), 'Read'], n: 2 }, env());
    const row = logRows('batches.jsonl').pop();
    expect(row.session_id).toHaveLength(200);
    expect(row.agent_type).toHaveLength(200);
    expect(row.tools.map((x) => x.length)).toEqual([200, 4]);
    expect(row.n).toBe(2);
  });

  it('fields the list never reads are not written: a secret in an unknown field stays out of the event', () => {
    const sid = session();
    const lock = `${listFile(sid, 'meta')}.lock`;
    mkdirSync(join(LOGS, 'lists', sid), { recursive: true });
    writeFileSync(lock, 'foreign'); // the event stays on disk
    call(sid, LIST_TOOL, { items: [{ content: 'A', status: 'pending', extra: { apiKey: 'plain-secret-77' } }], metadata: { apiKey: 'plain-secret-88' } }, { agent_id: 'meta' });
    const text = eventText(sid, 'meta');
    rmSync(lock, { force: true });
    expect(text).toContain('"content":"A"');
    expect(text).not.toContain('plain-secret');
    expect(L.readList(sid, 'meta', env()).items[0].content).toBe('A');
  });

  it('an event file left behind after its fold is removed at the next fold, so it cannot replay after its name ages out', () => {
    const sid = session();
    const base = Date.now();
    call(sid, 'TodoWrite', { todos: [{ content: 'Old list', status: 'pending' }] }, {}, base);
    const first = readListFile(sid, 'main').folded[0];
    const dir = join(LOGS, 'lists', sid, 'main.events');
    expect(eventFiles(sid, 'main')).toHaveLength(0);
    // a fold interrupted after it published the list and before it removed the event: the same event file is back on disk
    const leftover = { ts: new Date(base).toISOString(), pid: 1, id: 'aaaaaaaa', session_id: sid, tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'Old list', status: 'pending' }] }, agent_type: null, tool_use_id: null, prompt_id: null };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, first), JSON.stringify(leftover));
    // no new event: the sync alone removes it
    L.syncList(sid, 'main', env());
    expect(eventFiles(sid, 'main')).toHaveLength(0);
    // and with a new event in the same fold
    writeFileSync(join(dir, first), JSON.stringify(leftover));
    call(sid, 'TodoWrite', { todos: [{ content: 'Current list', status: 'completed' }] }, {}, base + 1);
    expect(eventFiles(sid, 'main')).toHaveLength(0);
    // 520 later calls push the name out of `folded`; the list must still be the last one sent
    for (let i = 0; i < 520; i += 1) call(sid, 'TodoWrite', { todos: [{ content: `Later ${i}`, status: 'pending' }] }, {}, base + 10 + i);
    expect(readListFile(sid, 'main').folded).not.toContain(first);
    expect(readListFile(sid, 'main').items[0].content).toBe('Later 519');
    expect(L.readList(sid, 'main', env()).items[0].content).toBe('Later 519');
  }, TOTAL_MS);
});

describe('task list: session retention sweep', () => {
  const HOUR = 3600 * 1000;
  const root = () => join(LOGS, 'lists');
  const age = (path, ms, now) => utimesSync(path, new Date(now - ms), new Date(now - ms));
  const sessionDir = (name, ageMs, now) => {
    const dir = join(root(), name);
    mkdirSync(join(dir, 'main.events'), { recursive: true });
    writeFileSync(join(dir, 'main.json'), '{}');
    for (const entry of ['main.json', 'main.events']) age(join(dir, entry), ageMs, now);
    age(dir, ageMs, now);
    return dir;
  };
  const fresh = () => rmSync(root(), { recursive: true, force: true });

  it('removes a session directory older than seven days with everything in it and keeps a younger one', () => {
    fresh();
    const now = Date.now();
    const expired = sessionDir('expired', L.LISTS_MAX_AGE_MS + HOUR, now);
    const recent = sessionDir('recent', L.LISTS_MAX_AGE_MS - HOUR, now);
    L.sweep(envFor(), now);
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(join(recent, 'main.json'))).toBe(true);
  });

  it('never touches an entry whose name starts with a dot, and writes its marker', () => {
    fresh();
    const now = Date.now();
    const dotted = sessionDir('.keep', L.LISTS_MAX_AGE_MS * 2, now);
    L.sweep(envFor(), now);
    expect(existsSync(dotted)).toBe(true);
    expect(existsSync(join(root(), '.sweep'))).toBe(true);
  });

  it('runs at most once an hour: an expired directory survives a second sweep within the hour and goes after it', () => {
    fresh();
    const now = Date.now();
    L.sweep(envFor(), now); // writes the marker
    const late = sessionDir('late', L.LISTS_MAX_AGE_MS + HOUR, now);
    L.sweep(envFor(), now + 10 * 60 * 1000);
    expect(existsSync(late)).toBe(true);
    age(join(root(), '.sweep'), HOUR + 1000, now);
    L.sweep(envFor(), now);
    expect(existsSync(late)).toBe(false);
  });

  it('a session a list call just used is never swept, however old its directory was: the lock of the fold renews the age the sweep reads', () => {
    fresh();
    const now = Date.now();
    const sid = session();
    const dir = sessionDir(sid, L.LISTS_MAX_AGE_MS + HOUR, now);
    expect(L.recordListCall(postToolUse(sid, 'TodoWrite', { todos: [{ content: 'Back after a week', status: 'pending' }] }), envFor(), now)).not.toBeNull();
    expect(existsSync(dir)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'main.json'), 'utf8')).items[0].content).toBe('Back after a week');
  });

  it('keeps a directory that looks old when something in it, or in its event folder, was written lately', () => {
    fresh();
    const now = Date.now();
    const byEvent = sessionDir('by-event', L.LISTS_MAX_AGE_MS + HOUR, now);
    writeFileSync(join(byEvent, 'main.events', '1-1-aaaaaaaa.json'), '{}');
    age(byEvent, L.LISTS_MAX_AGE_MS + HOUR, now); // the writer of the event did not change the directory itself
    const byFile = sessionDir('by-file', L.LISTS_MAX_AGE_MS + HOUR, now);
    writeFileSync(join(byFile, 'main.json'), '{"updated":1}');
    L.sweep(envFor(), now);
    expect(existsSync(join(byEvent, 'main.events', '1-1-aaaaaaaa.json'))).toBe(true);
    expect(readFileSync(join(byFile, 'main.json'), 'utf8')).toBe('{"updated":1}');
    expect(readdirSync(root()).filter((n) => n.endsWith('.sweeping'))).toEqual([]);
  });

  it('removes a tree left under a hidden name by an earlier sweep once it is idle, and keeps it while it is not', () => {
    fresh();
    const now = Date.now();
    const idle = sessionDir('.old-session.0123456789ab.sweeping', L.LISTS_MAX_AGE_MS + HOUR, now);
    const active = sessionDir('.live-session.0123456789ab.sweeping', L.LISTS_MAX_AGE_MS + HOUR, now);
    writeFileSync(join(active, 'main.json'), '{"updated":1}');
    L.sweep(envFor(), now);
    expect(existsSync(idle)).toBe(false);
    expect(existsSync(active)).toBe(true);
  });

  it('a list call triggers the sweep', () => {
    fresh();
    const now = Date.now();
    const expired = sessionDir('old-session', L.LISTS_MAX_AGE_MS + HOUR, now);
    L.recordListCall(postToolUse(session(), 'TodoWrite', { todos: [{ content: 'A', status: 'pending' }] }), envFor(), now);
    expect(existsSync(expired)).toBe(false);
  });
});

describe('task list: an event that becomes visible after a later call was folded', () => {
  const env = () => envFor();
  const T = Date.now(); // call times near the present: the sweep that follows a list call judges the age of session directories by it
  const call = (sid, tool, input, extra = {}, now = Date.now()) => L.recordListCall(postToolUse(sid, tool, input, extra), env(), now);
  const write = (sid, content, status, now) => call(sid, 'TodoWrite', { todos: [{ content, status }] }, {}, now);
  const create = (sid, id, subject, now) => call(sid, 'TaskCreate', { subject }, { tool_response: `Task #${id} created successfully: ${subject}` }, now);
  const contents = (sid) => L.readList(sid, 'main', env()).items.map((x) => x.content);
  const dropped = () => logRows('task-list.jsonl').filter((x) => x.event === 'late_event_dropped').length;

  it('an older call that replaces the list does not put its list back over a newer replacement; its event is removed and a row is logged', () => {
    const sid = session();
    const rows = dropped();
    write(sid, 'Newer list', 'completed', T + 2000);
    write(sid, 'Older list', 'pending', T + 1000);
    expect(contents(sid)).toEqual(['Newer list']);
    expect(readListFile(sid, 'main').items[0].status).toBe('completed');
    expect(eventFiles(sid, 'main')).toEqual([]);
    expect(dropped()).toBe(rows + 1);
    expect(readListFile(sid, 'main').last_event_ms).toBe(T + 2000);
    expect(readListFile(sid, 'main').last_replace_ms).toBe(T + 2000);
  });

  it('an older call that replaces the list does not undo a newer call that changed part of it', () => {
    const sid = session();
    create(sid, 11, 'Created later', T + 2000);
    write(sid, 'Replaced earlier', 'pending', T + 1000);
    expect(contents(sid)).toEqual(['Created later']);
    expect(eventFiles(sid, 'main')).toEqual([]);
  });

  it('an older call that changes part of the list is dropped when a newer call replaced the list, and the later list is as sent', () => {
    const sid = session();
    write(sid, 'Replaced later', 'pending', T + 2000);
    create(sid, 12, 'Created earlier', T + 1000);
    expect(contents(sid)).toEqual(['Replaced later']);
    expect(eventFiles(sid, 'main')).toEqual([]);
    // the number stays claimed: a later TaskUpdate of it changes nothing in a list that does not hold it
    const updates = readListFile(sid, 'main').updates;
    call(sid, 'TaskUpdate', { taskId: '12', status: 'completed' }, {}, T + 3000);
    expect(contents(sid)).toEqual(['Replaced later']);
    expect(readListFile(sid, 'main').updates).toBe(updates);
  });

  it('an older call that changes part of the list is applied after a newer call that changed part of it (tasks created together all stay)', () => {
    const sid = session();
    create(sid, 21, 'Task B', T + 2000);
    create(sid, 22, 'Task A', T + 1000);
    expect(contents(sid).sort()).toEqual(['Task A', 'Task B']);
    expect(eventFiles(sid, 'main')).toEqual([]);
  });

  it('calls in the same millisecond are in order of arrival (the monotonic tick in the name), not late', () => {
    const sid = session();
    for (let i = 0; i < 25; i += 1) {
      write(sid, `Call ${i}`, 'pending', T);
      expect(contents(sid), `call ${i}`).toEqual([`Call ${i}`]);
    }
  });

  // The calls of the grid are A (the earlier by name) and B (the later). Both orders of publication must give the list that one fold of
  // both gives: B folded first and A visible afterwards (a held-up hook), whatever the two calls are and whether they share a millisecond.
  describe('a held-up call of the same millisecond or the one before gives the list of the fold that saw both (a held-up replacement is not applied over a part-changing call folded before it)', () => {
    const kinds = {
      replace: (label, id) => ({ tool_name: 'TodoWrite', tool_input: { todos: [{ content: label, status: 'pending' }] } }),
      create: (label, id) => ({ tool_name: 'TaskCreate', tool_input: { subject: label }, task_id: String(id) }),
    };
    const publish = (sid, ms, tick, pid, kind, label, id) => {
      const dir = join(LOGS, 'lists', sid, 'main.events');
      mkdirSync(dir, { recursive: true });
      const evId = String(id).padStart(8, 'a');
      const event = { ts: new Date(ms).toISOString(), pid, id: evId, session_id: sid, agent_type: null, tool_use_id: null, prompt_id: null, ...kinds[kind](label, id) };
      const name = `${String(ms).padStart(13, '0')}-${String(tick).padStart(20, '0')}-${pid}-${evId}.json`;
      writeFileSync(join(dir, name), JSON.stringify(event));
    };
    const places = [
      ['the same millisecond', 0],
      ['the millisecond before', 1],
    ];
    for (const [placeLabel, gap] of places) {
      for (const first of Object.keys(kinds)) {
        for (const second of Object.keys(kinds)) {
          it(`A ${first} then B ${second}, ${placeLabel}`, () => {
            const run = (heldUp) => {
              const sid = session();
              publish(sid, T + 5000 - gap, 100, 11, first, 'from A', 'aa1');
              publish(sid, T + 5000, 200, 12, second, 'from B', 'bb2');
              if (!heldUp) return contents(sid);
              // the same two calls, with A visible only after B was folded
              const sid2 = session();
              publish(sid2, T + 5000, 200, 12, second, 'from B', 'bb2');
              L.syncList(sid2, 'main', env());
              publish(sid2, T + 5000 - gap, 100, 11, first, 'from A', 'aa1');
              L.syncList(sid2, 'main', env());
              expect(eventFiles(sid2, 'main')).toEqual([]);
              return contents(sid2);
            };
            // the one deliberate difference: a replacement that was held up is not applied over a part-changing call folded before it
            // (it would undo that call, as the call it is older than is a later state of the list), whether in one millisecond or not
            const expected = first === 'replace' && second === 'create' ? ['from B'] : run(false).sort();
            expect(run(true).sort()).toEqual(expected);
          });
        }
      }
    }

    it('a held-up call that replaces the list is dropped, not applied, when the call after it in the same millisecond was folded first', () => {
      const sid = session();
      publish(sid, T + 5000, 200, 12, 'replace', 'from B', 'bb2');
      L.syncList(sid, 'main', env());
      publish(sid, T + 5000, 100, 11, 'replace', 'from A', 'aa1');
      expect(contents(sid)).toEqual(['from B']);
      L.syncList(sid, 'main', env());
      expect(contents(sid)).toEqual(['from B']);
    });
  });

  it('a call more than LATE_EVENT_MS older than the newest folded one comes from a clock set back, not from a held-up hook, and is applied', () => {
    const sid = session();
    write(sid, 'Newest', 'pending', T + 60_000);
    write(sid, 'Exactly the window', 'pending', T + 60_000 - L.LATE_EVENT_MS);
    expect(contents(sid)).toEqual(['Newest']);
    write(sid, 'Beyond the window', 'pending', T + 60_000 - L.LATE_EVENT_MS - 1);
    expect(contents(sid)).toEqual(['Beyond the window']);
  });

  it('a reader that folds a pending older event on its own gets the same list as a fold that writes (no write, event left)', () => {
    const sid = session();
    write(sid, 'Newer list', 'pending', T + 2000);
    const dir = join(LOGS, 'lists', sid, 'main.events');
    const name = `${String(T + 1000).padStart(13, '0')}-77-aaaaaaaa.json`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), JSON.stringify({ ts: new Date(T + 1000).toISOString(), pid: 77, id: 'aaaaaaaa', session_id: sid, tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'Older list', status: 'pending' }] }, agent_type: null, tool_use_id: null, prompt_id: null }));
    expect(contents(sid)).toEqual(['Newer list']);
    L.syncList(sid, 'main', env());
    expect(contents(sid)).toEqual(['Newer list']);
    expect(eventFiles(sid, 'main')).toEqual([]);
  });
});

describe('task list: the hook accepts what the task_list tool accepts', () => {
  // The handler of the tool checks the call as the schema declares it; the hook must refuse the same items, or a call the tool accepted
  // is saved as something else (a note of another type dropped, a number turned into text).
  const values = [undefined, null, 5, true, false, {}, { text: 'x' }, [], ['a'], '', ' ', 'text'];
  const label = (v) => (v === undefined ? 'absent' : JSON.stringify(v));

  it.each(['content', 'note'])('for every value of %s the hook and the tool give the same verdict on an item', async (field) => {
    let accepted = 0;
    for (const value of values) {
      const item = { content: 'Task', status: 'in_progress', note: 'why' };
      if (value === undefined) delete item[field];
      else item[field] = value;
      const tool = await taskListTool.handler({ items: [item] });
      const hook = L.updateShape({ items: [item] }, 'note');
      expect(hook.ok, `${field} ${label(value)}`).toBe(tool.isError !== true);
      if (hook.ok) accepted += 1;
    }
    // content: only a non-blank string ('text'); note: absent, '', ' ' and 'text'
    expect(accepted).toBe(field === 'content' ? 1 : 4);
  });

  it('content given as subject, status of another type, and items that are not objects are refused by both', async () => {
    for (const item of [{ subject: 'Task', status: 'pending' }, { content: 'Task', status: 1 }, { content: 'Task' }, null, 'Task', 7]) {
      const tool = await taskListTool.handler({ items: [item] });
      expect(tool.isError, JSON.stringify(item)).toBe(true);
      expect(L.updateShape({ items: [item] }, 'note').ok, JSON.stringify(item)).toBe(false);
    }
  });

  it('a call with a note of another type changes nothing in the hook, and update_plan keeps its own rules', () => {
    const sid = session();
    expect(L.recordListCall(postToolUse(sid, LIST_TOOL, { items: [{ content: 'A', status: 'in_progress', note: { why: 'x' } }] }), envFor())).toBeNull();
    expect(readListFile(sid, 'main')).toBeNull();
    const saved = L.recordListCall(postToolUse(sid, 'mcp__ccd_turn__update_plan', { items: [{ content: 'A', status: 'pending', note: 5 }] }), envFor());
    expect(saved.items.map((x) => x.content)).toEqual(['A']);
  });
});
