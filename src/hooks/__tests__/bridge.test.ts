import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { processHook, resetSkipHooksCache, type HookInput, type HookOutput, type HookType } from '../bridge.js';

describe('processHook - Environment Kill-Switches', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment and cache before each test
    process.env = { ...originalEnv };
    delete process.env.DISABLE_OMC;
    delete process.env.OMC_SKIP_HOOKS;
    resetSkipHooksCache();
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
    resetSkipHooksCache();
  });

  describe('DISABLE_OMC flag', () => {
    it('should return continue:true when DISABLE_OMC=1', async () => {
      process.env.DISABLE_OMC = '1';

      const input: HookInput = {
        sessionId: 'test-session',
        prompt: 'test prompt',
        directory: '/tmp/test'
      };

      const result = await processHook('keyword-detector', input);

      expect(result).toEqual({ continue: true });
    });

    it('should return continue:true when DISABLE_OMC=true (string)', async () => {
      process.env.DISABLE_OMC = 'true';

      const input: HookInput = {
        sessionId: 'test-session',
        prompt: 'test prompt',
        directory: '/tmp/test'
      };

      const result = await processHook('persistent-mode', input);

      expect(result).toEqual({ continue: true });
    });

    it('should process normally when DISABLE_OMC is not set', async () => {
      const input: HookInput = {
        sessionId: 'test-session',
        prompt: 'hello world',
        directory: '/tmp/test'
      };

      const result = await processHook('keyword-detector', input);

      // Should process normally (keyword-detector returns continue:true for non-keyword prompts)
      expect(result.continue).toBe(true);
      // No message because 'hello world' doesn't contain keywords
    });

    it('should process normally when DISABLE_OMC=false', async () => {
      process.env.DISABLE_OMC = 'false';

      const input: HookInput = {
        sessionId: 'test-session',
        prompt: 'hello world',
        directory: '/tmp/test'
      };

      const result = await processHook('keyword-detector', input);

      // Should process normally (not disabled)
      expect(result.continue).toBe(true);
    });
  });

  describe('OMC_SKIP_HOOKS flag', () => {
    it('should skip single hook type when specified', async () => {
      process.env.OMC_SKIP_HOOKS = 'pre-tool-use';

      const input: HookInput = {
        sessionId: 'test-session',
        toolName: 'Write',
        toolInput: { file_path: '/test/file.ts', content: 'test' },
        directory: '/tmp/test'
      };

      const result = await processHook('pre-tool-use', input);

      expect(result).toEqual({ continue: true });
    });

    it('should skip multiple hook types when comma-separated', async () => {
      process.env.OMC_SKIP_HOOKS = 'pre-tool-use,persistent-mode';

      const preToolInput: HookInput = {
        sessionId: 'test-session',
        toolName: 'Write',
        directory: '/tmp/test'
      };

      const persistentModeInput: HookInput = {
        sessionId: 'test-session',
        directory: '/tmp/test'
      };

      const preToolResult = await processHook('pre-tool-use', preToolInput);
      const persistentResult = await processHook('persistent-mode', persistentModeInput);

      expect(preToolResult).toEqual({ continue: true });
      expect(persistentResult).toEqual({ continue: true });
    });

    it('should handle whitespace in OMC_SKIP_HOOKS', async () => {
      process.env.OMC_SKIP_HOOKS = ' pre-tool-use , persistent-mode ';

      const input: HookInput = {
        sessionId: 'test-session',
        toolName: 'Write',
        directory: '/tmp/test'
      };

      const result = await processHook('pre-tool-use', input);

      expect(result).toEqual({ continue: true });
    });

    it('should process normally when hook type is not in skip list', async () => {
      process.env.OMC_SKIP_HOOKS = 'persistent-mode';

      const input: HookInput = {
        sessionId: 'test-session',
        prompt: 'hello world',
        directory: '/tmp/test'
      };

      const result = await processHook('keyword-detector', input);

      // Should process normally (keyword-detector not in skip list)
      expect(result.continue).toBe(true);
    });

    it('should process normally when OMC_SKIP_HOOKS is empty', async () => {
      process.env.OMC_SKIP_HOOKS = '';

      const input: HookInput = {
        sessionId: 'test-session',
        prompt: 'hello world',
        directory: '/tmp/test'
      };

      const result = await processHook('keyword-detector', input);

      expect(result.continue).toBe(true);
    });
  });

  describe('Combined flags', () => {
    it('should respect DISABLE_OMC even if OMC_SKIP_HOOKS is set', async () => {
      process.env.DISABLE_OMC = '1';
      process.env.OMC_SKIP_HOOKS = 'keyword-detector';

      const input: HookInput = {
        sessionId: 'test-session',
        prompt: 'test',
        directory: '/tmp/test'
      };

      const result = await processHook('keyword-detector', input);

      // DISABLE_OMC takes precedence
      expect(result).toEqual({ continue: true });
    });
  });

  describe('Performance', () => {
    it('should have no performance impact when flags are not set', async () => {
      const input: HookInput = {
        sessionId: 'test-session',
        prompt: 'hello world',
        directory: '/tmp/test'
      };

      const start = Date.now();
      await processHook('keyword-detector', input);
      const duration = Date.now() - start;

      // Should complete in under 100ms (very generous threshold)
      // The actual overhead should be negligible (< 1ms)
      expect(duration).toBeLessThan(100);
    });

    it('should have minimal overhead when DISABLE_OMC=1', async () => {
      process.env.DISABLE_OMC = '1';

      const input: HookInput = {
        sessionId: 'test-session',
        prompt: 'test',
        directory: '/tmp/test'
      };

      const start = Date.now();
      await processHook('keyword-detector', input);
      const duration = Date.now() - start;

      // Should be even faster when disabled (immediate return)
      expect(duration).toBeLessThan(50);
    });
  });

  describe('All hook types', () => {
    // Ensure this list stays in sync with HookType.
    // NOTE: `satisfies HookType[]` catches invalid values (typos, removed types),
    // but does NOT enforce exhaustiveness -- if a new HookType variant is added,
    // TypeScript will not error here until a test exercises the missing variant.
    const hookTypes: HookType[] = [
      'keyword-detector',
      'stop-continuation',
      'ralph',
      'persistent-mode',
      'session-start',
      'session-end',
      'pre-tool-use',
      'post-tool-use',
      'autopilot',
      'subagent-start',
      'subagent-stop',
      'pre-compact',
      'setup-init',
      'setup-maintenance',
      'permission-request'
    ] satisfies HookType[];

    it('should disable all hook types when DISABLE_OMC=1', async () => {
      process.env.DISABLE_OMC = '1';

      const input: HookInput = {
        sessionId: 'test-session',
        prompt: 'test',
        directory: '/tmp/test'
      };

      for (const hookType of hookTypes) {
        const result = await processHook(hookType, input);
        expect(result).toEqual({ continue: true });
      }
    });
  });
});
