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

let learnFromToolOutput = null;
let findProjectRoot = null;

async function loadRuntimeModules() {
  try {
    learnFromToolOutput = (await import('../dist/hooks/project-memory/learner.js')).learnFromToolOutput;
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && /dist\//.test(err?.message)) {
      debugLog('dist/ learner module not found, skipping');
    } else {
      debugLog('Unexpected learner import error:', err?.code, err?.message);
    }
  }
  try {
    findProjectRoot = (await import('../dist/hooks/rules-injector/finder.js')).findProjectRoot;
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && /dist\//.test(err?.message)) {
      debugLog('dist/ finder module not found, skipping');
    } else {
      debugLog('Unexpected finder import error:', err?.code, err?.message);
    }
  }
}

/**
 * Main hook execution
 */
async function main() {
  const skipHooks = (process.env.OMC_SKIP_HOOKS || '').split(',').map((hook) => hook.trim());
  if (
    process.env.DISABLE_OMC === '1' ||
    process.env.DISABLE_OMC === 'true' ||
    skipHooks.includes('project-memory-posttool') ||
    skipHooks.includes('post-tool-use')
  ) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  try {
    await loadRuntimeModules();
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
