/**
 * Repro test for Bedrock model routing bug
 *
 * Bug: On Bedrock, workers get model ID "claude-sonnet-4-6" (bare builtin default)
 * instead of inheriting the parent model. On Bedrock, this bare ID is invalid
 * — Bedrock requires full IDs like "us.anthropic.claude-sonnet-4-6-v1:0".
 *
 * Root cause chain:
 * 1. buildDefaultConfig() → config.agents.executor.model = 'claude-sonnet-4-6'
 *    (from CLAUDE_FAMILY_DEFAULTS.SONNET, because no Bedrock env vars found)
 * 2. getAgentDefinitions() resolves executor.model = 'claude-sonnet-4-6'
 *    (configuredModel from config takes precedence over agent's defaultModel)
 * 3. enforceModel() injects 'claude-sonnet-4-6' into Task calls
 * 4. Claude Code passes it to Bedrock API → 400 invalid model
 *
 * The defense (forceInherit) works IF CLAUDE_CODE_USE_BEDROCK=1 is in the env.
 * But if that env var doesn't propagate to the MCP server / hook process,
 * forceInherit is never auto-enabled, and bare model IDs leak through.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// ── Env helpers ──────────────────────────────────────────────────────────────
const BEDROCK_ENV_KEYS = [
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_MODEL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'CLAUDE_CODE_BEDROCK_SONNET_MODEL',
    'CLAUDE_CODE_BEDROCK_OPUS_MODEL',
    'CLAUDE_CODE_BEDROCK_HAIKU_MODEL',
    'OMC_MODEL_HIGH',
    'OMC_MODEL_MEDIUM',
    'OMC_MODEL_LOW',
    'OMC_ROUTING_FORCE_INHERIT',
    'OMC_ROUTING_ENABLED',
];
function saveAndClear() {
    const saved = {};
    for (const key of BEDROCK_ENV_KEYS) {
        saved[key] = process.env[key];
        delete process.env[key];
    }
    return saved;
}
function restore(saved) {
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined)
            delete process.env[key];
        else
            process.env[key] = value;
    }
}
// ── Tests ────────────────────────────────────────────────────────────────────
describe('Bedrock model routing repro', () => {
    let saved;
    beforeEach(() => {
        saved = saveAndClear();
    });
    afterEach(() => {
        restore(saved);
    });
    // ── Unit tests: building blocks ────────────────────────────────────────────
    describe('detection: isBedrock()', () => {
        it('detects CLAUDE_CODE_USE_BEDROCK=1', async () => {
            process.env.CLAUDE_CODE_USE_BEDROCK = '1';
            const { isBedrock } = await import('../config/models.js');
            expect(isBedrock()).toBe(true);
        });
        it('detects Bedrock model ID in CLAUDE_MODEL', async () => {
            process.env.CLAUDE_MODEL = 'us.anthropic.claude-sonnet-4-6-v1:0';
            const { isBedrock } = await import('../config/models.js');
            expect(isBedrock()).toBe(true);
        });
        it('detects Bedrock model ID in ANTHROPIC_MODEL', async () => {
            process.env.ANTHROPIC_MODEL = 'global.anthropic.claude-sonnet-4-6-v1:0';
            const { isBedrock } = await import('../config/models.js');
            expect(isBedrock()).toBe(true);
        });
        it('returns false when no Bedrock signals present', async () => {
            const { isBedrock } = await import('../config/models.js');
            expect(isBedrock()).toBe(false);
        });
    });
    describe('tier resolution: getDefaultModelMedium()', () => {
        it('reads ANTHROPIC_DEFAULT_SONNET_MODEL', async () => {
            process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'global.anthropic.claude-sonnet-4-6-v1:0';
            const { getDefaultModelMedium } = await import('../config/models.js');
            expect(getDefaultModelMedium()).toBe('global.anthropic.claude-sonnet-4-6-v1:0');
        });
        it('falls back to bare "claude-sonnet-4-6" without env vars', async () => {
            const { getDefaultModelMedium } = await import('../config/models.js');
            // getDefaultModelMedium returns the raw config value (not normalized)
            expect(getDefaultModelMedium()).toBe('claude-sonnet-4-6');
        });
    });
    // ── E2E Repro Scenario A ──────────────────────────────────────────────────
    // CLAUDE_CODE_USE_BEDROCK=1 not propagated to MCP/hook process
    describe('SCENARIO A: CLAUDE_CODE_USE_BEDROCK not propagated to hook process', () => {
        it('full chain: Task call injects invalid model for Bedrock', async () => {
            // ── Setup: simulate MCP server process that did NOT inherit
            //    CLAUDE_CODE_USE_BEDROCK from parent Claude Code process ──
            // (all Bedrock env vars already cleared by beforeEach)
            // 1. Bedrock detection fails
            const { isBedrock, isNonClaudeProvider } = await import('../config/models.js');
            expect(isBedrock()).toBe(false);
            expect(isNonClaudeProvider()).toBe(false);
            // 2. loadConfig does NOT auto-enable forceInherit
            const { loadConfig } = await import('../config/loader.js');
            const config = loadConfig();
            expect(config.routing?.forceInherit).toBe(false);
            // 3. Agent definitions use full builtin model IDs from config
            const { getAgentDefinitions } = await import('../agents/definitions.js');
            const defs = getAgentDefinitions({ config });
            expect(defs['executor'].model).toBe('claude-sonnet-4-6');
            expect(defs['explore'].model).toBe('claude-haiku-4-5');
            expect(defs['architect'].model).toBe('claude-opus-4-6');
            // 4. enforceModel normalizes to bare CC-supported aliases (FIX)
            const { enforceModel } = await import('../features/delegation-enforcer.js');
            // 4a. executor → 'sonnet' (normalized from config's full model ID)
            const executorResult = enforceModel({
                description: 'Implement feature',
                prompt: 'Write the code',
                subagent_type: 'oh-my-claudecode:executor',
            });
            expect(executorResult.injected).toBe(true);
            expect(executorResult.modifiedInput.model).toBe('sonnet');
            // 4b. explore → 'haiku'
            const exploreResult = enforceModel({
                description: 'Find files',
                prompt: 'Search codebase',
                subagent_type: 'oh-my-claudecode:explore',
            });
            expect(exploreResult.injected).toBe(true);
            expect(exploreResult.modifiedInput.model).toBe('haiku');
            // 4c. architect → 'opus'
            const architectResult = enforceModel({
                description: 'Design system',
                prompt: 'Analyze architecture',
                subagent_type: 'oh-my-claudecode:architect',
            });
            expect(architectResult.injected).toBe(true);
            expect(architectResult.modifiedInput.model).toBe('opus');
            // 5. After fix: these are valid CC aliases that CC resolves on any provider
            expect(['sonnet', 'opus', 'haiku'].includes(executorResult.modifiedInput.model)).toBe(true);
            expect(['sonnet', 'opus', 'haiku'].includes(exploreResult.modifiedInput.model)).toBe(true);
            expect(['sonnet', 'opus', 'haiku'].includes(architectResult.modifiedInput.model)).toBe(true);
        });
        it('the defense works when CLAUDE_CODE_USE_BEDROCK IS propagated', async () => {
            // Same scenario but with the env var properly set
            process.env.CLAUDE_CODE_USE_BEDROCK = '1';
            const { isBedrock } = await import('../config/models.js');
            expect(isBedrock()).toBe(true);
            const { loadConfig } = await import('../config/loader.js');
            const config = loadConfig();
            expect(config.routing?.forceInherit).toBe(true);
            const { enforceModel } = await import('../features/delegation-enforcer.js');
            // All agents get model stripped → inherit parent
            for (const agent of ['executor', 'explore', 'architect', 'debugger', 'verifier']) {
                const result = enforceModel({
                    description: 'test',
                    prompt: 'test',
                    subagent_type: `oh-my-claudecode:${agent}`,
                });
                expect(result.model).toBe('inherit');
                expect(result.modifiedInput.model).toBeUndefined();
            }
        });
    });
    // ── E2E Repro Scenario B ──────────────────────────────────────────────────
    // User has ANTHROPIC_DEFAULT_SONNET_MODEL in Bedrock format,
    // but CLAUDE_CODE_USE_BEDROCK and CLAUDE_MODEL/ANTHROPIC_MODEL are missing
    describe('SCENARIO B: Bedrock tier env vars set but detection misses them', () => {
        it('full chain: isBedrock misses Bedrock model in ANTHROPIC_DEFAULT_*_MODEL', async () => {
            // ── Setup: user has Bedrock-format models in ANTHROPIC_DEFAULT_*_MODEL
            //    (as shown in their settings) but CLAUDE_CODE_USE_BEDROCK is not set ──
            process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'global.anthropic.claude-sonnet-4-6-v1:0';
            process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'global.anthropic.claude-opus-4-6-v1:0';
            process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'global.anthropic.claude-haiku-4-5-v1:0';
            // 1. isBedrock does NOT check ANTHROPIC_DEFAULT_*_MODEL env vars
            const { isBedrock, isNonClaudeProvider } = await import('../config/models.js');
            expect(isBedrock()).toBe(false);
            expect(isNonClaudeProvider()).toBe(false);
            // 2. forceInherit is NOT auto-enabled
            const { loadConfig } = await import('../config/loader.js');
            const config = loadConfig();
            expect(config.routing?.forceInherit).toBe(false);
            // 3. BUT tier model resolution DOES read the Bedrock IDs
            const { getDefaultModelMedium, getDefaultModelHigh, getDefaultModelLow } = await import('../config/models.js');
            expect(getDefaultModelMedium()).toBe('global.anthropic.claude-sonnet-4-6-v1:0');
            expect(getDefaultModelHigh()).toBe('global.anthropic.claude-opus-4-6-v1:0');
            expect(getDefaultModelLow()).toBe('global.anthropic.claude-haiku-4-5-v1:0');
            // 4. config.agents get the Bedrock-format model IDs
            expect(config.agents?.executor?.model).toBe('global.anthropic.claude-sonnet-4-6-v1:0');
            expect(config.agents?.architect?.model).toBe('global.anthropic.claude-opus-4-6-v1:0');
            expect(config.agents?.explore?.model).toBe('global.anthropic.claude-haiku-4-5-v1:0');
            // 5. enforceModel normalizes to bare alias (FIX: no longer injects full IDs)
            const { enforceModel } = await import('../features/delegation-enforcer.js');
            const result = enforceModel({
                description: 'Implement feature',
                prompt: 'Write the code',
                subagent_type: 'oh-my-claudecode:executor',
            });
            expect(result.injected).toBe(true);
            // After the fix: enforceModel normalizes to 'sonnet' (CC-supported alias)
            // instead of the full Bedrock ID from config
            expect(result.modifiedInput.model).toBe('sonnet');
            // Note: forceInherit should still ideally be enabled for Bedrock,
            // but even without it, 'sonnet' is safe — Claude Code resolves it
            // to the correct Bedrock model ID internally.
        });
        it('isBedrock should detect Bedrock patterns in tier env vars', async () => {
            // Verify the detection gap: ANTHROPIC_DEFAULT_*_MODEL values contain
            // Bedrock patterns but isBedrock only checks CLAUDE_MODEL/ANTHROPIC_MODEL
            process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'global.anthropic.claude-sonnet-4-6-v1:0';
            const { isBedrock, hasTierModelEnvOverrides } = await import('../config/models.js');
            // The env var IS detected by hasTierModelEnvOverrides
            expect(hasTierModelEnvOverrides()).toBe(true);
            // But isBedrock doesn't use it
            expect(isBedrock()).toBe(false);
            // A fix: isBedrock() should also scan tier env vars for Bedrock patterns
        });
    });
    // ── E2E Repro: LLM bypasses hook by passing model directly ────────────────
    describe('SCENARIO C: LLM passes explicit model in Task call', () => {
        it('bridge hook strips model when forceInherit is enabled', async () => {
            // When forceInherit IS enabled, the bridge pre-tool-use hook at
            // bridge.ts:1082-1093 strips the model param from Task calls.
            // This works correctly.
            process.env.CLAUDE_CODE_USE_BEDROCK = '1';
            const { loadConfig } = await import('../config/loader.js');
            const config = loadConfig();
            expect(config.routing?.forceInherit).toBe(true);
            // Simulate what the bridge does:
            const taskInput = {
                description: 'Implement feature',
                prompt: 'Write the code',
                subagent_type: 'oh-my-claudecode:executor',
                model: 'sonnet', // LLM passes this based on CLAUDE.md instructions
            };
            // Bridge logic (bridge.ts:1082-1093):
            const nextTaskInput = { ...taskInput };
            if (nextTaskInput.model && config.routing?.forceInherit) {
                delete nextTaskInput.model;
            }
            expect(nextTaskInput.model).toBeUndefined();
            // Worker inherits parent → works on Bedrock
        });
        it('bridge hook does NOT strip model when forceInherit is disabled', async () => {
            // Without forceInherit, the explicit model from LLM passes through
            // (no Bedrock env vars → forceInherit=false)
            const { loadConfig } = await import('../config/loader.js');
            const config = loadConfig();
            expect(config.routing?.forceInherit).toBe(false);
            // Simulate what the bridge does:
            const taskInput = {
                description: 'Implement feature',
                prompt: 'Write the code',
                subagent_type: 'oh-my-claudecode:executor',
                model: 'sonnet', // LLM passes this based on CLAUDE.md instructions
            };
            const nextTaskInput = { ...taskInput };
            if (nextTaskInput.model && config.routing?.forceInherit) {
                delete nextTaskInput.model;
            }
            // Model NOT stripped → 'sonnet' passes through to Claude Code
            expect(nextTaskInput.model).toBe('sonnet');
            // Claude Code resolves 'sonnet' → 'claude-sonnet-4-6' → Bedrock 400
        });
        it('even when enforceModel strips, LLM can still pass model directly', async () => {
            // The LLM can pass model: "sonnet" in the Task call because the
            // CLAUDE.md instructions say: "Pass model on Task calls: haiku, sonnet, opus"
            //
            // enforceModel only runs when model is NOT specified (it injects default).
            // If the LLM explicitly passes model, enforceModel preserves it (line 83-90).
            // Only the bridge hook strip (lines 1082-1093) catches explicit models.
            // Without forceInherit, explicit model from LLM passes straight through
            const { enforceModel } = await import('../features/delegation-enforcer.js');
            const result = enforceModel({
                description: 'Implement feature',
                prompt: 'Write the code',
                subagent_type: 'oh-my-claudecode:executor',
                model: 'sonnet', // LLM passes this explicitly
            });
            // enforceModel preserves explicit model (doesn't override it)
            expect(result.injected).toBe(false);
            expect(result.modifiedInput.model).toBe('sonnet');
            // → Claude Code resolves 'sonnet' → Bedrock can't handle it → 400
        });
    });
    // ── Summary: which scenario matches the reported error? ────────────────────
    describe('DIAGNOSIS: matching error to scenario', () => {
        it('reported error uses "claude-sonnet-4-6" → matches enforceModel injection path', async () => {
            const { enforceModel } = await import('../features/delegation-enforcer.js');
            const result = enforceModel({
                description: 'test',
                prompt: 'test',
                subagent_type: 'oh-my-claudecode:executor',
            });
            // This is exactly the model ID from the error report
            expect(result.modifiedInput.model).toBe('sonnet');
        });
    });
    // ── FIX VERIFICATION ──────────────────────────────────────────────────────
    describe('FIX: PreToolUse hook denies Task calls with model on Bedrock', () => {
        it('returns permissionDecision:deny when Task has model and forceInherit is enabled', async () => {
            process.env.CLAUDE_CODE_USE_BEDROCK = '1';
            // Import the bridge processPreToolUse indirectly by calling processHookBridge
            const bridge = await import('../hooks/bridge.js');
            // Simulate a PreToolUse hook input for a Task call with model
            const hookInput = {
                sessionId: 'test-session',
                toolName: 'Task',
                toolInput: {
                    description: 'Implement feature',
                    prompt: 'Write the code',
                    subagent_type: 'oh-my-claudecode:executor',
                    model: 'claude-sonnet-4-6',
                },
                directory: process.cwd(),
            };
            const result = await bridge.processHook('pre-tool-use', hookInput);
            const parsed = typeof result === 'string' ? JSON.parse(result) : result;
            // Should deny with permissionDecision
            expect(parsed.hookSpecificOutput?.permissionDecision).toBe('deny');
            expect(parsed.hookSpecificOutput?.permissionDecisionReason).toContain('claude-sonnet-4-6');
            expect(parsed.hookSpecificOutput?.permissionDecisionReason).toContain('model');
        });
        it('allows Task calls without model even on Bedrock', async () => {
            process.env.CLAUDE_CODE_USE_BEDROCK = '1';
            const bridge = await import('../hooks/bridge.js');
            const hookInput = {
                sessionId: 'test-session',
                toolName: 'Task',
                toolInput: {
                    description: 'Implement feature',
                    prompt: 'Write the code',
                    subagent_type: 'oh-my-claudecode:executor',
                    // No model param — this is the correct behavior
                },
                directory: process.cwd(),
            };
            const result = await bridge.processHook('pre-tool-use', hookInput);
            const parsed = typeof result === 'string' ? JSON.parse(result) : result;
            // Should allow (no deny)
            expect(parsed.hookSpecificOutput?.permissionDecision).not.toBe('deny');
        });
        it('allows Task calls with model when NOT on Bedrock', async () => {
            // No Bedrock env → forceInherit=false → model allowed
            const bridge = await import('../hooks/bridge.js');
            const hookInput = {
                sessionId: 'test-session',
                toolName: 'Task',
                toolInput: {
                    description: 'Implement feature',
                    prompt: 'Write the code',
                    subagent_type: 'oh-my-claudecode:executor',
                    model: 'sonnet',
                },
                directory: process.cwd(),
            };
            const result = await bridge.processHook('pre-tool-use', hookInput);
            const parsed = typeof result === 'string' ? JSON.parse(result) : result;
            // Should allow (no deny)
            expect(parsed.hookSpecificOutput?.permissionDecision).not.toBe('deny');
        });
    });
    describe('FIX: SessionStart injects Bedrock model routing override', () => {
        it('injects override message when forceInherit is enabled', async () => {
            process.env.CLAUDE_CODE_USE_BEDROCK = '1';
            const bridge = await import('../hooks/bridge.js');
            const hookInput = {
                sessionId: 'test-session',
                directory: process.cwd(),
            };
            const result = await bridge.processHook('session-start', hookInput);
            const parsed = typeof result === 'string' ? JSON.parse(result) : result;
            // Should contain Bedrock override instruction
            expect(parsed.message).toContain('MODEL ROUTING OVERRIDE');
            expect(parsed.message).toContain('Do NOT pass the `model` parameter');
        });
        it('does NOT inject override when not on Bedrock', async () => {
            const bridge = await import('../hooks/bridge.js');
            const hookInput = {
                sessionId: 'test-session',
                directory: process.cwd(),
            };
            const result = await bridge.processHook('session-start', hookInput);
            const parsed = typeof result === 'string' ? JSON.parse(result) : result;
            const message = parsed.message ?? '';
            expect(message).not.toContain('MODEL ROUTING OVERRIDE');
        });
    });
});
//# sourceMappingURL=bedrock-model-routing.test.js.map