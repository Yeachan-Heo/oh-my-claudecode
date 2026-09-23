import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..');
const RUN_CJS = join(REPO_ROOT, 'scripts', 'run.cjs');

// The trusted worker hooks, with the OMC_SKIP_HOOKS event token that makes each
// one take its early-return branch before it ever reads stdin (#4086).
const WORKER_HOOKS = [
  { script: 'pre-tool-enforcer.mjs', event: 'PreToolUse', skipToken: 'pre-tool-use' },
  { script: 'post-tool-verifier.mjs', event: 'PostToolUse', skipToken: 'post-tool-use' },
  { script: 'post-tool-rules-injector.mjs', event: 'PostToolUse', skipToken: 'post-tool-use' },
  { script: 'project-memory-posttool.mjs', event: 'PostToolUse', skipToken: 'post-tool-use' },
  { script: 'keyword-detector.mjs', event: 'UserPromptSubmit', skipToken: 'keyword-detector' },
] as const;

// Every declared budget for these hooks is >= 2500ms, so a skipped hook that
// still pays the timeout cannot fit inside this bound. Cold `node` start plus a
// worker is ~150ms on the slowest runner we ship to.
const SKIP_BUDGET_MS = 2000;

function payloadFor(event: string): string {
  return JSON.stringify({
    // Advice injection is deduplicated per session, so every probe needs its own
    // session id to observe the hook's payload-derived output.
    session_id: `run-cjs-worker-skip-guard-${randomUUID()}`,
    cwd: REPO_ROOT,
    hook_event_name: event,
    prompt: 'probe',
    tool_name: 'Read',
    tool_input: { file_path: 'probe.txt' },
    tool_response: { ok: true },
  });
}

function runHook(script: string, event: string, env: Record<string, string>) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [RUN_CJS, join(REPO_ROOT, 'scripts', script)], {
    input: payloadFor(event),
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: REPO_ROOT, ...env },
    timeout: 30_000,
  });
  return { ...result, elapsedMs: Date.now() - started };
}

describe('run.cjs trusted worker hooks (#4086)', () => {
  for (const { script, event, skipToken } of WORKER_HOOKS) {
    it(`returns immediately when OMC_SKIP_HOOKS short-circuits ${script}`, () => {
      const result = runHook(script, event, { OMC_SKIP_HOOKS: skipToken });

      // The worker used to idle on an unread stdin until the manifest budget
      // expired, so the wrapper reported a timeout and dropped the hook's own
      // protocol output.
      expect(result.stderr).not.toContain('timed out after');
      expect(result.stdout).toContain('"continue"');
      expect(JSON.parse(result.stdout).continue).toBe(true);
      expect(result.elapsedMs).toBeLessThan(SKIP_BUDGET_MS);
    });
  }

  it('returns immediately for every worker hook under DISABLE_OMC=1', () => {
    for (const { script, event } of WORKER_HOOKS) {
      const result = runHook(script, event, { DISABLE_OMC: '1' });

      expect(result.stderr, script).not.toContain('timed out after');
      expect(JSON.parse(result.stdout).continue, script).toBe(true);
      expect(result.elapsedMs, script).toBeLessThan(SKIP_BUDGET_MS);
    }
  });

  it('still delivers the payload to a hook that is not skipped', () => {
    // pre-tool-enforcer echoes payload-derived state, so a hook that reads
    // stdin must keep reading it: the fix may only release an unread stdin.
    const result = runHook('pre-tool-enforcer.mjs', 'PreToolUse', {});

    expect(result.stderr).not.toContain('timed out after');
    const parsed = JSON.parse(result.stdout) as {
      continue: boolean;
      hookSpecificOutput?: { hookEventName?: string };
    };
    expect(parsed.continue).toBe(true);
    expect(parsed.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
    expect(result.elapsedMs).toBeLessThan(SKIP_BUDGET_MS);
  });
});
