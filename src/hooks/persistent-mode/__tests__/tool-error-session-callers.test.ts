import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { checkPersistentModes } from '../index.js';

// #5148: post-tool-use-failure writes sessions/<sid>/last-tool-error-state.json when it
// knows the session id, so the continuation callers must read the error with that id.
describe('ralph continuation reads the session-scoped tool error (#5148)', () => {
  it('adds retry guidance when only the session-scoped error file exists', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'ralph-tool-error-session-'));
    const sessionId = 'session-5148-callers';
    try {
      execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
      const sessionDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        iteration: 1,
        max_iterations: 10,
        started_at: new Date().toISOString(),
        prompt: 'Finish all todos',
        session_id: sessionId,
        project_path: tempDir,
      }));
      writeFileSync(join(sessionDir, 'last-tool-error-state.json'), JSON.stringify({
        tool_name: 'Bash',
        tool_input_preview: 'npm test',
        error: 'session-scoped failure 5148',
        timestamp: new Date().toISOString(),
        retry_count: 1,
      }));

      const result = await checkPersistentModes(sessionId, tempDir);

      expect(result.shouldBlock).toBe(true);
      expect(result.mode).toBe('ralph');
      expect(result.message).toContain('[TOOL ERROR - RETRY REQUIRED]');
      expect(result.message).toContain('session-scoped failure 5148');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('autopilot continuation reads the session-scoped tool error (#5148)', () => {
  it('adds retry guidance when only the session-scoped error file exists', async () => {
    const { initAutopilot } = await import('../../autopilot/state.js');
    const { checkAutopilot } = await import('../../autopilot/enforcement.js');
    const tempDir = mkdtempSync(join(tmpdir(), 'autopilot-tool-error-session-'));
    const sessionId = 'session-5148-autopilot';
    try {
      execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
      expect(initAutopilot(tempDir, 'Build the parser', sessionId)).not.toBeNull();
      const sessionDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'last-tool-error-state.json'), JSON.stringify({
        tool_name: 'Bash',
        tool_input_preview: 'npm run build',
        error: 'autopilot session-scoped failure 5148',
        timestamp: new Date().toISOString(),
        retry_count: 1,
      }));

      const result = await checkAutopilot(sessionId, tempDir);

      expect(result).not.toBeNull();
      expect(result!.shouldBlock).toBe(true);
      expect(result!.message).toContain('[TOOL ERROR - RETRY REQUIRED]');
      expect(result!.message).toContain('autopilot session-scoped failure 5148');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
