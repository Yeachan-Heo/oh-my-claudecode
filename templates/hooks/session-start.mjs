#!/usr/bin/env node
// OMC Session Start Hook (Node.js)
// Restores persistent mode states when session starts
// Cross-platform: Windows, macOS, Linux

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Dynamic import for the shared stdin module
const { readStdin } = await import(join(__dirname, 'lib', 'stdin.mjs'));

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

function countIncompleteTodos(todosDir) {
  let count = 0;
  if (existsSync(todosDir)) {
    try {
      const files = readdirSync(todosDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const todos = readJsonFile(join(todosDir, file));
        if (Array.isArray(todos)) {
          count += todos.filter(t => t.status !== 'completed' && t.status !== 'cancelled').length;
        }
      }
    } catch {}
  }
  return count;
}

async function main() {
  try {
    const input = await readStdin();
    let data = {};
    try { data = JSON.parse(input); } catch {}

    const directory = data.directory || process.cwd();
    const messages = [];

    // Check for updates (non-blocking)
    const packageJsonPath = join(directory, 'package.json');
    let currentVersion = '3.8.4'; // fallback
    const packageJson = readJsonFile(packageJsonPath);
    if (packageJson?.version) {
      currentVersion = packageJson.version;
    }

    const updateInfo = await checkForUpdates(currentVersion);
    if (updateInfo) {
      messages.push(`<session-restore>

[OMC UPDATE AVAILABLE]

A new version of oh-my-claudecode is available: v${updateInfo.latestVersion} (current: ${updateInfo.currentVersion})

To update, run: claude /install-plugin oh-my-claudecode

</session-restore>

---
`);
    }

    // Check for ultrawork state
    const ultraworkState = readJsonFile(join(directory, '.omc', 'ultrawork-state.json'))
      || readJsonFile(join(homedir(), '.claude', 'ultrawork-state.json'));

    if (ultraworkState?.active) {
      messages.push(`<session-restore>

[ULTRAWORK MODE RESTORED]

You have an active ultrawork session from ${ultraworkState.started_at}.
Original task: ${ultraworkState.original_prompt}

Continue working in ultrawork mode until all tasks are complete.

</session-restore>

---
`);
    }

    // Check for incomplete todos
    const todosDir = join(homedir(), '.claude', 'todos');
    const incompleteCount = countIncompleteTodos(todosDir);

    if (incompleteCount > 0) {
      messages.push(`<session-restore>

[PENDING TASKS DETECTED]

You have ${incompleteCount} incomplete tasks from a previous session.
Please continue working on these tasks.

</session-restore>

---
`);
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
      console.log(JSON.stringify({ continue: true }));
    }
  } catch (error) {
    console.log(JSON.stringify({ continue: true }));
  }
}

main();
