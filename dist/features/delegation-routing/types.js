/**
 * Delegation Routing Types
 *
 * Re-exports from shared types for convenience plus
 * delegation-specific constants and helpers.
 */
/**
 * Default delegation routing configuration
 */
export const DEFAULT_DELEGATION_CONFIG = {
    enabled: false,
    defaultProvider: 'claude',
    roles: {},
};
/**
 * Role category to default Claude subagent mapping
 */
export const ROLE_CATEGORY_DEFAULTS = {
    // Exploration roles
    explore: 'explore',
    'document-specialist': 'document-specialist',
    researcher: 'document-specialist',
    'tdd-guide': 'test-engineer',
    // Advisory roles (high complexity)
    architect: 'architect',
    planner: 'planner',
    critic: 'critic',
    analyst: 'analyst',
    // Implementation roles
    executor: 'executor',
    // Review roles
    'code-reviewer': 'code-reviewer',
    'security-reviewer': 'security-reviewer',
    'quality-reviewer': 'quality-reviewer',
    // Specialized roles
    designer: 'designer',
    writer: 'writer',
    'qa-tester': 'qa-tester',
    debugger: 'debugger',
    scientist: 'scientist',
    'build-fixer': 'build-fixer',
};
/**
 * Deprecated role aliases mapped to canonical role names.
 */
export const DEPRECATED_ROLE_ALIASES = {
    researcher: 'document-specialist',
    'tdd-guide': 'test-engineer',
    'api-reviewer': 'code-reviewer',
    'performance-reviewer': 'quality-reviewer',
    'dependency-expert': 'document-specialist',
    'quality-strategist': 'quality-reviewer',
    vision: 'document-specialist',
};
/**
 * Normalize legacy role aliases to canonical role names.
 */
export function normalizeDelegationRole(role) {
    return DEPRECATED_ROLE_ALIASES[role] ?? role;
}
/**
 * Check if delegation routing is enabled
 */
export function isDelegationEnabled(config) {
    return config?.enabled === true;
}
//# sourceMappingURL=types.js.map