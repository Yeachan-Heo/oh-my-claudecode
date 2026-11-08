/**
 * Regression tests for scripts/verify-deliverables.mjs (issue #3233).
 *
 * verify-deliverables.mjs runs on the SubagentStop hook event. Previously, when
 * required deliverables were missing it returned
 * { continue: true, hookSpecificOutput: { additionalContext: "..." } }, which
 * Claude Code reinjects into the finishing subagent's context — the same loop
 * that #3209 fixed for subagent-tracker. The hook must instead always suppress
 * its own output: { continue: true, suppressOutput: true } with no
 * additionalContext / hookSpecificOutput.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import process from 'node:process';

const SCRIPT_PATH = join(process.cwd(), 'scripts', 'verify-deliverables.mjs');

function runHook(input) {
  // Strip CLAUDE_PLUGIN_ROOT / OMC_STATE_DIR so resolveOmcStateRoot uses the
  // inline fallback (<cwd>/.omc) and reads the fixtures written below.
  const env = { ...process.env, NODE_ENV: 'test' };
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.OMC_STATE_DIR;
  const stdout = execFileSync('node', [SCRIPT_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 5000,
    env,
  });
  return JSON.parse(stdout.trim());
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-deliverables-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeFixtures(dir, sessionId, { stage = 'team-plan', files = ['DESIGN.md'], minSize = 10 } = {}) {
  const omcRoot = join(dir, '.omc');
  mkdirSync(omcRoot, { recursive: true });
  writeFileSync(
    join(omcRoot, 'deliverables.json'),
    JSON.stringify({ [stage]: { files, minSize } }),
  );
  const sessionDir = join(omcRoot, 'state', 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, 'team-state.json'),
    JSON.stringify({ current_phase: stage }),
  );
}

describe('verify-deliverables SubagentStop output (issue #3233)', () => {
  it('suppresses output without additionalContext when deliverables are missing', () => {
    withTempDir((dir) => {
      const sessionId = 'sess-missing';
      writeFixtures(dir, sessionId);
      // Note: DESIGN.md is intentionally NOT created → missing deliverable.

      const result = runHook({
        hook_event_name: 'SubagentStop',
        cwd: dir,
        session_id: sessionId,
      });

      expect(result).toEqual({ continue: true, suppressOutput: true });
      expect(result.hookSpecificOutput).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('additionalContext');
    });
  });

  it('suppresses output when deliverables are present (control)', () => {
    withTempDir((dir) => {
      const sessionId = 'sess-present';
      writeFixtures(dir, sessionId);
      writeFileSync(
        join(dir, 'DESIGN.md'),
        '# Design\n\nThis document satisfies the minimum size requirement.\n',
      );

      const result = runHook({
        hook_event_name: 'SubagentStop',
        cwd: dir,
        session_id: sessionId,
      });

      expect(result).toEqual({ continue: true, suppressOutput: true });
      expect(result.hookSpecificOutput).toBeUndefined();
    });
  });
});
