import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('child_process');
vi.unmock('node:child_process');

import { execFileSync } from 'child_process';
// @ts-expect-error Local hook helper is a JS module loaded directly by the tests.
import { evaluateAgentHeavyPreflight } from '../../scripts/lib/pre-tool-enforcer-preflight.mjs';

const SCRIPT_PATH = join(process.cwd(), 'scripts', 'pre-tool-enforcer.mjs');

function runPreToolEnforcer(input: Record<string, unknown>): Record<string, unknown> {
  return runPreToolEnforcerWithEnv(input);
}

function runPreToolEnforcerWithEnv(
  input: Record<string, unknown>,
  env: Record<string, string> = {},
): Record<string, unknown> {
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const homeDir = join(cwd, '.test-home');
  const stdout = execFileSync(process.execPath, [SCRIPT_PATH], {
    cwd,
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 5000,
    env: {
      ...process.env,
      HOME: homeDir,
      CLAUDE_CONFIG_DIR: join(homeDir, '.claude'),
      NODE_ENV: 'test',
      DISABLE_OMC: '',
      OMC_SKIP_HOOKS: '',
      // Reset Bedrock/routing env vars so tests are isolated from the host environment.
      // Tests that exercise Bedrock model-routing behaviour set these explicitly via `env`.
      OMC_AGENT_PREFLIGHT_CONTEXT_THRESHOLD: '',
      OMC_ROUTING_FORCE_INHERIT: '',
      OMC_SUBAGENT_MODEL: '',
      CLAUDE_MODEL: '',
      ANTHROPIC_MODEL: '',
      ...env,
    },
  });

  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

function writeJson(filePath: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function writeTranscriptWithContext(filePath: string, contextWindow: number, inputTokens: number): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const line = JSON.stringify({
    usage: { context_window: contextWindow, input_tokens: inputTokens },
    context_window: contextWindow,
    input_tokens: inputTokens,
  });
  writeFileSync(filePath, `${line}\n`, 'utf-8');
}

describe('pre-tool-enforcer fallback gating (issue #970)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pre-tool-enforcer-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('suppresses unknown-tool fallback when no active mode exists', () => {
    const output = runPreToolEnforcer({
      tool_name: 'ToolSearch',
      cwd: tempDir,
      session_id: 'session-970',
    });

    expect(output).toEqual({ continue: true, suppressOutput: true });
  });

  it('emits boulder fallback for unknown tools when session-scoped mode is active', () => {
    const sessionId = 'session-970';
    writeJson(
      join(tempDir, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json'),
      {
        active: true,
        session_id: sessionId,
      },
    );

    const output = runPreToolEnforcer({
      tool_name: 'ToolSearch',
      cwd: tempDir,
      session_id: sessionId,
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(hookSpecificOutput.additionalContext).toContain('The boulder never stops');
  });

  it('does not fall back to legacy mode files when a valid session_id is provided', () => {
    writeJson(join(tempDir, '.omc', 'state', 'ralph-state.json'), {
      active: true,
    });

    const output = runPreToolEnforcer({
      tool_name: 'mcp__omx_state__state_read',
      cwd: tempDir,
      session_id: 'session-970',
    });

    expect(output).toEqual({ continue: true, suppressOutput: true });
  });

  it('uses legacy mode files when session_id is not provided', () => {
    writeJson(join(tempDir, '.omc', 'state', 'ultrawork-state.json'), {
      active: true,
    });

    const output = runPreToolEnforcer({
      tool_name: 'mcp__omx_state__state_read',
      cwd: tempDir,
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(hookSpecificOutput.additionalContext).toContain('The boulder never stops');
  });

  // === Team-routing enforcement tests (issue #1006) ===

  it('injects team-routing redirect when Task called without team_name during active team session', () => {
    const sessionId = 'session-1006';
    writeJson(
      join(tempDir, '.omc', 'state', 'sessions', sessionId, 'team-state.json'),
      {
        active: true,
        session_id: sessionId,
        team_name: 'fix-ts-errors',
      },
    );

    const output = runPreToolEnforcer({
      tool_name: 'Task',
      toolInput: {
        subagent_type: 'oh-my-claudecode:executor',
        description: 'Fix type errors',
        prompt: 'Fix all type errors in src/auth/',
      },
      cwd: tempDir,
      session_id: sessionId,
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(hookSpecificOutput.additionalContext).toContain('TEAM ROUTING REQUIRED');
    expect(hookSpecificOutput.additionalContext).toContain('fix-ts-errors');
    expect(hookSpecificOutput.additionalContext).toContain('team_name=');
  });

  it('does NOT inject team-routing redirect when Task called WITH team_name', () => {
    const sessionId = 'session-1006b';
    writeJson(
      join(tempDir, '.omc', 'state', 'sessions', sessionId, 'team-state.json'),
      {
        active: true,
        session_id: sessionId,
        team_name: 'fix-ts-errors',
      },
    );

    const output = runPreToolEnforcer({
      tool_name: 'Task',
      toolInput: {
        subagent_type: 'oh-my-claudecode:executor',
        team_name: 'fix-ts-errors',
        name: 'worker-1',
        description: 'Fix type errors',
        prompt: 'Fix all type errors in src/auth/',
      },
      cwd: tempDir,
      session_id: sessionId,
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    // Should be a normal spawn message, not a redirect
    expect(String(hookSpecificOutput.additionalContext)).not.toContain('TEAM ROUTING REQUIRED');
    expect(String(hookSpecificOutput.additionalContext)).toContain('Spawning agent');
  });

  it('does NOT inject team-routing redirect when no team state is active', () => {
    const output = runPreToolEnforcer({
      tool_name: 'Task',
      toolInput: {
        subagent_type: 'oh-my-claudecode:executor',
        description: 'Fix type errors',
        prompt: 'Fix all type errors in src/auth/',
      },
      cwd: tempDir,
      session_id: 'session-no-team',
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(String(hookSpecificOutput.additionalContext)).not.toContain('TEAM ROUTING REQUIRED');
    expect(String(hookSpecificOutput.additionalContext)).toContain('Spawning agent');
  });

  it('reads team state from legacy path when session_id is absent', () => {
    writeJson(join(tempDir, '.omc', 'state', 'team-state.json'), {
      active: true,
      team_name: 'legacy-team',
    });

    const output = runPreToolEnforcer({
      tool_name: 'Task',
      toolInput: {
        subagent_type: 'oh-my-claudecode:executor',
        description: 'Fix something',
        prompt: 'Fix it',
      },
      cwd: tempDir,
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(hookSpecificOutput.additionalContext).toContain('TEAM ROUTING REQUIRED');
    expect(hookSpecificOutput.additionalContext).toContain('legacy-team');
  });

  it('respects session isolation — ignores team state from different session', () => {
    writeJson(
      join(tempDir, '.omc', 'state', 'sessions', 'other-session', 'team-state.json'),
      {
        active: true,
        session_id: 'other-session',
        team_name: 'other-team',
      },
    );

    const output = runPreToolEnforcer({
      tool_name: 'Task',
      toolInput: {
        subagent_type: 'oh-my-claudecode:executor',
        description: 'Fix something',
        prompt: 'Fix it',
      },
      cwd: tempDir,
      session_id: 'my-session',
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(String(hookSpecificOutput.additionalContext)).not.toContain('TEAM ROUTING REQUIRED');
  });

  it('keeps known tool messages unchanged (Bash, Read)', () => {
    const bash = runPreToolEnforcer({
      tool_name: 'Bash',
      cwd: tempDir,
    });
    const bashOutput = bash.hookSpecificOutput as Record<string, unknown>;
    expect(bashOutput.additionalContext).toBe(
      'Use parallel execution for independent tasks. Use run_in_background for long operations (npm install, builds, tests).',
    );

    const read = runPreToolEnforcer({
      tool_name: 'Read',
      cwd: tempDir,
    });
    const readOutput = read.hookSpecificOutput as Record<string, unknown>;
    expect(readOutput.additionalContext).toBe(
      'Read multiple files in parallel when possible for faster analysis.',
    );
  });

  it('suppresses routine pre-tool reminders when OMC_QUIET=1', () => {
    const bash = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Bash',
        cwd: tempDir,
      },
      { OMC_QUIET: '1' },
    );

    expect(bash).toEqual({ continue: true, suppressOutput: true });

    const read = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Read',
        cwd: tempDir,
      },
      { OMC_QUIET: '1' },
    );

    expect(read).toEqual({ continue: true, suppressOutput: true });
  });

  it('keeps active-mode and team-routing enforcement visible when OMC_QUIET is enabled', () => {
    const sessionId = 'session-1646';
    writeJson(
      join(tempDir, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json'),
      {
        active: true,
        session_id: sessionId,
      },
    );
    writeJson(
      join(tempDir, '.omc', 'state', 'sessions', sessionId, 'team-state.json'),
      {
        active: true,
        session_id: sessionId,
        team_name: 'quiet-team',
      },
    );

    const modeOutput = runPreToolEnforcerWithEnv(
      {
        tool_name: 'ToolSearch',
        cwd: tempDir,
        session_id: sessionId,
      },
      { OMC_QUIET: '2' },
    );

    expect(String((modeOutput.hookSpecificOutput as Record<string, unknown>).additionalContext))
      .toContain('The boulder never stops');

    const taskOutput = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Task',
        toolInput: {
          subagent_type: 'oh-my-claudecode:executor',
          description: 'Fix type errors',
          prompt: 'Fix all type errors in src/auth/',
        },
        cwd: tempDir,
        session_id: sessionId,
      },
      { OMC_QUIET: '2' },
    );

    expect(String((taskOutput.hookSpecificOutput as Record<string, unknown>).additionalContext))
      .toContain('TEAM ROUTING REQUIRED');
  });

  it('suppresses routine agent spawn chatter at OMC_QUIET=2 but not enforcement', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Task',
        toolInput: {
          subagent_type: 'oh-my-claudecode:executor',
          description: 'Fix type errors',
          prompt: 'Fix all type errors in src/auth/',
        },
        cwd: tempDir,
        session_id: 'session-1646-quiet',
      },
      { OMC_QUIET: '2' },
    );

    expect(output).toEqual({ continue: true, suppressOutput: true });
  });

  it('blocks agent-heavy Task preflight when transcript context budget is exhausted', () => {
    const transcriptPath = join(tempDir, 'transcript.jsonl');
    writeTranscriptWithContext(transcriptPath, 1000, 800); // 80%

    const output = evaluateAgentHeavyPreflight({
      toolName: 'Task',
      transcriptPath,
    });

    expect(output?.decision).toBe('block');
    expect(String(output?.reason)).toContain('Preflight context guard');
    expect(String(output?.reason)).toContain('Safe recovery');
  });

  it('falls back to the default preflight threshold when the env value is invalid', () => {
    const transcriptPath = join(tempDir, 'transcript.jsonl');
    writeTranscriptWithContext(transcriptPath, 1000, 800); // 80%

    const output = evaluateAgentHeavyPreflight({
      toolName: 'Task',
      transcriptPath,
      env: {
        ...process.env,
        OMC_AGENT_PREFLIGHT_CONTEXT_THRESHOLD: 'abc',
      },
    });

    expect(output?.decision).toBe('block');
    expect(String(output?.reason)).toContain('threshold: 72%');
  });

  it('allows non-agent-heavy tools even when transcript context is high', () => {
    const transcriptPath = join(tempDir, 'transcript.jsonl');
    writeTranscriptWithContext(transcriptPath, 1000, 900); // 90%

    const output = runPreToolEnforcer({
      tool_name: 'Read',
      cwd: tempDir,
      transcript_path: transcriptPath,
      session_id: 'session-1373',
    });

    expect(output.continue).toBe(true);
    expect(output.decision).toBeUndefined();
  });

  it('clears awaiting confirmation from session-scoped mode state when a skill is invoked', () => {
    const sessionId = 'session-confirm';
    const sessionStateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
    mkdirSync(sessionStateDir, { recursive: true });
    writeJson(join(sessionStateDir, 'ralph-state.json'), {
      active: true,
      awaiting_confirmation: true,
      session_id: sessionId,
    });
    writeJson(join(sessionStateDir, 'ultrawork-state.json'), {
      active: true,
      awaiting_confirmation: true,
      session_id: sessionId,
    });

    const output = runPreToolEnforcer({
      tool_name: 'Skill',
      toolInput: {
        skill: 'oh-my-claudecode:ralph',
      },
      cwd: tempDir,
      session_id: sessionId,
    });

    expect(output.continue).toBe(true);
    expect((output.hookSpecificOutput as Record<string, unknown>).additionalContext).toContain(
      'The boulder never stops',
    );
    expect(
      JSON.parse(readFileSync(join(sessionStateDir, 'ralph-state.json'), 'utf-8')).awaiting_confirmation,
    ).toBeUndefined();
    expect(
      JSON.parse(readFileSync(join(sessionStateDir, 'ultrawork-state.json'), 'utf-8')).awaiting_confirmation,
    ).toBeUndefined();
  });

  // === Model routing / forceInherit tests (issue #1868 catch-22) ===

  it('allows tier alias "sonnet" through when OMC_SUBAGENT_MODEL is set and forceInherit is enabled', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: { subagent_type: 'oh-my-claudecode:architect', model: 'sonnet' },
        cwd: tempDir,
        session_id: 'session-tier-alias',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: 'global.anthropic.claude-sonnet-4-6',
      },
    );

    // Tier alias + OMC_SUBAGENT_MODEL configured → allow through; Agent tool routes via OMC_SUBAGENT_MODEL
    expect(output.continue).toBe(true);
    expect(JSON.stringify(output)).not.toContain('MODEL ROUTING');
  });

  it('blocks tier alias "sonnet" when OMC_SUBAGENT_MODEL is NOT set in forceInherit mode', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: { subagent_type: 'oh-my-claudecode:architect', model: 'sonnet' },
        cwd: tempDir,
        session_id: 'session-tier-alias-no-subagent',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: '',
      },
    );

    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(hookOutput.permissionDecisionReason as string).toContain('MODEL ROUTING');
  });

  it('blocks tier alias when OMC_SUBAGENT_MODEL is itself a bare Anthropic model ID', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: { subagent_type: 'oh-my-claudecode:executor', model: 'sonnet' },
        cwd: tempDir,
        session_id: 'session-tier-alias-bare',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: 'claude-sonnet-4-6',
      },
    );

    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(hookOutput.permissionDecisionReason as string).toContain('MODEL ROUTING');
  });

  it('blocks tier alias when OMC_SUBAGENT_MODEL has a [1m] extended-context suffix', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: { subagent_type: 'oh-my-claudecode:executor', model: 'opus' },
        cwd: tempDir,
        session_id: 'session-tier-alias-lm',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: 'global.anthropic.claude-sonnet-4-6[1m]',
      },
    );

    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(hookOutput.permissionDecisionReason as string).toContain('MODEL ROUTING');
  });


  it('still blocks bare Anthropic model ID even when OMC_SUBAGENT_MODEL is set', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: { subagent_type: 'oh-my-claudecode:executor', model: 'claude-sonnet-4-6' },
        cwd: tempDir,
        session_id: 'session-bare-anthropic',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: 'global.anthropic.claude-sonnet-4-6',
      },
    );

    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(hookOutput.permissionDecisionReason as string).toContain('MODEL ROUTING');
  });

  // === Agent definition model routing (issue: subagent_type bare-model-id on Bedrock) ===

  it('denies Agent call with subagent_type whose definition has a bare Anthropic model ID when forceInherit is enabled', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: {
          subagent_type: 'oh-my-claudecode:critic',
          description: 'Review spec',
          prompt: 'Review this spec',
        },
        cwd: tempDir,
        session_id: 'session-agent-def-model',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: 'global.anthropic.claude-sonnet-4-6',
      },
    );

    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(hookOutput.permissionDecision).toBe('deny');
    expect(hookOutput.permissionDecisionReason as string).toContain('[MODEL ROUTING]');
    expect(hookOutput.permissionDecisionReason as string).toContain('claude-opus-4-6');
  });

  it('denies Task call with subagent_type whose definition has a bare Anthropic model ID when forceInherit is enabled', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Task',
        toolInput: {
          subagent_type: 'oh-my-claudecode:executor',
          description: 'Implement feature',
          prompt: 'Do the thing',
        },
        cwd: tempDir,
        session_id: 'session-task-def-model',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: 'global.anthropic.claude-sonnet-4-6',
      },
    );

    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(hookOutput.permissionDecision).toBe('deny');
    expect(hookOutput.permissionDecisionReason as string).toContain('[MODEL ROUTING]');
  });

  it('deny message includes the bare model from the definition and suggests the tier alias', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: {
          subagent_type: 'oh-my-claudecode:critic',
          description: 'Review spec',
          prompt: 'Review this spec',
        },
        cwd: tempDir,
        session_id: 'session-deny-message',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: 'global.anthropic.claude-sonnet-4-6',
      },
    );

    const reason = (output.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason as string;
    expect(reason).toContain('claude-opus-4-6');
    expect(reason).toContain('opus'); // tier alias suggestion
    expect(reason).toContain('global.anthropic.claude-sonnet-4-6'); // OMC_SUBAGENT_MODEL routing
  });

  it('allows tier alias with OMC_SUBAGENT_MODEL set (escape hatch for denied subagent_type calls)', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: {
          subagent_type: 'oh-my-claudecode:critic',
          model: 'opus',
          description: 'Review spec',
          prompt: 'Review this spec',
        },
        cwd: tempDir,
        session_id: 'session-tier-alias-escape',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: 'global.anthropic.claude-sonnet-4-6',
      },
    );

    expect(output.continue).toBe(true);
    expect(JSON.stringify(output)).not.toContain('MODEL ROUTING');
  });

  it('still blocks tier alias when OMC_SUBAGENT_MODEL is not configured', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: {
          subagent_type: 'oh-my-claudecode:critic',
          model: 'opus',
          description: 'Review spec',
          prompt: 'Review this spec',
        },
        cwd: tempDir,
        session_id: 'session-tier-alias-no-subagent-model',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: '',
      },
    );

    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(hookOutput.permissionDecision as string).toBe('deny');
    expect(hookOutput.permissionDecisionReason as string).toContain('MODEL ROUTING');
  });

  it('does NOT deny subagent_type call when forceInherit is disabled', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: {
          subagent_type: 'oh-my-claudecode:critic',
          description: 'Review spec',
          prompt: 'Review this spec',
        },
        cwd: tempDir,
        session_id: 'session-no-force-inherit',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'false',
        OMC_SUBAGENT_MODEL: '',
      },
    );

    expect(output.continue).toBe(true);
    expect(JSON.stringify(output)).not.toContain('MODEL ROUTING');
  });

  it('does not throw or deny when subagent_type is a non-string value', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: {
          subagent_type: 42 as unknown as string,
          description: 'Some task',
          prompt: 'Do something',
        },
        cwd: tempDir,
        session_id: 'session-non-string-subagent-type',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: 'global.anthropic.claude-sonnet-4-6',
      },
    );

    expect(output.continue).toBe(true);
    expect(JSON.stringify(output)).not.toContain('MODEL ROUTING');
  });

  it('treats path-traversal subagent_type as unknown agent and does not deny', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: {
          subagent_type: 'oh-my-claudecode:../docs/CLAUDE',
          description: 'Some task',
          prompt: 'Do something',
        },
        cwd: tempDir,
        session_id: 'session-path-traversal',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: 'global.anthropic.claude-sonnet-4-6',
      },
    );

    expect(output.continue).toBe(true);
    expect(JSON.stringify(output)).not.toContain('MODEL ROUTING');
  });

  it('falls back to script-relative agents dir when CLAUDE_PLUGIN_ROOT points to a non-existent path', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: {
          subagent_type: 'oh-my-claudecode:critic',
          description: 'Review spec',
          prompt: 'Review this spec',
        },
        cwd: tempDir,
        session_id: 'session-stale-plugin-root',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: 'global.anthropic.claude-sonnet-4-6',
        CLAUDE_PLUGIN_ROOT: '/nonexistent/path/that/does/not/exist',
      },
    );

    // Despite stale CLAUDE_PLUGIN_ROOT, falls back to script-relative agents dir and detects bare model
    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(hookOutput.permissionDecision).toBe('deny');
    expect(hookOutput.permissionDecisionReason as string).toContain('[MODEL ROUTING]');
    expect(hookOutput.permissionDecisionReason as string).toContain('claude-opus-4-6');
  });

  it('falls back to script-relative agents dir when CLAUDE_PLUGIN_ROOT/agents exists but lacks the specific agent file', () => {
    // CLAUDE_PLUGIN_ROOT/agents/ exists (non-empty check passes) but does not contain critic.md
    const pluginRoot = join(tempDir, 'partial-plugin');
    const pluginAgentsDir = join(pluginRoot, 'agents');
    mkdirSync(pluginAgentsDir, { recursive: true });
    // Write a different agent file so the dir exists but critic.md is absent
    writeFileSync(join(pluginAgentsDir, 'other-agent.md'), '---\nname: other\n---\nBody.');

    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: {
          subagent_type: 'oh-my-claudecode:critic',
          description: 'Review spec',
          prompt: 'Review this spec',
        },
        cwd: tempDir,
        session_id: 'session-partial-plugin',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: 'global.anthropic.claude-sonnet-4-6',
        CLAUDE_PLUGIN_ROOT: pluginRoot,
      },
    );

    // Should fall back to script-relative agents/, find critic.md, and deny on bare model ID
    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(hookOutput.permissionDecision).toBe('deny');
    expect(hookOutput.permissionDecisionReason as string).toContain('[MODEL ROUTING]');
    expect(hookOutput.permissionDecisionReason as string).toContain('claude-opus-4-6');
  });

  it('does not deny when model: appears inside a body --- block (not real frontmatter)', () => {
    // File starts with normal text, then a horizontal-rule --- section containing model:
    const pluginRoot = join(tempDir, 'fake-plugin-body-hr');
    const agentsDir = join(pluginRoot, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'body-hr-agent.md'),
      'Some introductory text.\n\n---\nmodel: claude-opus-4-6\n---\n\nMore body text.',
    );

    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: {
          subagent_type: 'oh-my-claudecode:body-hr-agent',
          description: 'Some task',
          prompt: 'Do something',
        },
        cwd: tempDir,
        session_id: 'session-body-hr-model',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: 'global.anthropic.claude-sonnet-4-6',
        CLAUDE_PLUGIN_ROOT: pluginRoot,
      },
    );

    // A mid-body --- block is not frontmatter; must not trigger a deny
    expect(output.continue).toBe(true);
    expect(JSON.stringify(output)).not.toContain('MODEL ROUTING');
  });

  it('does not deny when model: appears only in the agent body (not frontmatter)', () => {
    // Frontmatter has no model key; body text contains "model: claude-opus-4-6"
    const pluginRoot = join(tempDir, 'fake-plugin-body');
    const agentsDir = join(pluginRoot, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'body-model-agent.md'),
      '---\nname: body-model-agent\n---\nThis agent can spawn sub-agents.\nmodel: claude-opus-4-6 is sometimes used in the body text.',
    );

    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: {
          subagent_type: 'oh-my-claudecode:body-model-agent',
          description: 'Some task',
          prompt: 'Do something',
        },
        cwd: tempDir,
        session_id: 'session-body-model',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: 'global.anthropic.claude-sonnet-4-6',
        CLAUDE_PLUGIN_ROOT: pluginRoot,
      },
    );

    // model: in the body must not trigger a deny — frontmatter has no model field
    expect(output.continue).toBe(true);
    expect(JSON.stringify(output)).not.toContain('MODEL ROUTING');
  });

  it('strips surrounding quotes from quoted YAML model values and still denies bare Anthropic IDs', () => {
    // Create a temporary agent definition with a quoted model scalar
    const pluginRoot = join(tempDir, 'fake-plugin');
    const agentsDir = join(pluginRoot, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'quoted-model-agent.md'),
      '---\nname: quoted-model-agent\nmodel: "claude-opus-4-6"\n---\nAgent body.',
    );

    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: {
          subagent_type: 'oh-my-claudecode:quoted-model-agent',
          description: 'Review spec',
          prompt: 'Review this spec',
        },
        cwd: tempDir,
        session_id: 'session-quoted-model',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: 'global.anthropic.claude-sonnet-4-6',
        CLAUDE_PLUGIN_ROOT: pluginRoot,
      },
    );

    // Quoted model "claude-opus-4-6" must be stripped of quotes before the safety check
    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(hookOutput.permissionDecision).toBe('deny');
    expect(hookOutput.permissionDecisionReason as string).toContain('[MODEL ROUTING]');
    expect(hookOutput.permissionDecisionReason as string).toContain('claude-opus-4-6');
  });

  it('allows a valid provider-specific model ID written with YAML quotes', () => {
    // Same setup but model is a valid Bedrock ID — should NOT be denied
    const pluginRoot = join(tempDir, 'fake-plugin-2');
    const agentsDir = join(pluginRoot, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'bedrock-quoted-agent.md'),
      '---\nname: bedrock-quoted-agent\nmodel: "global.anthropic.claude-sonnet-4-6"\n---\nAgent body.',
    );

    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: {
          subagent_type: 'oh-my-claudecode:bedrock-quoted-agent',
          description: 'Do something',
          prompt: 'Do it',
        },
        cwd: tempDir,
        session_id: 'session-bedrock-quoted',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: 'global.anthropic.claude-sonnet-4-6',
        CLAUDE_PLUGIN_ROOT: pluginRoot,
      },
    );

    expect(output.continue).toBe(true);
    expect(JSON.stringify(output)).not.toContain('MODEL ROUTING');
  });

  it('does NOT deny Agent call without subagent_type in forceInherit mode (normal inheritance unchanged)', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: {
          description: 'Some task',
          prompt: 'Do something',
        },
        cwd: tempDir,
        session_id: 'session-no-subagent-type',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
      },
    );

    expect(output.continue).toBe(true);
    expect(JSON.stringify(output)).not.toContain('MODEL ROUTING');
  });

  it('does NOT deny when subagent_type refers to an unknown agent (no definition file)', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: {
          subagent_type: 'oh-my-claudecode:nonexistent-agent-xyz',
          description: 'Some task',
          prompt: 'Do something',
        },
        cwd: tempDir,
        session_id: 'session-unknown-agent',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: 'global.anthropic.claude-sonnet-4-6',
      },
    );

    expect(output.continue).toBe(true);
    expect(JSON.stringify(output)).not.toContain('MODEL ROUTING');
  });

    it('does not write skill-active-state for unknown custom skills', () => {
    const sessionId = 'session-1581';

    const output = runPreToolEnforcer({
      tool_name: 'Skill',
      toolInput: {
        skill: 'phase-resume',
      },
      cwd: tempDir,
      session_id: sessionId,
    });

    expect(output).toEqual({ continue: true, suppressOutput: true });
    expect(
      existsSync(join(tempDir, '.omc', 'state', 'sessions', sessionId, 'skill-active-state.json')),
    ).toBe(false);
  });
});
