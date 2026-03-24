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
export {};
//# sourceMappingURL=bedrock-lm-suffix-hook.test.d.ts.map