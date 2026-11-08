/**
 * OMC Tools Server - In-process MCP server for custom tools
 *
 * Exposes 18 custom tools (12 LSP, 2 AST, 1 python_repl, 3 skills) via the Claude Agent SDK's
 * createSdkMcpServer helper for local Node.js Agent SDK integrations. This is not a VS Code
 * extension host or CI runner by itself.
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
import { deepinitManifestTool } from "../tools/deepinit-manifest.js";
import { wikiTools } from "../tools/wiki-tools.js";
import { TOOL_CATEGORIES, type ToolCategory } from "../constants/index.js";
import { filterDisabledTools, tagCategory } from "./disable-tools.js";
export { DISABLE_TOOLS_GROUP_MAP, parseDisabledGroups } from "./disable-tools.js";

// Type for our tool definitions
interface ToolDef {
  name: string;
  description: string;
  category?: ToolCategory;
  schema: Record<string, unknown>;
  handler: (args: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
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
  { ...(deepinitManifestTool as unknown as ToolDef), category: TOOL_CATEGORIES.DEEPINIT },
  ...tagCategory(wikiTools as unknown as ToolDef[], TOOL_CATEGORIES.WIKI),
  ...interopTools,
];

// Read OMC_DISABLE_TOOLS once at startup and filter tools accordingly
const enabledTools: ToolDef[] = filterDisabledTools(allTools);

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

interface ToolNameFilterOptions {
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
  includeDeepinit?: boolean;
  includeWiki?: boolean;
}

function getExcludedCategories(options?: ToolNameFilterOptions): Set<ToolCategory> {
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
    includeDeepinit = true,
    includeWiki = true,
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
  if (!includeDeepinit) excludedCategories.add(TOOL_CATEGORIES.DEEPINIT);
  if (!includeWiki) excludedCategories.add(TOOL_CATEGORIES.WIKI);
  return excludedCategories;
}

function filterToolNames(
  names: string[],
  categoriesByName: Map<string, ToolCategory>,
  options?: ToolNameFilterOptions,
): string[] {
  const excludedCategories = getExcludedCategories(options);
  if (excludedCategories.size === 0) return [...names];

  return names.filter(name => {
    const category = categoriesByName.get(name);
    return !category || !excludedCategories.has(category);
  });
}

/**
 * Get tool names filtered by category.
 * Uses category metadata instead of string heuristics.
 */
export function getOmcToolNames(options?: ToolNameFilterOptions): string[] {
  return filterToolNames(omcToolNames, toolCategoryMap, options);
}

/**
 * Test-only helper for deterministic category-filter verification independent of env startup state.
 */
export function _getAllToolNamesForTests(options?: ToolNameFilterOptions): string[] {
  const allToolNames = allTools.map(t => `mcp__t__${t.name}`);
  return filterToolNames(allToolNames, toolCategoryMap, options);
}
