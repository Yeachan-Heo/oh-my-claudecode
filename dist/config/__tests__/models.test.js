import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isBedrock, isVertexAI, isNonClaudeProvider, isProviderSpecificModelId, resolveClaudeFamily, hasExtendedContextSuffix, isSubagentSafeModelId, } from '../models.js';
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
    it('detects Bedrock inference-profile ARNs', () => {
        process.env.ANTHROPIC_MODEL = 'arn:aws:bedrock:us-east-2:123456789012:inference-profile/global.anthropic.claude-opus-4-6-v1:0';
        expect(isBedrock()).toBe(true);
    });
    it('detects Bedrock application-inference-profile ARNs', () => {
        process.env.CLAUDE_MODEL = 'arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/abc123/global.anthropic.claude-sonnet-4-6-v1:0';
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
    it('returns true for Bedrock inference-profile ARNs', () => {
        process.env.ANTHROPIC_MODEL = 'arn:aws:bedrock:us-east-2:123456789012:inference-profile/global.anthropic.claude-opus-4-6-v1:0';
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
// isProviderSpecificModelId() — issue #1695
// ---------------------------------------------------------------------------
describe('isProviderSpecificModelId()', () => {
    it('detects Bedrock region-prefixed model IDs', () => {
        expect(isProviderSpecificModelId('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(true);
        expect(isProviderSpecificModelId('global.anthropic.claude-opus-4-6-v1:0')).toBe(true);
        expect(isProviderSpecificModelId('eu.anthropic.claude-haiku-4-5-v1:0')).toBe(true);
        expect(isProviderSpecificModelId('ap.anthropic.claude-sonnet-4-6-v1:0')).toBe(true);
    });
    it('detects Bedrock bare anthropic.claude prefix (legacy)', () => {
        expect(isProviderSpecificModelId('anthropic.claude-3-haiku-20240307-v1:0')).toBe(true);
    });
    it('detects Bedrock ARN formats', () => {
        expect(isProviderSpecificModelId('arn:aws:bedrock:us-east-2:123456789012:inference-profile/global.anthropic.claude-opus-4-6-v1:0')).toBe(true);
        expect(isProviderSpecificModelId('arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/abc123/global.anthropic.claude-sonnet-4-6-v1:0')).toBe(true);
    });
    it('detects Vertex AI model IDs', () => {
        expect(isProviderSpecificModelId('vertex_ai/claude-sonnet-4-6@20250514')).toBe(true);
    });
    it('returns false for bare Anthropic API model IDs', () => {
        expect(isProviderSpecificModelId('claude-sonnet-4-6')).toBe(false);
        expect(isProviderSpecificModelId('claude-opus-4-6')).toBe(false);
        expect(isProviderSpecificModelId('claude-haiku-4-5')).toBe(false);
    });
    it('returns false for aliases', () => {
        expect(isProviderSpecificModelId('sonnet')).toBe(false);
        expect(isProviderSpecificModelId('opus')).toBe(false);
        expect(isProviderSpecificModelId('haiku')).toBe(false);
    });
    it('returns false for non-Claude model IDs', () => {
        expect(isProviderSpecificModelId('gpt-4o')).toBe(false);
        expect(isProviderSpecificModelId('gemini-1.5-pro')).toBe(false);
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
// ---------------------------------------------------------------------------
// hasExtendedContextSuffix() — issue: [1m] suffix breaks Bedrock sub-agents
// ---------------------------------------------------------------------------
describe('hasExtendedContextSuffix()', () => {
    it('detects [1m] suffix (1M context window annotation)', () => {
        expect(hasExtendedContextSuffix('global.anthropic.claude-sonnet-4-6[1m]')).toBe(true);
    });
    it('detects [200k] suffix (200k context window annotation)', () => {
        expect(hasExtendedContextSuffix('global.anthropic.claude-sonnet-4-6[200k]')).toBe(true);
    });
    it('detects [100k] suffix', () => {
        expect(hasExtendedContextSuffix('us.anthropic.claude-opus-4-6[100k]')).toBe(true);
    });
    it('returns false for standard Bedrock cross-region profile ID', () => {
        expect(hasExtendedContextSuffix('global.anthropic.claude-sonnet-4-6-v1:0')).toBe(false);
    });
    it('returns false for versioned Bedrock ID without suffix', () => {
        expect(hasExtendedContextSuffix('global.anthropic.claude-opus-4-6-v1')).toBe(false);
    });
    it('returns false for bare Anthropic model ID', () => {
        expect(hasExtendedContextSuffix('claude-sonnet-4-6')).toBe(false);
    });
    it('returns false for tier aliases', () => {
        expect(hasExtendedContextSuffix('sonnet')).toBe(false);
        expect(hasExtendedContextSuffix('opus')).toBe(false);
        expect(hasExtendedContextSuffix('haiku')).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// isSubagentSafeModelId() — safe to pass as `model` param on Bedrock/Vertex
// ---------------------------------------------------------------------------
describe('isSubagentSafeModelId()', () => {
    it('accepts global. cross-region Bedrock profile without suffix', () => {
        expect(isSubagentSafeModelId('global.anthropic.claude-sonnet-4-6-v1:0')).toBe(true);
    });
    it('accepts us. regional Bedrock profile', () => {
        expect(isSubagentSafeModelId('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(true);
    });
    it('accepts eu. regional Bedrock profile', () => {
        expect(isSubagentSafeModelId('eu.anthropic.claude-haiku-4-5-v1:0')).toBe(true);
    });
    it('accepts Bedrock ARN format', () => {
        expect(isSubagentSafeModelId('arn:aws:bedrock:us-east-2:123456789012:inference-profile/global.anthropic.claude-opus-4-6-v1:0')).toBe(true);
    });
    it('accepts Vertex AI model ID', () => {
        expect(isSubagentSafeModelId('vertex_ai/claude-sonnet-4-6@20250514')).toBe(true);
    });
    it('rejects [1m]-suffixed model ID — the core bug case', () => {
        expect(isSubagentSafeModelId('global.anthropic.claude-sonnet-4-6[1m]')).toBe(false);
    });
    it('rejects [200k]-suffixed model ID', () => {
        expect(isSubagentSafeModelId('global.anthropic.claude-sonnet-4-6[200k]')).toBe(false);
    });
    it('rejects bare Anthropic model ID (not provider-specific)', () => {
        expect(isSubagentSafeModelId('claude-sonnet-4-6')).toBe(false);
    });
    it('rejects tier alias "sonnet"', () => {
        expect(isSubagentSafeModelId('sonnet')).toBe(false);
    });
    it('rejects tier alias "opus"', () => {
        expect(isSubagentSafeModelId('opus')).toBe(false);
    });
    it('rejects tier alias "haiku"', () => {
        expect(isSubagentSafeModelId('haiku')).toBe(false);
    });
});
//# sourceMappingURL=models.test.js.map