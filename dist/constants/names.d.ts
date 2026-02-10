/**
 * Shared Constants Registry
 *
 * Canonical string constants for modes, tool categories, and hook events.
 * Eliminates scattered string literals across the codebase.
 */
export declare const MODES: {
    readonly AUTOPILOT: "autopilot";
    readonly RALPH: "ralph";
    readonly ULTRAWORK: "ultrawork";
    readonly ULTRAPILOT: "ultrapilot";
    readonly ULTRAQA: "ultraqa";
    readonly ECOMODE: "ecomode";
    readonly TEAM: "team";
    readonly PIPELINE: "pipeline";
};
export type ModeName = typeof MODES[keyof typeof MODES];
export declare const TOOL_CATEGORIES: {
    readonly LSP: "lsp";
    readonly AST: "ast";
    readonly PYTHON: "python";
    readonly STATE: "state";
    readonly NOTEPAD: "notepad";
    readonly MEMORY: "memory";
    readonly TRACE: "trace";
    readonly SKILLS: "skills";
    readonly CODEX: "codex";
    readonly GEMINI: "gemini";
};
export type ToolCategory = typeof TOOL_CATEGORIES[keyof typeof TOOL_CATEGORIES];
export declare const HOOK_EVENTS: {
    readonly PRE_TOOL_USE: "PreToolUse";
    readonly POST_TOOL_USE: "PostToolUse";
    readonly SESSION_START: "SessionStart";
    readonly STOP: "Stop";
    readonly NOTIFICATION: "Notification";
    readonly USER_PROMPT_SUBMIT: "UserPromptSubmit";
    readonly PRE_COMPACT: "PreCompact";
};
export type HookEvent = typeof HOOK_EVENTS[keyof typeof HOOK_EVENTS];
//# sourceMappingURL=names.d.ts.map