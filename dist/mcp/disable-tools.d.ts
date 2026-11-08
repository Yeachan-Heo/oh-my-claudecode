import { type ToolCategory } from '../constants/index.js';
/**
 * Map from user-facing OMC_DISABLE_TOOLS group names to ToolCategory values.
 * Supports both canonical names and common aliases.
 */
export declare const DISABLE_TOOLS_GROUP_MAP: Record<string, ToolCategory>;
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
export declare function parseDisabledGroups(envValue?: string): Set<ToolCategory>;
export declare function tagCategory<T extends {
    name: string;
}>(tools: T[], category: ToolCategory): (T & {
    category: ToolCategory;
})[];
export declare function filterDisabledTools<T extends {
    category?: ToolCategory;
}>(tools: T[], envValue?: string): T[];
//# sourceMappingURL=disable-tools.d.ts.map