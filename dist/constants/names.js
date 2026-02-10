/**
 * Shared Constants Registry
 *
 * Canonical string constants for modes, tool categories, and hook events.
 * Eliminates scattered string literals across the codebase.
 */
// Mode names
export const MODES = {
    AUTOPILOT: 'autopilot',
    RALPH: 'ralph',
    ULTRAWORK: 'ultrawork',
    ULTRAPILOT: 'ultrapilot',
    ULTRAQA: 'ultraqa',
    ECOMODE: 'ecomode',
    TEAM: 'team',
    PIPELINE: 'pipeline',
};
// Tool categories
export const TOOL_CATEGORIES = {
    LSP: 'lsp',
    AST: 'ast',
    PYTHON: 'python',
    STATE: 'state',
    NOTEPAD: 'notepad',
    MEMORY: 'memory',
    TRACE: 'trace',
    SKILLS: 'skills',
    CODEX: 'codex',
    GEMINI: 'gemini',
};
// Hook event names
export const HOOK_EVENTS = {
    PRE_TOOL_USE: 'PreToolUse',
    POST_TOOL_USE: 'PostToolUse',
    SESSION_START: 'SessionStart',
    STOP: 'Stop',
    NOTIFICATION: 'Notification',
    USER_PROMPT_SUBMIT: 'UserPromptSubmit',
    PRE_COMPACT: 'PreCompact',
};
//# sourceMappingURL=names.js.map