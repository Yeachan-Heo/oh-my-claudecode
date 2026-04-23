import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT_PATH = join(__dirname, '..', '..', '..', 'templates', 'hooks', 'session-start.mjs');
const NODE = process.execPath;

describe('session-start template guard for same-root parallel sessions (#1744)', () => {
  let tempDir: string;
  let fakeHome: string;
  let fakeProject: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-session-start-template-'));
    fakeHome = join(tempDir, 'home');
    fakeProject = join(tempDir, 'project');
    mkdirSync(join(fakeProject, '.omc', 'state'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function runSessionStart(input: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
    const raw = execFileSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        ...extraEnv,
      },
      timeout: 15000,
    }).trim();

    return JSON.parse(raw) as {
      continue: boolean;
      suppressOutput?: boolean;
      hookSpecificOutput?: { additionalContext?: string };
    };
  }

  it('warns and suppresses conflicting same-root restore for a different active session', () => {
    const now = new Date().toISOString();
    writeFileSync(
      join(fakeProject, '.omc', 'state', 'ultrawork-state.json'),
      JSON.stringify({
        active: true,
        session_id: 'session-a',
        started_at: now,
        last_checked_at: now,
        original_prompt: 'Old task that should not bleed into session-b',
      }),
    );

    const output = runSessionStart({
      hook_event_name: 'SessionStart',
      session_id: 'session-b',
      cwd: fakeProject,
    });

    const context = output.hookSpecificOutput?.additionalContext || '';
    expect(output.continue).toBe(true);
    expect(context).toContain('[PARALLEL SESSION WARNING]');
    expect(context).toContain('suppressed the restore');
    expect(context).not.toContain('[ULTRAWORK MODE RESTORED]');
    expect(context).not.toContain('Old task that should not bleed into session-b');
  });

  it('keeps template session-start under budget when only a tiny omission remainder remains', () => {
    writeFileSync(
      join(fakeProject, '.omc', 'state', 'ultrawork-state.json'),
      JSON.stringify({
        active: true,
        session_id: 'session-budget-owner',
        started_at: '2026-04-23T00:00:00.000Z',
        last_checked_at: '2026-04-23T00:05:00.000Z',
        original_prompt: 'budget '.repeat(520),
      }),
    );
    writeFileSync(
      join(fakeProject, 'AGENTS.md'),
      `# oh-my-claudecode - Intelligent Multi-Agent Orchestration

<guidance_schema_contract>schema</guidance_schema_contract>

<operating_principles>
${'- preserve this startup guidance\n'.repeat(400)}
</operating_principles>`,
    );

    const output = runSessionStart({
      hook_event_name: 'SessionStart',
      session_id: 'session-budget-owner',
      cwd: fakeProject,
    });

    const context = output.hookSpecificOutput?.additionalContext || '';
    expect(output.continue).toBe(true);
    expect(context.length).toBeLessThanOrEqual(6000);
  });

  it('compacts large OMC AGENTS guidance and caps aggregate session context', () => {
    mkdirSync(fakeProject, { recursive: true });
    const largeAgents = [
      '# oh-my-claudecode - Intelligent Multi-Agent Orchestration',
      '<guidance_schema_contract>schema details</guidance_schema_contract>',
      '<operating_principles>keep this high value section</operating_principles>',
      '<agent_catalog>' + 'agent '.repeat(5000) + '</agent_catalog>',
      '<skills>' + 'skill '.repeat(5000) + '</skills>',
      '<team_compositions>' + 'team '.repeat(5000) + '</team_compositions>',
      '<verification>verify before claiming completion</verification>',
    ].join('\n\n');
    writeFileSync(join(fakeProject, 'AGENTS.md'), largeAgents);

    const output = runSessionStart({
      hook_event_name: 'SessionStart',
      session_id: 'session-large-agents',
      cwd: fakeProject,
    });

    const context = output.hookSpecificOutput?.additionalContext || '';
    expect(output.continue).toBe(true);
    expect(context).toContain('[ROOT AGENTS.md LOADED]');
    expect(context).toContain('<operating_principles>keep this high value section</operating_principles>');
    expect(context).toContain('<verification>verify before claiming completion</verification>');
    expect(context).not.toContain('<agent_catalog>');
    expect(context).not.toContain('<skills>');
    expect(context.length).toBeLessThanOrEqual(6000);
  });

  it('still restores ultrawork for the owning session', () => {
    writeFileSync(
      join(fakeProject, '.omc', 'state', 'ultrawork-state.json'),
      JSON.stringify({
        active: true,
        session_id: 'session-owner',
        started_at: '2026-03-19T00:00:00.000Z',
        last_checked_at: '2026-03-19T00:05:00.000Z',
        original_prompt: 'Resume me',
      }),
    );

    const output = runSessionStart({
      hook_event_name: 'SessionStart',
      session_id: 'session-owner',
      cwd: fakeProject,
    });

    const context = output.hookSpecificOutput?.additionalContext || '';
    expect(output.continue).toBe(true);
    expect(context).toContain('[ULTRAWORK MODE RESTORED]');
    expect(context).toContain('Resume me');
    expect(context).not.toContain('[PARALLEL SESSION WARNING]');
  });

  it('does not warn for global fallback state from a different normalized project path', () => {
    mkdirSync(join(fakeHome, '.omc', 'state'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.omc', 'state', 'ultrawork-state.json'),
      JSON.stringify({
        active: true,
        session_id: 'session-a',
        started_at: '2026-03-19T00:00:00.000Z',
        last_checked_at: '2026-03-19T00:05:00.000Z',
        original_prompt: 'Different project task',
        project_path: join(tempDir, 'other-project'),
      }),
    );

    const output = runSessionStart({
      hook_event_name: 'SessionStart',
      session_id: 'session-b',
      cwd: fakeProject,
    });

    expect(output.continue).toBe(true);
    const context = output.hookSpecificOutput?.additionalContext || '';
    expect(context).not.toContain('[PARALLEL SESSION WARNING]');
    expect(context).not.toContain('[ULTRAWORK MODE RESTORED]');
  });

  it('keeps model routing override under budget for non-standard providers', () => {
    writeFileSync(
      join(fakeProject, 'AGENTS.md'),
      `# oh-my-claudecode - Intelligent Multi-Agent Orchestration

<guidance_schema_contract>schema</guidance_schema_contract>

<operating_principles>
${'- oversized startup guidance\n'.repeat(700)}
</operating_principles>`,
    );

    const output = runSessionStart({
      hook_event_name: 'SessionStart',
      session_id: 'session-bedrock-template',
      cwd: fakeProject,
    }, {
      CLAUDE_CODE_USE_BEDROCK: '1',
    });

    const context = output.hookSpecificOutput?.additionalContext || '';
    expect(output.continue).toBe(true);
    expect(context).toContain('[MODEL ROUTING OVERRIDE');
    expect(context).toContain('Do NOT pass the `model` parameter');
    expect(context.length).toBeLessThanOrEqual(6000);
  });

});
