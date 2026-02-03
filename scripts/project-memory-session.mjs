#!/usr/bin/env node

/**
 * SessionStart Hook: Project Memory Detection
 * Auto-detects project environment and injects context
 */

import { registerProjectMemoryContext } from '../dist/hooks/project-memory/index.js';

/**
 * Read JSON input from stdin
 */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Main hook execution
 */
async function main() {
  try {
    const input = await readStdin();
    const data = JSON.parse(input);

    // Extract directory and session ID
    const directory = data.directory || process.cwd();
    const sessionId = data.sessionId || data.session_id || '';

    // Register project memory context
    await registerProjectMemoryContext(sessionId, directory);

    // Return success (context registered via contextCollector)
    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: ''  // Context registered via contextCollector, not returned here
      }
    }));
  } catch (error) {
    // Always continue on error
    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: ''
      }
    }));
  }
}

main();
