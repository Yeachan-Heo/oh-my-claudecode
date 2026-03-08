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
    'CLAUDE_CODE_BEDROCK_OPUS_MODEL',
    'CLAUDE_CODE_BEDROCK_SONNET_MODEL',
    'CLAUDE_CODE_BEDROCK_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
];
// ---------------------------------------------------------------------------
// Auto-forceInherit for Bedrock / Vertex (issues #1201, #1025)
// ---------------------------------------------------------------------------
describe('loadConfig() — auto-forceInherit for non-standard providers', () => {
    let saved;
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
    it('maps Bedrock family env vars into agent defaults and routing tiers', () => {
        process.env.CLAUDE_CODE_BEDROCK_OPUS_MODEL = 'us.anthropic.claude-opus-4-6-v1:0';
        process.env.CLAUDE_CODE_BEDROCK_SONNET_MODEL = 'us.anthropic.claude-sonnet-4-6-v1:0';
        process.env.CLAUDE_CODE_BEDROCK_HAIKU_MODEL = 'us.anthropic.claude-haiku-4-5-v1:0';
        const config = loadConfig();
        expect(config.agents?.architect?.model).toBe('us.anthropic.claude-opus-4-6-v1:0');
        expect(config.agents?.executor?.model).toBe('us.anthropic.claude-sonnet-4-6-v1:0');
        expect(config.agents?.explore?.model).toBe('us.anthropic.claude-haiku-4-5-v1:0');
        expect(config.routing?.tierModels?.HIGH).toBe('us.anthropic.claude-opus-4-6-v1:0');
        expect(config.routing?.tierModels?.MEDIUM).toBe('us.anthropic.claude-sonnet-4-6-v1:0');
        expect(config.routing?.tierModels?.LOW).toBe('us.anthropic.claude-haiku-4-5-v1:0');
    });
    it('supports Anthropic family-default env vars for tiered routing defaults', () => {
        process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-4-6-custom';
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-4-6-custom';
        process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5-custom';
        const config = loadConfig();
        expect(config.agents?.architect?.model).toBe('claude-opus-4-6-custom');
        expect(config.agents?.executor?.model).toBe('claude-sonnet-4-6-custom');
        expect(config.agents?.explore?.model).toBe('claude-haiku-4-5-custom');
    });
});
//# sourceMappingURL=loader.test.js.map