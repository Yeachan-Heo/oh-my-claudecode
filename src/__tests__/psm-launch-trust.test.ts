/**
 * Regression tests for issue #2508:
 * PSM tmux sessions stalling on approval/confirm prompts.
 *
 * These are contract tests: they read the shell script source and assert that
 * the fix is in place. A reversion to bare `claude` (no trust flag) or removal
 * of the initial-context handling will immediately break these tests.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

const PSM_ROOT = join(__dirname, '../../skills/project-session-manager');
const TMUX_SH = join(PSM_ROOT, 'lib/tmux.sh');
const PSM_SH = join(PSM_ROOT, 'psm.sh');

function readScript(path: string): string {
  return readFileSync(path, 'utf-8');
}

describe('PSM launch trust fix (issue #2508)', () => {
  describe('tmux.sh psm_launch_claude', () => {
    let source: string;
    beforeAll(() => { source = readScript(TMUX_SH); });

    it('passes --dangerously-skip-permissions to claude', () => {
      expect(source).toContain('claude --dangerously-skip-permissions');
    });

    it('does NOT launch bare claude without the trust flag', () => {
      const bareClaudePattern = /send-keys[^\n]*"\s*claude\s*"\s*Enter/;
      expect(source).not.toMatch(bareClaudePattern);
    });

    it('accepts an initial_context parameter', () => {
      expect(source).toContain('local initial_context=');
    });

    it('preserves context-file injection for relative task files', () => {
      expect(source).toContain("tmux display-message -p -t \"$session_name\" '#{pane_current_path}'");
      expect(source).toContain('-f "$session_path/$initial_context"');
      expect(source).toContain('psm_inject_prompt "$session_name" "$initial_context"');
    });

    it('delivers literal prompts via tmux send-keys in a background subshell', () => {
      expect(source).toContain('send-keys -t "$session_name" -l -- "$initial_context"');
      expect(source).toMatch(/\(\s*[\s\S]*?sleep[\s\S]*?send-keys[\s\S]*?\)\s*&/m);
    });

    it('documents PSM_CLAUDE_STARTUP_DELAY env var for tuning', () => {
      expect(source).toContain('PSM_CLAUDE_STARTUP_DELAY');
    });
  });

  describe('psm.sh command functions — task context delivery', () => {
    let source: string;
    beforeAll(() => { source = readScript(PSM_SH); });

    it('cmd_review passes the rendered review context file to psm_launch_claude', () => {
      expect(source).toContain('local context_rel=".psm/review.md"');
      expect(source).toContain('psm_launch_claude "$session_name" "$context_rel"');
    });

    it('cmd_fix passes the rendered issue context file to psm_launch_claude', () => {
      expect(source).toContain('local fix_context_rel=".psm/fix.md"');
      expect(source).toContain('psm_launch_claude "$session_name" "$fix_context_rel"');
    });

    it('cmd_feature still passes a literal feature prompt to psm_launch_claude', () => {
      expect(source).toMatch(/feature_prompt=.*feature_name/s);
      expect(source).toContain('psm_launch_claude "$session_name" "$feature_prompt"');
    });

    it('no command calls psm_launch_claude with only a session name (no task context)', () => {
      const bareCall = /^\s*psm_launch_claude\s+"\$session_name"\s*$/m;
      expect(source).not.toMatch(bareCall);
    });
  });
});
