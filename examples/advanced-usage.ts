/**
 * Advanced Usage Example
 *
 * This example demonstrates advanced features of Oh-My-Claude-Sisyphus:
 * - Custom agent configuration
 * - Custom system prompts
 * - Context file injection
 * - MCP server configuration
 */

import {
  createSisyphusSession,
  getAgentDefinitions,
  getSisyphusSystemPrompt,
  getDefaultMcpServers
} from '../src/index.js';

async function main() {
  console.log('=== Advanced Oh-My-Claude-Sisyphus Example ===\n');

  // Example 1: Custom agent configuration
  console.log('Example 1: Custom Agents');

  const customSession = createSisyphusSession({
    config: {
      agents: {
        // Use a faster model for the orchestrator in dev
        sisyphus: { model: 'claude-sonnet-4-5-20250514' },
        // Disable some agents
        frontendEngineer: { enabled: false },
        documentWriter: { enabled: false }
      },
      features: {
        // Disable LSP tools if not needed
        lspTools: false,
        astTools: false
      }
    }
  });

  console.log('Custom session created');
  console.log(`Active features:`, customSession.config.features);
  console.log('');

  // Example 2: Get agent definitions for custom use
  console.log('Example 2: Agent Definitions');

  const agents = getAgentDefinitions({
    oracle: {
      // Override oracle's prompt for a specific use case
      prompt: 'You are a security-focused code reviewer...'
    }
  });

  console.log('Available agents:');
  for (const [name, agent] of Object.entries(agents)) {
    console.log(`  - ${name}: ${agent.tools.join(', ')}`);
  }
  console.log('');

  // Example 3: Custom system prompt
  console.log('Example 3: Custom System Prompt');

  const customPrompt = getSisyphusSystemPrompt({
    includeContinuation: true,
    customAddition: `
## Project-Specific Instructions

This is a TypeScript monorepo using:
- Bun as the runtime
- Zod for validation
- Commander for CLI

Always prefer Bun commands over npm/npx.
Always validate user input with Zod schemas.
`
  });

  console.log('Custom system prompt created');
  console.log(`Length: ${customPrompt.length} characters\n`);

  // Example 4: MCP Server configuration
  console.log('Example 4: MCP Servers');

  const mcpServers = getDefaultMcpServers({
    enableExa: true,
    exaApiKey: process.env.EXA_API_KEY,
    enableContext7: true,
    enablePlaywright: false, // Disable browser automation
    enableMemory: true // Enable persistent memory
  });

  console.log('Configured MCP servers:');
  for (const [name, config] of Object.entries(mcpServers)) {
    if (config) {
      console.log(`  - ${name}: ${config.command} ${config.args.join(' ')}`);
    }
  }
  console.log('');

  // Example 5: Full custom configuration
  console.log('Example 5: Full Custom Session');

  const fullCustomSession = createSisyphusSession({
    workingDirectory: '/path/to/project',
    skipConfigLoad: true, // Don't load from files
    skipContextInjection: false, // Still inject AGENTS.md
    customSystemPrompt: `
You are working on a critical production system.
Always:
1. Create backups before modifying files
2. Run tests after changes
3. Document all modifications
`,
    config: {
      agents: {
        sisyphus: { model: 'claude-opus-4-6-20260205' }
      },
      features: {
        parallelExecution: true,
        continuationEnforcement: true,
        autoContextInjection: true
      },
      permissions: {
        allowBash: true,
        allowEdit: true,
        allowWrite: true,
        maxBackgroundTasks: 3
      },
      magicKeywords: {
        // Custom trigger words
        ultrawork: ['godmode', 'fullpower', 'ultrawork'],
        search: ['hunt', 'seek', 'search'],
        analyze: ['dissect', 'examine', 'analyze']
      }
    }
  });

  console.log('Full custom session created');
  console.log('Custom keywords:', fullCustomSession.config.magicKeywords);

  // Test custom keyword
  const testPrompt = 'godmode implement the entire feature';
  console.log(`\nTesting custom keyword "godmode":`);
  console.log(`Input: "${testPrompt}"`);
  console.log(`Detected: ${fullCustomSession.detectKeywords(testPrompt)}`);
  console.log('');

  // Example 6: Building a custom tool integration
  console.log('Example 6: Tool Integration Pattern');
  console.log(`
// Pattern for adding custom tools:

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { createOmcSession } from 'oh-my-claudecode';

// Create custom MCP server with your tools
const customTools = createSdkMcpServer({
  name: 'my-custom-tools',
  version: '1.0.0',
  tools: [
    tool(
      'deploy_to_staging',
      'Deploy the current branch to staging environment',
      { branch: z.string().optional() },
      async (args) => {
        // Your deployment logic here
        return { content: [{ type: 'text', text: 'Deployed!' }] };
      }
    )
  ]
});

// Create session and merge custom MCP server
const session = createSisyphusSession();
const options = {
  ...session.queryOptions.options,
  mcpServers: {
    ...session.queryOptions.options.mcpServers,
    'my-custom-tools': customTools
  }
};
`);

}

main().catch(console.error);
