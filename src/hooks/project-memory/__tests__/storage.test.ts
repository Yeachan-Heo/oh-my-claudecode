/**
 * Tests for Project Memory Storage
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  loadProjectMemory,
  saveProjectMemory,
  shouldRescan,
  deleteProjectMemory,
  getMemoryPath,
} from '../storage.js';
import { ProjectMemory } from '../types.js';
import { SCHEMA_VERSION } from '../constants.js';

// Helper to create base memory with all required fields
const createBaseMemory = (projectRoot: string, overrides: Partial<ProjectMemory> = {}): ProjectMemory => ({
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
  ...overrides,
});

describe('Project Memory Storage', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-memory-test-'));
    projectRoot = tempDir;
  });

  afterEach(async () => {
    // Clean up temporary directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('getMemoryPath', () => {
    it('should return correct memory file path', () => {
      const memoryPath = getMemoryPath(projectRoot);
      expect(memoryPath).toBe(path.join(projectRoot, '.omc', 'project-memory.json'));
    });
  });

  describe('saveProjectMemory', () => {
    it('should create .omc directory and save memory file', async () => {
      const memory = createBaseMemory(projectRoot, {
        techStack: {
          languages: [{ name: 'TypeScript', version: '5.0.0', confidence: 'high', markers: ['tsconfig.json'] }],
          frameworks: [],
          packageManager: 'pnpm',
          runtime: null,
        },
        build: {
          buildCommand: 'pnpm build',
          testCommand: 'pnpm test',
          lintCommand: null,
          devCommand: null,
          scripts: {},
        },
        conventions: {
          namingStyle: null,
          importStyle: null,
          testPattern: null,
          fileOrganization: null,
        },
        structure: {
          isMonorepo: false,
          workspaces: [],
          mainDirectories: [],
          gitBranches: null,
        },
        customNotes: [],
      });

      await saveProjectMemory(projectRoot, memory);

      // Verify .omc directory exists
      const omcDir = path.join(projectRoot, '.omc');
      const omcStat = await fs.stat(omcDir);
      expect(omcStat.isDirectory()).toBe(true);

      // Verify memory file exists
      const memoryPath = getMemoryPath(projectRoot);
      const memoryStat = await fs.stat(memoryPath);
      expect(memoryStat.isFile()).toBe(true);

      // Verify content
      const content = await fs.readFile(memoryPath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.version).toBe(SCHEMA_VERSION);
      expect(parsed.projectRoot).toBe(projectRoot);
    });

    it('should overwrite existing memory file', async () => {
      const memory1 = createBaseMemory(projectRoot, {
        techStack: { languages: [], frameworks: [], packageManager: null, runtime: null },
        build: { buildCommand: null, testCommand: null, lintCommand: null, devCommand: null, scripts: {} },
        conventions: { namingStyle: null, importStyle: null, testPattern: null, fileOrganization: null },
        structure: { isMonorepo: false, workspaces: [], mainDirectories: [], gitBranches: null },
        customNotes: [],
      });

      await saveProjectMemory(projectRoot, memory1);

      const memory2 = { ...memory1, techStack: { ...memory1.techStack, packageManager: 'yarn' } };
      await saveProjectMemory(projectRoot, memory2);

      const loaded = await loadProjectMemory(projectRoot);
      expect(loaded?.techStack.packageManager).toBe('yarn');
    });
  });

  describe('loadProjectMemory', () => {
    it('should return null if memory file does not exist', async () => {
      const memory = await loadProjectMemory(projectRoot);
      expect(memory).toBeNull();
    });

    it('should load existing memory file', async () => {
      const original = createBaseMemory(projectRoot, {
        techStack: {
          languages: [{ name: 'Rust', version: '1.70.0', confidence: 'high', markers: ['Cargo.toml'] }],
          frameworks: [],
          packageManager: 'cargo',
          runtime: null,
        },
        build: {
          buildCommand: 'cargo build',
          testCommand: 'cargo test',
          lintCommand: 'cargo clippy',
          devCommand: null,
          scripts: {},
        },
        conventions: {
          namingStyle: 'snake_case',
          importStyle: null,
          testPattern: null,
          fileOrganization: null,
        },
        structure: {
          isMonorepo: false,
          workspaces: [],
          mainDirectories: ['src'],
          gitBranches: null,
        },
      });

      await saveProjectMemory(projectRoot, original);
      const loaded = await loadProjectMemory(projectRoot);

      expect(loaded).not.toBeNull();
      expect(loaded?.version).toBe(SCHEMA_VERSION);
      expect(loaded?.techStack.languages[0].name).toBe('Rust');
      expect(loaded?.build.buildCommand).toBe('cargo build');
    });

    it('should return null for invalid JSON', async () => {
      // Create .omc directory
      const omcDir = path.join(projectRoot, '.omc');
      await fs.mkdir(omcDir, { recursive: true });

      // Write invalid JSON
      const memoryPath = getMemoryPath(projectRoot);
      await fs.writeFile(memoryPath, 'invalid json', 'utf-8');

      const memory = await loadProjectMemory(projectRoot);
      expect(memory).toBeNull();
    });

    it('should return null for memory with missing required fields', async () => {
      // Create .omc directory
      const omcDir = path.join(projectRoot, '.omc');
      await fs.mkdir(omcDir, { recursive: true });

      // Write incomplete memory
      const memoryPath = getMemoryPath(projectRoot);
      await fs.writeFile(memoryPath, JSON.stringify({ version: SCHEMA_VERSION }), 'utf-8');

      const memory = await loadProjectMemory(projectRoot);
      expect(memory).toBeNull();
    });
  });

  describe('shouldRescan', () => {
    it('should return true if memory is older than 24 hours', () => {
      const oldTimestamp = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
      const memory = createBaseMemory(projectRoot, { lastScanned: oldTimestamp,
        techStack: { languages: [], frameworks: [], packageManager: null, runtime: null },
        build: { buildCommand: null, testCommand: null, lintCommand: null, devCommand: null, scripts: {} },
        conventions: { namingStyle: null, importStyle: null, testPattern: null, fileOrganization: null },
        structure: { isMonorepo: false, workspaces: [], mainDirectories: [], gitBranches: null },
        customNotes: [],
      });

      expect(shouldRescan(memory)).toBe(true);
    });

    it('should return false if memory is recent', () => {
      const recentTimestamp = Date.now() - 1 * 60 * 60 * 1000; // 1 hour ago
      const memory = createBaseMemory(projectRoot, { lastScanned: recentTimestamp,
        techStack: { languages: [], frameworks: [], packageManager: null, runtime: null },
        build: { buildCommand: null, testCommand: null, lintCommand: null, devCommand: null, scripts: {} },
        conventions: { namingStyle: null, importStyle: null, testPattern: null, fileOrganization: null },
        structure: { isMonorepo: false, workspaces: [], mainDirectories: [], gitBranches: null },
        customNotes: [],
      });

      expect(shouldRescan(memory)).toBe(false);
    });
  });

  describe('deleteProjectMemory', () => {
    it('should delete memory file if it exists', async () => {
      const memory = createBaseMemory(projectRoot, {
        techStack: { languages: [], frameworks: [], packageManager: null, runtime: null },
        build: { buildCommand: null, testCommand: null, lintCommand: null, devCommand: null, scripts: {} },
        conventions: { namingStyle: null, importStyle: null, testPattern: null, fileOrganization: null },
        structure: { isMonorepo: false, workspaces: [], mainDirectories: [], gitBranches: null },
        customNotes: [],
      });

      await saveProjectMemory(projectRoot, memory);
      await deleteProjectMemory(projectRoot);

      const loaded = await loadProjectMemory(projectRoot);
      expect(loaded).toBeNull();
    });

    it('should not throw error if memory file does not exist', async () => {
      await expect(deleteProjectMemory(projectRoot)).resolves.not.toThrow();
    });
  });
});
