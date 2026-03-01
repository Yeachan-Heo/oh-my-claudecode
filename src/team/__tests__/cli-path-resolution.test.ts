import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolvedEnv: vi.fn<() => NodeJS.ProcessEnv>(() => ({ PATH: '/usr/local/bin:/usr/bin' })),
  spawnSync: vi.fn(),
}));

vi.mock('../shell-path.js', () => ({
  resolvedEnv: mocks.resolvedEnv,
}));

vi.mock('child_process', () => ({
  spawnSync: mocks.spawnSync,
}));

import { resolveCliBinaryPath, clearResolvedPathCache, _testInternals } from '../model-contract.js';

describe('resolveCliBinaryPath', () => {
  beforeEach(() => {
    clearResolvedPathCache();
    mocks.spawnSync.mockReset();
    mocks.resolvedEnv.mockReset();
    mocks.resolvedEnv.mockReturnValue({ PATH: '/usr/local/bin:/usr/bin' });
  });

  it('resolves a binary to its absolute path via which', () => {
    mocks.spawnSync.mockReturnValue({
      status: 0,
      stdout: '/usr/local/bin/claude\n',
      stderr: '',
      pid: 0,
      output: [],
      signal: null,
    });

    const result = resolveCliBinaryPath('claude');
    expect(result).toBe('/usr/local/bin/claude');
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      'which',
      ['claude'],
      expect.objectContaining({ timeout: 5000, env: expect.any(Object) }),
    );
  });

  it('uses resolvedEnv() for PATH resolution', () => {
    const customEnv = { PATH: '/custom/bin:/usr/bin' };
    mocks.resolvedEnv.mockReturnValue(customEnv);
    mocks.spawnSync.mockReturnValue({
      status: 0,
      stdout: '/custom/bin/claude\n',
      stderr: '',
    });

    resolveCliBinaryPath('claude');
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      'which',
      ['claude'],
      expect.objectContaining({ env: customEnv }),
    );
  });

  it('caches resolved paths for subsequent calls', () => {
    mocks.spawnSync.mockReturnValue({
      status: 0,
      stdout: '/usr/local/bin/claude\n',
      stderr: '',
    });

    resolveCliBinaryPath('claude');
    resolveCliBinaryPath('claude');

    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
  });

  it('rejects binary names with path separators', () => {
    expect(() => resolveCliBinaryPath('../evil')).toThrow('Invalid CLI binary name');
    expect(() => resolveCliBinaryPath('foo/bar')).toThrow('Invalid CLI binary name');
    expect(() => resolveCliBinaryPath('foo\\bar')).toThrow('Invalid CLI binary name');
  });

  it('rejects binary names with shell metacharacters', () => {
    expect(() => resolveCliBinaryPath('claude;rm -rf /')).toThrow('Invalid CLI binary name');
    expect(() => resolveCliBinaryPath('claude|cat')).toThrow('Invalid CLI binary name');
    expect(() => resolveCliBinaryPath('claude&bg')).toThrow('Invalid CLI binary name');
    expect(() => resolveCliBinaryPath('$(whoami)')).toThrow('Invalid CLI binary name');
    expect(() => resolveCliBinaryPath('`whoami`')).toThrow('Invalid CLI binary name');
    expect(() => resolveCliBinaryPath("claude'inject")).toThrow('Invalid CLI binary name');
    expect(() => resolveCliBinaryPath('claude"inject')).toThrow('Invalid CLI binary name');
  });

  it('rejects binary names with whitespace', () => {
    expect(() => resolveCliBinaryPath('claude code')).toThrow('Invalid CLI binary name');
    expect(() => resolveCliBinaryPath('claude\tcode')).toThrow('Invalid CLI binary name');
  });

  it('throws when binary is not found in PATH', () => {
    mocks.spawnSync.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'not found',
    });

    expect(() => resolveCliBinaryPath('nonexistent')).toThrow('not found in PATH');
  });

  it('throws when which returns empty stdout', () => {
    mocks.spawnSync.mockReturnValue({
      status: 0,
      stdout: '  \n',
      stderr: '',
    });

    expect(() => resolveCliBinaryPath('empty')).toThrow('not found in PATH');
  });

  it('rejects paths in /tmp', () => {
    mocks.spawnSync.mockReturnValue({
      status: 0,
      stdout: '/tmp/evil/claude\n',
      stderr: '',
    });

    expect(() => resolveCliBinaryPath('claude')).toThrow('untrusted location');
  });

  it('rejects paths in /var/tmp', () => {
    mocks.spawnSync.mockReturnValue({
      status: 0,
      stdout: '/var/tmp/malicious/codex\n',
      stderr: '',
    });

    expect(() => resolveCliBinaryPath('codex')).toThrow('untrusted location');
  });

  it('rejects paths in /dev/shm', () => {
    mocks.spawnSync.mockReturnValue({
      status: 0,
      stdout: '/dev/shm/codex\n',
      stderr: '',
    });

    expect(() => resolveCliBinaryPath('codex')).toThrow('untrusted location');
  });

  it('rejects non-absolute resolved paths', () => {
    mocks.spawnSync.mockReturnValue({
      status: 0,
      stdout: 'relative/path/claude\n',
      stderr: '',
    });

    expect(() => resolveCliBinaryPath('claude')).toThrow('relative path');
  });

  it('accepts paths in /usr/local/bin without warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.spawnSync.mockReturnValue({
      status: 0,
      stdout: '/usr/local/bin/claude\n',
      stderr: '',
    });

    const result = resolveCliBinaryPath('claude');
    expect(result).toBe('/usr/local/bin/claude');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('accepts paths in /usr/bin without warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.spawnSync.mockReturnValue({
      status: 0,
      stdout: '/usr/bin/codex\n',
      stderr: '',
    });

    const result = resolveCliBinaryPath('codex');
    expect(result).toBe('/usr/bin/codex');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('accepts paths in user nvm directory without warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const home = process.env.HOME || '/home/test';
    mocks.spawnSync.mockReturnValue({
      status: 0,
      stdout: `${home}/.nvm/versions/node/v20/bin/codex\n`,
      stderr: '',
    });

    const result = resolveCliBinaryPath('codex');
    expect(result).toBe(`${home}/.nvm/versions/node/v20/bin/codex`);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('accepts paths in /opt/homebrew without warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.spawnSync.mockReturnValue({
      status: 0,
      stdout: '/opt/homebrew/bin/claude\n',
      stderr: '',
    });

    const result = resolveCliBinaryPath('claude');
    expect(result).toBe('/opt/homebrew/bin/claude');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('warns for paths outside standard directories but still resolves', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.spawnSync.mockReturnValue({
      status: 0,
      stdout: '/unusual/location/claude\n',
      stderr: '',
    });

    const result = resolveCliBinaryPath('claude');
    expect(result).toBe('/unusual/location/claude');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[omc:cli-security]'),
    );
    warnSpy.mockRestore();
  });

  it('respects OMC_TRUSTED_CLI_DIRS for custom trusted directories', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const origEnv = process.env.OMC_TRUSTED_CLI_DIRS;
    process.env.OMC_TRUSTED_CLI_DIRS = '/custom/tools/bin';

    mocks.spawnSync.mockReturnValue({
      status: 0,
      stdout: '/custom/tools/bin/claude\n',
      stderr: '',
    });

    try {
      const result = resolveCliBinaryPath('claude');
      expect(result).toBe('/custom/tools/bin/claude');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      if (origEnv === undefined) delete process.env.OMC_TRUSTED_CLI_DIRS;
      else process.env.OMC_TRUSTED_CLI_DIRS = origEnv;
      warnSpy.mockRestore();
    }
  });

  it('ignores relative paths in OMC_TRUSTED_CLI_DIRS', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const origEnv = process.env.OMC_TRUSTED_CLI_DIRS;
    process.env.OMC_TRUSTED_CLI_DIRS = 'relative/path';

    mocks.spawnSync.mockReturnValue({
      status: 0,
      stdout: '/unusual/location/claude\n',
      stderr: '',
    });

    try {
      resolveCliBinaryPath('claude');
      // Should still warn since the relative trusted dir is ignored
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      if (origEnv === undefined) delete process.env.OMC_TRUSTED_CLI_DIRS;
      else process.env.OMC_TRUSTED_CLI_DIRS = origEnv;
      warnSpy.mockRestore();
    }
  });

  it('clearResolvedPathCache resets the cache', () => {
    mocks.spawnSync.mockReturnValue({
      status: 0,
      stdout: '/usr/local/bin/claude\n',
      stderr: '',
    });

    resolveCliBinaryPath('claude');
    clearResolvedPathCache();
    resolveCliBinaryPath('claude');

    expect(mocks.spawnSync).toHaveBeenCalledTimes(2);
  });

  it('takes first result when which returns multiple lines', () => {
    mocks.spawnSync.mockReturnValue({
      status: 0,
      stdout: '/usr/local/bin/claude\n/usr/bin/claude\n',
      stderr: '',
    });

    expect(resolveCliBinaryPath('claude')).toBe('/usr/local/bin/claude');
  });

  it('normalizes paths with redundant separators', () => {
    mocks.spawnSync.mockReturnValue({
      status: 0,
      stdout: '/usr/local//bin/claude\n',
      stderr: '',
    });

    expect(resolveCliBinaryPath('claude')).toBe('/usr/local/bin/claude');
  });

  it('handles spawnSync throwing an exception', () => {
    mocks.spawnSync.mockImplementation(() => { throw new Error('spawn failed'); });

    expect(() => resolveCliBinaryPath('claude')).toThrow();
  });
});

describe('_testInternals', () => {
  it('UNTRUSTED_PATH_PATTERNS reject expected directories', () => {
    const { UNTRUSTED_PATH_PATTERNS } = _testInternals;
    expect(UNTRUSTED_PATH_PATTERNS.some(p => p.test('/tmp/evil'))).toBe(true);
    expect(UNTRUSTED_PATH_PATTERNS.some(p => p.test('/var/tmp/evil'))).toBe(true);
    expect(UNTRUSTED_PATH_PATTERNS.some(p => p.test('/dev/shm/evil'))).toBe(true);
    expect(UNTRUSTED_PATH_PATTERNS.some(p => p.test('/usr/local/bin/claude'))).toBe(false);
  });

  it('getTrustedPrefixes includes system directories', () => {
    const prefixes = _testInternals.getTrustedPrefixes();
    expect(prefixes).toContain('/usr/local/bin');
    expect(prefixes).toContain('/usr/bin');
    expect(prefixes).toContain('/opt/homebrew/');
  });

  it('getTrustedPrefixes includes user-local directories when HOME is set', () => {
    const home = process.env.HOME;
    if (!home) return; // Skip if HOME is not set

    const prefixes = _testInternals.getTrustedPrefixes();
    expect(prefixes).toContain(`${home}/.local/bin`);
    expect(prefixes).toContain(`${home}/.nvm/`);
    expect(prefixes).toContain(`${home}/.cargo/bin`);
  });
});
