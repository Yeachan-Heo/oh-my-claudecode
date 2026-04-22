/**
 * Tests for MiniMax provider detection and model constants.
 *
 * MiniMax exposes an Anthropic-compatible endpoint at
 * https://api.minimax.io/anthropic, enabling users to route OMC through
 * MiniMax by setting ANTHROPIC_BASE_URL + MINIMAX_API_KEY.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isMiniMax, isNonClaudeProvider, MINIMAX_MODELS } from '../config/models.js';

const ENV_KEYS = [
  'CLAUDE_MODEL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_BASE_URL',
  'MINIMAX_BASE_URL',
  'MINIMAX_API_KEY',
  'OMC_ROUTING_FORCE_INHERIT',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
];

describe('MINIMAX_MODELS constants', () => {
  it('exports MiniMax-M2.7 as default model', () => {
    expect(MINIMAX_MODELS.default).toBe('MiniMax-M2.7');
  });

  it('exports MiniMax-M2.7-highspeed as highspeed model', () => {
    expect(MINIMAX_MODELS.highspeed).toBe('MiniMax-M2.7-highspeed');
  });
});

describe('isMiniMax()', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('returns false when no MiniMax env vars are set', () => {
    expect(isMiniMax()).toBe(false);
  });

  it('returns true when ANTHROPIC_BASE_URL points to api.minimax.io', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
    expect(isMiniMax()).toBe(true);
  });

  it('returns true when ANTHROPIC_BASE_URL points to api.minimax.io with /v1 path', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic/v1';
    expect(isMiniMax()).toBe(true);
  });

  it('returns true when MINIMAX_BASE_URL is set', () => {
    process.env.MINIMAX_BASE_URL = 'https://api.minimax.io/anthropic';
    expect(isMiniMax()).toBe(true);
  });

  it('returns true when CLAUDE_MODEL is MiniMax-M2.7', () => {
    process.env.CLAUDE_MODEL = 'MiniMax-M2.7';
    expect(isMiniMax()).toBe(true);
  });

  it('returns true when ANTHROPIC_MODEL is MiniMax-M2.7-highspeed', () => {
    process.env.ANTHROPIC_MODEL = 'MiniMax-M2.7-highspeed';
    expect(isMiniMax()).toBe(true);
  });

  it('is case-insensitive for MiniMax model ID prefix', () => {
    process.env.CLAUDE_MODEL = 'minimax-m2.7';
    expect(isMiniMax()).toBe(true);
  });

  it('returns false for non-MiniMax model IDs', () => {
    process.env.CLAUDE_MODEL = 'claude-sonnet-4-6';
    expect(isMiniMax()).toBe(false);
  });

  it('returns false for non-MiniMax base URL', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
    expect(isMiniMax()).toBe(false);
  });

  it('returns false for other proxy base URLs', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://litellm.example.com/v1';
    expect(isMiniMax()).toBe(false);
  });
});

describe('isNonClaudeProvider() with MiniMax', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('returns true when ANTHROPIC_BASE_URL is minimax.io', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic';
    expect(isNonClaudeProvider()).toBe(true);
  });

  it('returns true when CLAUDE_MODEL is a MiniMax model', () => {
    process.env.CLAUDE_MODEL = 'MiniMax-M2.7';
    expect(isNonClaudeProvider()).toBe(true);
  });

  it('returns true when MINIMAX_BASE_URL is set', () => {
    process.env.MINIMAX_BASE_URL = 'https://api.minimax.io/anthropic';
    expect(isNonClaudeProvider()).toBe(true);
  });
});
