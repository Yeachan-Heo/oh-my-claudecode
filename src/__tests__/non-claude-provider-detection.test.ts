/**
 * Tests for non-Claude provider auto-detection (issue #1201)
 *
 * When CC Switch or similar tools route requests to non-Claude providers,
 * OMC should auto-enable forceInherit to avoid passing Claude-specific
 * model tier names (sonnet/opus/haiku) that cause 400 errors.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isNonClaudeProvider } from '../config/models.js';
import { loadConfig } from '../config/loader.js';

describe('isNonClaudeProvider (issue #1201)', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    'CLAUDE_MODEL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_BASE_URL',
    'OMC_ROUTING_FORCE_INHERIT',
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
});

describe('loadConfig auto-enables forceInherit for non-Claude providers (issue #1201)', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    'CLAUDE_MODEL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_BASE_URL',
    'OMC_ROUTING_FORCE_INHERIT',
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
});
