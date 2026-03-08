import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processHook, resetSkipHooksCache, type HookInput } from '../bridge.js';

// Mock the background-tasks module
vi.mock('../../hud/background-tasks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hud/background-tasks.js')>();
  return {
    ...actual,
    getRunningTaskCount: vi.fn().mockReturnValue(0),
    addBackgroundTask: vi.fn().mockReturnValue(true),
    completeBackgroundTask: vi.fn().mockReturnValue(true),
  };
});

// Mock the config loader
vi.mock('../../config/loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/loader.js')>();
  return {
    ...actual,
    loadConfig: vi.fn().mockReturnValue({
      permissions: { maxBackgroundTasks: 5 },
    }),
  };
});

import { getRunningTaskCount } from '../../hud/background-tasks.js';
import { loadConfig } from '../../config/loader.js';

const mockedGetRunningTaskCount = vi.mocked(getRunningTaskCount);
const mockedLoadConfig = vi.mocked(loadConfig);

describe('Background Process Guard (issue #302)', () => {
  const originalEnv = process.env;
  let claudeConfigDir: string;

  const writeClaudePermissions = (allow: string[] = []): void => {
    const settingsPath = join(claudeConfigDir, 'settings.local.json');
    mkdirSync(claudeConfigDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ permissions: { allow } }, null, 2));
  };

  beforeEach(() => {
    claudeConfigDir = mkdtempSync(join(tmpdir(), 'omc-bg-perms-'));
    process.env = { ...originalEnv, CLAUDE_CONFIG_DIR: claudeConfigDir };
    delete process.env.DISABLE_OMC;
    delete process.env.OMC_SKIP_HOOKS;
    resetSkipHooksCache();
    vi.clearAllMocks();
    mockedGetRunningTaskCount.mockReturnValue(0);
    mockedLoadConfig.mockReturnValue({
      permissions: { maxBackgroundTasks: 5 },
    } as ReturnType<typeof loadConfig>);
    writeClaudePermissions();
  });

  afterEach(() => {
    rmSync(claudeConfigDir, { recursive: true, force: true });
    process.env = originalEnv;
    resetSkipHooksCache();
  });

  describe('Task tool with run_in_background=true', () => {
    it('should allow background Task when under limit', async () => {
      writeClaudePermissions(['Edit', 'Write']);
      mockedGetRunningTaskCount.mockReturnValue(2);

      const input: HookInput = {
        sessionId: 'test-session',
        toolName: 'Task',
        toolInput: {
          description: 'test task',
          subagent_type: 'executor',
          run_in_background: true,
        },
        directory: '/tmp/test',
      };

      const result = await processHook('pre-tool-use', input);
      expect(result.continue).toBe(true);
    });

    it('should block background Task when at limit', async () => {
      writeClaudePermissions(['Edit', 'Write']);
      mockedGetRunningTaskCount.mockReturnValue(5);

      const input: HookInput = {
        sessionId: 'test-session',
        toolName: 'Task',
        toolInput: {
          description: 'test task',
          subagent_type: 'executor',
          run_in_background: true,
        },
        directory: '/tmp/test',
      };

      const result = await processHook('pre-tool-use', input);
      expect(result.continue).toBe(false);
      expect(result.reason).toContain('Background process limit reached');
      expect(result.reason).toContain('5/5');
    });

    it('should block background Task when over limit', async () => {
      writeClaudePermissions(['Edit', 'Write']);
      mockedGetRunningTaskCount.mockReturnValue(8);

      const input: HookInput = {
        sessionId: 'test-session',
        toolName: 'Task',
        toolInput: {
          description: 'test task',
          subagent_type: 'executor',
          run_in_background: true,
        },
        directory: '/tmp/test',
      };

      const result = await processHook('pre-tool-use', input);
      expect(result.continue).toBe(false);
      expect(result.reason).toContain('Background process limit reached');
    });

    it('should allow foreground Task (no run_in_background)', async () => {
      mockedGetRunningTaskCount.mockReturnValue(10);

      const input: HookInput = {
        sessionId: 'test-session',
        toolName: 'Task',
        toolInput: {
          description: 'test task',
          subagent_type: 'executor',
        },
        directory: '/tmp/test',
      };

      const result = await processHook('pre-tool-use', input);
      expect(result.continue).toBe(true);
    });

    it('should block executor background Task when Edit/Write are not pre-approved', async () => {
      const input: HookInput = {
        sessionId: 'test-session',
        toolName: 'Task',
        toolInput: {
          description: 'fix the bug',
          subagent_type: 'executor',
          run_in_background: true,
        },
        directory: '/tmp/test',
      };

      const result = await processHook('pre-tool-use', input);
      expect(result.continue).toBe(false);
      expect(result.reason).toContain('[BACKGROUND PERMISSIONS]');
      expect(result.reason).toContain('Edit, Write');
      expect(result.modifiedInput).toBeUndefined();
    });

    it('should keep read-only background Task in background without Edit/Write approvals', async () => {
      const input: HookInput = {
        sessionId: 'test-session',
        toolName: 'Task',
        toolInput: {
          description: 'inspect code',
          subagent_type: 'explore',
          run_in_background: true,
        },
        directory: '/tmp/test',
      };

      const result = await processHook('pre-tool-use', input);
      expect(result.continue).toBe(true);
      expect(result.message ?? '').not.toContain('[BACKGROUND PERMISSIONS]');
      expect(result.modifiedInput).toBeUndefined();
    });

    it('should keep executor background Task when Edit/Write are pre-approved', async () => {
      writeClaudePermissions(['Edit', 'Write']);

      const input: HookInput = {
        sessionId: 'test-session',
        toolName: 'Task',
        toolInput: {
          description: 'fix the bug',
          subagent_type: 'executor',
          run_in_background: true,
        },
        directory: '/tmp/test',
      };

      const result = await processHook('pre-tool-use', input);
      expect(result.continue).toBe(true);
      expect(result.message ?? '').not.toContain('[BACKGROUND PERMISSIONS]');
      expect(result.modifiedInput).toBeUndefined();
    });
  });

  describe('Bash tool with run_in_background=true', () => {
    it('should block background Bash when at limit', async () => {
      mockedGetRunningTaskCount.mockReturnValue(5);

      const input: HookInput = {
        sessionId: 'test-session',
        toolName: 'Bash',
        toolInput: {
          command: 'npm test',
          run_in_background: true,
        },
        directory: '/tmp/test',
      };

      const result = await processHook('pre-tool-use', input);
      expect(result.continue).toBe(false);
      expect(result.reason).toContain('Background process limit reached');
    });

    it('should allow foreground Bash even when at limit', async () => {
      mockedGetRunningTaskCount.mockReturnValue(10);

      const input: HookInput = {
        sessionId: 'test-session',
        toolName: 'Bash',
        toolInput: {
          command: 'npm test',
        },
        directory: '/tmp/test',
      };

      const result = await processHook('pre-tool-use', input);
      expect(result.continue).toBe(true);
    });

    it('should block unsafe background Bash when not pre-approved', async () => {
      const input: HookInput = {
        sessionId: 'test-session',
        toolName: 'Bash',
        toolInput: {
          command: 'rm -rf ./tmp-build',
          run_in_background: true,
        },
        directory: '/tmp/test',
      };

      const result = await processHook('pre-tool-use', input);
      expect(result.continue).toBe(false);
      expect(result.reason).toContain('[BACKGROUND PERMISSIONS]');
      expect(result.modifiedInput).toBeUndefined();
    });

    it('should keep safe background Bash commands in background', async () => {
      const input: HookInput = {
        sessionId: 'test-session',
        toolName: 'Bash',
        toolInput: {
          command: 'npm test',
          run_in_background: true,
        },
        directory: '/tmp/test',
      };

      const result = await processHook('pre-tool-use', input);
      expect(result.continue).toBe(true);
      expect(result.message ?? '').not.toContain('[BACKGROUND PERMISSIONS]');
      expect(result.modifiedInput).toBeUndefined();
    });

    it('should keep exact pre-approved background Bash commands in background', async () => {
      writeClaudePermissions(['Bash(rm -rf ./tmp-build)']);

      const input: HookInput = {
        sessionId: 'test-session',
        toolName: 'Bash',
        toolInput: {
          command: 'rm -rf ./tmp-build',
          run_in_background: true,
        },
        directory: '/tmp/test',
      };

      const result = await processHook('pre-tool-use', input);
      expect(result.continue).toBe(true);
      expect(result.message ?? '').not.toContain('[BACKGROUND PERMISSIONS]');
      expect(result.modifiedInput).toBeUndefined();
    });
  });

  describe('configurable limits', () => {
    it('should respect custom maxBackgroundTasks from config', async () => {
      mockedLoadConfig.mockReturnValue({
        permissions: { maxBackgroundTasks: 3 },
      } as ReturnType<typeof loadConfig>);
      mockedGetRunningTaskCount.mockReturnValue(3);

      const input: HookInput = {
        sessionId: 'test-session',
        toolName: 'Task',
        toolInput: {
          description: 'test task',
          run_in_background: true,
        },
        directory: '/tmp/test',
      };

      const result = await processHook('pre-tool-use', input);
      expect(result.continue).toBe(false);
      expect(result.reason).toContain('3/3');
    });

    it('should allow up to limit - 1 tasks', async () => {
      mockedLoadConfig.mockReturnValue({
        permissions: { maxBackgroundTasks: 3 },
      } as ReturnType<typeof loadConfig>);
      mockedGetRunningTaskCount.mockReturnValue(2);

      const input: HookInput = {
        sessionId: 'test-session',
        toolName: 'Task',
        toolInput: {
          description: 'test task',
          run_in_background: true,
        },
        directory: '/tmp/test',
      };

      const result = await processHook('pre-tool-use', input);
      expect(result.continue).toBe(true);
    });

    it('should default to 5 when config has no maxBackgroundTasks', async () => {
      mockedLoadConfig.mockReturnValue({
        permissions: {},
      } as ReturnType<typeof loadConfig>);
      mockedGetRunningTaskCount.mockReturnValue(5);

      const input: HookInput = {
        sessionId: 'test-session',
        toolName: 'Task',
        toolInput: {
          description: 'test task',
          run_in_background: true,
        },
        directory: '/tmp/test',
      };

      const result = await processHook('pre-tool-use', input);
      expect(result.continue).toBe(false);
      expect(result.reason).toContain('5/5');
    });
  });

  describe('non-background tools unaffected', () => {
    it('should not block Read tool', async () => {
      mockedGetRunningTaskCount.mockReturnValue(100);

      const input: HookInput = {
        sessionId: 'test-session',
        toolName: 'Read',
        toolInput: { file_path: '/test/file.ts' },
        directory: '/tmp/test',
      };

      const result = await processHook('pre-tool-use', input);
      expect(result.continue).toBe(true);
    });

    it('should not block Write tool', async () => {
      mockedGetRunningTaskCount.mockReturnValue(100);

      const input: HookInput = {
        sessionId: 'test-session',
        toolName: 'Write',
        toolInput: { file_path: '/test/file.ts', content: 'test' },
        directory: '/tmp/test',
      };

      const result = await processHook('pre-tool-use', input);
      expect(result.continue).toBe(true);
    });
  });
});
