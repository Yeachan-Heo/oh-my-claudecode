/**
 * Delegation Enforcer
 *
 * Middleware that ensures model parameter is always present in Task/Agent calls.
 * Automatically injects the default model from agent definitions when not specified.
 *
 * This solves the problem where Claude Code doesn't automatically apply models
 * from agent definitions - every Task call must explicitly pass the model parameter.
 *
 * For non-Claude providers (CC Switch, LiteLLM, etc.), forceInherit is auto-enabled
 * by the config loader (issue #1201), which causes this enforcer to strip model
 * parameters so agents inherit the user's configured model instead of receiving
 * Claude-specific tier names (sonnet/opus/haiku) that the provider won't recognize.
 */
import { getAgentDefinitions } from '../agents/definitions.js';
import { normalizeDelegationRole } from './delegation-routing/types.js';
import { loadConfig } from '../config/loader.js';
import { resolveClaudeFamily } from '../config/models.js';
/** Map Claude model family to CC-supported alias */
const FAMILY_TO_ALIAS = {
    SONNET: 'sonnet',
    OPUS: 'opus',
    HAIKU: 'haiku',
};
/** Normalize a model ID to a CC-supported alias (sonnet/opus/haiku) if possible */
export function normalizeToCcAlias(model) {
    const family = resolveClaudeFamily(model);
    return family ? (FAMILY_TO_ALIAS[family] ?? model) : model;
}
function canonicalizeSubagentType(subagentType) {
    const hasPrefix = subagentType.startsWith('oh-my-claudecode:');
    const rawAgentType = subagentType.replace(/^oh-my-claudecode:/, '');
    const canonicalAgentType = normalizeDelegationRole(rawAgentType);
    return hasPrefix ? `oh-my-claudecode:${canonicalAgentType}` : canonicalAgentType;
}
/**
 * Enforce model parameter for an agent delegation call
 *
 * If model is explicitly specified, it's preserved.
 * If not, the default model from agent definition is injected.
 *
 * @param agentInput - The agent/task input parameters
 * @returns Enforcement result with modified input
 * @throws Error if agent type has no default model
 */
export function enforceModel(agentInput) {
    const canonicalSubagentType = canonicalizeSubagentType(agentInput.subagent_type);
    // If forceInherit is enabled, skip model injection entirely so agents
    // inherit the user's Claude Code model setting (issue #1135)
    const config = loadConfig();
    if (config.routing?.forceInherit) {
        const { model: _existing, ...rest } = agentInput;
        const cleanedInput = { ...rest, subagent_type: canonicalSubagentType };
        return {
            originalInput: agentInput,
            modifiedInput: cleanedInput,
            injected: false,
            model: 'inherit',
        };
    }
    // If model is already specified, normalize it to CC-supported aliases
    // before passing through. Full IDs like 'claude-sonnet-4-6' cause 400
    // errors on Bedrock/Vertex. (issue #1415)
    if (agentInput.model) {
        const normalizedModel = normalizeToCcAlias(agentInput.model);
        return {
            originalInput: agentInput,
            modifiedInput: { ...agentInput, subagent_type: canonicalSubagentType, model: normalizedModel },
            injected: false,
            model: normalizedModel,
        };
    }
    const agentType = canonicalSubagentType.replace(/^oh-my-claudecode:/, '');
    const agentDefs = getAgentDefinitions({ config });
    const agentDef = agentDefs[agentType];
    if (!agentDef) {
        throw new Error(`Unknown agent type: ${agentType} (from ${agentInput.subagent_type})`);
    }
    if (!agentDef.model) {
        throw new Error(`No default model defined for agent: ${agentType}`);
    }
    // Apply modelAliases from config (issue #1211).
    // Priority: explicit param (already handled above) > modelAliases > agent default.
    // This lets users remap tier names without the nuclear forceInherit option.
    let resolvedModel = agentDef.model;
    const aliases = config.routing?.modelAliases;
    const aliasSourceModel = agentDef.defaultModel ?? agentDef.model;
    if (aliases && aliasSourceModel && aliasSourceModel !== 'inherit') {
        const alias = aliases[aliasSourceModel];
        if (alias) {
            resolvedModel = alias;
        }
    }
    // If the resolved model is 'inherit', don't inject any model parameter.
    if (resolvedModel === 'inherit') {
        const { model: _existing, ...rest } = agentInput;
        const cleanedInput = { ...rest, subagent_type: canonicalSubagentType };
        return {
            originalInput: agentInput,
            modifiedInput: cleanedInput,
            injected: false,
            model: 'inherit',
        };
    }
    // Normalize model to Claude Code's supported aliases (sonnet/opus/haiku).
    // Full IDs cause 400 errors on Bedrock/Vertex. (issue #1201, #1415)
    const normalizedModel = normalizeToCcAlias(resolvedModel);
    const modifiedInput = {
        ...agentInput,
        subagent_type: canonicalSubagentType,
        model: normalizedModel,
    };
    let warning;
    if (process.env.OMC_DEBUG === 'true') {
        const aliasNote = resolvedModel !== agentDef.model && aliasSourceModel
            ? ` (aliased from ${aliasSourceModel})`
            : '';
        const normalizedNote = normalizedModel !== resolvedModel
            ? ` (normalized from ${resolvedModel})`
            : '';
        warning = `[OMC] Auto-injecting model: ${normalizedModel} for ${agentType}${aliasNote}${normalizedNote}`;
    }
    return {
        originalInput: agentInput,
        modifiedInput,
        injected: true,
        model: normalizedModel,
        warning,
    };
}
/**
 * Check if tool input is an agent delegation call
 */
export function isAgentCall(toolName, toolInput) {
    if (toolName !== 'Agent' && toolName !== 'Task') {
        return false;
    }
    if (!toolInput || typeof toolInput !== 'object') {
        return false;
    }
    const input = toolInput;
    return (typeof input.subagent_type === 'string' &&
        typeof input.prompt === 'string' &&
        typeof input.description === 'string');
}
/**
 * Process a pre-tool-use hook for model enforcement
 */
export function processPreToolUse(toolName, toolInput) {
    if (!isAgentCall(toolName, toolInput)) {
        return { modifiedInput: toolInput };
    }
    const result = enforceModel(toolInput);
    if (result.warning) {
        console.warn(result.warning);
    }
    return {
        modifiedInput: result.modifiedInput,
        warning: result.warning,
    };
}
/**
 * Get model for an agent type (for testing/debugging)
 */
export function getModelForAgent(agentType) {
    const normalizedType = normalizeDelegationRole(agentType.replace(/^oh-my-claudecode:/, ''));
    const agentDefs = getAgentDefinitions({ config: loadConfig() });
    const agentDef = agentDefs[normalizedType];
    if (!agentDef) {
        throw new Error(`Unknown agent type: ${normalizedType}`);
    }
    if (!agentDef.model) {
        throw new Error(`No default model defined for agent: ${normalizedType}`);
    }
    // Normalize to CC-supported aliases (sonnet/opus/haiku)
    return normalizeToCcAlias(agentDef.model);
}
//# sourceMappingURL=delegation-enforcer.js.map