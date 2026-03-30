#!/usr/bin/env node

/**
 * PreToolUse Hook: OMC Reminder Enforcer (Node.js)
 * Injects contextual reminders before every tool execution
 * Cross-platform: Windows, macOS, Linux
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { readStdin } from './lib/stdin.mjs';

// Inlined from src/config/models.ts — avoids a dist/ import so the hook works
// before a build and stays consistent with the TypeScript source.
function isProviderSpecificModelId(modelId) {
  if (/^((us|eu|ap|global)\.anthropic\.|anthropic\.claude)/i.test(modelId)) return true;
  if (/^arn:aws(-[^:]+)?:bedrock:/i.test(modelId)) return true;
  if (modelId.toLowerCase().startsWith('vertex_ai/')) return true;
  return false;
}
function hasExtendedContextSuffix(modelId) {
  return /\[\d+[mk]\]$/i.test(modelId);
}
function isSubagentSafeModelId(modelId) {
  return isProviderSpecificModelId(modelId) && !hasExtendedContextSuffix(modelId);
}
const TIER_ALIASES = new Set(['sonnet', 'opus', 'haiku']);
function isTierAlias(modelId) {
  return TIER_ALIASES.has((modelId || '').toLowerCase());
}

const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;
const MODE_STATE_FILES = [
  'autopilot-state.json',
  'ultrapilot-state.json',
  'ralph-state.json',
  'ultrawork-state.json',
  'ultraqa-state.json',
  'pipeline-state.json',
  'team-state.json',
  'omc-teams-state.json',
];
const AGENT_HEAVY_TOOLS = new Set(['Task', 'TaskCreate', 'TaskUpdate']);
const PREFLIGHT_CONTEXT_THRESHOLD = parseInt(process.env.OMC_AGENT_PREFLIGHT_CONTEXT_THRESHOLD || '72', 10);
const QUIET_LEVEL = getQuietLevel();

function getQuietLevel() {
  const parsed = Number.parseInt(process.env.OMC_QUIET || '0', 10);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, parsed);
}

/**
 * Resolve transcript path in worktree environments.
 * Mirrors logic used by context safety/guard hooks.
 */
function resolveTranscriptPath(transcriptPath, cwd) {
  if (!transcriptPath) return transcriptPath;
  try {
    if (existsSync(transcriptPath)) return transcriptPath;
  } catch { /* fallthrough */ }

  const worktreePattern = /--claude-worktrees-[^/\\]+/;
  if (worktreePattern.test(transcriptPath)) {
    const resolvedPath = transcriptPath.replace(worktreePattern, '');
    try {
      if (existsSync(resolvedPath)) return resolvedPath;
    } catch { /* fallthrough */ }
  }

  const effectiveCwd = cwd || process.cwd();
  try {
    const gitCommonDir = execSync('git rev-parse --git-common-dir', {
      cwd: effectiveCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const absoluteCommonDir = resolve(effectiveCwd, gitCommonDir);
    const mainRepoRoot = dirname(absoluteCommonDir);

    const worktreeTop = execSync('git rev-parse --show-toplevel', {
      cwd: effectiveCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (mainRepoRoot !== worktreeTop) {
      const lastSep = transcriptPath.lastIndexOf('/');
      const sessionFile = lastSep !== -1 ? transcriptPath.substring(lastSep + 1) : '';
      if (sessionFile) {
        const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
        const projectsDir = join(configDir, 'projects');
        if (existsSync(projectsDir)) {
          const encodedMain = mainRepoRoot.replace(/[/\\]/g, '-');
          const resolvedPath = join(projectsDir, encodedMain, sessionFile);
          try {
            if (existsSync(resolvedPath)) return resolvedPath;
          } catch { /* fallthrough */ }
        }
      }
    }
  } catch { /* best-effort fallback */ }

  return transcriptPath;
}

function estimateContextPercent(transcriptPath) {
  if (!transcriptPath) return 0;

  let fd = -1;
  try {
    const stat = statSync(transcriptPath);
    if (stat.size === 0) return 0;

    fd = openSync(transcriptPath, 'r');
    const readSize = Math.min(4096, stat.size);
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, stat.size - readSize);
    closeSync(fd);
    fd = -1;

    const tail = buf.toString('utf-8');
    const windowMatch = tail.match(/"context_window"\s{0,5}:\s{0,5}(\d+)/g);
    const inputMatch = tail.match(/"input_tokens"\s{0,5}:\s{0,5}(\d+)/g);

    if (!windowMatch || !inputMatch) return 0;

    const lastWindow = parseInt(windowMatch[windowMatch.length - 1].match(/(\d+)/)[1], 10);
    const lastInput = parseInt(inputMatch[inputMatch.length - 1].match(/(\d+)/)[1], 10);

    if (lastWindow === 0) return 0;
    return Math.round((lastInput / lastWindow) * 100);
  } catch {
    return 0;
  } finally {
    if (fd !== -1) try { closeSync(fd); } catch { /* ignore */ }
  }
}

function buildPreflightRecoveryAdvice(contextPercent) {
  return `[OMC] Preflight context guard: ${contextPercent}% used ` +
    `(threshold: ${PREFLIGHT_CONTEXT_THRESHOLD}%). Avoid spawning additional agent-heavy tasks ` +
    `until context is reduced. Safe recovery: (1) pause new Task fan-out, (2) run /compact now, ` +
    `(3) if compact fails, open a fresh session and continue from .omc/state + .omc/notepad.md.`;
}

// Simple JSON field extraction
function extractJsonField(input, field, defaultValue = '') {
  try {
    const data = JSON.parse(input);
    return data[field] ?? defaultValue;
  } catch {
    // Fallback regex extraction
    const match = input.match(new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`, 'i'));
    return match ? match[1] : defaultValue;
  }
}

// Get agent tracking info from state file
function getAgentTrackingInfo(directory) {
  const trackingFile = join(directory, '.omc', 'state', 'subagent-tracking.json');
  try {
    if (existsSync(trackingFile)) {
      const data = JSON.parse(readFileSync(trackingFile, 'utf-8'));
      const running = (data.agents || []).filter(a => a.status === 'running').length;
      return { running, total: data.total_spawned || 0 };
    }
  } catch {}
  return { running: 0, total: 0 };
}

// Get todo status from project-local todos only
function getTodoStatus(directory) {
  let pending = 0;
  let inProgress = 0;

  // Check project-local todos
  const localPaths = [
    join(directory, '.omc', 'todos.json'),
    join(directory, '.claude', 'todos.json')
  ];

  for (const todoFile of localPaths) {
    if (existsSync(todoFile)) {
      try {
        const content = readFileSync(todoFile, 'utf-8');
        const data = JSON.parse(content);
        const todos = data.todos || data;
        if (Array.isArray(todos)) {
          pending += todos.filter(t => t.status === 'pending').length;
          inProgress += todos.filter(t => t.status === 'in_progress').length;
        }
      } catch {
        // Ignore errors
      }
    }
  }

  // NOTE: We intentionally do NOT scan the global ~/.claude/todos/ directory.
  // That directory accumulates todo files from ALL past sessions across all
  // projects, causing phantom task counts in fresh sessions (see issue #354).

  if (pending + inProgress > 0) {
    return `[${inProgress} active, ${pending} pending] `;
  }

  return '';
}

function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId);
}

function readJsonFile(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function hasActiveJsonMode(stateDir, { allowSessionTagged = false } = {}) {
  for (const file of MODE_STATE_FILES) {
    const state = readJsonFile(join(stateDir, file));
    if (!state || state.active !== true) continue;
    if (!allowSessionTagged && state.session_id) continue;
    return true;
  }
  return false;
}

function hasActiveSwarmMode(stateDir, { allowSessionTagged = false } = {}) {
  const markerFile = join(stateDir, 'swarm-active.marker');
  if (!existsSync(markerFile)) return false;

  const summary = readJsonFile(join(stateDir, 'swarm-summary.json'));
  if (!summary || summary.active !== true) return false;
  if (!allowSessionTagged && summary.session_id) return false;

  return true;
}

function hasActiveMode(directory, sessionId) {
  const stateDir = join(directory, '.omc', 'state');

  if (isValidSessionId(sessionId)) {
    const sessionStateDir = join(stateDir, 'sessions', sessionId);
    return (
      hasActiveJsonMode(sessionStateDir, { allowSessionTagged: true }) ||
      hasActiveSwarmMode(sessionStateDir, { allowSessionTagged: true })
    );
  }

  return (
    hasActiveJsonMode(stateDir, { allowSessionTagged: false }) ||
    hasActiveSwarmMode(stateDir, { allowSessionTagged: false })
  );
}

/**
 * Check if team mode is active for the given directory/session.
 * Reads team-state.json from session-scoped or legacy paths.
 * Returns the team state object if active, null otherwise.
 */
function getActiveTeamState(directory, sessionId) {
  const paths = [];

  // Session-scoped path (preferred)
  if (sessionId && SESSION_ID_PATTERN.test(sessionId)) {
    paths.push(join(directory, '.omc', 'state', 'sessions', sessionId, 'team-state.json'));
  }

  // Legacy path
  paths.push(join(directory, '.omc', 'state', 'team-state.json'));

  for (const statePath of paths) {
    const state = readJsonFile(statePath);
    if (state && state.active === true) {
      // Respect session isolation: skip state tagged to a different session
      if (sessionId && state.session_id && state.session_id !== sessionId) {
        continue;
      }
      return state;
    }
  }
  return null;
}

// Generate agent spawn message with metadata
function generateAgentSpawnMessage(toolInput, directory, todoStatus, sessionId) {
  if (!toolInput || typeof toolInput !== 'object') {
    if (QUIET_LEVEL >= 2) return '';
    return `${todoStatus}Launch multiple agents in parallel when tasks are independent. Use run_in_background for long operations.`;
  }

  const agentType = toolInput.subagent_type || 'unknown';
  const model = toolInput.model || 'inherit';
  const desc = toolInput.description || '';
  const bg = toolInput.run_in_background ? ' [BACKGROUND]' : '';
  const tracking = getAgentTrackingInfo(directory);

  // Team-routing enforcement (issue #1006):
  // When team state is active and Task is called WITHOUT team_name,
  // inject a redirect message to use team agents instead of subagents.
  const teamState = getActiveTeamState(directory, sessionId);
  if (teamState && !toolInput.team_name) {
    const teamName = teamState.team_name || teamState.teamName || 'team';
    return `[TEAM ROUTING REQUIRED] Team "${teamName}" is active but you are spawning a regular subagent ` +
      `without team_name. You MUST use TeamCreate first (if not already created), then spawn teammates with ` +
      `Task(team_name="${teamName}", name="worker-N", subagent_type="${agentType}"). ` +
      `Do NOT use Task without team_name during an active team session. ` +
      `If TeamCreate is not available in your tools, tell the user to verify ` +
      `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 is set in ~/.claude/settings.json and restart Claude Code.`;
  }

  if (QUIET_LEVEL >= 2) return '';

  const parts = [`${todoStatus}Spawning agent: ${agentType} (${model})${bg}`];
  if (desc) parts.push(`Task: ${desc}`);
  if (tracking.running > 0) parts.push(`Active agents: ${tracking.running}`);

  return parts.join(' | ');
}

// Generate contextual message based on tool type
function generateMessage(toolName, todoStatus, modeActive = false) {
  if (QUIET_LEVEL >= 1 && ['Bash', 'Edit', 'Write', 'Read', 'Grep', 'Glob'].includes(toolName)) {
    return '';
  }
  if (QUIET_LEVEL >= 2 && toolName === 'TodoWrite') {
    return '';
  }

  const messages = {
    TodoWrite: `${todoStatus}Mark todos in_progress BEFORE starting, completed IMMEDIATELY after finishing.`,
    Bash: `${todoStatus}Use parallel execution for independent tasks. Use run_in_background for long operations (npm install, builds, tests).`,
    Edit: `${todoStatus}Verify changes work after editing. Test functionality before marking complete.`,
    Write: `${todoStatus}Verify changes work after editing. Test functionality before marking complete.`,
    Read: `${todoStatus}Read multiple files in parallel when possible for faster analysis.`,
    Grep: `${todoStatus}Combine searches in parallel when investigating multiple patterns.`,
    Glob: `${todoStatus}Combine searches in parallel when investigating multiple patterns.`,
  };

  if (messages[toolName]) return messages[toolName];
  if (modeActive) return `${todoStatus}The boulder never stops. Continue until all tasks complete.`;
  return '';
}

// ---------------------------------------------------------------------------
// Skill Active State (issue #1033)
// Writes skill-active-state.json so the persistent-mode Stop hook can prevent
// premature session termination while a skill is executing.
// ---------------------------------------------------------------------------

const SKILL_PROTECTION_CONFIGS = {
  none:   { maxReinforcements: 0,  staleTtlMs: 0 },
  light:  { maxReinforcements: 3,  staleTtlMs: 5 * 60 * 1000 },
  medium: { maxReinforcements: 5,  staleTtlMs: 15 * 60 * 1000 },
  heavy:  { maxReinforcements: 10, staleTtlMs: 30 * 60 * 1000 },
};

const SKILL_PROTECTION_MAP = {
  // === Already have mode state → no additional protection ===
  autopilot: 'none', ralph: 'none', ultrawork: 'none', team: 'none',
  'omc-teams': 'none', ultraqa: 'none', cancel: 'none',

  // === Instant / read-only → no protection needed ===
  trace: 'none', hud: 'none', 'omc-doctor': 'none', 'omc-help': 'none',
  'learn-about-omc': 'none', note: 'none',

  // === Light protection (simple shortcuts, 3 reinforcements) ===
  skill: 'light', ask: 'light', 'configure-notifications': 'light',

  // === Medium protection (review/planning, 5 reinforcements) ===
  'omc-plan': 'medium', plan: 'medium',
  ralplan: 'none',  // Has first-class checkRalplan() enforcement; no skill-active needed
  'deep-interview': 'heavy',
  review: 'medium', 'external-context': 'medium',
  'ai-slop-cleaner': 'medium',
  sciomc: 'medium', learner: 'medium', 'omc-setup': 'medium',
  setup: 'medium',        // alias for omc-setup
  'mcp-setup': 'medium', 'project-session-manager': 'medium',
  psm: 'medium',          // alias for project-session-manager
  'writer-memory': 'medium', 'ralph-init': 'medium',
  release: 'medium', ccg: 'medium',

  // === Heavy protection (long-running, 10 reinforcements) ===
  deepinit: 'heavy',
};

function getSkillProtectionLevel(skillName, rawSkillName) {
  // When rawSkillName is provided, only apply protection to OMC-prefixed skills.
  // Non-prefixed skills are project custom skills or other plugins — no protection.
  // See: https://github.com/Yeachan-Heo/oh-my-claudecode/issues/1581
  if (rawSkillName != null && typeof rawSkillName === 'string' &&
      !rawSkillName.toLowerCase().startsWith('oh-my-claudecode:')) {
    return 'none';
  }
  const normalized = (skillName || '').toLowerCase().replace(/^oh-my-claudecode:/, '');
  return SKILL_PROTECTION_MAP[normalized] || 'none';
}

// Load OMC config to check forceInherit setting (issues #1135, #1201)
function loadOmcConfig() {
  const configPaths = [
    join(homedir(), '.claude', '.omc-config.json'),
    join(process.cwd(), '.omc', 'config.json'),
  ];
  for (const configPath of configPaths) {
    try {
      if (existsSync(configPath)) {
        return JSON.parse(readFileSync(configPath, 'utf-8'));
      }
    } catch { /* continue */ }
  }
  return {};
}

// Check if forceInherit is enabled via config or env var
function isForceInheritEnabled() {
  if (process.env.OMC_ROUTING_FORCE_INHERIT === 'true') return true;
  const config = loadOmcConfig();
  return config.routing?.forceInherit === true;
}

function extractSkillName(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const rawSkill = toolInput.skill || toolInput.skill_name || toolInput.skillName || toolInput.command || null;
  if (typeof rawSkill !== 'string' || !rawSkill.trim()) return null;
  const normalized = rawSkill.trim();
  return normalized.includes(':') ? normalized.split(':').at(-1).toLowerCase() : normalized.toLowerCase();
}

function writeSkillActiveState(directory, skillName, sessionId, rawSkillName) {
  const protection = getSkillProtectionLevel(skillName, rawSkillName);
  if (protection === 'none') return;

  const config = SKILL_PROTECTION_CONFIGS[protection];
  const now = new Date().toISOString();
  const normalized = (skillName || '').toLowerCase().replace(/^oh-my-claudecode:/, '');

  const stateDir = join(directory, '.omc', 'state');
  const safeSessionId = sessionId && SESSION_ID_PATTERN.test(sessionId) ? sessionId : '';
  const targetDir = safeSessionId
    ? join(stateDir, 'sessions', safeSessionId)
    : stateDir;
  const targetPath = join(targetDir, 'skill-active-state.json');

  // Nesting guard: when a skill (e.g. omc-setup) invokes a child skill
  // (e.g. mcp-setup), the child must not overwrite the parent's active state.
  // If a DIFFERENT skill is already active in this session, skip writing —
  // the parent's stop-hook protection already covers the session.
  // If the SAME skill is re-invoked, allow the overwrite (idempotent refresh).
  //
  // NOTE: This read-check-write sequence has a TOCTOU race condition
  // (non-atomic), but this is acceptable because Claude Code sessions are
  // single-threaded — only one tool call executes at a time within a session.
  try {
    if (existsSync(targetPath)) {
      const existing = JSON.parse(readFileSync(targetPath, 'utf-8'));
      if (existing.active && existing.skill_name && existing.skill_name !== normalized) {
        return; // A different skill already owns the active state — do not overwrite.
      }
    }
  } catch {
    // If read/parse fails, treat as no existing state — proceed with write
  }

  const state = {
    active: true,
    skill_name: normalized,
    session_id: safeSessionId || undefined,
    started_at: now,
    last_checked_at: now,
    reinforcement_count: 0,
    max_reinforcements: config.maxReinforcements,
    stale_ttl_ms: config.staleTtlMs,
  };

  try {
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }
    const tmpPath = targetPath + '.tmp';
    const envelope = {
      ...state,
      _meta: { written_at: now, mode: 'skill-active', ...(safeSessionId ? { sessionId: safeSessionId } : {}) },
    };
    writeFileSync(tmpPath, JSON.stringify(envelope, null, 2), { mode: 0o600 });
    renameSync(tmpPath, targetPath);
  } catch {
    // Best-effort; don't fail the hook
  }
}


function clearAwaitingConfirmationFlag(directory, stateName, sessionId) {
  const stateDir = join(directory, '.omc', 'state');
  const safeSessionId = sessionId && SESSION_ID_PATTERN.test(sessionId) ? sessionId : '';
  const paths = [
    safeSessionId ? join(stateDir, 'sessions', safeSessionId, `${stateName}-state.json`) : null,
    join(stateDir, `${stateName}-state.json`),
  ].filter(Boolean);

  for (const statePath of paths) {
    try {
      if (!existsSync(statePath)) continue;
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      if (!state || typeof state !== 'object' || !state.awaiting_confirmation) continue;
      delete state.awaiting_confirmation;
      const tmpPath = statePath + '.tmp';
      writeFileSync(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
      renameSync(tmpPath, statePath);
    } catch {
      // Best-effort; don't fail the hook
    }
  }
}

function confirmSkillModeStates(directory, skillName, sessionId) {
  switch (skillName) {
    case 'ralph':
      clearAwaitingConfirmationFlag(directory, 'ralph', sessionId);
      clearAwaitingConfirmationFlag(directory, 'ultrawork', sessionId);
      break;
    case 'ultrawork':
      clearAwaitingConfirmationFlag(directory, 'ultrawork', sessionId);
      break;
    case 'autopilot':
      clearAwaitingConfirmationFlag(directory, 'autopilot', sessionId);
      break;
    case 'ralplan':
      clearAwaitingConfirmationFlag(directory, 'ralplan', sessionId);
      break;
    default:
      break;
  }
}

// Record Skill/Task invocations to flow trace (best-effort)
async function recordToolInvocation(data, directory) {
  try {
    const toolName = data.toolName || data.tool_name || '';
    const sessionId = data.session_id || data.sessionId || '';
    if (!sessionId || !directory) return;

    if (toolName === 'Skill') {
      const skillName = data.toolInput?.skill || data.tool_input?.skill || '';
      if (skillName) {
        const { recordSkillInvoked } = await import('../dist/hooks/subagent-tracker/flow-tracer.js');
        recordSkillInvoked(directory, sessionId, skillName);
      }
    }
  } catch { /* best-effort, never block tool execution */ }
}

async function main() {
  // Skip guard: check OMC_SKIP_HOOKS env var (see issue #838)
  const _skipHooks = (process.env.OMC_SKIP_HOOKS || '').split(',').map(s => s.trim());
  if (process.env.DISABLE_OMC === '1' || _skipHooks.includes('pre-tool-use')) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  try {
    const input = await readStdin();

    const toolName = extractJsonField(input, 'tool_name') || extractJsonField(input, 'toolName', 'unknown');
    const directory = extractJsonField(input, 'cwd') || extractJsonField(input, 'directory', process.cwd());

    // Record Skill invocations to flow trace
    let data = {};
    try { data = JSON.parse(input); } catch {}
    recordToolInvocation(data, directory);

    // Activate skill state when Skill tool is invoked (issue #1033)
    // Writes skill-active-state.json so the persistent-mode Stop hook can
    // prevent premature session termination while a skill is executing.
    if (toolName === 'Skill') {
      const toolInput = data.toolInput || data.tool_input || {};
      const skillName = extractSkillName(toolInput);
      if (skillName) {
        const sid = typeof data.session_id === 'string' ? data.session_id
          : typeof data.sessionId === 'string' ? data.sessionId : '';
        // Pass rawSkillName to distinguish OMC skills from project custom skills (issue #1581)
        const rawSkill = toolInput.skill || toolInput.skill_name || toolInput.skillName || toolInput.command || '';
        const rawSkillName = typeof rawSkill === 'string' && rawSkill.trim() ? rawSkill.trim() : undefined;
        writeSkillActiveState(directory, skillName, sid, rawSkillName);
        confirmSkillModeStates(directory, skillName, sid);
      }
    }

    const sessionId =
      typeof data.session_id === 'string'
        ? data.session_id
        : typeof data.sessionId === 'string'
          ? data.sessionId
          : '';
    const modeActive = hasActiveMode(directory, sessionId);

    // Force-inherit check: deny Task/Agent calls with invalid model param when forceInherit is
    // enabled (Bedrock, Vertex, CC Switch, etc.) - issues #1135, #1201, #1767, #1868
    //
    // New behaviour (issue #1868 — [1m] suffix deadlock):
    //   ALLOW explicit valid provider-specific model IDs (full Bedrock/Vertex format, no [1m])
    //   DENY  tier names (sonnet/opus/haiku) and [1m]-suffixed IDs
    //   DENY  no-model calls when the session model itself has [1m] — guide to OMC_SUBAGENT_MODEL
    if (toolName === 'Task' || toolName === 'Agent') {
      const toolInput = data.toolInput || data.tool_input || {};
      const toolModel = toolInput.model;
      if (isForceInheritEnabled()) {
        // Check both vars: if either carries [1m] the session model is unsafe for sub-agents.
        // Avoids a split-brain between the hook and runtime code that may read the vars in
        // different orders (e.g. model-contract.ts uses ANTHROPIC_MODEL first).
        const claudeModel = process.env.CLAUDE_MODEL || '';
        const anthropicModel = process.env.ANTHROPIC_MODEL || '';
        const sessionHasLmSuffix =
          hasExtendedContextSuffix(claudeModel) || hasExtendedContextSuffix(anthropicModel);
        // For error messages: prefer whichever var actually carries the [1m] suffix.
        const sessionModel = hasExtendedContextSuffix(claudeModel)
          ? claudeModel
          : hasExtendedContextSuffix(anthropicModel)
            ? anthropicModel
            : claudeModel || anthropicModel;

        if (toolModel) {
          // Allow tier aliases (sonnet/opus/haiku) when OMC_SUBAGENT_MODEL is configured.
          // The Agent tool schema only accepts these short aliases — full Bedrock/Vertex model
          // IDs are rejected by the tool schema, leaving no valid escape hatch otherwise.
          // The routing layer maps tier aliases through OMC_SUBAGENT_MODEL at call time.
          const subagentModelForAlias = process.env.OMC_SUBAGENT_MODEL || '';
          if (isTierAlias(toolModel) && isSubagentSafeModelId(subagentModelForAlias)) {
            // fall through to continue — tier alias is safe when OMC_SUBAGENT_MODEL is a valid provider-specific ID
          } else if (!isSubagentSafeModelId(toolModel)) {
            const subagentModel = process.env.OMC_SUBAGENT_MODEL || '';
            const guidance = subagentModel
              ? `Pass model="${subagentModel}" (your configured OMC_SUBAGENT_MODEL value).`
              : `Remove the \`model\` parameter, or set OMC_SUBAGENT_MODEL=<valid-bedrock-id> and pass that value explicitly.`;
            console.log(JSON.stringify({
              continue: true,
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: `[MODEL ROUTING] This environment uses a non-standard provider (Bedrock/Vertex/proxy). ${guidance} The model "${toolModel}" is not valid for this provider.`
              }
            }));
            return;
          }
          // else: valid provider-specific model ID — fall through to continue.
        } else if (sessionHasLmSuffix) {
          // No model param, but the session model has a [1m] context-window suffix.
          // Sub-agents would inherit it and fail — the runtime strips [1m] to a bare
          // Anthropic model ID (e.g. claude-sonnet-4-6) which is invalid on Bedrock.
          const subagentModel = process.env.OMC_SUBAGENT_MODEL || '';
          const suggestion = subagentModel
            ? `Pass model="${subagentModel}" (your configured OMC_SUBAGENT_MODEL) explicitly on this ${toolName} call.`
            : `Set OMC_SUBAGENT_MODEL=<valid-bedrock-id> in your environment (use the model ID from the 400 error message, e.g. "us.anthropic.claude-sonnet-4-5-20250929-v1:0"), then pass that value as the model parameter.`;
          console.log(JSON.stringify({
            continue: true,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: `[MODEL ROUTING] Your session model "${sessionModel}" has a context-window suffix ([1m]) that sub-agents cannot inherit — the runtime strips it to a bare Anthropic model ID which is invalid on Bedrock. ${suggestion}`
            }
          }));
          return;
        }
        // else: no model param and no [1m] on session model → normal forceInherit,
        // agents inherit the parent session's model cleanly.
      }
    }

    // Send notification when AskUserQuestion is about to execute (user input needed)
    // Fires in PreToolUse so users get notified BEFORE the tool blocks for input (#597)
    if (toolName === 'AskUserQuestion') {
      try {
        const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
        if (pluginRoot) {
          const { notify } = await import(pathToFileURL(join(pluginRoot, 'dist', 'notifications', 'index.js')).href);

          const toolInput = data.toolInput || data.tool_input || {};
          const questions = toolInput.questions || [];
          const questionText = questions.map(q => q.question || '').filter(Boolean).join('; ') || 'User input requested';
          const sessionId = data.session_id || data.sessionId || '';

          // Fire and forget - don't block tool execution
          notify('ask-user-question', {
            sessionId,
            projectPath: directory,
            question: questionText,
          }).catch(() => {});
        }
      } catch {
        // Notification not available, skip
      }
    }

    const todoStatus = getTodoStatus(directory);

    if (AGENT_HEAVY_TOOLS.has(toolName)) {
      const rawTranscriptPath = data.transcript_path || data.transcriptPath || '';
      const transcriptPath = resolveTranscriptPath(rawTranscriptPath, directory);
      const contextPercent = estimateContextPercent(transcriptPath);

      if (contextPercent >= PREFLIGHT_CONTEXT_THRESHOLD) {
        console.log(JSON.stringify({
          decision: 'block',
          reason: buildPreflightRecoveryAdvice(contextPercent),
        }));
        return;
      }
    }

    let message;
    if (toolName === 'Task' || toolName === 'TaskCreate' || toolName === 'TaskUpdate') {
      const toolInput = data.toolInput || data.tool_input || null;
      message = generateAgentSpawnMessage(toolInput, directory, todoStatus, sessionId);
    } else {
      message = generateMessage(toolName, todoStatus, modeActive);
    }

    if (!message) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: message
      }
    }, null, 2));
  } catch (error) {
    // On error, always continue
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

main();
