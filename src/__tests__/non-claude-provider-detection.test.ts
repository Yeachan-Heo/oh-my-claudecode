/**
 * Tests for non-Claude provider auto-detection (issue #1201)
 * and Bedrock/Vertex AI auto-detection
 *
 * When CC Switch or similar tools route requests to non-Claude providers,
 * or when running on AWS Bedrock or Google Vertex AI, OMC should
 * auto-enable forceInherit to avoid passing Claude-specific model tier
 * names (sonnet/opus/haiku) that cause 400 errors.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isNonClaudeProvider, isBedrock, isVertexAI } from '../config/models.js';
import { loadConfig } from '../config/loader.js';

describe('isNonClaudeProvider (issue #1201)', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    'CLAUDE_MODEL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_BASE_URL',
    'OMC_ROUTING_FORCE_INHERIT',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'OMC_MODEL_HIGH',
    'OMC_MODEL_MEDIUM',
    'OMC_MODEL_LOW',
    'CLAUDE_CODE_BEDROCK_OPUS_MODEL',
    'CLAUDE_CODE_BEDROCK_SONNET_MODEL',
    'CLAUDE_CODE_BEDROCK_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  ];

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

  it('returns false when no env vars are set (default Claude provider)', () => {
    expect(isNonClaudeProvider()).toBe(false);
  });

  it('returns true when CLAUDE_MODEL is a non-Claude model', () => {
    process.env.CLAUDE_MODEL = 'glm-5';
    expect(isNonClaudeProvider()).toBe(true);
  });

  it('returns true when ANTHROPIC_MODEL is a non-Claude model', () => {
    process.env.ANTHROPIC_MODEL = 'MiniMax-Text-01';
    expect(isNonClaudeProvider()).toBe(true);
  });

  it('returns false when CLAUDE_MODEL contains "claude"', () => {
    process.env.CLAUDE_MODEL = 'claude-sonnet-4-6';
    expect(isNonClaudeProvider()).toBe(false);
  });

  it('returns true when ANTHROPIC_BASE_URL is a non-Anthropic URL', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://my-proxy.example.com/v1';
    expect(isNonClaudeProvider()).toBe(true);
  });

  it('returns false when ANTHROPIC_BASE_URL is anthropic.com', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
    expect(isNonClaudeProvider()).toBe(false);
  });

  it('returns true when OMC_ROUTING_FORCE_INHERIT is already true', () => {
    process.env.OMC_ROUTING_FORCE_INHERIT = 'true';
    expect(isNonClaudeProvider()).toBe(true);
  });

  it('detects kimi model as non-Claude', () => {
    process.env.CLAUDE_MODEL = 'kimi-k2';
    expect(isNonClaudeProvider()).toBe(true);
  });

  it('is case-insensitive for Claude detection in model name', () => {
    process.env.CLAUDE_MODEL = 'Claude-Sonnet-4-6';
    expect(isNonClaudeProvider()).toBe(false);
  });

  it('returns true when ANTHROPIC_DEFAULT_SONNET_MODEL is non-Claude', () => {
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'kimi-k2.6:cloud';
    expect(isNonClaudeProvider()).toBe(true);
  });

  it('returns true when OMC_MODEL_MEDIUM is non-Claude', () => {
    process.env.OMC_MODEL_MEDIUM = 'glm-5.1:cloud';
    expect(isNonClaudeProvider()).toBe(true);
  });

  // --- Bedrock detection ---

  it('returns true when CLAUDE_CODE_USE_BEDROCK=1', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    expect(isNonClaudeProvider()).toBe(true);
  });

  it('returns true for Bedrock model ID with us.anthropic prefix', () => {
    process.env.CLAUDE_MODEL = 'us.anthropic.claude-sonnet-4-6-v1:0';
    expect(isNonClaudeProvider()).toBe(true);
  });

  it('returns true for Bedrock model ID with global.anthropic prefix', () => {
    process.env.CLAUDE_MODEL = 'global.anthropic.claude-3-5-sonnet-20241022-v2:0';
    expect(isNonClaudeProvider()).toBe(true);
  });

  it('returns true for Bedrock model ID with bare anthropic prefix', () => {
    process.env.ANTHROPIC_MODEL = 'anthropic.claude-3-haiku-20240307-v1:0';
    expect(isNonClaudeProvider()).toBe(true);
  });

  it('returns true for Bedrock model ID with eu.anthropic prefix', () => {
    process.env.CLAUDE_MODEL = 'eu.anthropic.claude-sonnet-4-6-v1:0';
    expect(isNonClaudeProvider()).toBe(true);
  });

  // --- Vertex AI detection ---

  it('returns true when CLAUDE_CODE_USE_VERTEX=1', () => {
    process.env.CLAUDE_CODE_USE_VERTEX = '1';
    expect(isNonClaudeProvider()).toBe(true);
  });

  it('returns true for Vertex model ID with vertex_ai/ prefix', () => {
    process.env.CLAUDE_MODEL = 'vertex_ai/claude-sonnet-4-5';
    expect(isNonClaudeProvider()).toBe(true);
  });
});

describe('isBedrock()', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_MODEL', 'ANTHROPIC_MODEL'];

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

  it('returns true when CLAUDE_CODE_USE_BEDROCK=1', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    expect(isBedrock()).toBe(true);
  });

  it('returns false when CLAUDE_CODE_USE_BEDROCK is not set', () => {
    expect(isBedrock()).toBe(false);
  });

  it('returns false when CLAUDE_CODE_USE_BEDROCK=0', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '0';
    expect(isBedrock()).toBe(false);
  });

  it('detects us.anthropic.claude model ID pattern', () => {
    process.env.CLAUDE_MODEL = 'us.anthropic.claude-sonnet-4-6-v1:0';
    expect(isBedrock()).toBe(true);
  });

  it('detects global.anthropic.claude model ID pattern', () => {
    process.env.ANTHROPIC_MODEL = 'global.anthropic.claude-3-5-sonnet-20241022-v2:0';
    expect(isBedrock()).toBe(true);
  });

  it('detects bare anthropic.claude model ID pattern', () => {
    process.env.CLAUDE_MODEL = 'anthropic.claude-3-haiku-20240307-v1:0';
    expect(isBedrock()).toBe(true);
  });

  it('detects eu.anthropic.claude model ID pattern', () => {
    process.env.CLAUDE_MODEL = 'eu.anthropic.claude-opus-4-6-v1:0';
    expect(isBedrock()).toBe(true);
  });

  it('detects ap.anthropic.claude model ID pattern', () => {
    process.env.ANTHROPIC_MODEL = 'ap.anthropic.claude-sonnet-4-6-v1:0';
    expect(isBedrock()).toBe(true);
  });

  it('does not match standard Claude model IDs', () => {
    process.env.CLAUDE_MODEL = 'claude-sonnet-4-6';
    expect(isBedrock()).toBe(false);
  });

  it('does not match non-Claude model IDs', () => {
    process.env.CLAUDE_MODEL = 'glm-5';
    expect(isBedrock()).toBe(false);
  });

  it('detects Bedrock model ID with extended output tokens suffix', () => {
    process.env.ANTHROPIC_MODEL = 'us.anthropic.claude-opus-4-6-v1[1m]';
    expect(isBedrock()).toBe(true);
  });
});

describe('isVertexAI()', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ['CLAUDE_CODE_USE_VERTEX', 'CLAUDE_MODEL', 'ANTHROPIC_MODEL'];

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

  it('returns true when CLAUDE_CODE_USE_VERTEX=1', () => {
    process.env.CLAUDE_CODE_USE_VERTEX = '1';
    expect(isVertexAI()).toBe(true);
  });

  it('returns false when CLAUDE_CODE_USE_VERTEX is not set', () => {
    expect(isVertexAI()).toBe(false);
  });

  it('returns false when CLAUDE_CODE_USE_VERTEX=0', () => {
    process.env.CLAUDE_CODE_USE_VERTEX = '0';
    expect(isVertexAI()).toBe(false);
  });

  it('detects vertex_ai/ prefix in CLAUDE_MODEL', () => {
    process.env.CLAUDE_MODEL = 'vertex_ai/claude-sonnet-4-5';
    expect(isVertexAI()).toBe(true);
  });

  it('detects vertex_ai/ prefix in ANTHROPIC_MODEL', () => {
    process.env.ANTHROPIC_MODEL = 'vertex_ai/claude-3-5-sonnet';
    expect(isVertexAI()).toBe(true);
  });

  it('is case-insensitive for vertex_ai/ prefix', () => {
    process.env.CLAUDE_MODEL = 'Vertex_AI/claude-sonnet-4-5';
    expect(isVertexAI()).toBe(true);
  });

  it('does not match standard Claude model IDs', () => {
    process.env.CLAUDE_MODEL = 'claude-sonnet-4-6';
    expect(isVertexAI()).toBe(false);
  });

  it('does not match Bedrock model IDs', () => {
    process.env.CLAUDE_MODEL = 'us.anthropic.claude-sonnet-4-6-v1:0';
    expect(isVertexAI()).toBe(false);
  });
});

describe('loadConfig auto-enables forceInherit for non-Claude providers (issue #1201)', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    'CLAUDE_MODEL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_BASE_URL',
    'OMC_ROUTING_FORCE_INHERIT',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'OMC_MODEL_HIGH',
    'OMC_MODEL_MEDIUM',
    'OMC_MODEL_LOW',
    'CLAUDE_CODE_BEDROCK_OPUS_MODEL',
    'CLAUDE_CODE_BEDROCK_SONNET_MODEL',
    'CLAUDE_CODE_BEDROCK_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  ];

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

  it('auto-enables forceInherit when CLAUDE_MODEL is non-Claude', () => {
    process.env.CLAUDE_MODEL = 'glm-5';
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(true);
  });

  it('does not auto-enable forceInherit for partial OMC tier env overrides', () => {
    process.env.OMC_MODEL_HIGH = 'glm-5.1:cloud';
    const config = loadConfig();

    expect(config.routing?.forceInherit).toBe(false);
    expect(config.agents?.architect?.model).toBe('glm-5.1:cloud');
    expect(config.agents?.executor?.model).toContain('claude-sonnet');
  });

  it('auto-enables forceInherit when ANTHROPIC_BASE_URL is non-Anthropic', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://litellm.example.com/v1';
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(true);
  });

  it('does NOT auto-enable forceInherit for default Claude setup', () => {
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(false);
  });

  it('respects explicit OMC_ROUTING_FORCE_INHERIT=false even with non-Claude model', () => {
    process.env.CLAUDE_MODEL = 'glm-5';
    process.env.OMC_ROUTING_FORCE_INHERIT = 'false';
    const config = loadConfig();
    // User explicitly set forceInherit=false, but our auto-detection
    // checks OMC_ROUTING_FORCE_INHERIT === undefined, so explicit false
    // means the env config sets it to false, then auto-detect skips
    // because env var is defined.
    expect(config.routing?.forceInherit).toBe(false);
  });

  it('does not double-enable when OMC_ROUTING_FORCE_INHERIT=true is already set', () => {
    process.env.OMC_ROUTING_FORCE_INHERIT = 'true';
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(true);
  });

  // --- Bedrock integration ---

  it('auto-enables forceInherit when CLAUDE_CODE_USE_BEDROCK=1', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(true);
  });

  it('auto-enables forceInherit when Bedrock model ID is detected', () => {
    process.env.ANTHROPIC_MODEL = 'us.anthropic.claude-sonnet-4-6-v1:0';
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(true);
  });

  it('respects explicit OMC_ROUTING_FORCE_INHERIT=false even on Bedrock', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    process.env.OMC_ROUTING_FORCE_INHERIT = 'false';
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(false);
  });

  // --- Vertex AI integration ---

  it('auto-enables forceInherit when CLAUDE_CODE_USE_VERTEX=1', () => {
    process.env.CLAUDE_CODE_USE_VERTEX = '1';
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(true);
  });

  it('auto-enables forceInherit when Vertex model ID is detected', () => {
    process.env.CLAUDE_MODEL = 'vertex_ai/claude-sonnet-4-5';
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(true);
  });
});
