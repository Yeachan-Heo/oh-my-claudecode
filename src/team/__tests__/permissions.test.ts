import { describe, it, expect } from 'vitest';
import {
  isPathAllowed,
  isCommandAllowed,
  formatPermissionInstructions,
  getDefaultPermissions,
} from '../permissions.js';
import type { WorkerPermissions } from '../permissions.js';

describe('permissions', () => {
  const workDir = '/home/user/project';

  describe('isPathAllowed', () => {
    it('allows all paths with default permissions', () => {
      const perms = getDefaultPermissions('worker1');
      expect(isPathAllowed(perms, 'src/index.ts', workDir)).toBe(true);
      expect(isPathAllowed(perms, 'package.json', workDir)).toBe(true);
    });

    it('allows matching paths', () => {
      const perms: WorkerPermissions = {
        workerName: 'worker1',
        allowedPaths: ['src/**'],
        deniedPaths: [],
        allowedCommands: [],
        maxFileSize: Infinity,
      };
      expect(isPathAllowed(perms, 'src/index.ts', workDir)).toBe(true);
      expect(isPathAllowed(perms, 'src/deep/file.ts', workDir)).toBe(true);
    });

    it('denies non-matching paths', () => {
      const perms: WorkerPermissions = {
        workerName: 'worker1',
        allowedPaths: ['src/**'],
        deniedPaths: [],
        allowedCommands: [],
        maxFileSize: Infinity,
      };
      expect(isPathAllowed(perms, 'package.json', workDir)).toBe(false);
    });

    it('denied paths override allowed', () => {
      const perms: WorkerPermissions = {
        workerName: 'worker1',
        allowedPaths: ['src/**'],
        deniedPaths: ['src/secrets/**'],
        allowedCommands: [],
        maxFileSize: Infinity,
      };
      expect(isPathAllowed(perms, 'src/index.ts', workDir)).toBe(true);
      expect(isPathAllowed(perms, 'src/secrets/keys.ts', workDir)).toBe(false);
    });

    it('denies paths outside working directory', () => {
      const perms = getDefaultPermissions('worker1');
      expect(isPathAllowed(perms, '../../etc/passwd', workDir)).toBe(false);
    });

    it('treats dots literally, not as regex wildcards', () => {
      const perms: WorkerPermissions = {
        workerName: 'worker1',
        allowedPaths: ['src/*.ts'],
        deniedPaths: [],
        allowedCommands: [],
        maxFileSize: Infinity,
      };
      expect(isPathAllowed(perms, 'src/index.ts', workDir)).toBe(true);
      // A dot in the pattern should NOT match arbitrary characters
      expect(isPathAllowed(perms, 'src/indexXts', workDir)).toBe(false);
    });

    it('supports ? wildcard for single non-/ character', () => {
      const perms: WorkerPermissions = {
        workerName: 'worker1',
        allowedPaths: ['src/?.ts'],
        deniedPaths: [],
        allowedCommands: [],
        maxFileSize: Infinity,
      };
      expect(isPathAllowed(perms, 'src/a.ts', workDir)).toBe(true);
      expect(isPathAllowed(perms, 'src/ab.ts', workDir)).toBe(false);
    });

    it('handles patterns with regex meta characters safely', () => {
      const perms: WorkerPermissions = {
        workerName: 'worker1',
        allowedPaths: ['src/[utils]/**'],
        deniedPaths: [],
        allowedCommands: [],
        maxFileSize: Infinity,
      };
      // Brackets should be treated literally, not as regex character classes
      expect(isPathAllowed(perms, 'src/[utils]/index.ts', workDir)).toBe(true);
      expect(isPathAllowed(perms, 'src/u/index.ts', workDir)).toBe(false);
    });
  });

  describe('isCommandAllowed', () => {
    it('allows all commands with empty list', () => {
      const perms = getDefaultPermissions('worker1');
      expect(isCommandAllowed(perms, 'npm test')).toBe(true);
      expect(isCommandAllowed(perms, 'rm -rf /')).toBe(true);
    });

    it('allows matching command prefixes', () => {
      const perms: WorkerPermissions = {
        workerName: 'worker1',
        allowedPaths: [],
        deniedPaths: [],
        allowedCommands: ['npm test', 'tsc', 'npx vitest'],
        maxFileSize: Infinity,
      };
      expect(isCommandAllowed(perms, 'npm test')).toBe(true);
      expect(isCommandAllowed(perms, 'npm test --coverage')).toBe(true);
      expect(isCommandAllowed(perms, 'tsc --noEmit')).toBe(true);
    });

    it('denies non-matching commands', () => {
      const perms: WorkerPermissions = {
        workerName: 'worker1',
        allowedPaths: [],
        deniedPaths: [],
        allowedCommands: ['npm test', 'tsc'],
        maxFileSize: Infinity,
      };
      expect(isCommandAllowed(perms, 'rm -rf /')).toBe(false);
      expect(isCommandAllowed(perms, 'npm install')).toBe(false);
    });
  });

  describe('formatPermissionInstructions', () => {
    it('generates clear instructions', () => {
      const perms: WorkerPermissions = {
        workerName: 'worker1',
        allowedPaths: ['src/**'],
        deniedPaths: ['src/secrets/**'],
        allowedCommands: ['npm test'],
        maxFileSize: 102400, // 100KB
      };

      const instructions = formatPermissionInstructions(perms);
      expect(instructions).toContain('PERMISSION CONSTRAINTS');
      expect(instructions).toContain('src/**');
      expect(instructions).toContain('src/secrets/**');
      expect(instructions).toContain('npm test');
      expect(instructions).toContain('100KB');
    });

    it('shows no restrictions for default permissions', () => {
      const perms = getDefaultPermissions('worker1');
      const instructions = formatPermissionInstructions(perms);
      expect(instructions).toContain('No restrictions');
    });

    it('does not show "No restrictions" when only maxFileSize is set', () => {
      const perms: WorkerPermissions = {
        workerName: 'worker1',
        allowedPaths: [],
        deniedPaths: [],
        allowedCommands: [],
        maxFileSize: 51200, // 50KB
      };
      const instructions = formatPermissionInstructions(perms);
      expect(instructions).toContain('50KB');
      expect(instructions).not.toContain('No restrictions');
    });

    it('shows maxFileSize of 0 as a restriction', () => {
      const perms: WorkerPermissions = {
        workerName: 'worker1',
        allowedPaths: [],
        deniedPaths: [],
        allowedCommands: [],
        maxFileSize: 0,
      };
      const instructions = formatPermissionInstructions(perms);
      expect(instructions).toContain('0KB');
      expect(instructions).not.toContain('No restrictions');
    });
  });

  describe('getDefaultPermissions', () => {
    it('returns permissive defaults', () => {
      const perms = getDefaultPermissions('worker1');
      expect(perms.workerName).toBe('worker1');
      expect(perms.allowedPaths).toEqual([]);
      expect(perms.deniedPaths).toEqual([]);
      expect(perms.allowedCommands).toEqual([]);
      expect(perms.maxFileSize).toBe(Infinity);
    });
  });
});
