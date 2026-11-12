#!/usr/bin/env node
// omc-lokalne panel-v3: Stop and SubagentStop entry of the Jev panel. Category: 4. input for Jev. The panel itself is in jev-panel.mjs
// (runPanel): at the end of a turn it asks Jev about the text that ends the turn and logs the answer in panel.jsonl. Nothing goes back to
// the agent and nothing is blocked: the output is always the quiet one, also when a module fails to load (the imports are inside main,
// review rec-panel-v3 L3). The entry runs only once hooks.json names it for Stop and SubagentStop (latki/hooks-dodatki.json).
const QUIET = JSON.stringify({ continue: true, suppressOutput: true });

async function main() {
  const { readStdin } = await import('./lib/stdin.mjs');
  const raw = await readStdin();
  const { PANEL_NAMED, runPanel } = await import('./jev-panel.mjs');
  if (!PANEL_NAMED.test(String(process.env.OMC_JEV ?? ''))) return;
  const { parseHookInput } = await import('./lib/jev-lista.mjs');
  await runPanel(parseHookInput(raw));
}

main().then(() => console.log(QUIET), () => console.log(QUIET));
