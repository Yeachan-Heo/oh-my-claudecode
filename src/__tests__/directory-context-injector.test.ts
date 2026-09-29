/**
 * Tests for directory context injector (README.md + AGENTS.md)
 *
 * Validates that the directory-readme-injector correctly discovers
 * and injects both README.md and AGENTS.md files (issue #613).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join, sep } from 'path';
import { tmpdir } from 'os';
import { createDirectoryReadmeInjectorHook } from '../hooks/directory-readme-injector/index.js';
import {
  README_FILENAME,
  AGENTS_FILENAME,
  CONTEXT_FILENAMES,
  TRACKED_TOOLS,
} from '../hooks/directory-readme-injector/constants.js';

describe('Directory Context Injector - AGENTS.md support (issue #613)', () => {
  let testDir: string;
  let sessionId: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `omc-test-context-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    sessionId = `test-session-${Date.now()}`;
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('constants', () => {
    it('should export AGENTS_FILENAME', () => {
      expect(AGENTS_FILENAME).toBe('AGENTS.md');
    });

    it('should export CONTEXT_FILENAMES with both README and AGENTS', () => {
      expect(CONTEXT_FILENAMES).toContain('README.md');
      expect(CONTEXT_FILENAMES).toContain('AGENTS.md');
      expect(CONTEXT_FILENAMES).toHaveLength(2);
    });

    it('should export README_FILENAME unchanged', () => {
      expect(README_FILENAME).toBe('README.md');
    });

    it('should export TRACKED_TOOLS', () => {
      expect(TRACKED_TOOLS).toContain('read');
      expect(TRACKED_TOOLS).toContain('edit');
    });
  });

  describe('AGENTS.md discovery', () => {
    it('should find AGENTS.md in working directory root', () => {
      writeFileSync(join(testDir, 'AGENTS.md'), '# Root AGENTS\n\nProject docs for AI agents.');
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'dummy.ts'), 'const x = 1;');

      const hook = createDirectoryReadmeInjectorHook(testDir);
      const files = hook.getContextFilesForFile(join(testDir, 'src', 'dummy.ts'));

      expect(files.some(f => f.endsWith('AGENTS.md'))).toBe(true);
    });

    it('should find both README.md and AGENTS.md in same directory', () => {
      writeFileSync(join(testDir, 'README.md'), '# Project README');
      writeFileSync(join(testDir, 'AGENTS.md'), '# Project AGENTS');
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'index.ts'), 'export {};');

      const hook = createDirectoryReadmeInjectorHook(testDir);
      const files = hook.getContextFilesForFile(join(testDir, 'src', 'index.ts'));

      const readmes = files.filter(f => f.endsWith('README.md'));
      const agents = files.filter(f => f.endsWith('AGENTS.md'));

      expect(readmes).toHaveLength(1);
      expect(agents).toHaveLength(1);
    });

    it('should find AGENTS.md in subdirectories walking up', () => {
      mkdirSync(join(testDir, 'src', 'hooks'), { recursive: true });
      writeFileSync(join(testDir, 'AGENTS.md'), '# Root agents');
      writeFileSync(join(testDir, 'src', 'AGENTS.md'), '# Src agents');
      writeFileSync(join(testDir, 'src', 'hooks', 'index.ts'), 'export {};');

      const hook = createDirectoryReadmeInjectorHook(testDir);
      const files = hook.getContextFilesForFile(join(testDir, 'src', 'hooks', 'index.ts'));

      const agentsFiles = files.filter(f => f.endsWith('AGENTS.md'));
      // Should find root AGENTS.md and src/AGENTS.md
      expect(agentsFiles).toHaveLength(2);
    });

    it('should not find AGENTS.md when none exists', () => {
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'index.ts'), 'export {};');

      const hook = createDirectoryReadmeInjectorHook(testDir);
      const files = hook.getContextFilesForFile(join(testDir, 'src', 'index.ts'));

      expect(files.filter(f => f.endsWith('AGENTS.md'))).toHaveLength(0);
    });

    it('should return files in root-to-leaf order', () => {
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'AGENTS.md'), '# Root');
      writeFileSync(join(testDir, 'src', 'AGENTS.md'), '# Src');
      writeFileSync(join(testDir, 'src', 'index.ts'), 'export {};');

      const hook = createDirectoryReadmeInjectorHook(testDir);
      const files = hook.getContextFilesForFile(join(testDir, 'src', 'index.ts'));

      const agentsFiles = files.filter(f => f.endsWith('AGENTS.md'));
      // Root should come before src
      expect(agentsFiles[0]).toContain(join(testDir, 'AGENTS.md'));
      expect(agentsFiles[1]).toContain(join(testDir, 'src', 'AGENTS.md'));
    });
  });

  describe('working directory boundary', () => {
    it('does not walk into a sibling directory that shares the working directory name as a prefix', () => {
      const cwd = join(testDir, 'app');
      const sibling = join(testDir, 'app-legacy');
      mkdirSync(join(cwd, 'src'), { recursive: true });
      mkdirSync(join(sibling, 'src'), { recursive: true });
      writeFileSync(join(sibling, 'README.md'), '# Sibling project README');
      writeFileSync(join(sibling, 'src', 'a.ts'), 'export {};');

      const hook = createDirectoryReadmeInjectorHook(cwd);
      const filePath = join(sibling, 'src', 'a.ts');

      expect(hook.getContextFilesForFile(filePath)).not.toContain(join(sibling, 'README.md'));
      expect(hook.processToolExecution('read', filePath, sessionId)).not.toContain('Sibling project README');
    });

    it('does not walk above the working directory from a file outside it', () => {
      const cwd = join(testDir, 'app');
      mkdirSync(cwd, { recursive: true });
      mkdirSync(join(testDir, 'other'), { recursive: true });
      writeFileSync(join(testDir, 'README.md'), '# Parent README');
      writeFileSync(join(testDir, 'other', 'a.ts'), 'export {};');

      const hook = createDirectoryReadmeInjectorHook(cwd);
      const files = hook.getContextFilesForFile(join(testDir, 'other', 'a.ts'));

      expect(files).not.toContain(join(testDir, 'README.md'));
    });

    it('still reaches the root when the working directory has a trailing separator', () => {
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'AGENTS.md'), '# Root');
      writeFileSync(join(testDir, 'src', 'index.ts'), 'export {};');

      const hook = createDirectoryReadmeInjectorHook(`${testDir}${sep}`);
      const files = hook.getContextFilesForFile(join(testDir, 'src', 'index.ts'));

      expect(files).toContain(join(testDir, 'AGENTS.md'));
    });

    it('keeps walking through a directory whose name starts with two dots', () => {
      mkdirSync(join(testDir, '..cache', 'sub'), { recursive: true });
      writeFileSync(join(testDir, 'AGENTS.md'), '# Root');
      writeFileSync(join(testDir, '..cache', 'sub', 'index.ts'), 'export {};');

      const hook = createDirectoryReadmeInjectorHook(testDir);
      const files = hook.getContextFilesForFile(join(testDir, '..cache', 'sub', 'index.ts'));

      expect(files).toContain(join(testDir, 'AGENTS.md'));
    });
  });

  describe('injection deduplication', () => {
    it('should inject AGENTS.md content only once per session', () => {
      writeFileSync(join(testDir, 'AGENTS.md'), '# Root agents docs');
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'a.ts'), 'const a = 1;');
      writeFileSync(join(testDir, 'src', 'b.ts'), 'const b = 2;');

      const hook = createDirectoryReadmeInjectorHook(testDir);

      // First access should inject
      const first = hook.processToolExecution('read', join(testDir, 'src', 'a.ts'), sessionId);
      expect(first).toContain('AGENTS');
      expect(first).toContain('Root agents docs');

      // Second access in same session should NOT re-inject
      const second = hook.processToolExecution('read', join(testDir, 'src', 'b.ts'), sessionId);
      expect(second).not.toContain('Root agents docs');
    });

    it('should inject both README.md and AGENTS.md from same directory independently', () => {
      writeFileSync(join(testDir, 'README.md'), '# Project README content');
      writeFileSync(join(testDir, 'AGENTS.md'), '# Project AGENTS content');
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'index.ts'), 'export {};');

      const hook = createDirectoryReadmeInjectorHook(testDir);
      const output = hook.processToolExecution('read', join(testDir, 'src', 'index.ts'), sessionId);

      // Both should be injected
      expect(output).toContain('Project README content');
      expect(output).toContain('Project AGENTS content');
      expect(output).toContain('[Project README:');
      expect(output).toContain('[Project AGENTS:');
    });

    it('should not inject for untracked tools', () => {
      writeFileSync(join(testDir, 'AGENTS.md'), '# Agents');
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'index.ts'), 'export {};');

      const hook = createDirectoryReadmeInjectorHook(testDir);
      const output = hook.processToolExecution('bash', join(testDir, 'src', 'index.ts'), sessionId);

      expect(output).toBe('');
    });
  });

  describe('content labeling', () => {
    it('should label AGENTS.md with [Project AGENTS: ...]', () => {
      writeFileSync(join(testDir, 'AGENTS.md'), '# Test agents');
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'index.ts'), 'export {};');

      const hook = createDirectoryReadmeInjectorHook(testDir);
      const output = hook.processToolExecution('read', join(testDir, 'src', 'index.ts'), sessionId);

      expect(output).toContain('[Project AGENTS:');
      expect(output).toContain('AGENTS.md]');
    });

    it('should label README.md with [Project README: ...]', () => {
      writeFileSync(join(testDir, 'README.md'), '# Test readme');
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'index.ts'), 'export {};');

      const hook = createDirectoryReadmeInjectorHook(testDir);
      const output = hook.processToolExecution('read', join(testDir, 'src', 'index.ts'), sessionId);

      expect(output).toContain('[Project README:');
      expect(output).toContain('README.md]');
    });
  });

  describe('truncation', () => {
    it('should truncate large AGENTS.md content', () => {
      // Create content larger than 5000 tokens (~20000 chars)
      const largeContent = '# Large AGENTS\n\n' + 'x'.repeat(25000);
      writeFileSync(join(testDir, 'AGENTS.md'), largeContent);
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'index.ts'), 'export {};');

      const hook = createDirectoryReadmeInjectorHook(testDir);
      const output = hook.processToolExecution('read', join(testDir, 'src', 'index.ts'), sessionId);

      expect(output).toContain('[Note: Content was truncated');
      // Should not contain the full content
      expect(output.length).toBeLessThan(largeContent.length);
    });
  });

  describe('backward compatibility', () => {
    it('should still export getReadmesForFile (deprecated)', () => {
      writeFileSync(join(testDir, 'README.md'), '# Readme');
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'index.ts'), 'export {};');

      const hook = createDirectoryReadmeInjectorHook(testDir);
      // Deprecated function should still work
      const files = hook.getReadmesForFile(join(testDir, 'src', 'index.ts'));
      expect(files.some(f => f.endsWith('README.md'))).toBe(true);
    });

    it('getReadmesForFile should also find AGENTS.md', () => {
      writeFileSync(join(testDir, 'AGENTS.md'), '# Agents');
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'index.ts'), 'export {};');

      const hook = createDirectoryReadmeInjectorHook(testDir);
      const files = hook.getReadmesForFile(join(testDir, 'src', 'index.ts'));
      expect(files.some(f => f.endsWith('AGENTS.md'))).toBe(true);
    });
  });
});
