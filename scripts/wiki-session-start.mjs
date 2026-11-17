#!/usr/bin/env node
import { readStdin } from './lib/stdin.mjs';
import { loadContextText } from './lib/context-text-loader.mjs';

// Opt-in text cleaning (OMC_CONTEXT_TEXT_SANITIZE=1 or true): the wiki index text is cleaned before it is injected. The page
// files named in the index are identifiers (the model passes them to wiki_read), so they are written exactly, and the text
// around them is cleaned (see cleanTextBlockKeeping). The module is loaded only when the switch is on; with the switch off
// the text is injected unchanged.
async function main() {
  const input = await readStdin(1000);
  try {
    const data = JSON.parse(input);
    const { onSessionStart } = await import('../dist/hooks/wiki/session-hooks.js');
    const result = onSessionStart(data);
    if (result.additionalContext) {
      const sanitize = await loadContextText();
      let pages = [];
      if (sanitize) {
        try {
          pages = (await import('../dist/hooks/wiki/storage.js')).listPages(data.cwd || process.cwd());
        } catch {
          // The page files are not known: the index text is cleaned as a whole.
        }
      }
      console.log(JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: sanitize ? sanitize.cleanTextBlockKeeping(result.additionalContext, pages) : result.additionalContext,
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
