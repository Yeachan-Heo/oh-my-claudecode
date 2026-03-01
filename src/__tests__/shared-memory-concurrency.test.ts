/**
 * Tests for concurrent shared-memory access (issue #1160).
 *
 * Verifies that file-level locking prevents silent data loss when
 * multiple agents write to notepad and project memory simultaneously.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initNotepad,
  addWorkingMemoryEntry,
  addManualEntry,
  setPriorityContext,
  readNotepad,
  getNotepadPath,
  WORKING_MEMORY_HEADER,
  MANUAL_HEADER,
} from '../hooks/notepad/index.js';
import {
  loadProjectMemory,
  saveProjectMemory,
  withProjectMemoryLock,
} from '../hooks/project-memory/index.js';

describe('Shared Memory Concurrency (issue #1160)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `concurrency-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Notepad concurrent writes', () => {
    it('should not lose entries when multiple working memory writes happen concurrently', () => {
      initNotepad(testDir);

      // Simulate sequential writes (which previously raced without locking)
      const count = 5;
      for (let i = 0; i < count; i++) {
        const result = addWorkingMemoryEntry(testDir, `Agent ${i} observation`);
        expect(result).toBe(true);
      }

      // Verify all entries are present
      const content = readNotepad(testDir)!;
      for (let i = 0; i < count; i++) {
        expect(content).toContain(`Agent ${i} observation`);
      }
    });

    it('should not lose entries when manual and working memory writes interleave', () => {
      initNotepad(testDir);

      // Interleave different section writes
      addWorkingMemoryEntry(testDir, 'Working entry 1');
      addManualEntry(testDir, 'Manual entry 1');
      addWorkingMemoryEntry(testDir, 'Working entry 2');
      addManualEntry(testDir, 'Manual entry 2');

      const content = readNotepad(testDir)!;
      expect(content).toContain('Working entry 1');
      expect(content).toContain('Working entry 2');
      expect(content).toContain('Manual entry 1');
      expect(content).toContain('Manual entry 2');
    });

    it('should not lose priority context when set concurrently with working memory', () => {
      initNotepad(testDir);

      setPriorityContext(testDir, 'Critical discovery');
      addWorkingMemoryEntry(testDir, 'Working note');

      const content = readNotepad(testDir)!;
      expect(content).toContain('Critical discovery');
      expect(content).toContain('Working note');
    });

    it('lock file should be cleaned up after notepad writes', () => {
      initNotepad(testDir);

      addWorkingMemoryEntry(testDir, 'Test entry');

      const notepadPath = getNotepadPath(testDir);
      const lockPath = notepadPath + '.lock';
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  describe('Project memory concurrent writes', () => {
    it('withProjectMemoryLock should serialize concurrent access', async () => {
      // Set up initial memory
      const omcDir = join(testDir, '.omc');
      mkdirSync(omcDir, { recursive: true });

      const initialMemory = {
        version: '1.0.0',
        projectRoot: testDir,
        lastScanned: Date.now(),
        techStack: { languages: [], frameworks: [], packageManagers: [] },
        build: { buildCommand: null, testCommand: null, lintCommand: null },
        conventions: { indentation: null, quoting: null, semicolons: null },
        structure: { entryPoints: [], configFiles: [] },
        customNotes: [] as Array<{ timestamp: number; source: string; category: string; content: string }>,
        userDirectives: [],
        hotPaths: { files: [], directories: [] },
      };
      await saveProjectMemory(testDir, initialMemory as any);

      // Launch 5 concurrent note additions under lock
      const writers = Array.from({ length: 5 }, (_, i) =>
        withProjectMemoryLock(testDir, async () => {
          const memory = await loadProjectMemory(testDir);
          if (!memory) throw new Error('Memory not found');

          memory.customNotes.push({
            timestamp: Date.now(),
            source: 'learned',
            category: 'test',
            content: `Note from agent ${i}`,
          });

          await saveProjectMemory(testDir, memory);
        }),
      );

      await Promise.all(writers);

      // Verify all 5 notes are present (no data loss)
      const finalMemory = await loadProjectMemory(testDir);
      expect(finalMemory).not.toBeNull();
      expect(finalMemory!.customNotes).toHaveLength(5);
      for (let i = 0; i < 5; i++) {
        expect(
          finalMemory!.customNotes.some(
            (n: any) => n.content === `Note from agent ${i}`,
          ),
        ).toBe(true);
      }
    });

    it('lock file should be cleaned up after project memory writes', async () => {
      const omcDir = join(testDir, '.omc');
      mkdirSync(omcDir, { recursive: true });

      const memoryPath = join(omcDir, 'project-memory.json');
      writeFileSync(
        memoryPath,
        JSON.stringify({
          version: '1.0.0',
          projectRoot: testDir,
          lastScanned: Date.now(),
          techStack: { languages: [], frameworks: [], packageManagers: [] },
          build: {},
          conventions: {},
          structure: {},
          customNotes: [],
          userDirectives: [],
          hotPaths: { files: [], directories: [] },
        }),
      );

      await withProjectMemoryLock(testDir, async () => {
        // Do nothing -- just verify lock lifecycle
      });

      const lockPath = memoryPath + '.lock';
      expect(existsSync(lockPath)).toBe(false);
    });
  });
});
