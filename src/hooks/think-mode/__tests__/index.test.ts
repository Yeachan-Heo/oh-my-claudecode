import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  // Detector functions
  removeCodeBlocks,
  detectThinkKeyword,
  extractPromptText,
  detectUltrathinkKeyword,
  // Switcher functions
  getHighVariant,
  isAlreadyHighVariant,
  getThinkingConfig,
  getClaudeThinkingConfig,
  THINKING_CONFIGS,
  // State management
  clearThinkModeState,
  getThinkModeState,
  isThinkModeActive,
  processThinkMode,
  // Hook factory
  createThinkModeHook,
  // Simplified functions
  shouldActivateThinkMode,
  shouldActivateUltrathink,
} from '../index.js';
import type { ThinkModeState, ThinkModeInput } from '../types.js';

describe('think-mode', () => {
  // Clean up state after each test
  afterEach(() => {
    clearThinkModeState('test-session');
    clearThinkModeState('session-1');
    clearThinkModeState('session-2');
  });

  describe('detector - removeCodeBlocks', () => {
    it('should remove fenced code blocks', () => {
      const text = 'Before ```code``` after';
      expect(removeCodeBlocks(text)).toBe('Before  after');
    });

    it('should remove multiline fenced code blocks', () => {
      const text = `Hello
\`\`\`
think
\`\`\`
World`;
      expect(removeCodeBlocks(text)).toBe(`Hello

World`);
    });

    it('should remove inline code', () => {
      const text = 'Use `think` command';
      expect(removeCodeBlocks(text)).toBe('Use  command');
    });

    it('should handle empty input', () => {
      expect(removeCodeBlocks('')).toBe('');
    });

    it('should return unchanged text without code', () => {
      expect(removeCodeBlocks('regular text')).toBe('regular text');
    });
  });

  describe('detector - detectThinkKeyword', () => {
    describe('English keywords', () => {
      it('should detect "think" keyword', () => {
        expect(detectThinkKeyword('think about this')).toBe(true);
      });

      it('should detect "ultrathink" keyword', () => {
        expect(detectThinkKeyword('ultrathink this problem')).toBe(true);
      });

      it('should be case insensitive', () => {
        expect(detectThinkKeyword('THINK about this')).toBe(true);
        expect(detectThinkKeyword('Think carefully')).toBe(true);
      });

      it('should not detect partial matches', () => {
        // "think" should be a word boundary
        expect(detectThinkKeyword('rethinking this')).toBe(false);
      });
    });

    describe('Multilingual keywords', () => {
      it('should detect Korean "생각"', () => {
        expect(detectThinkKeyword('이것에 대해 생각해주세요')).toBe(true);
      });

      it('should detect Chinese "思考"', () => {
        expect(detectThinkKeyword('请思考这个问题')).toBe(true);
      });

      it('should detect Japanese "考え"', () => {
        expect(detectThinkKeyword('これについて考えてください')).toBe(true);
      });

      it('should detect Russian "думать"', () => {
        expect(detectThinkKeyword('пожалуйста думай')).toBe(true);
      });

      it('should detect Spanish "piensa"', () => {
        expect(detectThinkKeyword('piensa en esto')).toBe(true);
      });

      it('should detect French "penser"', () => {
        expect(detectThinkKeyword('tu dois penser')).toBe(true);
      });

      it('should detect German "denken"', () => {
        expect(detectThinkKeyword('bitte denken Sie')).toBe(true);
      });
    });

    describe('Code block exclusion', () => {
      it('should not detect keyword inside fenced code block', () => {
        expect(detectThinkKeyword('```\nthink\n```')).toBe(false);
      });

      it('should not detect keyword inside inline code', () => {
        expect(detectThinkKeyword('Use `think` command')).toBe(false);
      });

      it('should detect keyword outside code block', () => {
        expect(detectThinkKeyword('think about ```code```')).toBe(true);
      });
    });

    it('should return false for no keywords', () => {
      expect(detectThinkKeyword('regular text here')).toBe(false);
    });

    it('should return false for empty input', () => {
      expect(detectThinkKeyword('')).toBe(false);
    });
  });

  describe('detector - extractPromptText', () => {
    it('should extract text from text parts', () => {
      const parts = [
        { type: 'text', text: 'Hello' },
        { type: 'text', text: ' World' },
      ];
      expect(extractPromptText(parts)).toBe('Hello World');
    });

    it('should ignore non-text parts', () => {
      const parts = [
        { type: 'text', text: 'Hello' },
        { type: 'image' },
        { type: 'text', text: 'World' },
      ];
      expect(extractPromptText(parts)).toBe('HelloWorld');
    });

    it('should handle empty parts array', () => {
      expect(extractPromptText([])).toBe('');
    });

    it('should handle missing text property', () => {
      const parts = [{ type: 'text' }, { type: 'text', text: 'Valid' }];
      expect(extractPromptText(parts)).toBe('Valid');
    });
  });

  describe('detector - detectUltrathinkKeyword', () => {
    it('should detect ultrathink keyword', () => {
      expect(detectUltrathinkKeyword('ultrathink this')).toBe(true);
    });

    it('should be case insensitive', () => {
      expect(detectUltrathinkKeyword('ULTRATHINK')).toBe(true);
      expect(detectUltrathinkKeyword('UltraThink')).toBe(true);
    });

    it('should not detect just "think"', () => {
      expect(detectUltrathinkKeyword('think about this')).toBe(false);
    });

    it('should not detect in code block', () => {
      expect(detectUltrathinkKeyword('```ultrathink```')).toBe(false);
    });

    it('should return false for empty input', () => {
      expect(detectUltrathinkKeyword('')).toBe(false);
    });
  });

  describe('switcher - getHighVariant', () => {
    describe('Claude models', () => {
      it('should return high variant for claude-sonnet-4-5', () => {
        expect(getHighVariant('claude-sonnet-4-5')).toBe('claude-sonnet-4-5-high');
      });

      it('should return high variant for claude-opus-4-6', () => {
        expect(getHighVariant('claude-opus-4-6')).toBe('claude-opus-4-6-high');
      });

      it('should return high variant for claude-3-5-sonnet', () => {
        expect(getHighVariant('claude-3-5-sonnet')).toBe('claude-3-5-sonnet-high');
      });

      it('should return high variant for claude-3-opus', () => {
        expect(getHighVariant('claude-3-opus')).toBe('claude-3-opus-high');
      });

      it('should handle version with dot notation', () => {
        expect(getHighVariant('claude-sonnet-4.5')).toBe('claude-sonnet-4-5-high');
      });
    });

    describe('GPT models', () => {
      it('should return high variant for gpt-4', () => {
        expect(getHighVariant('gpt-4')).toBe('gpt-4-high');
      });

      it('should return high variant for gpt-4-turbo', () => {
        expect(getHighVariant('gpt-4-turbo')).toBe('gpt-4-turbo-high');
      });

      it('should return high variant for gpt-4o', () => {
        expect(getHighVariant('gpt-4o')).toBe('gpt-4o-high');
      });

      it('should return high variant for gpt-5', () => {
        expect(getHighVariant('gpt-5')).toBe('gpt-5-high');
      });
    });

    describe('Gemini models', () => {
      it('should return high variant for gemini-2-pro', () => {
        expect(getHighVariant('gemini-2-pro')).toBe('gemini-2-pro-high');
      });

      it('should return high variant for gemini-3-pro', () => {
        expect(getHighVariant('gemini-3-pro')).toBe('gemini-3-pro-high');
      });

      it('should return high variant for gemini-3-flash', () => {
        expect(getHighVariant('gemini-3-flash')).toBe('gemini-3-flash-high');
      });
    });

    describe('Already high variants', () => {
      it('should return null for already high variant', () => {
        expect(getHighVariant('claude-sonnet-4-5-high')).toBeNull();
      });

      it('should return null for model ending in -high', () => {
        expect(getHighVariant('some-model-high')).toBeNull();
      });
    });

    describe('Prefixed models', () => {
      it('should preserve prefix in high variant', () => {
        expect(getHighVariant('vertex_ai/claude-sonnet-4-5')).toBe('vertex_ai/claude-sonnet-4-5-high');
      });

      it('should handle openai/ prefix', () => {
        expect(getHighVariant('openai/gpt-4')).toBe('openai/gpt-4-high');
      });
    });

    it('should return null for unknown model', () => {
      expect(getHighVariant('unknown-model')).toBeNull();
    });
  });

  describe('switcher - isAlreadyHighVariant', () => {
    it('should return true for high variant models', () => {
      expect(isAlreadyHighVariant('claude-sonnet-4-5-high')).toBe(true);
    });

    it('should return true for any model ending in -high', () => {
      expect(isAlreadyHighVariant('custom-model-high')).toBe(true);
    });

    it('should return false for non-high variant', () => {
      expect(isAlreadyHighVariant('claude-sonnet-4-5')).toBe(false);
    });

    it('should handle prefixed models', () => {
      expect(isAlreadyHighVariant('vertex_ai/claude-sonnet-4-5-high')).toBe(true);
      expect(isAlreadyHighVariant('vertex_ai/claude-sonnet-4-5')).toBe(false);
    });

    it('should normalize dot notation', () => {
      expect(isAlreadyHighVariant('claude-sonnet-4.5-high')).toBe(true);
    });
  });

  describe('switcher - getThinkingConfig', () => {
    describe('Anthropic provider', () => {
      it('should return config for Claude models', () => {
        const config = getThinkingConfig('anthropic', 'claude-sonnet-4-5');
        expect(config).not.toBeNull();
        expect(config).toHaveProperty('thinking');
      });

      it('should return null for already high variant', () => {
        const config = getThinkingConfig('anthropic', 'claude-sonnet-4-5-high');
        expect(config).toBeNull();
      });
    });

    describe('Amazon Bedrock provider', () => {
      it('should return config for Claude models on Bedrock', () => {
        const config = getThinkingConfig('amazon-bedrock', 'anthropic.claude-3-sonnet');
        expect(config).not.toBeNull();
        expect(config).toHaveProperty('reasoningConfig');
      });
    });

    describe('Google provider', () => {
      it('should return config for Gemini models', () => {
        const config = getThinkingConfig('google', 'gemini-2-pro');
        expect(config).not.toBeNull();
        expect(config).toHaveProperty('providerOptions');
      });
    });

    describe('OpenAI provider', () => {
      it('should return config for GPT models', () => {
        const config = getThinkingConfig('openai', 'gpt-4');
        expect(config).not.toBeNull();
        expect(config).toHaveProperty('reasoning_effort');
      });

      it('should return config for o1 models', () => {
        const config = getThinkingConfig('openai', 'o1-preview');
        expect(config).not.toBeNull();
      });
    });

    describe('GitHub Copilot proxy', () => {
      it('should resolve to anthropic for Claude model', () => {
        const config = getThinkingConfig('github-copilot', 'claude-sonnet-4-5');
        expect(config).not.toBeNull();
        expect(config).toHaveProperty('thinking');
      });

      it('should resolve to google for Gemini model', () => {
        const config = getThinkingConfig('github-copilot', 'gemini-2-pro');
        expect(config).not.toBeNull();
        expect(config).toHaveProperty('providerOptions');
      });

      it('should resolve to openai for GPT model', () => {
        const config = getThinkingConfig('github-copilot', 'gpt-4');
        expect(config).not.toBeNull();
        expect(config).toHaveProperty('reasoning_effort');
      });
    });

    it('should return null for unknown provider', () => {
      const config = getThinkingConfig('unknown-provider', 'some-model');
      expect(config).toBeNull();
    });

    it('should return null for non-capable model', () => {
      const config = getThinkingConfig('anthropic', 'unknown-model');
      expect(config).toBeNull();
    });
  });

  describe('switcher - getClaudeThinkingConfig', () => {
    it('should return default config with 64000 tokens', () => {
      const config = getClaudeThinkingConfig();
      expect(config.thinking.type).toBe('enabled');
      expect(config.thinking.budgetTokens).toBe(64000);
      expect(config.maxTokens).toBe(128000);
    });

    it('should accept custom budget tokens', () => {
      const config = getClaudeThinkingConfig(32000);
      expect(config.thinking.budgetTokens).toBe(32000);
    });
  });

  describe('switcher - THINKING_CONFIGS', () => {
    it('should have anthropic config', () => {
      expect(THINKING_CONFIGS.anthropic).toBeDefined();
      expect(THINKING_CONFIGS.anthropic.thinking).toBeDefined();
    });

    it('should have amazon-bedrock config', () => {
      expect(THINKING_CONFIGS['amazon-bedrock']).toBeDefined();
      expect(THINKING_CONFIGS['amazon-bedrock'].reasoningConfig).toBeDefined();
    });

    it('should have google config', () => {
      expect(THINKING_CONFIGS.google).toBeDefined();
      expect(THINKING_CONFIGS.google.providerOptions).toBeDefined();
    });

    it('should have openai config', () => {
      expect(THINKING_CONFIGS.openai).toBeDefined();
      expect(THINKING_CONFIGS.openai.reasoning_effort).toBe('high');
    });
  });

  describe('state management - processThinkMode', () => {
    it('should set requested to false when no keyword', () => {
      const state = processThinkMode('test-session', 'regular text');
      expect(state.requested).toBe(false);
    });

    it('should set requested to true when keyword detected', () => {
      const state = processThinkMode('test-session', 'think about this');
      expect(state.requested).toBe(true);
    });

    it('should store state for session', () => {
      processThinkMode('test-session', 'think about this');
      const stored = getThinkModeState('test-session');
      expect(stored?.requested).toBe(true);
    });

    it('should return initial state values', () => {
      const state = processThinkMode('test-session', 'think');
      expect(state.modelSwitched).toBe(false);
      expect(state.thinkingConfigInjected).toBe(false);
    });
  });

  describe('state management - getThinkModeState', () => {
    it('should return undefined for unknown session', () => {
      expect(getThinkModeState('unknown-session')).toBeUndefined();
    });

    it('should return state after processThinkMode', () => {
      processThinkMode('test-session', 'think');
      const state = getThinkModeState('test-session');
      expect(state).toBeDefined();
      expect(state?.requested).toBe(true);
    });
  });

  describe('state management - isThinkModeActive', () => {
    it('should return false for unknown session', () => {
      expect(isThinkModeActive('unknown-session')).toBe(false);
    });

    it('should return true after think mode requested', () => {
      processThinkMode('test-session', 'think');
      expect(isThinkModeActive('test-session')).toBe(true);
    });

    it('should return false when not requested', () => {
      processThinkMode('test-session', 'regular text');
      expect(isThinkModeActive('test-session')).toBe(false);
    });
  });

  describe('state management - clearThinkModeState', () => {
    it('should clear state for session', () => {
      processThinkMode('test-session', 'think');
      clearThinkModeState('test-session');
      expect(getThinkModeState('test-session')).toBeUndefined();
    });

    it('should not affect other sessions', () => {
      processThinkMode('session-1', 'think');
      processThinkMode('session-2', 'think');
      clearThinkModeState('session-1');
      expect(getThinkModeState('session-2')).toBeDefined();
    });
  });

  describe('state management - session isolation', () => {
    it('should maintain separate state per session', () => {
      processThinkMode('session-1', 'think');
      processThinkMode('session-2', 'regular');

      expect(getThinkModeState('session-1')?.requested).toBe(true);
      expect(getThinkModeState('session-2')?.requested).toBe(false);
    });
  });

  describe('createThinkModeHook', () => {
    it('should create hook with processChatParams method', () => {
      const hook = createThinkModeHook();
      expect(typeof hook.processChatParams).toBe('function');
    });

    it('should create hook with onSessionDeleted method', () => {
      const hook = createThinkModeHook();
      expect(typeof hook.onSessionDeleted).toBe('function');
    });

    it('should create hook with isRequested method', () => {
      const hook = createThinkModeHook();
      expect(typeof hook.isRequested).toBe('function');
    });

    it('should create hook with getState method', () => {
      const hook = createThinkModeHook();
      expect(typeof hook.getState).toBe('function');
    });

    it('should create hook with clear method', () => {
      const hook = createThinkModeHook();
      expect(typeof hook.clear).toBe('function');
    });

    describe('processChatParams', () => {
      it('should detect think mode from parts', () => {
        const hook = createThinkModeHook();
        const input: ThinkModeInput = {
          parts: [{ type: 'text', text: 'think about this' }],
          message: {},
        };
        const state = hook.processChatParams('test-session', input);
        expect(state.requested).toBe(true);
      });

      it('should not request think mode for regular text', () => {
        const hook = createThinkModeHook();
        const input: ThinkModeInput = {
          parts: [{ type: 'text', text: 'regular text' }],
          message: {},
        };
        const state = hook.processChatParams('test-session', input);
        expect(state.requested).toBe(false);
      });

      it('should switch model to high variant', () => {
        const hook = createThinkModeHook();
        const input: ThinkModeInput = {
          parts: [{ type: 'text', text: 'think' }],
          message: {
            model: {
              providerId: 'anthropic',
              modelId: 'claude-sonnet-4-5',
            },
          },
        };
        const state = hook.processChatParams('test-session', input);
        expect(state.modelSwitched).toBe(true);
        expect(input.message.model?.modelId).toBe('claude-sonnet-4-5-high');
      });

      it('should not switch already high variant', () => {
        const hook = createThinkModeHook();
        const input: ThinkModeInput = {
          parts: [{ type: 'text', text: 'think' }],
          message: {
            model: {
              providerId: 'anthropic',
              modelId: 'claude-sonnet-4-5-high',
            },
          },
        };
        const state = hook.processChatParams('test-session', input);
        expect(state.modelSwitched).toBe(false);
      });

      it('should inject thinking config', () => {
        const hook = createThinkModeHook();
        const input: ThinkModeInput = {
          parts: [{ type: 'text', text: 'think' }],
          message: {
            model: {
              providerId: 'anthropic',
              modelId: 'claude-sonnet-4-5',
            },
          },
        };
        const state = hook.processChatParams('test-session', input);
        expect(state.thinkingConfigInjected).toBe(true);
      });

      it('should store provider and model in state', () => {
        const hook = createThinkModeHook();
        const input: ThinkModeInput = {
          parts: [{ type: 'text', text: 'think' }],
          message: {
            model: {
              providerId: 'anthropic',
              modelId: 'claude-sonnet-4-5',
            },
          },
        };
        hook.processChatParams('test-session', input);
        const state = hook.getState('test-session');
        expect(state?.providerId).toBe('anthropic');
        expect(state?.modelId).toBe('claude-sonnet-4-5');
      });
    });

    describe('onSessionDeleted', () => {
      it('should clear state when session deleted', () => {
        const hook = createThinkModeHook();
        processThinkMode('test-session', 'think');
        hook.onSessionDeleted('test-session');
        expect(getThinkModeState('test-session')).toBeUndefined();
      });
    });

    describe('isRequested', () => {
      it('should return true when think mode requested', () => {
        const hook = createThinkModeHook();
        processThinkMode('test-session', 'think');
        expect(hook.isRequested('test-session')).toBe(true);
      });

      it('should return false for unknown session', () => {
        const hook = createThinkModeHook();
        expect(hook.isRequested('unknown')).toBe(false);
      });
    });

    describe('getState', () => {
      it('should return state for session', () => {
        const hook = createThinkModeHook();
        processThinkMode('test-session', 'think');
        expect(hook.getState('test-session')).toBeDefined();
      });

      it('should return undefined for unknown session', () => {
        const hook = createThinkModeHook();
        expect(hook.getState('unknown')).toBeUndefined();
      });
    });

    describe('clear', () => {
      it('should clear state for session', () => {
        const hook = createThinkModeHook();
        processThinkMode('test-session', 'think');
        hook.clear('test-session');
        expect(hook.getState('test-session')).toBeUndefined();
      });
    });
  });

  describe('shouldActivateThinkMode', () => {
    it('should return true for think keyword', () => {
      expect(shouldActivateThinkMode('think about this')).toBe(true);
    });

    it('should return true for ultrathink keyword', () => {
      expect(shouldActivateThinkMode('ultrathink')).toBe(true);
    });

    it('should return true for multilingual keywords', () => {
      expect(shouldActivateThinkMode('생각해주세요')).toBe(true);
    });

    it('should return false for no keywords', () => {
      expect(shouldActivateThinkMode('regular text')).toBe(false);
    });

    it('should ignore keywords in code blocks', () => {
      expect(shouldActivateThinkMode('```think```')).toBe(false);
    });
  });

  describe('shouldActivateUltrathink', () => {
    it('should return true for ultrathink keyword', () => {
      expect(shouldActivateUltrathink('ultrathink this')).toBe(true);
    });

    it('should return false for just think', () => {
      expect(shouldActivateUltrathink('think about this')).toBe(false);
    });

    it('should be case insensitive', () => {
      expect(shouldActivateUltrathink('ULTRATHINK')).toBe(true);
    });

    it('should ignore in code blocks', () => {
      expect(shouldActivateUltrathink('```ultrathink```')).toBe(false);
    });
  });
});
