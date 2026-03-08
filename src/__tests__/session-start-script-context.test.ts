import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT_PATH = join(__dirname, '..', '..', 'scripts', 'session-start.mjs');
const NODE = process.execPath;

describe('session-start.mjs regression #1386', () => {
  let tempDir: string;
  let fakeHome: string;
  let fakeProject: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-session-start-script-'));
    fakeHome = join(tempDir, 'home');
    fakeProject = join(tempDir, 'project');
    mkdirSync(join(fakeProject, '.omc', 'state', 'sessions', 'session-1386'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('marks restored ultrawork state as prior-session context instead of imperative continuation', () => {
    writeFileSync(
      join(fakeProject, '.omc', 'state', 'sessions', 'session-1386', 'ultrawork-state.json'),
      JSON.stringify({
        active: true,
        session_id: 'session-1386',
        started_at: '2026-03-06T00:00:00.000Z',
        original_prompt: 'Old task that should not override a new request',
      }),
    );

    const raw = execFileSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-1386',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
      },
      timeout: 15000,
    }).trim();

    const output = JSON.parse(raw) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    const context = output.hookSpecificOutput?.additionalContext || '';

    expect(context).toContain('[ULTRAWORK MODE RESTORED]');
    expect(context).toContain("Prioritize the user's newest request");
    expect(context).not.toContain('Continue working in ultrawork mode until all tasks are complete.');
  });
});
