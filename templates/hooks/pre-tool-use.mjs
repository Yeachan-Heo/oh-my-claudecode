#!/usr/bin/env node
/**
 * OMC Pre-Tool-Use Hook (Node.js)
 * Enforces delegation by warning when orchestrator attempts direct source file edits.
 * Also activates skill-active state for Stop hook protection (issue #1033).
 */

import * as path from 'path';
import { dirname } from 'path';
import { existsSync, mkdirSync, writeFileSync, renameSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Dynamic import for the shared stdin module
const { readStdin } = await import(pathToFileURL(path.join(__dirname, 'lib', 'stdin.mjs')).href);

// ---------------------------------------------------------------------------
// Skill Active State (issue #1033)
// Writes skill-active-state.json so the persistent-mode Stop hook can prevent
// premature session termination while a skill is executing.
// ---------------------------------------------------------------------------

/**
 * Skill protection levels: none/light/medium/heavy.
 * - 'none': Already has dedicated mode state (ralph, autopilot) or instant/read-only
 * - 'light': Quick agent shortcuts (3 reinforcements, 5 min TTL)
 * - 'medium': Review/planning skills that run multiple agents (5 reinforcements, 15 min TTL)
 * - 'heavy': Long-running skills (10 reinforcements, 30 min TTL)
 */
const PROTECTION_CONFIGS = {
  none:   { maxReinforcements: 0,  staleTtlMs: 0 },
  light:  { maxReinforcements: 3,  staleTtlMs: 5 * 60 * 1000 },
  medium: { maxReinforcements: 5,  staleTtlMs: 15 * 60 * 1000 },
  heavy:  { maxReinforcements: 10, staleTtlMs: 30 * 60 * 1000 },
};

const SKILL_PROTECTION = {
  // Already have mode state → no protection needed
  autopilot: 'none', ralph: 'none', ultrawork: 'none', team: 'none',
  'omc-teams': 'none', ultraqa: 'none', cancel: 'none',
  // Instant / read-only → no protection needed
  trace: 'none', hud: 'none', 'omc-doctor': 'none', 'omc-help': 'none',
  'learn-about-omc': 'none', note: 'none',
  // Light protection (3 reinforcements)
  tdd: 'light', 'build-fix': 'light', analyze: 'light', skill: 'light',
  'configure-notifications': 'light',
  // Medium protection (5 reinforcements)
  'code-review': 'medium', 'security-review': 'medium', plan: 'medium',
  ralplan: 'medium', review: 'medium', 'external-context': 'medium',
  sciomc: 'medium', learner: 'medium', 'omc-setup': 'medium',
  'mcp-setup': 'medium', 'project-session-manager': 'medium',
  'writer-memory': 'medium', 'ralph-init': 'medium', ccg: 'medium',
  // Heavy protection (10 reinforcements)
  deepinit: 'heavy',
};

function getSkillProtection(skillName) {
  const normalized = (skillName || '').toLowerCase().replace(/^oh-my-claudecode:/, '');
  return SKILL_PROTECTION[normalized] || 'light';
}

function getInvokedSkillName(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const rawSkill = toolInput.skill || toolInput.skill_name || toolInput.skillName || toolInput.command || null;
  if (typeof rawSkill !== 'string' || !rawSkill.trim()) return null;
  const normalized = rawSkill.trim();
  return normalized.includes(':') ? normalized.split(':').at(-1).toLowerCase() : normalized.toLowerCase();
}

const SESSION_ID_ALLOWLIST = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;

function writeSkillActiveState(directory, skillName, sessionId) {
  const protection = getSkillProtection(skillName);
  if (protection === 'none') return;

  const config = PROTECTION_CONFIGS[protection];
  const now = new Date().toISOString();
  const normalized = (skillName || '').toLowerCase().replace(/^oh-my-claudecode:/, '');

  const state = {
    active: true,
    skill_name: normalized,
    session_id: sessionId || undefined,
    started_at: now,
    last_checked_at: now,
    reinforcement_count: 0,
    max_reinforcements: config.maxReinforcements,
    stale_ttl_ms: config.staleTtlMs,
  };

  const stateDir = path.join(directory, '.omc', 'state');

  // Write to session-scoped path when sessionId is available (must match persistent-mode.mjs reads)
  const safeSessionId = sessionId && SESSION_ID_ALLOWLIST.test(sessionId) ? sessionId : '';
  const targetDir = safeSessionId
    ? path.join(stateDir, 'sessions', safeSessionId)
    : stateDir;
  const targetPath = path.join(targetDir, 'skill-active-state.json');

  try {
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }
    const tmpPath = targetPath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmpPath, targetPath);
  } catch {
    // Best-effort; don't fail the hook
  }
}

// ---------------------------------------------------------------------------
// Delegation enforcement
// ---------------------------------------------------------------------------

// Allowed path patterns (no warning)
// Paths are normalized to forward slashes before matching
const ALLOWED_PATH_PATTERNS = [
  /^\.omc\//,          // .omc/** (anchored)
  /^\.claude\//,       // .claude/** (anchored)
  /\/\.claude\//,      // any /.claude/ path (intentionally unanchored for absolute paths)
  /CLAUDE\.md$/,
  /AGENTS\.md$/,
];

// Source file extensions (should warn)
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw',
  '.go', '.rs', '.java', '.kt', '.scala',
  '.c', '.cpp', '.cc', '.h', '.hpp',
  '.rb', '.php',
  '.svelte', '.vue',
  '.graphql', '.gql',
  '.sh', '.bash', '.zsh',
]);

function isAllowedPath(filePath) {
  if (!filePath) return true;
  // Normalize path: convert backslashes, resolve . and .. segments, ensure forward slashes
  const clean = path.normalize(filePath.replace(/\\/g, '/')).replace(/\\/g, '/');
  if (clean.startsWith('../') || clean === '..') return false;
  return ALLOWED_PATH_PATTERNS.some(pattern => pattern.test(clean));
}

function isSourceFile(filePath) {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  return SOURCE_EXTENSIONS.has(ext);
}

// Patterns that indicate file modification in bash commands
const FILE_MODIFY_PATTERNS = [
  /sed\s+-i/,
  />\s*[^&]/,
  />>/,
  /tee\s+/,
  /cat\s+.*>\s*/,
  /echo\s+.*>\s*/,
  /printf\s+.*>\s*/,
];

// Source file pattern for command inspection
const SOURCE_EXT_PATTERN = /\.(ts|tsx|js|jsx|mjs|cjs|py|pyw|go|rs|java|kt|scala|c|cpp|cc|h|hpp|rb|php|svelte|vue|graphql|gql|sh|bash|zsh)/i;
const WORKER_BLOCKED_TMUX_PATTERN = /\btmux\s+(split-window|new-session|new-window|join-pane)\b/i;
const WORKER_BLOCKED_TEAM_CLI_PATTERN = /\bom[cx]\s+team\b(?!\s+api\b)/i;
const WORKER_BLOCKED_SKILL_PATTERN = /\$(team|ultrawork|autopilot|ralph)\b/i;

function teamWorkerIdentity() {
  return (process.env.OMC_TEAM_WORKER || process.env.OMX_TEAM_WORKER || '').trim();
}

function workerCommandViolation(command) {
  if (!command) return null;
  if (WORKER_BLOCKED_TMUX_PATTERN.test(command)) {
    return 'Team worker cannot run tmux pane/session orchestration commands.';
  }
  if (WORKER_BLOCKED_TEAM_CLI_PATTERN.test(command)) {
    return 'Team worker cannot run team orchestration commands (except `omc team api ...`).';
  }
  if (WORKER_BLOCKED_SKILL_PATTERN.test(command)) {
    return 'Team worker cannot invoke orchestration skills (`$team`, `$ultrawork`, `$autopilot`, `$ralph`).';
  }
  return null;
}

function checkBashCommand(command) {
  // Check if command might modify files
  const mayModify = FILE_MODIFY_PATTERNS.some(pattern => pattern.test(command));
  if (!mayModify) return null;

  // Check if it might affect source files
  if (SOURCE_EXT_PATTERN.test(command)) {
    return `[DELEGATION NOTICE] Bash command may modify source files: ${command}

Recommended: Delegate to executor agent instead:
  Task(subagent_type="oh-my-claudecode:executor", model="sonnet", prompt="...")

This is a soft warning. Operation will proceed.`;
  }
  return null;
}

async function main() {
  const input = await readStdin();

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Extract tool name (handle both cases)
  const toolName = data.tool_name || data.toolName || '';
  const worker = teamWorkerIdentity();

  if (worker) {
    if (toolName === 'Task' || toolName === 'task') {
      console.log(JSON.stringify({
        continue: false,
        reason: 'team-worker-task-blocked',
        message: `Worker ${worker} cannot spawn/delegate Task calls in worker mode.`
      }));
      return;
    }

    if (toolName === 'Skill' || toolName === 'skill') {
      console.log(JSON.stringify({
        continue: false,
        reason: 'team-worker-skill-blocked',
        message: `Worker ${worker} cannot invoke Skill tool in worker mode.`
      }));
      return;
    }
  }

  // Handle Bash tool separately - check for file modification patterns
  if (toolName === 'Bash' || toolName === 'bash') {
    const toolInput = data.tool_input || data.toolInput || {};
    const command = toolInput.command || '';
    if (worker) {
      const violation = workerCommandViolation(command);
      if (violation) {
        console.log(JSON.stringify({
          continue: false,
          reason: 'team-worker-bash-blocked',
          message: `${violation}\nCommand blocked: ${command}`
        }));
        return;
      }
    }
    const warning = checkBashCommand(command);
    if (warning) {
      console.log(JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: warning
        }
      }));
    } else {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    }
    return;
  }

  // Activate skill state when Skill tool is invoked (issue #1033)
  // Writes skill-active-state.json so the persistent-mode Stop hook can
  // prevent premature session termination while a skill is executing.
  if (toolName === 'Skill' || toolName === 'skill') {
    const directory = data.cwd || data.directory || process.cwd();
    const sessionId = data.sessionId || data.session_id || data.sessionid || '';
    const toolInput = data.tool_input || data.toolInput || {};
    const skillName = getInvokedSkillName(toolInput);
    if (skillName) {
      writeSkillActiveState(directory, skillName, sessionId);
    }
  }

  // Only check Edit and Write tools
  if (!['Edit', 'Write', 'edit', 'write'].includes(toolName)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Extract file path (handle nested structures)
  const toolInput = data.tool_input || data.toolInput || {};
  const filePath = toolInput.file_path || toolInput.filePath || '';

  // No file path? Allow
  if (!filePath) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Check if allowed path
  if (isAllowedPath(filePath)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Check if source file
  if (isSourceFile(filePath)) {
    const warning = `[DELEGATION NOTICE] Direct ${toolName} on source file: ${filePath}

Recommended: Delegate to executor agent instead:
  Task(subagent_type="oh-my-claudecode:executor", model="sonnet", prompt="...")

This is a soft warning. Operation will proceed.`;

    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: warning
      }
    }));
    return;
  }

  // Not a source file, allow without warning
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
});
