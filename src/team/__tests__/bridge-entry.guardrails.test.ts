import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { validateConfigPath, isPathWithin } from '../bridge-entry.js';

describe('bridge-entry workdir guardrails (source contract)', () => {
  const source = readFileSync(join(__dirname, '..', 'bridge-entry.ts'), 'utf-8');

  it('requires working directory to exist and be a directory', () => {
    expect(source).toContain('statSync(workingDirectory)');
    expect(source).toContain('isDirectory()');
  });

  it('requires working directory to stay under home directory', () => {
    expect(source).toContain('realpathSync(workingDirectory)');
    expect(source).toContain('isPathWithin(resolved, home)');
  });

  it('requires working directory to be inside a git worktree', () => {
    expect(source).toContain('getWorktreeRoot(workingDirectory)');
    expect(source).toContain('workingDirectory is not inside a git worktree');
  });
});

describe('validateConfigPath guardrails', () => {
  const home = '/home/user';
  const claudeConfigDir = '/home/user/.claude';

  it('rejects path outside home', () => {
    expect(validateConfigPath('/tmp/.omc/config.json', home, claudeConfigDir)).toBe(false);
  });

  it('rejects path not under trusted subpaths', () => {
    expect(validateConfigPath('/home/user/project/config.json', home, claudeConfigDir)).toBe(false);
  });

  it('accepts trusted .omc path under home', () => {
    expect(validateConfigPath('/home/user/project/.omc/state/config.json', home, claudeConfigDir)).toBe(true);
  });
});

describe('isPathWithin (cross-platform separator handling)', () => {
  // Windows: resolve()/realpathSync() and homedir() return backslash paths.
  // The home-prefix containment check must still match, otherwise the bridge
  // daemon rejects its own config and working directory on Windows.
  it('matches a Windows path under a Windows home dir', () => {
    expect(isPathWithin('C:\\Users\\me\\proj\\.omc\\state\\cfg.json', 'C:\\Users\\me')).toBe(true);
  });

  it('matches the home dir itself (Windows)', () => {
    expect(isPathWithin('C:\\Users\\me', 'C:\\Users\\me')).toBe(true);
  });

  it('rejects a Windows sibling that only shares a name prefix', () => {
    // C:\Users\member must not be treated as under C:\Users\me
    expect(isPathWithin('C:\\Users\\member\\x', 'C:\\Users\\me')).toBe(false);
  });

  it('rejects a Windows path outside the home dir', () => {
    expect(isPathWithin('D:\\evil\\cfg.json', 'C:\\Users\\me')).toBe(false);
  });

  it('still works for POSIX paths', () => {
    expect(isPathWithin('/home/user/proj/.omc/cfg.json', '/home/user')).toBe(true);
    expect(isPathWithin('/home/user', '/home/user')).toBe(true);
    expect(isPathWithin('/tmp/x', '/home/user')).toBe(false);
    expect(isPathWithin('/home/username/x', '/home/user')).toBe(false);
  });
});

