/**
 * Tests for Project Memory Learner
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { learnFromToolOutput, addCustomNote } from '../learner.js';
import { saveProjectMemory, loadProjectMemory } from '../storage.js';
import { ProjectMemory } from '../types.js';
import { SCHEMA_VERSION } from '../constants.js';

// Helper to create base memory with all required fields
const createBaseMemory = (projectRoot: string): ProjectMemory => ({
  version: SCHEMA_VERSION,
  lastScanned: Date.now(),
  projectRoot,
  techStack: { languages: [], frameworks: [], packageManager: null, runtime: null },
  build: { buildCommand: null, testCommand: null, lintCommand: null, devCommand: null, scripts: {} },
  conventions: { namingStyle: null, importStyle: null, testPattern: null, fileOrganization: null },
  structure: { isMonorepo: false, workspaces: [], mainDirectories: [], gitBranches: null },
  customNotes: [],
  directoryMap: {},
  hotPaths: [],
  userDirectives: [],
});

describe('Project Memory Learner', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learner-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const createBasicMemory = (): ProjectMemory => createBaseMemory(tempDir);

  describe('learnFromToolOutput', () => {
    it('should ignore non-Bash tools', async () => {
      const memory = createBasicMemory();
      await saveProjectMemory(tempDir, memory);

      await learnFromToolOutput('Read', { file_path: '/test' }, '', tempDir);

      const updated = await loadProjectMemory(tempDir);
      expect(updated?.build.buildCommand).toBeNull();
    });

    it('should detect and store build commands', async () => {
      const memory = createBasicMemory();
      await saveProjectMemory(tempDir, memory);

      await learnFromToolOutput('Bash', { command: 'pnpm build' }, '', tempDir);

      const updated = await loadProjectMemory(tempDir);
      expect(updated?.build.buildCommand).toBe('pnpm build');
    });

    it('should detect and store test commands', async () => {
      const memory = createBasicMemory();
      await saveProjectMemory(tempDir, memory);

      await learnFromToolOutput('Bash', { command: 'cargo test' }, '', tempDir);

      const updated = await loadProjectMemory(tempDir);
      expect(updated?.build.testCommand).toBe('cargo test');
    });

    it('should extract Node.js version from output', async () => {
      const memory = createBasicMemory();
      await saveProjectMemory(tempDir, memory);

      const output = 'Node.js v20.10.0\n...';
      await learnFromToolOutput('Bash', { command: 'node --version' }, output, tempDir);

      const updated = await loadProjectMemory(tempDir);
      expect(updated?.customNotes).toHaveLength(1);
      expect(updated?.customNotes[0].category).toBe('runtime');
      expect(updated?.customNotes[0].content).toContain('Node.js');
    });

    it('should extract Python version from output', async () => {
      const memory = createBasicMemory();
      await saveProjectMemory(tempDir, memory);

      const output = 'Python 3.11.5\n...';
      await learnFromToolOutput('Bash', { command: 'python --version' }, output, tempDir);

      const updated = await loadProjectMemory(tempDir);
      expect(updated?.customNotes).toHaveLength(1);
      expect(updated?.customNotes[0].category).toBe('runtime');
      expect(updated?.customNotes[0].content).toContain('Python 3.11.5');
    });

    it('should extract Rust version from output', async () => {
      const memory = createBasicMemory();
      await saveProjectMemory(tempDir, memory);

      const output = 'rustc 1.75.0 (82e1608df 2024-01-01)\n...';
      await learnFromToolOutput('Bash', { command: 'rustc --version' }, output, tempDir);

      const updated = await loadProjectMemory(tempDir);
      expect(updated?.customNotes).toHaveLength(1);
      expect(updated?.customNotes[0].category).toBe('runtime');
      expect(updated?.customNotes[0].content).toContain('Rust 1.75.0');
    });

    it('should detect missing modules', async () => {
      const memory = createBasicMemory();
      await saveProjectMemory(tempDir, memory);

      const output = 'Error: Cannot find module \'express\'\n...';
      await learnFromToolOutput('Bash', { command: 'node app.js' }, output, tempDir);

      const updated = await loadProjectMemory(tempDir);
      expect(updated?.customNotes).toHaveLength(1);
      expect(updated?.customNotes[0].category).toBe('dependency');
      expect(updated?.customNotes[0].content).toContain('express');
    });

    it('should detect required environment variables', async () => {
      const memory = createBasicMemory();
      await saveProjectMemory(tempDir, memory);

      const output = 'Error: Missing environment variable: DATABASE_URL\n...';
      await learnFromToolOutput('Bash', { command: 'npm start' }, output, tempDir);

      const updated = await loadProjectMemory(tempDir);
      expect(updated?.customNotes).toHaveLength(1);
      expect(updated?.customNotes[0].category).toBe('env');
      expect(updated?.customNotes[0].content).toContain('DATABASE_URL');
    });

    it('should not duplicate existing notes', async () => {
      const memory = createBasicMemory();
      memory.customNotes.push({
        timestamp: Date.now(),
        source: 'learned',
        category: 'runtime',
        content: 'Node.js v20.10.0',
      });
      await saveProjectMemory(tempDir, memory);

      const output = 'Node.js v20.10.0\n...';
      await learnFromToolOutput('Bash', { command: 'node --version' }, output, tempDir);

      const updated = await loadProjectMemory(tempDir);
      expect(updated?.customNotes).toHaveLength(1);
    });

    it('should limit custom notes to 20 entries', async () => {
      const memory = createBasicMemory();
      // Add 20 existing notes
      for (let i = 0; i < 20; i++) {
        memory.customNotes.push({
          timestamp: Date.now(),
          source: 'learned',
          category: 'test',
          content: `Note ${i}`,
        });
      }
      await saveProjectMemory(tempDir, memory);

      // Add one more
      const output = 'Node.js v20.10.0\n...';
      await learnFromToolOutput('Bash', { command: 'node --version' }, output, tempDir);

      const updated = await loadProjectMemory(tempDir);
      expect(updated?.customNotes).toHaveLength(20);
      expect(updated?.customNotes[19].content).toContain('Node.js');
    });

    it('should do nothing if memory file does not exist', async () => {
      await expect(
        learnFromToolOutput('Bash', { command: 'pnpm build' }, '', tempDir)
      ).resolves.not.toThrow();
    });
  });

  describe('addCustomNote', () => {
    it('should add manual custom note', async () => {
      const memory = createBasicMemory();
      await saveProjectMemory(tempDir, memory);

      await addCustomNote(tempDir, 'deploy', 'Requires Docker');

      const updated = await loadProjectMemory(tempDir);
      expect(updated?.customNotes).toHaveLength(1);
      expect(updated?.customNotes[0].source).toBe('manual');
      expect(updated?.customNotes[0].category).toBe('deploy');
      expect(updated?.customNotes[0].content).toBe('Requires Docker');
    });

    it('should do nothing if memory file does not exist', async () => {
      await expect(
        addCustomNote(tempDir, 'test', 'Test note')
      ).resolves.not.toThrow();
    });
  });
});
