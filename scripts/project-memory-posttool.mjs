#!/usr/bin/env node

/**
 * PostToolUse Hook: Project Memory Learning
 * Learns from tool outputs and updates project memory
 */

import { learnFromToolOutput } from '../dist/hooks/project-memory/learner.js';
import { findProjectRoot } from '../dist/hooks/rules-injector/finder.js';
import { readStdin } from './lib/stdin.mjs';

/**
 * Main hook execution
 */
async function main() {
  try {
    const input = await readStdin();
    const data = JSON.parse(input);

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
