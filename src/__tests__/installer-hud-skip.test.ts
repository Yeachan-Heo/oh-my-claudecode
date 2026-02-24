import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

import { existsSync, readFileSync } from 'fs';
import { isHudEnabledInConfig, isOmcStatusLine, CLAUDE_CONFIG_DIR } from '../installer/index.js';
import type { InstallOptions } from '../installer/index.js';
import { join } from 'path';

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);

describe('isHudEnabledInConfig', () => {
  const configPath = join(CLAUDE_CONFIG_DIR, '.omc-config.json');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return true when config file does not exist', () => {
    mockedExistsSync.mockReturnValue(false);

    expect(isHudEnabledInConfig()).toBe(true);
    expect(mockedExistsSync).toHaveBeenCalledWith(configPath);
  });

  it('should return true when hudEnabled is not set in config', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({ silentAutoUpdate: false }));

    expect(isHudEnabledInConfig()).toBe(true);
  });

  it('should return true when hudEnabled is explicitly true', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({ silentAutoUpdate: false, hudEnabled: true }));

    expect(isHudEnabledInConfig()).toBe(true);
  });

  it('should return false when hudEnabled is explicitly false', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({ silentAutoUpdate: false, hudEnabled: false }));

    expect(isHudEnabledInConfig()).toBe(false);
  });

  it('should return true when config file has invalid JSON', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('not valid json');

    expect(isHudEnabledInConfig()).toBe(true);
  });

  it('should return true when readFileSync throws', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error('read error');
    });

    expect(isHudEnabledInConfig()).toBe(true);
  });
});

describe('InstallOptions skipHud', () => {
  it('should accept skipHud as a valid option', () => {
    const opts: InstallOptions = { skipHud: true };
    expect(opts.skipHud).toBe(true);
  });

  it('should accept skipHud as false', () => {
    const opts: InstallOptions = { skipHud: false };
    expect(opts.skipHud).toBe(false);
  });

  it('should accept skipHud as undefined (default)', () => {
    const opts: InstallOptions = {};
    expect(opts.skipHud).toBeUndefined();
  });
});

describe('isOmcStatusLine', () => {
  it('should return true for OMC HUD statusLine', () => {
    expect(isOmcStatusLine({
      type: 'command',
      command: 'node /home/user/.claude/hud/omc-hud.mjs'
    })).toBe(true);
  });

  it('should return true for any command containing omc-hud', () => {
    expect(isOmcStatusLine({
      type: 'command',
      command: '/usr/local/bin/node /some/path/omc-hud.mjs'
    })).toBe(true);
  });

  it('should return false for custom statusLine', () => {
    expect(isOmcStatusLine({
      type: 'command',
      command: 'my-custom-statusline --fancy'
    })).toBe(false);
  });

  it('should return false for null', () => {
    expect(isOmcStatusLine(null)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isOmcStatusLine(undefined)).toBe(false);
  });

  // Legacy string format tests (pre-v4.5 compatibility)
  it('should return true for legacy string containing omc-hud', () => {
    expect(isOmcStatusLine('~/.claude/hud/omc-hud.mjs')).toBe(true);
  });

  it('should return true for legacy string with absolute path to omc-hud', () => {
    expect(isOmcStatusLine('/home/user/.claude/hud/omc-hud.mjs')).toBe(true);
  });

  it('should return false for non-OMC string', () => {
    expect(isOmcStatusLine('my-custom-statusline')).toBe(false);
  });

  it('should return false for empty string', () => {
    expect(isOmcStatusLine('')).toBe(false);
  });

  it('should return false for object without command', () => {
    expect(isOmcStatusLine({ type: 'command' })).toBe(false);
  });

  it('should return false for object with non-string command', () => {
    expect(isOmcStatusLine({ type: 'command', command: 42 })).toBe(false);
  });
});
