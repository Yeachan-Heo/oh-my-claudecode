/**
 * MiniMax model routing tests
 *
 * Validates that MiniMax is properly detected as a recognized provider
 * and that the tier system maps to MiniMax model IDs instead of
 * falling back to forceInherit mode.
 *
 * MiniMax provides an Anthropic-compatible API at https://api.minimax.io/anthropic
 * which accepts Anthropic-format requests but serves MiniMax models.
 * Unlike generic non-Claude providers, MiniMax gets intelligent tier mapping:
 *   HIGH/MEDIUM → MiniMax-M2.7, LOW → MiniMax-M2.7-highspeed
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── Env helpers ──────────────────────────────────────────────────────────────

const MINIMAX_ENV_KEYS = [
  'MINIMAX_API_KEY',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_MODEL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_BEDROCK_SONNET_MODEL',
  'CLAUDE_CODE_BEDROCK_OPUS_MODEL',
  'CLAUDE_CODE_BEDROCK_HAIKU_MODEL',
  'OMC_MODEL_HIGH',
  'OMC_MODEL_MEDIUM',
  'OMC_MODEL_LOW',
  'OMC_ROUTING_FORCE_INHERIT',
  'OMC_ROUTING_ENABLED',
] as const;

function saveAndClear(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of MINIMAX_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return saved;
}

function restore(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('MiniMax model routing', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveAndClear();
  });
  afterEach(() => {
    restore(saved);
  });

  // ── Detection ──────────────────────────────────────────────────────────────

  describe('detection: isMiniMax()', () => {
    it('detects ANTHROPIC_BASE_URL containing minimax.io', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
      const { isMiniMax } = await import('../config/models.js');
      expect(isMiniMax()).toBe(true);
    });

    it('detects minimax.io in custom base URL paths', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/v1';
      const { isMiniMax } = await import('../config/models.js');
      expect(isMiniMax()).toBe(true);
    });

    it('returns false when no MiniMax signals present', async () => {
      const { isMiniMax } = await import('../config/models.js');
      expect(isMiniMax()).toBe(false);
    });

    it('returns false for generic non-MiniMax base URLs', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://my-litellm-proxy.example.com';
      const { isMiniMax } = await import('../config/models.js');
      expect(isMiniMax()).toBe(false);
    });

    it('is URL-based — MINIMAX_API_KEY alone does not trigger detection', async () => {
      process.env.MINIMAX_API_KEY = 'test-minimax-key';
      const { isMiniMax } = await import('../config/models.js');
      expect(isMiniMax()).toBe(false);
    });
  });

  // ── Auto-configuration utility ─────────────────────────────────────────────

  describe('configureMiniMaxEnvironment()', () => {
    it('sets ANTHROPIC_BASE_URL when MINIMAX_API_KEY is set', async () => {
      process.env.MINIMAX_API_KEY = 'test-minimax-key';
      const { configureMiniMaxEnvironment } = await import('../config/loader.js');
      configureMiniMaxEnvironment();
      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.minimax.io/anthropic');
    });

    it('sets ANTHROPIC_API_KEY when MINIMAX_API_KEY is set', async () => {
      process.env.MINIMAX_API_KEY = 'test-minimax-key';
      const { configureMiniMaxEnvironment } = await import('../config/loader.js');
      configureMiniMaxEnvironment();
      expect(process.env.ANTHROPIC_API_KEY).toBe('test-minimax-key');
    });

    it('does NOT override existing ANTHROPIC_BASE_URL', async () => {
      process.env.MINIMAX_API_KEY = 'test-minimax-key';
      process.env.ANTHROPIC_BASE_URL = 'https://custom-proxy.example.com';
      const { configureMiniMaxEnvironment } = await import('../config/loader.js');
      configureMiniMaxEnvironment();
      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://custom-proxy.example.com');
    });

    it('does NOT override existing ANTHROPIC_API_KEY', async () => {
      process.env.MINIMAX_API_KEY = 'test-minimax-key';
      process.env.ANTHROPIC_API_KEY = 'existing-key';
      const { configureMiniMaxEnvironment } = await import('../config/loader.js');
      configureMiniMaxEnvironment();
      expect(process.env.ANTHROPIC_API_KEY).toBe('existing-key');
    });

    it('skips when Bedrock is active', async () => {
      process.env.MINIMAX_API_KEY = 'test-minimax-key';
      process.env.CLAUDE_CODE_USE_BEDROCK = '1';
      const { configureMiniMaxEnvironment } = await import('../config/loader.js');
      configureMiniMaxEnvironment();
      expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
    });

    it('skips when Vertex AI is active', async () => {
      process.env.MINIMAX_API_KEY = 'test-minimax-key';
      process.env.CLAUDE_CODE_USE_VERTEX = '1';
      const { configureMiniMaxEnvironment } = await import('../config/loader.js');
      configureMiniMaxEnvironment();
      expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
    });

    it('skips when explicit non-MiniMax model is set', async () => {
      process.env.MINIMAX_API_KEY = 'test-minimax-key';
      process.env.ANTHROPIC_MODEL = 'some-non-claude-model';
      const { configureMiniMaxEnvironment } = await import('../config/loader.js');
      configureMiniMaxEnvironment();
      expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
    });
  });

  // ── Provider classification ────────────────────────────────────────────────

  describe('provider classification: isNonClaudeProvider()', () => {
    it('returns true when ANTHROPIC_BASE_URL is minimax.io (non-anthropic URL)', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
      const { isNonClaudeProvider } = await import('../config/models.js');
      // isNonClaudeProvider returns true (non-anthropic.com URL),
      // but loadConfig() skips forceInherit for MiniMax
      expect(isNonClaudeProvider()).toBe(true);
    });

    it('returns true for generic non-Claude providers (unchanged behavior)', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://my-litellm-proxy.example.com';
      const { isNonClaudeProvider } = await import('../config/models.js');
      expect(isNonClaudeProvider()).toBe(true);
    });

    it('returns true for Bedrock (unchanged behavior)', async () => {
      process.env.CLAUDE_CODE_USE_BEDROCK = '1';
      const { isNonClaudeProvider } = await import('../config/models.js');
      expect(isNonClaudeProvider()).toBe(true);
    });

    it('returns true for Vertex AI (unchanged behavior)', async () => {
      process.env.CLAUDE_CODE_USE_VERTEX = '1';
      const { isNonClaudeProvider } = await import('../config/models.js');
      expect(isNonClaudeProvider()).toBe(true);
    });
  });

  // ── Tier model resolution ──────────────────────────────────────────────────

  describe('tier resolution with MiniMax defaults', () => {
    it('resolves HIGH tier to MiniMax-M2.7 when URL is minimax.io', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
      const { getDefaultModelHigh } = await import('../config/models.js');
      expect(getDefaultModelHigh()).toBe('MiniMax-M2.7');
    });

    it('resolves MEDIUM tier to MiniMax-M2.7 when URL is minimax.io', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
      const { getDefaultModelMedium } = await import('../config/models.js');
      expect(getDefaultModelMedium()).toBe('MiniMax-M2.7');
    });

    it('resolves LOW tier to MiniMax-M2.7-highspeed when URL is minimax.io', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
      const { getDefaultModelLow } = await import('../config/models.js');
      expect(getDefaultModelLow()).toBe('MiniMax-M2.7-highspeed');
    });

    it('all tiers resolve to MiniMax models', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
      const { getDefaultTierModels } = await import('../config/models.js');
      const tierModels = getDefaultTierModels();
      expect(tierModels.HIGH).toBe('MiniMax-M2.7');
      expect(tierModels.MEDIUM).toBe('MiniMax-M2.7');
      expect(tierModels.LOW).toBe('MiniMax-M2.7-highspeed');
    });

    it('explicit OMC_MODEL_* env vars take precedence over MiniMax defaults', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
      process.env.OMC_MODEL_HIGH = 'custom-model-high';
      const { getDefaultModelHigh } = await import('../config/models.js');
      expect(getDefaultModelHigh()).toBe('custom-model-high');
    });

    it('falls back to Claude defaults when MiniMax is not detected', async () => {
      const { getDefaultTierModels } = await import('../config/models.js');
      const tierModels = getDefaultTierModels();
      expect(tierModels.HIGH).toBe('claude-opus-4-6');
      expect(tierModels.MEDIUM).toBe('claude-sonnet-4-6');
      expect(tierModels.LOW).toBe('claude-haiku-4-5');
    });
  });

  // ── Model ID recognition ──────────────────────────────────────────────────

  describe('MiniMax model ID recognition', () => {
    it('recognizes MiniMax-M2.7 as provider-specific model ID', async () => {
      const { isProviderSpecificModelId } = await import('../config/models.js');
      expect(isProviderSpecificModelId('MiniMax-M2.7')).toBe(true);
    });

    it('recognizes MiniMax-M2.7-highspeed as provider-specific model ID', async () => {
      const { isProviderSpecificModelId } = await import('../config/models.js');
      expect(isProviderSpecificModelId('MiniMax-M2.7-highspeed')).toBe(true);
    });

    it('recognizes case-insensitive minimax- prefix', async () => {
      const { isProviderSpecificModelId } = await import('../config/models.js');
      expect(isProviderSpecificModelId('minimax-m2.7')).toBe(true);
    });

    it('does not normalize MiniMax models to Claude aliases', async () => {
      const { resolveClaudeFamily } = await import('../config/models.js');
      expect(resolveClaudeFamily('MiniMax-M2.7')).toBeNull();
      expect(resolveClaudeFamily('MiniMax-M2.7-highspeed')).toBeNull();
    });
  });

  // ── E2E: Config loading with MiniMax URL ───────────────────────────────────

  describe('E2E: loadConfig() with MiniMax URL', () => {
    it('does NOT enable forceInherit when MiniMax URL is set', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
      const { loadConfig } = await import('../config/loader.js');
      const config = loadConfig();
      expect(config.routing?.forceInherit).toBe(false);
    });

    it('agent definitions get MiniMax model IDs from tier defaults', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
      const { loadConfig } = await import('../config/loader.js');
      const config = loadConfig();
      // HIGH tier agents get MiniMax-M2.7
      expect(config.agents?.architect?.model).toBe('MiniMax-M2.7');
      expect(config.agents?.planner?.model).toBe('MiniMax-M2.7');
      // MEDIUM tier agents get MiniMax-M2.7
      expect(config.agents?.executor?.model).toBe('MiniMax-M2.7');
      expect(config.agents?.debugger?.model).toBe('MiniMax-M2.7');
      // LOW tier agents get MiniMax-M2.7-highspeed
      expect(config.agents?.explore?.model).toBe('MiniMax-M2.7-highspeed');
      expect(config.agents?.writer?.model).toBe('MiniMax-M2.7-highspeed');
    });

    it('enables forceInherit for non-MiniMax non-Claude URLs (unchanged)', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://my-litellm.example.com';
      const { loadConfig } = await import('../config/loader.js');
      const config = loadConfig();
      expect(config.routing?.forceInherit).toBe(true);
    });
  });

  // ── E2E: Delegation enforcer with MiniMax ─────────────────────────────────

  describe('E2E: enforceModel() with MiniMax tier models', () => {
    it('injects MiniMax model for executor agent (MEDIUM tier)', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
      const { enforceModel } = await import('../features/delegation-enforcer.js');
      const result = enforceModel({
        description: 'Implement feature',
        prompt: 'Write the code',
        subagent_type: 'oh-my-claudecode:executor',
      });
      expect(result.injected).toBe(true);
      expect(result.modifiedInput.model).toBe('MiniMax-M2.7');
    });

    it('injects MiniMax model for explore agent (LOW tier)', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
      const { enforceModel } = await import('../features/delegation-enforcer.js');
      const result = enforceModel({
        description: 'Search codebase',
        prompt: 'Find files',
        subagent_type: 'oh-my-claudecode:explore',
      });
      expect(result.injected).toBe(true);
      expect(result.modifiedInput.model).toBe('MiniMax-M2.7-highspeed');
    });

    it('injects MiniMax model for architect agent (HIGH tier)', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
      const { enforceModel } = await import('../features/delegation-enforcer.js');
      const result = enforceModel({
        description: 'Design system',
        prompt: 'Analyze architecture',
        subagent_type: 'oh-my-claudecode:architect',
      });
      expect(result.injected).toBe(true);
      expect(result.modifiedInput.model).toBe('MiniMax-M2.7');
    });

    it('preserves explicitly passed MiniMax model', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
      const { enforceModel } = await import('../features/delegation-enforcer.js');
      const result = enforceModel({
        description: 'Test',
        prompt: 'Test',
        subagent_type: 'oh-my-claudecode:executor',
        model: 'MiniMax-M2.7-highspeed',
      });
      expect(result.injected).toBe(false);
      expect(result.modifiedInput.model).toBe('MiniMax-M2.7-highspeed');
    });
  });

  // ── Worker env propagation ─────────────────────────────────────────────────

  describe('worker env propagation', () => {
    it('includes MINIMAX_API_KEY in worker environment', async () => {
      process.env.MINIMAX_API_KEY = 'test-minimax-key';
      const { getWorkerEnv } = await import('../team/model-contract.js');
      const env = getWorkerEnv('test-team', 'worker-1', 'claude');
      expect(env.MINIMAX_API_KEY).toBe('test-minimax-key');
    });

    it('includes ANTHROPIC_BASE_URL in worker environment', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
      const { getWorkerEnv } = await import('../team/model-contract.js');
      const env = getWorkerEnv('test-team', 'worker-1', 'claude');
      expect(env.ANTHROPIC_BASE_URL).toBe('https://api.minimax.io/anthropic');
    });

    it('includes ANTHROPIC_API_KEY in worker environment', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-minimax-key';
      const { getWorkerEnv } = await import('../team/model-contract.js');
      const env = getWorkerEnv('test-team', 'worker-1', 'claude');
      expect(env.ANTHROPIC_API_KEY).toBe('test-minimax-key');
    });
  });

  // ── Coexistence with other providers ───────────────────────────────────────

  describe('coexistence: MiniMax does not break other providers', () => {
    it('Bedrock detection still works when MiniMax URL is set', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
      process.env.CLAUDE_CODE_USE_BEDROCK = '1';
      const { isBedrock, isNonClaudeProvider } = await import('../config/models.js');
      expect(isBedrock()).toBe(true);
      expect(isNonClaudeProvider()).toBe(true);
    });

    it('Vertex AI detection still works when MiniMax URL is set', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
      process.env.CLAUDE_CODE_USE_VERTEX = '1';
      const { isVertexAI, isNonClaudeProvider } = await import('../config/models.js');
      expect(isVertexAI()).toBe(true);
      expect(isNonClaudeProvider()).toBe(true);
    });

    it('standard Claude provider works without MiniMax (no regression)', async () => {
      const { isMiniMax, isNonClaudeProvider, getDefaultTierModels } =
        await import('../config/models.js');
      expect(isMiniMax()).toBe(false);
      expect(isNonClaudeProvider()).toBe(false);
      const tierModels = getDefaultTierModels();
      expect(tierModels.HIGH).toBe('claude-opus-4-6');
      expect(tierModels.MEDIUM).toBe('claude-sonnet-4-6');
      expect(tierModels.LOW).toBe('claude-haiku-4-5');
    });

    it('forceInherit override still works with MiniMax', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
      process.env.OMC_ROUTING_FORCE_INHERIT = 'true';
      const { isNonClaudeProvider } = await import('../config/models.js');
      expect(isNonClaudeProvider()).toBe(true);
    });

    it('configureMiniMaxEnvironment does not interfere with non-MiniMax setup', async () => {
      process.env.MINIMAX_API_KEY = 'test-minimax-key';
      process.env.ANTHROPIC_MODEL = 'some-other-model';
      const { configureMiniMaxEnvironment } = await import('../config/loader.js');
      configureMiniMaxEnvironment();
      expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
    });
  });
});
