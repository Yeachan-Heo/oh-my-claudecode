/**
 * Tests for the forceInherit hook's handling of [1m]-suffixed Bedrock model IDs.
 *
 * These tests verify the decision functions that underpin the updated forceInherit
 * block in scripts/pre-tool-enforcer.mjs. The hook uses isSubagentSafeModelId()
 * to decide whether to allow or deny an explicit `model` param, and
 * hasExtendedContextSuffix() to detect when the session model would cause a
 * silent sub-agent failure on Bedrock.
 *
 * Manual hook verification (stdin test):
 *   echo '{"tool_name":"Agent","toolInput":{},"cwd":"/tmp"}' | \
 *     ANTHROPIC_MODEL='global.anthropic.claude-sonnet-4-6[1m]' \
 *     OMC_ROUTING_FORCE_INHERIT=true \
 *     node scripts/pre-tool-enforcer.mjs
 *   → expect: deny with [1m] suffix guidance and OMC_SUBAGENT_MODEL mention
 *
 *   echo '{"tool_name":"Agent","toolInput":{"model":"us.anthropic.claude-sonnet-4-5-20250929-v1:0"},"cwd":"/tmp"}' | \
 *     ANTHROPIC_MODEL='global.anthropic.claude-sonnet-4-6[1m]' \
 *     OMC_ROUTING_FORCE_INHERIT=true \
 *     node scripts/pre-tool-enforcer.mjs
 *   → expect: continue (allowed through as valid Bedrock ID)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { hasExtendedContextSuffix, isSubagentSafeModelId, isProviderSpecificModelId, } from '../config/models.js';
import { saveAndClear, restore } from '../config/__tests__/test-helpers.js';
const ENV_KEYS = ['ANTHROPIC_MODEL', 'CLAUDE_MODEL', 'OMC_ROUTING_FORCE_INHERIT', 'OMC_SUBAGENT_MODEL'];
// ---------------------------------------------------------------------------
// Hook ALLOW path: explicit model param is a valid provider-specific ID
// ---------------------------------------------------------------------------
describe('hook allow path — isSubagentSafeModelId(model) === true', () => {
    it('allows global. cross-region Bedrock profile (the standard escape hatch)', () => {
        expect(isSubagentSafeModelId('global.anthropic.claude-sonnet-4-6-v1:0')).toBe(true);
    });
    it('allows us. regional Bedrock cross-region inference profile', () => {
        expect(isSubagentSafeModelId('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(true);
    });
    it('allows ap. regional Bedrock profile', () => {
        expect(isSubagentSafeModelId('ap.anthropic.claude-sonnet-4-6-v1:0')).toBe(true);
    });
    it('allows Bedrock ARN inference-profile format', () => {
        expect(isSubagentSafeModelId('arn:aws:bedrock:us-east-2:123456789012:inference-profile/global.anthropic.claude-opus-4-6-v1:0')).toBe(true);
    });
    it('allows Vertex AI model ID', () => {
        expect(isSubagentSafeModelId('vertex_ai/claude-sonnet-4-6@20250514')).toBe(true);
    });
});
// ---------------------------------------------------------------------------
// Hook DENY path: explicit model param is invalid for sub-agents
// ---------------------------------------------------------------------------
describe('hook deny path — explicit model param is invalid', () => {
    it('denies [1m]-suffixed model ID (the core bug case)', () => {
        expect(isSubagentSafeModelId('global.anthropic.claude-sonnet-4-6[1m]')).toBe(false);
    });
    it('denies [200k]-suffixed model ID', () => {
        expect(isSubagentSafeModelId('global.anthropic.claude-sonnet-4-6[200k]')).toBe(false);
    });
    it('denies tier alias "sonnet"', () => {
        expect(isSubagentSafeModelId('sonnet')).toBe(false);
    });
    it('denies tier alias "opus"', () => {
        expect(isSubagentSafeModelId('opus')).toBe(false);
    });
    it('denies tier alias "haiku"', () => {
        expect(isSubagentSafeModelId('haiku')).toBe(false);
    });
    it('denies bare Anthropic model ID (invalid on Bedrock)', () => {
        expect(isSubagentSafeModelId('claude-sonnet-4-6')).toBe(false);
        expect(isSubagentSafeModelId('claude-opus-4-6')).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// Session model [1m] detection — the no-model-param deny path
// ---------------------------------------------------------------------------
describe('session model [1m] detection — hasExtendedContextSuffix', () => {
    it('detects [1m] on the exact model from the bug report', () => {
        expect(hasExtendedContextSuffix('global.anthropic.claude-sonnet-4-6[1m]')).toBe(true);
    });
    it('detects [200k] on hypothetical future variant', () => {
        expect(hasExtendedContextSuffix('global.anthropic.claude-sonnet-4-6[200k]')).toBe(true);
    });
    it('does NOT flag the standard Bedrock profile without suffix', () => {
        expect(hasExtendedContextSuffix('global.anthropic.claude-sonnet-4-6-v1:0')).toBe(false);
    });
    it('does NOT flag the opus env var from the bug report env', () => {
        // ANTHROPIC_DEFAULT_OPUS_MODEL=global.anthropic.claude-opus-4-6-v1 (no [1m])
        expect(hasExtendedContextSuffix('global.anthropic.claude-opus-4-6-v1')).toBe(false);
    });
    it('does NOT flag the haiku env var from the bug report env', () => {
        // ANTHROPIC_DEFAULT_HAIKU_MODEL=global.anthropic.claude-haiku-4-5-20251001-v1:0
        expect(hasExtendedContextSuffix('global.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// Provider-specific check still correct for Bedrock IDs used in guidance
// ---------------------------------------------------------------------------
describe('isProviderSpecificModelId — Bedrock IDs used in OMC_SUBAGENT_MODEL guidance', () => {
    it('accepts the model from the 400 error message', () => {
        expect(isProviderSpecificModelId('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(true);
    });
    it('accepts [1m]-suffixed model as provider-specific (but it is NOT subagent-safe)', () => {
        // isProviderSpecificModelId detects the Bedrock prefix — the [1m] is a secondary check
        expect(isProviderSpecificModelId('global.anthropic.claude-sonnet-4-6[1m]')).toBe(true);
        // But isSubagentSafeModelId combines both checks and rejects it
        expect(isSubagentSafeModelId('global.anthropic.claude-sonnet-4-6[1m]')).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// Environment-based session model detection (simulates hook reading env vars)
// ---------------------------------------------------------------------------
describe('environment-based session model detection', () => {
    let saved;
    beforeEach(() => { saved = saveAndClear(ENV_KEYS); });
    afterEach(() => { restore(saved); });
    it('detects [1m] session model via ANTHROPIC_MODEL env var', () => {
        process.env.ANTHROPIC_MODEL = 'global.anthropic.claude-sonnet-4-6[1m]';
        const sessionModel = process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL || '';
        expect(hasExtendedContextSuffix(sessionModel)).toBe(true);
    });
    it('detects [1m] session model via CLAUDE_MODEL env var', () => {
        process.env.CLAUDE_MODEL = 'global.anthropic.claude-sonnet-4-6[1m]';
        const sessionModel = process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL || '';
        expect(hasExtendedContextSuffix(sessionModel)).toBe(true);
    });
    it('does not flag missing env vars', () => {
        const sessionModel = process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL || '';
        expect(hasExtendedContextSuffix(sessionModel)).toBe(false);
    });
    it('does not flag a valid Bedrock model in env vars', () => {
        process.env.ANTHROPIC_MODEL = 'global.anthropic.claude-opus-4-6-v1';
        const sessionModel = process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL || '';
        expect(hasExtendedContextSuffix(sessionModel)).toBe(false);
    });
});
//# sourceMappingURL=bedrock-lm-suffix-hook.test.js.map