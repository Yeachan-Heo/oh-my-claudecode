#!/usr/bin/env node

/**
 * PostToolUse Hook: Project Memory Learning
 * Learns from tool outputs and updates project memory
 */

import { readStdin } from './lib/stdin.mjs';

// Debug logging helper - gated behind OMC_DEBUG env var
const debugLog = (...args) => {
  if (process.env.OMC_DEBUG) console.error('[omc:debug:project-memory]', ...args);
};

// Dynamic imports with graceful fallback
let learnFromToolOutput = null;
let findProjectRoot = null;
try {
  const learnerModule = await import('../dist/hooks/project-memory/learner.js');
  const finderModule = await import('../dist/hooks/rules-injector/finder.js');
  learnFromToolOutput = learnerModule.learnFromToolOutput;
  findProjectRoot = finderModule.findProjectRoot;
} catch (err) {
  if (err?.code === 'ERR_MODULE_NOT_FOUND' && /dist\//.test(err?.message)) {
    // dist/ not built yet - expected during development, silently skip
    debugLog('dist/ modules not found, skipping project memory');
  } else {
    // Unexpected error (runtime failure, syntax error, etc.) - always log
    debugLog('Unexpected import error:', err?.code, err?.message);
  }
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
