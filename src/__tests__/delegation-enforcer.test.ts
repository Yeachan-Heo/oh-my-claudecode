/**
 * Tests for delegation enforcer middleware
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  enforceModel,
  isAgentCall,
  processPreToolUse,
  getModelForAgent,
  type AgentInput
} from '../features/delegation-enforcer.js';
import { resolveDelegation } from '../features/delegation-routing/resolver.js';

describe('delegation-enforcer', () => {
  let originalDebugEnv: string | undefined;
  // Save/restore env vars that trigger non-Claude provider detection (issue #1201)
  // so existing tests run in a standard Claude environment
  const providerEnvKeys = ['ANTHROPIC_BASE_URL', 'CLAUDE_MODEL', 'ANTHROPIC_MODEL', 'OMC_ROUTING_FORCE_INHERIT', 'CLAUDE_CODE_BEDROCK_OPUS_MODEL', 'CLAUDE_CODE_BEDROCK_SONNET_MODEL', 'CLAUDE_CODE_BEDROCK_HAIKU_MODEL'];
  const savedProviderEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    originalDebugEnv = process.env.OMC_DEBUG;
    for (const key of providerEnvKeys) {
      savedProviderEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    if (originalDebugEnv === undefined) {
      delete process.env.OMC_DEBUG;
    } else {
      process.env.OMC_DEBUG = originalDebugEnv;
    }
    for (const key of providerEnvKeys) {
      if (savedProviderEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedProviderEnv[key];
      }
    }
  });

  describe('enforceModel', () => {
    it('preserves explicitly specified model', () => {
      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'oh-my-claudecode:executor',
        model: 'haiku'
      };

      const result = enforceModel(input);

      expect(result.injected).toBe(false);
      expect(result.modifiedInput.model).toBe('haiku');
      expect(result.modifiedInput).toEqual(input);
    });

    it('injects model from agent definition when not specified', () => {
      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'oh-my-claudecode:executor'
      };

      const result = enforceModel(input);

      expect(result.injected).toBe(true);
      expect(result.modifiedInput.model).toBe('claude-sonnet-4-6'); // executor defaults to claude-sonnet-4-6
      expect(result.originalInput.model).toBeUndefined();
    });

    it('handles agent type without prefix', () => {
      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'debugger'
      };

      const result = enforceModel(input);

      expect(result.injected).toBe(true);
      expect(result.modifiedInput.model).toBe('claude-sonnet-4-6'); // debugger defaults to claude-sonnet-4-6
    });

    it('rewrites deprecated aliases to canonical agent names before injecting model', () => {
      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'oh-my-claudecode:build-fixer'
      };

      const result = enforceModel(input);

      expect(result.injected).toBe(true);
      expect(result.modifiedInput.subagent_type).toBe('oh-my-claudecode:debugger');
      expect(result.modifiedInput.model).toBe('claude-sonnet-4-6');
    });

    it('throws error for unknown agent type', () => {
      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'unknown-agent'
      };

      expect(() => enforceModel(input)).toThrow('Unknown agent type');
    });

    it('logs warning only when OMC_DEBUG=true', () => {
      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'executor'
      };

      // Without debug flag
      delete process.env.OMC_DEBUG;
      const resultWithoutDebug = enforceModel(input);
      expect(resultWithoutDebug.warning).toBeUndefined();

      // With debug flag
      process.env.OMC_DEBUG = 'true';
      const resultWithDebug = enforceModel(input);
      expect(resultWithDebug.warning).toBeDefined();
      expect(resultWithDebug.warning).toContain('Auto-injecting model');
      expect(resultWithDebug.warning).toContain('claude-sonnet-4-6');
      expect(resultWithDebug.warning).toContain('executor');
    });

    it('does not log warning when OMC_DEBUG is false', () => {
      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'executor'
      };

      process.env.OMC_DEBUG = 'false';
      const result = enforceModel(input);
      expect(result.warning).toBeUndefined();
    });

    it('works with all agents', () => {
      const testCases = [
        { agent: 'architect', expectedModel: 'claude-opus-4-6' },
        { agent: 'executor', expectedModel: 'claude-sonnet-4-6' },
        { agent: 'explore', expectedModel: 'claude-haiku-4-5' },
        { agent: 'designer', expectedModel: 'claude-sonnet-4-6' },
        { agent: 'debugger', expectedModel: 'claude-sonnet-4-6' },
        { agent: 'verifier', expectedModel: 'claude-sonnet-4-6' },
        { agent: 'code-reviewer', expectedModel: 'claude-opus-4-6' },
        { agent: 'test-engineer', expectedModel: 'claude-sonnet-4-6' }
      ];

      for (const testCase of testCases) {
        const input: AgentInput = {
          description: 'Test',
          prompt: 'Test',
          subagent_type: testCase.agent
        };

        const result = enforceModel(input);
        expect(result.modifiedInput.model).toBe(testCase.expectedModel);
        expect(result.injected).toBe(true);
      }
    });
  });

  describe('isAgentCall', () => {
    it('returns true for Agent tool with valid input', () => {
      const toolInput = {
        description: 'Test',
        prompt: 'Test',
        subagent_type: 'executor'
      };

      expect(isAgentCall('Agent', toolInput)).toBe(true);
    });

    it('returns true for Task tool with valid input', () => {
      const toolInput = {
        description: 'Test',
        prompt: 'Test',
        subagent_type: 'executor'
      };

      expect(isAgentCall('Task', toolInput)).toBe(true);
    });

    it('returns false for non-agent tools', () => {
      const toolInput = {
        description: 'Test',
        prompt: 'Test',
        subagent_type: 'executor'
      };

      expect(isAgentCall('Bash', toolInput)).toBe(false);
      expect(isAgentCall('Read', toolInput)).toBe(false);
    });

    it('returns false for invalid input structure', () => {
      expect(isAgentCall('Agent', null)).toBe(false);
      expect(isAgentCall('Agent', undefined)).toBe(false);
      expect(isAgentCall('Agent', 'string')).toBe(false);
      expect(isAgentCall('Agent', { description: 'test' })).toBe(false); // missing prompt
      expect(isAgentCall('Agent', { prompt: 'test' })).toBe(false); // missing description
    });
  });

  describe('processPreToolUse', () => {
    it('returns original input for non-agent tools', () => {
      const toolInput = { command: 'ls -la' };
      const result = processPreToolUse('Bash', toolInput);

      expect(result.modifiedInput).toEqual(toolInput);
      expect(result.warning).toBeUndefined();
    });

    it('rewrites deprecated aliases in pre-tool-use enforcement even when model is explicit', () => {
      const toolInput: AgentInput = {
        description: 'Test',
        prompt: 'Test',
        subagent_type: 'quality-reviewer',
        model: 'opus'
      };

      const result = processPreToolUse('Task', toolInput);

      expect(result.modifiedInput).toEqual({
        ...toolInput,
        subagent_type: 'code-reviewer',
      });
    });


    it('enforces model for agent calls', () => {
      const toolInput: AgentInput = {
        description: 'Test',
        prompt: 'Test',
        subagent_type: 'executor'
      };

      const result = processPreToolUse('Agent', toolInput);

      expect(result.modifiedInput).toHaveProperty('model', 'claude-sonnet-4-6');
    });

    it('does not modify input when model already specified', () => {
      const toolInput: AgentInput = {
        description: 'Test',
        prompt: 'Test',
        subagent_type: 'executor',
        model: 'haiku'
      };

      const result = processPreToolUse('Agent', toolInput);

      expect(result.modifiedInput).toEqual(toolInput);
      expect(result.warning).toBeUndefined();
    });

    it('logs warning only when OMC_DEBUG=true and model injected', () => {
      const toolInput: AgentInput = {
        description: 'Test',
        prompt: 'Test',
        subagent_type: 'executor'
      };

      // Without debug
      delete process.env.OMC_DEBUG;
      const resultWithoutDebug = processPreToolUse('Agent', toolInput);
      expect(resultWithoutDebug.warning).toBeUndefined();

      // With debug
      process.env.OMC_DEBUG = 'true';
      const resultWithDebug = processPreToolUse('Agent', toolInput);
      expect(resultWithDebug.warning).toBeDefined();
    });
  });

  describe('getModelForAgent', () => {
    it('returns correct model for agent with prefix', () => {
      expect(getModelForAgent('oh-my-claudecode:executor')).toBe('claude-sonnet-4-6');
      expect(getModelForAgent('oh-my-claudecode:debugger')).toBe('claude-sonnet-4-6');
      expect(getModelForAgent('oh-my-claudecode:architect')).toBe('claude-opus-4-6');
    });

    it('returns correct model for agent without prefix', () => {
      expect(getModelForAgent('executor')).toBe('claude-sonnet-4-6');
      expect(getModelForAgent('debugger')).toBe('claude-sonnet-4-6');
      expect(getModelForAgent('architect')).toBe('claude-opus-4-6');
      expect(getModelForAgent('build-fixer')).toBe('claude-sonnet-4-6');
    });

    it('throws error for unknown agent', () => {
      expect(() => getModelForAgent('unknown')).toThrow('Unknown agent type');
    });
  });

  describe('deprecated alias routing', () => {
    it('routes api-reviewer to code-reviewer', () => {
      const result = resolveDelegation({ agentRole: 'api-reviewer' });
      expect(result.provider).toBe('claude');
      expect(result.tool).toBe('Task');
      expect(result.agentOrModel).toBe('code-reviewer');
    });

    it('routes performance-reviewer to code-reviewer', () => {
      const result = resolveDelegation({ agentRole: 'performance-reviewer' });
      expect(result.provider).toBe('claude');
      expect(result.tool).toBe('Task');
      expect(result.agentOrModel).toBe('code-reviewer');
    });

    it('routes dependency-expert to document-specialist', () => {
      const result = resolveDelegation({ agentRole: 'dependency-expert' });
      expect(result.provider).toBe('claude');
      expect(result.tool).toBe('Task');
      expect(result.agentOrModel).toBe('document-specialist');
    });

    it('routes quality-strategist to code-reviewer', () => {
      const result = resolveDelegation({ agentRole: 'quality-strategist' });
      expect(result.provider).toBe('claude');
      expect(result.tool).toBe('Task');
      expect(result.agentOrModel).toBe('code-reviewer');
    });

    it('routes vision to document-specialist', () => {
      const result = resolveDelegation({ agentRole: 'vision' });
      expect(result.provider).toBe('claude');
      expect(result.tool).toBe('Task');
      expect(result.agentOrModel).toBe('document-specialist');
    });
  });

  describe('env-resolved agent defaults (issue #1415)', () => {
    it('injects Bedrock family env model IDs instead of hardcoded tier aliases', () => {
      process.env.CLAUDE_CODE_BEDROCK_SONNET_MODEL = 'us.anthropic.claude-sonnet-4-6-v1:0';
      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'executor'
      };

      const result = enforceModel(input);

      expect(result.injected).toBe(true);
      expect(result.model).toBe('us.anthropic.claude-sonnet-4-6-v1:0');
      expect(result.modifiedInput.model).toBe('us.anthropic.claude-sonnet-4-6-v1:0');
    });

    it('getModelForAgent returns env-resolved model IDs', () => {
      process.env.CLAUDE_CODE_BEDROCK_OPUS_MODEL = 'us.anthropic.claude-opus-4-6-v1:0';
      expect(getModelForAgent('architect')).toBe('us.anthropic.claude-opus-4-6-v1:0');
    });
  });

  describe('modelAliases config override (issue #1211)', () => {
    const savedEnv: Record<string, string | undefined> = {};
    const aliasEnvKeys = ['OMC_MODEL_ALIAS_HAIKU', 'OMC_MODEL_ALIAS_SONNET', 'OMC_MODEL_ALIAS_OPUS'];

    beforeEach(() => {
      for (const key of aliasEnvKeys) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    });

    afterEach(() => {
      for (const key of aliasEnvKeys) {
        if (savedEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedEnv[key];
        }
      }
    });

    it('remaps haiku agents to inherit via env var', () => {
      process.env.OMC_MODEL_ALIAS_HAIKU = 'inherit';
      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'explore' // explore defaults to haiku
      };
      const result = enforceModel(input);
      expect(result.model).toBe('inherit');
      expect(result.modifiedInput.model).toBeUndefined();
    });

    it('remaps haiku agents to sonnet via env var', () => {
      process.env.OMC_MODEL_ALIAS_HAIKU = 'sonnet';
      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'explore' // explore defaults to haiku
      };
      const result = enforceModel(input);
      expect(result.model).toBe('sonnet');
      expect(result.modifiedInput.model).toBe('sonnet');
    });

    it('does not remap when no alias configured for the tier', () => {
      process.env.OMC_MODEL_ALIAS_HAIKU = 'sonnet';
      // executor defaults to sonnet — no alias for sonnet
      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'executor'
      };
      const result = enforceModel(input);
      expect(result.model).toBe('claude-sonnet-4-6');
      expect(result.modifiedInput.model).toBe('claude-sonnet-4-6');
    });

    it('explicit model param takes priority over alias', () => {
      process.env.OMC_MODEL_ALIAS_HAIKU = 'sonnet';
      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'explore',
        model: 'opus' // explicit param wins
      };
      const result = enforceModel(input);
      expect(result.model).toBe('opus');
      expect(result.modifiedInput.model).toBe('opus');
    });

    it('forceInherit takes priority over alias', () => {
      process.env.OMC_ROUTING_FORCE_INHERIT = 'true';
      process.env.OMC_MODEL_ALIAS_HAIKU = 'sonnet';
      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'explore'
      };
      const result = enforceModel(input);
      expect(result.model).toBe('inherit');
      expect(result.modifiedInput.model).toBeUndefined();
    });

    it('remaps opus agents to inherit via env var', () => {
      process.env.OMC_MODEL_ALIAS_OPUS = 'inherit';
      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'architect' // architect defaults to opus
      };
      const result = enforceModel(input);
      expect(result.model).toBe('inherit');
      expect(result.modifiedInput.model).toBeUndefined();
    });

    it('includes alias note in debug warning', () => {
      process.env.OMC_MODEL_ALIAS_HAIKU = 'sonnet';
      process.env.OMC_DEBUG = 'true';
      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'explore'
      };
      const result = enforceModel(input);
      expect(result.warning).toContain('aliased from haiku');
    });
  });

  describe('non-Claude provider support (issue #1201)', () => {
    const savedEnv: Record<string, string | undefined> = {};
    const envKeys = ['CLAUDE_MODEL', 'ANTHROPIC_BASE_URL', 'OMC_ROUTING_FORCE_INHERIT'];

    beforeEach(() => {
      for (const key of envKeys) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    });

    afterEach(() => {
      for (const key of envKeys) {
        if (savedEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedEnv[key];
        }
      }
    });

    it('strips model when non-Claude provider auto-enables forceInherit', () => {
      process.env.CLAUDE_MODEL = 'glm-5';
      // forceInherit is auto-enabled by loadConfig for non-Claude providers
      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'oh-my-claudecode:executor',
        model: 'sonnet'
      };
      const result = enforceModel(input);
      expect(result.model).toBe('inherit');
      expect(result.modifiedInput.model).toBeUndefined();
    });

    it('strips model when custom ANTHROPIC_BASE_URL auto-enables forceInherit', () => {
      process.env.ANTHROPIC_BASE_URL = 'https://my-proxy.example.com/v1';
      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'oh-my-claudecode:architect',
        model: 'opus'
      };
      const result = enforceModel(input);
      expect(result.model).toBe('inherit');
      expect(result.modifiedInput.model).toBeUndefined();
    });

    it('does not strip model for standard Claude setup', () => {
      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'oh-my-claudecode:executor',
        model: 'haiku'
      };
      const result = enforceModel(input);
      expect(result.model).toBe('haiku');
      expect(result.modifiedInput.model).toBe('haiku');
    });
  });
});
