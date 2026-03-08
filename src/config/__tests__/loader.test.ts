import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../loader.js';
import { saveAndClear, restore } from './test-helpers.js';

const ALL_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_MODEL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_BASE_URL',
  'OMC_ROUTING_FORCE_INHERIT',
  'OMC_MODEL_HIGH',
  'OMC_MODEL_MEDIUM',
  'OMC_MODEL_LOW',
] as const;

// ---------------------------------------------------------------------------
// Auto-forceInherit for Bedrock / Vertex (issues #1201, #1025)
// ---------------------------------------------------------------------------
describe('loadConfig() — auto-forceInherit for non-standard providers', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => { saved = saveAndClear(ALL_KEYS); });
  afterEach(() => { restore(saved); });

  it('auto-enables forceInherit for global. Bedrock inference profile with [1m] suffix', () => {
    process.env.ANTHROPIC_MODEL = 'global.anthropic.claude-sonnet-4-6[1m]';
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(true);
  });

  it('auto-enables forceInherit when CLAUDE_CODE_USE_BEDROCK=1', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(true);
  });

  it('auto-enables forceInherit for us. Bedrock region prefix', () => {
    process.env.ANTHROPIC_MODEL = 'us.anthropic.claude-opus-4-6-v1';
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(true);
  });

  it('auto-enables forceInherit when CLAUDE_CODE_USE_VERTEX=1', () => {
    process.env.CLAUDE_CODE_USE_VERTEX = '1';
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(true);
  });

  it('does NOT auto-enable forceInherit for standard Anthropic API usage', () => {
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6';
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(false);
  });

  it('does NOT auto-enable forceInherit when no provider env vars are set', () => {
    const config = loadConfig();
    expect(config.routing?.forceInherit).toBe(false);
  });

  it('respects explicit OMC_ROUTING_FORCE_INHERIT=false even on Bedrock', () => {
    // When user explicitly sets the var (even to false), auto-detection is skipped.
    // This matches the guard: process.env.OMC_ROUTING_FORCE_INHERIT === undefined
    process.env.ANTHROPIC_MODEL = 'global.anthropic.claude-sonnet-4-6[1m]';
    process.env.OMC_ROUTING_FORCE_INHERIT = 'false';
    const config = loadConfig();
    // env var is defined → auto-detection skipped → remains at default (false)
    expect(config.routing?.forceInherit).toBe(false);
  });
});
