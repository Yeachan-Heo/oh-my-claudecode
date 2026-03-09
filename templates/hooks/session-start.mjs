#!/usr/bin/env node
// OMC Session Start Hook (Node.js)
// Restores persistent mode states when session starts
// Cross-platform: Windows, macOS, Linux

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import timeout-protected stdin reader (prevents hangs on Linux/Windows, see issue #240, #524)
let readStdin;
try {
  const mod = await import(pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href);
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

function readJsonFile(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJsonFile(path, data) {
  try {
    const dir = join(path, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

async function checkForUpdates(currentVersion) {
  const cacheFile = join(homedir(), '.omc', 'update-check.json');
  const now = Date.now();
  const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

  // Check cache first
  const cached = readJsonFile(cacheFile);
  if (cached && cached.timestamp && (now - cached.timestamp) < CACHE_DURATION) {
    return cached.updateAvailable ? cached : null;
  }

  // Fetch latest version from npm
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const response = await fetch('https://registry.npmjs.org/oh-my-claude-sisyphus/latest', {
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error('Network response was not ok');
    }

    const data = await response.json();
    const latestVersion = data.version;

    const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;

    const cacheData = {
      timestamp: now,
      latestVersion,
      currentVersion,
      updateAvailable
    };

    writeJsonFile(cacheFile, cacheData);

    return updateAvailable ? cacheData : null;
  } catch (error) {
    // Silent fail - network unavailable or timeout
    return null;
  }
}

function compareVersions(v1, v2) {
  const parts1 = v1.replace(/^v/, '').split('.').map(Number);
  const parts2 = v2.replace(/^v/, '').split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const diff = (parts1[i] || 0) - (parts2[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ============================================================================
// Notepad Support
// ============================================================================

const NOTEPAD_FILENAME = 'notepad.md';
const PRIORITY_HEADER = '## Priority Context';
const WORKING_MEMORY_HEADER = '## Working Memory';

/**
 * Get notepad path in .omc directory
 */
function getNotepadPath(directory) {
  return join(directory, '.omc', NOTEPAD_FILENAME);
}

/**
 * Read notepad content
 */
function readNotepad(directory) {
  const notepadPath = getNotepadPath(directory);
  if (!existsSync(notepadPath)) {
    return null;
  }
  try {
    return readFileSync(notepadPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Extract a section from notepad content
 */
function extractSection(content, header) {
  // Match from header to next section (## followed by space and non-# char)
  const regex = new RegExp(`${header}\\n([\\s\\S]*?)(?=\\n## [^#]|$)`);
  const match = content.match(regex);
  if (!match) {
    return null;
  }
  // Remove HTML comments and trim
  let section = match[1];
  section = section.replace(/<!--[\s\S]*?-->/g, '').trim();
  return section || null;
}

/**
 * Get Priority Context section (for injection)
 */
function getPriorityContext(directory) {
  const content = readNotepad(directory);
  if (!content) {
    return null;
  }
  return extractSection(content, PRIORITY_HEADER);
}

/**
 * Format notepad context for session injection
 */
function formatNotepadContext(directory) {
  const priorityContext = getPriorityContext(directory);
  if (!priorityContext) {
    return null;
  }
  return `<notepad-priority>

## Priority Context

${priorityContext}

</notepad-priority>`;
}

async function main() {
  try {
    const input = await readStdin();
    let data = {};
    try { data = JSON.parse(input); } catch {}

    const directory = data.cwd || data.directory || process.cwd();
    const sessionId = data.sessionId || data.session_id || data.sessionid || '';
    const messages = [];

    // Check for updates (non-blocking)
    // Read version from OMC's own package.json, not the project's (fixes #516)
    let currentVersion = null;
    for (let i = 1; i <= 4; i++) {
      const candidate = join(__dirname, ...Array(i).fill('..'), 'package.json');
      const pkg = readJsonFile(candidate);
      if ((pkg?.name === 'oh-my-claude-sisyphus' || pkg?.name === 'oh-my-claudecode') && pkg?.version) {
        currentVersion = pkg.version;
        break;
      }
    }

    const updateInfo = currentVersion ? await checkForUpdates(currentVersion) : null;
    if (updateInfo) {
      // Read config to check autoUpgradePrompt preference
      const configPath = join(homedir(), '.claude', '.omc-config.json');
      const omcConfig = readJsonFile(configPath) || {};
      const autoUpgradePrompt = omcConfig.autoUpgradePrompt !== false; // default: true

      if (autoUpgradePrompt) {
        messages.push(`<session-restore>

[OMC AUTO-UPGRADE AVAILABLE]

oh-my-claudecode v${updateInfo.latestVersion} is available (current: v${updateInfo.currentVersion}).

ACTION: Use AskUserQuestion to ask the user if they want to upgrade now. Offer these options:
- "Upgrade now" (Recommended): Run \`npm install -g oh-my-claude-sisyphus@latest\` via Bash, then run \`omc install --force --skip-claude-check --refresh-hooks\` to reconcile hooks and CLAUDE.md
- "Skip this time": Continue the session without upgrading
- "Don't ask again": Tell the user to set "autoUpgradePrompt": false in ~/.claude/.omc-config.json to disable future prompts

Keep the prompt brief. If the user accepts, execute the upgrade commands and report the result.

</session-restore>

---
`);
      } else {
        messages.push(`<session-restore>

[OMC UPDATE AVAILABLE]

A new version of oh-my-claudecode is available: v${updateInfo.latestVersion} (current: ${updateInfo.currentVersion})

To update, run: omc update

</session-restore>

---
`);
      }
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

    // Check for notepad Priority Context (ALWAYS loaded on session start)
    const notepadContext = formatNotepadContext(directory);
    if (notepadContext) {
      messages.push(`<session-restore>

[NOTEPAD PRIORITY CONTEXT LOADED]

${notepadContext}

</session-restore>

---
`);
    }

    // Load root AGENTS.md if it exists (deepinit output - issue #613)
    // This ensures AI-readable directory documentation is available from session start
    const agentsMdPath = join(directory, 'AGENTS.md');
    if (existsSync(agentsMdPath)) {
      try {
        let agentsContent = readFileSync(agentsMdPath, 'utf-8').trim();
        if (agentsContent) {
          // Truncate to ~5000 tokens (20000 chars) to avoid context bloat
          const MAX_AGENTS_CHARS = 20000;
          let truncationNotice = '';
          if (agentsContent.length > MAX_AGENTS_CHARS) {
            agentsContent = agentsContent.slice(0, MAX_AGENTS_CHARS);
            truncationNotice = `\n\n[Note: Content was truncated. For full context, read: ${agentsMdPath}]`;
          }
          messages.push(`<session-restore>

[ROOT AGENTS.md LOADED]

The following project documentation was generated by deepinit to help AI agents understand the codebase:

${agentsContent}${truncationNotice}

</session-restore>

---
`);
        }
      } catch {
        // Skip if file can't be read
      }
    }

    if (messages.length > 0) {
      console.log(JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: messages.join('\n')
        }
      }));
    } else {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    }
  } catch (error) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

main();
