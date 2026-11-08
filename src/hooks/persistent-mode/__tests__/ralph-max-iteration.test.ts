import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { checkPersistentModes } from '../index.js';

describe('persistent-mode ralph max iteration handling (#635)', () => {
  it('extends max iterations and keeps ralph blocking instead of silently stopping', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'ralph-max-iter-'));
    const sessionId = 'session-635';

    try {
      execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
      const stateDir = join(tempDir, '.omc', 'state', 'sessions', sessionId);
      mkdirSync(stateDir, { recursive: true });

      writeFileSync(
        join(stateDir, 'ralph-state.json'),
        JSON.stringify(
          {
            active: true,
            iteration: 10,
            max_iterations: 10,
            started_at: new Date().toISOString(),
            prompt: 'Finish all todos',
            session_id: sessionId,
            project_path: tempDir,
            linked_ultrawork: true
          },
          null,
          2
        )
      );

      const result = await checkPersistentModes(sessionId, tempDir);
      expect(result.shouldBlock).toBe(true);
      expect(result.mode).toBe('ralph');
      expect(result.message).toContain('[RALPH - ITERATION 11/20]');

      const updated = JSON.parse(readFileSync(join(stateDir, 'ralph-state.json'), 'utf-8')) as {
        iteration: number;
        max_iterations: number;
      };
      expect(updated.iteration).toBe(11);
      expect(updated.max_iterations).toBe(20);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
