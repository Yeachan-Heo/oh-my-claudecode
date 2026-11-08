#!/usr/bin/env node
import { readStdin } from './lib/stdin.mjs';

async function main() {
  const input = await readStdin(1000);
  try {
    const data = JSON.parse(input);
    const { onSessionStart } = await import('../dist/hooks/wiki/session-hooks.js');
    const result = onSessionStart(data);
    if (result.additionalContext) {
      console.log(JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: result.additionalContext,
        },
      }));
    } else {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    }
  } catch (error) {
    console.error('[wiki-session-start] Error:', error.message);
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

main();
