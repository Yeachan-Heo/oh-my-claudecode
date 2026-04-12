/**
 * E2E drift guard for the standalone MCP server ListTools surface.
 *
 * Why this test exists (issue #2538):
 * The standalone server exposes a fixed set of tool families to Claude Code.
 * When a new tool family is added to allTools in tool-registry.ts without a
 * corresponding guard here, the MCP surface silently drifts. This test catches
 * that drift by exercising buildListToolsResponse() — the exact same function
 * that the ListTools handler calls — and asserting:
 *
 *   1. Every expected tool family has at least one representative present.
 *   2. Tool names are globally unique (no accidental duplication).
 *   3. Every returned entry is a valid MCP tool object (name, description, inputSchema).
 *   4. The minimum total count hasn't shrunk below the known baseline.
 *
 * Optional tools:
 *   AST tools (ast_grep_search, ast_grep_replace) depend on @ast-grep/napi at
 *   runtime. They are always registered in the tool list (graceful degradation —
 *   they return an error message when the native module is absent). Tests assert
 *   they are present in the registry; availability of the native module is out
 *   of scope here.
 */
export {};
//# sourceMappingURL=standalone-listtools.test.d.ts.map