/**
 * Task-list storage and hooks: the state hook (PostToolUse), the batch hook, the
 * storage library (scripts/lib/jev-task-list.mjs). Every case runs the real
 * scripts in a temporary HOME and log directory; no network. The MCP tool and
 * the registry opt-in are covered in task-list-tool.test.ts.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
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

  it('a call that does not change the list leaves no list file; its event waits for an older call and goes once none can come', async () => {
    const sid = session();
    await stan(sid, 'TaskUpdate', { taskId: '9999', status: 'completed' }, { agent_id: 'o4' });
    await stan(sid, LIST_TOOL, { advance: true }, { agent_id: 'o4' });
    expect(existsSync(listFile(sid, 'o4'))).toBe(false);
    expect(eventFiles(sid, 'o4')).toHaveLength(2); // kept: a TaskCreate or a replacement that is held up may still become visible
    expect(L.readList(sid, 'o4', envFor())).toBeNull();
    // a later call, more than LATE_EVENT_MS ahead, shows that no held-up hook can precede the two any more (it waits itself)
    L.recordListCall(postToolUse(sid, 'TaskUpdate', { taskId: '9999', status: 'completed' }, { agent_id: 'o4' }), envFor(), Date.now() + L.LATE_EVENT_MS + 1000);
    expect(eventFiles(sid, 'o4')).toHaveLength(1);
    expect(existsSync(listFile(sid, 'o4'))).toBe(false);
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

  // An array argument sent as JSON text is parsed before the event keeps it: kept as text it would be cut to the longest text a list keeps, and
  // the cut text is no array, so the call the tool accepted would change nothing. Each row sends the argument pretty printed, longer than that cut.
  it.each([
    ['done', (n) => ({ done: JSON.stringify(Array.from({ length: n }, (_, i) => i + 1), null, 10) })],
    ['items', (n) => ({ items: JSON.stringify(Array.from({ length: n }, (_, i) => ({ content: `Task ${i + 1}`, status: 'pending' })), null, 10) })],
  ])('a long %s argument sent as JSON text still changes the list as the call asked', async (_what, input) => {
    const sid = session();
    const a = { agent_id: 'j1' };
    const tasks = Array.from({ length: 50 }, (_, i) => ({ content: `Task ${i + 1}`, status: 'pending' }));
    await stan(sid, LIST_TOOL, { items: tasks }, a);
    const sent = input(50);
    expect(Object.values(sent)[0].length).toBeGreaterThan(600);
    const s = await stan(sid, LIST_TOOL, sent, a);
    expect(s.code).toBe(0);
    const statuses = L.readList(sid, 'j1', envFor()).items.map((x) => x.status);
    expect(statuses).toHaveLength(50);
    expect(statuses.every((x) => (Object.keys(sent)[0] === 'done' ? x === 'completed' : x === 'pending'))).toBe(true);
    // and the event on disk holds the array itself, not text
    const kept = eventFiles(sid, 'j1').map((f) => JSON.parse(readFileSync(join(LOGS, 'lists', sid, 'j1.events', f), 'utf8')).tool_input);
    expect(kept.some((x) => Array.isArray(x.done) && x.done.length === 50)).toBe(Object.keys(sent)[0] === 'done');
  }, TOTAL_MS);

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
    expect(eventFiles(sid, 'o2')).toHaveLength(5); // every call of the last seconds stays until it is older than LATE_EVENT_MS
    expect(file.items.find((x) => x.content === 'B').status).toBe('completed');
    expect(file.items).toHaveLength(3);
  }, TOTAL_MS);

  it('retention: 600 events are folded by one locked write that keeps all 600 names; the next fold trims them to 500', async () => {
    const sid = session();
    const dir = join(LOGS, 'lists', sid, 'o3.events');
    mkdirSync(dir, { recursive: true });
    const t = Date.now() - 60_000; // older than the window: every event is settled by the fold
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
    expect(readdirSync(dir)).toHaveLength(1); // the call just made is in the window
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
          expect(ok(file) && eventFiles(sid, 'o1').length <= count, `file ${count}/${run}`).toBe(true); // the calls of the window are still events (a slow run may have settled some)
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
    const saved = call(sid, 'TodoWrite', { todos }, {}, Date.now() - 60_000);
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
    const base = Date.now() - 60_000; // older than the window: each call is settled by its own fold
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

  it('removes a tree left under a hidden name by an earlier sweep once it is idle, and puts it back under its own name while it is in use', () => {
    fresh();
    const now = Date.now();
    const idle = sessionDir('.old-session.0123456789ab.sweeping', L.LISTS_MAX_AGE_MS + HOUR, now);
    const active = sessionDir('.live-session.0123456789ab.sweeping', L.LISTS_MAX_AGE_MS + HOUR, now);
    writeFileSync(join(active, 'main.json'), '{"updated":1}');
    L.sweep(envFor(), now);
    expect(existsSync(idle)).toBe(false);
    expect(existsSync(active)).toBe(false);
    expect(readFileSync(join(root(), 'live-session', 'main.json'), 'utf8')).toBe('{"updated":1}');
    expect(readdirSync(root()).filter((n) => n.endsWith('.sweeping'))).toEqual([]);
  });

  it('folds the lists of a tree that goes back to its own name by one rename: the list file shows what the events give as soon as it is back', () => {
    fresh();
    const now = Date.now();
    const sid = session();
    L.recordListCall(postToolUse(sid, 'TaskCreate', { subject: 'Written once' }, { tool_response: 'Task #1 created successfully: Written once' }), envFor(), now - 5000);
    const listFile = join(root(), sid, 'main.json');
    const beforeUpdate = readFileSync(listFile, 'utf8');
    L.recordListCall(postToolUse(sid, 'TaskUpdate', { taskId: '1', status: 'completed' }), envFor(), now - 1000);
    writeFileSync(listFile, beforeUpdate); // the call published its event, and the directory was moved before the fold wrote the list
    expect(JSON.parse(readFileSync(listFile, 'utf8')).items[0].status).toBe('pending');
    renameSync(join(root(), sid), join(root(), `.${sid}.0123456789ab.sweeping`)); // what the sweep did a moment ago
    rmSync(join(root(), '.sweep'), { force: true });
    L.sweep(envFor(), now);
    expect(existsSync(join(root(), `.${sid}.0123456789ab.sweeping`))).toBe(false);
    expect(JSON.parse(readFileSync(listFile, 'utf8')).items[0].status).toBe('completed'); // not only what readList computes
    expect(L.readList(sid, 'main', envFor()).items[0].status).toBe('completed');
  });

  it('merges a tree in use under a hidden name into the directory a hook made again: its events and claims arrive, nothing the live tree has is replaced (its list is kept next to the live list), locks and temporary files are left behind', () => {
    fresh();
    const now = Date.now();
    const put = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };
    const moved = join(root(), '.merged-session.0123456789ab.sweeping');
    const live = join(root(), 'merged-session');
    put(join(moved, 'main.json'), '{"moved":1}');
    put(join(moved, 'main.json.lock'), 'a-dead-holder');
    put(join(moved, 'main.events', 'e-moved.json'), '{"moved":1}');
    put(join(moved, 'main.events', 'e-same.json'), '{"moved":1}');
    put(join(moved, 'main.events', 'e-partial.json.tmp'), '{"half');
    put(join(moved, '_task', '1.json'), '{"agent":"moved"}');
    put(join(moved, '_task', '9.json'), '{"agent":"moved"}');
    put(join(moved, 'other.events', 'e-other.json'), '{"moved":1}');
    put(join(live, 'main.json'), '{"live":1}');
    put(join(live, 'main.events', 'e-live.json'), '{"live":1}');
    put(join(live, 'main.events', 'e-same.json'), '{"live":1}');
    put(join(live, '_task', '9.json'), '{"agent":"live"}');
    L.sweep(envFor(), now);
    expect(existsSync(moved)).toBe(false);
    const read = (...parts) => readFileSync(join(live, ...parts), 'utf8');
    expect(read('main.json')).toBe('{"live":1}');
    expect(readdirSync(join(live, 'main.events')).sort()).toEqual(['e-live.json', 'e-moved.json', 'e-same.json']);
    expect(read('main.events', 'e-moved.json')).toBe('{"moved":1}');
    expect(read('main.events', 'e-same.json')).toBe('{"live":1}');
    expect(readdirSync(join(live, '_task')).sort()).toEqual(['1.json', '9.json']);
    expect(read('_task', '9.json')).toBe('{"agent":"live"}');
    expect(read('_task', '1.json')).toBe('{"agent":"moved"}');
    expect(read('other.events', 'e-other.json')).toBe('{"moved":1}');
    expect(readdirSync(live).sort()).toEqual(['_task', 'main.events', 'main.json', 'main.json.moved', 'other.events']);
    expect(read('main.json.moved')).toBe('{"moved":1}');
  });

  // The sweep moved a session directory away and, finding it in use, merges it into the directory a hook made again meanwhile (both have a list file).
  describe('a moved tree and the directory a hook made again, both with a list', () => {
    const create = (sid, id, subject, at) => L.recordListCall(postToolUse(sid, 'TaskCreate', { subject }, { tool_response: `Task #${id} created successfully: ${subject}` }), envFor(), at);
    const moveAndSweep = (sid, liveCalls) => {
      const moved = join(root(), `.${sid}.0123456789ab.sweeping`);
      renameSync(join(root(), sid), moved); // what the sweep did a moment ago
      liveCalls(); // another hook makes the directory again and folds its call
      rmSync(join(root(), '.sweep'), { force: true });
      L.sweep(envFor(), Date.now());
      expect(existsSync(moved)).toBe(false);
    };

    it('the list of the moved tree is the base the live events are replayed on: a call on a task only the moved list holds is not lost', () => {
      fresh();
      const now = Date.now();
      const sid = session();
      create(sid, 1, 'Settled long ago', now - 60_000); // settled by its own fold: it is in the base of the moved list and in no event
      L.recordListCall(postToolUse(sid, 'TaskUpdate', { taskId: '1', status: 'completed' }), envFor(), now - 1000); // the call the hook just made: still an event
      moveAndSweep(sid, () => create(sid, 2, 'Made in the new directory', now));
      expect(L.readList(sid, 'main', envFor()).items.map((x) => `${x.id} ${x.content}:${x.status}`)).toEqual(['1 Settled long ago:completed', '2 Made in the new directory:pending']);
      const file = JSON.parse(readFileSync(join(root(), sid, 'main.json'), 'utf8'));
      expect(file.items.map((x) => x.id)).toEqual(['1', '2']); // the file shows what the events give, as soon as the merge is done
      expect(existsSync(join(root(), sid, 'main.json.moved'))).toBe(false);
      expect(logRows('task-list.jsonl').some((x) => x.event === 'moved_list_set_aside' && String(x.file).startsWith(sid))).toBe(false);
    });

    it('the calls the moved tree still held as events are replayed before the later calls of the new directory, however long before these were made', () => {
      fresh();
      const now = Date.now();
      const sid = session();
      // the last call of an idle session: still an event of its window (the fold ran at its time), with the list that fold wrote
      const at = now - 120_000;
      const name = `${at}-${'7'.padStart(20, '0')}-11-aaaaaaaa.json`;
      const event = { ts: new Date(at).toISOString(), pid: 11, id: 'aaaaaaaa', session_id: sid, agent_type: null, tool_use_id: null, prompt_id: null, tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'Old list', status: 'pending' }] } };
      mkdirSync(join(root(), sid, 'main.events'), { recursive: true });
      writeFileSync(join(root(), sid, 'main.events', name), JSON.stringify(event));
      writeFileSync(join(root(), sid, 'main.json'), JSON.stringify(L.foldedRecord(L.foldEvents({ record: null, broken: false }, [{ name, event }], 'main', envFor(), at))));
      moveAndSweep(sid, () => create(sid, 9, 'New call', now));
      expect(L.readList(sid, 'main', envFor()).items.map((x) => `${x.id ?? '-'} ${x.content}:${x.status}`)).toEqual(['- Old list:pending', '9 New call:pending']);
      expect(existsSync(join(root(), sid, 'main.json.moved'))).toBe(false);
    });

    it('a live list that has settled calls of its own keeps its base: the list of the moved tree is kept next to it, and a row says so', () => {
      fresh();
      const now = Date.now();
      const sid = session();
      create(sid, 1, 'From the moved tree', now - 60_000);
      moveAndSweep(sid, () => {
        create(sid, 2, 'Settled in the new directory', now - 50_000);
        create(sid, 3, 'In the window', now);
      });
      expect(existsSync(join(root(), sid, 'main.json.moved'))).toBe(true);
      expect(JSON.parse(readFileSync(join(root(), sid, 'main.json.moved'), 'utf8')).items.map((x) => x.content)).toEqual(['From the moved tree']);
      expect(L.readList(sid, 'main', envFor()).items.map((x) => x.content)).toEqual(['Settled in the new directory', 'In the window']);
      expect(logRows('task-list.jsonl').some((x) => x.event === 'moved_list_set_aside')).toBe(true);
    });

    // The sweep was stopped right after it moved the directory (a hook is stopped by the host after 3 s), so the tree stayed hidden while the
    // session went on in a new directory; the sweep that finds it merges it when the new list has settled calls of its own. The events the
    // moved tree held are older than every call the new list has settled: their place in the order of the calls is before those calls, which
    // are settled and gone, so they cannot be replayed there, and applying them last (as a call of a clock set back) would put an older call over a
    // newer one.
    describe('an interrupted sweep: the moved tree is merged after the new directory settled calls of its own', () => {
      const held = (sid, key, at, tool, input, extra = {}) => {
        const name = `${at}-${'7'.padStart(20, '0')}-11-aaaaaaaa.json`;
        const event = { ts: new Date(at).toISOString(), pid: 11, id: 'aaaaaaaa', session_id: sid, agent_type: null, tool_use_id: null, prompt_id: null, tool_name: tool, tool_input: input, ...extra };
        mkdirSync(join(root(), sid, `${key}.events`), { recursive: true });
        writeFileSync(join(root(), sid, `${key}.events`, name), JSON.stringify(event));
        return { name, event };
      };
      const interrupted = (sid, { withList }) => {
        const at = Date.now() - 120_000;
        const first = held(sid, 'main', at, 'TodoWrite', { todos: [{ content: 'Old list', status: 'pending' }] });
        if (withList) writeFileSync(join(root(), sid, 'main.json'), JSON.stringify(L.foldedRecord(L.foldEvents({ record: null, broken: false }, [first], 'main', envFor(), at))));
        return at;
      };
      const stopAfterMove = (sid) => {
        writeFileSync(join(root(), '.sweep'), '{}'); // the sweep ran a moment ago: no other sweep runs before the one below
        const moved = join(root(), `.${sid}.0123456789ab.sweeping`);
        renameSync(join(root(), sid), moved);
        return moved;
      };
      const sweepAgain = () => { rmSync(join(root(), '.sweep'), { force: true }); L.sweep(envFor(), Date.now()); };
      const liveCalls = (sid, now) => {
        L.recordListCall(postToolUse(sid, 'TodoWrite', { todos: [{ content: 'Live task', status: 'pending' }] }), envFor(), now - 50_000); // settled at once
        L.recordListCall(postToolUse(sid, 'TodoWrite', { todos: [{ content: 'Live task', status: 'pending' }] }), envFor(), now);
      };
      const shown = (sid) => L.readList(sid, 'main', envFor()).items.map((x) => `${x.content}:${x.status}`);
      const rowsSince = (count) => logRows('task-list.jsonl').slice(count).filter((x) => x.event === 'moved_events_behind_settled').length;
      const dropRowsSince = (count) => logRows('task-list.jsonl').slice(count).filter((x) => x.event === 'moved_events_behind_settled').map((x) => [x.file, x.session, x.dropped]);

      it.each([['with the list of the moved tree', true], ['with its events only', false]])('an older replacement of the list does not land over the newer list (%s)', (_what, withList) => {
        fresh();
        const now = Date.now();
        const sid = session();
        const rows = logRows('task-list.jsonl').length;
        interrupted(sid, { withList });
        const moved = stopAfterMove(sid);
        liveCalls(sid, now);
        sweepAgain();
        expect(existsSync(moved)).toBe(false); // merged: the events left behind were deliberately left, not a reason to keep the tree
        expect(shown(sid)).toEqual(['Live task:pending']);
        expect(readListFile(sid, 'main').items.map((x) => x.content)).toEqual(['Live task']);
        expect(eventFiles(sid, 'main').some((n) => n.startsWith(String(now - 120_000)))).toBe(false);
        expect(dropRowsSince(rows)).toEqual([['main.json', sid, 1]]); // the row says which list, which session and how many calls
        expect(existsSync(join(root(), sid, 'main.json.moved'))).toBe(withList);
      });

      // every kind of call: none of them changes the list the new directory settled, whatever it does to a list when it is applied last
      it.each([
        ['TodoWrite replaces the list', 'TodoWrite', { todos: [{ content: 'Old list', status: 'pending' }] }],
        ['task_list replaces the list', LIST_TOOL, { items: [{ content: 'Old list', status: 'pending' }] }],
        ['task_list done by number', LIST_TOOL, { done: [1] }],
        ['task_list start by number', LIST_TOOL, { start: 1 }],
        ['task_list advance', LIST_TOOL, { advance: true }],
        ['wrap_up completes the list', 'mcp__ccd_turn__wrap_up', {}],
      ])('%s: an older call of the moved tree is not applied over the settled list', (_what, tool, input) => {
        fresh();
        const now = Date.now();
        const sid = session();
        held(sid, 'main', now - 120_000, tool, input);
        const moved = stopAfterMove(sid);
        liveCalls(sid, now);
        sweepAgain();
        expect(existsSync(moved)).toBe(false);
        expect(shown(sid)).toEqual(['Live task:pending']);
      });

      // its name is above the last call the new list settled, but its time is more than 10 s older than the newest call the new list holds
      it('an event more than 10 s older than the newest call of the new list is not applied over it either', () => {
        fresh();
        const now = Date.now();
        const sid = session();
        held(sid, 'main', now - 60_000, 'TodoWrite', { todos: [{ content: 'Old list', status: 'pending' }] });
        const moved = stopAfterMove(sid);
        L.recordListCall(postToolUse(sid, 'TodoWrite', { todos: [{ content: 'Live task', status: 'pending' }] }), envFor(), now - 100_000); // settled at once
        L.recordListCall(postToolUse(sid, LIST_TOOL, { start: 1 }), envFor(), now);
        sweepAgain();
        expect(existsSync(moved)).toBe(false);
        expect(shown(sid)).toEqual(['Live task:in_progress']);
      });

      // the decision about the events is made under the lock of the live list: when that lock is not taken in time the tree stays hidden, and the next sweep decides
      it('keeps the moved tree while the lock of the live list is held, and decides at the next sweep', () => {
        fresh();
        const now = Date.now();
        const sid = session();
        held(sid, 'main', now - 120_000, 'TodoWrite', { todos: [{ content: 'Old list', status: 'pending' }] });
        const moved = stopAfterMove(sid);
        liveCalls(sid, now);
        const lock = join(root(), sid, 'main.json.lock');
        writeFileSync(lock, 'another-hook');
        sweepAgain();
        expect(existsSync(moved)).toBe(true);
        expect(readdirSync(join(moved, 'main.events')).length).toBe(1); // nothing was linked in or dropped
        expect(shown(sid)).toEqual(['Live task:pending']);
        rmSync(lock);
        sweepAgain();
        expect(existsSync(moved)).toBe(false);
        expect(shown(sid)).toEqual(['Live task:pending']);
      });

      // the list of the moved tree and its events are decided together under that lock: a fold of the live list cannot publish between the
      // adoption of the base and the judging of the events, so the events are judged against the base they were made on, and a lock not taken
      // in time keeps both in the moved tree (the list is not set aside next to the live one, and the events are not left to a later fold)
      it('keeps the moved list with its events while the lock of the live list is held, and takes the base and the events together at the next sweep', () => {
        fresh();
        const now = Date.now();
        const sid = session();
        const rows = logRows('task-list.jsonl').length;
        interrupted(sid, { withList: true });
        const moved = stopAfterMove(sid);
        // the new directory has a list that settled nothing (its call is in its window), so the moved base is adopted; the call of the moved tree
        // is more than 10 s older than the live one: behind the live list as it stands, not behind the base it is merged on
        L.recordListCall(postToolUse(sid, 'TodoWrite', { todos: [{ content: 'Live task', status: 'pending' }] }), envFor(), now);
        const lock = join(root(), sid, 'main.json.lock');
        writeFileSync(lock, 'another-hook');
        sweepAgain();
        expect(existsSync(moved)).toBe(true);
        expect(existsSync(join(moved, 'main.json'))).toBe(true); // the list stayed with its events
        expect(existsSync(join(root(), sid, 'main.json.moved'))).toBe(false);
        expect(logRows('task-list.jsonl').slice(rows).some((x) => x.event === 'moved_list_set_aside')).toBe(false);
        rmSync(lock);
        sweepAgain();
        expect(existsSync(moved)).toBe(false);
        expect(existsSync(join(root(), sid, 'main.json.moved'))).toBe(false);
        expect(shown(sid)).toEqual(['Live task:pending']);
        expect(rowsSince(rows)).toBe(0); // the moved call was not judged against the live list as it stood before the adoption
      });

      it('an event of the moved tree newer than what the new list has settled still takes its place in the order of the calls', () => {
        fresh();
        const now = Date.now();
        const sid = session();
        const rows = logRows('task-list.jsonl').length;
        const early = held(sid, 'main', now - 60_000, 'TodoWrite', { todos: [{ content: 'Moved list', status: 'pending' }] });
        held(sid, 'main', now - 40_000, 'TodoWrite', { todos: [{ content: 'Moved list', status: 'pending' }, { content: 'Second', status: 'pending' }] });
        expect(early.name < `${now - 40_000}`).toBe(true);
        const moved = stopAfterMove(sid);
        // the new directory settles nothing: its only call is in its window, so the moved events and it are replayed together, in order
        L.recordListCall(postToolUse(sid, LIST_TOOL, { done: [2] }), envFor(), now);
        sweepAgain();
        expect(existsSync(moved)).toBe(false);
        expect(shown(sid)).toEqual(['Moved list:pending', 'Second:completed']);
        expect(rowsSince(rows)).toBe(0);
      });

      // A call that finds no task to change (a TaskUpdate of a task the new directory does not hold) settles without a write of the list file, so
      // no mark of the list says that it was seen. The tree a stopped sweep moved aside may hold the task it is about, and when it is merged
      // later it is judged against marks that know nothing of the call: the call has to be there to take its place after the task.
      describe('a call that finds no task to change, while a tree of the session is still hidden', () => {
        const noop = (sid, at, taskId = '1') => L.recordListCall(postToolUse(sid, 'TaskUpdate', { taskId, status: 'completed' }), envFor(), at);
        const oldTask = (sid, now, withList, age = 120_000) => {
          const at = now - age;
          const made = held(sid, 'main', at, 'TaskCreate', { subject: 'Old task' }, { task_id: '1' });
          if (withList) writeFileSync(join(root(), sid, 'main.json'), JSON.stringify(L.foldedRecord(L.foldEvents({ record: null, broken: false }, [made], 'main', envFor(), at))));
        };
        const leftNames = (sid) => eventFiles(sid, 'main').map((n) => n.slice(0, 13));

        // the first call is in its window when it is made, and settles when the second one, 25 s later, is folded
        it.each([['with the list of the moved tree', true], ['with its events only', false]])('stays until the moved tree is merged, and completes the task the moved tree holds (%s)', (_what, withList) => {
          fresh();
          const now = Date.now();
          const sid = session();
          oldTask(sid, now, withList);
          const moved = stopAfterMove(sid);
          noop(sid, now - 5000);
          noop(sid, now + 20_000, '9'); // another task no list holds: the call before it settles
          expect(leftNames(sid)).toEqual([String(now - 5000), String(now + 20_000)]); // the first one was not removed, though it settled
          expect(existsSync(moved)).toBe(true);
          sweepAgain();
          expect(existsSync(moved)).toBe(false);
          expect(shown(sid)).toEqual(['Old task:completed']);
          L.syncList(sid, 'main', envFor()); // the tree is merged: the calls are settled with the marks of the list like any other
          expect(leftNames(sid)).toEqual([String(now + 20_000)]);
          expect(readListFile(sid, 'main').items.map((x) => `${x.id} ${x.content}:${x.status}`)).toEqual(['1 Old task:completed']);
        });

        // The merge restores the list of the moved tree (a list file the live tree has none of) or only its events: the list file is folded when the
        // merge is done, so the readers of the file, which do not fold, see what the events give and not the restored snapshot.
        it.each([['with the list of the moved tree', true], ['with its events only', false]])('shows in the list file, at the end of the merge, the task the call completed (%s)', (_what, withList) => {
          fresh();
          const now = Date.now();
          const sid = session();
          oldTask(sid, now, withList);
          stopAfterMove(sid);
          noop(sid, now - 5000);
          sweepAgain();
          expect(readListFile(sid, 'main').items.map((x) => `${x.id} ${x.content}:${x.status}`)).toEqual(['1 Old task:completed']);
        });

        // the call that changed nothing is settled by the clock when the next call is folded, and that call changes the list: the fold writes the
        // file, so the settled call is named in the marks and the older create of the moved tree is behind them (dropped with a row, as for any call
        // that changed the list), not replayed without the call that completes it
        it('is in the marks when a later call changes the list in the same fold, so the older create of the moved tree is dropped with a row', () => {
          fresh();
          const now = Date.now();
          const sid = session();
          oldTask(sid, now, false, 13_000);
          const moved = stopAfterMove(sid);
          noop(sid, now - 12_000);
          expect(leftNames(sid)).toEqual([String(now - 12_000)]); // kept: the tree is hidden
          L.recordListCall(postToolUse(sid, 'TaskCreate', { subject: 'Second' }, { tool_response: 'Task #2 created successfully: Second' }), envFor(), now - 8000);
          expect(readListFile(sid, 'main').base_name.startsWith(String(now - 12_000))).toBe(true);
          expect(leftNames(sid)).toEqual([String(now - 8000)]);
          const rows = logRows('task-list.jsonl').length;
          sweepAgain();
          expect(existsSync(moved)).toBe(false);
          expect(shown(sid)).toEqual(['Second:pending']);
          expect(rowsSince(rows)).toBe(1);
        });

        it('does not stay past EVENTS_KEPT files in the folder, so a tree that is never merged cannot make the folder grow', () => {
          fresh();
          const now = Date.now();
          const sid = session();
          oldTask(sid, now, false);
          stopAfterMove(sid);
          const dir = join(root(), sid, 'main.events');
          mkdirSync(dir, { recursive: true });
          for (let i = 0; i <= L.EVENTS_KEPT; i += 1) {
            const at = now - 100_000 + i;
            const event = { ts: new Date(at).toISOString(), pid: 11, id: 'bbbbbbbb', session_id: sid, agent_type: null, tool_use_id: null, prompt_id: null, tool_name: 'TaskUpdate', tool_input: { taskId: '9', status: 'completed' } };
            writeFileSync(join(dir, `${at}-${String(i).padStart(20, '0')}-11-bbbbbbbb.json`), JSON.stringify(event));
          }
          noop(sid, now - 5000, '9');
          expect(leftNames(sid)).toEqual([String(now - 5000)]);
        });

        it('is settled at once when no tree of the session is hidden (a tree of another session does not keep it)', () => {
          fresh();
          const now = Date.now();
          const sid = session();
          mkdirSync(join(root(), '.another-session.0123456789ab.sweeping'), { recursive: true });
          writeFileSync(join(root(), '.sweep'), '{}'); // no sweep runs before the calls below
          noop(sid, now - 5000);
          noop(sid, now + 20_000, '9');
          expect(leftNames(sid)).toEqual([String(now + 20_000)]);
          expect(readListFile(sid, 'main')).toBeNull();
        });
      });
    });
  });

  it('a list call triggers the sweep', () => {
    fresh();
    const now = Date.now();
    const expired = sessionDir('old-session', L.LISTS_MAX_AGE_MS + HOUR, now);
    L.recordListCall(postToolUse(session(), 'TodoWrite', { todos: [{ content: 'A', status: 'pending' }] }), envFor(), now);
    expect(existsSync(expired)).toBe(false);
  });
});

describe('task list: calls whose events become visible out of order give the list of the order of the calls', () => {
  const env = () => envFor();
  // call times a few seconds in the past: inside the window of a fold made now (LATE_EVENT_MS), so nothing here is settled yet
  const t0 = () => Date.now() - 3000;
  const call = (sid, tool, input, extra = {}, now = Date.now()) => L.recordListCall(postToolUse(sid, tool, input, extra), env(), now);
  const write = (sid, content, status, now) => call(sid, 'TodoWrite', { todos: [{ content, status }] }, {}, now);
  const create = (sid, id, subject, now) => call(sid, 'TaskCreate', { subject }, { tool_response: `Task #${id} created successfully: ${subject}` }, now);
  const contents = (sid) => L.readList(sid, 'main', env()).items.map((x) => x.content);
  const tasks = (sid) => (L.readList(sid, 'main', env())?.items ?? []).map((x) => `${x.id ?? '-'} ${x.content}:${x.status}`);
  const fileTasks = (sid) => (readListFile(sid, 'main')?.items ?? []).map((x) => `${x.id ?? '-'} ${x.content}:${x.status}`);
  const publish = (sid, ms, tick, pid, spec, evId) => {
    const dir = join(LOGS, 'lists', sid, 'main.events');
    mkdirSync(dir, { recursive: true });
    const event = { ts: new Date(ms).toISOString(), pid, id: evId, session_id: sid, agent_type: null, tool_use_id: null, prompt_id: null, ...spec };
    writeFileSync(join(dir, `${String(ms).padStart(13, '0')}-${String(tick).padStart(20, '0')}-${pid}-${evId}.json`), JSON.stringify(event));
  };

  // The four reproductions of the review: the call that becomes visible last was made before (or after) the one that is visible first.
  describe('calls whose hooks published in the other order', () => {
    it('a done that found no list does not complete a task created after it, and completes one created before it that became visible later', () => {
      const t = t0();
      const sid = session();
      call(sid, LIST_TOOL, { done: [1] }, {}, t + 1000); // no list yet: nothing to complete
      create(sid, 1, 'Created after the done', t + 2000);
      expect(tasks(sid)).toEqual(['1 Created after the done:pending']);
      expect(fileTasks(sid)).toEqual(['1 Created after the done:pending']);
      const other = session();
      call(other, LIST_TOOL, { done: [1] }, {}, t + 2000);
      create(other, 1, 'Created before the done', t + 1000); // the hook of an older call publishes last
      expect(tasks(other)).toEqual(['1 Created before the done:completed']);
    });

    it('a TaskCreate that becomes visible after a later advance is replayed before it, so the advance starts it', () => {
      const t = t0();
      const sid = session();
      write(sid, 'Current', 'in_progress', t);
      call(sid, LIST_TOOL, { advance: true }, {}, t + 2000);
      expect(tasks(sid)).toEqual(['- Current:completed']);
      create(sid, 5, 'Created before the advance', t + 1000);
      expect(tasks(sid)).toEqual(['- Current:completed', '5 Created before the advance:in_progress']);
      expect(fileTasks(sid)).toEqual(tasks(sid));
    });

    it('a deletion that becomes visible after a later done by number is replayed before it, so the done reaches the task now at that number', () => {
      const t = t0();
      const sid = session();
      for (const id of [1, 2, 3]) create(sid, id, `Task ${id}`, t - 30_000 + id);
      call(sid, LIST_TOOL, { done: [2] }, {}, t + 2000);
      call(sid, 'TaskUpdate', { taskId: '2', status: 'deleted' }, {}, t + 1000);
      expect(tasks(sid)).toEqual(['1 Task 1:pending', '3 Task 3:completed']);
      const start = session();
      for (const id of [1, 2, 3]) create(start, id, `Task ${id}`, t - 30_000 + id);
      call(start, LIST_TOOL, { start: 2 }, {}, t + 2000);
      call(start, 'TaskUpdate', { taskId: '2', status: 'deleted' }, {}, t + 1000);
      expect(tasks(start)).toEqual(['1 Task 1:pending', '3 Task 3:in_progress']);
    });
  });

  it('a list replaced by a later call stays as that call sent it, whatever order the two hooks published in', () => {
    const t = t0();
    const sid = session();
    write(sid, 'Newer list', 'completed', t + 2000);
    write(sid, 'Older list', 'pending', t + 1000);
    expect(contents(sid)).toEqual(['Newer list']);
    expect(readListFile(sid, 'main').items[0].status).toBe('completed');
    expect(readListFile(sid, 'main').last_event_ms).toBe(t + 2000);
    // the call that became visible late took its place before the later one: both stay in the window until they are older than LATE_EVENT_MS
    expect(eventFiles(sid, 'main')).toHaveLength(2);
  });

  it('a call made before a later replacement of the list is replayed before it (and is gone with it); one made after it stays', () => {
    const t = t0();
    const sid = session();
    write(sid, 'Replaced later', 'pending', t + 2000);
    create(sid, 12, 'Created earlier', t + 1000);
    expect(contents(sid)).toEqual(['Replaced later']);
    const updates = readListFile(sid, 'main').updates;
    // the number stays claimed: a later TaskUpdate of it changes nothing in a list that does not hold it
    call(sid, 'TaskUpdate', { taskId: '12', status: 'completed' }, {}, t + 3000);
    expect(contents(sid)).toEqual(['Replaced later']);
    expect(readListFile(sid, 'main').updates).toBe(updates);
    const kept = session();
    write(kept, 'Replaced earlier', 'pending', t + 1000);
    create(kept, 13, 'Created later', t + 2000);
    write(kept, 'Replaced first', 'pending', t);
    expect(contents(kept)).toEqual(['Replaced earlier', 'Created later']);
  });

  it('tasks created by calls sent together all stay, in the order of the calls', () => {
    const t = t0();
    const sid = session();
    create(sid, 21, 'Task B', t + 2000);
    create(sid, 22, 'Task A', t + 1000);
    expect(contents(sid)).toEqual(['Task A', 'Task B']);
  });

  it('calls in the same millisecond are in order of arrival (the monotonic tick in the name), not late', () => {
    const sid = session();
    const now = Date.now();
    for (let i = 0; i < 25; i += 1) {
      write(sid, `Call ${i}`, 'pending', now);
      expect(contents(sid), `call ${i}`).toEqual([`Call ${i}`]);
    }
  });

  it('a call more than LATE_EVENT_MS older than the newest one seen comes from a clock set back, not from a held-up hook, and is applied last', () => {
    const sid = session();
    const now = Date.now();
    write(sid, 'Newest', 'pending', now + 60_000);
    write(sid, 'Exactly the window', 'pending', now + 60_000 - L.LATE_EVENT_MS); // a held-up call at the limit: takes its place before the newest
    expect(contents(sid)).toEqual(['Newest']);
    write(sid, 'Beyond the window', 'pending', now + 60_000 - L.LATE_EVENT_MS - 1);
    expect(contents(sid)).toEqual(['Beyond the window']);
    // the clock stays set back: the calls that follow are applied in the order they come, and the list is what the last one sent
    write(sid, 'After the clock was set back', 'pending', now + 61_000 - L.LATE_EVENT_MS * 3);
    expect(contents(sid)).toEqual(['After the clock was set back']);
  });

  it('a reader that folds a pending older event on its own gets the same list as a fold that writes (no write, event left)', () => {
    const t = t0();
    const sid = session();
    write(sid, 'Newer list', 'pending', t + 2000);
    const dir = join(LOGS, 'lists', sid, 'main.events');
    const name = `${String(t + 1000).padStart(13, '0')}-77-aaaaaaaa.json`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), JSON.stringify({ ts: new Date(t + 1000).toISOString(), pid: 77, id: 'aaaaaaaa', session_id: sid, tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'Older list', status: 'pending' }] }, agent_type: null, tool_use_id: null, prompt_id: null }));
    const before = readFileSync(listFile(sid, 'main'), 'utf8');
    expect(contents(sid)).toEqual(['Newer list']);
    expect(readFileSync(listFile(sid, 'main'), 'utf8')).toBe(before);
    L.syncList(sid, 'main', env());
    expect(contents(sid)).toEqual(['Newer list']);
    expect(eventFiles(sid, 'main')).toHaveLength(2);
  });

  // The kinds of the grids: every one is a call on the tasks 1 to 3 that exist (Seed 1 in progress). `slot` is the place of the call among the
  // ones of a case; it varies the numbers so that calls of one kind differ.
  const seeds = [
    ...[1, 2, 3].map((id) => ({ tool_name: 'TaskCreate', tool_input: { subject: `Seed ${id}` }, task_id: String(id) })),
    { tool_name: 'TaskUpdate', tool_input: { taskId: '1', status: 'in_progress' } },
  ];
  const kinds = {
    replace: (slot) => ({ tool_name: 'TodoWrite', tool_input: { todos: [{ content: `List ${slot}`, status: slot % 2 ? 'pending' : 'in_progress' }, { content: `Other ${slot}`, status: 'pending' }] } }),
    create: (slot) => ({ tool_name: 'TaskCreate', tool_input: { subject: `New ${slot}` }, task_id: String(4 + slot) }),
    update: (slot) => ({ tool_name: 'TaskUpdate', tool_input: { taskId: '2', status: slot % 2 ? 'completed' : 'in_progress' } }),
    remove: () => ({ tool_name: 'TaskUpdate', tool_input: { taskId: '2', status: 'deleted' } }),
    done: (slot) => ({ tool_name: LIST_TOOL, tool_input: { done: [2 + (slot % 2)] } }),
    start: (slot) => ({ tool_name: LIST_TOOL, tool_input: { start: 2 + (slot % 2) } }),
    advance: () => ({ tool_name: LIST_TOOL, tool_input: { advance: true } }),
    wrapUp: () => ({ tool_name: 'mcp__ccd_turn__wrap_up', tool_input: {} }),
    noop: (slot) => ({ tool_name: LIST_TOOL, tool_input: { done: [4 + slot] } }), // a task only a create of the case makes: nothing to complete before it
  };
  const kindNames = Object.keys(kinds);
  const permutations = (n) => (n === 0 ? [[]] : permutations(n - 1).flatMap((p) => Array.from({ length: n }, (_, i) => [...p.slice(0, i), n - 1, ...p.slice(i)])));
  const view = (items) => (items ?? []).map((x) => `${x.id ?? '-'} ${x.content}:${x.status}${x.note ? ` (${x.note})` : ''}`);

  const settle = (sid) => {
    const at = Date.now() - 60_000; // older than the window: the seed is settled by the first fold
    seeds.forEach((spec, i) => publish(sid, at + i, 50 + i, 9, spec, `5eed000${i}`));
    L.syncList(sid, 'main', env());
  };

  // Every order of publication of two calls, on disk, with a fold after each one: the list of the order of the calls, as one fold of both gives it.
  describe('every pair of kinds, two orders of publication, on disk', () => {
    it.each(kindNames)('first call: %s', (first) => {
      for (const second of kindNames) {
        for (const gap of [0, 1000]) { // the same millisecond (the order of the names decides) and a second apart
          const at = Date.now() - 3000;
          const a = kinds[first](0);
          const b = kinds[second](1);
          const run = (steps) => {
            const sid = session();
            settle(sid);
            for (const step of steps) {
              if (step === 'A') publish(sid, at, 100, 11, a, 'aaaaaaaa');
              else if (step === 'B') publish(sid, at + gap, 200, 12, b, 'bbbbbbbb');
              else L.syncList(sid, 'main', env());
            }
            return sid;
          };
          const inOrder = tasks(run(['A', 'B', 'sync']));
          const held = run(['B', 'sync', 'A', 'sync']);
          expect(tasks(held), `${first} then ${second}, gap ${gap}: the later call folded first`).toEqual(inOrder);
          expect(fileTasks(held), `${first} then ${second}, gap ${gap}: the file`).toEqual(inOrder);
          expect(tasks(run(['A', 'sync', 'B', 'sync'])), `${first} then ${second}, gap ${gap}: in order`).toEqual(inOrder);
        }
      }
    }, 60_000);
  });

  // The same for sets of three calls on disk, through syncList and readList (the in-memory grid below runs the functions a fold is made of, which an
  // older fold does not export): for each first kind, the nine sets whose second and third kind together make a multiple of nine places, 81 sets in all.
  describe('a sample of the sets of three kinds, every order of publication, on disk', () => {
    it.each(kindNames)('first call: %s', (first) => {
      const wrong = [];
      kindNames.forEach((second, j) => {
        const third = kindNames[(9 - j) % 9];
        const at = Date.now() - 3000;
        const specs = [kinds[first](0), kinds[second](1), kinds[third](2)];
        const run = (order) => {
          const sid = session();
          settle(sid);
          for (const i of order) {
            publish(sid, at + 1000 * i, 100 * (i + 1), 11 + i, specs[i], String(i).repeat(8));
            L.syncList(sid, 'main', env());
          }
          return { shown: tasks(sid), file: fileTasks(sid) };
        };
        const inOrder = run([0, 1, 2]);
        for (const order of permutations(3).filter((o) => o.join('') !== '012')) {
          const got = run(order);
          if (JSON.stringify(got) !== JSON.stringify(inOrder)) wrong.push(`${first},${second},${third} published ${order.join('')}: ${got.shown.join(' | ')} instead of ${inOrder.shown.join(' | ')}`);
        }
      });
      expect(wrong).toEqual([]);
    }, 60_000);
  });

  // The same for every order of publication of three calls, with a fold after each one, replayed in memory (foldEvents and foldedRecord are what
  // syncList runs under the lock): 9 kinds, 729 sets of calls, 6 orders each.
  describe('every three kinds, every order of publication, in memory', () => {
    const NOW = 1_800_000_000_000;
    const eventOf = (ms, slot, spec) => {
      const id = String(slot).padStart(8, 'a');
      const pid = 10 + slot;
      return {
        name: `${String(ms).padStart(13, '0')}-${String(100 + slot).padStart(20, '0')}-${pid}-${id}.json`,
        event: { ts: new Date(ms).toISOString(), pid, id, session_id: 'grid', agent_type: null, tool_use_id: null, prompt_id: null, ...spec },
      };
    };
    const seedEvents = seeds.map((spec, i) => eventOf(NOW - 60_000 + i, 50 + i, spec));
    // what the hooks do: publish an event, fold under the lock (publish the list when it changed, remove what went into the base and the leftovers)
    // `clocks` is the clock of the fold after each publication (the same clock for all by default)
    const replay = (events, order, clocks = order.map(() => NOW + 4000)) => {
      let snap = null;
      let folder = [...seedEvents];
      let clock = NOW;
      const sync = () => {
        const f = L.foldEvents({ record: snap, broken: false }, folder, 'main', env(), clock);
        if (f.changed) snap = L.foldedRecord(f);
        folder = folder.filter(({ name }) => !f.done.has(name) && !f.absorbed.includes(name));
      };
      sync();
      order.forEach((i, n) => {
        clock = clocks[n];
        folder = [...folder, events[i]].sort((x, y) => (x.name < y.name ? -1 : 1));
        sync();
      });
      return view(L.foldEvents({ record: snap, broken: false }, folder, 'main', env(), clock).record?.items);
    };
    it.each(kindNames)('first call: %s', (first) => {
      const orders = permutations(3).filter((order) => order.join('') !== '012');
      const wrong = [];
      for (const second of kindNames) {
        for (const third of kindNames) {
          const events = [first, second, third].map((kind, slot) => eventOf(NOW + 1000 * (slot + 1), slot, kinds[kind](slot)));
          const inOrder = replay(events, [0, 1, 2]);
          for (const order of orders) {
            const got = replay(events, order);
            if (JSON.stringify(got) !== JSON.stringify(inOrder)) wrong.push(`${first},${second},${third} published ${order.join('')}: ${got.join(' | ')} instead of ${inOrder.join(' | ')}`);
          }
        }
      }
      expect(wrong).toEqual([]);
    }, 60_000);

    // The clock of the folds moves between the publications. A hook is stopped after 3 s, so calls more than 3 s apart cannot be held up past each
    // other: of the three calls the early ones are published first and are settled (older than the window) when the late ones become visible, which
    // can still come in either order among themselves. The clock of a fold is at most 3 s past the call of the oldest call not yet published.
    const layouts = [
      { name: 'one early call, two late ones', at: [1000, 10_000, 11_000], orders: [[0, 1, 2], [0, 2, 1]], clocks: [2000, 12_000, 14_000] },
      { name: 'two early calls, one late one', at: [1000, 2000, 11_500], orders: [[0, 1, 2], [1, 0, 2]], clocks: [3500, 5000, 14_500] },
    ];
    it.each(kindNames)('with the clock of the folds moving, first call: %s', (first) => {
      const wrong = [];
      for (const layout of layouts) {
        const clocks = layout.clocks.map((ms) => NOW + ms);
        for (const second of kindNames) {
          for (const third of kindNames) {
            const events = [first, second, third].map((kind, slot) => eventOf(NOW + layout.at[slot], slot, kinds[kind](slot)));
            const inOrder = replay(events, layout.orders[0], clocks);
            for (const order of layout.orders.slice(1)) {
              const got = replay(events, order, clocks);
              if (JSON.stringify(got) !== JSON.stringify(inOrder)) wrong.push(`${layout.name}: ${first},${second},${third} published ${order.join('')}: ${got.join(' | ')} instead of ${inOrder.join(' | ')}`);
            }
          }
        }
      }
      expect(wrong).toEqual([]);
    }, 60_000);
  });

  it('a write that is older than a list file of an earlier version is read as written after it (no base: the list is the base)', () => {
    const t = t0();
    const sid = session();
    mkdirSync(join(LOGS, 'lists', sid), { recursive: true });
    const stamp = `${String(t).padStart(13, '0')}-${'0'.repeat(20)}-1-aaaaaaaa.json`;
    writeFileSync(listFile(sid, 'main'), JSON.stringify({
      v: 1, session_id: sid, agent: 'main', agent_type: null, tool: 'TaskCreate', tool_use_id: null, prompt_id: null, updated: new Date(t).toISOString(), updates: 3,
      items: [{ id: '1', content: 'From the earlier file', status: 'pending' }], folded: [stamp], last_event_ms: t, last_replace_ms: 0, last_event_name: stamp, last_replace_name: '', touched: { 1: stamp },
    }));
    call(sid, 'TaskUpdate', { taskId: '1', status: 'completed' }, {}, t + 1000);
    expect(tasks(sid)).toEqual(['1 From the earlier file:completed']);
    const file = readListFile(sid, 'main');
    expect(file.base.items.map((x) => x.status)).toEqual(['pending']);
    expect(file.touched).toBeUndefined();
    expect(file.updates).toBe(4);
    expect(file.folded).toEqual([stamp]);
    // a call older than the last one that file settled is a call of a clock set back: applied last
    call(sid, 'TaskUpdate', { taskId: '1', status: 'in_progress' }, {}, t - 1000);
    expect(tasks(sid)).toEqual(['1 From the earlier file:in_progress']);
  });

  it('the generation of the list file is the number of writes, not the number of calls that changed the list: a late deletion can leave that number as it was', () => {
    const t = t0();
    const sid = session();
    for (const id of [1, 2, 3]) create(sid, id, `Task ${id}`, t - 30_000 + id);
    call(sid, 'TaskUpdate', { taskId: '3', status: 'completed' }, {}, t + 2000);
    const before = readListFile(sid, 'main');
    call(sid, 'TaskUpdate', { taskId: '3', status: 'deleted' }, {}, t + 1000); // visible late: the update of task 3 finds nothing now
    const after = readListFile(sid, 'main');
    expect(after.items.map((x) => x.id)).toEqual(['1', '2']);
    expect(after.updates).toBe(before.updates); // the update that no longer changes anything is not counted, the deletion is
    expect(after.rev).toBe(before.rev + 1);
    // a fold that read the file before the deletion must find it changed, though `updates` is the same
    const generation = (record) => L.foldEvents({ record, broken: false }, [], 'main', env()).generation;
    expect(generation(after)).not.toBe(generation(before));
  });

  it('a call that edits tasks and finds nothing to change stays in the window like any other call, and goes once it is older than LATE_EVENT_MS', () => {
    const sid = session();
    const t = Date.now();
    call(sid, 'TaskUpdate', { taskId: '71', status: 'completed' }, {}, t + 1000);
    call(sid, 'TaskUpdate', { taskId: '72', status: 'completed' }, {}, t + 1000 + L.LATE_EVENT_MS); // exactly the window: the first still stays
    expect(eventFiles(sid, 'main')).toHaveLength(2);
    expect(existsSync(listFile(sid, 'main'))).toBe(false);
    call(sid, 'TaskUpdate', { taskId: '73', status: 'completed' }, {}, t + 1001 + L.LATE_EVENT_MS); // the first is beyond the window now
    expect(eventFiles(sid, 'main')).toHaveLength(2);
    call(sid, 'TaskCreate', { subject: 'Later' }, { tool_response: 'Task #74 created successfully: Later' }, t + 60_000);
    expect(tasks(sid)).toEqual(['74 Later:pending']);
    expect(eventFiles(sid, 'main')).toHaveLength(1); // only the creation is in the window
  });

  it('a TaskUpdate and a deletion that find no task wait for the TaskCreate held up before them, and apply when it is visible', () => {
    const sid = session();
    const t = t0();
    call(sid, 'TaskUpdate', { taskId: '61', status: 'in_progress' }, {}, t + 2000);
    call(sid, 'TaskUpdate', { taskId: '61', status: 'completed' }, {}, t + 3000);
    call(sid, 'TaskUpdate', { taskId: '62', status: 'deleted' }, {}, t + 3500);
    expect(L.readList(sid, 'main', env())).toBeNull();
    expect(eventFiles(sid, 'main')).toHaveLength(3); // kept for the creation that is not visible yet
    publish(sid, t + 1000, 100, 11, { tool_name: 'TaskCreate', tool_input: { subject: 'Held up' }, task_id: '61' }, 'cccccccc');
    publish(sid, t + 1001, 100, 13, { tool_name: 'TaskCreate', tool_input: { subject: 'Deleted at once' }, task_id: '62' }, 'dddddddd');
    L.syncList(sid, 'main', env());
    expect(tasks(sid)).toEqual(['61 Held up:completed']);
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
