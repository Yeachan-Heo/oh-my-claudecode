import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = join(process.cwd(), 'scripts', 'keyword-detector.mjs');
const NODE = process.execPath;

const tempDirs: string[] = [];

function makeCwd(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
});

function runKeywordDetector(prompt: string, cwd: string, sessionId: string) {
  const raw = execFileSync(NODE, [SCRIPT_PATH], {
    input: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      cwd,
      session_id: sessionId,
      prompt,
    }),
    encoding: 'utf-8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      OMC_SKIP_HOOKS: '',
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

function stateFile(cwd: string, sessionId: string, name: string) {
  return join(cwd, '.omc', 'state', 'sessions', sessionId, `${name}-state.json`);
}

describe('keyword-detector.mjs — pasted system-echo re-entry guard', () => {
  // Primary regression: user pastes a bare [RALPH LOOP - ITERATION N] block
  // (no other user request). Must NOT re-activate ralph.
  it('does NOT re-activate ralph for a bare [RALPH LOOP - ITERATION] paste', () => {
    const cwd = makeCwd('kd-echo-bare-ralph-');
    const sid = 'sess-bare-ralph';
    const prompt = [
      '[RALPH LOOP - ITERATION 3/100] Work is NOT done. Continue working.',
      'When FULLY complete (after Architect verification), run /oh-my-claudecode:cancel to cleanly exit ralph mode and clean up all state files. If cancel fails, retry with /oh-my-claudecode:cancel --force.',
      'Task: keep iterating on ralph until tests pass',
    ].join('\n');

    const output = runKeywordDetector(prompt, cwd, sid);

    expect(output.continue).toBe(true);
    expect(existsSync(stateFile(cwd, sid, 'ralph'))).toBe(false);
    expect(existsSync(stateFile(cwd, sid, 'ultrawork'))).toBe(false);
  });

  // Other modes' paste blocks must also not re-activate.
  it('does NOT re-activate autopilot from [AUTOPILOT #N/M] paste', () => {
    const cwd = makeCwd('kd-echo-autopilot-');
    const sid = 'sess-autopilot';
    const prompt = '[AUTOPILOT #2/20] Continue working.\nTask: foo';

    runKeywordDetector(prompt, cwd, sid);

    expect(existsSync(stateFile(cwd, sid, 'autopilot'))).toBe(false);
  });

  it('does NOT re-activate ultrawork from [ULTRAWORK #N/M] paste', () => {
    const cwd = makeCwd('kd-echo-ultrawork-');
    const sid = 'sess-ultrawork';
    const prompt = '[ULTRAWORK #3/50] Continue working.\nTask: bar';

    runKeywordDetector(prompt, cwd, sid);

    expect(existsSync(stateFile(cwd, sid, 'ultrawork'))).toBe(false);
  });

  // A "Stop hook feedback:" wrapper must also be recognized as echo.
  // Regression for Major #1 (GPT-5.5): isAntiSlopCleanupRequest bypasses
  // hasActionableKeyword. Stripping must happen upstream in the main dispatch
  // so all matchers benefit, not only the hasActionableKeyword ones.
  it('does NOT re-activate ai-slop-cleaner from a pasted echo whose Task line contains cleanup/deslop terms', () => {
    const cwd = makeCwd('kd-echo-anti-slop-');
    const sid = 'sess-anti-slop';
    const prompt = [
      '[RALPH LOOP - ITERATION 7/100] Work is NOT done.',
      'Task: please run ai-slop-cleaner and deslop the duplicated functions',
    ].join('\n');

    const output = runKeywordDetector(prompt, cwd, sid);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).not.toContain('[MAGIC KEYWORD: AI-SLOP-CLEANER]');
    expect(context).not.toContain('<ai-slop-cleaner-mode>');
    expect(existsSync(stateFile(cwd, sid, 'ai-slop-cleaner'))).toBe(false);
  });

  it('does NOT re-activate ralph when the prompt is a Stop hook feedback block', () => {
    const cwd = makeCwd('kd-echo-stop-hook-');
    const sid = 'sess-stop-hook';
    const prompt = [
      'Stop hook feedback:',
      '[RALPH LOOP - ITERATION 5/100] Work is NOT done.',
      'When FULLY complete (after Architect verification), run /oh-my-claudecode:cancel ...',
      'Task: previous ralph task prompt',
    ].join('\n');

    runKeywordDetector(prompt, cwd, sid);

    expect(existsSync(stateFile(cwd, sid, 'ralph'))).toBe(false);
  });

  // Sanity check: legitimate explicit invocation still works.
  it('STILL activates ralph for an explicit user request', () => {
    const cwd = makeCwd('kd-echo-real-invocation-');
    const sid = 'sess-real-ralph';

    const output = runKeywordDetector('ralph로 이 문제 계속 고쳐주세요', cwd, sid);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(output.continue).toBe(true);
    expect(context).toContain('[MAGIC KEYWORD: RALPH]');
    expect(existsSync(stateFile(cwd, sid, 'ralph'))).toBe(true);
  });

  // Regression for Codex automated review P1/P2 (third round): the previous
  // revision added standalone single-line strippers for `Task:\s`,
  // `When FULLY complete`, and `run /oh-my-claudecode:cancel`, which meant
  // a user's legitimate "Task: ralph로 이거 해줘" prompt would have its
  // only line removed before keyword dispatch. Continuation stripping must
  // happen ONLY in the context of an echo block header.
  it('STILL activates ralph for a user prompt that starts with "Task:" (no echo header)', () => {
    const cwd = makeCwd('kd-task-standalone-');
    const sid = 'sess-task-standalone';

    const output = runKeywordDetector('Task: ralph로 이 문제 계속 고쳐주세요', cwd, sid);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(context).toContain('[MAGIC KEYWORD: RALPH]');
    expect(existsSync(stateFile(cwd, sid, 'ralph'))).toBe(true);

    const state = JSON.parse(readFileSync(stateFile(cwd, sid, 'ralph'), 'utf-8'));
    // The user's `Task:` line is NOT treated as echo continuation here, so
    // its content is preserved in state.prompt (up to the 500-char cap).
    expect(state.prompt).toContain('이 문제 계속 고쳐주세요');
  });

  // Regression for Codex automated review P1: echo-block body was being
  // consumed all the way to EOF when no blank line separated it from the
  // user's follow-up request. Users commonly type the real request on the
  // immediate next line. Must STILL activate ralph in that shape.
  it('activates ralph when an echo block is DIRECTLY followed (no blank line) by a real ralph request', () => {
    const cwd = makeCwd('kd-echo-no-blank-');
    const sid = 'sess-echo-no-blank';

    const prompt = [
      '[RALPH LOOP - ITERATION 2/100] Work is NOT done.',
      'Task: previous task',
      'ralph로 새 작업 계속 진행',
    ].join('\n');

    const output = runKeywordDetector(prompt, cwd, sid);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(context).toContain('[MAGIC KEYWORD: RALPH]');
    expect(existsSync(stateFile(cwd, sid, 'ralph'))).toBe(true);

    const state = JSON.parse(readFileSync(stateFile(cwd, sid, 'ralph'), 'utf-8'));
    expect(state.prompt).toContain('새 작업 계속 진행');
    expect(state.prompt).not.toContain('[RALPH LOOP');
    expect(state.prompt).not.toContain('Task: previous task');
  });

  // Regression for hasActionableKeyword searchText-index alignment:
  // user quotes a previous RALPH LOOP block AND issues a fresh explicit ralph
  // request after a blank line. Stripping the echo must NOT prevent the
  // trailing real request from matching, because isInformationalKeywordContext
  // / hasExplicitInvocationContext need match.index to align with the
  // text they're inspecting (the stripped searchText).
  it('activates ralph when an echo block is followed by a blank line and a real ralph request', () => {
    const cwd = makeCwd('kd-echo-plus-real-ralph-');
    const sid = 'sess-echo-plus-real-ralph';

    const prompt = [
      '[RALPH LOOP - ITERATION 4/100] Work is NOT done.',
      'Task: previous task',
      '',
      'ralph로 새 작업 계속해줘',
    ].join('\n');

    const output = runKeywordDetector(prompt, cwd, sid);
    const context = output.hookSpecificOutput?.additionalContext ?? '';

    expect(context).toContain('[MAGIC KEYWORD: RALPH]');
    expect(existsSync(stateFile(cwd, sid, 'ralph'))).toBe(true);

    // state.prompt should capture the REAL request, not the echo sentinel,
    // when stripping leaves meaningful non-echo content.
    const state = JSON.parse(readFileSync(stateFile(cwd, sid, 'ralph'), 'utf-8'));
    expect(state.prompt).toContain('새 작업 계속해줘');
    expect(state.prompt).not.toContain('[RALPH LOOP');
    expect(state.prompt).not.toBe('(prompt omitted: pasted system echo)');
  });
});

describe('keyword-detector.mjs — state.prompt sanitization', () => {
  it('truncates oversized prompts when writing ralph state', () => {
    const cwd = makeCwd('kd-prompt-len-');
    const sid = 'sess-prompt-len';
    const longTail = 'x'.repeat(2000);
    const prompt = `ralph로 다음 긴 지시사항을 수행해주세요:\n${longTail}`;

    runKeywordDetector(prompt, cwd, sid);
    const path = stateFile(cwd, sid, 'ralph');
    expect(existsSync(path)).toBe(true);

    const state = JSON.parse(readFileSync(path, 'utf-8'));
    expect(typeof state.prompt).toBe('string');
    expect(state.prompt.length).toBeLessThanOrEqual(500);
  });

  it('records awaiting_confirmation_set_at on ralph state (enables 2-min TTL)', () => {
    const cwd = makeCwd('kd-setat-ralph-');
    const sid = 'sess-setat-ralph';

    runKeywordDetector('ralph로 시작해주세요', cwd, sid);
    const path = stateFile(cwd, sid, 'ralph');
    expect(existsSync(path)).toBe(true);

    const state = JSON.parse(readFileSync(path, 'utf-8'));
    expect(state.awaiting_confirmation).toBe(true);
    expect(typeof state.awaiting_confirmation_set_at).toBe('string');
    expect(Number.isFinite(new Date(state.awaiting_confirmation_set_at).getTime())).toBe(true);
  });

  it('records awaiting_confirmation_set_at on ultrawork state', () => {
    const cwd = makeCwd('kd-setat-ultrawork-');
    const sid = 'sess-setat-uw';

    runKeywordDetector('ulw로 시작해주세요', cwd, sid);
    const path = stateFile(cwd, sid, 'ultrawork');
    expect(existsSync(path)).toBe(true);

    const state = JSON.parse(readFileSync(path, 'utf-8'));
    expect(state.awaiting_confirmation).toBe(true);
    expect(typeof state.awaiting_confirmation_set_at).toBe('string');
  });
});
