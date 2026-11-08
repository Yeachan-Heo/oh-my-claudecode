/**
 * Agent Types for Oh-My-ClaudeCode
 *
 * Defines types for agent configuration and metadata used in dynamic prompt generation.
 * Ported from oh-my-opencode's agent type system.
 */
/**
 * Check if a model ID is a GPT model
 */
export function isGptModel(modelId) {
    return modelId.toLowerCase().includes('gpt');
}
/**
 * Check if a model ID is a Claude model
 */
export function isClaudeModel(modelId) {
    return modelId.toLowerCase().includes('claude');
}
/**
 * Get default model for a category
 */
export function getDefaultModelForCategory(category) {
    switch (category) {
        case 'exploration':
            return 'haiku'; // Fast, cheap
        case 'specialist':
            return 'sonnet'; // Balanced
        case 'advisor':
            return 'opus'; // High quality reasoning
        case 'utility':
            return 'haiku'; // Fast, cheap
        case 'orchestration':
            return 'sonnet'; // Balanced
        default:
            return 'sonnet';
    }
}
//# sourceMappingURL=types.js.map