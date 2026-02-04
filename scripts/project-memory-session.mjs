#!/usr/bin/env node

/**
 * SessionStart Hook: Project Memory Detection
 * Auto-detects project environment and injects context
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import timeout-protected stdin reader (prevents hangs on Linux, see issue #240)
let readStdin;
try {
  const mod = await import(join(__dirname, 'lib', 'stdin.mjs'));
  readStdin = mod.readStdin;
} catch {
  // Fallback: inline timeout-protected readStdin if lib module is missing
  readStdin = (timeoutMs = 5000) => new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; process.stdin.removeAllListeners(); process.stdin.destroy(); resolve(Buffer.concat(chunks).toString('utf-8')); }
    }, timeoutMs);
    process.stdin.on('data', (chunk) => { chunks.push(chunk); });
    process.stdin.on('end', () => { if (!settled) { settled = true; clearTimeout(timeout); resolve(Buffer.concat(chunks).toString('utf-8')); } });
    process.stdin.on('error', () => { if (!settled) { settled = true; clearTimeout(timeout); resolve(''); } });
    if (process.stdin.readableEnded) { if (!settled) { settled = true; clearTimeout(timeout); resolve(Buffer.concat(chunks).toString('utf-8')); } }
  });
}

// Dynamic import of project memory module (prevents crash if dist is missing, see issue #362)
let registerProjectMemoryContext;
try {
  const mod = await import(join(__dirname, '..', 'dist', 'hooks', 'project-memory', 'index.js'));
  registerProjectMemoryContext = mod.registerProjectMemoryContext;
} catch {
  // dist not built or missing - skip project memory detection silently
  registerProjectMemoryContext = null;
}

/**
 * Main hook execution
 */
async function main() {
  try {
    const input = await readStdin();
    let data = {};
    try { data = JSON.parse(input); } catch {}

    // Extract directory and session ID
    const directory = data.directory || process.cwd();
    const sessionId = data.sessionId || data.session_id || '';

    // Register project memory context (skip if module unavailable)
    if (registerProjectMemoryContext) {
      await registerProjectMemoryContext(sessionId, directory);
    }

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
