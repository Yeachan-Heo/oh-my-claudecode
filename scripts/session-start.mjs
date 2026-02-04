#!/usr/bin/env node

/**
 * Sisyphus Session Start Hook (Node.js)
 * Restores persistent mode states when session starts
 * Cross-platform: Windows, macOS, Linux
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Read all stdin
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// Read JSON file safely
function readJsonFile(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

// Check if HUD is properly installed (with retry for race conditions)
async function checkHudInstallation(retryCount = 0) {
  const hudDir = join(homedir(), '.claude', 'hud');
  // Support both legacy (sisyphus-hud.mjs) and current (omc-hud.mjs) naming
  const hudScriptOmc = join(hudDir, 'omc-hud.mjs');
  const hudScriptSisyphus = join(hudDir, 'sisyphus-hud.mjs');
  const settingsFile = join(homedir(), '.claude', 'settings.json');

  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 100;

  // Check if HUD script exists (either naming convention)
  const hudScriptExists = existsSync(hudScriptOmc) || existsSync(hudScriptSisyphus);
  if (!hudScriptExists) {
    return { installed: false, reason: 'HUD script missing' };
  }

  // Check if statusLine is configured (with retry for race conditions)
  try {
    if (existsSync(settingsFile)) {
      const content = readFileSync(settingsFile, 'utf-8');
      // Handle empty or whitespace-only content (race condition during write)
      if (!content || !content.trim()) {
        if (retryCount < MAX_RETRIES) {
          // Sleep and retry (non-blocking)
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
          return checkHudInstallation(retryCount + 1);
        }
        return { installed: false, reason: 'settings.json empty (possible race condition)' };
      }
      const settings = JSON.parse(content);
      if (!settings.statusLine) {
        // Retry once if statusLine not found (could be mid-write)
        if (retryCount < MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
          return checkHudInstallation(retryCount + 1);
        }
        return { installed: false, reason: 'statusLine not configured' };
      }
    } else {
      return { installed: false, reason: 'settings.json missing' };
    }
  } catch (err) {
    // JSON parse error - could be mid-write, retry
    if (retryCount < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      return checkHudInstallation(retryCount + 1);
    }
    console.error('HUD check error:', err.message);
    return { installed: false, reason: 'Could not read settings' };
  }

  return { installed: true };
}

// Main
async function main() {
  try {
    const input = await readStdin();
    let data = {};
    try { data = JSON.parse(input); } catch {}

    const directory = data.directory || process.cwd();
    const sessionId = data.sessionId || data.session_id || '';
    const messages = [];

    // Check HUD installation (one-time setup guidance)
    const hudCheck = await checkHudInstallation();
    if (!hudCheck.installed) {
      messages.push(`<system-reminder>
[Sisyphus] HUD not configured (${hudCheck.reason}). Run /hud setup then restart Claude Code.
</system-reminder>`);
    }

    // Check for ultrawork state - only restore if session matches (issue #311)
    const ultraworkState = readJsonFile(join(directory, '.omc', 'state', 'ultrawork-state.json'))
      || readJsonFile(join(homedir(), '.omc', 'state', 'ultrawork-state.json'));

    if (ultraworkState?.active && (!ultraworkState.session_id || ultraworkState.session_id === sessionId)) {
      messages.push(`<session-restore>

[ULTRAWORK MODE RESTORED]

You have an active ultrawork session from ${ultraworkState.started_at}.
Original task: ${ultraworkState.original_prompt}

Continue working in ultrawork mode until all tasks are complete.

</session-restore>

---
`);
    }

    // Check for ralph loop state
    const ralphState = readJsonFile(join(directory, '.omc', 'ralph-state.json'));
    if (ralphState?.active) {
      messages.push(`<session-restore>

[RALPH LOOP RESTORED]

You have an active ralph-loop session.
Original task: ${ralphState.prompt || 'Task in progress'}
Iteration: ${ralphState.iteration || 1}/${ralphState.max_iterations || 10}

Continue working until the task is verified complete.

</session-restore>

---
`);
    }

    // Check for incomplete todos (project-local only, not global ~/.claude/todos/)
    // NOTE: We intentionally do NOT scan the global ~/.claude/todos/ directory.
    // That directory accumulates todo files from ALL past sessions across all
    // projects, causing phantom task counts in fresh sessions (see issue #354).
    const localTodoPaths = [
      join(directory, '.omc', 'todos.json'),
      join(directory, '.claude', 'todos.json')
    ];
    let incompleteCount = 0;
    for (const todoFile of localTodoPaths) {
      if (existsSync(todoFile)) {
        try {
          const data = readJsonFile(todoFile);
          const todos = data?.todos || (Array.isArray(data) ? data : []);
          incompleteCount += todos.filter(t => t.status !== 'completed' && t.status !== 'cancelled').length;
        } catch {}
      }
    }

    if (incompleteCount > 0) {
      messages.push(`<session-restore>

[PENDING TASKS DETECTED]

You have ${incompleteCount} incomplete tasks from a previous session.
Please continue working on these tasks.

</session-restore>

---
`);
    }

    // Check for notepad Priority Context
    const notepadPath = join(directory, '.omc', 'notepad.md');
    if (existsSync(notepadPath)) {
      try {
        const notepadContent = readFileSync(notepadPath, 'utf-8');
        const priorityMatch = notepadContent.match(/## Priority Context\n([\s\S]*?)(?=## |$)/);
        if (priorityMatch && priorityMatch[1].trim()) {
          const priorityContext = priorityMatch[1].trim();
          // Only inject if there's actual content (not just the placeholder comment)
          const cleanContent = priorityContext.replace(/<!--[\s\S]*?-->/g, '').trim();
          if (cleanContent) {
            messages.push(`<notepad-context>
[NOTEPAD - Priority Context]
${cleanContent}
</notepad-context>`);
          }
        }
      } catch (err) {
        // Silently ignore notepad read errors
      }
    }

    if (messages.length > 0) {
      console.log(JSON.stringify({ continue: true, message: messages.join('\n') }));
    } else {
      console.log(JSON.stringify({ continue: true }));
    }
  } catch (error) {
    console.log(JSON.stringify({ continue: true }));
  }
}

main();
