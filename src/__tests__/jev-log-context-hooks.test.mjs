/**
 * OMC_JEV_LOG_CONTEXT wiring in the five hook scripts that consult Jev: each
 * passes the ids of its hook input to the shadow-log line, and none of them
 * changes the line without the variable.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NODE = process.execPath;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLEANUPS = [];
let endpoint = '';
let server;

/** A local Jev stub that answers every question of a request with a valid answer of its type. */
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const answers = {};
      for (const [name, question] of Object.entries(JSON.parse(body).questions ?? {})) {
        if (question.type === 'choice') answers[name] = { type: 'choice', choice: Object.keys(question.criteria)[0] };
        else if (question.type === 'score') answers[name] = { type: 'score', score: 0 };
        else answers[name] = { type: 'noul', noul: 0.1 };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers }));
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
  const root = mkdtempSync(join(tmpdir(), 'jev-log-context-hooks-'));
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
    NODE_ENV: 'test',
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return env;
}

/** Run one hook script asynchronously, so the stub in this process can answer its resolver. */
function runHook(context, script, input, point, overrides = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(NODE, [join(ROOT, 'scripts', script)], {
      cwd: context.cwd,
      encoding: 'utf8',
      timeout: 30_000,
      env: hookEnv(context, point, overrides),
    }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin.end(JSON.stringify(input));
  });
}

function pointLines(context, point) {
  const logPath = join(context.logDir, 'shadow.jsonl');
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.point === point);
}

function initGitWithChange(context) {
  execFileSync('git', ['init'], { cwd: context.cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'jev-test@example.invalid'], { cwd: context.cwd });
  execFileSync('git', ['config', 'user.name', 'Jev Test'], { cwd: context.cwd });
  mkdirSync(join(context.cwd, 'src'), { recursive: true });
  writeFileSync(join(context.cwd, 'src', 'sample.ts'), 'export const value = 1;\n');
  execFileSync('git', ['add', 'src/sample.ts'], { cwd: context.cwd });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: context.cwd, stdio: 'ignore' });
  writeFileSync(join(context.cwd, 'src', 'sample.ts'), 'export const value = 2;\n');
  mkdirSync(join(context.home, '.omc'), { recursive: true });
  writeFileSync(join(context.home, '.omc', 'config.json'), JSON.stringify({ codeSimplifier: { enabled: true } }));
}

const CASES = [
  {
    hook: 'keyword-detector.mjs',
    point: 'intent',
    input: (cwd) => ({ cwd, session_id: 'session-kd', prompt: '/oh-my-claudecode:intent Describe the problem.' }),
    ids: { session_id: 'session-kd' },
  },
  {
    hook: 'pre-tool-enforcer.mjs',
    point: 'model-routing',
    input: (cwd) => ({
      cwd,
      session_id: 'session-pte',
      tool_use_id: 'toolu_pte',
      agent_id: 'agent-pte',
      agent_type: 'planner',
      tool_name: 'Task',
      tool_input: { subagent_type: 'oh-my-claudecode:executor', description: 'Fix', prompt: 'Fix the regression.', model: 'sonnet' },
    }),
    ids: { session_id: 'session-pte', tool_use_id: 'toolu_pte', agent_id: 'agent-pte', agent_type: 'planner' },
  },
  {
    hook: 'post-tool-verifier.mjs',
    point: 'context-pruning',
    input: (cwd) => ({
      cwd,
      session_id: 'session-ptv',
      tool_use_id: 'toolu_ptv',
      tool_name: 'Read',
      tool_response: 'A retained tool result with useful context.\nMore content.',
      context_window: { used_percentage: 90 },
    }),
    ids: { session_id: 'session-ptv', tool_use_id: 'toolu_ptv' },
  },
  {
    hook: 'persistent-mode.mjs',
    point: 'learner-extraction',
    input: (cwd) => ({ cwd, session_id: 'session-pm', last_assistant_message: 'The issue was a race condition. I fixed it with a lock.' }),
    ids: { session_id: 'session-pm' },
  },
  {
    hook: 'code-simplifier.mjs',
    point: 'simplifier-trigger',
    setup: initGitWithChange,
    input: (cwd) => ({ cwd, session_id: 'session-cs' }),
    ids: { session_id: 'session-cs' },
  },
];

describe('hook scripts with OMC_JEV_LOG_CONTEXT=1', () => {
  it.each(CASES)('$hook logs the ids of its hook input with the $point line', async ({ hook, point, input, ids, setup }) => {
    const context = makeContext();
    setup?.(context);
    await runHook(context, hook, input(context.cwd), point, { OMC_JEV_LOG_CONTEXT: '1' });
    const lines = pointLines(context, point);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ...ids, cwd: context.cwd, request_id: expect.stringMatching(UUID), mode: 'active' });
  }, 60_000);

  it('keyword-detector writes no ids without the variable', async () => {
    const context = makeContext();
    const { hook, point, input } = CASES[0];
    await runHook(context, hook, input(context.cwd), point);
    const [line] = pointLines(context, point);
    expect(Object.keys(line)).toEqual(['ts', 'point', 'mode', 'state', 'heuristic', 'jev', 'answers', 'durationMs']);
  }, 60_000);
});
