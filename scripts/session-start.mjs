#!/usr/bin/env node

/**
 * OMC Session Start Hook (Node.js)
 * Restores persistent mode states when session starts
 * Cross-platform: Windows, macOS, Linux
 */

import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync, symlinkSync, lstatSync, readlinkSync, unlinkSync, renameSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { getClaudeConfigDir } from './lib/config-dir.mjs';
import { resolveOmcStateRoot } from './lib/state-root.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Claude config directory (respects CLAUDE_CONFIG_DIR env var) */
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

// Read JSON file safely
function readJsonFile(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

const WORKFLOW_SLOT_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;

function isWorkflowSlotTombstonedForMode(omcRoot, mode, sessionId) {
  const safeSessionId = typeof sessionId === 'string' && SAFE_SESSION_ID_PATTERN.test(sessionId) ? sessionId : '';
  const ledgerPath = safeSessionId
    ? join(omcRoot, 'state', 'sessions', safeSessionId, 'skill-active-state.json')
    : join(omcRoot, 'state', 'skill-active-state.json');
  const ledger = readJsonFile(ledgerPath);
  const slot = ledger?.active_skills?.[mode];
  if (!slot || typeof slot !== 'object') return false;
  if (typeof slot.completed_at !== 'string' || !slot.completed_at) return false;
  const completedAt = new Date(slot.completed_at).getTime();
  if (!Number.isFinite(completedAt)) return true;
  return Date.now() - completedAt < WORKFLOW_SLOT_TOMBSTONE_TTL_MS;
}

function shouldRestoreModeState(omcRoot, mode, state, sessionId) {
  if (!state?.active) return false;
  if (isWorkflowSlotTombstonedForMode(omcRoot, mode, sessionId)) return false;
  return true;
}

function readLinuxBootId() {
  try {
    if (!existsSync(LINUX_BOOT_ID_PATH)) return undefined;
    const bootId = readFileSync(LINUX_BOOT_ID_PATH, 'utf-8').trim();
    return bootId || undefined;
  } catch {
    return undefined;
  }
}

function sessionStateDir(omcRoot, sessionId) {
  return join(omcRoot, 'state', 'sessions', sessionId);
}

function sessionStartedMarkerPath(omcRoot, sessionId) {
  return join(sessionStateDir(omcRoot, sessionId), SESSION_STARTED_MARKER_FILE);
}

function writeSessionStartedMarker(omcRoot, directory, sessionId) {
  if (!sessionId || !SAFE_SESSION_ID_PATTERN.test(sessionId)) return;
  try {
    const dir = sessionStateDir(omcRoot, sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      sessionStartedMarkerPath(omcRoot, sessionId),
      JSON.stringify({
        session_id: sessionId,
        started_at: new Date().toISOString(),
        cwd: directory,
        pid: process.pid,
        // Do not persist process.ppid here: installed hooks run through
        // scripts/run.cjs, whose short-lived process exits as soon as this
        // hook returns. Treating that runner PID as owner liveness caused
        // later SessionStart hooks to falsely clean live session state.
        boot_id: readLinuxBootId(),
      }, null, 2),
      { encoding: 'utf-8', mode: 0o600 },
    );
  } catch {
    // Best-effort only; SessionStart must remain non-blocking.
  }
}

function removeSessionStartedMarker(omcRoot, sessionId) {
  if (!sessionId || !SAFE_SESSION_ID_PATTERN.test(sessionId)) return;
  try {
    const markerPath = sessionStartedMarkerPath(omcRoot, sessionId);
    if (existsSync(markerPath)) unlinkSync(markerPath);
  } catch {
    // Best-effort only.
  }
}

/**
 * Return true only when SessionStart has durable abandonment evidence.
 *
 * Claude Code SessionStart input currently provides session metadata such as
 * session_id, transcript_path, cwd, source, model, and agent_type, but no
 * stable owner process for the interactive session. In installed OMC hooks the
 * immediate hook parent belongs to scripts/run.cjs and is intentionally
 * short-lived, so same-boot PID liveness checks are not reliable here. SessionEnd
 * remains the primary same-boot cleanup path; SessionStart only reconciles
 * durable leftovers, such as markers from a previous OS boot.
 */
function hasDurableAbandonmentEvidence(marker) {
  const storedBootId = typeof marker?.boot_id === 'string' ? marker.boot_id : undefined;
  const currentBootId = readLinuxBootId();
  if (storedBootId && currentBootId && storedBootId !== currentBootId) {
    return true;
  }

  // Same-boot hard-kill cleanup requires a durable owner signal. Claude Code
  // does not currently provide one to hooks, so keep active state rather than
  // guessing from hook-runner process ancestry or transcript metadata.
  return false;
}

function cleanupSessionModeState(omcRoot, sessionId) {
  const sessionDir = sessionStateDir(omcRoot, sessionId);
  for (const file of SESSION_END_MODE_STATE_FILES) {
    try {
      const filePath = join(sessionDir, file);
      const state = readJsonFile(filePath);
      if (state?.active === true || file === 'skill-active-state.json') {
        unlinkSync(filePath);
      }
    } catch {
      // Leave ambiguous/unreadable state untouched.
    }
  }
}

function cleanupMissionStateForSession(omcRoot, sessionId) {
  const missionStatePath = join(omcRoot, 'state', 'mission-state.json');
  const parsed = readJsonFile(missionStatePath);
  if (!Array.isArray(parsed?.missions)) return;

  const before = parsed.missions.length;
  parsed.missions = parsed.missions.filter((mission) => {
    if (mission?.source !== 'session') return true;
    const missionId = typeof mission.id === 'string' ? mission.id : '';
    return !missionId.includes(sessionId);
  });
  if (parsed.missions.length !== before) {
    parsed.updatedAt = new Date().toISOString();
    try {
      writeFileSync(missionStatePath, JSON.stringify(parsed, null, 2));
    } catch {
      // Best-effort only.
    }
  }
}

function reconcileAbandonedSessionStarts(omcRoot, currentSessionId) {
  const sessionsDir = join(omcRoot, 'state', 'sessions');
  if (!existsSync(sessionsDir)) return;

  let entries = [];
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return;
  }

  for (const sessionId of entries) {
    if (!SAFE_SESSION_ID_PATTERN.test(sessionId) || sessionId === currentSessionId) continue;

    const marker = readJsonFile(sessionStartedMarkerPath(omcRoot, sessionId));
    if (!marker || marker.session_id !== sessionId) continue;

    if (existsSync(join(omcRoot, 'sessions', `${sessionId}.json`))) {
      removeSessionStartedMarker(omcRoot, sessionId);
      continue;
    }

    if (!hasDurableAbandonmentEvidence(marker)) continue;

    cleanupSessionModeState(omcRoot, sessionId);
    cleanupMissionStateForSession(omcRoot, sessionId);
    removeSessionStartedMarker(omcRoot, sessionId);

    try {
      const sessionDir = sessionStateDir(omcRoot, sessionId);
      if (readdirSync(sessionDir).length === 0) {
        rmSync(sessionDir, { recursive: false, force: true });
      }
    } catch {
      // Leave non-empty/unreadable directories untouched.
    }
  }
}

function getRuntimeBaseDir() {
  return process.env.CLAUDE_PLUGIN_ROOT || join(__dirname, '..');
}

async function loadProjectMemoryModules() {
  try {
    const runtimeBase = getRuntimeBaseDir();
    const [
      projectMemoryStorage,
      projectMemoryDetector,
      projectMemoryFormatter,
      rulesFinder,
    ] = await Promise.all([
      import(pathToFileURL(join(runtimeBase, 'dist', 'hooks', 'project-memory', 'storage.js')).href),
      import(pathToFileURL(join(runtimeBase, 'dist', 'hooks', 'project-memory', 'detector.js')).href),
      import(pathToFileURL(join(runtimeBase, 'dist', 'hooks', 'project-memory', 'formatter.js')).href),
      import(pathToFileURL(join(runtimeBase, 'dist', 'hooks', 'rules-injector', 'finder.js')).href),
    ]);

    return {
      loadProjectMemory: projectMemoryStorage.loadProjectMemory,
      saveProjectMemory: projectMemoryStorage.saveProjectMemory,
      shouldRescan: projectMemoryStorage.shouldRescan,
      detectProjectEnvironment: projectMemoryDetector.detectProjectEnvironment,
      formatContextSummary: projectMemoryFormatter.formatContextSummary,
      findProjectRoot: rulesFinder.findProjectRoot,
    };
  } catch {
    return null;
  }
}

function hasProjectMemoryContent(memory) {
  return Boolean(
    memory &&
    (
      memory.userDirectives?.length ||
      memory.customNotes?.length ||
      memory.hotPaths?.length ||
      memory.techStack?.languages?.length ||
      memory.techStack?.frameworks?.length ||
      memory.build?.buildCommand ||
      memory.build?.testCommand
    )
  );
}

async function resolveProjectMemorySummary(directory, projectMemoryModules) {
  const {
    detectProjectEnvironment,
    findProjectRoot,
    formatContextSummary,
    loadProjectMemory,
    saveProjectMemory,
    shouldRescan,
  } = projectMemoryModules;

  const projectRoot = findProjectRoot?.(directory);
  if (!projectRoot) {
    return '';
  }

  let memory = await loadProjectMemory?.(projectRoot);

  if ((!memory || shouldRescan?.(memory)) && detectProjectEnvironment && saveProjectMemory) {
    const existing = memory;
    memory = await detectProjectEnvironment(projectRoot);

    if (existing) {
      memory.customNotes = existing.customNotes;
      memory.userDirectives = existing.userDirectives;
    }

    await saveProjectMemory(projectRoot, memory);
  }

  if (!hasProjectMemoryContent(memory)) {
    return '';
  }

  return formatContextSummary(memory)?.trim() || '';
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

const SESSION_START_CONTEXT_BUDGET = 6000;
const SESSION_START_OMISSION_NOTICE = '[Additional SessionStart context omitted to preserve the 6000-character aggregate budget.]';
const SESSION_STARTED_MARKER_FILE = 'session-started.json';
const SAFE_SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;
const LINUX_BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
const SESSION_END_MODE_STATE_FILES = [
  'autopilot-state.json',
  'autoresearch-state.json',
  'team-state.json',
  'ralph-state.json',
  'ultrawork-state.json',
  'ultraqa-state.json',
  'ralplan-state.json',
  'deep-interview-state.json',
  'self-improve-state.json',
  'skill-active-state.json',
];

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

function buildSessionStartAdditionalContext(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';

  const sections = messages.map((message, index) => ({ index, message }));
  const priorityOrder = [
    /\[MODEL ROUTING OVERRIDE/,
    /\[AUTOPILOT MODE RESTORED\]/,
    /\[ULTRAWORK MODE RESTORED\]/,
    /\[RALPH LOOP RESTORED\]/,
    /\[PROJECT MEMORY\]/,
    /\[NOTEPAD - Priority Context\]/,
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch('https://registry.npmjs.org/oh-my-claude-sisyphus/latest', {
      signal: controller.signal
    });
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
  } catch { return null; } finally { clearTimeout(timeoutId); }
}

// Check if HUD is properly installed (with retry for race conditions)
async function checkHudInstallation(retryCount = 0) {
  const hudDir = join(configDir, 'hud');
  // Support current and legacy script names
  const hudScriptOmc = join(hudDir, 'omc-hud.mjs');
  const hudScriptLegacy = join(hudDir, 'omc-hud.js');
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

      const statusLineCommand = typeof settings.statusLine === 'string'
        ? settings.statusLine
        : (typeof settings.statusLine === 'object' && settings.statusLine && typeof settings.statusLine.command === 'string'
          ? settings.statusLine.command
          : null);

      // If OMC HUD wrapper is configured, ensure at least one plugin cache version is built.
      if (statusLineCommand?.includes('omc-hud')) {
        const pluginCacheBase = join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
        if (existsSync(pluginCacheBase)) {
          const versions = readdirSync(pluginCacheBase)
            .filter(version => !version.startsWith('.'))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            .reverse();
          if (versions.length > 0) {
            const hasBuiltHud = versions.some(version =>
              existsSync(join(pluginCacheBase, version, 'dist', 'hud', 'index.js'))
            );
            if (!hasBuiltHud) {
              const latestVersionDir = join(pluginCacheBase, versions[0]);
              return {
                installed: false,
                reason: `HUD plugin cache is not built. Run: cd "${latestVersionDir}" && npm install && npm run build`,
              };
            }
          }
        }
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
    const omcRoot = await resolveOmcStateRoot(directory);
    const messages = [];
    const projectMemoryModules = await loadProjectMemoryModules();

    writeSessionStartedMarker(omcRoot, directory, sessionId);
    reconcileAbandonedSessionStarts(omcRoot, sessionId);

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

    // Warn if silentAutoUpdate is enabled but running in plugin mode (#1773)
    if (process.env.CLAUDE_PLUGIN_ROOT) {
      try {
        const omcConfigPath = join(configDir, '.omc-config.json');
        const omcConfig = readJsonFile(omcConfigPath);
        if (omcConfig?.silentAutoUpdate) {
          messages.push(`<session-restore>\n\n[OMC] silentAutoUpdate is enabled in .omc-config.json but has no effect in plugin mode.\nTo update, use: /plugin marketplace update omc && /omc-setup\nOr run manually: omc update\n\n</session-restore>\n\n---\n`);
        }
      } catch {}
    }

    // Check HUD installation (one-time setup guidance)
    const hudCheck = await checkHudInstallation();
    if (!hudCheck.installed) {
      messages.push(`<system-reminder>
[OMC] HUD not configured (${hudCheck.reason}). Run /hud setup then restart Claude Code.
</system-reminder>`);
    }

    if (shouldEmitModelRoutingOverride(directory)) {
      messages.push(MODEL_ROUTING_OVERRIDE_MESSAGE);
    }

    // Check for ultrawork state - only restore if session matches (issue #311)
    // Session-scoped ONLY when session_id exists — no legacy fallback
    let ultraworkState = null;
    if (sessionId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) {
      // Session-scoped ONLY — no legacy fallback
      ultraworkState = readJsonFile(join(omcRoot, 'state', 'sessions', sessionId, 'ultrawork-state.json'));
      // Validate session identity
      if (ultraworkState && ultraworkState.session_id && ultraworkState.session_id !== sessionId) {
        ultraworkState = null;
      }
    } else {
      // No session_id — legacy behavior for backward compat
      ultraworkState = readJsonFile(join(omcRoot, 'state', 'ultrawork-state.json'));
    }

    if (shouldRestoreModeState(omcRoot, 'ultrawork', ultraworkState, sessionId)) {
      messages.push(`<session-restore>

[ULTRAWORK MODE RESTORED]

You have an active ultrawork session from ${ultraworkState.started_at}.
Original task: ${ultraworkState.original_prompt}

Treat this as prior-session context only. Prioritize the user's newest request, and resume ultrawork only if the user explicitly asks to continue it.

</session-restore>

---
`);
    }

    // Check for ralph loop state
    // Session-scoped ONLY when session_id exists — no legacy fallback
    let ralphState = null;
    if (sessionId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) {
      // Session-scoped ONLY — no legacy fallback
      ralphState = readJsonFile(join(omcRoot, 'state', 'sessions', sessionId, 'ralph-state.json'));
      // Validate session identity
      if (ralphState && ralphState.session_id && ralphState.session_id !== sessionId) {
        ralphState = null;
      }
    } else {
      // No session_id — legacy behavior for backward compat
      ralphState = readJsonFile(join(omcRoot, 'state', 'ralph-state.json'));
      if (!ralphState) {
        ralphState = readJsonFile(join(omcRoot, 'ralph-state.json'));
      }
    }
    if (shouldRestoreModeState(omcRoot, 'ralph', ralphState, sessionId)) {
      messages.push(`<session-restore>

[RALPH LOOP RESTORED]

You have an active ralph-loop session.
Original task: ${ralphState.prompt || 'Task in progress'}
Iteration: ${ralphState.iteration || 1}/${ralphState.max_iterations || 10}

Treat this as prior-session context only. Prioritize the user's newest request, and resume the ralph loop only if the user explicitly asks to continue it.

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
      join(omcRoot, 'todos.json'),
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
Treat this as prior-session context only. Prioritize the user's newest request, and resume these tasks only if the user explicitly asks to continue them.

</session-restore>

---
`);
    }

    if (projectMemoryModules) {
      try {
        const summary = await resolveProjectMemorySummary(directory, projectMemoryModules);
        if (summary) {
          messages.push(`<project-memory-context>

[PROJECT MEMORY]

${summary}

</project-memory-context>

---
`);
        }
      } catch {
        // Project memory is additive only; never break session start.
      }
    }

    // Check for notepad Priority Context
    const notepadPath = join(omcRoot, 'notepad.md');
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
      let versions = [];
      if (existsSync(cacheBase)) {
        versions = readdirSync(cacheBase)
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

      // Guard against CLAUDE_PLUGIN_ROOT pointing to a stale/deleted version.
      // When an old version directory is removed during upgrade but a running
      // session still has the old CLAUDE_PLUGIN_ROOT in its environment, the
      // directory won't exist. Create a symlink so subsequent hook invocations
      // via run.cjs resolve correctly.
      const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT?.replace(/[\/\\]+$/, ''); // strip trailing separators
      if (pluginRoot && !existsSync(pluginRoot)) {
        const pluginRootVersion = basename(pluginRoot);
        if (/^\d+\.\d+\.\d+/.test(pluginRootVersion) && versions.length > 0) {
          const latest = versions[0];
          const stalePath = pluginRoot;
          const isWin = process.platform === 'win32';
          // Always use absolute path to avoid symlink target resolution issues
          // when stalePath is not under cacheBase (e.g., after config-dir move)
          const symlinkTarget = join(cacheBase, latest);
          try {
            // Atomic: create temp symlink then rename over stale path
            const tmpLink = stalePath + '.tmp.' + process.pid;
            // Ensure parent dir exists (stalePath may reference a deleted config tree)
            const parentDir = dirname(stalePath);
            if (!existsSync(parentDir)) {
              try { mkdirSync(parentDir, { recursive: true }); } catch {}
            }
            symlinkSync(symlinkTarget, tmpLink, isWin ? 'junction' : undefined);
            try {
              renameSync(tmpLink, stalePath);
            } catch {
              try { unlinkSync(tmpLink); } catch {}
              // Remove any pre-existing dangling symlink/junction at stalePath
              // before recreating, otherwise symlinkSync throws EEXIST
              try { unlinkSync(stalePath); } catch {}
              symlinkSync(symlinkTarget, stalePath, isWin ? 'junction' : undefined);
            }
          } catch {}
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

        // Start reply listener daemon if notification reply config is available
        try {
          const { startReplyListener, buildDaemonConfig } = await import(pathToFileURL(join(pluginRoot, 'dist', 'notifications', 'reply-listener.js')).href);
          const replyConfig = await buildDaemonConfig();
          if (replyConfig) {
            startReplyListener(replyConfig);
          }
        } catch {
          // Reply listener not available or not configured, skip silently
        }
      }
    } catch {
      // Notification module not available, skip silently
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
