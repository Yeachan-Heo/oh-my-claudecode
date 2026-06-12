import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const NODE = process.execPath;
const REPO_ROOT = resolve(join(__dirname, '..', '..'));
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'post-tool-use-failure.mjs');
const TEST_TMP_ROOT = join(REPO_ROOT, '.tmp-post-tool-use-failure-tests');

function runHook(input: Record<string, unknown>, extraEnv?: Record<string, string>) {
  const raw = execFileSync(NODE, [SCRIPT_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
      NODE_ENV: 'test',
      ...extraEnv,
    },
    timeout: 15000,
  }).trim();

  return JSON.parse(raw) as {
    continue: boolean;
    suppressOutput?: boolean;
    hookSpecificOutput?: {
      hookEventName?: string;
      additionalContext?: string;
    };
  };
}

describe('post-tool-use-failure.mjs', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  function makeRepoLocalTempDir() {
    mkdirSync(TEST_TMP_ROOT, { recursive: true });
    const cwd = mkdtempSync(join(TEST_TMP_ROOT, 'case-'));
    tempDirs.push(cwd);
    return cwd;
  }

  it('suppresses optional omx startup read method-not-found noise', () => {
    const cwd = makeRepoLocalTempDir();
    const errorPath = join(cwd, '.omc', 'state', 'last-tool-error.json');

    const result = runHook({
      tool_name: 'mcp__omx_state__state_read',
      tool_input: { mode: 'deep-interview' },
      error: 'Method not found',
      cwd,
    });

    expect(result).toEqual({ continue: true, suppressOutput: true });
    expect(existsSync(errorPath)).toBe(false);
  });

  it('preserves real failures for the same optional startup reads', () => {
    const cwd = makeRepoLocalTempDir();
    const errorPath = join(cwd, '.omc', 'state', 'last-tool-error.json');

    const result = runHook({
      tool_name: 'mcp__omx_state__state_read',
      tool_input: { mode: 'deep-interview' },
      error: 'Connection refused',
      cwd,
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).not.toBe(true);
    expect(result.hookSpecificOutput?.hookEventName).toBe('PostToolUseFailure');
    expect(result.hookSpecificOutput?.additionalContext).toContain(
      'Tool "mcp__omx_state__state_read" failed.',
    );

    expect(existsSync(errorPath)).toBe(true);
    const errorState = JSON.parse(readFileSync(errorPath, 'utf-8')) as {
      tool_name: string;
      error: string;
      retry_count: number;
    };
    expect(errorState.tool_name).toBe('mcp__omx_state__state_read');
    expect(errorState.error).toBe('Connection refused');
    expect(errorState.retry_count).toBe(1);
  });

  it('suppresses broad AGENTS scan permission-denied noise for Bash', () => {
    const cwd = makeRepoLocalTempDir();
    const errorPath = join(cwd, '.omc', 'state', 'last-tool-error.json');

    const result = runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'pwd && find .. -name AGENTS.md -print',
      },
      error: [
        'find: ../systemd-private-123: Permission denied',
        'find: ../snap-private-tmp: Permission denied',
        'Command failed with exit code 1:',
      ].join('\n'),
      cwd,
    });

    expect(result).toEqual({ continue: true, suppressOutput: true });
    expect(existsSync(errorPath)).toBe(false);
  });

  it('does not suppress Bash permission-denied errors with actionable non-scan content', () => {
    const cwd = makeRepoLocalTempDir();
    const errorPath = join(cwd, '.omc', 'state', 'last-tool-error.json');

    const result = runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'find .. -name AGENTS.md -print',
      },
      error: [
        'find: ../systemd-private-123: Permission denied',
        'fatal: not a git repository (or any of the parent directories): .git',
      ].join('\n'),
      cwd,
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).not.toBe(true);
    expect(existsSync(errorPath)).toBe(true);
  });

  it('writes to session-scoped path when session_id is provided in payload', () => {
    const cwd = makeRepoLocalTempDir();
    const sessionId = 'abc';
    const sessionPath = join(cwd, '.omc', 'state', 'sessions', sessionId, 'last-tool-error-state.json');
    const legacyPath = join(cwd, '.omc', 'state', 'last-tool-error.json');

    const result = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'false' },
      error: 'exit code 1',
      cwd,
      session_id: sessionId,
    });

    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput?.hookEventName).toBe('PostToolUseFailure');
    expect(existsSync(sessionPath)).toBe(true);
    expect(existsSync(legacyPath)).toBe(false);

    const state = JSON.parse(readFileSync(sessionPath, 'utf-8')) as {
      tool_name: string;
      error: string;
      retry_count: number;
    };
    expect(state.tool_name).toBe('Bash');
    expect(state.retry_count).toBe(1);
  });

  it('writes to legacy path when no session_id is present (back-compat)', () => {
    const cwd = makeRepoLocalTempDir();
    const legacyPath = join(cwd, '.omc', 'state', 'last-tool-error.json');

    const result = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'false' },
      error: 'exit code 1',
      cwd,
      // no session_id
    });

    expect(result.continue).toBe(true);
    expect(existsSync(legacyPath)).toBe(true);
    // session subdir should NOT be created
    expect(existsSync(join(cwd, '.omc', 'state', 'sessions'))).toBe(false);
  });

  it('uses OMC_SESSION_ID env var as fallback when payload has no session_id', () => {
    const cwd = makeRepoLocalTempDir();
    const sessionId = 'env-session-1';
    const sessionPath = join(cwd, '.omc', 'state', 'sessions', sessionId, 'last-tool-error-state.json');
    const legacyPath = join(cwd, '.omc', 'state', 'last-tool-error.json');

    runHook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'false' },
        error: 'exit code 1',
        cwd,
        // no session_id in payload
      },
      { OMC_SESSION_ID: sessionId },
    );

    expect(existsSync(sessionPath)).toBe(true);
    expect(existsSync(legacyPath)).toBe(false);
  });

  it('payload session_id takes priority over OMC_SESSION_ID env var', () => {
    const cwd = makeRepoLocalTempDir();
    const payloadSessionId = 'payload-session';
    const envSessionId = 'env-session';
    const payloadPath = join(cwd, '.omc', 'state', 'sessions', payloadSessionId, 'last-tool-error-state.json');
    const envPath = join(cwd, '.omc', 'state', 'sessions', envSessionId, 'last-tool-error-state.json');

    runHook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'false' },
        error: 'exit code 1',
        cwd,
        session_id: payloadSessionId,
      },
      { OMC_SESSION_ID: envSessionId },
    );

    expect(existsSync(payloadPath)).toBe(true);
    expect(existsSync(envPath)).toBe(false);
  });

  it('two consecutive invocations with different session_ids write to isolated files', () => {
    const cwd = makeRepoLocalTempDir();
    const sessionA = 'session-alpha';
    const sessionB = 'session-beta';
    const pathA = join(cwd, '.omc', 'state', 'sessions', sessionA, 'last-tool-error-state.json');
    const pathB = join(cwd, '.omc', 'state', 'sessions', sessionB, 'last-tool-error-state.json');

    // First invocation
    runHook({
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/x' },
      error: 'file not found',
      cwd,
      session_id: sessionA,
    });

    // Second invocation with different session
    runHook({
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      error: 'command failed',
      cwd,
      session_id: sessionB,
    });

    expect(existsSync(pathA)).toBe(true);
    expect(existsSync(pathB)).toBe(true);

    const stateA = JSON.parse(readFileSync(pathA, 'utf-8')) as { tool_name: string };
    const stateB = JSON.parse(readFileSync(pathB, 'utf-8')) as { tool_name: string };

    expect(stateA.tool_name).toBe('Edit');
    expect(stateB.tool_name).toBe('Bash');

    // Files are independent — different paths, different content
    expect(pathA).not.toBe(pathB);
  });

  describe('skip guards (DISABLE_OMC / OMC_SKIP_HOOKS)', () => {
    const FAILING_INPUT = {
      tool_name: 'Bash',
      tool_input: { command: 'false' },
      error: 'exit code 1',
    };

    function expectSkipped(cwd: string, extraEnv: Record<string, string>) {
      const result = runHook({ ...FAILING_INPUT, cwd }, extraEnv);
      // Skipped hooks emit a bare continue with no guidance injected.
      expect(result).toEqual({ continue: true });
      // No state directory/file is created when the hook no-ops.
      expect(existsSync(join(cwd, '.omc', 'state'))).toBe(false);
    }

    it('no-ops when DISABLE_OMC=1', () => {
      expectSkipped(makeRepoLocalTempDir(), { DISABLE_OMC: '1', OMC_SKIP_HOOKS: '' });
    });

    it('no-ops when DISABLE_OMC=true', () => {
      expectSkipped(makeRepoLocalTempDir(), { DISABLE_OMC: 'true', OMC_SKIP_HOOKS: '' });
    });

    it('no-ops when OMC_SKIP_HOOKS contains post-tool-use-failure', () => {
      expectSkipped(makeRepoLocalTempDir(), {
        DISABLE_OMC: '',
        OMC_SKIP_HOOKS: 'post-tool-use-failure',
      });
    });

    it('no-ops when OMC_SKIP_HOOKS contains the post-tool-use compat token', () => {
      expectSkipped(makeRepoLocalTempDir(), {
        DISABLE_OMC: '',
        OMC_SKIP_HOOKS: 'post-tool-use',
      });
    });

    it('honors whitespace and commas in OMC_SKIP_HOOKS', () => {
      expectSkipped(makeRepoLocalTempDir(), {
        DISABLE_OMC: '',
        OMC_SKIP_HOOKS: ' keyword-detector , post-tool-use-failure ',
      });
    });

    it('injects guidance normally when skip vars are empty', () => {
      const cwd = makeRepoLocalTempDir();
      const legacyPath = join(cwd, '.omc', 'state', 'last-tool-error.json');

      const result = runHook({ ...FAILING_INPUT, cwd }, { DISABLE_OMC: '', OMC_SKIP_HOOKS: '' });

      expect(result.continue).toBe(true);
      expect(result.hookSpecificOutput?.hookEventName).toBe('PostToolUseFailure');
      expect(result.hookSpecificOutput?.additionalContext).toContain('Tool "Bash" failed.');
      expect(existsSync(legacyPath)).toBe(true);
    });

    it('processes normally when DISABLE_OMC=false', () => {
      const cwd = makeRepoLocalTempDir();

      const result = runHook({ ...FAILING_INPUT, cwd }, { DISABLE_OMC: 'false', OMC_SKIP_HOOKS: '' });

      expect(result.hookSpecificOutput?.hookEventName).toBe('PostToolUseFailure');
    });

    it('does not skip for an unrelated OMC_SKIP_HOOKS token', () => {
      const cwd = makeRepoLocalTempDir();

      const result = runHook(
        { ...FAILING_INPUT, cwd },
        { DISABLE_OMC: '', OMC_SKIP_HOOKS: 'keyword-detector' },
      );

      expect(result.hookSpecificOutput?.hookEventName).toBe('PostToolUseFailure');
    });
  });
});
