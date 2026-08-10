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
import { clearSkillsCache } from '../features/builtin-skills/skills.js';
import { resolveDelegation } from '../features/delegation-routing/resolver.js';

describe('delegation-enforcer', () => {
  let originalDebugEnv: string | undefined;
  // Save/restore env vars that trigger non-Claude provider detection (issue #1201)
  // so existing tests run in a standard Claude environment
  const providerEnvKeys = ['ANTHROPIC_BASE_URL', 'CLAUDE_MODEL', 'ANTHROPIC_MODEL', 'OMC_ROUTING_FORCE_INHERIT', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_BEDROCK_OPUS_MODEL', 'CLAUDE_CODE_BEDROCK_SONNET_MODEL', 'CLAUDE_CODE_BEDROCK_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'OMC_MODEL_HIGH', 'OMC_MODEL_MEDIUM', 'OMC_MODEL_LOW'];
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
    it('preserves explicitly specified model (already an alias)', () => {
      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'oh-my-claudecode:executor',
        model: 'haiku'
      };

      const result = enforceModel(input);

      expect(result.injected).toBe(false);
      expect(result.modifiedInput.model).toBe('haiku');
    });

    it('normalizes explicit full model ID to CC alias (issue #1415)', () => {
      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'oh-my-claudecode:executor',
        model: 'claude-sonnet-5'
      };

      const result = enforceModel(input);

      expect(result.injected).toBe(false);
      expect(result.modifiedInput.model).toBe('sonnet');
    });

    it('normalizes claude-fable-5 to the fable tier alias (issue #3246)', () => {
      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'oh-my-claudecode:executor',
        model: 'claude-fable-5'
      };

      const result = enforceModel(input);

      expect(result.injected).toBe(false);
      expect(result.modifiedInput.model).toBe('fable');
    });

    it('preserves explicit provider-specific Bedrock model ID', () => {
      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'oh-my-claudecode:executor',
        model: 'us.anthropic.claude-sonnet-4-6-v1:0'
      };

      const result = enforceModel(input);

      expect(result.injected).toBe(false);
      expect(result.modifiedInput.model).toBe('us.anthropic.claude-sonnet-4-6-v1:0');
    });

    it('injects model from agent definition when not specified', () => {
      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'oh-my-claudecode:executor'
      };

      const result = enforceModel(input);

      expect(result.injected).toBe(true);
      expect(result.modifiedInput.model).toBe('sonnet'); // executor defaults to claude-sonnet-5
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
      expect(result.modifiedInput.model).toBe('sonnet'); // debugger defaults to claude-sonnet-5
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
      expect(result.modifiedInput.model).toBe('sonnet');
    });

    it('throws error for unknown agent type', () => {
      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'unknown-agent'
      };

      expect(() => enforceModel(input)).toThrow('Unknown agent type');
    });
    it('throws error for a bundled skill name with Skill-tool guidance (issue #3667)', () => {
      const input: AgentInput = {
        description: 'Deslop changed files',
        prompt: 'Run the cleaner',
        subagent_type: 'oh-my-claudecode:ai-slop-cleaner'
      };

      let thrown: Error | undefined;
      try {
        enforceModel(input);
      } catch (error) {
        thrown = error as Error;
      }

      expect(thrown).toBeDefined();
      expect(thrown!.message).toContain('Unknown agent type');
      expect(thrown!.message).toContain('ai-slop-cleaner');
      expect(thrown!.message).toContain('Skill');
      expect(thrown!.message).toContain('Skill(skill="oh-my-claudecode:ai-slop-cleaner")');
      expect(thrown!.message).toContain('do NOT substitute a similarly-named agent');
    });

    it('does not add Skill guidance for genuinely unknown agents (no closest-match substitution)', () => {
      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'oh-my-claudecode:ai-slop-cleanr'
      };

      let thrown: Error | undefined;
      try {
        enforceModel(input);
      } catch (error) {
        thrown = error as Error;
      }

      expect(thrown).toBeDefined();
      expect(thrown!.message).toContain('Unknown agent type');
      expect(thrown!.message).not.toContain('Skill');
      expect(thrown!.message).not.toContain('closest match');
    });
    it('resolves the learner directory/canonical collision to skillify in the guidance (issue #3667)', () => {
      const input: AgentInput = {
        description: 'Learner task',
        prompt: 'Run it',
        subagent_type: 'oh-my-claudecode:learner'
      };

      let thrown: Error | undefined;
      try {
        enforceModel(input);
      } catch (error) {
        thrown = error as Error;
      }

      expect(thrown).toBeDefined();
      // Canonical registry precedence: skillify owns the deprecated alias.
      expect(thrown!.message).toContain('Skill(skill="oh-my-claudecode:skillify")');
      expect(thrown!.message).not.toContain('Skill(skill="oh-my-claudecode:learner")');
    });

    it('resolves the dir-only plan name to omc-plan in the guidance (hook parity)', () => {
      const input: AgentInput = {
        description: 'Plan task',
        prompt: 'Run it',
        subagent_type: 'oh-my-claudecode:plan'
      };

      let thrown: Error | undefined;
      try {
        enforceModel(input);
      } catch (error) {
        thrown = error as Error;
      }

      expect(thrown).toBeDefined();
      expect(thrown!.message).toContain('Skill(skill="oh-my-claudecode:omc-plan")');
    });
    describe('runtime-hidden skill visibility (USER_TYPE entitlement, issue #3667)', () => {
      let savedUserType: string | undefined;

      beforeEach(() => {
        savedUserType = process.env.USER_TYPE;
        clearSkillsCache();
      });

      afterEach(() => {
        if (savedUserType === undefined) {
          delete process.env.USER_TYPE;
        } else {
          process.env.USER_TYPE = savedUserType;
        }
        clearSkillsCache();
      });

      function thrownFor(subagentType: string): Error | undefined {
        try {
          enforceModel({ description: 't', prompt: 'p', subagent_type: subagentType });
        } catch (error) {
          return error as Error;
        }
        return undefined;
      }

      it.each(['remember', 'verify', 'debug'])(
        'does NOT add Skill guidance for the runtime-hidden %s skill when USER_TYPE != ant',
        (hiddenSkill) => {
          delete process.env.USER_TYPE;
          clearSkillsCache();
          const thrown = thrownFor(`oh-my-claudecode:${hiddenSkill}`);
          expect(thrown).toBeDefined();
          expect(thrown!.message).toContain('Unknown agent type');
          expect(thrown!.message).not.toContain('Skill(skill=');
        },
      );

      it.each(['remember', 'verify', 'debug'])(
        'adds Skill guidance for the %s skill when USER_TYPE=ant',
        (hiddenSkill) => {
          process.env.USER_TYPE = 'ant';
          clearSkillsCache();
          const thrown = thrownFor(`oh-my-claudecode:${hiddenSkill}`);
          expect(thrown).toBeDefined();
          expect(thrown!.message).toContain(`Skill(skill="oh-my-claudecode:${hiddenSkill}")`);
        },
      );

      it('keeps guidance for visible skills while hidden ones stay unsuggested in the same process', () => {
        delete process.env.USER_TYPE;
        clearSkillsCache();
        const visible = thrownFor('oh-my-claudecode:ai-slop-cleaner');
        const hidden = thrownFor('oh-my-claudecode:remember');
        expect(visible!.message).toContain('Skill(skill="oh-my-claudecode:ai-slop-cleaner")');
        expect(hidden!.message).not.toContain('Skill(skill=');
      });

      it('case-folds identifiers before visibility and resolution (Windows/macOS semantics, issue #3667)', () => {
        delete process.env.USER_TYPE;
        clearSkillsCache();
        const hiddenMixedCase = thrownFor('oh-my-claudecode:Remember');
        expect(hiddenMixedCase!.message).not.toContain('Skill(skill=');

        const visibleMixedCase = thrownFor('oh-my-claudecode:Plan');
        expect(visibleMixedCase!.message).toContain('Skill(skill="oh-my-claudecode:omc-plan")');

        const aliasMixedCase = thrownFor('oh-my-claudecode:LEARNER');
        expect(aliasMixedCase!.message).toContain('Skill(skill="oh-my-claudecode:skillify")');
      });

      it('case-folds the namespace prefix and hidden skills for USER_TYPE=ant', () => {
        process.env.USER_TYPE = 'ant';
        clearSkillsCache();
        const hiddenMixedCase = thrownFor('oh-my-claudecode:Remember');
        expect(hiddenMixedCase!.message).toContain('Skill(skill="oh-my-claudecode:remember")');
        const omcPrefix = thrownFor('OMC:ai-slop-cleaner');
        expect(omcPrefix!.message).toContain('Skill(skill="oh-my-claudecode:ai-slop-cleaner")');
      });
      it('preserves bare native identifiers (no Skill guidance for plan/general-purpose, issue #3667 P1)', () => {
        delete process.env.USER_TYPE;
        clearSkillsCache();
        for (const bare of ['plan', 'Plan', 'general-purpose']) {
          const thrown = thrownFor(bare);
          expect(thrown).toBeDefined();
          expect(thrown!.message).toContain('Unknown agent type');
          expect(thrown!.message).not.toContain('Skill(skill=');
        }
      });

      it('validates skill names even with an explicit model (issue #3667 P2)', () => {
        delete process.env.USER_TYPE;
        clearSkillsCache();
        let thrown: Error | undefined;
        try {
          enforceModel({
            description: 't',
            prompt: 'p',
            subagent_type: 'oh-my-claudecode:ai-slop-cleaner',
            model: 'sonnet',
          });
        } catch (error) {
          thrown = error as Error;
        }
        expect(thrown).toBeDefined();
        expect(thrown!.message).toContain('Skill(skill="oh-my-claudecode:ai-slop-cleaner")');
      });

      it('validates skill names under force-inherit routing (issue #3667 P2)', () => {
        delete process.env.USER_TYPE;
        process.env.OMC_ROUTING_FORCE_INHERIT = 'true';
        clearSkillsCache();
        let thrown: Error | undefined;
        try {
          enforceModel({ description: 't', prompt: 'p', subagent_type: 'oh-my-claudecode:ai-slop-cleaner' });
        } catch (error) {
          thrown = error as Error;
        }
        expect(thrown).toBeDefined();
        expect(thrown!.message).toContain('Skill(skill="oh-my-claudecode:ai-slop-cleaner")');
        delete process.env.OMC_ROUTING_FORCE_INHERIT;
      });

      it('keeps valid agents passing validation with an explicit model', () => {
        const result = enforceModel({ description: 't', prompt: 'p', subagent_type: 'executor', model: 'haiku' });
        expect(result.modifiedInput.model).toBe('haiku');
        expect(result.injected).toBe(false);
      });
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
      expect(resultWithDebug.warning).toContain('claude-sonnet-5');
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
        { agent: 'code-reviewer', expectedModel: 'opus' },
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
      expect(getModelForAgent('build-fixer')).toBe('sonnet');
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
    it('preserves Bedrock family env IDs without auto-enabling forceInherit from tier env alone', () => {
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

    it('preserves Bedrock family env model IDs when forceInherit is explicitly disabled', () => {
      process.env.OMC_ROUTING_FORCE_INHERIT = 'false';
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

    it('getModelForAgent preserves provider-specific IDs from Bedrock env vars', () => {
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
      expect(result.model).toBe('sonnet');
      expect(result.modifiedInput.model).toBe('sonnet');
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

    it('strips model when Bedrock ARN auto-enables forceInherit', () => {
      process.env.ANTHROPIC_MODEL = 'arn:aws:bedrock:us-east-2:123456789012:inference-profile/global.anthropic.claude-opus-4-6-v1:0';
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
