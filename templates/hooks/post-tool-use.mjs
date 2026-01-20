#!/usr/bin/env node
// OMC Post-Tool-Use Hook (Node.js)
// Processes <remember> tags from Task agent output
// Saves to .omc/notepad.md for compaction-resilient memory

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// Constants
const NOTEPAD_TEMPLATE = '# Notepad\n' +
  '<!-- Auto-managed by OMC. Manual edits preserved in MANUAL section. -->\n\n' +
  '## Priority Context\n' +
  '<!-- ALWAYS loaded. Keep under 500 chars. Critical discoveries only. -->\n\n' +
  '## Working Memory\n' +
  '<!-- Session notes. Auto-pruned after 7 days. -->\n\n' +
  '## MANUAL\n' +
  '<!-- User content. Never auto-pruned. -->\n';

// Read all stdin
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// Initialize notepad.md if needed
function initNotepad(directory) {
  const sisyphusDir = join(directory, '.omc');
  const notepadPath = join(sisyphusDir, 'notepad.md');

  if (!existsSync(sisyphusDir)) {
    try { mkdirSync(sisyphusDir, { recursive: true }); } catch {}
  }

  if (!existsSync(notepadPath)) {
    try { writeFileSync(notepadPath, NOTEPAD_TEMPLATE); } catch {}
  }

  return notepadPath;
}

// Set priority context
function setPriorityContext(notepadPath, content) {
  try {
    let notepad = readFileSync(notepadPath, 'utf-8');

    // Find and replace Priority Context section
    const priorityMatch = notepad.match(/## Priority Context[\s\S]*?(?=## Working Memory)/);
    if (priorityMatch) {
      const newPriority = '## Priority Context\n' +
        '<!-- ALWAYS loaded. Keep under 500 chars. Critical discoveries only. -->\n' +
        content.trim() + '\n\n';
      notepad = notepad.replace(priorityMatch[0], newPriority);
      writeFileSync(notepadPath, notepad);
    }
  } catch {}
}

// Add working memory entry
function addWorkingMemoryEntry(notepadPath, content) {
  try {
    let notepad = readFileSync(notepadPath, 'utf-8');

    const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const entry = '### ' + timestamp + '\n' + content.trim() + '\n\n';

    // Insert before MANUAL section
    const manualIndex = notepad.indexOf('## MANUAL');
    if (manualIndex !== -1) {
      notepad = notepad.slice(0, manualIndex) + entry + notepad.slice(manualIndex);
      writeFileSync(notepadPath, notepad);
    }
  } catch {}
}

// Process remember tags
function processRememberTags(output, notepadPath) {
  if (!output) return;

  // Process priority remember tags
  const priorityRegex = /<remember\s+priority>([\s\S]*?)<\/remember>/gi;
  let match;
  while ((match = priorityRegex.exec(output)) !== null) {
    const content = match[1].trim();
    if (content) {
      setPriorityContext(notepadPath, content);
    }
  }

  // Process regular remember tags
  const regularRegex = /<remember>([\s\S]*?)<\/remember>/gi;
  while ((match = regularRegex.exec(output)) !== null) {
    const content = match[1].trim();
    if (content) {
      addWorkingMemoryEntry(notepadPath, content);
    }
  }
}

async function main() {
  try {
    const input = await readStdin();
    const data = JSON.parse(input);

    const toolName = data.toolName || '';
    const toolOutput = data.toolOutput || '';
    const directory = data.directory || process.cwd();

    // Only process Task tool output
    if (toolName !== 'Task' && toolName !== 'task') {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    // Check for remember tags
    if (!toolOutput.includes('<remember')) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    // Initialize notepad and process tags
    const notepadPath = initNotepad(directory);
    processRememberTags(toolOutput, notepadPath);

    console.log(JSON.stringify({ continue: true }));
  } catch (error) {
    console.log(JSON.stringify({ continue: true }));
  }
}

main();
