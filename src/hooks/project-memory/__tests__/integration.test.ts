/**
 * Integration Tests for Project Memory Hook
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { registerProjectMemoryContext, clearProjectMemorySession } from '../index.js';
import { loadProjectMemory } from '../storage.js';
import { learnFromToolOutput } from '../learner.js';

describe('Project Memory Integration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'integration-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('End-to-end SessionStart flow', () => {
    it('should detect, persist, and inject context on first session', async () => {
      // Create a TypeScript project
      const packageJson = {
        name: 'test-app',
        scripts: {
          build: 'tsc',
          test: 'vitest',
        },
        dependencies: {
          react: '^18.2.0',
        },
        devDependencies: {
          typescript: '^5.0.0',
        },
      };

      await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));
      await fs.writeFile(path.join(tempDir, 'tsconfig.json'), '{}');
      await fs.writeFile(path.join(tempDir, 'pnpm-lock.yaml'), '');

      // Simulate SessionStart hook
      const sessionId = 'test-session-1';
      const registered = await registerProjectMemoryContext(sessionId, tempDir);

      expect(registered).toBe(true);

      // Verify memory file was created
      const memory = await loadProjectMemory(tempDir);
      expect(memory).not.toBeNull();
      expect(memory?.techStack.packageManager).toBe('pnpm');
      expect(memory?.build.buildCommand).toBe('pnpm build');

      // Verify .omc directory structure
      const omcDir = path.join(tempDir, '.omc');
      const omcStat = await fs.stat(omcDir);
      expect(omcStat.isDirectory()).toBe(true);
    });

    it('should not inject duplicate context in same session', async () => {
      const packageJson = { name: 'test' };
      await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson));

      const sessionId = 'test-session-2';

      // First registration
      const first = await registerProjectMemoryContext(sessionId, tempDir);
      expect(first).toBe(true);

      // Second registration in same session
      const second = await registerProjectMemoryContext(sessionId, tempDir);
      expect(second).toBe(false); // Should skip duplicate
    });

    it('should inject again for different session', async () => {
      const packageJson = { name: 'test' };
      await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson));

      // Session 1
      const session1 = 'test-session-3a';
      const first = await registerProjectMemoryContext(session1, tempDir);
      expect(first).toBe(true);

      // Session 2
      const session2 = 'test-session-3b';
      const second = await registerProjectMemoryContext(session2, tempDir);
      expect(second).toBe(true);
    });

    it('should not inject if project has no useful info', async () => {
      // Empty directory with no config files
      const sessionId = 'test-session-4';
      const registered = await registerProjectMemoryContext(sessionId, tempDir);

      expect(registered).toBe(false);
    });
  });

  describe('End-to-end PostToolUse learning flow', () => {
    it('should learn build command from Bash execution', async () => {
      // Create initial project
      const packageJson = { name: 'test', scripts: {} };
      await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson));

      // Initial detection (no build command)
      const sessionId = 'test-session-5';
      await registerProjectMemoryContext(sessionId, tempDir);

      let memory = await loadProjectMemory(tempDir);
      expect(memory?.build.buildCommand).toBeNull();

      // Simulate user running build command
      await learnFromToolOutput('Bash', { command: 'npm run build' }, '', tempDir);

      // Verify learning
      memory = await loadProjectMemory(tempDir);
      expect(memory?.build.buildCommand).toBe('npm run build');
    });

    it('should learn environment hints from command output', async () => {
      // Create initial project
      const packageJson = { name: 'test' };
      await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson));

      // Initial detection
      const sessionId = 'test-session-6';
      await registerProjectMemoryContext(sessionId, tempDir);

      // Simulate command with Node.js version in output
      const output = 'Node.js v20.10.0\nnpm v10.2.0';
      await learnFromToolOutput('Bash', { command: 'node --version' }, output, tempDir);

      // Verify learning
      const memory = await loadProjectMemory(tempDir);
      expect(memory?.customNotes.length).toBeGreaterThan(0);
      expect(memory?.customNotes[0].category).toBe('runtime');
      expect(memory?.customNotes[0].content).toContain('Node.js');
    });
  });

  describe('Session cleanup', () => {
    it('should clear session cache', async () => {
      const packageJson = { name: 'test' };
      await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson));

      const sessionId = 'test-session-7';

      // Register
      await registerProjectMemoryContext(sessionId, tempDir);

      // Clear cache
      clearProjectMemorySession(sessionId);

      // Should register again (cache cleared)
      const registered = await registerProjectMemoryContext(sessionId, tempDir);
      expect(registered).toBe(true);
    });
  });

  describe('Cache expiry', () => {
    it('should rescan if cache is stale', async () => {
      const packageJson = { name: 'test', version: '1.0.0' };
      await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson));

      // Initial scan
      const sessionId = 'test-session-8';
      await registerProjectMemoryContext(sessionId, tempDir);

      // Load and manually set lastScanned to 25 hours ago
      let memory = await loadProjectMemory(tempDir);
      expect(memory).not.toBeNull();
      memory!.lastScanned = Date.now() - 25 * 60 * 60 * 1000;

      // Save with old timestamp
      const memoryPath = path.join(tempDir, '.omc', 'project-memory.json');
      await fs.writeFile(memoryPath, JSON.stringify(memory, null, 2));

      // Clear session cache to allow re-registration
      clearProjectMemorySession(sessionId);

      // Register again - should trigger rescan
      await registerProjectMemoryContext(sessionId, tempDir);

      // Verify lastScanned was updated
      const updated = await loadProjectMemory(tempDir);
      const age = Date.now() - updated!.lastScanned;
      expect(age).toBeLessThan(5000); // Less than 5 seconds old
    });
  });
});
