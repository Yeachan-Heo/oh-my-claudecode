import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
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

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { install, isProjectScopedPlugin, checkNodeVersion } from '../installer/index.js';
import * as hooksModule from '../installer/hooks.js';
import {
  reconcileUpdateRuntime,
  performUpdate,
} from '../features/auto-update.js';

const mockedExecSync = vi.mocked(execSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedMkdirSync = vi.mocked(mkdirSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedInstall = vi.mocked(install);
const mockedIsProjectScopedPlugin = vi.mocked(isProjectScopedPlugin);
const mockedCheckNodeVersion = vi.mocked(checkNodeVersion);

describe('auto-update reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedIsProjectScopedPlugin.mockReturnValue(false);
    mockedReadFileSync.mockImplementation((path: Parameters<typeof readFileSync>[0]) => {
      if (String(path).includes('.omc-version.json')) {
        return JSON.stringify({
          version: '4.1.5',
          installedAt: '2026-02-09T00:00:00.000Z',
          installMethod: 'npm',
        });
      }
      return '';
    });
    mockedCheckNodeVersion.mockReturnValue({
      valid: true,
      current: 20,
      required: 20,
    });
    mockedInstall.mockReturnValue({
      success: true,
      message: 'ok',
      installedAgents: [],
      installedCommands: [],
      installedSkills: [],
      hooksConfigured: true,
      hookConflicts: [],
      errors: [],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reconciles runtime state and refreshes hooks after update', () => {
    mockedExistsSync.mockReturnValue(false);

    const result = reconcileUpdateRuntime({ verbose: false });

    expect(result.success).toBe(true);
    expect(mockedMkdirSync).toHaveBeenCalledWith('/tmp/omc-test-hooks', { recursive: true });
    expect(mockedInstall).toHaveBeenCalledWith({
      force: true,
      verbose: false,
      skipClaudeCheck: true,
      forceHooks: true,
      refreshHooksInPlugin: true,
    });
  });

  it('skips hooks directory prep in project-scoped plugin reconciliation', () => {
    mockedIsProjectScopedPlugin.mockReturnValue(true);

    const result = reconcileUpdateRuntime({ verbose: false });

    expect(result.success).toBe(true);
    expect(mockedMkdirSync).not.toHaveBeenCalled();
    expect(mockedInstall).toHaveBeenCalledWith({
      force: true,
      verbose: false,
      skipClaudeCheck: true,
      forceHooks: true,
      refreshHooksInPlugin: false,
    });
  });

  it('is idempotent when reconciliation runs repeatedly', () => {
    const first = reconcileUpdateRuntime({ verbose: false });
    const second = reconcileUpdateRuntime({ verbose: false });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(mockedInstall).toHaveBeenNthCalledWith(1, {
      force: true,
      verbose: false,
      skipClaudeCheck: true,
      forceHooks: true,
      refreshHooksInPlugin: true,
    });
    expect(mockedInstall).toHaveBeenNthCalledWith(2, {
      force: true,
      verbose: false,
      skipClaudeCheck: true,
      forceHooks: true,
      refreshHooksInPlugin: true,
    });
  });

  it('runs reconciliation as part of performUpdate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: 'v4.1.5',
        name: '4.1.5',
        published_at: '2026-02-09T00:00:00.000Z',
        html_url: 'https://example.com/release',
        body: 'notes',
        prerelease: false,
        draft: false,
      }),
    }));

    mockedExecSync.mockReturnValue('');

    const result = await performUpdate({ verbose: false });

    expect(result.success).toBe(true);
    expect(mockedExecSync).toHaveBeenCalledWith('npm install -g oh-my-claude-sisyphus@latest', expect.any(Object));
    expect(mockedInstall).toHaveBeenCalledWith({
      force: true,
      verbose: false,
      skipClaudeCheck: true,
      forceHooks: true,
      refreshHooksInPlugin: true,
    });
  });

  it('does not persist metadata when reconciliation fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: 'v4.1.5',
        name: '4.1.5',
        published_at: '2026-02-09T00:00:00.000Z',
        html_url: 'https://example.com/release',
        body: 'notes',
        prerelease: false,
        draft: false,
      }),
    }));

    mockedExecSync.mockReturnValue('');
    mockedInstall.mockReturnValue({
      success: false,
      message: 'fail',
      installedAgents: [],
      installedCommands: [],
      installedSkills: [],
      hooksConfigured: false,
      hookConflicts: [],
      errors: ['boom'],
    });

    const result = await performUpdate({ verbose: false });

    expect(result.success).toBe(false);
    expect(result.errors).toEqual(['boom']);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it('preserves non-OMC hooks when refreshing plugin hooks during reconciliation', () => {
    const existingSettings = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: 'node $HOME/.claude/hooks/other-plugin.mjs',
              },
            ],
          },
        ],
      },
    };

    const settingsPath = join(homedir(), '.claude', 'settings.json');
    const baseHooks = hooksModule.getHooksSettingsConfig();
    const freshHooks = {
      ...baseHooks,
      hooks: {
        ...baseHooks.hooks,
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command' as const,
                command: 'node $HOME/.claude/hooks/keyword-detector.mjs',
              },
            ],
          },
        ],
      },
    };

    mockedExistsSync.mockImplementation((path) => {
      const normalized = String(path).replace(/\\/g, '/');
      if (normalized === settingsPath) {
        return true;
      }
      if (normalized.endsWith('/.claude/hud')) {
        return false;
      }
      if (normalized.includes('/hooks/')) {
        return false;
      }
      return true;
    });
    mockedIsProjectScopedPlugin.mockReturnValue(false);

    mockedReadFileSync.mockImplementation((path: Parameters<typeof readFileSync>[0]) => {
      if (String(path) === settingsPath) {
        return JSON.stringify(existingSettings);
      }
      if (String(path).includes('/hooks/')) {
        return 'hook-script';
      }
      return '';
    });

    vi.spyOn(hooksModule, 'getHooksSettingsConfig').mockReturnValue(freshHooks);

    const originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = join(homedir(), '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.1.5');

    const result = install({
      force: true,
      skipClaudeCheck: true,
      refreshHooksInPlugin: true,
    });

    if (originalPluginRoot !== undefined) {
      process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
    } else {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    }

    const settingsWrite = mockedWriteFileSync.mock.calls.find((call) => String(call[0]).includes('settings.json'));
    if (settingsWrite) {
      const writtenSettings = JSON.parse(String(settingsWrite[1]));
      expect(writtenSettings.hooks.UserPromptSubmit[0].hooks[0].command).toBe('node $HOME/.claude/hooks/other-plugin.mjs');
    }
    expect(result.hooksConfigured).toBe(true);
  });
});
