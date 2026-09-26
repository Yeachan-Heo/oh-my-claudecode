import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NODE = process.execPath;
const CLEANUPS = [];

function makeContext() {
  const root = mkdtempSync(join(tmpdir(), 'jev-plugin-hook-wiring-'));
  CLEANUPS.push(root);
  const cwd = join(root, 'project');
  const home = join(root, 'home');
  const logDir = join(root, 'jev-log');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, cwd, home, logDir };
}

function hookEnv(context, point, overrides = {}) {
  return {
    ...process.env,
    HOME: context.home,
    USERPROFILE: context.home,
    CLAUDE_CONFIG_DIR: join(context.home, '.claude'),
    CLAUDE_PLUGIN_ROOT: '',
    DISABLE_OMC: '',
    OMC_SKIP_HOOKS: '',
    OMC_STATE_DIR: '',
    TYPESAFE_API_KEY: 'test-key',
    OMC_JEV: point,
    OMC_JEV_LOG_DIR: context.logDir,
    OMC_JEV_ENDPOINT: 'http://127.0.0.1:1/v1/systemone',
    NODE_ENV: 'test',
    ...overrides,
  };
}

function runHook(context, script, input, point, overrides = {}) {
  const stdout = execFileSync(NODE, [join(ROOT, 'scripts', script)], {
    cwd: context.cwd,
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 15_000,
    env: hookEnv(context, point, overrides),
  });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

function readPoint(context, point) {
  const logPath = join(context.logDir, 'shadow.jsonl');
  for (let i = 0; i < 120; i++) {
    if (existsSync(logPath)) {
      const entries = readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const entry = entries.find((candidate) => candidate.point === point);
      if (entry) return entry;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  throw new Error(`No ${point} shadow entry in ${logPath}`);
}

function initGit(cwd) {
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
}

function createRalphState(context) {
  initGit(context.cwd);
  const sessionId = 'jev-session';
  const stateDir = join(context.cwd, '.omc', 'state', 'sessions', sessionId);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'ralph-state.json'), JSON.stringify({
    active: true,
    session_id: sessionId,
    project_path: context.cwd,
    iteration: 1,
    max_iterations: 5,
    started_at: new Date().toISOString(),
    last_checked_at: new Date().toISOString(),
    prompt: 'Complete the bounded task and verify the result.',
  }));
  return sessionId;
}

afterEach(() => {
  for (const path of CLEANUPS.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('plugin hook script Jev wiring (#4120)', () => {
  it('records intent from the UserPromptSubmit script', () => {
    const context = makeContext();
    runHook(context, 'keyword-detector.mjs', {
      cwd: context.cwd,
      prompt: '/oh-my-claudecode:intent Describe the problem and constraints.',
    }, 'intent');

    expect(readPoint(context, 'intent')).toMatchObject({
      point: 'intent',
      state: { mode_name: 'intent' },
      heuristic: true,
    });
  });

  it('records skill-trigger from the UserPromptSubmit script', () => {
    const context = makeContext();
    runHook(context, 'keyword-detector.mjs', {
      cwd: context.cwd,
      prompt: '/oh-my-claudecode:ralph fix the regression',
    }, 'skill-trigger');

    expect(readPoint(context, 'skill-trigger')).toMatchObject({
      point: 'skill-trigger',
      state: { source: 'user-prompt-submit' },
      heuristic: ['ralph'],
    });
  });

  it('records task-size with the existing classifier from the UserPromptSubmit script', () => {
    const context = makeContext();
    runHook(context, 'keyword-detector.mjs', {
      cwd: context.cwd,
      prompt: 'Refactor the architecture across the entire codebase.',
    }, 'task-size');

    expect(readPoint(context, 'task-size')).toMatchObject({
      point: 'task-size',
      state: { source: 'user-prompt-submit' },
      heuristic: { size: 'large' },
    });
  });

  it('records model-routing from the PreToolUse script', () => {
    const context = makeContext();
    runHook(context, 'pre-tool-enforcer.mjs', {
      cwd: context.cwd,
      tool_name: 'Task',
      tool_input: {
        subagent_type: 'oh-my-claudecode:executor',
        description: 'Fix the regression',
        prompt: 'Fix the regression and add a test.',
        model: 'sonnet',
      },
    }, 'model-routing');

    expect(readPoint(context, 'model-routing')).toMatchObject({
      point: 'model-routing',
      state: {
        tool_name: 'Task',
        subagent_type: 'oh-my-claudecode:executor',
        task: 'Fix the regression and add a test.',
      },
      heuristic: { model: 'sonnet' },
    });
  });

  it('records loop-continuation for an active Ralph Stop hook', () => {
    const context = makeContext();
    const sessionId = createRalphState(context);
    runHook(context, 'persistent-mode.mjs', {
      cwd: context.cwd,
      session_id: sessionId,
      last_assistant_message: 'The task is not complete yet.',
    }, 'loop-continuation');

    expect(readPoint(context, 'loop-continuation')).toMatchObject({
      point: 'loop-continuation',
      state: { mode_name: 'ralph', should_block: true },
      heuristic: { mode: 'ralph', shouldBlock: true },
    });
  });

  it('records the current conservative Ralph verdict for a Stop completion claim', () => {
    const context = makeContext();
    const sessionId = createRalphState(context);
    runHook(context, 'persistent-mode.mjs', {
      cwd: context.cwd,
      session_id: sessionId,
      last_assistant_message: 'The task is complete.',
    }, 'ralph-verdict');

    expect(readPoint(context, 'ralph-verdict')).toMatchObject({
      point: 'ralph-verdict',
      state: {
        mode_name: 'ralph',
        completion_claim: 'The task is complete.',
        verification_available: false,
      },
      heuristic: false,
    });
  });

  it('records learner-extraction from the Stop hook assistant message', () => {
    const context = makeContext();
    runHook(context, 'persistent-mode.mjs', {
      cwd: context.cwd,
      session_id: 'jev-session',
      last_assistant_message: 'The issue was caused by a race condition. I fixed it by adding proper locking.',
    }, 'learner-extraction');

    expect(readPoint(context, 'learner-extraction')).toMatchObject({
      point: 'learner-extraction',
      state: { assistant_message: expect.stringContaining('race condition') },
      heuristic: { detected: true },
    });
  });

  it('records context-pruning from the PostToolUse context heuristic', () => {
    const context = makeContext();
    runHook(context, 'post-tool-verifier.mjs', {
      cwd: context.cwd,
      session_id: 'jev-session',
      tool_name: 'Read',
      tool_response: 'A retained tool result with useful context.\nMore content.',
      context_window: { used_percentage: 90 },
    }, 'context-pruning');

    expect(readPoint(context, 'context-pruning')).toMatchObject({
      point: 'context-pruning',
      heuristic: 'compact',
      state: {
        action: 'compact',
        context_percent: 90,
        candidateCount: 1,
      },
    });
  });

  it('records simplifier-trigger from the Stop code-simplifier script', () => {
    const context = makeContext();
    initGit(context.cwd);
    execFileSync('git', ['config', 'user.email', 'jev-test@example.invalid'], { cwd: context.cwd });
    execFileSync('git', ['config', 'user.name', 'Jev Test'], { cwd: context.cwd });
    mkdirSync(join(context.cwd, 'src'), { recursive: true });
    writeFileSync(join(context.cwd, 'src', 'sample.ts'), 'export const value = 1;\n');
    execFileSync('git', ['add', 'src/sample.ts'], { cwd: context.cwd });
    execFileSync('git', ['commit', '-m', 'baseline'], { cwd: context.cwd, stdio: 'ignore' });
    writeFileSync(join(context.cwd, 'src', 'sample.ts'), 'export const value = 2;\n');
    mkdirSync(join(context.home, '.omc'), { recursive: true });
    writeFileSync(join(context.home, '.omc', 'config.json'), JSON.stringify({ codeSimplifier: { enabled: true } }));

    runHook(context, 'code-simplifier.mjs', { cwd: context.cwd }, 'simplifier-trigger');

    expect(readPoint(context, 'simplifier-trigger')).toMatchObject({
      point: 'simplifier-trigger',
      state: { source: 'code-simplifier-stop' },
      heuristic: true,
    });
  });
});
