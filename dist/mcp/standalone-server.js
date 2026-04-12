#!/usr/bin/env node
/**
 * Standalone MCP Server for OMC Tools
 *
 * This server exposes LSP, AST, and Python REPL tools via stdio transport
 * for discovery by Claude Code's MCP management system.
 *
 * Usage: node dist/mcp/standalone-server.js
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { registerStandaloneShutdownHandlers } from './standalone-shutdown.js';
import { cleanupOwnedBridgeSessions } from '../tools/python-repl/bridge-manager.js';
import { allTools, buildListToolsResponse } from './tool-registry.js';
// Create the MCP server
const server = new Server({
    name: 't',
    version: '1.0.0',
}, {
    capabilities: {
        tools: {},
    },
});
// List available tools — delegates to tool-registry so tests exercise the same path.
server.setRequestHandler(ListToolsRequestSchema, async () => buildListToolsResponse());
// Handle tool calls
const setStandaloneCallToolRequestHandler = server.setRequestHandler.bind(server);
setStandaloneCallToolRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = allTools.find(t => t.name === name);
    if (!tool) {
        return {
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            isError: true,
        };
    }
    try {
        const result = await tool.handler((args ?? {}));
        return {
            content: result.content,
            isError: result.isError ?? false,
        };
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            content: [{ type: 'text', text: `Error: ${errorMessage}` }],
            isError: true,
        };
    }
});
// Graceful shutdown: disconnect LSP servers on process termination (#768).
// Without this, LSP child processes (e.g. jdtls) survive the MCP server exit
// and become orphaned, consuming memory indefinitely.
// The MCP server process owns the LSP child processes (spawned via
// child_process.spawn in LspClient.connect), so cleanup must happen here.
import { disconnectAll as disconnectAllLsp } from '../tools/lsp/index.js';
async function gracefulShutdown(signal) {
    // Hard deadline: exit even if cleanup hangs (e.g. unresponsive LSP server)
    const forceExitTimer = setTimeout(() => process.exit(1), 5_000);
    forceExitTimer.unref();
    console.error(`OMC MCP Server: received ${signal}, disconnecting LSP servers...`);
    try {
        await cleanupOwnedBridgeSessions();
    }
    catch {
        // Best-effort — do not block exit
    }
    try {
        await disconnectAllLsp();
    }
    catch {
        // Best-effort — do not block exit
    }
    try {
        await server.close();
    }
    catch {
        // Best-effort — MCP transport cleanup
    }
    process.exit(0);
}
registerStandaloneShutdownHandlers({
    onShutdown: gracefulShutdown,
});
// Start the server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('OMC Tools MCP Server running on stdio');
}
main().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
});
//# sourceMappingURL=standalone-server.js.map