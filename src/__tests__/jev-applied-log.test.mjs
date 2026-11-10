/**
 * OMC_JEV_APPLIED_LOG: the hook scripts that act on an active Jev answer write
 * what the answer changed to applied.jsonl, next to shadow.jsonl, and nothing
 * without the variable.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isJevAppliedLogEnabled } from '../../scripts/lib/jev-shadow.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NODE = process.execPath;
const JEV_SHADOW_URL = pathToFileURL(join(ROOT, 'scripts', 'lib', 'jev-shadow.mjs')).href;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLEANUPS = [];
let endpoint = '';
let server;
// The stub's answers for the next requests: question name -> answer.
let stubAnswers = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const answers = {};
      for (const name of Object.keys(JSON.parse(body).questions ?? {})) {
        if (stubAnswers[name]) answers[name] = stubAnswers[name];
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: Object.keys(answers).length > 0 ? answers : { unknown: { type: 'noul', noul: 0 } } }));
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
  const root = mkdtempSync(join(tmpdir(), 'jev-applied-log-'));
  CLEANUPS.push(root);
  const cwd = join(root, 'project');
  const home = join(root, 'home');
  const logDir = join(root, 'jev-log');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, cwd, home, logDir };
}

function hookEnv(context, point, overrides = {}) {
  const env = {
    ...process.env,
    HOME: context.home,
    USERPROFILE: context.home,
    CLAUDE_CONFIG_DIR: join(context.home, '.claude'),
    CLAUDE_PLUGIN_ROOT: '',
    DISABLE_OMC: '',
    OMC_SKIP_HOOKS: '',
    OMC_STATE_DIR: '',
    TYPESAFE_API_KEY: 'test-key',
    OMC_JEV: point + ':active',
    OMC_JEV_LOG_DIR: context.logDir,
    OMC_JEV_ENDPOINT: endpoint,
    OMC_JEV_TIMEOUT_MS: '10000',
    OMC_JEV_APPLIED_LOG: '1',
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

function runHook(context, script, input, point, overrides = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(NODE, [join(ROOT, 'scripts', script)], {
      cwd: context.cwd,
      encoding: 'utf8',
      timeout: 30_000,
      env: hookEnv(context, point, overrides),
    }, (error, stdout) => {
      if (error) return reject(error);
      try {
        resolve(parseHookOutput(stdout));
      } catch (parseError) {
        reject(parseError);
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function readLog(context, file) {
  const path = join(context.logDir, file);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const TASK_CALL = (cwd, toolInput = {}) => ({
  cwd,
  session_id: 'session-1',
  tool_use_id: 'toolu_1',
  tool_name: 'Task',
  tool_input: { subagent_type: 'oh-my-claudecode:executor', description: 'Fix', prompt: 'Fix the regression and add a test.', model: 'sonnet', ...toolInput },
});

describe('isJevAppliedLogEnabled', () => {
  it.each([
    [{}, false],
    [{ OMC_JEV_APPLIED_LOG: '0' }, false],
    [{ OMC_JEV_APPLIED_LOG: 'on' }, false],
    [{ OMC_JEV_APPLIED_LOG: '1' }, true],
    [{ OMC_JEV_APPLIED_LOG: ' TRUE ' }, true],
  ])('%j -> %s', (env, expected) => {
    expect(isJevAppliedLogEnabled(env)).toBe(expected);
  });
});

describe('recordJevApplied', () => {
  function runApplied(context, env) {
    const script = `
      import { recordJevApplied, setJevHookContext } from ${JSON.stringify(JEV_SHADOW_URL)};
      await setJevHookContext({ session_id: 'session-9', cwd: '/work' });
      recordJevApplied('context-pruning', { action: { from: 'warn', to: 'none' } });
    `;
    execFileSync(NODE, ['--input-type=module', '-e', script], { cwd: context.cwd, env, timeout: 30_000 });
  }

  it('writes {ts, point, applied} without OMC_JEV_LOG_CONTEXT', () => {
    const context = makeContext();
    runApplied(context, hookEnv(context, 'context-pruning'));
    const lines = readLog(context, 'applied.jsonl');
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0])).toEqual(['ts', 'point', 'applied']);
    expect(lines[0]).toMatchObject({ point: 'context-pruning', applied: { action: { from: 'warn', to: 'none' } } });
  });

  it('adds the hook call ids with OMC_JEV_LOG_CONTEXT=1', () => {
    const context = makeContext();
    runApplied(context, hookEnv(context, 'context-pruning', { OMC_JEV_LOG_CONTEXT: '1' }));
    const [line] = readLog(context, 'applied.jsonl');
    expect(Object.keys(line)).toEqual(['ts', 'point', 'session_id', 'cwd', 'applied']);
    expect(line).toMatchObject({ session_id: 'session-9', cwd: '/work' });
  });

  it('writes nothing without the variable', () => {
    const context = makeContext();
    runApplied(context, hookEnv(context, 'context-pruning', { OMC_JEV_APPLIED_LOG: undefined }));
    expect(existsSync(join(context.logDir, 'applied.jsonl'))).toBe(false);
  });

  it('rotates applied.jsonl with OMC_JEV_LOG_MAX_MB like the resolver lines', () => {
    const context = makeContext();
    mkdirSync(context.logDir, { recursive: true });
    const before = (JSON.stringify({ ts: '2026-11-01T00:00:00.000Z', point: 'intent', applied: { pad: 'x'.repeat(80) } }) + '\n').repeat(12_000);
    writeFileSync(join(context.logDir, 'applied.jsonl'), before);
    runApplied(context, hookEnv(context, 'context-pruning', { OMC_JEV_LOG_MAX_MB: '1' }));
    const rotated = readdirSync(context.logDir).filter((name) => /^applied-\d{8}-\d{6}-\d+\.jsonl$/.test(name));
    expect(rotated).toHaveLength(1);
    expect(readFileSync(join(context.logDir, rotated[0]), 'utf8')).toBe(before);
    expect(readLog(context, 'applied.jsonl')).toHaveLength(1);
  });
});

describe('hook scripts with OMC_JEV_APPLIED_LOG=1', () => {
  it('model-routing: one line once the output carries Jev\'s model and effort', async () => {
    stubAnswers = { 'model-tier': { type: 'choice', choice: 'opus' }, effort: { type: 'score', score: 3 } };
    const context = makeContext();
    const output = await runHook(context, 'pre-tool-enforcer.mjs', TASK_CALL(context.cwd), 'model-routing');
    expect(output.hookSpecificOutput.updatedInput).toMatchObject({ model: 'opus', effort: 'xhigh' });
    const lines = readLog(context, 'applied.jsonl');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      ts: expect.any(String),
      point: 'model-routing',
      applied: { subagent_type: 'oh-my-claudecode:executor', model: { from: 'sonnet', to: 'opus' }, effort: { from: null, to: 'xhigh', score: 3 } },
    });
  }, 60_000);

  it('model-routing: the line and the shadow line share one request_id with OMC_JEV_LOG_CONTEXT=1', async () => {
    stubAnswers = { 'model-tier': { type: 'choice', choice: 'haiku' } };
    const context = makeContext();
    await runHook(context, 'pre-tool-enforcer.mjs', TASK_CALL(context.cwd), 'model-routing', { OMC_JEV_LOG_CONTEXT: '1' });
    const [shadow] = readLog(context, 'shadow.jsonl');
    const [applied] = readLog(context, 'applied.jsonl');
    expect(shadow.request_id).toMatch(UUID);
    expect(applied).toMatchObject({
      point: 'model-routing',
      session_id: 'session-1',
      tool_use_id: 'toolu_1',
      request_id: shadow.request_id,
      applied: { model: { from: 'sonnet', to: 'haiku' } },
    });
    expect(applied.applied).not.toHaveProperty('effort');
  }, 60_000);

  it('model-routing: no line when the answer changes nothing, in shadow mode, or without the variable', async () => {
    stubAnswers = { 'model-tier': { type: 'choice', choice: 'sonnet' } };
    const same = makeContext();
    await runHook(same, 'pre-tool-enforcer.mjs', TASK_CALL(same.cwd), 'model-routing');
    expect(readLog(same, 'applied.jsonl')).toEqual([]);

    stubAnswers = { 'model-tier': { type: 'choice', choice: 'opus' } };
    const shadow = makeContext();
    await runHook(shadow, 'pre-tool-enforcer.mjs', TASK_CALL(shadow.cwd), 'model-routing', { OMC_JEV: 'model-routing' });
    expect(readLog(shadow, 'applied.jsonl')).toEqual([]);

    const off = makeContext();
    await runHook(off, 'pre-tool-enforcer.mjs', TASK_CALL(off.cwd), 'model-routing', { OMC_JEV_APPLIED_LOG: undefined });
    expect(readLog(off, 'shadow.jsonl')).toHaveLength(1);
    expect(existsSync(join(off.logDir, 'applied.jsonl'))).toBe(false);
  }, 90_000);

  it('model-routing: a call without a model is compared with the model of its agent definition', async () => {
    // agents/executor.md names sonnet: an answer of sonnet changes nothing.
    stubAnswers = { 'model-tier': { type: 'choice', choice: 'sonnet' } };
    const same = makeContext();
    await runHook(same, 'pre-tool-enforcer.mjs', TASK_CALL(same.cwd, { model: undefined }), 'model-routing');
    expect(readLog(same, 'applied.jsonl')).toEqual([]);

    stubAnswers = { 'model-tier': { type: 'choice', choice: 'opus' } };
    const changed = makeContext();
    await runHook(changed, 'pre-tool-enforcer.mjs', TASK_CALL(changed.cwd, { model: undefined }), 'model-routing');
    expect(readLog(changed, 'applied.jsonl')).toEqual([
      expect.objectContaining({ applied: { subagent_type: 'oh-my-claudecode:executor', model: { from: 'sonnet', to: 'opus' } } }),
    ]);
  }, 90_000);

  it('model-routing: no line for an effort that only OMC_JEV_MAX_EFFORT lowered', async () => {
    stubAnswers = { 'model-tier': { type: 'choice', choice: 'sonnet' } };
    const context = makeContext();
    const output = await runHook(context, 'pre-tool-enforcer.mjs', TASK_CALL(context.cwd, { effort: 'xhigh' }), 'model-routing', { OMC_JEV_MAX_EFFORT: 'high' });
    expect(output.hookSpecificOutput.updatedInput).toMatchObject({ effort: 'high' });
    expect(readLog(context, 'applied.jsonl')).toEqual([]);
  }, 60_000);

  it('model-routing: OMC_JEV_MAX_EFFORT_ALWAYS caps the baseline effort too', async () => {
    const always = { OMC_JEV_MAX_EFFORT_ALWAYS: '1', OMC_JEV_MAX_EFFORT: 'high' };
    // Score 3 is high: with the cap on, the call would have run on high without Jev as well.
    stubAnswers = { effort: { type: 'score', score: 3 } };
    const same = makeContext();
    const sameOutput = await runHook(same, 'pre-tool-enforcer.mjs', TASK_CALL(same.cwd, { effort: 'xhigh' }), 'model-routing', always);
    expect(sameOutput.hookSpecificOutput.updatedInput).toMatchObject({ effort: 'high' });
    expect(readLog(same, 'applied.jsonl')).toEqual([]);

    // Score 1 is medium: the change is from the capped baseline (high), not from the incoming xhigh.
    stubAnswers = { effort: { type: 'score', score: 1 } };
    const lower = makeContext();
    await runHook(lower, 'pre-tool-enforcer.mjs', TASK_CALL(lower.cwd, { effort: 'xhigh' }), 'model-routing', always);
    expect(readLog(lower, 'applied.jsonl')).toEqual([
      expect.objectContaining({ applied: { subagent_type: 'oh-my-claudecode:executor', effort: { from: 'high', to: 'medium', score: 1 } } }),
    ]);

    // Without the always-on variable the cap bounds only Jev's own answer: the baseline stays xhigh.
    stubAnswers = { effort: { type: 'score', score: 3 } };
    const capOnly = makeContext();
    await runHook(capOnly, 'pre-tool-enforcer.mjs', TASK_CALL(capOnly.cwd, { effort: 'xhigh' }), 'model-routing', { OMC_JEV_MAX_EFFORT: 'high', OMC_JEV_MAX_EFFORT_ALWAYS: undefined });
    expect(readLog(capOnly, 'applied.jsonl')).toEqual([
      expect.objectContaining({ applied: { subagent_type: 'oh-my-claudecode:executor', effort: { from: 'xhigh', to: 'high', score: 3 } } }),
    ]);
  }, 90_000);

  it('model-routing: with forceInherit a call without a model is compared with the session model', async () => {
    const SESSION_MODEL = 'us.anthropic.claude-haiku-5-v1:0';
    const inherit = {
      OMC_ROUTING_FORCE_INHERIT: 'true',
      OMC_JEV_MODEL_ROUTING_ALL_AGENTS: '1',
      CLAUDE_MODEL: SESSION_MODEL,
      ANTHROPIC_MODEL: undefined,
      OMC_SUBAGENT_MODEL: undefined,
      CLAUDE_CODE_BEDROCK_SONNET_MODEL: undefined,
      CLAUDE_CODE_BEDROCK_OPUS_MODEL: undefined,
      CLAUDE_CODE_BEDROCK_HAIKU_MODEL: undefined,
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'us.anthropic.claude-sonnet-5-v1:0',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'us.anthropic.claude-opus-5-v1:0',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: SESSION_MODEL,
    };
    stubAnswers = { 'model-tier': { type: 'choice', choice: 'sonnet' } };
    const unpinned = makeContext();
    await runHook(unpinned, 'pre-tool-enforcer.mjs', TASK_CALL(unpinned.cwd, { subagent_type: 'general-purpose', model: undefined }), 'model-routing', inherit);
    expect(readLog(unpinned, 'applied.jsonl')).toEqual([
      expect.objectContaining({ applied: { subagent_type: 'general-purpose', model: { from: SESSION_MODEL, to: 'sonnet' } } }),
    ]);

    // An agent definition that names a tier still runs on that tier, so it stays the baseline:
    // agents/executor.md names sonnet.
    const definition = makeContext();
    await runHook(definition, 'pre-tool-enforcer.mjs', TASK_CALL(definition.cwd, { model: undefined }), 'model-routing', inherit);
    expect(readLog(definition, 'applied.jsonl')).toEqual([]);

    stubAnswers = { 'model-tier': { type: 'choice', choice: 'opus' } };
    const changed = makeContext();
    await runHook(changed, 'pre-tool-enforcer.mjs', TASK_CALL(changed.cwd, { model: undefined }), 'model-routing', inherit);
    expect(readLog(changed, 'applied.jsonl')).toEqual([
      expect.objectContaining({ applied: { subagent_type: 'oh-my-claudecode:executor', model: { from: 'sonnet', to: 'opus' } } }),
    ]);
  }, 120_000);

  it('model-routing: no line for a call that a later check of the hook denies', async () => {
    stubAnswers = { 'model-tier': { type: 'choice', choice: 'opus' } };
    const context = makeContext();
    // A transcript at 90 % of its context window: the agent-heavy preflight blocks the call.
    const transcript = join(context.root, 'transcript.jsonl');
    writeFileSync(transcript, JSON.stringify({ context_window: 1000, usage: { input_tokens: 900 } }) + '\n');
    const output = await runHook(context, 'pre-tool-enforcer.mjs', { ...TASK_CALL(context.cwd), transcript_path: transcript }, 'model-routing');
    expect(output).toMatchObject({ decision: 'block' });
    expect(readLog(context, 'shadow.jsonl')).toHaveLength(1);
    expect(readLog(context, 'applied.jsonl')).toEqual([]);
  }, 60_000);

  it('context-pruning: the action Jev changed', async () => {
    stubAnswers = { staleness: { type: 'score', score: 0 } };
    const context = makeContext();
    await runHook(context, 'post-tool-verifier.mjs', {
      cwd: context.cwd,
      session_id: 'session-1',
      tool_name: 'Read',
      tool_response: 'A retained tool result with useful context.\nMore content.',
      context_window: { used_percentage: 80 },
    }, 'context-pruning');
    const [line] = readLog(context, 'applied.jsonl');
    expect(line).toMatchObject({ point: 'context-pruning', applied: { action: { from: 'warn', to: 'none' }, staleness: 'fresh', message: 'none' } });
  }, 60_000);

  it('skill-trigger: the keywords Jev changed', async () => {
    stubAnswers = { 'skill-trigger': { type: 'choice', choice: 'none' } };
    const context = makeContext();
    await runHook(context, 'keyword-detector.mjs', { cwd: context.cwd, session_id: 'session-1', prompt: '/oh-my-claudecode:ralph fix the regression' }, 'skill-trigger');
    const [line] = readLog(context, 'applied.jsonl');
    expect(line).toMatchObject({ point: 'skill-trigger', applied: { keywords: { from: ['ralph'], to: [] }, choice: 'none' } });
  }, 60_000);

  it('task-size: the heavy modes a small answer suppressed', async () => {
    stubAnswers = { 'task-size': { type: 'choice', choice: 'small', confidence: 0.95 } };
    const context = makeContext();
    await runHook(context, 'keyword-detector.mjs', { cwd: context.cwd, session_id: 'session-1', prompt: 'quick: ralph fix the typo in the readme' }, 'task-size');
    const [line] = readLog(context, 'applied.jsonl');
    expect(line).toMatchObject({ point: 'task-size', applied: { size: 'small', confidence: 0.95, suppressed: ['ralph'] } });
  }, 60_000);

  it('task-size: no line for heavy modes that a winning size prefix dropped (OMC_JEV_TASK_SIZE_PREFIX_WINS)', async () => {
    const prompt = 'quick: ralph fix the typo in the readme';
    const env = { OMC_JEV_TASK_SIZE_PREFIX_WINS: '1', OMC_JEV_TASK_SIZE_NOTICE: '1' };
    // The prefix drops ralph whatever Jev answers; Jev's answer changed nothing here.
    for (const answer of [{ choice: 'large', confidence: 0.95 }, { choice: 'medium', confidence: 0.95 }, { choice: 'small', confidence: 0.5 }]) {
      stubAnswers = { 'task-size': { type: 'choice', ...answer } };
      const context = makeContext();
      const output = await runHook(context, 'keyword-detector.mjs', { cwd: context.cwd, session_id: 'session-1', prompt }, 'task-size', env);
      expect(JSON.stringify(output)).toContain('Heavy orchestration mode(s) suppressed: ralph');
      expect(readLog(context, 'shadow.jsonl')).toHaveLength(1);
      expect(readLog(context, 'applied.jsonl')).toEqual([]);
    }

    // Jev's own small answer is still recorded under the same variable.
    stubAnswers = { 'task-size': { type: 'choice', choice: 'small', confidence: 0.95 } };
    const small = makeContext();
    await runHook(small, 'keyword-detector.mjs', { cwd: small.cwd, session_id: 'session-1', prompt }, 'task-size', env);
    expect(readLog(small, 'applied.jsonl')).toEqual([
      expect.objectContaining({ point: 'task-size', applied: { size: 'small', confidence: 0.95, suppressed: ['ralph'] } }),
    ]);
  }, 90_000);

  it('loop-continuation: the mode Jev\'s "task complete" ended', async () => {
    stubAnswers = { task_complete: { type: 'noul', noul: 0.9 } };
    const context = makeContext();
    execFileSync('git', ['init'], { cwd: context.cwd, stdio: 'ignore' });
    const stateDir = join(context.cwd, '.omc', 'state', 'sessions', 'jev-session');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'ralph-state.json'), JSON.stringify({
      active: true,
      session_id: 'jev-session',
      project_path: context.cwd,
      iteration: 1,
      max_iterations: 5,
      started_at: new Date().toISOString(),
      last_checked_at: new Date().toISOString(),
      prompt: 'Complete the bounded task and verify the result.',
    }));
    await runHook(context, 'persistent-mode.mjs', { cwd: context.cwd, session_id: 'jev-session', last_assistant_message: 'The task is complete.' }, 'loop-continuation');
    const [line] = readLog(context, 'applied.jsonl');
    expect(line).toMatchObject({ point: 'loop-continuation', applied: { mode: 'ralph', completed: { from: false, to: true } } });
    expect(JSON.parse(readFileSync(join(stateDir, 'ralph-state.json'), 'utf8')).active).toBe(false);
  }, 60_000);
});
