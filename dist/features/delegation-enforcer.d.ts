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
/** Normalize a model ID to a CC-supported alias (sonnet/opus/haiku) if possible */
export declare function normalizeToCcAlias(model: string): string;
/**
 * Agent input structure from Claude Agent SDK
 */
export interface AgentInput {
    description: string;
    prompt: string;
    subagent_type: string;
    model?: string;
    resume?: string;
    run_in_background?: boolean;
}
/**
 * Result of model enforcement
 */
export interface EnforcementResult {
    /** Original input */
    originalInput: AgentInput;
    /** Modified input with model enforced */
    modifiedInput: AgentInput;
    /** Whether model was auto-injected */
    injected: boolean;
    /** The model that was used */
    model: string;
    /** Warning message (only if OMC_DEBUG=true) */
    warning?: string;
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
export declare function enforceModel(agentInput: AgentInput): EnforcementResult;
/**
 * Check if tool input is an agent delegation call
 */
export declare function isAgentCall(toolName: string, toolInput: unknown): toolInput is AgentInput;
/**
 * Process a pre-tool-use hook for model enforcement
 */
export declare function processPreToolUse(toolName: string, toolInput: unknown): {
    modifiedInput: unknown;
    warning?: string;
};
/**
 * Get model for an agent type (for testing/debugging)
 */
export declare function getModelForAgent(agentType: string): string;
//# sourceMappingURL=delegation-enforcer.d.ts.map