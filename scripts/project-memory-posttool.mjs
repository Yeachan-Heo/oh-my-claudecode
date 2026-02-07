#!/usr/bin/env node

/**
 * PostToolUse Hook: Project Memory Learning
 * Learns from tool outputs and updates project memory
 */

// Dynamic imports with graceful fallback
let learnFromToolOutput = null;
let findProjectRoot = null;
try {
  const learnerModule = await import('../dist/hooks/project-memory/learner.js');
  const finderModule = await import('../dist/hooks/rules-injector/finder.js');
  learnFromToolOutput = learnerModule.learnFromToolOutput;
  findProjectRoot = finderModule.findProjectRoot;
} catch {
  // dist not built - degrade gracefully
}

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

    // Early exit if imports failed
    if (!learnFromToolOutput || !findProjectRoot) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    // Extract directory and find project root
    const directory = data.cwd || data.directory || process.cwd();
    const projectRoot = findProjectRoot(directory);

    if (projectRoot) {
      // Learn from tool output
      await learnFromToolOutput(
        data.tool_name || data.toolName || '',
        data.tool_input || data.toolInput || {},
        data.tool_response || data.toolOutput || '',
        projectRoot
      );
    }

    // Return success
    console.log(JSON.stringify({
      continue: true,
      suppressOutput: true
    }));
  } catch (error) {
    // Always continue on error
    console.log(JSON.stringify({
      continue: true,
      suppressOutput: true
    }));
  }
}

main();
