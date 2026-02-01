/**
 * Integration tests for delegation enforcer
 * Tests the entire flow from hook input to modified output
 *
 * NOTE: These tests are SKIPPED because the delegation enforcer is not yet wired
 * into the hooks bridge. The enforcer module exists but processHook() doesn't
 * call it. These tests will be enabled once the integration is implemented.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { processHook, type HookInput } from '../hooks/bridge.js';

describe.skip('delegation-enforcer integration', () => {
  let originalDebugEnv: string | undefined;

  beforeEach(() => {
    originalDebugEnv = process.env.OMC_DEBUG;
  });

  afterEach(() => {
    if (originalDebugEnv === undefined) {
      delete process.env.OMC_DEBUG;
    } else {
      process.env.OMC_DEBUG = originalDebugEnv;
    }
  });

  describe('pre-tool-use hook with Task calls', () => {
    it('injects model parameter for Task call without model', async () => {
      const input: HookInput = {
        toolName: 'Task',
        toolInput: {
          description: 'Test task',
          prompt: 'Do something',
          subagent_type: 'general-purpose'
        }
      };

      const result = await processHook('pre-tool-use', input);

      expect(result.continue).toBe(true);
      expect(result.modifiedInput).toBeDefined();

      const modifiedInput = result.modifiedInput as {
        model?: string;
        description: string;
        prompt: string;
        subagent_type: string;
      };

      expect(modifiedInput.model).toBe('sonnet');
      expect(modifiedInput.description).toBe('Test task');
      expect(modifiedInput.prompt).toBe('Do something');
    });

    it('preserves explicit model parameter', async () => {
      const input: HookInput = {
        toolName: 'Task',
        toolInput: {
          description: 'Test task',
          prompt: 'Do something',
          subagent_type: 'general-purpose',
          model: 'haiku'
        }
      };

      const result = await processHook('pre-tool-use', input);

      expect(result.continue).toBe(true);
      expect(result.modifiedInput).toBeDefined();

      const modifiedInput = result.modifiedInput as {
        model?: string;
      };

      expect(modifiedInput.model).toBe('haiku');
    });

    it('handles Agent tool name', async () => {
      const input: HookInput = {
        toolName: 'Agent',
        toolInput: {
          description: 'Test task',
          prompt: 'Do something',
          subagent_type: 'general-purpose'
        }
      };

      const result = await processHook('pre-tool-use', input);

      expect(result.continue).toBe(true);

      const modifiedInput = result.modifiedInput as {
        model?: string;
      };

      expect(modifiedInput.model).toBe('haiku');
    });

    it('does not modify non-agent tools', async () => {
      const input: HookInput = {
        toolName: 'Bash',
        toolInput: {
          command: 'ls -la'
        }
      };

      const result = await processHook('pre-tool-use', input);

      expect(result.continue).toBe(true);

      const modifiedInput = result.modifiedInput as {
        command: string;
      };

      expect(modifiedInput.command).toBe('ls -la');
      expect(modifiedInput).not.toHaveProperty('model');
    });

    it('works with all agent tiers', async () => {
      const testCases = [
        { agent: 'Plan', expectedModel: 'opus' },
        { agent: 'Explore', expectedModel: 'haiku' },
        { agent: 'general-purpose', expectedModel: 'opus' },
        { agent: 'general-purpose', expectedModel: 'haiku' },
        { agent: 'general-purpose', expectedModel: 'opus' }
      ];

      for (const testCase of testCases) {
        const input: HookInput = {
          toolName: 'Task',
          toolInput: {
            description: 'Test',
            prompt: 'Test',
            subagent_type: testCase.agent
          }
        };

        const result = await processHook('pre-tool-use', input);

        const modifiedInput = result.modifiedInput as {
          model?: string;
        };

        expect(modifiedInput.model).toBe(testCase.expectedModel);
      }
    });

    it('does not log warning when OMC_DEBUG not set', async () => {
      delete process.env.OMC_DEBUG;

      const consoleWarnSpy = vi.spyOn(console, 'warn');

      const input: HookInput = {
        toolName: 'Task',
        toolInput: {
          description: 'Test',
          prompt: 'Test',
          subagent_type: 'general-purpose'
        }
      };

      await processHook('pre-tool-use', input);

      expect(consoleWarnSpy).not.toHaveBeenCalled();

      consoleWarnSpy.mockRestore();
    });

    it('logs warning when OMC_DEBUG=true', async () => {
      process.env.OMC_DEBUG = 'true';

      const consoleWarnSpy = vi.spyOn(console, 'warn');

      const input: HookInput = {
        toolName: 'Task',
        toolInput: {
          description: 'Test',
          prompt: 'Test',
          subagent_type: 'general-purpose'
        }
      };

      await processHook('pre-tool-use', input);

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[OMC] Auto-injecting model')
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('sonnet')
      );

      consoleWarnSpy.mockRestore();
    });
  });
});
