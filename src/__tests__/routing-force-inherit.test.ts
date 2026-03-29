/**
 * Tests for routing.forceInherit feature (issue #1135)
 *
 * When routing.forceInherit is true, all agents should inherit the parent
 * model instead of using OMC's per-agent model routing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  routeTask,
  getModelForTask,
} from '../features/model-routing/router.js';
import {
  enforceModel,
  processPreToolUse,
  type AgentInput,
} from '../features/delegation-enforcer.js';
import { getAgentDefinitions } from '../agents/definitions.js';

// Mock loadConfig to control forceInherit
vi.mock('../config/loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/loader.js')>();
  return {
    ...actual,
    loadConfig: vi.fn(() => ({
      ...actual.DEFAULT_CONFIG,
      routing: {
        ...actual.DEFAULT_CONFIG.routing,
        forceInherit: false,
      },
    })),
  };
});

import { loadConfig, DEFAULT_CONFIG } from '../config/loader.js';

const mockedLoadConfig = vi.mocked(loadConfig);

describe('routing.forceInherit (issue #1135)', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.OMC_ROUTING_FORCE_INHERIT;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OMC_ROUTING_FORCE_INHERIT;
    } else {
      process.env.OMC_ROUTING_FORCE_INHERIT = originalEnv;
    }
  });

  describe('routeTask with forceInherit', () => {
    it('returns inherit model type when forceInherit is true', () => {
      const result = routeTask(
        { taskPrompt: 'Find all files', agentType: 'explore' },
        { enabled: true, defaultTier: 'MEDIUM', forceInherit: true, escalationEnabled: false, maxEscalations: 0, tierModels: { LOW: 'haiku', MEDIUM: 'sonnet', HIGH: 'opus' } }
      );

      expect(result.model).toBe('inherit');
      expect(result.modelType).toBe('inherit');
      expect(result.reasons).toContain('forceInherit enabled: agents inherit parent model');
      expect(result.confidence).toBe(1.0);
    });

    it('bypasses agent-specific overrides when forceInherit is true', () => {
      const result = routeTask(
        { taskPrompt: 'Design system architecture', agentType: 'architect' },
        {
          enabled: true,
          defaultTier: 'MEDIUM',
          forceInherit: true,
          escalationEnabled: false,
          maxEscalations: 0,
          tierModels: { LOW: 'haiku', MEDIUM: 'sonnet', HIGH: 'opus' },
          agentOverrides: {
            architect: { tier: 'HIGH', reason: 'Advisory agent requires deep reasoning' },
          },
        }
      );

      expect(result.model).toBe('inherit');
      expect(result.modelType).toBe('inherit');
    });

    it('bypasses complexity-based routing when forceInherit is true', () => {
      const result = routeTask(
        {
          taskPrompt: 'Refactor the entire authentication architecture with security review and data migration',
          agentType: 'executor',
        },
        { enabled: true, defaultTier: 'MEDIUM', forceInherit: true, escalationEnabled: false, maxEscalations: 0, tierModels: { LOW: 'haiku', MEDIUM: 'sonnet', HIGH: 'opus' } }
      );

      expect(result.model).toBe('inherit');
      expect(result.modelType).toBe('inherit');
    });

    it('routes normally when forceInherit is false', () => {
      const result = routeTask(
        { taskPrompt: 'Find all files', agentType: 'explore' },
        { enabled: true, defaultTier: 'MEDIUM', forceInherit: false, escalationEnabled: false, maxEscalations: 0, tierModels: { LOW: 'haiku', MEDIUM: 'sonnet', HIGH: 'opus' } }
      );

      expect(result.model).not.toBe('inherit');
    });

    it('routes normally when forceInherit is undefined', () => {
      const result = routeTask(
        { taskPrompt: 'Find all files', agentType: 'explore' },
        { enabled: true, defaultTier: 'MEDIUM', escalationEnabled: false, maxEscalations: 0, tierModels: { LOW: 'haiku', MEDIUM: 'sonnet', HIGH: 'opus' } }
      );

      expect(result.model).not.toBe('inherit');
    });
  });

  describe('getModelForTask with forceInherit', () => {
    it('returns inherit for all agent types when forceInherit is true', () => {
      const config = { enabled: true, defaultTier: 'MEDIUM' as const, forceInherit: true, escalationEnabled: false, maxEscalations: 0, tierModels: { LOW: 'haiku', MEDIUM: 'sonnet', HIGH: 'opus' } };

      const agents = ['architect', 'executor', 'explore', 'writer', 'debugger', 'verifier'];
      for (const agent of agents) {
        const result = getModelForTask(agent, 'test task', config);
        expect(result.model).toBe('inherit');
      }
    });
  });

  describe('enforceModel with forceInherit', () => {
    it('strips model when forceInherit is true', () => {
      mockedLoadConfig.mockReturnValue({
        routing: { forceInherit: true },
      } as ReturnType<typeof loadConfig>);

      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'oh-my-claudecode:executor',
        model: 'opus',
      };

      const result = enforceModel(input);

      expect(result.modifiedInput.model).toBeUndefined();
      expect(result.injected).toBe(false);
      expect(result.model).toBe('inherit');
    });

    it('does not inject model when forceInherit is true and no model specified', () => {
      mockedLoadConfig.mockReturnValue({
        routing: { forceInherit: true },
      } as ReturnType<typeof loadConfig>);

      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'oh-my-claudecode:executor',
      };

      const result = enforceModel(input);

      expect(result.modifiedInput.model).toBeUndefined();
      expect(result.injected).toBe(false);
    });

    it('injects model normally when forceInherit is false', () => {
      mockedLoadConfig.mockReturnValue({
        routing: { forceInherit: false },
      } as ReturnType<typeof loadConfig>);

      const input: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'oh-my-claudecode:executor',
      };

      const result = enforceModel(input);

      expect(result.modifiedInput.model).toBe('sonnet');
      expect(result.injected).toBe(true);
    });
  });

  describe('config defaults', () => {
    it('DEFAULT_CONFIG has forceInherit set to false', () => {
      expect(DEFAULT_CONFIG.routing?.forceInherit).toBe(false);
    });
  });

  describe('processPreToolUse with forceInherit', () => {
    it('strips model from Task calls when forceInherit is true', () => {
      mockedLoadConfig.mockReturnValue({
        routing: { forceInherit: true },
      } as ReturnType<typeof loadConfig>);

      const toolInput: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'oh-my-claudecode:executor',
        model: 'opus',
      };

      const result = processPreToolUse('Task', toolInput);
      const modified = result.modifiedInput as AgentInput;

      expect(modified.model).toBeUndefined();
      expect(modified.prompt).toBe('Do something');
      expect(modified.subagent_type).toBe('oh-my-claudecode:executor');
    });

    it('strips model from Agent calls when forceInherit is true', () => {
      mockedLoadConfig.mockReturnValue({
        routing: { forceInherit: true },
      } as ReturnType<typeof loadConfig>);

      const toolInput: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'oh-my-claudecode:executor',
        model: 'opus',
      };

      const result = processPreToolUse('Agent', toolInput);
      const modified = result.modifiedInput as AgentInput;

      expect(modified.model).toBeUndefined();
      expect(modified.prompt).toBe('Do something');
      expect(modified.subagent_type).toBe('oh-my-claudecode:executor');
    });

    it('strips model from lowercase agent calls when forceInherit is true', () => {
      mockedLoadConfig.mockReturnValue({
        routing: { forceInherit: true },
      } as ReturnType<typeof loadConfig>);

      const toolInput: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'oh-my-claudecode:executor',
        model: 'opus',
      };

      const result = processPreToolUse('agent', toolInput);
      const modified = result.modifiedInput as AgentInput;

      expect(modified.model).toBeUndefined();
      expect(modified.subagent_type).toBe('oh-my-claudecode:executor');
    });

    it('does not strip model when forceInherit is false', () => {
      mockedLoadConfig.mockReturnValue({
        routing: { forceInherit: false },
      } as ReturnType<typeof loadConfig>);

      const toolInput: AgentInput = {
        description: 'Test task',
        prompt: 'Do something',
        subagent_type: 'oh-my-claudecode:executor',
        model: 'haiku',
      };

      const result = processPreToolUse('Task', toolInput);
      const modified = result.modifiedInput as AgentInput;

      // Should preserve the explicit model (enforceModel preserves explicit)
      expect(modified.model).toBe('haiku');
    });

    it('does not affect non-Task tool calls', () => {
      mockedLoadConfig.mockReturnValue({
        routing: { forceInherit: true },
      } as ReturnType<typeof loadConfig>);

      const toolInput = { command: 'ls -la' };
      const result = processPreToolUse('Bash', toolInput);

      expect(result.modifiedInput).toEqual(toolInput);
    });
  });
});

describe('getAgentDefinitions with forceInherit (issue #1989)', () => {
  let originalClaudeModel: string | undefined;
  let originalAnthropicModel: string | undefined;

  beforeEach(() => {
    originalClaudeModel = process.env.CLAUDE_MODEL;
    originalAnthropicModel = process.env.ANTHROPIC_MODEL;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalClaudeModel === undefined) delete process.env.CLAUDE_MODEL;
    else process.env.CLAUDE_MODEL = originalClaudeModel;

    if (originalAnthropicModel === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = originalAnthropicModel;
  });

  it('uses parent CLAUDE_MODEL for all agents when forceInherit is true', () => {
    process.env.CLAUDE_MODEL = 'accounts/fireworks/routers/kimi-k2p5-turbo';
    mockedLoadConfig.mockReturnValue({
      ...DEFAULT_CONFIG,
      routing: { ...DEFAULT_CONFIG.routing, forceInherit: true },
    } as ReturnType<typeof loadConfig>);

    const defs = getAgentDefinitions();

    // Every agent should use the parent model, not its hardcoded default
    for (const [name, def] of Object.entries(defs)) {
      expect(def.model, `agent "${name}" should inherit parent model`).toBe(
        'accounts/fireworks/routers/kimi-k2p5-turbo'
      );
    }
  });

  it('falls back to ANTHROPIC_MODEL when CLAUDE_MODEL is unset and forceInherit is true', () => {
    delete process.env.CLAUDE_MODEL;
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-6';
    mockedLoadConfig.mockReturnValue({
      ...DEFAULT_CONFIG,
      routing: { ...DEFAULT_CONFIG.routing, forceInherit: true },
    } as ReturnType<typeof loadConfig>);

    const defs = getAgentDefinitions();
    for (const def of Object.values(defs)) {
      expect(def.model).toBe('claude-opus-4-6');
    }
  });

  it('uses hardcoded agent defaults when forceInherit is false', () => {
    process.env.CLAUDE_MODEL = 'accounts/fireworks/routers/kimi-k2p5-turbo';
    mockedLoadConfig.mockReturnValue({
      ...DEFAULT_CONFIG,
      routing: { ...DEFAULT_CONFIG.routing, forceInherit: false },
    } as ReturnType<typeof loadConfig>);

    const defs = getAgentDefinitions();

    // At least some agents should NOT use the env model (they have their own defaults)
    const modelsUsed = new Set(Object.values(defs).map(d => d.model));
    expect(modelsUsed.has('accounts/fireworks/routers/kimi-k2p5-turbo')).toBe(false);
  });

  it('explicit override model still wins over forceInherit', () => {
    process.env.CLAUDE_MODEL = 'accounts/fireworks/routers/kimi-k2p5-turbo';
    mockedLoadConfig.mockReturnValue({
      ...DEFAULT_CONFIG,
      routing: { ...DEFAULT_CONFIG.routing, forceInherit: true },
    } as ReturnType<typeof loadConfig>);

    const defs = getAgentDefinitions({
      overrides: { executor: { model: 'claude-haiku-4-5-20251001' } },
    });

    expect(defs.executor?.model).toBe('claude-haiku-4-5-20251001');
  });
});
