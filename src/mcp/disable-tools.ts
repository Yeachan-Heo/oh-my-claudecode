import { TOOL_CATEGORIES, type ToolCategory } from '../constants/index.js';

/**
 * Map from user-facing OMC_DISABLE_TOOLS group names to ToolCategory values.
 * Supports both canonical names and common aliases.
 */
export const DISABLE_TOOLS_GROUP_MAP: Record<string, ToolCategory> = {
  'lsp': TOOL_CATEGORIES.LSP,
  'ast': TOOL_CATEGORIES.AST,
  'python': TOOL_CATEGORIES.PYTHON,
  'python-repl': TOOL_CATEGORIES.PYTHON,
  'trace': TOOL_CATEGORIES.TRACE,
  'state': TOOL_CATEGORIES.STATE,
  'notepad': TOOL_CATEGORIES.NOTEPAD,
  'memory': TOOL_CATEGORIES.MEMORY,
  'project-memory': TOOL_CATEGORIES.MEMORY,
  'skills': TOOL_CATEGORIES.SKILLS,
  'interop': TOOL_CATEGORIES.INTEROP,
  'codex': TOOL_CATEGORIES.CODEX,
  'gemini': TOOL_CATEGORIES.GEMINI,
  'antigravity': TOOL_CATEGORIES.ANTIGRAVITY,
  'shared-memory': TOOL_CATEGORIES.SHARED_MEMORY,
  'deepinit': TOOL_CATEGORIES.DEEPINIT,
  'deepinit-manifest': TOOL_CATEGORIES.DEEPINIT,
  'wiki': TOOL_CATEGORIES.WIKI,
};

/**
 * Parse OMC_DISABLE_TOOLS env var value into a Set of disabled ToolCategory values.
 *
 * Accepts a comma-separated list of group names (case-insensitive).
 * Unknown names are silently ignored.
 *
 * @param envValue - The env var value to parse. Defaults to process.env.OMC_DISABLE_TOOLS.
 * @returns Set of ToolCategory values that should be disabled.
 *
 * @example
 * // OMC_DISABLE_TOOLS=lsp,python-repl,project-memory
 * parseDisabledGroups(); // Set { 'lsp', 'python', 'memory' }
 */
export function parseDisabledGroups(envValue?: string): Set<ToolCategory> {
  const disabled = new Set<ToolCategory>();
  const value = envValue ?? process.env.OMC_DISABLE_TOOLS;
  if (!value || !value.trim()) return disabled;

  for (const name of value.split(',')) {
    const trimmed = name.trim().toLowerCase();
    if (!trimmed) continue;
    const category = DISABLE_TOOLS_GROUP_MAP[trimmed];
    if (category !== undefined) {
      disabled.add(category);
    }
  }
  return disabled;
}

export function tagCategory<T extends { name: string }>(
  tools: T[],
  category: ToolCategory,
): (T & { category: ToolCategory })[] {
  return tools.map(t => ({ ...t, category }));
}

export function filterDisabledTools<T extends { category?: ToolCategory }>(
  tools: T[],
  envValue?: string,
): T[] {
  const disabledGroups = parseDisabledGroups(envValue);
  if (disabledGroups.size === 0) return tools;

  return tools.filter(tool => !tool.category || !disabledGroups.has(tool.category));
}
