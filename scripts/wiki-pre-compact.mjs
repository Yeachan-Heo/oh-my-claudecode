#!/usr/bin/env node
import { readStdin } from './lib/stdin.mjs';
import { loadContextText } from './lib/context-text-loader.mjs';

// Opt-in text cleaning (OMC_CONTEXT_TEXT_SANITIZE=1 or true): the wiki page metadata is cleaned before it is written. The
// categories in it are identifiers (the model passes them to wiki_list), so they are written exactly, and the text around
// them is cleaned (see cleanTextBlockKeeping). The module is loaded only when the switch is on; with the switch off the
// text is written unchanged.
async function main() {
  const input = await readStdin(1000);
  try {
    const data = JSON.parse(input);
    const { onPreCompact } = await import('../dist/hooks/wiki/session-hooks.js');
    const result = onPreCompact(data);
    if (result.additionalContext) {
      const sanitize = await loadContextText();
      let categories = [];
      if (sanitize) {
        try {
          categories = (await import('../dist/hooks/wiki/storage.js')).readAllPages(data.cwd || process.cwd()).map((page) => page.frontmatter.category);
        } catch {
          // The categories are not known: the text is cleaned as a whole.
        }
      }
      console.log(JSON.stringify({
        continue: true,
        systemMessage: sanitize ? sanitize.cleanTextBlockKeeping(result.additionalContext, categories) : result.additionalContext,
      }));
    } else {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    }
  } catch (error) {
    console.error('[wiki-pre-compact] Error:', error.message);
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

main();
