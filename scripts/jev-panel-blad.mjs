#!/usr/bin/env node
// omc-lokalne A3: PostToolUseFailure entry of the Jev panel (stage 4 of the Jev task-list plan). Category: 4. input for Jev.
// The panel itself is in jev-panel.mjs (runPanel); the PostToolBatch side runs in jev-lista-paczka.mjs, one process per batch (review M3).
import { readStdin } from './lib/stdin.mjs';
import { parseHookInput, skipped } from './lib/jev-lista.mjs';
import { PANEL_NAMED, runPanel } from './jev-panel.mjs';

const QUIET = JSON.stringify({ continue: true, suppressOutput: true });

async function main() {
  const raw = await readStdin();
  if (skipped('post-tool-use-failure') || !PANEL_NAMED.test(String(process.env.OMC_JEV ?? ''))) return QUIET; // panel not named or this event off
  const text = await runPanel(parseHookInput(raw));
  return text ? JSON.stringify({ continue: true, hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: text } }) : QUIET;
}

main().then((out) => console.log(out), () => console.log(QUIET));
