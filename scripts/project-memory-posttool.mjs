#!/usr/bin/env node

/**
 * PostToolUse Hook: Project Memory Learning
 * Learns from tool outputs and updates project memory
 */

import { learnFromToolOutput } from '../dist/hooks/project-memory/learner.js';
import { findProjectRoot } from '../dist/hooks/rules-injector/finder.js';

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

    // Extract directory and find project root
    const directory = data.directory || process.cwd();
    const projectRoot = findProjectRoot(directory);

    if (projectRoot) {
      // Learn from tool output
      await learnFromToolOutput(
        data.toolName || '',
        data.toolInput || {},
        data.toolOutput || '',
        projectRoot
      );
    }

    // Return success
    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: ''
      }
    }));
  } catch (error) {
    // Always continue on error
    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: ''
      }
    }));
  }
}

main();
