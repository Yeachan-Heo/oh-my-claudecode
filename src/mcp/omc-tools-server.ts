/**
 * OMC Tools Server - In-process MCP server for custom tools
 *
 * Exposes 18 custom tools (12 LSP, 2 AST, 1 python_repl, 3 skills) via the Claude Agent SDK's
 * createSdkMcpServer helper for local Node.js Agent SDK integrations. This is not a VS Code
 * extension host or CI runner by itself.
 *
 * NOTE: Agent SDK imports are deferred to dynamic import() to preserve ESM loading in CJS bundles.
 * This avoids ERR_REQUIRE_ESM on Node <20.19 and <22.12 where require(esm) is not supported.
 */
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

// Lazy-initialized server to defer SDK imports until first use (avoids require(esm) errors)
let _omcToolsServerCache: any = null;

/**
 * Initialize the OMC tools server by dynamically importing the Agent SDK.
 * This is deferred from module load time to preserve ESM loading in CJS bundles.
 */
async function initializeOmcToolsServer() {
  if (_omcToolsServerCache !== null) {
    return _omcToolsServerCache;
  }

  // Dynamic import to preserve ESM loading for the external Agent SDK
  const { createSdkMcpServer, tool } = await import(
    "@anthropic-ai/claude-agent-sdk"
  );

  // Convert to SDK tool format
  // The SDK's tool() expects a ZodRawShape directly (not wrapped in z.object())
  const sdkTools = enabledTools.map((t) =>
    tool(
      t.name,
      t.description,
      t.schema as Parameters<typeof tool>[2],
      async (args: unknown) => await t.handler(args)
    )
  );

  // Create and cache the server
  _omcToolsServerCache = createSdkMcpServer({
    name: "t",
    version: "1.0.0",
    tools: sdkTools,
  });

  return _omcToolsServerCache;
}

/**
 * Get the OMC tools server, initializing it if needed.
 * This function must be awaited to ensure the Agent SDK is properly loaded.
 */
export async function getOmcToolsServer() {
  return initializeOmcToolsServer();
}

/**
 * In-process MCP server exposing all OMC custom tools.
 *
 * NOTE: This is initialized lazily on first access. Code using this must be aware that
 * in new runtime contexts (like when imported by the CLI), the server may not be immediately
 * available and should use getOmcToolsServer() async variant instead, or wait for initialization.
 *
 * Tools will be available as mcp__t__<tool_name>.
 * Tools in disabled groups (via OMC_DISABLE_TOOLS) are excluded at startup.
 */
export let omcToolsServer: any = null;

// Initialize on first import for backward compatibility with existing code
// This runs asynchronously and doesn't block module load
initializeOmcToolsServer().then((server) => {
  omcToolsServer = server;
}).catch((err) => {
  // If initialization fails, log it but don't crash module load
  // The error will be caught when someone tries to actually use the server
  if (process.env.DEBUG) {
    console.error("Failed to initialize OMC tools server:", err);
  }
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

/**
 * Ensure the OMC tools server is initialized before use.
 * This is a synchronous check for tests and other code that needs to know if the server is ready.
 */
export function isOmcToolsServerReady(): boolean {
  return _omcToolsServerCache !== null && omcToolsServer !== null;
}
