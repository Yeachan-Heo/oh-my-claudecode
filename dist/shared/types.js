/**
 * Shared types for Oh-My-ClaudeCode
 */
// ---------------------------------------------------------------------------
// /team role routing (Option E — /team-scoped per-role provider & model)
// ---------------------------------------------------------------------------
/** Canonical role names accepted in `team.roleRouting` (source of truth). */
export const CANONICAL_TEAM_ROLES = [
    'orchestrator',
    'planner',
    'analyst',
    'architect',
    'executor',
    'debugger',
    'critic',
    'code-reviewer',
    'security-reviewer',
    'test-engineer',
    'designer',
    'writer',
    'code-simplifier',
    'explore',
    'document-specialist',
];
/** Known agent names derived from `buildDefaultConfig().agents` keys in src/config/loader.ts. */
export const KNOWN_AGENT_NAMES = [
    'omc',
    'explore',
    'analyst',
    'planner',
    'architect',
    'debugger',
    'executor',
    'verifier',
    'securityReviewer',
    'codeReviewer',
    'testEngineer',
    'designer',
    'writer',
    'qaTester',
    'scientist',
    'tracer',
    'gitMaster',
    'codeSimplifier',
    'critic',
    'documentSpecialist',
];
//# sourceMappingURL=types.js.map