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
import { TOOL_CATEGORIES } from "../constants/index.js";
// Tag each tool array with its category before aggregation
function tagCategory(tools, category) {
    return tools.map(t => ({ ...t, category }));
}
// Aggregate all custom tools with category metadata
const allTools = [
    ...tagCategory(lspTools, TOOL_CATEGORIES.LSP),
    ...tagCategory(astTools, TOOL_CATEGORIES.AST),
    { ...pythonReplTool, category: TOOL_CATEGORIES.PYTHON },
    ...tagCategory(skillsTools, TOOL_CATEGORIES.SKILLS),
    ...tagCategory(stateTools, TOOL_CATEGORIES.STATE),
    ...tagCategory(notepadTools, TOOL_CATEGORIES.NOTEPAD),
    ...tagCategory(memoryTools, TOOL_CATEGORIES.MEMORY),
    ...tagCategory(traceTools, TOOL_CATEGORIES.TRACE),
];
// Convert to SDK tool format
// The SDK's tool() expects a ZodRawShape directly (not wrapped in z.object())
const sdkTools = allTools.map(t => tool(t.name, t.description, t.schema, async (args) => await t.handler(args)));
/**
 * In-process MCP server exposing all OMC custom tools
 *
 * Tools will be available as mcp__t__<tool_name>
 */
export const omcToolsServer = createSdkMcpServer({
    name: "t",
    version: "1.0.0",
    tools: sdkTools
});
/**
 * Tool names in MCP format for allowedTools configuration
 */
export const omcToolNames = allTools.map(t => `mcp__t__${t.name}`);
// Build a map from MCP tool name to category for efficient lookup
const toolCategoryMap = new Map(allTools.map(t => [`mcp__t__${t.name}`, t.category]));
/**
 * Get tool names filtered by category.
 * Uses category metadata instead of string heuristics.
 */
export function getOmcToolNames(options) {
    const { includeLsp = true, includeAst = true, includePython = true, includeSkills = true, includeState = true, includeNotepad = true, includeMemory = true, includeTrace = true } = options || {};
    const excludedCategories = new Set();
    if (!includeLsp)
        excludedCategories.add(TOOL_CATEGORIES.LSP);
    if (!includeAst)
        excludedCategories.add(TOOL_CATEGORIES.AST);
    if (!includePython)
        excludedCategories.add(TOOL_CATEGORIES.PYTHON);
    if (!includeSkills)
        excludedCategories.add(TOOL_CATEGORIES.SKILLS);
    if (!includeState)
        excludedCategories.add(TOOL_CATEGORIES.STATE);
    if (!includeNotepad)
        excludedCategories.add(TOOL_CATEGORIES.NOTEPAD);
    if (!includeMemory)
        excludedCategories.add(TOOL_CATEGORIES.MEMORY);
    if (!includeTrace)
        excludedCategories.add(TOOL_CATEGORIES.TRACE);
    if (excludedCategories.size === 0)
        return [...omcToolNames];
    return omcToolNames.filter(name => {
        const category = toolCategoryMap.get(name);
        return !category || !excludedCategories.has(category);
    });
}
//# sourceMappingURL=omc-tools-server.js.map