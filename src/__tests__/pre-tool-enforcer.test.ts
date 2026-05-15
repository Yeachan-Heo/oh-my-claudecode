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
      ANTHROPIC_BASE_URL: '',
      CLAUDE_CODE_USE_BEDROCK: '',
      CLAUDE_CODE_USE_VERTEX: '',
      // Reset tier-resolution chain env vars (resolveTierAliasToSafeModel reads these).
      OMC_MODEL_LOW: '',
      OMC_MODEL_MEDIUM: '',
      OMC_MODEL_HIGH: '',
      CLAUDE_CODE_BEDROCK_HAIKU_MODEL: '',
      CLAUDE_CODE_BEDROCK_SONNET_MODEL: '',
      CLAUDE_CODE_BEDROCK_OPUS_MODEL: '',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
      ANTHROPIC_DEFAULT_SONNET_MODEL: '',
      ANTHROPIC_DEFAULT_OPUS_MODEL: '',
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

  it('suppresses built-in TaskCreate task-list operation chatter', () => {
    const output = runPreToolEnforcer({
      tool_name: 'TaskCreate',
      toolInput: {
        title: 'Inspect hook behavior',
        status: 'pending',
      },
      cwd: tempDir,
      session_id: 'session-taskcreate-builtin',
    });

    expect(output).toEqual({ continue: true, suppressOutput: true });
  });

  it('suppresses built-in TaskUpdate task-list operation chatter', () => {
    const output = runPreToolEnforcer({
      tool_name: 'TaskUpdate',
      toolInput: {
        id: 'task-1',
        status: 'in_progress',
      },
      cwd: tempDir,
      session_id: 'session-taskupdate-builtin',
    });

    expect(output).toEqual({ continue: true, suppressOutput: true });
  });

  it('preserves Agent spawn warnings for real subagent delegation', () => {
    const output = runPreToolEnforcer({
      tool_name: 'Agent',
      toolInput: {
        subagent_type: 'oh-my-claudecode:executor',
        description: 'Fix type errors',
        prompt: 'Fix all type errors in src/auth/',
      },
      cwd: tempDir,
      session_id: 'session-agent-spawn',
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(String(hookSpecificOutput.additionalContext)).toContain('Spawning agent: oh-my-claudecode:executor');
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

  it('routes Task calls from canonical team state when coarse team-state drifts away', () => {
    const sessionId = 'session-canonical-team';
    const canonicalTeamDir = join(tempDir, '.omc', 'state', 'team', 'canonical-team');
    writeJson(join(canonicalTeamDir, 'manifest.json'), {
      name: 'canonical-team',
      task: 'Canonical team task',
      leader: {
        session_id: sessionId,
        worker_id: 'leader-fixed',
        role: 'leader',
      },
      created_at: new Date().toISOString(),
      leader_cwd: tempDir,
      team_state_root: join(tempDir, '.omc', 'state'),
    });
    writeJson(join(canonicalTeamDir, 'phase-state.json'), {
      current_phase: 'executing',
      updated_at: new Date().toISOString(),
    });

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
    expect(hookSpecificOutput.additionalContext).toContain('canonical-team');
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

  it('warns without blocking when Task prompt uses fallback or workaround language', () => {
    const output = runPreToolEnforcer({
      tool_name: 'Task',
      toolInput: {
        subagent_type: 'oh-my-claudecode:executor',
        description: 'Implement a fallback',
        prompt: 'Add a workaround if the normal architecture is hard.',
      },
      cwd: tempDir,
      session_id: 'session-slop-warning',
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    const context = String(hookSpecificOutput.additionalContext);
    expect(output.continue).toBe(true);
    expect(hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(context).toContain('[SLOP WARNING]');
    expect(context).toContain('Do not make potential slop');
    expect(context).toContain('consult the architect');
    expect(context).toContain('ask the user to confirm constraints');
    expect(context).toContain('Spawning agent');
    expect(hookSpecificOutput).not.toHaveProperty('permissionDecision');
  });

  it('keeps slop warning visible even when routine reminders are quieted', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Bash',
        toolInput: {
          command: 'node scripts/add-fallback-workaround.mjs',
        },
        cwd: tempDir,
        session_id: 'session-slop-warning-quiet',
      },
      { OMC_QUIET: '2' },
    );

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    const context = String(hookSpecificOutput.additionalContext);
    expect(output.continue).toBe(true);
    expect(context).toContain('[SLOP WARNING]');
    expect(context).not.toContain('Use parallel execution');
  });

  it('does not warn for documentation edits that describe workaround terms as nouns', () => {
    const output = runPreToolEnforcer({
      tool_name: 'Write',
      toolInput: {
        file_path: join(tempDir, 'docs', 'troubleshooting.md'),
        content: [
          '# Troubleshooting',
          '',
          'Document workaround for a specific bug in the troubleshooting guide.',
          'This section explains when the workaround term appears in instructions.',
        ].join('\n'),
      },
      cwd: tempDir,
      session_id: 'session-slop-doc-text',
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(String(hookSpecificOutput.additionalContext)).not.toContain('[SLOP WARNING]');
  });

  it('does not warn for self-referential pre-tool enforcer edits that document the rule', () => {
    const output = runPreToolEnforcer({
      tool_name: 'Edit',
      toolInput: {
        file_path: 'scripts/pre-tool-enforcer.mjs',
        old_string: 'const SLOP_FALLBACK_LANGUAGE_PATTERN = /fallback|workaround/i;',
        new_string: [
          '// The fallback/workaround detector should avoid warning on rule documentation.',
          'const SLOP_FALLBACK_LANGUAGE_PATTERN = /fallback|workaround/i;',
        ].join('\n'),
      },
      cwd: tempDir,
      session_id: 'session-slop-self-reference',
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(String(hookSpecificOutput.additionalContext)).not.toContain('[SLOP WARNING]');
  });

  it('still warns for action-shaped fallback narration outside documentation contexts', () => {
    const output = runPreToolEnforcer({
      tool_name: 'Task',
      toolInput: {
        subagent_type: 'oh-my-claudecode:executor',
        description: 'Implement fallback routing',
        prompt: 'Please implement a fallback layer for the flaky API.',
      },
      cwd: tempDir,
      session_id: 'session-slop-action-shaped',
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(String(hookSpecificOutput.additionalContext)).toContain('[SLOP WARNING]');
  });

  it('warns for natural work-around phrasing with direct noun objects', () => {
    const output = runPreToolEnforcer({
      tool_name: 'Task',
      toolInput: {
        subagent_type: 'oh-my-claudecode:executor',
        description: 'Skip architecture for flaky API failures',
        prompt: 'Please work around flaky API failures by skipping the normal architecture.',
      },
      cwd: tempDir,
      session_id: 'session-slop-work-around-noun-object',
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(String(hookSpecificOutput.additionalContext)).toContain('[SLOP WARNING]');
  });

  it('warns for fall back on cached responses phrasing', () => {
    const output = runPreToolEnforcer({
      tool_name: 'Task',
      toolInput: {
        subagent_type: 'oh-my-claudecode:executor',
        description: 'Add API fallback',
        prompt: 'If the API fails, fall back on cached responses.',
      },
      cwd: tempDir,
      session_id: 'session-slop-fall-back-on',
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(String(hookSpecificOutput.additionalContext)).toContain('[SLOP WARNING]');
  });

  it('warns for single-word fallback to cached responses phrasing', () => {
    const output = runPreToolEnforcer({
      tool_name: 'Task',
      toolInput: {
        subagent_type: 'oh-my-claudecode:executor',
        description: 'Add API fallback',
        prompt: 'If the API fails, fallback to cached responses.',
      },
      cwd: tempDir,
      session_id: 'session-slop-fallback-to',
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(String(hookSpecificOutput.additionalContext)).toContain('[SLOP WARNING]');
  });

  it('does not treat markdown headings alone as documentation context for Task prompts', () => {
    const output = runPreToolEnforcer({
      tool_name: 'Task',
      toolInput: {
        subagent_type: 'oh-my-claudecode:executor',
        description: 'Implement fallback routing',
        prompt: [
          '## Implementation',
          '',
          'Please implement a fallback layer and explain why.',
        ].join('\n'),
      },
      cwd: tempDir,
      session_id: 'session-slop-markdown-task',
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(String(hookSpecificOutput.additionalContext)).toContain('[SLOP WARNING]');
  });

  it('does not warn for documentation edits that quote action-shaped work-around wording', () => {
    const output = runPreToolEnforcer({
      tool_name: 'Write',
      toolInput: {
        file_path: join(tempDir, 'docs', 'architecture-notes.md'),
        content: [
          '# Architecture notes',
          '',
          'Explain why the phrase "Please work around flaky API failures" should be reviewed carefully.',
        ].join('\n'),
      },
      cwd: tempDir,
      session_id: 'session-slop-doc-action-shaped',
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(String(hookSpecificOutput.additionalContext)).not.toContain('[SLOP WARNING]');
  });

  it('does not warn for read-only search tools that mention fallback as the query', () => {
    const output = runPreToolEnforcer({
      tool_name: 'Grep',
      toolInput: {
        pattern: 'fallback|workaround',
      },
      cwd: tempDir,
      session_id: 'session-slop-search',
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(String(hookSpecificOutput.additionalContext)).not.toContain('[SLOP WARNING]');
    expect(String(hookSpecificOutput.additionalContext)).toContain('Combine searches in parallel');
  });

  it('does not warn for benign technical fallback descriptions from issue #2939', () => {
    const benignPrompts = [
      'Preserve the fail-soft fallback value when LAST_INSERT_ID() returns 0 after a failed INSERT.',
      'Describe the fallback to default config when the project config file is missing.',
      'Add a workaround for commit cf9703f so the regression note links to the upstream change.',
      'Keep the memory workaround note, but do not change runtime behavior.',
    ];

    for (const [index, prompt] of benignPrompts.entries()) {
      const output = runPreToolEnforcer({
        tool_name: 'Task',
        toolInput: {
          subagent_type: 'oh-my-claudecode:executor',
          description: 'Handle benign fallback documentation',
          prompt,
        },
        cwd: tempDir,
        session_id: `session-slop-benign-${index}`,
      });

      const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
      expect(output.continue).toBe(true);
      expect(String(hookSpecificOutput.additionalContext)).not.toContain('[SLOP WARNING]');
    }
  });

  it('warns when benign and risky fallback phrasing coexist in one segment', () => {
    const output = runPreToolEnforcer({
      tool_name: 'Task',
      toolInput: {
        subagent_type: 'oh-my-claudecode:executor',
        description: 'Preserve benign fallback and reject risky routing fallback',
        prompt: 'Preserve the fail-soft fallback value, and fallback to weaker model if the preferred agent is unavailable.',
      },
      cwd: tempDir,
      session_id: 'session-slop-mixed-benign-risky',
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(String(hookSpecificOutput.additionalContext)).toContain('[SLOP WARNING]');
  });

  it('does not warn when fallback/workaround phrases only appear in quoted or code contexts', () => {
    const output = runPreToolEnforcer({
      tool_name: 'Task',
      toolInput: {
        subagent_type: 'oh-my-claudecode:executor',
        description: 'Review quoted technical phrases',
        prompt: [
          'Review the quoted phrase "fallback to default config" in the migration notes.',
          'The code sample says `workaround the requirement`, but do not implement that behavior.',
          '```ts',
          'const message = "fallback to weaker model";',
          '```',
        ].join('\n'),
      },
      cwd: tempDir,
      session_id: 'session-slop-quoted-code',
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(String(hookSpecificOutput.additionalContext)).not.toContain('[SLOP WARNING]');
  });

  it('does not warn for primary-path extra/additional naming from issue #3012', () => {
    const output = runPreToolEnforcer({
      tool_name: 'Edit',
      toolInput: {
        file_path: join(tempDir, 'token.go'),
        old_string: 'type tokenRequest struct {}',
        new_string: [
          'type extraSecretFetch struct {',
          '\tpath string',
          '}',
          '',
          'type tokenRequest struct {',
          '\textraSecrets []extraSecretFetch',
          '}',
          '',
          '// Fetch additional SM paths as part of the primary dual-secret design.',
          'func fetchTokenSecrets(extraSecrets []extraSecretFetch) {}',
        ].join('\n'),
      },
      cwd: tempDir,
      session_id: 'session-slop-extra-additional-primary-path',
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(String(hookSpecificOutput.additionalContext)).not.toContain('[SLOP WARNING]');
  });

  it('does not warn for Task prompts that describe extra/additional primary-path fields', () => {
    const output = runPreToolEnforcer({
      tool_name: 'Task',
      toolInput: {
        subagent_type: 'oh-my-claudecode:executor',
        description: 'Implement primary dual-secret token fetch',
        prompt: [
          'Implement the primary dual-secret path using extraSecretFetch.',
          'The request type should include extraSecrets []extraSecretFetch.',
          'Comments may describe additional SM paths because both paths are intentional.',
        ].join('\n'),
      },
      cwd: tempDir,
      session_id: 'session-slop-task-extra-additional-primary-path',
    });

    const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(String(hookSpecificOutput.additionalContext)).not.toContain('[SLOP WARNING]');
  });

  it('still warns for real SLOP intent from issue #2939', () => {
    const slopPrompts = [
      'If the preferred agent is unavailable, fallback to weaker model to keep going.',
      'Please workaround the requirement instead of implementing the requested workflow.',
    ];

    for (const [index, prompt] of slopPrompts.entries()) {
      const output = runPreToolEnforcer({
        tool_name: 'Task',
        toolInput: {
          subagent_type: 'oh-my-claudecode:executor',
          description: 'Implement risky fallback',
          prompt,
        },
        cwd: tempDir,
        session_id: `session-slop-real-${index}`,
      });

      const hookSpecificOutput = output.hookSpecificOutput as Record<string, unknown>;
      expect(output.continue).toBe(true);
      expect(String(hookSpecificOutput.additionalContext)).toContain('[SLOP WARNING]');
    }
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

    // Tier alias + OMC_SUBAGENT_MODEL configured → allow through
    expect(output.continue).toBe(true);
    expect(JSON.stringify(output)).not.toContain('MODEL ROUTING');
  });

  // --- ANTHROPIC_DEFAULT_*_MODEL resolution (eliminates mandatory OMC_SUBAGENT_MODEL) ---

  it('allows tier alias "sonnet" via ANTHROPIC_DEFAULT_SONNET_MODEL without OMC_SUBAGENT_MODEL', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: { subagent_type: 'oh-my-claudecode:architect', model: 'sonnet' },
        cwd: tempDir,
        session_id: 'session-tier-default-sonnet',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: '',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'global.anthropic.claude-sonnet-4-6',
      },
    );

    expect(output.continue).toBe(true);
    expect(JSON.stringify(output)).not.toContain('MODEL ROUTING');
  });

  it('allows tier alias "opus" via ANTHROPIC_DEFAULT_OPUS_MODEL without OMC_SUBAGENT_MODEL', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: { subagent_type: 'oh-my-claudecode:architect', model: 'opus' },
        cwd: tempDir,
        session_id: 'session-tier-default-opus',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: '',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'global.anthropic.claude-opus-4-6-v1',
      },
    );

    expect(output.continue).toBe(true);
    expect(JSON.stringify(output)).not.toContain('MODEL ROUTING');
  });

  it('allows tier alias "haiku" via ANTHROPIC_DEFAULT_HAIKU_MODEL without OMC_SUBAGENT_MODEL', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: { subagent_type: 'oh-my-claudecode:executor', model: 'haiku' },
        cwd: tempDir,
        session_id: 'session-tier-default-haiku',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: '',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      },
    );

    expect(output.continue).toBe(true);
    expect(JSON.stringify(output)).not.toContain('MODEL ROUTING');
  });

  it.each([
    ['sonnet', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'glm-5.1:cloud', 'session-tier-proxy-sonnet'],
    ['opus', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'glm-5.1:cloud', 'session-tier-proxy-opus'],
    ['haiku', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'glm-5.1:cloud', 'session-tier-proxy-haiku'],
  ])('allows tier alias %s via proxy ANTHROPIC_DEFAULT_*_MODEL when non-Claude routing is active', (tier, envKey, proxyModel, sessionId) => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: { subagent_type: 'oh-my-claudecode:executor', model: tier },
        cwd: tempDir,
        session_id: sessionId,
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: '',
        ANTHROPIC_MODEL: 'glm-5.1:cloud',
        [envKey]: proxyModel,
      },
    );

    expect(output.continue).toBe(true);
    expect(JSON.stringify(output)).not.toContain('MODEL ROUTING');
  });

  it('blocks tier alias when proxy ANTHROPIC_DEFAULT_*_MODEL is only whitespace', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: { subagent_type: 'oh-my-claudecode:executor', model: 'sonnet' },
        cwd: tempDir,
        session_id: 'session-tier-proxy-empty',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: '',
        ANTHROPIC_DEFAULT_SONNET_MODEL: '   ',
      },
    );

    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(hookOutput.permissionDecisionReason as string).toContain('MODEL ROUTING');
  });

  it('preserves provider-specific validation for CLAUDE_CODE_BEDROCK_*_MODEL in proxy mode', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: { subagent_type: 'oh-my-claudecode:executor', model: 'sonnet' },
        cwd: tempDir,
        session_id: 'session-tier-proxy-invalid-bedrock-var',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: '',
        CLAUDE_CODE_BEDROCK_SONNET_MODEL: 'glm-5.1:cloud',
        ANTHROPIC_DEFAULT_SONNET_MODEL: '',
      },
    );

    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(hookOutput.permissionDecisionReason as string).toContain('MODEL ROUTING');
  });

  it('allows proxy ANTHROPIC_DEFAULT_*_MODEL in config force-inherit mode when no normal Claude model is active', () => {
    const configDir = join(tempDir, '.omc');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ routing: { forceInherit: true } }));

    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: { subagent_type: 'oh-my-claudecode:executor', model: 'sonnet' },
        cwd: tempDir,
        session_id: 'session-tier-config-proxy-default',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: '',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.1:cloud',
      },
    );

    expect(output.continue).toBe(true);
    expect(JSON.stringify(output)).not.toContain('MODEL ROUTING');
  });

  it('rejects proxy ANTHROPIC_DEFAULT_*_MODEL when env force-inherit runs under a normal Claude active model', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: { subagent_type: 'oh-my-claudecode:executor', model: 'sonnet' },
        cwd: tempDir,
        session_id: 'session-tier-env-force-normal-claude-proxy-default',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: '',
        ANTHROPIC_MODEL: 'claude-sonnet-4-5',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.1:cloud',
      },
    );

    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(hookOutput.permissionDecisionReason as string).toContain('MODEL ROUTING');
  });

  it('OMC_SUBAGENT_MODEL takes priority over ANTHROPIC_DEFAULT_*_MODEL when both set', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: { subagent_type: 'oh-my-claudecode:architect', model: 'sonnet' },
        cwd: tempDir,
        session_id: 'session-tier-priority',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: 'global.anthropic.claude-sonnet-4-6',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'us.anthropic.claude-sonnet-4-5-v1:0',
      },
    );

    expect(output.continue).toBe(true);
    expect(JSON.stringify(output)).not.toContain('MODEL ROUTING');
  });

  it('accepts ANTHROPIC_DEFAULT_*_MODEL with [1m] suffix — CC handles [1m] correctly for explicit tier alias calls', () => {
    // Live-tested 2026-04-16: `claude -p --model sonnet` succeeds when
    // ANTHROPIC_DEFAULT_SONNET_MODEL=global.anthropic.claude-sonnet-4-6[1m].
    // CC resolves [1m]-suffixed values correctly for explicit model= calls;
    // only the inheritance path (stripping [1m] from session model) is broken.
    // resolveTierAliasToSafeModel uses isProviderSpecificModelId (not isSubagentSafeModelId)
    // so [1m]-suffixed provider IDs are valid routing targets.
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: { subagent_type: 'oh-my-claudecode:executor', model: 'sonnet' },
        cwd: tempDir,
        session_id: 'session-tier-default-lm',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: '',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'global.anthropic.claude-sonnet-4-6[1m]',
      },
    );

    expect(output.continue).toBe(true);
    expect(JSON.stringify(output)).not.toContain('MODEL ROUTING');
  });

  it('resolves via CLAUDE_CODE_BEDROCK_SONNET_MODEL as sole configured env var', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: { subagent_type: 'oh-my-claudecode:executor', model: 'sonnet' },
        cwd: tempDir,
        session_id: 'session-tier-cc-bedrock-env',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: '',
        CLAUDE_CODE_BEDROCK_SONNET_MODEL: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      },
    );

    expect(output.continue).toBe(true);
    expect(JSON.stringify(output)).not.toContain('MODEL ROUTING');
  });

  it('OMC_MODEL_MEDIUM is not used as routing proof; ANTHROPIC_DEFAULT_SONNET_MODEL resolves the alias', () => {
    // OMC_MODEL_* is excluded from the resolution chain because CC itself does not read it
    // for tier-alias routing. ANTHROPIC_DEFAULT_SONNET_MODEL (even with [1m]) is accepted
    // since CC handles that suffix correctly for explicit model= calls.
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: { subagent_type: 'oh-my-claudecode:executor', model: 'sonnet' },
        cwd: tempDir,
        session_id: 'session-tier-omc-model-fallback',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: '',
        OMC_MODEL_MEDIUM: 'global.anthropic.claude-sonnet-4-6',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'global.anthropic.claude-sonnet-4-6[1m]',
      },
    );

    expect(output.continue).toBe(true);
    expect(JSON.stringify(output)).not.toContain('MODEL ROUTING');
  });

  it('blocks tier alias when only OMC_MODEL_* is set (not a CC-side routing proof)', () => {
    // OMC_MODEL_* proves OMC-bridge routing, not CC model resolution. Without a CC-native
    // var (ANTHROPIC_DEFAULT_* or CLAUDE_CODE_BEDROCK_*), CC cannot route the tier alias
    // and the downstream Agent/Task call would fail — so the hook must deny.
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: { subagent_type: 'oh-my-claudecode:executor', model: 'sonnet' },
        cwd: tempDir,
        session_id: 'session-tier-omc-model-only',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: '',
        OMC_MODEL_MEDIUM: 'global.anthropic.claude-sonnet-4-6',
        ANTHROPIC_DEFAULT_SONNET_MODEL: '',
        CLAUDE_CODE_BEDROCK_SONNET_MODEL: '',
      },
    );

    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(hookOutput.permissionDecisionReason as string).toContain('MODEL ROUTING');
  });

  it('blocks tier alias when NO safe model env is configured at all', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: { subagent_type: 'oh-my-claudecode:architect', model: 'sonnet' },
        cwd: tempDir,
        session_id: 'session-tier-alias-no-env',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: '',
        ANTHROPIC_DEFAULT_SONNET_MODEL: '',
      },
    );

    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(hookOutput.permissionDecisionReason as string).toContain('MODEL ROUTING');
  });

  it('agent-definition deny works via ANTHROPIC_DEFAULT_*_MODEL without OMC_SUBAGENT_MODEL', () => {
    const pluginRoot = join(tempDir, 'bare-model-default-env');
    const agentsDir = join(pluginRoot, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'critic.md'),
      '---\nname: critic\nmodel: claude-opus-4-6\n---\nPlugin critic body.',
    );

    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: {
          subagent_type: 'oh-my-claudecode:critic',
          description: 'Review spec',
          prompt: 'Review this spec',
        },
        cwd: tempDir,
        session_id: 'session-agent-def-default-env',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: '',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'global.anthropic.claude-opus-4-6-v1',
        CLAUDE_PLUGIN_ROOT: pluginRoot,
      },
    );

    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(hookOutput.permissionDecision).toBe('deny');
    expect(hookOutput.permissionDecisionReason as string).toContain('[MODEL ROUTING]');
    expect(hookOutput.permissionDecisionReason as string).toContain('claude-opus-4-6');
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

  it('denies Agent call when a discovered plugin agent definition has a bare Anthropic model ID', () => {
    const pluginRoot = join(tempDir, 'bare-model-plugin-agent');
    const agentsDir = join(pluginRoot, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'critic.md'),
      '---\nname: critic\nmodel: claude-opus-4-6\n---\nPlugin critic body.',
    );

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
        CLAUDE_PLUGIN_ROOT: pluginRoot,
      },
    );

    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(hookOutput.permissionDecision).toBe('deny');
    expect(hookOutput.permissionDecisionReason as string).toContain('[MODEL ROUTING]');
    expect(hookOutput.permissionDecisionReason as string).toContain('claude-opus-4-6');
  });

  it('denies Task call when a discovered plugin agent definition has a bare Anthropic model ID', () => {
    const pluginRoot = join(tempDir, 'bare-model-plugin-task');
    const agentsDir = join(pluginRoot, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'executor.md'),
      '---\nname: executor\nmodel: claude-sonnet-4-6\n---\nPlugin executor body.',
    );

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
        CLAUDE_PLUGIN_ROOT: pluginRoot,
      },
    );

    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(hookOutput.permissionDecision).toBe('deny');
    expect(hookOutput.permissionDecisionReason as string).toContain('[MODEL ROUTING]');
  });

  it('deny message includes the bare model from a plugin definition and suggests the tier alias', () => {
    const pluginRoot = join(tempDir, 'bare-model-plugin-message');
    const agentsDir = join(pluginRoot, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'critic.md'),
      '---\nname: critic\nmodel: claude-opus-4-6\n---\nPlugin critic body.',
    );

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
        CLAUDE_PLUGIN_ROOT: pluginRoot,
      },
    );

    const reason = (output.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason as string;
    expect(reason).toContain('claude-opus-4-6');
    expect(reason).toContain('opus'); // tier alias suggestion
    expect(reason).toContain('global.anthropic.claude-sonnet-4-6'); // resolved safe model in guidance
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

  it('does not deny shipped agent definitions that use routable tier aliases in frontmatter', () => {
    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: {
          subagent_type: 'oh-my-claudecode:critic',
          description: 'Review spec',
          prompt: 'Review this spec',
        },
        cwd: tempDir,
        session_id: 'session-shipped-tier-alias',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: 'global.anthropic.claude-sonnet-4-6-v1:0',
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

  it('falls back to script-relative agents dir when CLAUDE_PLUGIN_ROOT points to a non-existent path and allows shipped tier aliases', () => {
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

    expect(output.continue).toBe(true);
    expect(JSON.stringify(output)).not.toContain('MODEL ROUTING');
  });

  it('falls back to script-relative agents dir when CLAUDE_PLUGIN_ROOT/agents exists but lacks the specific agent file, and allows shipped tier aliases', () => {
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

    expect(output.continue).toBe(true);
    expect(JSON.stringify(output)).not.toContain('MODEL ROUTING');
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

  it('strips UTF-8 BOM before frontmatter parsing so agent-definition model check still fires', () => {
    const pluginRoot = join(tempDir, 'fake-plugin-bom');
    const agentsDir = join(pluginRoot, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    // Write agent file with BOM prefix (\uFEFF)
    writeFileSync(
      join(agentsDir, 'bom-agent.md'),
      '\uFEFF---\nname: bom-agent\nmodel: claude-opus-4-6\n---\nAgent body with BOM.',
    );

    const output = runPreToolEnforcerWithEnv(
      {
        tool_name: 'Agent',
        toolInput: {
          subagent_type: 'oh-my-claudecode:bom-agent',
          description: 'BOM test',
          prompt: 'Test BOM handling',
        },
        cwd: tempDir,
        session_id: 'session-bom-test',
      },
      {
        OMC_ROUTING_FORCE_INHERIT: 'true',
        OMC_SUBAGENT_MODEL: 'global.anthropic.claude-sonnet-4-6',
        CLAUDE_PLUGIN_ROOT: pluginRoot,
      },
    );

    // BOM must be stripped so the frontmatter regex matches and the bare
    // Anthropic model ID triggers a deny — not silently bypassed.
    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(output.continue).toBe(true);
    expect(hookOutput.permissionDecision).toBe('deny');
    expect(hookOutput.permissionDecisionReason as string).toContain('[MODEL ROUTING]');
    expect(hookOutput.permissionDecisionReason as string).toContain('bom-agent');
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
