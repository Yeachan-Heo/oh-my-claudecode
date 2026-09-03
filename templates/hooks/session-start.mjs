#!/usr/bin/env node
// OMC Session Start Hook (Node.js)
// Restores persistent mode states when session starts
// Cross-platform: Windows, macOS, Linux

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, rmSync, statSync } from 'fs';
import { join, dirname, normalize, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const { getClaudeConfigDir, getUpdateCheckCachePath } = await import(pathToFileURL(join(__dirname, 'lib', 'config-dir.mjs')).href);
const configDir = getClaudeConfigDir();
const { resolveSessionStatePathsForHook, resolveOmcStateRoot } = await import(pathToFileURL(join(__dirname, 'lib', 'state-root.mjs')).href);
const { publishCacheOccupancy } = await import(pathToFileURL(join(__dirname, 'lib', 'cache-occupancy.mjs')).href);

// Detached update-cache refresh: argv flag and the child's overall deadline.
const REFRESH_UPDATE_CACHE_FLAG = '--refresh-update-cache';
const REFRESH_UPDATE_CACHE_DEADLINE_MS = 3000;

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


const SESSION_ID_ALLOWLIST = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;
const WORKFLOW_SLOT_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;

async function isWorkflowSlotTombstonedForMode(directory, mode, sessionId) {
  const safeSessionId = typeof sessionId === 'string' && SESSION_ID_ALLOWLIST.test(sessionId) ? sessionId : '';
  const { readPath } = await resolveSessionStatePathsForHook(directory, 'skill-active', safeSessionId || undefined);
  const ledgerPath = readPath;
  const ledger = readJsonFile(ledgerPath);
  const slot = ledger?.active_skills?.[mode];
  if (!slot || typeof slot !== 'object') return false;
  if (typeof slot.completed_at !== 'string' || !slot.completed_at) return false;
  const completedAt = new Date(slot.completed_at).getTime();
  if (!Number.isFinite(completedAt)) return true;
  return Date.now() - completedAt < WORKFLOW_SLOT_TOMBSTONE_TTL_MS;
}

async function shouldRestoreModeState(directory, mode, state, sessionId) {
  if (!state?.active) return false;
  if (await isWorkflowSlotTombstonedForMode(directory, mode, sessionId)) return false;
  return true;
}

// Read version from OMC's own package.json, not the project's (fixes #516)
function resolveOmcVersion() {
  for (let i = 1; i <= 4; i++) {
    const candidate = join(__dirname, ...Array(i).fill('..'), 'package.json');
    const pkg = readJsonFile(candidate);
    if ((pkg?.name === 'oh-my-claude-sisyphus' || pkg?.name === 'oh-my-claudecode') && pkg?.version) {
      return pkg.version;
    }
  }
  return null;
}

// Registry base override. Only honoured when set; tests point it at a closed
// port to exercise the offline/timeout paths without touching the network.
function registryLatestUrl(packageName) {
  const base = process.env.OMC_UPDATE_REGISTRY_BASE;
  const root = base ? base.replace(/\/+$/, '') : 'https://registry.npmjs.org';
  return `${root}/${packageName}/latest`;
}

function readUpdateCheckCache() {
  const cached = readJsonFile(getUpdateCheckCachePath());
  return cached && typeof cached === 'object' && !Array.isArray(cached) ? cached : {};
}

// Merge into the existing cache so unrelated fields (e.g. the Claude Code
// version tracked below) survive an OMC-only refresh. Refresh children from
// concurrent sessions share this file, so serialize the read/modify/write and
// publish a complete JSON document with a same-directory rename.
function mergeUpdateCheckCache(fields) {
  const cachePath = getUpdateCheckCachePath();
  const cacheDir = dirname(cachePath);
  const lockPath = `${cachePath}.lock`;
  const deadline = Date.now() + 1000;
  let locked = false;

  try {
    mkdirSync(cacheDir, { recursive: true });
    while (!locked && Date.now() < deadline) {
      try {
        mkdirSync(lockPath);
        locked = true;
      } catch {
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > 10_000) {
            rmSync(lockPath, { recursive: true, force: true });
          }
        } catch {}
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } catch {}
      }
    }
    if (!locked) return;

    const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify({ ...readUpdateCheckCache(), ...fields }), 'utf-8');
    try {
      renameSync(temporaryPath, cachePath);
    } catch {
      // Windows cannot replace an existing file with rename. The lock keeps
      // other writers out; readers already tolerate a missing cache briefly.
      try { unlinkSync(cachePath); } catch {}
      renameSync(temporaryPath, cachePath);
    }
  } catch {
    // Cache refresh is best-effort and must never affect session startup.
  } finally {
    if (locked) {
      try { rmSync(lockPath, { recursive: true, force: true }); } catch {}
    }
  }
}

// Refresh the cached latest Claude Code version (same 24h window and 2s timeout
// as the OMC check) so the HUD can show a Claude Code update hint. The field is
// simply absent on caches written before this check existed.
async function checkClaudeCodeUpdate() {
  const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours
  const cached = readUpdateCheckCache();
  if (cached.claudeCodeCheckedAt && (Date.now() - cached.claudeCodeCheckedAt) < CACHE_DURATION) return;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(registryLatestUrl('@anthropic-ai/claude-code'), {
      signal: controller.signal
    });
    if (!response.ok) return;

    const data = await response.json();
    if (!data?.version) return;
    mergeUpdateCheckCache({ claudeCodeLatestVersion: data.version, claudeCodeCheckedAt: Date.now() });
  } catch {
    // Silent fail - network unavailable or timeout
  } finally { clearTimeout(timeoutId); }
}

async function checkForUpdates(currentVersion) {
  const cacheFile = getUpdateCheckCachePath();
  const now = Date.now();
  const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

  // Check cache first
  const cached = readJsonFile(cacheFile);
  if (cached && cached.timestamp && (now - cached.timestamp) < CACHE_DURATION) {
    return cached.updateAvailable ? cached : null;
  }

  // Fetch latest version from npm
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(registryLatestUrl('oh-my-claude-sisyphus'), {
      signal: controller.signal
    });

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
      updateAvailable,
      // This hook only queries npm; pin the source so the merge does not
      // preserve a stale marketplace value from an earlier plugin install.
      source: 'npm'
    };

    mergeUpdateCheckCache(cacheData);

    return updateAvailable ? cacheData : null;
  } catch (error) {
    // Silent fail - network unavailable or timeout
    return null;
  } finally { clearTimeout(timeoutId); }
}

// Concurrent: each fetch aborts after 2s, and SessionStart hooks have a 5s
// budget, so running them in sequence would risk a cold-cache timeout.
async function runUpdateChecks() {
  const currentVersion = resolveOmcVersion();
  const [updateInfo] = await Promise.all([
    currentVersion ? checkForUpdates(currentVersion).catch(() => null) : null,
    checkClaudeCodeUpdate().catch(() => {}),
  ]);
  return updateInfo;
}

// Refresh the update caches in a detached child so a slow or unreachable
// registry cannot delay the SessionStart response (the hook budget is 5s).
function refreshUpdateCacheInBackground() {
  if (process.env.OMC_HOOK_BACKGROUND_CHILD === '1') return;
  try {
    const child = spawn(process.execPath, [__filename, REFRESH_UPDATE_CACHE_FLAG], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, OMC_HOOK_BACKGROUND_CHILD: '1' },
    });
    // spawn reports most failures (EMFILE, EPERM, ENOMEM) via an async 'error'
    // event, not a throw; swallow it so the hook never exits non-zero after answering.
    child.on('error', () => {});
    child.unref();
  } catch {
    // Cache refresh is best-effort and must never affect hook output.
  }
}

// Detached child entrypoint: refresh the caches, then exit. The deadline keeps
// the child from lingering if a fetch never settles.
async function refreshUpdateCacheAndExit() {
  const deadline = setTimeout(() => process.exit(0), REFRESH_UPDATE_CACHE_DEADLINE_MS);
  deadline.unref();
  try { await runUpdateChecks(); } catch {}
  clearTimeout(deadline);
  process.exit(0);
}

function compareVersions(v1, v2) {
  const parts1 = v1.replace(/^v/, '').split('.').map(p => parseInt(p, 10) || 0);
  const parts2 = v2.replace(/^v/, '').split('.').map(p => parseInt(p, 10) || 0);

  for (let i = 0; i < 3; i++) {
    const diff = (parts1[i] || 0) - (parts2[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const OMC_STARTUP_COMPACTABLE_SECTIONS = [
  'agent_catalog',
  'skills',
  'team_compositions',
];
const OMC_STARTUP_GUIDANCE_MAX_CHARS = 8000;
const SESSION_START_CONTEXT_BUDGET = 6000;
const SESSION_START_OMISSION_NOTICE = '[Additional SessionStart context omitted to preserve the 6000-character aggregate budget.]';

const { MODEL_ROUTING_OVERRIDE_MESSAGE } = await import(pathToFileURL(join(__dirname, 'lib', 'model-routing-override-message.mjs')).href);

function isTruthyProviderFlag(value) {
  return value === '1' || value === 'true';
}

function getSessionModelId() {
  return process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || '';
}

function isBedrockSession() {
  if (isTruthyProviderFlag(process.env.CLAUDE_CODE_USE_BEDROCK)) return true;
  const modelId = getSessionModelId();
  return Boolean(
    modelId && (
      /^((us|eu|ap|global)\.anthropic\.|anthropic\.claude)/i.test(modelId) ||
      (
        /^arn:aws(-[^:]+)?:bedrock:/i.test(modelId) &&
        /:(inference-profile|application-inference-profile)\//i.test(modelId) &&
        modelId.toLowerCase().includes('claude')
      )
    )
  );
}

function isVertexSession() {
  if (isTruthyProviderFlag(process.env.CLAUDE_CODE_USE_VERTEX)) return true;
  const modelId = getSessionModelId();
  return Boolean(modelId && modelId.toLowerCase().startsWith('vertex_ai/'));
}

async function readRoutingForceInheritFromConfig(directory) {
  const omcRoot = await resolveOmcStateRoot(directory);
  const configPaths = [
    join(configDir, '.omc-config.json'),
    join(omcRoot, 'config.json'),
  ];

  for (const configPath of configPaths) {
    const config = readJsonFile(configPath);
    if (config?.routing?.forceInherit === true) return true;
  }

  return false;
}

async function shouldEmitModelRoutingOverride(directory) {
  if (process.env.OMC_ROUTING_FORCE_INHERIT === 'true') return true;
  if (process.env.OMC_ROUTING_FORCE_INHERIT === 'false') return false;
  if (await readRoutingForceInheritFromConfig(directory)) return true;

  if (isBedrockSession() || isVertexSession()) return true;

  const modelId = getSessionModelId();
  if (modelId && !modelId.toLowerCase().includes('claude')) return true;

  const baseUrl = process.env.ANTHROPIC_BASE_URL || '';
  if (baseUrl && !baseUrl.includes('anthropic.com')) return true;

  return false;
}


function compactBudgetedText(text, maxChars) {
  const notice = '\n...[truncated to preserve SessionStart context budget]';
  if (!text || text.length <= maxChars) return text || '';
  if (maxChars <= notice.length) return notice.slice(0, Math.max(0, maxChars));
  return `${text.slice(0, maxChars - notice.length).trimEnd()}${notice}`;
}

function looksLikeOmcGuidance(content) {
  return (
    typeof content === 'string' &&
    content.includes('<guidance_schema_contract>') &&
    /oh-my-(claudecode|codex)/i.test(content) &&
    OMC_STARTUP_COMPACTABLE_SECTIONS.some(
      section => content.includes(`<${section}>`) && content.includes(`</${section}>`),
    )
  );
}

function compactOmcStartupGuidance(content) {
  if (!looksLikeOmcGuidance(content)) return content;

  let compacted = content;
  let removedAny = false;

  for (const section of OMC_STARTUP_COMPACTABLE_SECTIONS) {
    const pattern = new RegExp(`\n*<${section}>[\\s\\S]*?</${section}>\n*`, 'g');
    const next = compacted.replace(pattern, '\n\n');
    removedAny = removedAny || next !== compacted;
    compacted = next;
  }

  const normalized = compacted
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n\n---\n\n---\n\n/g, '\n\n---\n\n')
    .trim();

  if (normalized.length <= OMC_STARTUP_GUIDANCE_MAX_CHARS) {
    return removedAny ? normalized : content;
  }

  const notice = '\n\n[OMC startup guidance truncated to preserve an 8000-character budget. Read the source file directly for the full document.]';
  return `${normalized.slice(0, OMC_STARTUP_GUIDANCE_MAX_CHARS - notice.length).trimEnd()}${notice}`;
}

function formatUpdateNoticeForUser(updateInfo, options = {}) {
  const latestVersion = updateInfo?.latestVersion || 'latest';
  const currentVersion = updateInfo?.currentVersion || 'unknown';
  const action = options.autoUpgradePrompt === false
    ? 'To update later, run: omc update'
    : 'Run /update to upgrade now, or use /plugin install oh-my-claudecode';
  return `[OMC UPDATE AVAILABLE] oh-my-claudecode v${latestVersion} is available (current: v${currentVersion}). ${action}`;
}

function buildSessionStartAdditionalContext(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';

  const sections = messages.map((message, index) => ({ index, message }));
  const priorityOrder = [
    /\[MODEL ROUTING OVERRIDE/,
    /\[AUTOPILOT MODE RESTORED\]/,
    /\[RALPH LOOP RESTORED\]/,
    /\[PROJECT MEMORY\]/,
    /\[NOTEPAD PRIORITY CONTEXT LOADED\]/,
    /\[PENDING TASKS DETECTED\]/,
  ];
  const prioritized = [];
  const remaining = [];
  for (const section of sections) {
    const score = priorityOrder.findIndex((pattern) => pattern.test(section.message));
    if (score !== -1) prioritized.push({ ...section, score });
    else remaining.push({ ...section, score: priorityOrder.length + section.index });
  }
  const ordered = [...prioritized.sort((a, b) => a.score - b.score || a.index - b.index), ...remaining]
    .map((entry) => entry.message);

  let used = 0;
  const selected = [];
  for (const message of ordered) {
    const separator = selected.length > 0 ? 1 : 0;
    if (used + separator + message.length > SESSION_START_CONTEXT_BUDGET) {
      const remainingBudget = SESSION_START_CONTEXT_BUDGET - used - separator;
      if (remainingBudget > 0) {
        selected.push(
          remainingBudget > 120
            ? compactBudgetedText(message, remainingBudget)
            : compactBudgetedText(SESSION_START_OMISSION_NOTICE, remainingBudget),
        );
      }
      break;
    }
    selected.push(message);
    used += separator + message.length;
  }

  return selected.join('\n');
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
async function getNotepadPath(directory) {
  const omcRoot = await resolveOmcStateRoot(directory);
  return join(omcRoot, NOTEPAD_FILENAME);
}

/**
 * Read notepad content
 */
async function readNotepad(directory) {
  const notepadPath = await getNotepadPath(directory);
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
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`${escaped}\\n([\\s\\S]*?)(?=\\n## [^#]|$)`);
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
async function getPriorityContext(directory) {
  const content = await readNotepad(directory);
  if (!content) {
    return null;
  }
  return extractSection(content, PRIORITY_HEADER);
}

/**
 * Format notepad context for session injection
 */
async function formatNotepadContext(directory) {
  const priorityContext = await getPriorityContext(directory);
  if (!priorityContext) {
    return null;
  }
  return `<notepad-priority>

## Priority Context

${priorityContext}

</notepad-priority>`;
}

/**
 * Validate that a candidate cwd is a real OMC workspace anchor.
 * Returns the candidate unchanged if it is non-empty AND contains a
 * `.omc-workspace` marker OR a `.git` directory.
 * Otherwise emits a one-line warning to stderr and returns null,
 * signalling the caller to skip all state mutations.
 */
function validateCwd(candidate) {
  if (!candidate || typeof candidate !== 'string') {
    process.stderr.write(
      `[OMC] session-start: refusing to use cwd '${candidate}' as workspace anchor (no .omc-workspace or .git marker)\n`
    );
    return null;
  }
  // cwd is commonly a subdirectory of the repo/workspace root, so walk up
  // looking for a `.omc-workspace` marker or `.git` dir. Stop before scanning
  // $HOME (or above) so a stray marker/repo in $HOME cannot validate an
  // unrelated directory. Returns the original candidate so downstream root
  // resolution (getOmcRoot/resolveOmcStateRoot) can anchor it.
  let home = null;
  try { home = homedir(); } catch { home = null; }
  let cursor = candidate;
  while (true) {
    if (home && cursor === home) break;
    if (existsSync(join(cursor, '.omc-workspace')) || existsSync(join(cursor, '.git'))) {
      return candidate;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  process.stderr.write(
    `[OMC] session-start: refusing to use cwd '${candidate}' as workspace anchor (no .omc-workspace or .git marker)\n`
  );
  return null;
}

function normalizePath(p) {
  if (!p || typeof p !== 'string') return '';
  let normalized = resolve(p);
  normalized = normalize(normalized).replace(/[\/\\]+$/, '');
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

async function main() {
  try {
    const input = await readStdin();
    let data = {};
    try { data = JSON.parse(input); } catch {}

    const rawDirectory = data.cwd || data.directory || process.cwd();
    const directory = validateCwd(rawDirectory);
    if (directory === null) {
      // No workspace here, but the registry update checks do not need one, so
      // the HUD update cache still refreshes for users who launch Claude Code
      // outside a repo. It runs detached: this path must answer immediately and
      // must not touch any workspace or session state.
      refreshUpdateCacheInBackground();
      console.log(JSON.stringify({ continue: true }));
      return;
    }
    const sessionId = data.sessionId || data.session_id || data.sessionid || '';
    if (process.env.CLAUDE_PLUGIN_ROOT) {
      publishCacheOccupancy(process.env.CLAUDE_PLUGIN_ROOT, configDir);
    }
    let messages = [];
    const userMessages = [];
    let pendingRestore = null;
    let pendingRestoreMessage = null;

    // Restore the newest PreCompact checkpoint after compaction (issue #3730).
    // Only fires when Claude Code signals the session resumed from compaction
    // (source === 'compact'); never on startup, resume, or clear.
    if (data.source === 'compact' && sessionId) {
      try {
        const { preparePreCompactCheckpointRestore, claimPreCompactCheckpointRestore } = await import(
          pathToFileURL(join(__dirname, 'lib', 'precompact-restore.mjs')).href
        );
        const restoreRoot = await resolveOmcStateRoot(directory);
        const prepared = preparePreCompactCheckpointRestore(restoreRoot, sessionId);
        if (prepared) {
          pendingRestore = { ...prepared, restoreRoot, preparePreCompactCheckpointRestore, claimPreCompactCheckpointRestore };
          pendingRestoreMessage = `<session-restore>\n\n${prepared.text}\n\n</session-restore>\n\n---\n`;
          messages.push(pendingRestoreMessage);
        }
      } catch {
        // Restore is advisory: never break session start on a checkpoint error.
      }
    }

    // Check for updates (non-blocking)
    const currentVersion = resolveOmcVersion();

    // Template-version drift check: warn once per session if installed templates differ from plugin
    if (currentVersion) {
      try {
        const omcRoot = await resolveOmcStateRoot(directory);
        const stampPath = join(omcRoot, 'template-version.json');
        const driftMarkerPath = join(omcRoot, 'state', `drift-warned-${sessionId || 'nosession'}.json`);
        if (existsSync(stampPath) && !existsSync(driftMarkerPath)) {
          const stamp = readJsonFile(stampPath);
          if (stamp?.version && stamp.version !== currentVersion) {
            process.stderr.write(
              `[omc] template version drift: installed=${stamp.version}, plugin=${currentVersion} — run /oh-my-claudecode:omc-setup to refresh\n`
            );
            mkdirSync(join(driftMarkerPath, '..'), { recursive: true });
            writeFileSync(driftMarkerPath, JSON.stringify({ warnedAt: new Date().toISOString() }));
          }
        }
      } catch { /* non-fatal */ }
    }

    const updateInfo = await runUpdateChecks();
    if (updateInfo) {
      const configPath = join(getClaudeConfigDir(), '.omc-config.json');
      const omcConfig = readJsonFile(configPath) || {};
      userMessages.push(formatUpdateNoticeForUser(updateInfo, {
        autoUpgradePrompt: omcConfig.autoUpgradePrompt !== false,
      }));
    }

    if (await shouldEmitModelRoutingOverride(directory)) {
      messages.push(MODEL_ROUTING_OVERRIDE_MESSAGE);
    }

    // Check for incomplete todos (project-local only, not global
    // [$CLAUDE_CONFIG_DIR|~/.claude]/todos/)
    // NOTE: We intentionally do NOT scan the global
    // [$CLAUDE_CONFIG_DIR|~/.claude]/todos/ directory.
    // That directory accumulates todo files from ALL past sessions across all
    // projects, causing phantom task counts in fresh sessions (see issue #354).
    const omcRootForTodos = await resolveOmcStateRoot(directory);
    const localTodoPaths = [
      join(omcRootForTodos, 'todos.json'),
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
    const notepadContext = await formatNotepadContext(directory);
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
        const agentsContent = compactOmcStartupGuidance(readFileSync(agentsMdPath, 'utf-8').trim());
        if (agentsContent) {
          messages.push(`<session-restore>

[ROOT AGENTS.md LOADED]

The following project documentation was generated by deepinit to help AI agents understand the codebase:

${agentsContent}

</session-restore>

---
`);
        }
      } catch {
        // Skip if file can't be read
      }
    }

    let additionalContext = '';
    if (pendingRestore && pendingRestoreMessage) {
      additionalContext = buildSessionStartAdditionalContext(messages);
      if (additionalContext.includes(pendingRestoreMessage)) {
        let markerStatus = null;
        const waitCell = new Int32Array(new SharedArrayBuffer(4));
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const status = pendingRestore.claimPreCompactCheckpointRestore(
            pendingRestore.restoreRoot,
            sessionId,
            pendingRestore.path,
            pendingRestore.created_at,
            pendingRestore.mtime_ms,
            pendingRestore.checkpoint_sha256,
          );
          if (status === 'written') {
            markerStatus = status;
            break;
          }
          if (status !== 'contended') break;
          Atomics.wait(waitCell, 0, 0, 10);
          const refreshed = pendingRestore.preparePreCompactCheckpointRestore(
            pendingRestore.restoreRoot,
            sessionId,
          );
          if (!refreshed) break;
          const refreshedMessage = `<session-restore>\n\n${refreshed.text}\n\n</session-restore>\n\n---\n`;
          const refreshedMessages = messages.map((message) => (
            message === pendingRestoreMessage ? refreshedMessage : message
          ));
          const refreshedContext = buildSessionStartAdditionalContext(refreshedMessages);
          if (!refreshedContext.includes(refreshedMessage)) break;
          pendingRestore = {
            ...refreshed,
            restoreRoot: pendingRestore.restoreRoot,
            preparePreCompactCheckpointRestore: pendingRestore.preparePreCompactCheckpointRestore,
            claimPreCompactCheckpointRestore: pendingRestore.claimPreCompactCheckpointRestore,
          };
          pendingRestoreMessage = refreshedMessage;
          messages = refreshedMessages;
          additionalContext = refreshedContext;
        }
        if (!markerStatus) {
          messages = messages.filter((message) => message !== pendingRestoreMessage);
          additionalContext = buildSessionStartAdditionalContext(messages);
        }
      } else {
        // The complete restore sentinel did not fit the aggregate budget;
        // do not commit a replay marker for context that was not delivered.
        messages = messages.filter((message) => message !== pendingRestoreMessage);
        additionalContext = buildSessionStartAdditionalContext(messages);
      }
    } else if (messages.length > 0) {
      additionalContext = buildSessionStartAdditionalContext(messages);
    }

    if (messages.length > 0 || userMessages.length > 0) {
      const output = {
        continue: true,
      };
      if (userMessages.length > 0) {
        output.systemMessage = userMessages.join('\n');
      }
      if (messages.length > 0) {
        output.hookSpecificOutput = {
          hookEventName: 'SessionStart',
          additionalContext,
        };
      }
      console.log(JSON.stringify(output));
    } else {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    }
  } catch (error) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

if (process.argv.includes(REFRESH_UPDATE_CACHE_FLAG)) {
  refreshUpdateCacheAndExit();
} else {
  main();
}
