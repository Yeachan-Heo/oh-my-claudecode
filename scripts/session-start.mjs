#!/usr/bin/env node

/**
 * OMC Session Start Hook (Node.js)
 * Restores persistent mode states when session starts
 * Cross-platform: Windows, macOS, Linux
 */

import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync, symlinkSync, lstatSync, readlinkSync, unlinkSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Claude config directory (respects CLAUDE_CONFIG_DIR env var) */
const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

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

// Read JSON file safely
function readJsonFile(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

// Semantic version comparison (for cache cleanup sorting)
function semverCompare(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(s => parseInt(s, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map(s => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

// Extract OMC version from CLAUDE.md content
function extractOmcVersion(content) {
  const match = content.match(/<!-- OMC:VERSION:(\d+\.\d+\.\d+[^\s]*?) -->/);
  return match ? match[1] : null;
}

// Get plugin version from CLAUDE_PLUGIN_ROOT
function getPluginVersion() {
  try {
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    if (!pluginRoot) return null;
    const pkg = readJsonFile(join(pluginRoot, 'package.json'));
    return pkg?.version || null;
  } catch { return null; }
}

// Get npm global package version
function getNpmVersion() {
  try {
    const versionFile = join(configDir, '.omc-version.json');
    const data = readJsonFile(versionFile);
    return data?.version || null;
  } catch { return null; }
}

// Get CLAUDE.md version
function getClaudeMdVersion() {
  try {
    const claudeMdPath = join(configDir, 'CLAUDE.md');
    if (!existsSync(claudeMdPath)) return null;  // File doesn't exist
    const content = readFileSync(claudeMdPath, 'utf-8');
    const version = extractOmcVersion(content);
    return version || 'unknown';  // File exists but no marker = 'unknown'
  } catch { return null; }
}

// Detect version drift between components
function detectVersionDrift() {
  const pluginVersion = getPluginVersion();
  const npmVersion = getNpmVersion();
  const claudeMdVersion = getClaudeMdVersion();

  // Need at least plugin version to detect drift
  if (!pluginVersion) return null;

  const drift = [];

  if (npmVersion && npmVersion !== pluginVersion) {
    drift.push({ component: 'npm package (omc CLI)', current: npmVersion, expected: pluginVersion });
  }

  if (claudeMdVersion === 'unknown') {
    drift.push({
      component: 'CLAUDE.md instructions',
      current: 'unknown (needs migration)',
      expected: pluginVersion
    });
  } else if (claudeMdVersion && claudeMdVersion !== pluginVersion) {
    drift.push({
      component: 'CLAUDE.md instructions',
      current: claudeMdVersion,
      expected: pluginVersion
    });
  }

  if (drift.length === 0) return null;

  return { pluginVersion, npmVersion, claudeMdVersion, drift };
}

// Check if we should notify (once per unique drift combination)
function shouldNotifyDrift(driftInfo) {
  const stateFile = join(configDir, '.omc', 'update-state.json');
  const driftKey = `plugin:${driftInfo.pluginVersion}-npm:${driftInfo.npmVersion}-claude:${driftInfo.claudeMdVersion}`;

  try {
    if (existsSync(stateFile)) {
      const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
      if (state.lastNotifiedDrift === driftKey) return false;
    }
  } catch {}

  // Save new drift state
  try {
    const dir = join(configDir, '.omc');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stateFile, JSON.stringify({
      lastNotifiedDrift: driftKey,
      lastNotifiedAt: new Date().toISOString()
    }));
  } catch {}

  return true;
}

// Check npm registry for available update (with 24h cache)
async function checkNpmUpdate(currentVersion) {
  const cacheFile = join(configDir, '.omc', 'update-check.json');
  const CACHE_DURATION = 24 * 60 * 60 * 1000;
  const now = Date.now();

  // Check cache
  try {
    if (existsSync(cacheFile)) {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf-8'));
      if (cached.timestamp && (now - cached.timestamp) < CACHE_DURATION) {
        return (cached.updateAvailable && semverCompare(cached.latestVersion, currentVersion) > 0)
          ? { currentVersion, latestVersion: cached.latestVersion }
          : null;
      }
    }
  } catch {}

  // Fetch from npm registry with 2s timeout
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    const response = await fetch('https://registry.npmjs.org/oh-my-claudecode/latest', {
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!response.ok) return null;

    const data = await response.json();
    const latestVersion = data.version;
    const updateAvailable = semverCompare(latestVersion, currentVersion) > 0;

    // Update cache
    try {
      const dir = join(configDir, '.omc');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify({ timestamp: now, latestVersion, currentVersion, updateAvailable }));
    } catch {}

    return updateAvailable ? { currentVersion, latestVersion } : null;
  } catch { return null; }
}

// Check if HUD is properly installed (with retry for race conditions)
async function checkHudInstallation(retryCount = 0) {
  const hudDir = join(configDir, 'hud');
  // Support both legacy (omc-hud.mjs) and current (omc-hud.mjs) naming
  const hudScriptOmc = join(hudDir, 'omc-hud.mjs');
  const hudScriptLegacy = join(hudDir, 'omc-hud.mjs');
  const settingsFile = join(configDir, 'settings.json');

  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 100;

  // Check if HUD script exists (either naming convention)
  const hudScriptExists = existsSync(hudScriptOmc) || existsSync(hudScriptLegacy);
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

    const directory = data.cwd || data.directory || process.cwd();
    const sessionId = data.session_id || data.sessionId || '';
    const messages = [];

    // Check for version drift between components
    const driftInfo = detectVersionDrift();
    if (driftInfo && shouldNotifyDrift(driftInfo)) {
      let driftMsg = `[OMC VERSION DRIFT DETECTED]\n\nPlugin version: ${driftInfo.pluginVersion}\n`;
      for (const d of driftInfo.drift) {
        driftMsg += `${d.component}: ${d.current} (expected ${d.expected})\n`;
      }
      driftMsg += `\nRun 'omc update' to sync all components.`;

      messages.push(`<session-restore>\n\n${driftMsg}\n\n</session-restore>\n\n---\n`);
    }

    // Check npm registry for available update (with 24h cache)
    try {
      const pluginVersion = getPluginVersion();
      if (pluginVersion) {
        const updateInfo = await checkNpmUpdate(pluginVersion);
        if (updateInfo) {
          messages.push(`<session-restore>\n\n[OMC UPDATE AVAILABLE]\n\nA new version of oh-my-claudecode is available: v${updateInfo.latestVersion} (current: v${updateInfo.currentVersion})\n\nTo update, run: omc update\n(This syncs plugin, npm package, and CLAUDE.md together)\n\n</session-restore>\n\n---\n`);
        }
      }
    } catch {}

    // Check HUD installation (one-time setup guidance)
    const hudCheck = await checkHudInstallation();
    if (!hudCheck.installed) {
      messages.push(`<system-reminder>
[OMC] HUD not configured (${hudCheck.reason}). Run /hud setup then restart Claude Code.
</system-reminder>`);
    }

    // Check for ultrawork state - only restore if session matches (issue #311)
    // Session-scoped ONLY when session_id exists — no legacy fallback
    let ultraworkState = null;
    if (sessionId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) {
      // Session-scoped ONLY — no legacy fallback
      ultraworkState = readJsonFile(join(directory, '.omc', 'state', 'sessions', sessionId, 'ultrawork-state.json'));
      // Validate session identity
      if (ultraworkState && ultraworkState.session_id && ultraworkState.session_id !== sessionId) {
        ultraworkState = null;
      }
    } else {
      // No session_id — legacy behavior for backward compat
      ultraworkState = readJsonFile(join(directory, '.omc', 'state', 'ultrawork-state.json'));
    }

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

    // Check for ralph loop state
    // Session-scoped ONLY when session_id exists — no legacy fallback
    let ralphState = null;
    if (sessionId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) {
      // Session-scoped ONLY — no legacy fallback
      ralphState = readJsonFile(join(directory, '.omc', 'state', 'sessions', sessionId, 'ralph-state.json'));
      // Validate session identity
      if (ralphState && ralphState.session_id && ralphState.session_id !== sessionId) {
        ralphState = null;
      }
    } else {
      // No session_id — legacy behavior for backward compat
      ralphState = readJsonFile(join(directory, '.omc', 'state', 'ralph-state.json'));
      if (!ralphState) {
        ralphState = readJsonFile(join(directory, '.omc', 'ralph-state.json'));
      }
    }
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

    // Cleanup old plugin cache versions (keep latest 2, symlink the rest)
    // Instead of deleting old versions, replace them with symlinks to the latest.
    // This prevents "Cannot find module" errors for sessions started before a
    // plugin update whose CLAUDE_PLUGIN_ROOT still points to the old version.
    try {
      const cacheBase = join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
      if (existsSync(cacheBase)) {
        const versions = readdirSync(cacheBase)
          .filter(v => /^\d+\.\d+\.\d+/.test(v))
          .sort(semverCompare)
          .reverse();

        if (versions.length > 2) {
          const latest = versions[0];
          const toSymlink = versions.slice(2);
          for (const version of toSymlink) {
            try {
              const versionPath = join(cacheBase, version);
              const stat = lstatSync(versionPath);

              const isWin = process.platform === 'win32';
              const symlinkTarget = isWin ? join(cacheBase, latest) : latest;

              if (stat.isSymbolicLink()) {
                // Already a symlink — update only if pointing to wrong target.
                // Use atomic temp-symlink + rename to avoid a window where
                // the path doesn't exist (fixes race in issue #1007).
                const target = readlinkSync(versionPath);
                if (target === latest || target === join(cacheBase, latest)) continue;
                try {
                  const tmpLink = versionPath + '.tmp.' + process.pid;
                  symlinkSync(symlinkTarget, tmpLink, isWin ? 'junction' : undefined);
                  try {
                    renameSync(tmpLink, versionPath);
                  } catch {
                    // rename failed (e.g. cross-device) — fall back to unlink+symlink
                    try { unlinkSync(tmpLink); } catch {}
                    unlinkSync(versionPath);
                    symlinkSync(symlinkTarget, versionPath, isWin ? 'junction' : undefined);
                  }
                } catch (swapErr) {
                  if (swapErr?.code !== 'EEXIST') {
                    // Leave as-is rather than losing it
                  }
                }
              } else if (stat.isDirectory()) {
                // Directory → symlink: cannot be atomic, but run.cjs now
                // handles missing targets gracefully (issue #1007).
                rmSync(versionPath, { recursive: true, force: true });
                try {
                  symlinkSync(symlinkTarget, versionPath, isWin ? 'junction' : undefined);
                } catch (symlinkErr) {
                  // EEXIST: another session raced us — safe to ignore.
                  if (symlinkErr?.code !== 'EEXIST') {
                    // Symlink genuinely failed. Leave the path as-is.
                  }
                }
              }
            } catch {
              // lstatSync / rmSync / unlinkSync failure — leave old directory as-is.
            }
          }
        }
      }
    } catch {}

    // Send session-start notification (non-blocking, fire-and-forget)
    try {
      const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
      if (pluginRoot) {
        const { notify } = await import(pathToFileURL(join(pluginRoot, 'dist', 'notifications', 'index.js')).href);
        // Fire and forget - don't await, don't block session start
        notify('session-start', {
          sessionId,
          projectPath: directory,
          timestamp: new Date().toISOString(),
        }).catch(() => {}); // swallow errors silently
      }
    } catch {
      // Notification module not available, skip silently
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
