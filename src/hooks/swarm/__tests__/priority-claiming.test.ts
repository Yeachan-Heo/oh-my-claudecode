import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, closeDb, initSession, addTasks } from '../state.js';
import { claimTask, claimTaskForFiles } from '../claiming.js';

describe('Priority Claiming', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'swarm-priority-test-'));
    await initDb(testDir);
    initSession('test-session', 5);
  });

  afterEach(() => {
    closeDb();
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('claimTask with priority ordering', () => {
    it('should claim lower priority number first', () => {
      addTasks([
        { id: 'task-1', description: 'Low priority', priority: 10 },
        { id: 'task-2', description: 'High priority', priority: 1 },
        { id: 'task-3', description: 'Medium priority', priority: 5 }
      ]);

      const result = claimTask('agent-1');
      expect(result.success).toBe(true);
      expect(result.taskId).toBe('task-2'); // Priority 1 = highest priority
      expect(result.description).toBe('High priority');
    });

    it('should use ID order for same priority', () => {
      addTasks([
        { id: 'task-3', description: 'Third', priority: 1 },
        { id: 'task-1', description: 'First', priority: 1 },
        { id: 'task-2', description: 'Second', priority: 1 }
      ]);

      const result = claimTask('agent-1');
      expect(result.success).toBe(true);
      expect(result.taskId).toBe('task-1'); // Same priority, lowest ID first
    });

    it('should claim tasks in priority order sequentially', () => {
      addTasks([
        { id: 'task-a', description: 'Priority 3', priority: 3 },
        { id: 'task-b', description: 'Priority 1', priority: 1 },
        { id: 'task-c', description: 'Priority 2', priority: 2 }
      ]);

      const r1 = claimTask('agent-1');
      const r2 = claimTask('agent-2');
      const r3 = claimTask('agent-3');

      expect(r1.taskId).toBe('task-b'); // priority 1
      expect(r2.taskId).toBe('task-c'); // priority 2
      expect(r3.taskId).toBe('task-a'); // priority 3
    });

    it('should default to priority 0 when not specified', () => {
      addTasks([
        { id: 'task-1', description: 'Has priority', priority: 1 },
        { id: 'task-2', description: 'Default priority' } // defaults to 0
      ]);

      const result = claimTask('agent-1');
      expect(result.success).toBe(true);
      expect(result.taskId).toBe('task-2'); // Priority 0 < 1
    });
  });

  describe('claimTaskForFiles', () => {
    it('should claim task matching agent file patterns', () => {
      addTasks([
        { id: 'task-1', description: 'Fix auth', ownedFiles: ['src/auth/login.ts'] },
        { id: 'task-2', description: 'Fix api', ownedFiles: ['src/api/routes.ts'] }
      ]);

      const result = claimTaskForFiles('agent-1', ['src/auth/*']);
      expect(result.success).toBe(true);
      expect(result.taskId).toBe('task-1');
    });

    it('should fall back to regular claim when no file match', () => {
      addTasks([
        { id: 'task-1', description: 'Fix utils', ownedFiles: ['src/utils.ts'] },
        { id: 'task-2', description: 'Fix config', ownedFiles: ['src/config.ts'] }
      ]);

      // No match for this pattern
      const result = claimTaskForFiles('agent-1', ['src/hooks/*']);
      expect(result.success).toBe(true);
      // Falls back to regular claiming - gets first by priority/id
      expect(result.taskId).toBe('task-1');
    });

    it('should fall back when tasks have no file ownership', () => {
      addTasks([
        { id: 'task-1', description: 'Generic task' },
        { id: 'task-2', description: 'Another task' }
      ]);

      const result = claimTaskForFiles('agent-1', ['src/**']);
      expect(result.success).toBe(true);
      // Falls back to regular claiming
      expect(result.taskId).toBe('task-1');
    });

    it('should match using filePatterns field', () => {
      addTasks([
        { id: 'task-1', description: 'Fix hooks', filePatterns: ['src/hooks/**/*.ts'] },
        { id: 'task-2', description: 'Fix api', filePatterns: ['src/api/**/*.ts'] }
      ]);

      const result = claimTaskForFiles('agent-1', ['src/hooks/**/*.ts']);
      expect(result.success).toBe(true);
      expect(result.taskId).toBe('task-1');
    });

    it('should respect priority when multiple tasks match file patterns', () => {
      addTasks([
        { id: 'task-1', description: 'Low priority hook fix', filePatterns: ['src/hooks/**/*.ts'], priority: 5 },
        { id: 'task-2', description: 'High priority hook fix', filePatterns: ['src/hooks/**/*.ts'], priority: 1 }
      ]);

      const result = claimTaskForFiles('agent-1', ['src/hooks/**/*.ts']);
      expect(result.success).toBe(true);
      expect(result.taskId).toBe('task-2'); // Higher priority (lower number)
    });

    it('should handle glob wildcards correctly', () => {
      addTasks([
        { id: 'task-1', description: 'Fix nested file', ownedFiles: ['src/deep/nested/file.ts'] }
      ]);

      const result = claimTaskForFiles('agent-1', ['src/**/file.ts']);
      expect(result.success).toBe(true);
      expect(result.taskId).toBe('task-1');
    });
  });
});
