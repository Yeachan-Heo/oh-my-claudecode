/**
 * Declarative hook registry and dispatcher shadow-mode types — #3698 / #3707.
 *
 * Contract source: docs/design/ISSUE-3698-LIGHTWEIGHT-WORKFLOW-PLAN.md §6.3.
 * One registry entry per installed hooks.json command; a shadow dispatcher
 * that parses each event once, selects only applicable entries in declared
 * order, enforces per-hook timeouts, applies declared fail-modes, and records
 * structured timing/error observations — without changing any runtime
 * decision. Risk classes and fail-modes are derived by convention from the
 * entrypoint name using the canonical taxonomy in src/workflow/registry.ts.
 * No behavior change; cutover is #3708.
 */
/** Lifecycle events present in hooks/hooks.json (the installed registration). */
export const HOOK_EVENTS = [
    'UserPromptSubmit',
    'SessionStart',
    'PreToolUse',
    'PermissionRequest',
    'PostToolUse',
    'PostToolUseFailure',
    'SubagentStart',
    'SubagentStop',
    'PreCompact',
    'Stop',
    'SessionEnd',
];
//# sourceMappingURL=types.js.map