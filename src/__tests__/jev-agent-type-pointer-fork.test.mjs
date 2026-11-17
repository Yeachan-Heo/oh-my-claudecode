/**
 * Three opt-in behaviours of the PreToolUse hook for Agent/Task calls:
 * OMC_AGENT_TYPE_DENY with OMC_AGENT_TYPE_DENY_MODE (deny list), OMC_JEV_POINTER_EXPAND
 * with OMC_JEV_POINTER_EXPAND_DIRS and OMC_JEV_POINTER_EXPAND_SECRET_DIRS (pointer expansion), and the fork skip row of the
 * model-routing point. Each is also checked to leave the hook unchanged when unset.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NODE = process.execPath;
const CLEANUPS = [];
// Request bodies the local stub endpoint received, in order.
const receivedBodies = [];
let endpoint = '';
let server;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      receivedBodies.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: { unknown: { type: 'noul', noul: 0 } } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = 'http://127.0.0.1:' + server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const path of CLEANUPS.splice(0)) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A temp directory still held by the OS is left for the OS.
    }
  }
});

function makeContext() {
  const root = mkdtempSync(join(tmpdir(), 'jev-agent-type-pointer-fork-'));
  CLEANUPS.push(root);
  const cwd = join(root, 'project');
  const home = join(root, 'home');
  const logDir = join(root, 'jev-log');
  const stateDir = join(root, 'state');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, cwd, home, logDir, stateDir };
}

function hookEnv(context, overrides = {}) {
  const env = {
    ...process.env,
    HOME: context.home,
    USERPROFILE: context.home,
    CLAUDE_CONFIG_DIR: join(context.home, '.claude'),
    CLAUDE_PLUGIN_ROOT: '',
    DISABLE_OMC: '',
    OMC_SKIP_HOOKS: '',
    OMC_STATE_DIR: context.stateDir,
    OMC_JEV_MODEL_ROUTING_MARKER: '',
    OMC_JEV: '',
    OMC_AGENT_TYPE_DENY: '',
    OMC_AGENT_TYPE_DENY_MODE: '',
    OMC_JEV_POINTER_EXPAND: '',
    OMC_JEV_POINTER_EXPAND_DIRS: '',
    OMC_JEV_POINTER_EXPAND_SECRET_DIRS: '',
    OMC_JEV_ROW_TELEMETRY: '',
    OMC_JEV_LOG_CONTEXT: '',
    TYPESAFE_API_KEY: 'test-key',
    OMC_JEV_LOG_DIR: context.logDir,
    OMC_JEV_ENDPOINT: endpoint,
    OMC_JEV_TIMEOUT_MS: '10000',
    OMC_JEV_APPLIED_LOG: '1',
    OMC_JEV_QUIET: '1',
    NODE_ENV: 'test',
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return env;
}

/** A hook prints one JSON object, pretty-printed by some hooks; anything before it is ignored. */
function parseHookOutput(stdout) {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(text.slice(text.indexOf('\n{') + 1));
  }
}

function runHookFull(context, input, overrides = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(NODE, [join(ROOT, 'scripts', 'pre-tool-enforcer.mjs')], {
      cwd: context.cwd,
      encoding: 'utf8',
      timeout: 30_000,
      env: hookEnv(context, overrides),
    }, (error, stdout, stderr) => {
      if (error) return reject(error);
      try {
        resolve({ output: parseHookOutput(stdout), stdout, stderr });
      } catch (parseError) {
        reject(parseError);
      }
    });
    child.stdin.end(JSON.stringify({ cwd: context.cwd, session_id: 'session-1', tool_use_id: 'toolu_1', ...input }));
  });
}

async function runHook(context, input, overrides = {}) {
  return (await runHookFull(context, input, overrides)).output;
}

/** Every file with this name under a directory tree (the project id in a state directory is a hash). */
function findLogs(dir, fileName) {
  const found = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findLogs(path, fileName));
    else if (entry.name === fileName) found.push(...readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)));
  }
  return found;
}

/** The questions requests of the model-routing point that the stub endpoint received after `before`. */
function routingRequests(before) {
  return receivedBodies.slice(before).map((body) => JSON.parse(body)).filter((body) => body.questions && ('model-tier' in body.questions || 'effort' in body.questions));
}

function readLog(context, file) {
  const path = join(context.logDir, file);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const AGENT_CALL = (subagentType, extra = {}) => ({
  tool_name: 'Agent',
  tool_input: { ...(subagentType === undefined ? {} : { subagent_type: subagentType }), description: 'Check', prompt: 'Check the repository layout.', ...extra },
});

const denyReason = (output) => output?.hookSpecificOutput?.permissionDecisionReason ?? '';
const denied = (output) => output?.hookSpecificOutput?.permissionDecision === 'deny';

// A list that refuses the built-in general-purpose and claude types and the plugin explore and writer
// agents without regard to letter case, and the bare explore and writer names exactly.
const DENY_LIST = 'general-purpose,claude,oh-my-claudecode:explore,oh-my-claudecode:writer,=explore,=writer';
const DENY = { OMC_AGENT_TYPE_DENY: DENY_LIST, OMC_AGENT_TYPE_DENY_MODE: 'deny' };
const LOG_IDS = { OMC_JEV_LOG_CONTEXT: '1' };

const REFUSED = [
  ['general-purpose', 'general-purpose'],
  ['oh-my-claudecode:explore', 'oh-my-claudecode:explore'],
  ['oh-my-claudecode:writer', 'oh-my-claudecode:writer'],
  ['no key', undefined],
  ['empty', ''],
  ['spaces only', '   '],
  ['General-Purpose (letter case)', 'General-Purpose'],
  ['GENERAL-PURPOSE (letter case)', 'GENERAL-PURPOSE'],
  ['claude', 'claude'],
  ['Claude (letter case)', 'Claude'],
  ['explore (bare plugin name)', 'explore'],
  ['writer (bare plugin name)', 'writer'],
  ['OH-MY-CLAUDECODE:WRITER (letter case)', 'OH-MY-CLAUDECODE:WRITER'],
];
// Types the list does not name, plus Explore and EXPLORE, which the exact entry =explore does not match.
const ALLOWED = ['fork', 'example-agent', 'Explore', 'EXPLORE', 'Writer', 'docs', 'oh-my-claudecode:executor', 'oh-my-claudecode:verifier', 'Plan'];

describe('agent-type deny list (OMC_AGENT_TYPE_DENY, OMC_AGENT_TYPE_DENY_MODE)', () => {
  it('without the list and the mode: no refusal and no agent-type row', async () => {
    const context = makeContext();
    const output = await runHook(context, AGENT_CALL('general-purpose'));
    expect(denied(output)).toBe(false);
    expect(readLog(context, 'agent-type.jsonl')).toEqual([]);
  });

  it('a list without the mode stays off: no refusal and no row', async () => {
    const context = makeContext();
    const output = await runHook(context, AGENT_CALL('general-purpose'), { OMC_AGENT_TYPE_DENY: 'general-purpose' });
    expect(denied(output)).toBe(false);
    expect(readLog(context, 'agent-type.jsonl')).toEqual([]);
  });

  it('deny: every listed type and a missing or empty type is refused with a reason, with no Jev query, no shadow line and no applied line', async () => {
    for (const [label, type] of REFUSED) {
      const context = makeContext();
      const before = receivedBodies.length;
      const output = await runHook(context, AGENT_CALL(type, { resume: 'a1b2c3' }), { ...DENY, ...LOG_IDS, OMC_JEV: 'model-routing:active' });
      expect(denied(output), label).toBe(true);
      expect(denyReason(output), label).toContain('[AGENT TYPE]');
      expect(output.hookSpecificOutput.updatedInput, label).toBeUndefined();
      expect(receivedBodies.length, label).toBe(before);
      expect(readLog(context, 'shadow.jsonl'), label).toEqual([]);
      expect(readLog(context, 'applied.jsonl'), label).toEqual([]);
      const rows = readLog(context, 'agent-type.jsonl');
      expect(rows, label).toHaveLength(1);
      expect(rows[0], label).toMatchObject({ point: 'agent-type', decision: 'deny', mode: 'deny', tool_name: 'Agent', session_id: 'session-1', tool_use_id: 'toolu_1' });
    }
  });

  it('deny: the entry list is compared without regard to letter case, so General-Purpose is refused under general-purpose', async () => {
    const context = makeContext();
    const output = await runHook(context, AGENT_CALL('General-Purpose'), { OMC_AGENT_TYPE_DENY: 'general-purpose', OMC_AGENT_TYPE_DENY_MODE: 'deny' });
    expect(denied(output)).toBe(true);
    const mixedEntry = await runHook(makeContext(), AGENT_CALL('general-purpose'), { OMC_AGENT_TYPE_DENY: 'General-Purpose', OMC_AGENT_TYPE_DENY_MODE: 'deny' });
    expect(denied(mixedEntry)).toBe(true);
  });

  it('deny: an entry starting with = matches exactly, so Explore and EXPLORE pass under =explore', async () => {
    for (const type of ['Explore', 'EXPLORE']) {
      const context = makeContext();
      const output = await runHook(context, AGENT_CALL(type), { OMC_AGENT_TYPE_DENY: '=explore', OMC_AGENT_TYPE_DENY_MODE: 'deny' });
      expect(denied(output), type).toBe(false);
      expect(readLog(context, 'agent-type.jsonl').map((row) => [row.decision, row.subagent_type]), type).toEqual([['allow', type]]);
    }
    const exact = await runHook(makeContext(), AGENT_CALL('explore'), { OMC_AGENT_TYPE_DENY: '=explore', OMC_AGENT_TYPE_DENY_MODE: 'deny' });
    expect(denied(exact)).toBe(true);
  });

  it('deny: a call without subagent_type is judged as general-purpose', async () => {
    const context = makeContext();
    const output = await runHook(context, AGENT_CALL(undefined), { OMC_AGENT_TYPE_DENY: 'general-purpose', OMC_AGENT_TYPE_DENY_MODE: 'deny' });
    expect(denied(output)).toBe(true);
    expect(denyReason(output)).toContain('(no subagent_type)');
  });

  it('deny: the other types pass and are logged as allow, the fork type with its skipped model-routing line', async () => {
    for (const type of ALLOWED) {
      const context = makeContext();
      const output = await runHook(context, AGENT_CALL(type), { ...DENY, OMC_JEV: 'model-routing:active' });
      expect(denied(output), type).toBe(false);
      const rows = readLog(context, 'agent-type.jsonl');
      expect(rows.map((row) => [row.decision, row.mode, row.subagent_type]), type).toEqual([['allow', 'deny', type]]);
      if (type === 'fork') expect(readLog(context, 'shadow.jsonl').some((row) => row.point === 'model-routing' && row.skipped === 'fork')).toBe(true);
    }
  });

  it('deny: a call from a subagent carries the agent ids in the row; a Task call is judged like an Agent call', async () => {
    const ids = { agent_id: 'a-1', agent_type: 'oh-my-claudecode:executor' };
    const context = makeContext();
    const refused = await runHook(context, { ...AGENT_CALL('general-purpose'), ...ids }, { ...DENY, ...LOG_IDS });
    expect(denied(refused)).toBe(true);
    const passed = await runHook(context, { ...AGENT_CALL('example-agent'), ...ids }, { ...DENY, ...LOG_IDS });
    expect(denied(passed)).toBe(false);
    expect(readLog(context, 'agent-type.jsonl').map((row) => [row.decision, row.agent_id])).toEqual([['deny', 'a-1'], ['allow', 'a-1']]);
    const taskContext = makeContext();
    const task = await runHook(taskContext, { ...AGENT_CALL('general-purpose'), tool_name: 'Task' }, DENY);
    expect(denied(task)).toBe(true);
    expect(readLog(taskContext, 'agent-type.jsonl')[0]).toMatchObject({ tool_name: 'Task', decision: 'deny' });
  });

  it('deny: input that is not a parsed object, or a subagent_type that is not text, passes and is logged as unparsed', async () => {
    for (const [label, input] of [
      ['tool_input text', { tool_name: 'Agent', tool_input: 'general-purpose' }],
      ['tool_input null', { tool_name: 'Agent', tool_input: null }],
      ['tool_input array', { tool_name: 'Agent', tool_input: ['general-purpose'] }],
      ['subagent_type number', { tool_name: 'Agent', tool_input: { subagent_type: 7, prompt: 'Check.' } }],
      ['subagent_type object', { tool_name: 'Agent', tool_input: { subagent_type: { name: 'general-purpose' }, prompt: 'Check.' } }],
    ]) {
      const context = makeContext();
      const output = await runHook(context, input, DENY);
      expect(denied(output), label).toBe(false);
      const rows = readLog(context, 'agent-type.jsonl');
      expect(rows.map((row) => [row.decision, row.subagent_type]), label).toEqual([['unparsed', null]]);
    }
  });

  it('shadow: every refused type is only logged as would-deny, the call passes with its normal routing', async () => {
    for (const [label, type] of REFUSED) {
      const context = makeContext();
      const output = await runHook(context, AGENT_CALL(type), { OMC_AGENT_TYPE_DENY: DENY_LIST, OMC_AGENT_TYPE_DENY_MODE: 'shadow' });
      expect(denied(output), label).toBe(false);
      expect(readLog(context, 'agent-type.jsonl').map((row) => [row.decision, row.mode]), label).toEqual([['would-deny', 'shadow']]);
    }
    const context = makeContext();
    await runHook(context, AGENT_CALL('example-agent'), { OMC_AGENT_TYPE_DENY: DENY_LIST, OMC_AGENT_TYPE_DENY_MODE: 'shadow' });
    expect(readLog(context, 'agent-type.jsonl').map((row) => row.decision)).toEqual(['allow']);
  });

  it('off: no refusal and no row, and the hook output is the same as in shadow mode, for refused and allowed types', async () => {
    for (const type of ['general-purpose', 'General-Purpose', undefined, 'example-agent', 'fork']) {
      const off = await runHookFull(makeContext(), AGENT_CALL(type), { OMC_AGENT_TYPE_DENY: DENY_LIST, OMC_AGENT_TYPE_DENY_MODE: 'off' });
      const shadow = await runHookFull(makeContext(), AGENT_CALL(type), { OMC_AGENT_TYPE_DENY: DENY_LIST, OMC_AGENT_TYPE_DENY_MODE: 'shadow' });
      expect(denied(off.output), String(type)).toBe(false);
      expect(off.stdout, String(type)).toBe(shadow.stdout);
    }
    const context = makeContext();
    await runHook(context, AGENT_CALL('general-purpose'), { OMC_AGENT_TYPE_DENY: DENY_LIST, OMC_AGENT_TYPE_DENY_MODE: 'off' });
    expect(readLog(context, 'agent-type.jsonl')).toEqual([]);
  });

  it('an unknown mode value works as shadow, with one warning on stderr and mode_raw in the row; a spaced, mixed-case deny is deny', async () => {
    for (const value of ['yes', 'active', '1']) {
      const context = makeContext();
      const { output, stderr } = await runHookFull(context, AGENT_CALL('general-purpose'), { OMC_AGENT_TYPE_DENY: DENY_LIST, OMC_AGENT_TYPE_DENY_MODE: value, OMC_JEV_QUIET: '' });
      expect(denied(output), value).toBe(false);
      expect(readLog(context, 'agent-type.jsonl')[0], value).toMatchObject({ mode: 'shadow', decision: 'would-deny', mode_raw: value });
      expect(stderr, value).toContain('OMC_AGENT_TYPE_DENY_MODE=' + value + ' is not one of off, shadow, deny; using shadow');
    }
    const context = makeContext();
    const explicit = await runHookFull(context, AGENT_CALL('general-purpose'), { OMC_AGENT_TYPE_DENY: DENY_LIST, OMC_AGENT_TYPE_DENY_MODE: 'shadow', OMC_JEV_QUIET: '' });
    expect(explicit.stderr).not.toContain('agent-type:');
    expect(readLog(context, 'agent-type.jsonl')[0]).not.toHaveProperty('mode_raw');
    const spaced = await runHook(makeContext(), AGENT_CALL('general-purpose'), { OMC_AGENT_TYPE_DENY: DENY_LIST, OMC_AGENT_TYPE_DENY_MODE: ' Deny ' });
    expect(denied(spaced)).toBe(true);
  });

  it('deny: a use marker does not bypass the refusal; Bash and Workflow calls leave no agent-type row', async () => {
    const context = makeContext();
    const before = receivedBodies.length;
    const refused = await runHook(context, AGENT_CALL('general-purpose', { prompt: 'use sonnet low\n\nCheck the repository layout.' }), {
      ...DENY,
      OMC_JEV: 'model-routing:active',
      OMC_JEV_MODEL_ROUTING_MARKER: '1',
    });
    expect(denied(refused)).toBe(true);
    expect(receivedBodies.length).toBe(before);
    expect(readLog(context, 'applied.jsonl')).toEqual([]);
    expect(readLog(context, 'overrides.jsonl')).toEqual([]);
    for (const input of [
      { tool_name: 'Bash', tool_input: { command: 'ls' } },
      { tool_name: 'Workflow', tool_input: { script: "export const meta = { name: 'x', description: 'x' }\nawait agent('x')" } },
    ]) {
      const other = makeContext();
      const output = await runHook(other, input, DENY);
      expect(denied(output), input.tool_name).toBe(false);
      expect(readLog(other, 'agent-type.jsonl'), input.tool_name).toEqual([]);
    }
  });

  it('deny: with Jev off and no OMC_JEV_LOG_DIR the row goes to the jev directory of the state directory', async () => {
    const context = makeContext();
    const output = await runHook(context, AGENT_CALL('general-purpose'), { ...DENY, OMC_JEV_LOG_DIR: undefined });
    expect(denied(output)).toBe(true);
    const rows = findLogs(context.stateDir, 'agent-type.jsonl');
    expect(rows.map((row) => row.decision)).toEqual(['deny']);
  });
});

describe('pointer expansion (OMC_JEV_POINTER_EXPAND, OMC_JEV_POINTER_EXPAND_DIRS)', () => {
  const TASK = 'Review the payment module and list the risks.';
  // The routing requests are answered while the hook waits (the point is active), so a test reads
  // them as soon as the hook returns; no request of another test can arrive late.
  const ON = (context, extra = {}) => ({
    OMC_JEV: 'model-routing:active',
    OMC_JEV_POINTER_EXPAND: '1',
    OMC_JEV_POINTER_EXPAND_DIRS: join(context.root, 'briefs'),
    OMC_JEV_ROW_TELEMETRY: '1',
    ...extra,
  });

  function briefsDir(context) {
    const dir = join(context.root, 'briefs');
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  function briefFixture(context, name = 'brief.md', text = 'BRIEF-MARKER: do the migration step by step.\nSecond line.\n') {
    const path = join(briefsDir(context), name);
    writeFileSync(path, text, 'utf8');
    return path;
  }
  const label = (real) => '\n\n[source file: ' + real + ', head of file]\n';
  /** Runs the hook with `prompt` and returns the task of the single routing request, and its shadow row. */
  async function taskSentFor(context, prompt, overrides = ON(context)) {
    const before = receivedBodies.length;
    const output = await runHook(context, AGENT_CALL('executor', { prompt, model: 'sonnet' }), overrides);
    const requests = routingRequests(before);
    expect(requests).toHaveLength(1);
    return { task: requests[0].state.task, output, row: readLog(context, 'shadow.jsonl').findLast((x) => x.point === 'model-routing') };
  }

  it('switch on, file under an allowed dir: the task is the prompt plus the head of the file, and the call itself is not changed', async () => {
    const context = makeContext();
    const brief = briefFixture(context);
    const prompt = TASK + ' Details in ' + brief;
    const { task, output, row } = await taskSentFor(context, prompt);
    expect(task).toBe(prompt + label(realpathSync(brief)) + 'BRIEF-MARKER: do the migration step by step.\nSecond line.\n');
    expect(output?.hookSpecificOutput?.updatedInput?.prompt ?? prompt).toBe(prompt);
    expect(row?.pointer_expanded).toBe(true);
    expect(row?.pointer_unexpanded).toBeNull();
  });

  it('a file of 20000 characters: the task ends with exactly the first 8000 characters', async () => {
    const context = makeContext();
    const brief = briefFixture(context, 'long.md', 'w'.repeat(20000));
    const prompt = TASK + ' Details in ' + brief;
    const { task } = await taskSentFor(context, prompt);
    expect(task).toBe(prompt + label(realpathSync(brief)) + 'w'.repeat(8000));
  });

  it('switch on, no allowed dirs (empty default): the file is never read and the reason is logged', async () => {
    const context = makeContext();
    const brief = briefFixture(context);
    const prompt = TASK + ' Details in ' + brief;
    const { task, row } = await taskSentFor(context, prompt, ON(context, { OMC_JEV_POINTER_EXPAND_DIRS: '' }));
    expect(task).toBe(prompt);
    expect(row?.pointer_unexpanded).toBe('outside-allowed-dirs');
  });

  it('switch unset: the prompt is sent as it was, even with an allowed dir', async () => {
    const context = makeContext();
    const brief = briefFixture(context);
    const prompt = TASK + ' Details in ' + brief;
    const { task } = await taskSentFor(context, prompt, ON(context, { OMC_JEV_POINTER_EXPAND: '' }));
    expect(task).toBe(prompt);
  });

  it('a path that names no file: the task is unchanged and the hook does not fail', async () => {
    const context = makeContext();
    briefsDir(context);
    const prompt = TASK + ' The path looks like ' + join(context.root, 'briefs', 'no-such-brief.md');
    const { task, row } = await taskSentFor(context, prompt);
    expect(task).toBe(prompt);
    expect(row?.pointer_unexpanded).toBe('missing');
  });

  it('a directory whose name ends in .md: the task is unchanged', async () => {
    const context = makeContext();
    mkdirSync(join(briefsDir(context), 'dir-brief.md'));
    const prompt = TASK + ' Details in ' + join(context.root, 'briefs', 'dir-brief.md');
    const { task, row } = await taskSentFor(context, prompt);
    expect(task).toBe(prompt);
    expect(row?.pointer_unexpanded).toBe('directory');
  });

  it('a symlink to a .md file under a secret path is excluded: the real path is checked before the patterns', async () => {
    const context = makeContext();
    const dir = briefsDir(context);
    mkdirSync(join(dir, 'private', '.ssh'), { recursive: true });
    writeFileSync(join(dir, 'private', '.ssh', 'brief.md'), 'Secret brief.', 'utf8');
    symlinkSync(join(dir, 'private', '.ssh', 'brief.md'), join(dir, 'visible.md'));
    const prompt = TASK + ' Details in ' + join(dir, 'visible.md');
    const { task, row } = await taskSentFor(context, prompt);
    expect(task).toBe(prompt);
    expect(row?.pointer_unexpanded).toBe('secret-path');
  });

  it('a symlink to a key store or a file under a GnuPG directory is excluded, a harmless neighbour is expanded', async () => {
    const context = makeContext();
    const dir = briefsDir(context);
    writeFileSync(join(dir, 'server.pem'), 'PEM-MARKER', 'utf8');
    symlinkSync(join(dir, 'server.pem'), join(dir, 'to-key.md'));
    mkdirSync(join(dir, '.gnupg'));
    writeFileSync(join(dir, '.gnupg', 'brief.md'), 'GNUPG-MARKER', 'utf8');
    mkdirSync(join(dir, '.sshuttle'));
    const ordinary = join(dir, '.sshuttle', 'brief.md');
    writeFileSync(ordinary, 'ORDINARY-MARKER', 'utf8');
    for (const path of [join(dir, 'to-key.md'), join(dir, '.gnupg', 'brief.md')]) {
      const { task, row } = await taskSentFor(context, TASK + ' Details in ' + path);
      expect(task, path).toBe(TASK + ' Details in ' + path);
      expect(row?.pointer_unexpanded, path).toBe('secret-path');
    }
    const prompt = TASK + ' Details in ' + ordinary;
    const { task, row } = await taskSentFor(context, prompt);
    expect(task).toBe(prompt + label(realpathSync(ordinary)) + 'ORDINARY-MARKER');
    expect(row?.pointer_expanded).toBe(true);
  });

  it('a directory in OMC_JEV_POINTER_EXPAND_SECRET_DIRS is never read; without the variable the same file is expanded', async () => {
    const context = makeContext();
    const dir = briefsDir(context);
    mkdirSync(join(dir, 'vault'));
    mkdirSync(join(dir, 'vault-notes'));
    const inside = join(dir, 'vault', 'brief.md');
    const sibling = join(dir, 'vault-notes', 'brief.md');
    writeFileSync(inside, 'VAULT-MARKER', 'utf8');
    writeFileSync(sibling, 'SIBLING-MARKER', 'utf8');
    const secretDirs = ON(context, { OMC_JEV_POINTER_EXPAND_SECRET_DIRS: join(dir, 'vault') });
    const refused = await taskSentFor(context, TASK + ' Details in ' + inside, secretDirs);
    expect(refused.task).toBe(TASK + ' Details in ' + inside);
    expect(refused.row?.pointer_unexpanded).toBe('secret-path');
    const siblingPrompt = TASK + ' Details in ' + sibling;
    const kept = await taskSentFor(context, siblingPrompt, secretDirs);
    expect(kept.task).toBe(siblingPrompt + label(realpathSync(sibling)) + 'SIBLING-MARKER');
    const unset = await taskSentFor(context, TASK + ' Details in ' + inside);
    expect(unset.task).toBe(TASK + ' Details in ' + inside + label(realpathSync(inside)) + 'VAULT-MARKER');
  });

  it('a path with .. segments: one that reaches a secret path is excluded; one that reaches an ordinary file is expanded', async () => {
    const context = makeContext();
    const dir = briefsDir(context);
    mkdirSync(join(dir, 'private', '.ssh'), { recursive: true });
    writeFileSync(join(dir, 'private', '.ssh', 'brief.md'), 'Secret brief.', 'utf8');
    mkdirSync(join(dir, 'dots-a'));
    mkdirSync(join(dir, 'dots-b'));
    const ordinary = briefFixture(context, 'ordinary.md', 'Brief reachable through "..".');
    const toSecret = dir + '/private/.ssh/../.ssh/brief.md';
    const excluded = await taskSentFor(context, TASK + ' Details in ' + toSecret);
    expect(excluded.task).not.toContain('Secret brief.');
    expect(excluded.task).not.toContain('source file');
    const viaDots = dir + '/dots-a/../dots-b/../ordinary.md';
    const prompt = TASK + ' Details in ' + viaDots;
    const expanded = await taskSentFor(context, prompt);
    expect(expanded.task).toBe(prompt + label(realpathSync(ordinary)) + 'Brief reachable through "..".');
  });

  it('a binary file (a zero byte in the first 8192 bytes): the task is unchanged', async () => {
    const context = makeContext();
    const dir = briefsDir(context);
    writeFileSync(join(dir, 'binary.md'), Buffer.from([0x41, 0x42, 0x00, 0x43]));
    const prompt = TASK + ' Details in ' + join(dir, 'binary.md');
    const { task, row } = await taskSentFor(context, prompt);
    expect(task).toBe(prompt);
    expect(row?.pointer_unexpanded).toBe('binary');
  });

  it('a file over 1 MiB: the task is unchanged and the file is not read', async () => {
    const context = makeContext();
    const dir = briefsDir(context);
    writeFileSync(join(dir, 'huge.md'), Buffer.alloc(1024 * 1024 + 1, 'a'));
    const prompt = TASK + ' Details in ' + join(dir, 'huge.md');
    const { task, row } = await taskSentFor(context, prompt);
    expect(task).toBe(prompt);
    expect(row?.pointer_unexpanded).toBe('too-large');
  });

  it('a prompt of 600 characters or more is not expanded, even with a path to a .md file in it', async () => {
    const context = makeContext();
    const brief = briefFixture(context);
    const prompt = TASK + ' Details in ' + brief + ' ' + 'x'.repeat(600);
    expect(prompt.length).toBeGreaterThanOrEqual(600);
    const { task } = await taskSentFor(context, prompt);
    expect(task).toBe(prompt);
  });

  it('a read error other than a missing file (a symlink loop) is logged as read-error', async () => {
    const context = makeContext();
    const dir = briefsDir(context);
    symlinkSync(join(dir, 'loop-b.md'), join(dir, 'loop-a.md'));
    symlinkSync(join(dir, 'loop-a.md'), join(dir, 'loop-b.md'));
    const prompt = TASK + ' Details in ' + join(dir, 'loop-a.md');
    const { task, row } = await taskSentFor(context, prompt);
    expect(task).toBe(prompt);
    expect(row?.pointer_expanded).toBe(false);
    expect(row?.pointer_unexpanded).toBe('read-error');
  });

  it('a relative path, a URL and a ./ path are not pointers; letters outside ASCII inside a path still are', async () => {
    const context = makeContext();
    briefsDir(context);
    for (const text of [
      'Read docs/sub/plan.md and review the payment module.',
      'See https://example.org/a/b.md and summarize.',
      'See ./brief.md and summarize.',
    ]) {
      const { task, row } = await taskSentFor(context, text);
      expect(task, text).toBe(text);
      expect(row?.pointer_expanded, text).toBe(false);
      expect(row?.pointer_unexpanded, text).toBeNull();
    }
    const accented = briefFixture(context, 'r\u00e9sum\u00e9-brief.md', 'Brief with letters outside ASCII in its path.');
    const prompt = 'Read ' + accented + ' and review the payment module.';
    const { task, row } = await taskSentFor(context, prompt);
    expect(task).toBe(prompt + label(realpathSync(accented)) + 'Brief with letters outside ASCII in its path.');
    expect(row?.pointer_expanded).toBe(true);
  });

  it('with an allowed dir configured, a file outside it is not read and one inside it is', async () => {
    const context = makeContext();
    const dir = briefsDir(context);
    mkdirSync(join(dir, 'allowed'));
    writeFileSync(join(dir, 'allowed', 'inside.md'), 'Inside the allowed dir.', 'utf8');
    writeFileSync(join(dir, 'outside.md'), 'Outside the allowed dir.', 'utf8');
    const only = ON(context, { OMC_JEV_POINTER_EXPAND_DIRS: join(dir, 'allowed') });
    const outsidePrompt = TASK + ' Details in ' + join(dir, 'outside.md');
    const outside = await taskSentFor(context, outsidePrompt, only);
    expect(outside.task).toBe(outsidePrompt);
    expect(outside.row?.pointer_unexpanded).toBe('outside-allowed-dirs');
    const insidePrompt = TASK + ' Details in ' + join(dir, 'allowed', 'inside.md');
    const inside = await taskSentFor(makeContext(), insidePrompt, only);
    expect(inside.task).toBe(insidePrompt + label(realpathSync(join(dir, 'allowed', 'inside.md'))) + 'Inside the allowed dir.');
  });

  it('a prompt without a path: the task is the prompt', async () => {
    const context = makeContext();
    briefsDir(context);
    const prompt = TASK + ' (no file path)';
    const { task, row } = await taskSentFor(context, prompt);
    expect(task).toBe(prompt);
    expect(row?.pointer_expanded).toBe(false);
  });
});

describe('fork skip row (model-routing point)', () => {
  const ROW_FIELDS = [
    'source_chars', 'sent_chars', 'cut_chars', 'input_complete', 'pointer_expanded', 'pointer_unexpanded',
    'questions_version', 'jev_model', 'usage_status', 'cost_usd', 'cost_basis',
  ];

  it('point active: a fork call gets one skipped row and no applied row, with no Jev question and the call unchanged', async () => {
    const context = makeContext();
    const before = receivedBodies.length;
    const output = await runHook(context, AGENT_CALL('fork', { prompt: 'Continue the work.' }), { OMC_JEV: 'model-routing:active', ...LOG_IDS });
    expect(receivedBodies.length).toBe(before);
    const rows = readLog(context, 'shadow.jsonl');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ point: 'model-routing', subagent_type: 'fork', skipped: 'fork', durationMs: 0, session_id: 'session-1' });
    for (const field of ROW_FIELDS) expect(rows[0], field).not.toHaveProperty(field);
    expect(readLog(context, 'applied.jsonl')).toEqual([]);
    expect(output?.hookSpecificOutput?.updatedInput).toBeUndefined();
  });

  it('with OMC_JEV_ROW_TELEMETRY=1 the skipped row carries the telemetry fields as null, never zero', async () => {
    const context = makeContext();
    await runHook(context, AGENT_CALL('fork', { prompt: 'Continue the work.' }), { OMC_JEV: 'model-routing:active', OMC_JEV_ROW_TELEMETRY: '1' });
    const [row] = readLog(context, 'shadow.jsonl');
    for (const field of ROW_FIELDS) expect(row[field], field).toBeNull();
    expect(row.durationMs).toBe(0);
  });

  it('point in shadow mode: the same skipped row and no request', async () => {
    const context = makeContext();
    const before = receivedBodies.length;
    await runHook(context, AGENT_CALL('fork', { prompt: 'Continue the work.' }), { OMC_JEV: 'model-routing:shadow' });
    expect(receivedBodies.length).toBe(before);
    const rows = readLog(context, 'shadow.jsonl');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ point: 'model-routing', subagent_type: 'fork', skipped: 'fork' });
  });

  it('a use marker on a fork call is not applied: no question, no applied or override line, the prompt keeps its marker line', async () => {
    const context = makeContext();
    const before = receivedBodies.length;
    const output = await runHook(context, AGENT_CALL('fork', { prompt: 'use sonnet low\n\nContinue the work.' }), {
      OMC_JEV: 'model-routing:active',
      OMC_JEV_MODEL_ROUTING_MARKER: '1',
    });
    expect(receivedBodies.length).toBe(before);
    const rows = readLog(context, 'shadow.jsonl');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ skipped: 'fork' });
    expect(rows[0]).not.toHaveProperty('marker');
    expect(rows[0]).not.toHaveProperty('override');
    expect(readLog(context, 'applied.jsonl')).toEqual([]);
    expect(readLog(context, 'overrides.jsonl')).toEqual([]);
    expect(output?.hookSpecificOutput?.updatedInput).toBeUndefined();
  });

  it('without OMC_JEV_LOG_DIR the skipped row goes to the jev directory of the state directory', async () => {
    const context = makeContext();
    await runHook(context, AGENT_CALL('fork', { prompt: 'Continue the work.' }), { OMC_JEV: 'model-routing:active', OMC_JEV_LOG_DIR: undefined });
    const rows = findLogs(context.stateDir, 'shadow.jsonl');
    expect(rows.map((row) => row.skipped)).toEqual(['fork']);
  });

  it('point off: a fork call writes no skipped row', async () => {
    const context = makeContext();
    await runHook(context, AGENT_CALL('fork', { prompt: 'Continue the work.' }), { OMC_JEV: '' });
    expect(readLog(context, 'shadow.jsonl')).toEqual([]);
  });

  it('control: a call of another type still asks Jev, and has no skipped row', async () => {
    const context = makeContext();
    const before = receivedBodies.length;
    await runHook(context, AGENT_CALL('executor', { prompt: 'Continue the work.', model: 'sonnet' }), { OMC_JEV: 'model-routing:active' });
    expect(routingRequests(before)).toHaveLength(1);
    expect(readLog(context, 'shadow.jsonl').some((row) => row.skipped === 'fork')).toBe(false);
  });
});
