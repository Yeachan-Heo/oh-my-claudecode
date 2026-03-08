import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isBedrock, isVertexAI, isNonClaudeProvider, resolveClaudeFamily, } from '../models.js';
import { saveAndClear, restore } from './test-helpers.js';
const BEDROCK_KEYS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_MODEL', 'ANTHROPIC_MODEL'];
const VERTEX_KEYS = ['CLAUDE_CODE_USE_VERTEX', 'CLAUDE_MODEL', 'ANTHROPIC_MODEL'];
const ALL_KEYS = [
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_MODEL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_BASE_URL',
    'OMC_ROUTING_FORCE_INHERIT',
];
// ---------------------------------------------------------------------------
// isBedrock()
// ---------------------------------------------------------------------------
describe('isBedrock()', () => {
    let saved;
    beforeEach(() => { saved = saveAndClear(BEDROCK_KEYS); });
    afterEach(() => { restore(saved); });
    it('returns true when CLAUDE_CODE_USE_BEDROCK=1', () => {
        process.env.CLAUDE_CODE_USE_BEDROCK = '1';
        expect(isBedrock()).toBe(true);
    });
    it('returns false when CLAUDE_CODE_USE_BEDROCK=0', () => {
        process.env.CLAUDE_CODE_USE_BEDROCK = '0';
        expect(isBedrock()).toBe(false);
    });
    // --- ANTHROPIC_MODEL pattern detection ---
    it('detects global. inference profile — the [1m] 1M-context case', () => {
        process.env.ANTHROPIC_MODEL = 'global.anthropic.claude-sonnet-4-6[1m]';
        expect(isBedrock()).toBe(true);
    });
    it('detects global. inference profile without suffix', () => {
        process.env.ANTHROPIC_MODEL = 'global.anthropic.claude-sonnet-4-6-v1:0';
        expect(isBedrock()).toBe(true);
    });
    it('detects us. region prefix', () => {
        process.env.ANTHROPIC_MODEL = 'us.anthropic.claude-opus-4-6-v1';
        expect(isBedrock()).toBe(true);
    });
    it('detects eu. region prefix', () => {
        process.env.ANTHROPIC_MODEL = 'eu.anthropic.claude-haiku-4-5-v1:0';
        expect(isBedrock()).toBe(true);
    });
    it('detects ap. region prefix', () => {
        process.env.ANTHROPIC_MODEL = 'ap.anthropic.claude-sonnet-4-6-v1:0';
        expect(isBedrock()).toBe(true);
    });
    it('detects bare anthropic.claude prefix (legacy Bedrock IDs)', () => {
        process.env.ANTHROPIC_MODEL = 'anthropic.claude-3-haiku-20240307-v1:0';
        expect(isBedrock()).toBe(true);
    });
    it('also checks CLAUDE_MODEL', () => {
        process.env.CLAUDE_MODEL = 'global.anthropic.claude-sonnet-4-6[1m]';
        expect(isBedrock()).toBe(true);
    });
    it('returns false for bare Anthropic model IDs', () => {
        process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6';
        expect(isBedrock()).toBe(false);
    });
    it('returns false when no relevant env var is set', () => {
        expect(isBedrock()).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// isVertexAI()
// ---------------------------------------------------------------------------
describe('isVertexAI()', () => {
    let saved;
    beforeEach(() => { saved = saveAndClear(VERTEX_KEYS); });
    afterEach(() => { restore(saved); });
    it('returns true when CLAUDE_CODE_USE_VERTEX=1', () => {
        process.env.CLAUDE_CODE_USE_VERTEX = '1';
        expect(isVertexAI()).toBe(true);
    });
    it('detects vertex_ai/ prefix in ANTHROPIC_MODEL', () => {
        process.env.ANTHROPIC_MODEL = 'vertex_ai/claude-sonnet-4-6@20250301';
        expect(isVertexAI()).toBe(true);
    });
    it('returns false for Bedrock or bare model IDs', () => {
        process.env.ANTHROPIC_MODEL = 'global.anthropic.claude-sonnet-4-6[1m]';
        expect(isVertexAI()).toBe(false);
    });
    it('returns false when CLAUDE_CODE_USE_VERTEX=0', () => {
        process.env.CLAUDE_CODE_USE_VERTEX = '0';
        expect(isVertexAI()).toBe(false);
    });
    it('returns false when no relevant env var is set', () => {
        expect(isVertexAI()).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// isNonClaudeProvider()
// ---------------------------------------------------------------------------
describe('isNonClaudeProvider()', () => {
    let saved;
    beforeEach(() => { saved = saveAndClear(ALL_KEYS); });
    afterEach(() => { restore(saved); });
    it('returns true for global. Bedrock inference profile (the [1m] case)', () => {
        process.env.ANTHROPIC_MODEL = 'global.anthropic.claude-sonnet-4-6[1m]';
        expect(isNonClaudeProvider()).toBe(true);
    });
    it('returns true when CLAUDE_CODE_USE_BEDROCK=1', () => {
        process.env.CLAUDE_CODE_USE_BEDROCK = '1';
        expect(isNonClaudeProvider()).toBe(true);
    });
    it('returns true when CLAUDE_CODE_USE_VERTEX=1', () => {
        process.env.CLAUDE_CODE_USE_VERTEX = '1';
        expect(isNonClaudeProvider()).toBe(true);
    });
    it('returns true when OMC_ROUTING_FORCE_INHERIT=true', () => {
        process.env.OMC_ROUTING_FORCE_INHERIT = 'true';
        expect(isNonClaudeProvider()).toBe(true);
    });
    it('returns false for standard Anthropic API bare model IDs', () => {
        process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6';
        expect(isNonClaudeProvider()).toBe(false);
    });
    it('returns false when no env vars are set', () => {
        expect(isNonClaudeProvider()).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// resolveClaudeFamily() — ensure Bedrock profile IDs map to correct families
// ---------------------------------------------------------------------------
describe('resolveClaudeFamily() — Bedrock inference profile IDs', () => {
    it('resolves global. sonnet [1m] profile to SONNET', () => {
        expect(resolveClaudeFamily('global.anthropic.claude-sonnet-4-6[1m]')).toBe('SONNET');
    });
    it('resolves us. opus profile to OPUS', () => {
        expect(resolveClaudeFamily('us.anthropic.claude-opus-4-6-v1')).toBe('OPUS');
    });
    it('resolves eu. haiku profile to HAIKU', () => {
        expect(resolveClaudeFamily('eu.anthropic.claude-haiku-4-5-v1:0')).toBe('HAIKU');
    });
    it('resolves bare Anthropic model IDs', () => {
        expect(resolveClaudeFamily('claude-sonnet-4-6')).toBe('SONNET');
        expect(resolveClaudeFamily('claude-opus-4-6')).toBe('OPUS');
        expect(resolveClaudeFamily('claude-haiku-4-5')).toBe('HAIKU');
    });
    it('returns null for non-Claude model IDs', () => {
        expect(resolveClaudeFamily('gpt-4o')).toBeNull();
        expect(resolveClaudeFamily('gemini-1.5-pro')).toBeNull();
    });
});
//# sourceMappingURL=models.test.js.map