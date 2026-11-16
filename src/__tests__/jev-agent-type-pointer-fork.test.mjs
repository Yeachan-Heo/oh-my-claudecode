/**
 * Three opt-in behaviours of the PreToolUse hook for Agent/Task calls:
 * OMC_AGENT_TYPE_DENY with OMC_AGENT_TYPE_DENY_MODE (deny list), OMC_JEV_POINTER_EXPAND
 * with OMC_JEV_POINTER_EXPAND_DIRS (pointer expansion), and the fork skip row of the
 * model-routing point. Each is also checked to leave the hook unchanged when unset.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, cwd, home, logDir };
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
    OMC_STATE_DIR: '',
    OMC_JEV: '',
    OMC_AGENT_TYPE_DENY: '',
    OMC_AGENT_TYPE_DENY_MODE: '',
    OMC_JEV_POINTER_EXPAND: '',
    OMC_JEV_POINTER_EXPAND_DIRS: '',
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

function runHook(context, input, overrides = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(NODE, [join(ROOT, 'scripts', 'pre-tool-enforcer.mjs')], {
      cwd: context.cwd,
      encoding: 'utf8',
      timeout: 30_000,
      env: hookEnv(context, overrides),
    }, (error, stdout) => {
      if (error) return reject(error);
      try {
        resolve(parseHookOutput(stdout));
      } catch (parseError) {
        reject(parseError);
      }
    });
    child.stdin.end(JSON.stringify({ cwd: context.cwd, session_id: 'session-1', tool_use_id: 'toolu_1', ...input }));
  });
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

describe('agent-type deny list (OMC_AGENT_TYPE_DENY, OMC_AGENT_TYPE_DENY_MODE)', () => {
  it('without the list and the mode: no refusal and no agent-type row', async () => {
    const context = makeContext();
    const output = await runHook(context, AGENT_CALL('general-purpose'));
    expect(output?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(readLog(context, 'agent-type.jsonl')).toEqual([]);
  });

  it('a list without the mode stays off: no refusal and no row', async () => {
    const context = makeContext();
    const output = await runHook(context, AGENT_CALL('general-purpose'), { OMC_AGENT_TYPE_DENY: 'general-purpose' });
    expect(output?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(readLog(context, 'agent-type.jsonl')).toEqual([]);
  });

  it('deny: a listed type is refused with a reason, before any Jev query', async () => {
    const context = makeContext();
    const before = receivedBodies.length;
    const output = await runHook(context, AGENT_CALL('claude'), {
      OMC_AGENT_TYPE_DENY: 'general-purpose, claude',
      OMC_AGENT_TYPE_DENY_MODE: 'deny',
      OMC_JEV: 'model-routing:active',
    });
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(denyReason(output)).toContain('[AGENT TYPE] "claude"');
    expect(receivedBodies.length).toBe(before);
    expect(readLog(context, 'agent-type.jsonl').map((row) => row.decision)).toEqual(['deny']);
  });

  it('deny: a call without subagent_type is judged as general-purpose', async () => {
    const context = makeContext();
    const output = await runHook(context, AGENT_CALL(undefined), { OMC_AGENT_TYPE_DENY: 'general-purpose', OMC_AGENT_TYPE_DENY_MODE: 'deny' });
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(denyReason(output)).toContain('(no subagent_type)');
  });

  it('deny: a type that is not listed passes and is logged as allow', async () => {
    const context = makeContext();
    const output = await runHook(context, AGENT_CALL('docs'), { OMC_AGENT_TYPE_DENY: 'general-purpose', OMC_AGENT_TYPE_DENY_MODE: 'deny' });
    expect(output?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    const rows = readLog(context, 'agent-type.jsonl');
    expect(rows.map((row) => [row.decision, row.mode, row.subagent_type])).toEqual([['allow', 'deny', 'docs']]);
  });

  it('shadow: a listed type is only logged as would-deny, the call passes', async () => {
    const context = makeContext();
    const output = await runHook(context, AGENT_CALL('general-purpose'), { OMC_AGENT_TYPE_DENY: 'general-purpose', OMC_AGENT_TYPE_DENY_MODE: 'shadow' });
    expect(output?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(readLog(context, 'agent-type.jsonl').map((row) => row.decision)).toEqual(['would-deny']);
  });
});

describe('pointer expansion (OMC_JEV_POINTER_EXPAND, OMC_JEV_POINTER_EXPAND_DIRS)', () => {
  function briefFixture(context, text = 'BRIEF-MARKER: do the migration step by step.') {
    const dir = join(context.root, 'briefs');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'brief.md');
    writeFileSync(path, text, 'utf8');
    return path;
  }
  const POINTER_CALL = (path) => AGENT_CALL('executor', { prompt: path });

  it('switch on, file under an allowed dir: the Jev state carries the head of the file', async () => {
    const context = makeContext();
    const brief = briefFixture(context);
    const before = receivedBodies.length;
    await runHook(context, POINTER_CALL(brief), {
      OMC_JEV: 'model-routing:shadow',
      OMC_JEV_POINTER_EXPAND: '1',
      OMC_JEV_POINTER_EXPAND_DIRS: join(context.root, 'briefs'),
      OMC_JEV_ROW_TELEMETRY: '1',
    });
    const sent = receivedBodies.slice(before).join('\n');
    expect(sent).toContain('BRIEF-MARKER');
    expect(sent).toContain('head of file');
    const row = readLog(context, 'shadow.jsonl').find((x) => x.point === 'model-routing' && 'pointer_expanded' in x);
    expect(row?.pointer_expanded).toBe(true);
    expect(row?.pointer_unexpanded).toBeNull();
  });

  it('switch on, no allowed dirs (empty default): the file is never read and the reason is logged', async () => {
    const context = makeContext();
    const brief = briefFixture(context);
    const before = receivedBodies.length;
    await runHook(context, POINTER_CALL(brief), { OMC_JEV: 'model-routing:shadow', OMC_JEV_POINTER_EXPAND: '1', OMC_JEV_ROW_TELEMETRY: '1' });
    expect(receivedBodies.slice(before).join('\n')).not.toContain('BRIEF-MARKER');
    const rows = readLog(context, 'shadow.jsonl');
    expect(rows.some((x) => x.pointer_unexpanded === 'outside-allowed-dirs')).toBe(true);
  });

  it('switch unset: the prompt is sent as it was, even with an allowed dir', async () => {
    const context = makeContext();
    const brief = briefFixture(context);
    const before = receivedBodies.length;
    await runHook(context, POINTER_CALL(brief), { OMC_JEV: 'model-routing:shadow', OMC_JEV_POINTER_EXPAND_DIRS: join(context.root, 'briefs') });
    expect(receivedBodies.slice(before).join('\n')).not.toContain('BRIEF-MARKER');
  });
});

describe('fork skip row (model-routing point)', () => {
  it('point active: a fork call gets one skipped row and no applied row, with no Jev question', async () => {
    const context = makeContext();
    const before = receivedBodies.length;
    await runHook(context, AGENT_CALL('fork', { prompt: 'Continue the work.' }), { OMC_JEV: 'model-routing:active' });
    expect(receivedBodies.length).toBe(before);
    const rows = readLog(context, 'shadow.jsonl');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ point: 'model-routing', subagent_type: 'fork', skipped: 'fork', durationMs: 0 });
    expect(readLog(context, 'applied.jsonl')).toEqual([]);
  });

  it('point off: a fork call writes no skipped row', async () => {
    const context = makeContext();
    await runHook(context, AGENT_CALL('fork', { prompt: 'Continue the work.' }), { OMC_JEV: '' });
    expect(readLog(context, 'shadow.jsonl')).toEqual([]);
  });
});
