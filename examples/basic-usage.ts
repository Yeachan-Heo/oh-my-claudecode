/**
 * Basic Usage Example
 *
 * This example demonstrates how to use Oh-My-ClaudeCode
 * with the Claude Agent SDK.
 */

// Note: In real usage, import from 'oh-my-claudecode'
import { createOmcSession, enhancePrompt } from '../src/index.js';

// For demonstration - in real usage, import from '@anthropic-ai/claude-agent-sdk'
// import { query } from '@anthropic-ai/claude-agent-sdk';

async function main() {
  console.log('=== Oh-My-ClaudeCode Example ===\n');

  // Create a OMC session
  const session = createOmcSession({
    // Optional: custom configuration overrides
    config: {
      features: {
        parallelExecution: true,
        continuationEnforcement: true
      }
    }
  });

  console.log('Session created with:');
  console.log(`- ${Object.keys(session.queryOptions.options.agents).length} subagents`);
  console.log(`- ${Object.keys(session.queryOptions.options.mcpServers).length} MCP servers`);
  console.log(`- ${session.queryOptions.options.allowedTools.length} allowed tools\n`);

  // Example 1: Basic prompt processing
  const basicPrompt = 'Fix the authentication bug';
  console.log('Example 1: Basic prompt');
  console.log(`Input:  "${basicPrompt}"`);
  console.log(`Output: "${session.processPrompt(basicPrompt)}"\n`);

  // Example 2: Ultrawork mode
  const ultraworkPrompt = 'ultrawork refactor the entire authentication module';
  console.log('Example 2: Ultrawork mode');
  console.log(`Input:  "${ultraworkPrompt}"`);
  console.log('Detected keywords:', session.detectKeywords(ultraworkPrompt));
  console.log('Enhanced prompt:');
  console.log(session.processPrompt(ultraworkPrompt).substring(0, 500) + '...\n');

  // Example 3: Search mode
  const searchPrompt = 'search for all API endpoints in the codebase';
  console.log('Example 3: Search mode');
  console.log(`Input:  "${searchPrompt}"`);
  console.log('Detected keywords:', session.detectKeywords(searchPrompt));
  console.log('Enhanced prompt:');
  console.log(session.processPrompt(searchPrompt) + '\n');

  // Example 4: Using with Claude Agent SDK (pseudo-code)
  console.log('Example 4: Using with Claude Agent SDK');
  console.log(`
// Real usage with Claude Agent SDK:
import { query } from '@anthropic-ai/claude-agent-sdk';

const session = createOmcSession();

for await (const message of query({
  prompt: session.processPrompt("ultrawork implement user authentication"),
  ...session.queryOptions
})) {
  // Handle messages from the agent
  if (message.type === 'assistant') {
    console.log(message.content);
  }
}
`);

  // Example 5: Direct prompt enhancement
  console.log('Example 5: Quick enhance (without session)');
  const quick = enhancePrompt('analyze the performance bottleneck');
  console.log('Enhanced:', quick.substring(0, 200) + '...\n');

  // Show system prompt snippet
  console.log('=== System Prompt Preview ===');
  console.log(session.queryOptions.options.systemPrompt.substring(0, 500) + '...\n');
}

main().catch(console.error);
