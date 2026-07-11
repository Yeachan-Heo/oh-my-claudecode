import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';

const persistentModeScript = join(process.cwd(), 'scripts', 'persistent-mode.mjs');
const preToolScript = join(process.cwd(), 'scripts', 'pre-tool-enforcer.mjs');
const keywordScript = join(process.cwd(), 'scripts', 'keyword-detector.mjs');

function runHook(script: string, payload: Record<string, unknown>, env: Record<string, string> = {}) {
  const stdout = execFileSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    cwd: process.cwd(),
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: '', ...env },
  });
  return JSON.parse(stdout);
}

function makeTempProject(prefix: string) {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(cwd, '.omc', 'state', 'sessions', 'session-a'), { recursive: true });
  return cwd;
}

function writeUltragoalState(cwd: string, overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  const state = {
    active: true,
    started_at: now,
    last_checked_at: now,
    session_id: 'session-a',
    project_path: cwd,
    current_phase: 'executing',
    claude_goal_objective: 'Complete issue #3098 ultragoal persistence.',
    ...overrides,
  };
  writeFileSync(
    join(cwd, '.omc', 'state', 'sessions', 'session-a', 'ultragoal-state.json'),
    `${JSON.stringify(state, null, 2)}\n`,
  );
  return state;
}

describe('ultragoal persistence and Claude /goal enforcement', () => {
  it('allows PreToolUse when active ultragoal has a matching active Claude /goal', () => {
    const cwd = makeTempProject('omc-ultragoal-pass-');
    writeUltragoalState(cwd);

    const result = runHook(preToolScript, {
      cwd,
      session_id: 'session-a',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      goal: { objective: 'Complete issue #3098 ultragoal persistence.', status: 'active' },
    });

    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });

  it('allows standalone active goal snapshot when no expected ultragoal objective exists', () => {
    const cwd = makeTempProject('omc-ultragoal-standalone-empty-');
    writeUltragoalState(cwd, { claude_goal_objective: '' });

    const result = runHook(preToolScript, {
      cwd,
      session_id: 'session-a',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      goal: { objective: 'Standalone Claude Code aggregate goal', status: 'active' },
    });

    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });

  it('allows ultragoal CLI bootstrap commands before Claude /goal is visible', () => {
    const cwd = makeTempProject('omc-ultragoal-bootstrap-');
    writeUltragoalState(cwd);

    const createGoals = runHook(preToolScript, {
      cwd,
      session_id: 'session-a',
      tool_name: 'Bash',
      tool_input: { command: 'omc ultragoal create-goals --brief "fix issue"' },
    });
    const completeGoals = runHook(preToolScript, {
      cwd,
      session_id: 'session-a',
      tool_name: 'Bash',
      tool_input: { command: 'omc ultragoal complete-goals' },
    });

    expect(createGoals.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    expect(completeGoals.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });

  it('allows cancel skill bootstrap paths when ultragoal goal snapshot is absent', () => {
    const cwd = makeTempProject('omc-ultragoal-cancel-bootstrap-');
    writeUltragoalState(cwd);

    const readCancelSkill = runHook(preToolScript, {
      cwd,
      session_id: 'session-a',
      tool_name: 'Read',
      tool_input: { file_path: join(process.cwd(), 'skills', 'cancel', 'SKILL.md') },
    });
    const invokeCancelSkill = runHook(preToolScript, {
      cwd,
      session_id: 'session-a',
      tool_name: 'Skill',
      tool_input: { skill: 'oh-my-claudecode:cancel' },
    });
    const clearState = runHook(preToolScript, {
      cwd,
      session_id: 'session-a',
      tool_name: 'mcp__omx_state__state_clear',
      tool_input: { mode: 'ultragoal' },
    });

    expect(readCancelSkill.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    expect(invokeCancelSkill.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    expect(clearState.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });

  it('denies PreToolUse when active ultragoal has no visible Claude /goal', () => {
    const cwd = makeTempProject('omc-ultragoal-deny-');
    writeUltragoalState(cwd);

    const result = runHook(preToolScript, {
      cwd,
      session_id: 'session-a',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });

    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain('ALLOW_ULTRAGOAL_WITHOUT_GOAL=1');
  });

  // Write a session-bound transcript (`<sessionId>.jsonl`) with the given record
  // contents, mirroring how Claude Code records `/goal` local-command output.
  function writeSessionTranscript(cwd: string, sessionId: string, contents: string[]) {
    const transcriptPath = join(cwd, `${sessionId}.jsonl`);
    writeFileSync(
      transcriptPath,
      `${contents
        .map(content => JSON.stringify({ type: 'user', message: { role: 'user', content } }))
        .join('\n')}\n`,
    );
    return transcriptPath;
  }

  it('allows PreToolUse when an active Claude /goal is recovered from the transcript', () => {
    const cwd = makeTempProject('omc-ultragoal-transcript-');
    writeUltragoalState(cwd);
    // Claude Code never puts /goal in the hook payload; it is only recorded in the
    // session transcript as a `/goal` local-command-stdout record. The guard must
    // recover it there instead of denying every tool for the whole run (regression
    // for #3341).
    const transcriptPath = writeSessionTranscript(cwd, 'session-a', [
      '<command-name>/goal</command-name>',
      '<local-command-stdout>Goal set: Complete issue #3098 ultragoal persistence.</local-command-stdout>',
    ]);

    const result = runHook(preToolScript, {
      cwd,
      session_id: 'session-a',
      transcript_path: transcriptPath,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });

    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });

  it('re-denies when the transcript shows the /goal was cleared', () => {
    const cwd = makeTempProject('omc-ultragoal-transcript-cleared-');
    writeUltragoalState(cwd);
    const transcriptPath = writeSessionTranscript(cwd, 'session-a', [
      '<local-command-stdout>Goal set: Complete issue #3098 ultragoal persistence.</local-command-stdout>',
      '<local-command-stdout>Goal cleared</local-command-stdout>',
    ]);

    const result = runHook(preToolScript, {
      cwd,
      session_id: 'session-a',
      transcript_path: transcriptPath,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });

    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('denies when the transcript is not the active session file (#3465 blocker 1)', () => {
    const cwd = makeTempProject('omc-ultragoal-foreign-transcript-');
    writeUltragoalState(cwd);
    // A canonical-looking record, but in a file not bound to this session.
    const foreignPath = join(cwd, 'not-the-session.jsonl');
    writeFileSync(
      foreignPath,
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '<local-command-stdout>Goal set: Complete issue #3098 ultragoal persistence.</local-command-stdout>' },
      })}\n`,
    );

    const result = runHook(preToolScript, {
      cwd,
      session_id: 'session-a',
      transcript_path: foreignPath,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });

    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('denies when transcript prose merely quotes "Goal set:" outside a /goal record (#3465 blocker 1)', () => {
    const cwd = makeTempProject('omc-ultragoal-prose-transcript-');
    writeUltragoalState(cwd);
    // Ordinary user message text (not a /goal local-command-stdout record) must not
    // authorize tools, even in the session-bound file.
    const transcriptPath = writeSessionTranscript(cwd, 'session-a', [
      'Please investigate: Goal set: Complete issue #3098 ultragoal persistence.',
    ]);

    const result = runHook(preToolScript, {
      cwd,
      session_id: 'session-a',
      transcript_path: transcriptPath,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });

    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('applies set/clear in order within one record, last-event-wins (#3465 blocker 2)', () => {
    const cwd = makeTempProject('omc-ultragoal-record-order-');
    writeUltragoalState(cwd);
    const transcriptPath = writeSessionTranscript(cwd, 'session-a', [
      '<local-command-stdout>Goal set: Complete issue #3098 ultragoal persistence.</local-command-stdout> then <local-command-stdout>Goal cleared</local-command-stdout>',
    ]);

    const result = runHook(preToolScript, {
      cwd,
      session_id: 'session-a',
      transcript_path: transcriptPath,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });

    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('denies an explicit payload goal whose objective does not match the plan (#3465 blocker 3)', () => {
    const cwd = makeTempProject('omc-ultragoal-payload-mismatch-');
    writeUltragoalState(cwd);

    const result = runHook(preToolScript, {
      cwd,
      session_id: 'session-a',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      goal: { objective: 'Some entirely unrelated objective', status: 'active' },
    });

    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('allows single ultragoal checkpoint / record-review-blockers commands', () => {
    const cwd = makeTempProject('omc-ultragoal-checkpoint-');
    writeUltragoalState(cwd);

    const checkpoint = runHook(preToolScript, {
      cwd,
      session_id: 'session-a',
      tool_name: 'Bash',
      tool_input: { command: 'omc ultragoal checkpoint --goal-id G001 --status complete' },
    });
    const blockers = runHook(preToolScript, {
      cwd,
      session_id: 'session-a',
      tool_name: 'Bash',
      tool_input: { command: 'omc ultragoal record-review-blockers --goal-id G001' },
    });

    expect(checkpoint.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    expect(blockers.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });

  it('does not let a checkpoint bypass smuggle a chained command (#3465 blocker 4)', () => {
    const cwd = makeTempProject('omc-ultragoal-checkpoint-chain-');
    writeUltragoalState(cwd);

    const result = runHook(preToolScript, {
      cwd,
      session_id: 'session-a',
      tool_name: 'Bash',
      tool_input: { command: 'omc ultragoal checkpoint --goal-id G001 --status complete && npm test' },
    });

    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('ignores stale ultragoal state in PreToolUse and Stop enforcement', () => {
    const cwd = makeTempProject('omc-ultragoal-stale-');
    writeUltragoalState(cwd, {
      started_at: '2000-01-01T00:00:00.000Z',
      last_checked_at: '2000-01-01T00:00:00.000Z',
    });

    const preTool = runHook(preToolScript, { cwd, session_id: 'session-a', tool_name: 'Bash', tool_input: {} });
    const stop = runHook(persistentModeScript, { cwd, session_id: 'session-a' });

    expect(preTool.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    expect(stop.continue).toBe(true);
  });

  it('ignores ultragoal state for another worktree', () => {
    const cwd = makeTempProject('omc-ultragoal-worktree-a-');
    const other = makeTempProject('omc-ultragoal-worktree-b-');
    writeUltragoalState(cwd, { project_path: other });

    const preTool = runHook(preToolScript, { cwd, session_id: 'session-a', tool_name: 'Bash', tool_input: {} });
    const stop = runHook(persistentModeScript, { cwd, session_id: 'session-a' });

    expect(preTool.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    expect(stop.continue).toBe(true);
  });

  it('does not reinject Stop continuation after ultragoal is all done', () => {
    const cwd = makeTempProject('omc-ultragoal-done-');
    writeUltragoalState(cwd, { current_phase: 'all-done', all_done: true });

    const stop = runHook(persistentModeScript, { cwd, session_id: 'session-a' });

    expect(stop.continue).toBe(true);
    expect(stop.decision).toBeUndefined();
  });

  it('does not activate ultragoal state for unrelated prose mentions', () => {
    const cwd = makeTempProject('omc-ultragoal-keyword-prose-');

    runHook(keywordScript, {
      cwd,
      session_id: 'session-a',
      prompt: 'Review whether ultragoal keyword activation steals unrelated prompts',
    });

    const statePath = join(cwd, '.omc', 'state', 'sessions', 'session-a', 'ultragoal-state.json');
    expect(existsSync(statePath)).toBe(false);
  });

  it('activates ultragoal session state from explicit natural-language invocation', () => {
    const cwd = makeTempProject('omc-ultragoal-keyword-natural-');

    runHook(keywordScript, { cwd, session_id: 'session-a', prompt: 'run ultragoal for issue #3098' });

    const statePath = join(cwd, '.omc', 'state', 'sessions', 'session-a', 'ultragoal-state.json');
    const state = JSON.parse(execFileSync('cat', [statePath], { encoding: 'utf-8' }));
    expect(state.active).toBe(true);
  });

  it('activates ultragoal session state from keyword-detector', () => {
    const cwd = makeTempProject('omc-ultragoal-keyword-');

    runHook(keywordScript, { cwd, session_id: 'session-a', prompt: '$ultragoal fix issue #3098' });

    const statePath = join(cwd, '.omc', 'state', 'sessions', 'session-a', 'ultragoal-state.json');
    const state = JSON.parse(execFileSync('cat', [statePath], { encoding: 'utf-8' }));
    expect(state.active).toBe(true);
    expect(state.session_id).toBe('session-a');
    expect(state.current_phase).toBe('executing');
  });
});
