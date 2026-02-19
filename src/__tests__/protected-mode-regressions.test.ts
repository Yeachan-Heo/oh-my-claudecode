import { describe, expect, it } from 'vitest';
import { findPermissionViolations, getEffectivePermissions, isPathAllowed } from '../team/permissions.js';

const cwd = '/tmp/protected-mode-project';

describe('Protected-mode regression: secure deny defaults', () => {
  it('cannot be bypassed by allow-all path grants', () => {
    const perms = getEffectivePermissions({
      workerName: 'worker-protected',
      allowedPaths: ['**'],
      deniedPaths: [],
      allowedCommands: [],
      maxFileSize: Infinity,
    });

    expect(isPathAllowed(perms, '.git/config', cwd)).toBe(false);
    expect(isPathAllowed(perms, '.env.local', cwd)).toBe(false);
    expect(isPathAllowed(perms, 'nested/secrets/token.txt', cwd)).toBe(false);
    expect(isPathAllowed(perms, 'src/index.ts', cwd)).toBe(true);
  });

  it('blocks traversal-style attempts into sensitive files', () => {
    const perms = getEffectivePermissions({ workerName: 'worker-protected' });

    expect(isPathAllowed(perms, 'src/../../.env', cwd)).toBe(false);
    expect(isPathAllowed(perms, '../outside.txt', cwd)).toBe(false);
  });

  it('reports secure deny violations even with permissive caller config', () => {
    const perms = getEffectivePermissions({
      workerName: 'worker-protected',
      allowedPaths: ['**'],
      deniedPaths: [],
      allowedCommands: [],
      maxFileSize: Infinity,
    });

    const violations = findPermissionViolations(
      ['src/app.ts', '.git/HEAD', 'config/.env.production', 'src/utils.ts'],
      perms,
      cwd
    );

    expect(violations.map(v => v.path)).toEqual(['.git/HEAD', 'config/.env.production']);
    expect(violations.every(v => /denied pattern/i.test(v.reason))).toBe(true);
  });
});
