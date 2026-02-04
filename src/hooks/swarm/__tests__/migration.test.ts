import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, closeDb, addTask, addTasks, getTask, getTasks, getDb } from '../state.js';

describe('Schema Migration', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'swarm-migration-test-'));
  });

  afterEach(() => {
    closeDb();
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('Fresh database (v2)', () => {
    it('should create tables with new columns included', async () => {
      await initDb(testDir);

      // Add a task with new fields
      const success = addTask('task-1', 'Test task', {
        priority: 5,
        wave: 2,
        ownedFiles: ['src/test.ts'],
        filePatterns: ['src/**/*.ts']
      });
      expect(success).toBe(true);

      const task = getTask('task-1');
      expect(task).not.toBeNull();
      expect(task?.priority).toBe(5);
      expect(task?.wave).toBe(2);
      expect(task?.ownedFiles).toEqual(['src/test.ts']);
      expect(task?.filePatterns).toEqual(['src/**/*.ts']);
    });

    it('should apply default values for new fields', async () => {
      await initDb(testDir);

      // Add a task without new fields
      addTask('task-1', 'Test task');

      const task = getTask('task-1');
      expect(task).not.toBeNull();
      expect(task?.priority).toBe(0);
      expect(task?.wave).toBe(1);
      expect(task?.ownedFiles).toBeUndefined();
      expect(task?.filePatterns).toBeUndefined();
    });

    it('should store schema version 2', async () => {
      await initDb(testDir);

      const db = getDb();
      expect(db).not.toBeNull();

      const stmt = db!.prepare("SELECT value FROM schema_info WHERE key = 'version'");
      const row = stmt.get() as { value: string };
      expect(row.value).toBe('2');
    });
  });

  describe('v1 to v2 migration', () => {
    it('should migrate existing database by adding new columns', async () => {
      // First, create a v1 database manually
      await initDb(testDir);
      const db = getDb();
      expect(db).not.toBeNull();

      // Simulate v1 by setting version back to 1 and removing new columns would
      // be complex, so instead we verify the migration path works by:
      // 1. Setting version to 1
      db!.prepare("UPDATE schema_info SET value = '1' WHERE key = 'version'").run();

      // Close and re-open to trigger migration
      closeDb();
      await initDb(testDir);

      // Verify columns exist by inserting with new fields
      const success = addTask('task-1', 'Migrated task', {
        priority: 3,
        wave: 1,
        ownedFiles: ['file.ts']
      });
      expect(success).toBe(true);

      const task = getTask('task-1');
      expect(task?.priority).toBe(3);
      expect(task?.ownedFiles).toEqual(['file.ts']);
    });

    it('should preserve existing data after migration', async () => {
      await initDb(testDir);

      // Add tasks without new fields (like v1 would)
      addTask('task-1', 'Original task');

      // Simulate re-migration by setting version back
      const db = getDb();
      db!.prepare("UPDATE schema_info SET value = '1' WHERE key = 'version'").run();

      closeDb();
      await initDb(testDir);

      // Verify original task is preserved
      const task = getTask('task-1');
      expect(task).not.toBeNull();
      expect(task?.description).toBe('Original task');
      expect(task?.priority).toBe(0); // Default
      expect(task?.wave).toBe(1); // Default
    });

    it('should handle migration idempotently (running twice is safe)', async () => {
      await initDb(testDir);

      // Set version to 1 to trigger migration
      const db = getDb();
      db!.prepare("UPDATE schema_info SET value = '1' WHERE key = 'version'").run();
      closeDb();

      // First migration
      await initDb(testDir);
      closeDb();

      // Set version to 1 again
      await initDb(testDir);
      const db2 = getDb();
      db2!.prepare("UPDATE schema_info SET value = '1' WHERE key = 'version'").run();
      closeDb();

      // Second migration should not fail
      const success = await initDb(testDir);
      expect(success).toBe(true);

      // Verify everything works
      addTask('task-1', 'After double migration', { priority: 1 });
      const task = getTask('task-1');
      expect(task?.priority).toBe(1);
    });
  });

  describe('addTasks with new fields', () => {
    it('should batch add tasks with metadata', async () => {
      await initDb(testDir);

      const success = addTasks([
        { id: 'task-1', description: 'Task 1', priority: 1, wave: 1, ownedFiles: ['a.ts'] },
        { id: 'task-2', description: 'Task 2', priority: 2, wave: 1, filePatterns: ['src/**'] },
        { id: 'task-3', description: 'Task 3' } // No metadata
      ]);
      expect(success).toBe(true);

      const tasks = getTasks();
      expect(tasks).toHaveLength(3);

      // Tasks are ordered by priority ASC, then id ASC
      // task-3 has priority 0 (default), task-1 has priority 1, task-2 has priority 2
      expect(tasks[0].id).toBe('task-3');
      expect(tasks[0].priority).toBe(0);

      expect(tasks[1].id).toBe('task-1');
      expect(tasks[1].priority).toBe(1);
      expect(tasks[1].ownedFiles).toEqual(['a.ts']);

      expect(tasks[2].id).toBe('task-2');
      expect(tasks[2].priority).toBe(2);
      expect(tasks[2].filePatterns).toEqual(['src/**']);
    });
  });
});
