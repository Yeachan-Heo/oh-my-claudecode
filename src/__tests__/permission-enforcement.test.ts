// src/__tests__/permission-enforcement.test.ts
//
// Tests for post-execution permission enforcement:
// - getEffectivePermissions merges secure deny-defaults
// - findPermissionViolations detects disallowed paths
// - matchGlob edge cases via isPathAllowed

import { describe, it, expect } from 'vitest';
import {
  isPathAllowed,
  getDefaultPermissions,
  getEffectivePermissions,
  findPermissionViolations,
} from '../team/permissions.js';

describe('getEffectivePermissions', () => {
  it('adds secure deny-defaults when no base provided', () => {
    const perms = getEffectivePermissions({ workerName: 'test-worker' });
    expect(perms.workerName).toBe('test-worker');
    expect(perms.deniedPaths).toContain('.git/**');
    expect(perms.deniedPaths).toContain('.env*');
    expect(perms.deniedPaths).toContain('**/.env*');
    expect(perms.deniedPaths).toContain('**/secrets/**');
    expect(perms.deniedPaths).toContain('**/.ssh/**');
    expect(perms.deniedPaths).toContain('**/node_modules/.cache/**');
  });

  it('merges caller deniedPaths with secure defaults (no duplicates)', () => {
    const perms = getEffectivePermissions({
      workerName: 'w1',
      deniedPaths: ['.git/**', 'custom/deny/**'],
      allowedPaths: ['src/**'],
      allowedCommands: ['npm test'],
      maxFileSize: 1024,
    });

    // .git/** should only appear once (from caller, not duplicated from defaults)
    const gitCount = perms.deniedPaths.filter((p: string) => p === '.git/**').length;
    expect(gitCount).toBe(1);

    // custom/deny/** should also be present
    expect(perms.deniedPaths).toContain('custom/deny/**');

    // Secure defaults should be present
    expect(perms.deniedPaths).toContain('.env*');
    expect(perms.deniedPaths).toContain('**/secrets/**');

    // Caller's allowedPaths preserved
    expect(perms.allowedPaths).toEqual(['src/**']);
    expect(perms.allowedCommands).toEqual(['npm test']);
    expect(perms.maxFileSize).toBe(1024);
  });

  it('returns full defaults when no base provided', () => {
    const perms = getEffectivePermissions(undefined as any);
    expect(perms.workerName).toBe('default');
    expect(perms.allowedPaths).toEqual([]);
    expect(perms.allowedCommands).toEqual([]);
    expect(perms.deniedPaths.length).toBeGreaterThan(0);
  });
});

describe('findPermissionViolations', () => {
  const cwd = '/tmp/test-project';

  it('returns empty array when all paths are allowed', () => {
    const perms = getEffectivePermissions({
      workerName: 'w1',
      allowedPaths: ['src/**'],
      deniedPaths: [],
      allowedCommands: [],
      maxFileSize: Infinity,
    });

    const violations = findPermissionViolations(
      ['src/index.ts', 'src/utils/helper.ts'],
      perms,
      cwd
    );
    expect(violations).toEqual([]);
  });

  it('detects violations for paths matching deny patterns', () => {
    const perms = getEffectivePermissions({
      workerName: 'w1',
      allowedPaths: [],
      deniedPaths: [],
      allowedCommands: [],
      maxFileSize: Infinity,
    });

    const violations = findPermissionViolations(
      ['.git/config', '.env.local', 'config/secrets/api-key.json'],
      perms,
      cwd
    );

    expect(violations.length).toBe(3);

    const paths = violations.map((v: any) => v.path);
    expect(paths).toContain('.git/config');
    expect(paths).toContain('.env.local');
    expect(paths).toContain('config/secrets/api-key.json');
  });

  it('detects violations for paths outside allowedPaths', () => {
    const perms = {
      workerName: 'w1',
      allowedPaths: ['src/**'],
      deniedPaths: [],
      allowedCommands: [],
      maxFileSize: Infinity,
    };

    const violations = findPermissionViolations(
      ['src/index.ts', 'package.json', 'docs/readme.md'],
      perms,
      cwd
    );

    expect(violations.length).toBe(2);
    const paths = violations.map((v: any) => v.path);
    expect(paths).toContain('package.json');
    expect(paths).toContain('docs/readme.md');
    // src/index.ts is allowed
    expect(paths).not.toContain('src/index.ts');
  });

  it('detects directory escape as violation', () => {
    const perms = getDefaultPermissions('w1');

    const violations = findPermissionViolations(
      ['../../etc/passwd'],
      perms,
      cwd
    );

    expect(violations.length).toBe(1);
    expect(violations[0].reason).toMatch(/escapes working directory/i);
  });

  it('returns empty for empty changedPaths', () => {
    const perms = getEffectivePermissions({ workerName: 'w1' });
    const violations = findPermissionViolations([], perms, cwd);
    expect(violations).toEqual([]);
  });

  it('violation reason mentions the matching deny pattern', () => {
    const perms = getEffectivePermissions({
      workerName: 'w1',
      allowedPaths: [],
      deniedPaths: [],
      allowedCommands: [],
      maxFileSize: Infinity,
    });

    const violations = findPermissionViolations(['.env'], perms, cwd);
    expect(violations.length).toBe(1);
    expect(violations[0].reason).toMatch(/denied pattern.*\.env/);
  });
});

describe('isPathAllowed with secure deny-defaults', () => {
  const cwd = '/tmp/test-project';

  it('denies .git/** even with empty allowedPaths', () => {
    const perms = getEffectivePermissions({ workerName: 'w1' });
    expect(isPathAllowed(perms, '.git/config', cwd)).toBe(false);
    expect(isPathAllowed(perms, '.git/objects/abc123', cwd)).toBe(false);
  });

  it('denies .env files at any depth', () => {
    const perms = getEffectivePermissions({ workerName: 'w1' });
    expect(isPathAllowed(perms, '.env', cwd)).toBe(false);
    expect(isPathAllowed(perms, '.env.local', cwd)).toBe(false);
    expect(isPathAllowed(perms, 'config/.env.production', cwd)).toBe(false);
  });

  it('denies secrets directories at any depth', () => {
    const perms = getEffectivePermissions({ workerName: 'w1' });
    expect(isPathAllowed(perms, 'secrets/api-key.json', cwd)).toBe(false);
    expect(isPathAllowed(perms, 'config/secrets/token.txt', cwd)).toBe(false);
  });

  it('denies .ssh directories at any depth', () => {
    const perms = getEffectivePermissions({ workerName: 'w1' });
    expect(isPathAllowed(perms, '.ssh/id_rsa', cwd)).toBe(false);
    expect(isPathAllowed(perms, 'home/.ssh/known_hosts', cwd)).toBe(false);
  });

  it('allows normal source files with effective permissions', () => {
    const perms = getEffectivePermissions({ workerName: 'w1' });
    expect(isPathAllowed(perms, 'src/index.ts', cwd)).toBe(true);
    expect(isPathAllowed(perms, 'package.json', cwd)).toBe(true);
    expect(isPathAllowed(perms, 'README.md', cwd)).toBe(true);
  });
});

describe('glob edge cases', () => {
  const cwd = '/tmp/test-project';

  it('exact filename match in deniedPaths', () => {
    const perms = {
      workerName: 'w1',
      allowedPaths: [],
      deniedPaths: ['Makefile'],
      allowedCommands: [],
      maxFileSize: Infinity,
    };
    expect(isPathAllowed(perms, 'Makefile', cwd)).toBe(false);
    expect(isPathAllowed(perms, 'src/Makefile', cwd)).toBe(true); // not recursive
  });

  it('single star does not cross directories', () => {
    const perms = {
      workerName: 'w1',
      allowedPaths: ['src/*.ts'],
      deniedPaths: [],
      allowedCommands: [],
      maxFileSize: Infinity,
    };
    expect(isPathAllowed(perms, 'src/index.ts', cwd)).toBe(true);
    expect(isPathAllowed(perms, 'src/deep/index.ts', cwd)).toBe(false);
  });

  it('double star matches any depth', () => {
    const perms = {
      workerName: 'w1',
      allowedPaths: ['src/**'],
      deniedPaths: [],
      allowedCommands: [],
      maxFileSize: Infinity,
    };
    expect(isPathAllowed(perms, 'src/index.ts', cwd)).toBe(true);
    expect(isPathAllowed(perms, 'src/deep/nested/file.ts', cwd)).toBe(true);
  });

  it('question mark matches single non-slash character', () => {
    const perms = {
      workerName: 'w1',
      allowedPaths: ['src/?.ts'],
      deniedPaths: [],
      allowedCommands: [],
      maxFileSize: Infinity,
    };
    expect(isPathAllowed(perms, 'src/a.ts', cwd)).toBe(true);
    expect(isPathAllowed(perms, 'src/ab.ts', cwd)).toBe(false);
  });
});
