import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { checkPersistentModes } from '../index.js';
import { clearSecurityConfigCache } from '../../../lib/security-config.js';

describe('persistent-mode ralph hard max iterations', () => {
  const originalSecurity = process.env.OMC_SECURITY;

  afterEach(() => {
    if (originalSecurity === undefined) {
      delete process.env.OMC_SECURITY;
    } else {
      process.env.OMC_SECURITY = originalSecurity;
    }
    clearSecurityConfigCache();
  });

  it('auto-disables ralph when hard max is reached (OMC_SECURITY=strict)', async () => {
    process.env.OMC_SECURITY = 'strict';
    clearSecurityConfigCache();

    const tempDir = mkdtempSync(join(tmpdir(), 'ralph-hard-max-'));
    const sessionId = 'session-hard-max';

    try {
      execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
      const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(stateDir, { recursive: true });

      writeFileSync(
        join(stateDir, 'ralph-state.json'),
        JSON.stringify({
          active: true,
          iteration: 200,
          max_iterations: 200,
          started_at: new Date().toISOString(),
          prompt: 'Test task',
          session_id: sessionId,
          project_path: tempDir,
        }, null, 2)
      );

      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result).not.toBeNull();
      expect(result!.message).toContain('HARD LIMIT');

      const updated = JSON.parse(readFileSync(join(stateDir, 'ralph-state.json'), 'utf-8'));
      expect(updated.active).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('still extends normally when below hard max (default 500)', async () => {
    delete process.env.OMC_SECURITY;
    clearSecurityConfigCache();

    const tempDir = mkdtempSync(join(tmpdir(), 'ralph-no-hardmax-'));
    const sessionId = 'session-no-hardmax';

    try {
      execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
      const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(stateDir, { recursive: true });

      writeFileSync(
        join(stateDir, 'ralph-state.json'),
        JSON.stringify({
          active: true,
          iteration: 100,
          max_iterations: 100,
          started_at: new Date().toISOString(),
          prompt: 'Test task',
          session_id: sessionId,
          project_path: tempDir,
        }, null, 2)
      );

      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result).not.toBeNull();
      expect(result!.shouldBlock).toBe(true);
      expect(result!.message).not.toContain('HARD LIMIT');

      const updated = JSON.parse(readFileSync(join(stateDir, 'ralph-state.json'), 'utf-8'));
      expect(updated.active).toBe(true);
      expect(updated.max_iterations).toBe(110);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
