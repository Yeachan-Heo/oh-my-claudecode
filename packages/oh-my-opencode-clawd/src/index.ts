#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createTools, toolDefinitions } from './server.js';
import { startBot } from './bot/index.js';
import { initDatabase } from './db/index.js';
import { loadConfig, getPidPath } from './config.js';

async function main() {
  const config = loadConfig();

  // Initialize database
  initDatabase(config);

  // Write PID file
  const pidPath = getPidPath();
  mkdirSync(dirname(pidPath), { recursive: true });
  writeFileSync(pidPath, process.pid.toString());

  // Start Telegram bot in background (reads token from config/env internally)
  await startBot();

  // Create MCP server
  const server = new Server(
    { name: 'oh-my-opencode-clawd', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  const tools = createTools();

  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions
  }));

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = tools[name];
    if (!tool) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    try {
      const result = await tool(args ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true
      };
    }
  });

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
