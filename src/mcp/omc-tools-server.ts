/**
 * OMC Tools Server - In-process MCP server for custom tools
 *
 * Exposes 18 custom tools (12 LSP, 2 AST, 1 python_repl, 3 skills) via the Claude Agent SDK's
 * createSdkMcpServer helper for use by subagents.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { lspTools } from "../tools/lsp-tools.js";
import { astTools } from "../tools/ast-tools.js";
import { pythonReplTool } from "../tools/python-repl/index.js";
import { skillsTools } from "../tools/skills-tools.js";
import { stateTools } from "../tools/state-tools.js";
import { notepadTools } from "../tools/notepad-tools.js";
import { memoryTools } from "../tools/memory-tools.js";
import { traceTools } from "../tools/trace-tools.js";
import { sharedMemoryTools } from "../tools/shared-memory-tools.js";
import { getInteropTools } from "../interop/mcp-bridge.js";
import { TOOL_CATEGORIES, type ToolCategory } from "../constants/index.js";

// Type for our tool definitions
interface ToolDef {
  name: string;
  description: string;
  category?: ToolCategory;
  schema: Record<string, unknown>;
  handler: (args: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
}

// Tag each tool array with its category before aggregation
function tagCategory<T extends { name: string }>(tools: T[], category: ToolCategory): (T & { category: ToolCategory })[] {
  return tools.map(t => ({ ...t, category }));
}

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
  'shared-memory': TOOL_CATEGORIES.SHARED_MEMORY,
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

// Aggregate all custom tools with category metadata (full list, unfiltered)
const interopToolsEnabled = process.env.OMC_INTEROP_TOOLS_ENABLED === '1';
const interopTools: ToolDef[] = interopToolsEnabled
  ? tagCategory(getInteropTools() as unknown as ToolDef[], TOOL_CATEGORIES.INTEROP)
  : [];

const allTools: ToolDef[] = [
  ...tagCategory(lspTools as unknown as ToolDef[], TOOL_CATEGORIES.LSP),
  ...tagCategory(astTools as unknown as ToolDef[], TOOL_CATEGORIES.AST),
  { ...(pythonReplTool as unknown as ToolDef), category: TOOL_CATEGORIES.PYTHON },
  ...tagCategory(skillsTools as unknown as ToolDef[], TOOL_CATEGORIES.SKILLS),
  ...tagCategory(stateTools as unknown as ToolDef[], TOOL_CATEGORIES.STATE),
  ...tagCategory(notepadTools as unknown as ToolDef[], TOOL_CATEGORIES.NOTEPAD),
  ...tagCategory(memoryTools as unknown as ToolDef[], TOOL_CATEGORIES.MEMORY),
  ...tagCategory(traceTools as unknown as ToolDef[], TOOL_CATEGORIES.TRACE),
  ...tagCategory(sharedMemoryTools as unknown as ToolDef[], TOOL_CATEGORIES.SHARED_MEMORY),
  ...interopTools,
];

// Read OMC_DISABLE_TOOLS once at startup and filter tools accordingly
const _startupDisabledGroups = parseDisabledGroups();
const enabledTools: ToolDef[] = _startupDisabledGroups.size === 0
  ? allTools
  : allTools.filter(t => !t.category || !_startupDisabledGroups.has(t.category));

// Convert to SDK tool format
// The SDK's tool() expects a ZodRawShape directly (not wrapped in z.object())
const sdkTools = enabledTools.map(t =>
  tool(
    t.name,
    t.description,
    t.schema as Parameters<typeof tool>[2],
    async (args: unknown) => await t.handler(args)
  )
);

/**
 * In-process MCP server exposing all OMC custom tools
 *
 * Tools will be available as mcp__t__<tool_name>.
 * Tools in disabled groups (via OMC_DISABLE_TOOLS) are excluded at startup.
 */
export const omcToolsServer = createSdkMcpServer({
  name: "t",
  version: "1.0.0",
  tools: sdkTools
});

/**
 * Tool names in MCP format for allowedTools configuration.
 * Only includes tools that are enabled (not disabled via OMC_DISABLE_TOOLS).
 */
export const omcToolNames = enabledTools.map(t => `mcp__t__${t.name}`);

// Build a map from MCP tool name to category for efficient lookup
// Built from allTools so getOmcToolNames() category filtering works correctly
const toolCategoryMap = new Map<string, ToolCategory>(
  allTools.map(t => [`mcp__t__${t.name}`, t.category!])
);

/**
 * Get tool names filtered by category.
 * Uses category metadata instead of string heuristics.
 */
export function getOmcToolNames(options?: {
  includeLsp?: boolean;
  includeAst?: boolean;
  includePython?: boolean;
  includeSkills?: boolean;
  includeState?: boolean;
  includeNotepad?: boolean;
  includeMemory?: boolean;
  includeTrace?: boolean;
  includeInterop?: boolean;
  includeSharedMemory?: boolean;
}): string[] {
  const {
    includeLsp = true,
    includeAst = true,
    includePython = true,
    includeSkills = true,
    includeState = true,
    includeNotepad = true,
    includeMemory = true,
    includeTrace = true,
    includeInterop = true,
    includeSharedMemory = true,
  } = options || {};

  const excludedCategories = new Set<ToolCategory>();
  if (!includeLsp) excludedCategories.add(TOOL_CATEGORIES.LSP);
  if (!includeAst) excludedCategories.add(TOOL_CATEGORIES.AST);
  if (!includePython) excludedCategories.add(TOOL_CATEGORIES.PYTHON);
  if (!includeSkills) excludedCategories.add(TOOL_CATEGORIES.SKILLS);
  if (!includeState) excludedCategories.add(TOOL_CATEGORIES.STATE);
  if (!includeNotepad) excludedCategories.add(TOOL_CATEGORIES.NOTEPAD);
  if (!includeMemory) excludedCategories.add(TOOL_CATEGORIES.MEMORY);
  if (!includeTrace) excludedCategories.add(TOOL_CATEGORIES.TRACE);
  if (!includeInterop) excludedCategories.add(TOOL_CATEGORIES.INTEROP);
  if (!includeSharedMemory) excludedCategories.add(TOOL_CATEGORIES.SHARED_MEMORY);

  if (excludedCategories.size === 0) return [...omcToolNames];

  return omcToolNames.filter(name => {
    const category = toolCategoryMap.get(name);
    return !category || !excludedCategories.has(category);
  });
}

/**
 * Test-only helper for deterministic category-filter verification independent of env startup state.
 */
export function _getAllToolNamesForTests(options?: {
  includeLsp?: boolean;
  includeAst?: boolean;
  includePython?: boolean;
  includeSkills?: boolean;
  includeState?: boolean;
  includeNotepad?: boolean;
  includeMemory?: boolean;
  includeTrace?: boolean;
  includeInterop?: boolean;
  includeSharedMemory?: boolean;
}): string[] {
  const {
    includeLsp = true,
    includeAst = true,
    includePython = true,
    includeSkills = true,
    includeState = true,
    includeNotepad = true,
    includeMemory = true,
    includeTrace = true,
    includeInterop = true,
    includeSharedMemory = true,
  } = options || {};

  const excludedCategories = new Set<ToolCategory>();
  if (!includeLsp) excludedCategories.add(TOOL_CATEGORIES.LSP);
  if (!includeAst) excludedCategories.add(TOOL_CATEGORIES.AST);
  if (!includePython) excludedCategories.add(TOOL_CATEGORIES.PYTHON);
  if (!includeSkills) excludedCategories.add(TOOL_CATEGORIES.SKILLS);
  if (!includeState) excludedCategories.add(TOOL_CATEGORIES.STATE);
  if (!includeNotepad) excludedCategories.add(TOOL_CATEGORIES.NOTEPAD);
  if (!includeMemory) excludedCategories.add(TOOL_CATEGORIES.MEMORY);
  if (!includeTrace) excludedCategories.add(TOOL_CATEGORIES.TRACE);
  if (!includeInterop) excludedCategories.add(TOOL_CATEGORIES.INTEROP);
  if (!includeSharedMemory) excludedCategories.add(TOOL_CATEGORIES.SHARED_MEMORY);

  return allTools
    .filter(t => !t.category || !excludedCategories.has(t.category))
    .map(t => `mcp__t__${t.name}`);
}
