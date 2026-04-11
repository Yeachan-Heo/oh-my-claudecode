/**
 * Tests for post-tool-verifier.mjs failure detection
 * Covers issue #696: false positive "permission denied" from Claude Code temp CWD errors on macOS
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { join } from 'path';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import process from 'process';
import { detectBashFailure, detectWriteFailure, isNonZeroExitWithOutput, summarizeAgentResult } from '../../scripts/post-tool-verifier.mjs';

const SCRIPT_PATH = join(process.cwd(), 'scripts', 'post-tool-verifier.mjs');
const TEMPLATE_HOOK_PATH = join(process.cwd(), 'templates', 'hooks', 'post-tool-use.mjs');

function runPostToolVerifier(input, env = {}) {
  return runHookScript(SCRIPT_PATH, input, env);
}

function runHookScript(scriptPath, input, env = {}) {
  const stdout = execSync(`node "${scriptPath}"`, {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 5000,
    env: { ...process.env, NODE_ENV: 'test', ...env },
  });
  return JSON.parse(stdout.trim());
}

function withTempDir(fn) {
  const tempDir = mkdtempSync(join(tmpdir(), 'post-tool-verifier-'));
  try {
    return fn(tempDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function skillStatePath(tempDir, sessionId) {
  return join(tempDir, '.omc', 'state', 'sessions', sessionId, 'skill-active-state.json');
}

function legacySkillStatePath(tempDir) {
  return join(tempDir, '.omc', 'state', 'skill-active-state.json');
}

function ralplanStatePath(tempDir, sessionId) {
  return join(tempDir, '.omc', 'state', 'sessions', sessionId, 'ralplan-state.json');
}

function writeSkillStateFixtures(tempDir, sessionId, skillName = 'plan') {
  mkdirSync(join(tempDir, '.omc', 'state', 'sessions', sessionId), { recursive: true });
  writeFileSync(
    skillStatePath(tempDir, sessionId),
    JSON.stringify({
      active: true,
      skill_name: skillName,
      session_id: sessionId,
      started_at: '2026-04-01T00:00:00.000Z',
      last_checked_at: '2026-04-01T00:00:00.000Z',
      reinforcement_count: 0,
      max_reinforcements: 5,
      stale_ttl_ms: 900000,
    }),
  );
  mkdirSync(join(tempDir, '.omc', 'state'), { recursive: true });
  writeFileSync(
    legacySkillStatePath(tempDir),
    JSON.stringify({
      active: true,
      skill_name: skillName,
    }),
  );
}

function writeRalplanStateFixture(tempDir, sessionId, overrides = {}) {
  mkdirSync(join(tempDir, '.omc', 'state', 'sessions', sessionId), { recursive: true });
  writeFileSync(
    ralplanStatePath(tempDir, sessionId),
    JSON.stringify({
      active: true,
      session_id: sessionId,
      current_phase: 'ralplan',
      started_at: '2026-04-01T00:00:00.000Z',
      ...overrides,
    }),
  );
}

describe('detectBashFailure', () => {
  describe('Claude Code temp CWD false positives (issue #696)', () => {
    it('should not flag macOS temp CWD permission error as a failure', () => {
      const output = 'zsh:1: permission denied: /var/folders/xx/yyyyyyy/T/claude-abc123def-cwd';
      expect(detectBashFailure(output)).toBe(false);
    });

    it('should not flag temp CWD error with different session id', () => {
      const output = 'zsh:1: permission denied: /var/folders/ab/cdefgh/T/claude-xyz789-cwd';
      expect(detectBashFailure(output)).toBe(false);
    });

    it('should not flag temp CWD error with different zsh line numbers', () => {
      const output = 'zsh:42: permission denied: /var/folders/ab/cdefgh/T/claude-abc000-cwd';
      expect(detectBashFailure(output)).toBe(false);
    });

    it('should not flag output that contains only a temp CWD error line', () => {
      const output = [
        'some normal output',
        'zsh:1: permission denied: /var/folders/xx/yyyyy/T/claude-abc123-cwd',
        'more normal output',
      ].join('\n');
      expect(detectBashFailure(output)).toBe(false);
    });

    it('should still flag real permission denied errors not matching the temp CWD pattern', () => {
      const output = 'bash: /etc/shadow: permission denied';
      expect(detectBashFailure(output)).toBe(true);
    });

    it('should flag real permission denied even when temp CWD noise is also present', () => {
      const output = [
        'zsh:1: permission denied: /var/folders/xx/yyyyy/T/claude-abc123-cwd',
        'rm: /protected/file: permission denied',
      ].join('\n');
      expect(detectBashFailure(output)).toBe(true);
    });
  });

  describe('real error detection', () => {
    it('should detect "error:" pattern', () => {
      expect(detectBashFailure('error: file not found')).toBe(true);
    });

    it('should detect "failed" pattern when it is a failure summary line', () => {
      expect(detectBashFailure('Build failed')).toBe(true);
    });

    it('should detect "command not found"', () => {
      expect(detectBashFailure('zsh: command not found: foo')).toBe(true);
    });

    it('should detect Claude exit code failures', () => {
      expect(detectBashFailure('Error: Exit code 1')).toBe(true);
    });

    it('should detect textual exit code failures', () => {
      expect(detectBashFailure('exit code: 1')).toBe(true);
    });

    it('should detect "fatal:" pattern', () => {
      expect(detectBashFailure('fatal: not a git repository')).toBe(true);
    });

    it('should not flag successful pytest output containing failure words', () => {
      const output = [
        'tests/test_render.py::TestRender::test_ffmpeg_failure_raises PASSED',
        'tests/test_render.py::TestRender::test_qa_failure_propagates PASSED',
        '80 passed in 0.24s',
      ].join('\n');
      expect(detectBashFailure(output)).toBe(false);
    });

    it('should not flag successful grep output containing "Command failed" text', () => {
      const output = 'scripts/post-tool-verifier.mjs:683:        message = \'Command failed. Please investigate the error and fix before continuing.\'';
      expect(detectBashFailure(output)).toBe(false);
    });

    it('should not flag successful output when the word "error" appears mid-line', () => {
      const output = [
        'frame=   15 fps=0.0 q=-0.0 size=       0kB time=00:00:00.50 bitrate=   0.8kbits/s speed=5.6x',
        'codec-side-data: some harmless error metric label',
        'video:4kB audio:0kB subtitle:0kB other streams:0kB global headers:0kB muxing overhead: 0.000000%',
      ].join('\n');
      expect(detectBashFailure(output)).toBe(false);
    });

    it('should return false for clean output', () => {
      expect(detectBashFailure('All tests passed')).toBe(false);
    });

    it('should return false for empty output', () => {
      expect(detectBashFailure('')).toBe(false);
    });
  });
});

describe('isNonZeroExitWithOutput (issue #960)', () => {
  describe('should return true for non-zero exit with valid stdout', () => {
    it('gh pr checks with pending checks (exit code 8)', () => {
      const output = [
        'Error: Exit code 8',
        'Lint & Type Check  pass  47s  https://example.com/1',
        'Test               pending 0  https://example.com/2',
      ].join('\n');
      expect(isNonZeroExitWithOutput(output)).toBe(true);
    });

    it('generic non-zero exit with clean output', () => {
      const output = 'Error: Exit code 2\nSome valid output here';
      expect(isNonZeroExitWithOutput(output)).toBe(true);
    });

    it('exit code with multi-line valid output', () => {
      const output = [
        'Error: Exit code 1',
        'line 1: something',
        'line 2: something else',
        'line 3: all good',
      ].join('\n');
      expect(isNonZeroExitWithOutput(output)).toBe(true);
    });
  });

  describe('should return false for real failures', () => {
    it('exit code with error content in stdout', () => {
      const output = [
        'Error: Exit code 1',
        'FAIL src/test.js',
        'Test failed: expected 1 to equal 2',
      ].join('\n');
      expect(isNonZeroExitWithOutput(output)).toBe(false);
    });

    it('exit code with fatal error in stdout', () => {
      const output = 'Error: Exit code 128\nfatal: not a git repository';
      expect(isNonZeroExitWithOutput(output)).toBe(false);
    });

    it('exit code with permission denied in stdout', () => {
      const output = 'Error: Exit code 1\npermission denied: /etc/shadow';
      expect(isNonZeroExitWithOutput(output)).toBe(false);
    });

    it('exit code with "cannot" in stdout', () => {
      const output = 'Error: Exit code 1\ncannot find module "foo"';
      expect(isNonZeroExitWithOutput(output)).toBe(false);
    });
  });

  describe('should return false for non-matching cases', () => {
    it('exit code only, no stdout content', () => {
      expect(isNonZeroExitWithOutput('Error: Exit code 1')).toBe(false);
    });

    it('exit code with only whitespace after', () => {
      expect(isNonZeroExitWithOutput('Error: Exit code 1\n   \n  ')).toBe(false);
    });

    it('no exit code prefix at all', () => {
      expect(isNonZeroExitWithOutput('some normal output')).toBe(false);
    });

    it('empty string', () => {
      expect(isNonZeroExitWithOutput('')).toBe(false);
    });

    it('null/undefined', () => {
      expect(isNonZeroExitWithOutput(null)).toBe(false);
      expect(isNonZeroExitWithOutput(undefined)).toBe(false);
    });
  });
});

describe('detectWriteFailure', () => {
  describe('Claude Code temp CWD false positives (issue #696)', () => {
    it('should not flag macOS temp CWD permission error as a write failure', () => {
      const output = 'zsh:1: permission denied: /var/folders/xx/yyyyyyy/T/claude-abc123def-cwd';
      expect(detectWriteFailure(output)).toBe(false);
    });

    it('should not flag temp CWD error alongside successful write output', () => {
      const output = [
        'zsh:1: permission denied: /var/folders/xx/yyyyy/T/claude-abc123-cwd',
        'File written successfully.',
      ].join('\n');
      expect(detectWriteFailure(output)).toBe(false);
    });

    it('should still flag real permission denied on write operations', () => {
      const output = 'Write failed: permission denied on /etc/hosts';
      expect(detectWriteFailure(output)).toBe(true);
    });
  });

  describe('real write failure detection', () => {
    it('should detect "error:" in output', () => {
      expect(detectWriteFailure('error: file not found')).toBe(true);
      expect(detectWriteFailure('Error: ENOENT')).toBe(true);
    });

    it('should detect "failed to" in output', () => {
      expect(detectWriteFailure('failed to write file')).toBe(true);
      expect(detectWriteFailure('Failed to create directory')).toBe(true);
    });

    it('should detect "write failed" in output', () => {
      expect(detectWriteFailure('write failed for /tmp/foo')).toBe(true);
    });

    it('should detect "operation failed" in output', () => {
      expect(detectWriteFailure('Operation failed')).toBe(true);
    });

    it('should detect "read-only" in output', () => {
      expect(detectWriteFailure('filesystem is read-only')).toBe(true);
    });

    it('should detect "no such file" in output', () => {
      expect(detectWriteFailure('no such file or directory')).toBe(true);
    });

    it('should detect "directory not found" in output', () => {
      expect(detectWriteFailure('Directory not found')).toBe(true);
    });

    it('should return false for clean output', () => {
      expect(detectWriteFailure('File written successfully')).toBe(false);
    });
  });

  describe('false positive prevention (issue #1005)', () => {
    it('should not flag file content containing error-handling code', () => {
      expect(detectWriteFailure('const [error, setError] = useState(null)')).toBe(false);
      expect(detectWriteFailure('} catch (err) { console.error(err) }')).toBe(false);
      expect(detectWriteFailure('<div className="error-banner">{error}</div>')).toBe(false);
      expect(detectWriteFailure('export class ApiError extends Error {}')).toBe(false);
    });

    it('should not flag file content containing "failed" in identifiers or i18n keys', () => {
      expect(detectWriteFailure('t.auth.failedOidc')).toBe(false);
      expect(detectWriteFailure('const loginFailed = true')).toBe(false);
      expect(detectWriteFailure('expect(result).toBe("failed")')).toBe(false);
      expect(detectWriteFailure('assertLoginFailed(response)')).toBe(false);
    });

    it('should not flag file content containing "not found" without "directory" prefix', () => {
      expect(detectWriteFailure('// User not found in database')).toBe(false);
      expect(detectWriteFailure('message: "Resource not found"')).toBe(false);
      expect(detectWriteFailure('<NotFound />')).toBe(false);
    });

    it('should not flag typical React/JSX error handling patterns', () => {
      const jsxContent = `
        const [error, setError] = useState<string | null>(null);
        if (error) return <ErrorBanner message={error} />;
        try { await login(); } catch (e) { setError(e.message); }
      `;
      expect(detectWriteFailure(jsxContent)).toBe(false);
    });

    it('should not flag test assertion code', () => {
      const testContent = `
        it('should handle errors', () => {
          expect(handleError).toThrow();
          expect(result.error).toBeNull();
          expect(status).not.toBe('failed');
        });
      `;
      expect(detectWriteFailure(testContent)).toBe(false);
    });

    it('should still detect real tool-level errors alongside code content', () => {
      expect(detectWriteFailure('error: EACCES writing to /etc/hosts')).toBe(true);
      expect(detectWriteFailure('failed to write file: permission denied')).toBe(true);
      expect(detectWriteFailure('no such file or directory: /missing/path')).toBe(true);
    });
  });
});

describe('agent output summarization / truncation (issue #1373)', () => {
  it('summarizes multi-line agent output into concise single-line context', () => {
    const output = [
      'Completed worker step A',
      '',
      'Updated src/foo.ts',
      'Updated src/bar.ts',
      'Tests: 12 passed',
    ].join('\n');

    const summary = summarizeAgentResult(output, 80);
    expect(summary).toContain('Completed worker step A');
    expect(summary).toContain('Updated src/foo.ts');
    expect(summary.length).toBeLessThanOrEqual(80);
  });

  it('adds truncation guidance for oversized TaskOutput responses', () => {
    const huge = `ok:${'x'.repeat(5000)}`;
    const out = runPostToolVerifier(
      {
        tool_name: 'TaskOutput',
        tool_response: huge,
        session_id: 's-1373',
        cwd: process.cwd(),
      },
      {
        OMC_AGENT_OUTPUT_ANALYSIS_LIMIT: '300',
        OMC_AGENT_OUTPUT_SUMMARY_LIMIT: '90',
      },
    );

    expect(out.continue).toBe(true);
    expect(out.hookSpecificOutput?.additionalContext).toContain('TaskOutput summary:');
    expect(out.hookSpecificOutput?.additionalContext).toContain('TaskOutput clipped');
  });
});

describe('OMC_QUIET hook message suppression (issue #1646)', () => {
  it('suppresses routine success/advice messages at OMC_QUIET=1 while keeping failures', () => {
    const edit = runPostToolVerifier(
      {
        tool_name: 'Edit',
        tool_response: 'File updated successfully',
        session_id: 'quiet-1',
        cwd: process.cwd(),
      },
      { OMC_QUIET: '1' },
    );

    expect(edit).toEqual({ continue: true, suppressOutput: true });

    const grep = runPostToolVerifier(
      {
        tool_name: 'Grep',
        tool_response: '0',
        session_id: 'quiet-1',
        cwd: process.cwd(),
      },
      { OMC_QUIET: '1' },
    );

    expect(grep).toEqual({ continue: true, suppressOutput: true });

    const writeFailure = runPostToolVerifier(
      {
        tool_name: 'Write',
        tool_response: 'Write failed: permission denied on /etc/hosts',
        session_id: 'quiet-1',
        cwd: process.cwd(),
      },
      { OMC_QUIET: '1' },
    );

    expect(writeFailure.hookSpecificOutput?.additionalContext)
      .toContain('Write operation failed');
  });

  it('keeps important warnings at OMC_QUIET=2 but suppresses routine task summaries', () => {
    const nonZero = runPostToolVerifier(
      {
        tool_name: 'Bash',
        tool_response: 'Error: Exit code 8\nLint pass\nTest pending',
        session_id: 'quiet-2',
        cwd: process.cwd(),
      },
      { OMC_QUIET: '2' },
    );

    expect(nonZero.hookSpecificOutput?.additionalContext)
      .toContain('produced valid output');

    const taskSummary = withTempDir((tempDir) => {
      mkdirSync(join(tempDir, '.omc', 'state'), { recursive: true });
      writeFileSync(
        join(tempDir, '.omc', 'state', 'subagent-tracking.json'),
        JSON.stringify({
          agents: [{ status: 'running', agent_type: 'oh-my-claudecode:executor' }],
          total_completed: 1,
          total_failed: 0,
        }),
      );

      return runPostToolVerifier(
        {
          tool_name: 'TaskOutput',
          tool_response: 'Completed worker step A\nUpdated src/foo.ts\nTests: 12 passed',
          session_id: 'quiet-2',
          cwd: tempDir,
        },
        { OMC_QUIET: '2' },
      );
    });

    expect(taskSummary).toEqual({ continue: true, suppressOutput: true });
  });
});

describe('Skill active state cleanup on PostToolUse (issue #2103)', () => {
  it('clears session and legacy skill-active-state files for Skill completion in post-tool-verifier', () => {
    withTempDir((tempDir) => {
      const sessionId = 'skill-clear-script';
      writeSkillStateFixtures(tempDir, sessionId, 'plan');

      const out = runPostToolVerifier({
        tool_name: 'Skill',
        tool_input: { skill: 'oh-my-claudecode:plan' },
        tool_response: { ok: true },
        session_id: sessionId,
        cwd: tempDir,
      });

      expect(out).toEqual({ continue: true, suppressOutput: true });
      expect(existsSync(skillStatePath(tempDir, sessionId))).toBe(false);
      expect(existsSync(legacySkillStatePath(tempDir))).toBe(false);
    });
  });

  it('does not clear parent-owned skill-active-state for nested child Skill completion in post-tool-verifier', () => {
    withTempDir((tempDir) => {
      const sessionId = 'skill-nested-script';
      writeSkillStateFixtures(tempDir, sessionId, 'omc-setup');

      const out = runPostToolVerifier({
        tool_name: 'Skill',
        tool_input: { skill: 'oh-my-claudecode:mcp-setup' },
        tool_response: { ok: true },
        session_id: sessionId,
        cwd: tempDir,
      });

      expect(out).toEqual({ continue: true, suppressOutput: true });
      expect(existsSync(skillStatePath(tempDir, sessionId))).toBe(true);
      expect(existsSync(legacySkillStatePath(tempDir))).toBe(true);
    });
  });

  it('clears session and legacy skill-active-state files for the template post-tool hook path', () => {
    withTempDir((tempDir) => {
      const sessionId = 'skill-clear-template';
      writeSkillStateFixtures(tempDir, sessionId, 'plan');

      const out = runHookScript(TEMPLATE_HOOK_PATH, {
        tool_name: 'Skill',
        tool_input: { skill: 'oh-my-claudecode:plan' },
        tool_response: { ok: true },
        session_id: sessionId,
        cwd: tempDir,
      });

      expect(out).toEqual({ continue: true, suppressOutput: true });
      expect(existsSync(skillStatePath(tempDir, sessionId))).toBe(false);
      expect(existsSync(legacySkillStatePath(tempDir))).toBe(false);
    });
  });

  it('deactivates ralplan state when the ralplan skill completes in post-tool-verifier', () => {
    withTempDir((tempDir) => {
      const sessionId = 'ralplan-complete-script';
      writeRalplanStateFixture(tempDir, sessionId);

      const out = runPostToolVerifier({
        tool_name: 'Skill',
        tool_input: { skill: 'oh-my-claudecode:ralplan' },
        tool_response: { ok: true },
        session_id: sessionId,
        cwd: tempDir,
      });

      expect(out).toEqual({ continue: true, suppressOutput: true });

      const state = JSON.parse(readFileSync(ralplanStatePath(tempDir, sessionId), 'utf-8'));
      expect(state.active).toBe(false);
      expect(state.current_phase).toBe('complete');
      expect(state.deactivated_reason).toBe('skill_completed');
      expect(typeof state.completed_at).toBe('string');
    });
  });

  it('deactivates ralplan state when the consensus plan alias completes in the template hook path', () => {
    withTempDir((tempDir) => {
      const sessionId = 'ralplan-complete-template';
      writeRalplanStateFixture(tempDir, sessionId);

      const out = runHookScript(TEMPLATE_HOOK_PATH, {
        tool_name: 'Skill',
        tool_input: {
          skill: 'oh-my-claudecode:plan',
          args: '--consensus issue #2368',
        },
        tool_response: { ok: true },
        session_id: sessionId,
        cwd: tempDir,
      });

      expect(out).toEqual({ continue: true, suppressOutput: true });

      const state = JSON.parse(readFileSync(ralplanStatePath(tempDir, sessionId), 'utf-8'));
      expect(state.active).toBe(false);
      expect(state.current_phase).toBe('complete');
      expect(state.deactivated_reason).toBe('skill_completed');
      expect(typeof state.completed_at).toBe('string');
    });
  });
});
