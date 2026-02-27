/**
 * Delegation Enforcer
 *
 * Middleware that ensures model parameter is always present in Task/Agent calls.
 * Automatically injects the default model from agent definitions when not specified.
 *
 * This solves the problem where Claude Code doesn't automatically apply models
 * from agent definitions - every Task call must explicitly pass the model parameter.
 */
import { getAgentDefinitions } from '../agents/definitions.js';
import { normalizeDelegationRole } from './delegation-routing/types.js';
import { loadConfig } from '../config/loader.js';
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
    // If forceInherit is enabled, skip model injection entirely so agents
    // inherit the user's Claude Code model setting (issue #1135)
    const config = loadConfig();
    if (config.routing?.forceInherit) {
        // Strip model if present, or leave as-is if not
        const { model: _existing, ...rest } = agentInput;
        const cleanedInput = rest;
        return {
            originalInput: agentInput,
            modifiedInput: cleanedInput,
            injected: false,
            model: 'inherit',
        };
    }
    // If model is already specified, return as-is
    if (agentInput.model) {
        return {
            originalInput: agentInput,
            modifiedInput: agentInput,
            injected: false,
            model: agentInput.model,
        };
    }
    // Extract agent type (strip oh-my-claudecode: prefix if present)
    const rawAgentType = agentInput.subagent_type.replace(/^oh-my-claudecode:/, '');
    // Normalize deprecated role aliases before registry lookup
    const agentType = normalizeDelegationRole(rawAgentType);
    // Get agent definition
    const agentDefs = getAgentDefinitions();
    const agentDef = agentDefs[agentType];
    if (!agentDef) {
        throw new Error(`Unknown agent type: ${agentType} (from ${agentInput.subagent_type})`);
    }
    if (!agentDef.model) {
        throw new Error(`No default model defined for agent: ${agentType}`);
    }
    // Convert ModelType to SDK model type
    const sdkModel = convertToSdkModel(agentDef.model);
    // Create modified input with model injected
    const modifiedInput = {
        ...agentInput,
        model: sdkModel,
    };
    // Create warning message (only shown if OMC_DEBUG=true)
    let warning;
    if (process.env.OMC_DEBUG === 'true') {
        warning = `[OMC] Auto-injecting model: ${sdkModel} for ${agentType}`;
    }
    return {
        originalInput: agentInput,
        modifiedInput,
        injected: true,
        model: agentDef.model,
        warning,
    };
}
/**
 * Convert ModelType to SDK model format
 */
function convertToSdkModel(model) {
    if (model === 'inherit') {
        return 'sonnet'; // Default fallback
    }
    return model;
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
 *
 * @param toolName - The tool being invoked
 * @param toolInput - The tool input parameters
 * @returns Modified tool input with model enforced, or original if not an agent call
 */
export function processPreToolUse(toolName, toolInput) {
    // Check if this is an agent delegation call
    if (!isAgentCall(toolName, toolInput)) {
        return { modifiedInput: toolInput };
    }
    // Enforce model parameter
    const result = enforceModel(toolInput);
    // Log warning if debug mode is enabled and model was injected
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
 *
 * @param agentType - The agent type (with or without oh-my-claudecode: prefix)
 * @returns The default model for the agent
 * @throws Error if agent type not found or has no model
 */
export function getModelForAgent(agentType) {
    const normalizedType = agentType.replace(/^oh-my-claudecode:/, '');
    const agentDefs = getAgentDefinitions();
    const agentDef = agentDefs[normalizedType];
    if (!agentDef) {
        throw new Error(`Unknown agent type: ${normalizedType}`);
    }
    if (!agentDef.model) {
        throw new Error(`No default model defined for agent: ${normalizedType}`);
    }
    return agentDef.model;
}
//# sourceMappingURL=delegation-enforcer.js.map