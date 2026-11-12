#!/usr/bin/env node
// omc-lokalne panel-v3: SubagentStop entry of the Jev panel: the code of the Stop entry jev-panel-koniec.mjs (it reads the hook input
// and always prints the quiet output). A file of its own, because zastosuj.mjs takes one hooks.json entry per script
// (latki/hooks-dodatki.json). A failed load prints the quiet output too (review rec-panel-v3 L3).
import('./jev-panel-koniec.mjs').catch(() => console.log(JSON.stringify({ continue: true, suppressOutput: true })));
