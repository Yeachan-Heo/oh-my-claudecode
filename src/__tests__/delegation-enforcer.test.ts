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
      expect(result.modifiedInput.model).toBe('sonnet'); // executor defaults to sonnet
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
      expect(result.modifiedInput.model).toBe('sonnet'); // debugger defaults to sonnet
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
      expect(resultWithDebug.warning).toContain('sonnet');
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
        { agent: 'architect', expectedModel: 'opus' },
        { agent: 'executor', expectedModel: 'sonnet' },
        { agent: 'explore', expectedModel: 'haiku' },
        { agent: 'designer', expectedModel: 'sonnet' },
        { agent: 'debugger', expectedModel: 'sonnet' },
        { agent: 'verifier', expectedModel: 'sonnet' },
        { agent: 'quality-reviewer', expectedModel: 'sonnet' },
        { agent: 'test-engineer', expectedModel: 'sonnet' }
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

    it('enforces model for agent calls', () => {
      const toolInput: AgentInput = {
        description: 'Test',
        prompt: 'Test',
        subagent_type: 'executor'
      };

      const result = processPreToolUse('Agent', toolInput);

      expect(result.modifiedInput).toHaveProperty('model', 'sonnet');
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
      expect(getModelForAgent('oh-my-claudecode:executor')).toBe('sonnet');
      expect(getModelForAgent('oh-my-claudecode:debugger')).toBe('sonnet');
      expect(getModelForAgent('oh-my-claudecode:architect')).toBe('opus');
    });

    it('returns correct model for agent without prefix', () => {
      expect(getModelForAgent('executor')).toBe('sonnet');
      expect(getModelForAgent('debugger')).toBe('sonnet');
      expect(getModelForAgent('architect')).toBe('opus');
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

    it('routes performance-reviewer to quality-reviewer', () => {
      const result = resolveDelegation({ agentRole: 'performance-reviewer' });
      expect(result.provider).toBe('claude');
      expect(result.tool).toBe('Task');
      expect(result.agentOrModel).toBe('quality-reviewer');
    });

    it('routes dependency-expert to document-specialist', () => {
      const result = resolveDelegation({ agentRole: 'dependency-expert' });
      expect(result.provider).toBe('claude');
      expect(result.tool).toBe('Task');
      expect(result.agentOrModel).toBe('document-specialist');
    });

    it('routes quality-strategist to quality-reviewer', () => {
      const result = resolveDelegation({ agentRole: 'quality-strategist' });
      expect(result.provider).toBe('claude');
      expect(result.tool).toBe('Task');
      expect(result.agentOrModel).toBe('quality-reviewer');
    });

    it('routes vision to document-specialist', () => {
      const result = resolveDelegation({ agentRole: 'vision' });
      expect(result.provider).toBe('claude');
      expect(result.tool).toBe('Task');
      expect(result.agentOrModel).toBe('document-specialist');
    });
  });
});
