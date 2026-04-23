#!/usr/bin/env node
// OMC Session Start Hook (Node.js)
// Restores persistent mode states when session starts
// Cross-platform: Windows, macOS, Linux

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, normalize, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const { getClaudeConfigDir } = await import(pathToFileURL(join(__dirname, 'lib', 'config-dir.mjs')).href);
const configDir = getClaudeConfigDir();

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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch('https://registry.npmjs.org/oh-my-claude-sisyphus/latest', {
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
      updateAvailable
    };

    writeJsonFile(cacheFile, cacheData);

    return updateAvailable ? cacheData : null;
  } catch (error) {
    // Silent fail - network unavailable or timeout
    return null;
  } finally { clearTimeout(timeoutId); }
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

const MODEL_ROUTING_OVERRIDE_MESSAGE = `<system-reminder>

[MODEL ROUTING OVERRIDE — NON-STANDARD PROVIDER DETECTED]

This environment uses a non-standard model provider (AWS Bedrock, Google Vertex AI, or a proxy).
Do NOT pass the \`model\` parameter on Task/Agent calls. Omit it entirely so agents inherit the parent session's model.
The CLAUDE.md instruction "Pass model on Task calls: haiku, sonnet, opus" does NOT apply here.

</system-reminder>`;

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

function readRoutingForceInheritFromConfig(directory) {
  const configPaths = [
    join(configDir, '.omc-config.json'),
    join(directory, '.omc', 'config.json'),
  ];

  for (const configPath of configPaths) {
    const config = readJsonFile(configPath);
    if (config?.routing?.forceInherit === true) return true;
  }

  return false;
}

function shouldEmitModelRoutingOverride(directory) {
  if (process.env.OMC_ROUTING_FORCE_INHERIT === 'true') return true;
  if (process.env.OMC_ROUTING_FORCE_INHERIT === 'false') return false;
  if (readRoutingForceInheritFromConfig(directory)) return true;

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

function buildSessionStartAdditionalContext(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';

  const sections = messages.map((message, index) => ({ index, message }));
  const priorityOrder = [
    /\[MODEL ROUTING OVERRIDE/,
    /\[AUTOPILOT MODE RESTORED\]/,
    /\[ULTRAWORK MODE RESTORED\]/,
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

const STALE_STATE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

function normalizePath(p) {
  if (!p || typeof p !== 'string') return '';
  let normalized = resolve(p);
  normalized = normalize(normalized).replace(/[\/\\]+$/, '');
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

function getStateRecencyMs(state) {
  if (!state || typeof state !== 'object') return 0;
  const startedAt = state.started_at ? new Date(state.started_at).getTime() : 0;
  const lastCheckedAt = state.last_checked_at ? new Date(state.last_checked_at).getTime() : 0;
  return Math.max(startedAt || 0, lastCheckedAt || 0);
}

function isFreshActiveState(state) {
  if (!state?.active) return false;
  const recencyMs = getStateRecencyMs(state);
  if (!Number.isFinite(recencyMs) || recencyMs <= 0) return false;
  return (Date.now() - recencyMs) <= STALE_STATE_THRESHOLD_MS;
}

function hasConflictingUltraworkRestore(state, sessionId, directory, source) {
  if (!sessionId || !isFreshActiveState(state)) return false;
  if (typeof state.session_id !== 'string' || !state.session_id || state.session_id === sessionId) {
    return false;
  }

  if (source === 'global') {
    if (typeof state.project_path !== 'string' || !state.project_path) {
      return false;
    }
    return normalizePath(state.project_path) === normalizePath(directory);
  }

  return true;
}

function getUltraworkRestoreCandidate(directory, sessionId) {
  const localPath = join(directory, '.omc', 'state', 'ultrawork-state.json');
  const globalPath = join(homedir(), '.omc', 'state', 'ultrawork-state.json');

  const localState = readJsonFile(localPath);
  if (hasConflictingUltraworkRestore(localState, sessionId, directory, 'local')) {
    return { restore: null, collision: { source: 'local', state: localState } };
  }
  if (localState?.active && (!localState.session_id || localState.session_id === sessionId)) {
    return { restore: localState, collision: null };
  }

  const globalState = readJsonFile(globalPath);
  if (hasConflictingUltraworkRestore(globalState, sessionId, directory, 'global')) {
    return { restore: null, collision: { source: 'global', state: globalState } };
  }
  if (globalState?.active && (!globalState.session_id || globalState.session_id === sessionId)) {
    return { restore: globalState, collision: null };
  }

  return { restore: null, collision: null };
}

function formatUltraworkCollisionWarning(source, state) {
  const startedAt = state?.started_at || 'an unknown time';
  const ownerSession = state?.session_id || 'another session';
  const scope = source === 'global' ? 'matching project path in the shared global fallback state' : 'this repo root';
  return `<session-restore>

[PARALLEL SESSION WARNING]

Detected an active ultrawork session for ${scope}.
Owner session: ${ownerSession}
Started: ${startedAt}

To avoid shared \.omc/state bleed across parallel sessions, OMC suppressed the restore for this session.
Continue normally in this session, or use a separate worktree / close the other same-root session before resuming the prior ultrawork state.

</session-restore>

---
`;
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
      const configPath = join(getClaudeConfigDir(), '.omc-config.json');
      const omcConfig = readJsonFile(configPath) || {};
      const autoUpgradePrompt = omcConfig.autoUpgradePrompt !== false; // default: true

      if (autoUpgradePrompt) {
        messages.push(`<session-restore>

[OMC AUTO-UPGRADE AVAILABLE]

oh-my-claudecode v${updateInfo.latestVersion} is available (current: v${updateInfo.currentVersion}).

ACTION: Use AskUserQuestion to ask the user if they want to upgrade now. Offer these options:
- "Upgrade now" (Recommended): Run \`npm install -g oh-my-claude-sisyphus@latest\` via Bash, then run \`omc install --force --skip-claude-check --refresh-hooks\` to reconcile hooks and CLAUDE.md
- "Skip this time": Continue the session without upgrading
- "Don't ask again": Tell the user to set "autoUpgradePrompt": false in [$CLAUDE_CONFIG_DIR|~/.claude]/.omc-config.json to disable future prompts

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

    if (shouldEmitModelRoutingOverride(directory)) {
      messages.push(MODEL_ROUTING_OVERRIDE_MESSAGE);
    }

    // Check for ultrawork state - warn on conflicting same-path session, otherwise restore.
    const ultraworkCandidate = getUltraworkRestoreCandidate(directory, sessionId);
    if (ultraworkCandidate.collision) {
      messages.push(
        formatUltraworkCollisionWarning(
          ultraworkCandidate.collision.source,
          ultraworkCandidate.collision.state,
        ),
      );
    } else if (ultraworkCandidate.restore) {
      const ultraworkState = ultraworkCandidate.restore;
      messages.push(`<session-restore>

[ULTRAWORK MODE RESTORED]

You have an active ultrawork session from ${ultraworkState.started_at}.
Original task: ${ultraworkState.original_prompt}

Continue working in ultrawork mode until all tasks are complete.

</session-restore>

---
`);
    }

    // Check for incomplete todos (project-local only, not global
    // [$CLAUDE_CONFIG_DIR|~/.claude]/todos/)
    // NOTE: We intentionally do NOT scan the global
    // [$CLAUDE_CONFIG_DIR|~/.claude]/todos/ directory.
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

    if (messages.length > 0) {
      console.log(JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: buildSessionStartAdditionalContext(messages)
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
