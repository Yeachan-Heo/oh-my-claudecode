#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { createTools, toolDefinitions } from './server.js';
import { startBot } from './bot/index.js';
import { initDatabase, closeDatabase } from './db/index.js';
import { loadConfig, getPidPath } from './config.js';
import { logger } from './utils/logger.js';
import * as sessionManager from './core/session-manager.js';
import { initialize as initSessionManager } from './core/session-manager.js';

async function main() {
  const config = loadConfig();

  // Initialize database
  initDatabase(config);

  // Initialize session manager and recover existing sessions
  initSessionManager();

  // Write PID file
  const pidPath = getPidPath();
  mkdirSync(dirname(pidPath), { recursive: true });
  writeFileSync(pidPath, process.pid.toString());

  // Start Telegram bot in background (reads token from config/env internally)
  await startBot();

  // Create MCP server
  const server = new Server(
    { name: 'omc-monkey', version: '0.1.0' },
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

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`Received ${signal}, shutting down gracefully...`);

  try {
    sessionManager.shutdown();
  } catch (error) {
    logger.error('Error during session shutdown', { error: String(error) });
  }

  try {
    closeDatabase();
  } catch (error) {
    logger.error('Error closing database', { error: String(error) });
  }

  try {
    const pidPath = getPidPath();
    unlinkSync(pidPath);
  } catch {
    // PID file may not exist, ignore
  }

  logger.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
