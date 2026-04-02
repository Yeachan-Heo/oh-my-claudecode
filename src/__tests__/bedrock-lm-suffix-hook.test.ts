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
 *   → expect: continue (stripped ID is provider-specific — inheritance is safe)
 *
 *   echo '{"tool_name":"Agent","toolInput":{},"cwd":"/tmp"}' | \
 *     ANTHROPIC_MODEL='claude-sonnet-4-6[1m]' \
 *     OMC_ROUTING_FORCE_INHERIT=true \
 *     node scripts/pre-tool-enforcer.mjs
 *   → expect: deny (stripped ID is a bare Anthropic model ID, invalid on Bedrock)
 *
 *   echo '{"tool_name":"Agent","toolInput":{"model":"us.anthropic.claude-sonnet-4-5-20250929-v1:0"},"cwd":"/tmp"}' | \
 *     ANTHROPIC_MODEL='global.anthropic.claude-sonnet-4-6[1m]' \
 *     OMC_ROUTING_FORCE_INHERIT=true \
 *     node scripts/pre-tool-enforcer.mjs
 *   → expect: continue (allowed through as valid Bedrock ID)
 */

import { spawnSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  hasExtendedContextSuffix,
  isSubagentSafeModelId,
  isProviderSpecificModelId,
} from '../config/models.js';
import { saveAndClear, restore } from '../config/__tests__/test-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = resolve(__dirname, '../../scripts/pre-tool-enforcer.mjs');

const ENV_KEYS = ['ANTHROPIC_MODEL', 'CLAUDE_MODEL', 'OMC_ROUTING_FORCE_INHERIT', 'OMC_SUBAGENT_MODEL'] as const;

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
    expect(isSubagentSafeModelId(
      'arn:aws:bedrock:us-east-2:123456789012:inference-profile/global.anthropic.claude-opus-4-6-v1:0'
    )).toBe(true);
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
  let saved: Record<string, string | undefined>;

  beforeEach(() => { saved = saveAndClear(ENV_KEYS); });
  afterEach(() => { restore(saved); });

  // Helper matching the dual-check logic in pre-tool-enforcer.mjs
  const sessionHasLmSuffix = () =>
    hasExtendedContextSuffix(process.env.CLAUDE_MODEL || '') ||
    hasExtendedContextSuffix(process.env.ANTHROPIC_MODEL || '');

  it('detects [1m] session model via ANTHROPIC_MODEL env var', () => {
    process.env.ANTHROPIC_MODEL = 'global.anthropic.claude-sonnet-4-6[1m]';
    expect(sessionHasLmSuffix()).toBe(true);
  });

  it('detects [1m] session model via CLAUDE_MODEL env var', () => {
    process.env.CLAUDE_MODEL = 'global.anthropic.claude-sonnet-4-6[1m]';
    expect(sessionHasLmSuffix()).toBe(true);
  });

  it('detects [1m] when only ANTHROPIC_MODEL has suffix and CLAUDE_MODEL is set without it', () => {
    // Split-brain scenario: CLAUDE_MODEL is clean but ANTHROPIC_MODEL carries [1m].
    // A single CLAUDE_MODEL || ANTHROPIC_MODEL lookup would miss this.
    process.env.CLAUDE_MODEL = 'global.anthropic.claude-sonnet-4-6-v1:0';
    process.env.ANTHROPIC_MODEL = 'global.anthropic.claude-sonnet-4-6[1m]';
    expect(sessionHasLmSuffix()).toBe(true);
  });

  it('does not flag missing env vars', () => {
    expect(sessionHasLmSuffix()).toBe(false);
  });

  it('does not flag a valid Bedrock model in env vars', () => {
    process.env.ANTHROPIC_MODEL = 'global.anthropic.claude-opus-4-6-v1';
    expect(sessionHasLmSuffix()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hook integration tests — spawn the hook and verify stdin→stdout behaviour
// ---------------------------------------------------------------------------

function runHook(
  toolInput: Record<string, unknown>,
  env: Record<string, string>,
): { denied: boolean; reason?: string } {
  const stdin = JSON.stringify({
    tool_name: 'Agent',
    toolInput,
    cwd: '/tmp',
    session_id: 'test-hook-integration',
  });
  const result = spawnSync('node', [HOOK_PATH], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, ...env, OMC_ROUTING_FORCE_INHERIT: 'true' },
    timeout: 10000,
  });
  const lines = (result.stdout || '').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.hookSpecificOutput?.permissionDecision === 'deny') {
        return { denied: true, reason: parsed.hookSpecificOutput.permissionDecisionReason };
      }
    } catch {
      // non-JSON line — skip
    }
  }
  return { denied: false };
}

describe('hook integration — force-inherit + [1m] scenarios', () => {
  it('denies [1m]-suffixed explicit model param', () => {
    const result = runHook(
      { model: 'global.anthropic.claude-sonnet-4-6[1m]' },
      { ANTHROPIC_MODEL: 'global.anthropic.claude-sonnet-4-6[1m]' },
    );
    expect(result.denied).toBe(true);
    expect(result.reason).toMatch(/\[1m\]/);
    expect(result.reason).toMatch(/MODEL ROUTING/);
  });

  it('allows valid Bedrock cross-region profile through without denying', () => {
    const result = runHook(
      { model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' },
      { ANTHROPIC_MODEL: 'global.anthropic.claude-sonnet-4-6[1m]' },
    );
    expect(result.denied).toBe(false);
  });

  it('denies no-model call when session model has [1m] suffix and guides to tier alias', () => {
    const result = runHook(
      {},
      { ANTHROPIC_MODEL: 'global.anthropic.claude-sonnet-4-6[1m]' },
    );
    expect(result.denied).toBe(true);
    // Guidance must recommend a tier alias (sonnet/haiku/opus), not a raw Bedrock ID.
    // Agent tool schema only accepts tier aliases for the model param.
    expect(result.reason).toMatch(/model="sonnet"/);
    expect(result.reason).toMatch(/global\.anthropic\.claude-sonnet-4-6\[1m\]/);
  });

  it('derives tier alias from OMC_SUBAGENT_MODEL when set', () => {
    const result = runHook(
      {},
      {
        ANTHROPIC_MODEL: 'global.anthropic.claude-sonnet-4-6[1m]',
        OMC_SUBAGENT_MODEL: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      },
    );
    expect(result.denied).toBe(true);
    // normalizeToCcAlias('us.anthropic.claude-sonnet-4-5-...') → 'sonnet'
    expect(result.reason).toMatch(/model="sonnet"/);
  });

  it('denies no-model call when only ANTHROPIC_MODEL has [1m] suffix (any [1m] triggers deny)', () => {
    // Our policy: any [1m] suffix in session model vars triggers deny and tier-alias guidance.
    // Even if stripped ID would be provider-specific, we always guide to tier alias for safety.
    const result = runHook(
      {},
      {
        CLAUDE_MODEL: 'global.anthropic.claude-sonnet-4-6-v1:0',
        ANTHROPIC_MODEL: 'global.anthropic.claude-sonnet-4-6[1m]',
      },
    );
    expect(result.denied).toBe(true);
    expect(result.reason).toMatch(/model="sonnet"/);
  });

  it('denies no-model call when session model is a bare Anthropic ID with [1m] suffix', () => {
    // claude-sonnet-4-6[1m] → session has [1m] → deny with tier alias guidance
    const result = runHook(
      {},
      { ANTHROPIC_MODEL: 'claude-sonnet-4-6[1m]' },
    );
    expect(result.denied).toBe(true);
    expect(result.reason).toMatch(/model="sonnet"/);
    expect(result.reason).toMatch(/claude-sonnet-4-6\[1m\]/);
  });

  it('derives tier alias from OMC_SUBAGENT_MODEL for guidance in [1m] deny', () => {
    // normalizeToCcAlias('us.anthropic.claude-sonnet-4-5-20250929-v1:0') → 'sonnet'
    const result = runHook(
      {},
      {
        ANTHROPIC_MODEL: 'claude-sonnet-4-6[1m]',
        OMC_SUBAGENT_MODEL: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      },
    );
    expect(result.denied).toBe(true);
    expect(result.reason).toMatch(/model="sonnet"/);
  });

  it('denies no-model call when CLAUDE_MODEL is provider-specific[1m] but ANTHROPIC_MODEL is bare[1m]', () => {
    // Mixed case: CLAUDE_MODEL strips safely, but ANTHROPIC_MODEL strips to a bare Anthropic ID.
    // The runtime (resolveClaudeWorkerModel) may pick ANTHROPIC_MODEL, so both must be safe.
    const result = runHook(
      {},
      {
        CLAUDE_MODEL: 'global.anthropic.claude-sonnet-4-6[1m]',
        ANTHROPIC_MODEL: 'claude-sonnet-4-6[1m]',
      },
    );
    expect(result.denied).toBe(true);
    expect(result.reason).toMatch(/model="sonnet"/);
  });
});
