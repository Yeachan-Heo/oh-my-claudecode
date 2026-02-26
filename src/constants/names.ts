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
  TEAM: 'team',
  PIPELINE: 'pipeline',
  SWARM: 'swarm',
  RALPLAN: 'ralplan',
} as const;
export type ModeName = typeof MODES[keyof typeof MODES];

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
  INTEROP: 'interop',
  CODEX: 'codex',
  GEMINI: 'gemini',
} as const;
export type ToolCategory = typeof TOOL_CATEGORIES[keyof typeof TOOL_CATEGORIES];

// Hook event names
export const HOOK_EVENTS = {
  PRE_TOOL_USE: 'PreToolUse',
  POST_TOOL_USE: 'PostToolUse',
  SESSION_START: 'SessionStart',
  STOP: 'Stop',
  NOTIFICATION: 'Notification',
  USER_PROMPT_SUBMIT: 'UserPromptSubmit',
  PRE_COMPACT: 'PreCompact',
} as const;
export type HookEvent = typeof HOOK_EVENTS[keyof typeof HOOK_EVENTS];
