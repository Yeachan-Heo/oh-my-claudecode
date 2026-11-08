import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execSync: vi.fn(),
}));

vi.mock('../installer/index.js', async () => {
  const actual = await vi.importActual<typeof import('../installer/index.js')>('../installer/index.js');
  return {
    ...actual,
    install: vi.fn(),
    HOOKS_DIR: '/tmp/omc-test-hooks',
    isProjectScopedPlugin: vi.fn(),
    checkNodeVersion: vi.fn(),
  };
});

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

import { existsSync, readFileSync } from 'fs';
import {
  getOMCConfig,
  isAutoUpgradePromptEnabled,
  isSilentAutoUpdateEnabled,
} from '../features/auto-update.js';

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);

describe('auto-upgrade prompt config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults autoUpgradePrompt to true when config file does not exist', () => {
    mockedExistsSync.mockReturnValue(false);

    const config = getOMCConfig();
    expect(config.autoUpgradePrompt).toBeUndefined();
    expect(isAutoUpgradePromptEnabled()).toBe(true);
  });

  it('defaults autoUpgradePrompt to true when field is not set in config', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      silentAutoUpdate: false,
    }));

    const config = getOMCConfig();
    expect(config.autoUpgradePrompt).toBeUndefined();
    expect(isAutoUpgradePromptEnabled()).toBe(true);
  });

  it('returns true when autoUpgradePrompt is explicitly true', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      silentAutoUpdate: false,
      autoUpgradePrompt: true,
    }));

    expect(isAutoUpgradePromptEnabled()).toBe(true);
    expect(getOMCConfig().autoUpgradePrompt).toBe(true);
  });

  it('returns false when autoUpgradePrompt is explicitly false', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      silentAutoUpdate: false,
      autoUpgradePrompt: false,
    }));

    expect(isAutoUpgradePromptEnabled()).toBe(false);
    expect(getOMCConfig().autoUpgradePrompt).toBe(false);
  });

  it('autoUpgradePrompt and silentAutoUpdate are independent', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      silentAutoUpdate: true,
      autoUpgradePrompt: false,
    }));

    expect(isSilentAutoUpdateEnabled()).toBe(true);
    expect(isAutoUpgradePromptEnabled()).toBe(false);
  });

  it('defaults to true when config file is invalid JSON', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('not valid json');

    expect(isAutoUpgradePromptEnabled()).toBe(true);
  });

  it('silentAutoUpdate blocked by security config (OMC_SECURITY=strict)', async () => {
    // When security config disables auto-update, silentAutoUpdate=true is overridden
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      silentAutoUpdate: true,
    }));

    const originalSecurity = process.env.OMC_SECURITY;
    process.env.OMC_SECURITY = 'strict';
    const { clearSecurityConfigCache } = await import('../lib/security-config.js');
    clearSecurityConfigCache();

    expect(isSilentAutoUpdateEnabled()).toBe(false);

    // Cleanup
    if (originalSecurity === undefined) {
      delete process.env.OMC_SECURITY;
    } else {
      process.env.OMC_SECURITY = originalSecurity;
    }
    clearSecurityConfigCache();
  });
});

describe('claudeMdEnabled config passthrough', () => {
  const originalEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    OMC_CLI_SKIP_PARSE: process.env.OMC_CLI_SKIP_PARSE,
  };
  let tempHome: string;
  let configDir: string;

  /** Fresh module graph on the real fs, so CONFIG_FILE resolves under the temp CLAUDE_CONFIG_DIR. */
  async function loadReal() {
    vi.doUnmock('fs');
    vi.resetModules();
    const actualFs = await import('fs');
    const autoUpdate = await import('../features/auto-update.js');
    return { actualFs, autoUpdate };
  }

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'omc-claude-md-enabled-'));
    configDir = join(tempHome, '.claude');
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    // Importing src/cli/index.ts must not auto-parse the test runner's argv.
    process.env.OMC_CLI_SKIP_PARSE = '1';
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('getOMCConfig returns claudeMdEnabled: false from the config file', async () => {
    const { actualFs, autoUpdate } = await loadReal();
    actualFs.mkdirSync(configDir, { recursive: true });
    actualFs.writeFileSync(autoUpdate.CONFIG_FILE, JSON.stringify({ silentAutoUpdate: false, claudeMdEnabled: false }));

    expect(autoUpdate.CONFIG_FILE.startsWith(tempHome)).toBe(true);
    expect(autoUpdate.getOMCConfig().claudeMdEnabled).toBe(false);
  });

  it.each([
    ['config-stop-callback file', ['config-stop-callback', 'file', '--enable', '--path', '/tmp/omc-stop-log.md']],
    ['config-stop-callback --profile', ['config-stop-callback', 'discord', '--profile', 'work', '--enable', '--webhook', 'https://discord.invalid/hook']],
  ])('keeps claudeMdEnabled: false when %s rewrites the config', async (_label, argv) => {
    const { actualFs, autoUpdate } = await loadReal();
    expect(autoUpdate.CONFIG_FILE.startsWith(tempHome)).toBe(true);
    actualFs.mkdirSync(configDir, { recursive: true });
    actualFs.writeFileSync(autoUpdate.CONFIG_FILE, JSON.stringify({ silentAutoUpdate: true, claudeMdEnabled: false }));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { buildProgram } = await import('../cli/index.js');
      await buildProgram().parseAsync(argv, { from: 'user' });
    } finally {
      logSpy.mockRestore();
    }

    const rewritten = JSON.parse(actualFs.readFileSync(autoUpdate.CONFIG_FILE, 'utf-8'));
    expect(rewritten.silentAutoUpdate).toBe(true);
    expect(rewritten.claudeMdEnabled).toBe(false);
    expect(rewritten.stopHookCallbacks ?? rewritten.notificationProfiles).toBeDefined();
  });
});
