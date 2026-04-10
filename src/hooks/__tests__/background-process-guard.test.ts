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
    completeMostRecentMatchingBackgroundTask: vi.fn().mockReturnValue(true),
    remapBackgroundTaskId: vi.fn().mockReturnValue(true),
    remapMostRecentMatchingBackgroundTaskId: vi.fn().mockReturnValue(true),
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

import {
  addBackgroundTask,
  completeBackgroundTask,
  completeMostRecentMatchingBackgroundTask,
  getRunningTaskCount,
  remapBackgroundTaskId,
  remapMostRecentMatchingBackgroundTaskId,
} from '../../hud/background-tasks.js';
import { loadConfig } from '../../config/loader.js';

const mockedAddBackgroundTask = vi.mocked(addBackgroundTask);
const mockedCompleteBackgroundTask = vi.mocked(completeBackgroundTask);
const mockedCompleteMostRecentMatchingBackgroundTask = vi.mocked(completeMostRecentMatchingBackgroundTask);
const mockedGetRunningTaskCount = vi.mocked(getRunningTaskCount);
const mockedRemapBackgroundTaskId = vi.mocked(remapBackgroundTaskId);
const mockedRemapMostRecentMatchingBackgroundTaskId = vi.mocked(remapMostRecentMatchingBackgroundTaskId);
const mockedLoadConfig = vi.mocked(loadConfig);

describe('Background Process Guard (issue #302)', () => {
  const originalEnv = process.env;
  const resolvedDirectory = process.cwd();
  let claudeConfigDir: string;

  const writeClaudePermissions = (allow: string[] = [], ask: string[] = []): void => {
    const settingsPath = join(claudeConfigDir, 'settings.local.json');
    mkdirSync(claudeConfigDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ permissions: { allow, ask } }, null, 2));
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
      expect(mockedAddBackgroundTask).toHaveBeenCalledWith(
        expect.stringContaining('task-'),
        'test task',
        'executor',
        resolvedDirectory,
        'test-session',
      );
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
      expect(mockedAddBackgroundTask).toHaveBeenCalledWith(
        expect.stringContaining('task-'),
        'test task',
        'executor',
        resolvedDirectory,
        'test-session',
      );
    });

    it('should track only background Task invocations with the hook tool_use_id', async () => {
      writeClaudePermissions(['Edit', 'Write']);

      const input = {
        session_id: 'test-session',
        tool_name: 'Task',
        tool_input: {
          description: 'inspect code',
          subagent_type: 'explore',
          run_in_background: true,
        },
        tool_use_id: 'tool-use-123',
        cwd: '/tmp/test',
      } as unknown as HookInput;

      const result = await processHook('pre-tool-use', input);
      expect(result.continue).toBe(true);
      expect(mockedAddBackgroundTask).toHaveBeenCalledWith(
        'tool-use-123',
        'inspect code',
        'explore',
        resolvedDirectory,
        'test-session',
      );
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

  describe('HUD background task lifecycle tracking', () => {
    it('tracks only background Task invocations using tool_use_id', async () => {
      writeClaudePermissions(['Edit', 'Write']);

      const input = {
        sessionId: 'test-session',
        toolName: 'Task',
        toolInput: {
          description: 'background executor task',
          subagent_type: 'executor',
          run_in_background: true,
        },
        tool_use_id: 'tool-use-bg-1',
        directory: '/tmp/test',
      } as unknown as HookInput;

      const result = await processHook('pre-tool-use', input);
      expect(result.continue).toBe(true);
      expect(mockedAddBackgroundTask).toHaveBeenCalledWith(
        'tool-use-bg-1',
        'background executor task',
        'executor',
        resolvedDirectory,
        'test-session',
      );
    });

    it('tracks foreground Task invocations with the stable hook id when available', async () => {
      const input = {
        sessionId: 'test-session',
        toolName: 'Task',
        toolInput: {
          description: 'foreground task',
          subagent_type: 'executor',
        },
        tool_use_id: 'tool-use-fg-1',
        directory: '/tmp/test',
      } as unknown as HookInput;

      const result = await processHook('pre-tool-use', input);
      expect(result.continue).toBe(true);
      expect(mockedAddBackgroundTask).toHaveBeenCalledWith(
        'tool-use-fg-1',
        'foreground task',
        'executor',
        resolvedDirectory,
        'test-session',
      );
    });

    it('remaps background Task launch id to async agent id after successful launch', async () => {
      const input = {
        sessionId: 'test-session',
        toolName: 'Task',
        toolInput: {
          description: 'background task',
          run_in_background: true,
        },
        tool_use_id: 'tool-use-bg-2',
        toolOutput: ['Async agent launched successfully', 'agentId: a8de3dd'].join('\n'),
        directory: '/tmp/test',
      } as unknown as HookInput;

      const result = await processHook('post-tool-use', input);
      expect(result.continue).toBe(true);
      expect(mockedRemapBackgroundTaskId).toHaveBeenCalledWith(
        'tool-use-bg-2',
        'a8de3dd',
        resolvedDirectory,
        'test-session',
      );
      expect(mockedCompleteBackgroundTask).not.toHaveBeenCalled();
      expect(mockedRemapMostRecentMatchingBackgroundTaskId).not.toHaveBeenCalled();
    });

    it('marks failed Task launches as failed in HUD state', async () => {
      const input = {
        sessionId: 'test-session',
        toolName: 'Task',
        toolInput: {
          description: 'background task',
          run_in_background: true,
        },
        tool_use_id: 'tool-use-bg-3',
        toolOutput: 'Error: failed to launch async agent',
        directory: '/tmp/test',
      } as unknown as HookInput;

      const result = await processHook('post-tool-use', input);
      expect(result.continue).toBe(true);
      expect(mockedCompleteBackgroundTask).toHaveBeenCalledWith(
        'tool-use-bg-3',
        resolvedDirectory,
        true,
        'test-session',
      );
    });

    it('completes background tasks on TaskOutput completion', async () => {
      const input: HookInput = {
        sessionId: 'test-session',
        toolName: 'TaskOutput',
        toolOutput: ['<task_id>a8de3dd</task_id>', '<status>completed</status>'].join('\n'),
        directory: '/tmp/test',
      };

      const result = await processHook('post-tool-use', input);
      expect(result.continue).toBe(true);
      expect(mockedCompleteBackgroundTask).toHaveBeenCalledWith(
        'a8de3dd',
        resolvedDirectory,
        false,
        'test-session',
      );
    });

    it('fails background tasks on TaskOutput error status', async () => {
      const input: HookInput = {
        sessionId: 'test-session',
        toolName: 'TaskOutput',
        toolOutput: ['<task_id>a8de3dd</task_id>', '<status>error</status>'].join('\n'),
        directory: '/tmp/test',
      };

      const result = await processHook('post-tool-use', input);
      expect(result.continue).toBe(true);
      expect(mockedCompleteBackgroundTask).toHaveBeenCalledWith(
        'a8de3dd',
        resolvedDirectory,
        true,
        'test-session',
      );
    });

    it('completes fallback generated Task tracking by description when no tool_use_id is present', async () => {
      const input = {
        sessionId: 'test-session',
        toolName: 'Task',
        toolInput: {
          description: 'foreground task',
          subagent_type: 'executor',
        },
        toolOutput: 'Task completed successfully',
        directory: '/tmp/test',
      } as unknown as HookInput;

      const result = await processHook('post-tool-use', input);
      expect(result.continue).toBe(true);
      expect(mockedCompleteMostRecentMatchingBackgroundTask).toHaveBeenCalledWith(
        'foreground task',
        resolvedDirectory,
        false,
        'executor',
        'test-session',
      );
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

    it('should block safe-looking background Bash when ask rules require approval', async () => {
      writeClaudePermissions([], ['Bash(git commit:*)']);

      const input: HookInput = {
        sessionId: 'test-session',
        toolName: 'Bash',
        toolInput: {
          command: `git commit -m "$(cat <<'EOF'\nfeat: test\nEOF\n)"`,
          run_in_background: true,
        },
        directory: '/tmp/test',
      };

      const result = await processHook('pre-tool-use', input);
      expect(result.continue).toBe(false);
      expect(result.reason).toContain('[BACKGROUND PERMISSIONS]');
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
