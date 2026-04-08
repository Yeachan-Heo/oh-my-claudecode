import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
  };
});

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: vi.fn(),
  };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: vi.fn(() => '/home/tester'),
  };
});

import { existsSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { pickLatestVersion, resolveNodeBinary } from '../utils/resolve-node.js';

const mockedExistsSync = vi.mocked(existsSync);
const mockedReaddirSync = vi.mocked(readdirSync);
const mockedExecSync = vi.mocked(execSync);

const originalExecPath = process.execPath;

function setExecPath(value: string) {
  Object.defineProperty(process, 'execPath', {
    value,
    configurable: true,
    writable: true,
  });
}

describe('pickLatestVersion', () => {
  it('returns the highest semver from a list', () => {
    expect(pickLatestVersion(['v18.0.0', 'v20.11.0', 'v16.20.0'])).toBe('v20.11.0');
  });

  it('handles versions without leading v', () => {
    expect(pickLatestVersion(['18.0.0', '20.11.0', '16.20.0'])).toBe('20.11.0');
  });

  it('handles a single entry', () => {
    expect(pickLatestVersion(['v22.1.0'])).toBe('v22.1.0');
  });

  it('returns undefined for an empty array', () => {
    expect(pickLatestVersion([])).toBeUndefined();
  });

  it('filters out non-version entries', () => {
    expect(pickLatestVersion(['default', 'v18.0.0', 'system'])).toBe('v18.0.0');
  });

  it('compares patch versions correctly', () => {
    expect(pickLatestVersion(['v20.0.0', 'v20.0.1', 'v20.0.9'])).toBe('v20.0.9');
  });

  it('compares minor versions correctly', () => {
    expect(pickLatestVersion(['v20.1.0', 'v20.9.0', 'v20.10.0'])).toBe('v20.10.0');
  });
});

describe('resolveNodeBinary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setExecPath(originalExecPath);
    mockedExistsSync.mockReturnValue(false);
    mockedReaddirSync.mockReturnValue([] as any);
    mockedExecSync.mockImplementation(() => {
      throw new Error('node not on PATH');
    });
  });

  afterEach(() => {
    setExecPath(originalExecPath);
  });

  it('reproduces the prior bug: process.execPath would beat PATH node', () => {
    setExecPath('/opt/homebrew/Cellar/node/25.8.1_1/bin/node');

    mockedExecSync.mockReturnValue('/opt/homebrew/bin/node\n' as any);
    mockedExistsSync.mockImplementation((pathLike) => {
      const path = String(pathLike);
      return path === '/opt/homebrew/Cellar/node/25.8.1_1/bin/node' || path === '/opt/homebrew/bin/node';
    });

    const result = resolveNodeBinary();

    expect(result).toBe('/opt/homebrew/bin/node');
  });

  it('prefers PATH node over a Homebrew Cellar versioned process.execPath', () => {
    setExecPath('/opt/homebrew/Cellar/node/25.8.1_1/bin/node');

    mockedExecSync.mockReturnValue('/opt/homebrew/bin/node\n' as any);
    mockedExistsSync.mockImplementation((pathLike) => {
      const path = String(pathLike);
      return path === '/opt/homebrew/Cellar/node/25.8.1_1/bin/node' || path === '/opt/homebrew/bin/node';
    });

    expect(resolveNodeBinary()).toBe('/opt/homebrew/bin/node');
    expect(mockedExecSync).toHaveBeenCalledWith('which node', { encoding: 'utf-8', stdio: 'pipe' });
  });

  it('prefers PATH node over a CI-only hostedtoolcache process.execPath', () => {
    setExecPath('/opt/hostedtoolcache/node/20.20.2/x64/bin/node');

    mockedExecSync.mockReturnValue('/usr/local/bin/node\n' as any);
    mockedExistsSync.mockImplementation((pathLike) => {
      const path = String(pathLike);
      return path === '/opt/hostedtoolcache/node/20.20.2/x64/bin/node' || path === '/usr/local/bin/node';
    });

    expect(resolveNodeBinary()).toBe('/usr/local/bin/node');
  });

  it('falls back to process.execPath when PATH node is unavailable and execPath is usable', () => {
    setExecPath('/Users/tester/.nvm/versions/node/v22.0.0/bin/node');

    mockedExistsSync.mockImplementation((pathLike) => String(pathLike) === '/Users/tester/.nvm/versions/node/v22.0.0/bin/node');

    expect(resolveNodeBinary()).toBe('/Users/tester/.nvm/versions/node/v22.0.0/bin/node');
  });

  it('falls back to the latest nvm version when PATH node and process.execPath are unusable', () => {
    setExecPath('/opt/hostedtoolcache/node/20.20.2/x64/bin/node');

    mockedExistsSync.mockImplementation((pathLike) => {
      const path = String(pathLike);
      return path === '/home/tester/.nvm/versions/node' || path === '/home/tester/.nvm/versions/node/v22.3.0/bin/node';
    });
    mockedReaddirSync.mockReturnValue(['v20.11.0', 'v22.3.0'] as any);

    expect(resolveNodeBinary()).toBe('/home/tester/.nvm/versions/node/v22.3.0/bin/node');
  });

  it('returns bare node as a last resort', () => {
    setExecPath('/opt/hostedtoolcache/node/20.20.2/x64/bin/node');

    expect(resolveNodeBinary()).toBe('node');
  });
});
