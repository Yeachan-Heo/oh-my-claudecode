#!/usr/bin/env node

/**
 * PostToolUse Hook: Verification Reminder System (Node.js)
 * Monitors tool execution and provides contextual guidance
 * Cross-platform: Windows, macOS, Linux
 */

import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync, unlinkSync } from 'fs';
import { closeSync, openSync, readSync, statSync } from 'fs';
import { basename, join, dirname, resolve } from 'path';
import { homedir, tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { getClaudeConfigDir } from './lib/config-dir.mjs';
import { readStdin } from './lib/stdin.mjs';

const AGENT_OUTPUT_ANALYSIS_LIMIT = parseInt(process.env.OMC_AGENT_OUTPUT_ANALYSIS_LIMIT || '12000', 10);
const AGENT_OUTPUT_SUMMARY_LIMIT = parseInt(process.env.OMC_AGENT_OUTPUT_SUMMARY_LIMIT || '360', 10);
const PREEMPTIVE_WARNING_THRESHOLD_PERCENT = parseInt(process.env.OMC_PREEMPTIVE_COMPACTION_WARNING_PERCENT || '70', 10);
const PREEMPTIVE_CRITICAL_THRESHOLD_PERCENT = parseInt(process.env.OMC_PREEMPTIVE_COMPACTION_CRITICAL_PERCENT || '90', 10);
const PREEMPTIVE_COOLDOWN_MS = parseInt(process.env.OMC_PREEMPTIVE_COMPACTION_COOLDOWN_MS || '60000', 10);
const PREEMPTIVE_TRANSCRIPT_TAIL_BYTES = 4096;
const PREEMPTIVE_LARGE_OUTPUT_TOOLS = new Set(['read', 'grep', 'glob', 'bash', 'webfetch', 'task', 'taskcreate', 'taskupdate', 'taskoutput']);
const QUIET_LEVEL = getQuietLevel();
const SESSION_ID_ALLOWLIST = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;

function getQuietLevel() {
  const parsed = Number.parseInt(process.env.OMC_QUIET || '0', 10);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, parsed);
}

function clampPercent(percent, fallback) {
  if (!Number.isFinite(percent)) return fallback;
  return Math.min(100, Math.max(1, percent));
}

function getPreemptiveWarningThreshold() {
  return clampPercent(PREEMPTIVE_WARNING_THRESHOLD_PERCENT, 70);
}

function getPreemptiveCriticalThreshold() {
  return clampPercent(PREEMPTIVE_CRITICAL_THRESHOLD_PERCENT, 90);
}

// Get the directory of this script to resolve the dist module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distDir = join(__dirname, '..', 'dist', 'hooks', 'notepad');

// Try to import notepad functions (may fail if not built)
let setPriorityContext = null;
let addWorkingMemoryEntry = null;
try {
  const notepadModule = await import(pathToFileURL(join(distDir, 'index.js')).href);
  setPriorityContext = notepadModule.setPriorityContext;
  addWorkingMemoryEntry = notepadModule.addWorkingMemoryEntry;
} catch {
  // Notepad module not available - remember tags will be silently ignored
}

// Debug logging helper - gated behind OMC_DEBUG env var
const debugLog = (...args) => {
  if (process.env.OMC_DEBUG) console.error('[omc:debug:post-tool-verifier]', ...args);
};

// State file for session tracking
const cfgDir = getClaudeConfigDir();
const STATE_FILE = join(cfgDir, '.session-stats.json');

// Ensure state directory exists
try {
  const stateDir = cfgDir;
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
} catch {}

// Load session statistics
function loadStats() {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch (e) {
    debugLog('Failed to load stats:', e.message);
  }
  return { sessions: {} };
}

// Save session statistics
function saveStats(stats) {
  const tmpFile = `${STATE_FILE}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(tmpFile, JSON.stringify(stats, null, 2));
    renameSync(tmpFile, STATE_FILE);
  } catch (e) {
    debugLog('Failed to save stats:', e.message);
    try { unlinkSync(tmpFile); } catch {}
  }
}

// Update stats for this session
function updateStats(toolName, sessionId) {
  const stats = loadStats();

  if (!stats.sessions[sessionId]) {
    stats.sessions[sessionId] = {
      tool_counts: {},
      last_tool: '',
      total_calls: 0,
      started_at: Math.floor(Date.now() / 1000)
    };
  }

  const session = stats.sessions[sessionId];
  session.tool_counts[toolName] = (session.tool_counts[toolName] || 0) + 1;
  session.last_tool = toolName;
  session.total_calls = (session.total_calls || 0) + 1;
  session.updated_at = Math.floor(Date.now() / 1000);

  saveStats(stats);
  return session.tool_counts[toolName];
}

// Read bash history config (default: enabled)
function getBashHistoryConfig() {
  try {
    const configPath = join(cfgDir, '.omc-config.json');
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (config.bashHistory === false) return false;
      if (typeof config.bashHistory === 'object' && config.bashHistory.enabled === false) return false;
    }
  } catch {}
  return true; // Default: enabled
}

// Append command to ~/.bash_history (Unix only - no bash_history on Windows)
function appendToBashHistory(command) {
  if (process.platform === 'win32') return;
  if (!command || typeof command !== 'string') return;

  // Clean command: trim, skip empty, skip if it's just whitespace
  const cleaned = command.trim();
  if (!cleaned) return;

  // Skip internal/meta commands that aren't useful in history
  if (cleaned.startsWith('#')) return;

  try {
    const historyPath = join(homedir(), '.bash_history');
    appendFileSync(historyPath, cleaned + '\n');
  } catch {
    // Silently fail - history is best-effort
  }
}

// Pattern to match Claude Code temp CWD permission errors (false positives on macOS)
// e.g. "zsh:1: permission denied: /var/folders/.../T/claude-abc123-cwd"
const CLAUDE_TEMP_CWD_PATTERN = /zsh:\d+: permission denied:.*\/T\/claude-[a-z0-9]+-cwd/gi;

// Strip Claude Code temp CWD noise before pattern matching
function stripClaudeTempCwdErrors(output) {
  return output.replace(CLAUDE_TEMP_CWD_PATTERN, '');
}

// Pattern matching Claude Code's "Error: Exit code N" prefix line
// Note: no /g flag — module-level regex with /g is stateful (.lastIndex persists across calls)
const CLAUDE_EXIT_CODE_PREFIX = /^Error: Exit code \d+\s*$/m;
const QUOTED_SPAN_PATTERN =
  /"[^"\n]{1,400}"|'[^'\n]{1,400}'|“[^”\n]{1,400}”|‘[^’\n]{1,400}’/g;
const NON_ACTIONABLE_ERROR_LINES = [
  /^\s*["']?severity["']?\s*[:=]\s*["']error["']?\s*[,}]?\s*$/i,
  /^\s*["']?totalErrors["']?\s*[:=]\s*0\b.*$/i,
  /^\s*totalErrors\s*[:=]\s*0\b.*$/i,
  /^\s*["']?error["']?\s*:\s*["'][^"']*["']\s*[,}]?\s*$/i,
  /^\s*return\s*\{[^\n]*\berror\s*:\s*["'][^"']*["'][^\n]*\}\s*;?$/i,
];

function stripQuotedSpans(output) {
  return output.replace(QUOTED_SPAN_PATTERN, ' ');
}

function isPytestRunOutput(output) {
  if (!output) return false;

  const cleaned = stripClaudeTempCwdErrors(output);
  const hasPytestHeader =
    /(^|\n)=+\s*test session starts\s*=+/i.test(cleaned) ||
    /(^|\n).*pytest-\d/i.test(cleaned) ||
    /(^|\n)collected\s+\d+\s+items?\b/i.test(cleaned);
  const hasPytestBody =
    /(^|\n)=+\s*short test summary info\s*=+/i.test(cleaned) ||
    /(^|\n)=+\s*failures\s*=+/i.test(cleaned) ||
    /(^|\n)(?:FAILED|ERROR)\s+.+::.+/m.test(cleaned) ||
    /(^|\n)\S+\.py::\S+\s+(?:PASSED|FAILED|ERROR)\b/m.test(cleaned);

  return hasPytestHeader && hasPytestBody;
}

function stripNonActionableErrorContext(output) {
  if (!output) return '';
  return output
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      return !NON_ACTIONABLE_ERROR_LINES.some((pattern) => pattern.test(trimmed));
    })
    .join('\n');
}

/**
 * Detect non-zero exit code with valid stdout (issue #960).
 * Returns true when output has Claude Code's "Error: Exit code N" prefix
 * AND substantial content that doesn't itself indicate real errors.
 * Example: `gh pr checks` exits 8 (pending) but outputs valid CI status.
 */
export function isNonZeroExitWithOutput(output) {
  if (!output) return false;
  const cleaned = stripNonActionableErrorContext(stripClaudeTempCwdErrors(output));

  // Must contain Claude Code's exit code prefix
  if (!CLAUDE_EXIT_CODE_PREFIX.test(cleaned)) return false;

  // Strip exit code prefix line(s) and check remaining content
  const remaining = cleaned.replace(CLAUDE_EXIT_CODE_PREFIX, '').trim();

  // Must have at least one non-empty line of real output
  const contentLines = remaining.split('\n').filter(l => l.trim().length > 0);
  if (contentLines.length === 0) return false;

  // If remaining content has its own error indicators, it's a real failure
  const contentErrorPatterns = [
    /error:/i,
    /failed/i,
    /cannot/i,
    /permission denied/i,
    /command not found/i,
    /no such file/i,
    /fatal:/i,
    /abort/i,
  ];

  return !contentErrorPatterns.some(p => p.test(stripQuotedSpans(remaining)));
}

// Detect failures in Bash output
export function detectBashFailure(output) {
  if (!output) return false;

  const cleaned = stripClaudeTempCwdErrors(output);

  if (isPytestRunOutput(cleaned)) {
    return false;
  }

  const explicitExitPatterns = [
    /(^|\n)Error: Exit code [1-9]\d*(\n|$)/i,
    /(^|\n).*\bexit code:\s*[1-9]\d*\b/i,
    /(^|\n).*\bexit status\s+[1-9]\d*\b/i,
  ];

  if (explicitExitPatterns.some(pattern => pattern.test(cleaned))) {
    return true;
  }

  const linePatterns = [
    /^error:\s+/i,
    /^(?:bash|zsh|sh): .*command not found/i,
    /^(?:bash|zsh|sh): .*no such file/i,
    /^(?:bash|zsh|sh): .*permission denied/i,
    /^(?:rm|cp|mv|cat|chmod|chown|git|node|npm|pnpm|yarn|python|python3|pip|pip3|cargo|go|rustc|docker|ffmpeg): .*permission denied/i,
    /^(?:rm|cp|mv|cat|git|node|npm|pnpm|yarn|python|python3|pip|pip3|cargo|go|rustc|docker|ffmpeg): .*no such file/i,
    /^fatal:\s+/i,
    /^abort(?:ed)?\b/i,
    /^(?:build|command|task|operation) failed\b/i,
  ];

  return cleaned
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .some(line => linePatterns.some(pattern => pattern.test(line)));
}

// Detect background operation
function detectBackgroundOperation(output) {
  const bgPatterns = [
    /started/i,
    /running/i,
    /background/i,
    /async/i,
    /task_id/i,
    /spawned/i,
  ];

  return bgPatterns.some(pattern => pattern.test(output));
}

function resolveTranscriptPath(transcriptPath, cwd) {
  if (!transcriptPath) return undefined;

  try {
    if (existsSync(transcriptPath)) return transcriptPath;
  } catch {}

  const worktreePattern = /--claude-worktrees-[^/\\]+/;
  if (worktreePattern.test(transcriptPath)) {
    const resolvedPath = transcriptPath.replace(worktreePattern, '');
    try {
      if (existsSync(resolvedPath)) return resolvedPath;
    } catch {}
  }

  const effectiveCwd = cwd || process.cwd();
  try {
    const gitCommonDir = execSync('git rev-parse --git-common-dir', {
      cwd: effectiveCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const mainRepoRoot = dirname(resolve(effectiveCwd, gitCommonDir));
    const worktreeTop = execSync('git rev-parse --show-toplevel', {
      cwd: effectiveCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (mainRepoRoot !== worktreeTop) {
      const sessionFile = basename(transcriptPath);
      if (sessionFile) {
        const projectsDir = join(getClaudeConfigDir(), 'projects');
        if (existsSync(projectsDir)) {
          const encodedMain = mainRepoRoot.replace(/[/\\]/g, '-');
          const resolvedPath = join(projectsDir, encodedMain, sessionFile);
          if (existsSync(resolvedPath)) return resolvedPath;
        }
      }
    }
  } catch {}

  return transcriptPath;
}

function readTranscriptUsage(transcriptPath) {
  if (!transcriptPath) return null;

  let fd = -1;
  try {
    const stat = statSync(transcriptPath);
    if (stat.size === 0) return null;

    fd = openSync(transcriptPath, 'r');
    const readSize = Math.min(PREEMPTIVE_TRANSCRIPT_TAIL_BYTES, stat.size);
    const buffer = Buffer.alloc(readSize);
    readSync(fd, buffer, 0, readSize, stat.size - readSize);
    closeSync(fd);
    fd = -1;

    const tail = buffer.toString('utf-8');
    const windowMatches = tail.match(/"context_window"\s{0,5}:\s{0,5}(\d+)/g);
    const inputMatches = tail.match(/"input_tokens"\s{0,5}:\s{0,5}(\d+)/g);
    if (!windowMatches || !inputMatches) return null;

    const lastWindow = Number.parseInt(
      windowMatches[windowMatches.length - 1].match(/(\d+)/)?.[1] || '0',
      10,
    );
    const lastInput = Number.parseInt(
      inputMatches[inputMatches.length - 1].match(/(\d+)/)?.[1] || '0',
      10,
    );
    if (!Number.isFinite(lastWindow) || lastWindow <= 0) return null;
    if (!Number.isFinite(lastInput) || lastInput < 0) return null;

    return Math.round((lastInput / lastWindow) * 100);
  } catch {
    return null;
  } finally {
    if (fd !== -1) {
      try { closeSync(fd); } catch {}
    }
  }
}

function readContextUsageFromHookInput(data) {
  const contextWindow = data?.context_window;
  if (!contextWindow || typeof contextWindow !== 'object') {
    return null;
  }

  const usedPercentage = contextWindow.used_percentage;
  if (Number.isFinite(usedPercentage) && usedPercentage >= 0) {
    return Math.min(100, Math.max(0, Math.round(usedPercentage)));
  }

  const size = contextWindow.context_window_size;
  if (!Number.isFinite(size) || size <= 0) {
    return null;
  }

  const usage = contextWindow.current_usage;
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const inputTokens = Number(usage.input_tokens || 0);
  const cacheCreationTokens = Number(usage.cache_creation_input_tokens || 0);
  const cacheReadTokens = Number(usage.cache_read_input_tokens || 0);

  const totalTokens = inputTokens + cacheCreationTokens + cacheReadTokens;
  if (!Number.isFinite(totalTokens) || totalTokens < 0) {
    return null;
  }

  return Math.min(100, Math.max(0, Math.round((totalTokens / size) * 100)));
}

function getPreemptiveCooldownFilePath(directory, sessionId) {
  const cooldownScope =
    sessionId && sessionId !== 'unknown'
      ? `${directory || process.cwd()}::${sessionId}`
      : directory || process.cwd();
  const hash = createHash('sha1').update(cooldownScope).digest('hex');
  const cooldownDir = join(tmpdir(), 'omc-preemptive-compaction');
  mkdirSync(cooldownDir, { recursive: true });
  return join(cooldownDir, `${hash}.json`);
}

function readPreemptiveCooldownState(directory, sessionId) {
  try {
    const filePath = getPreemptiveCooldownFilePath(directory, sessionId);
    if (!existsSync(filePath)) return null;
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (!data || typeof data !== 'object') return null;
    return {
      lastWarningTime:
        typeof data.lastWarningTime === 'number' ? data.lastWarningTime : 0,
      severity: data.severity === 'critical' ? 'critical' : 'warning',
    };
  } catch {
    return null;
  }
}

function writePreemptiveCooldownState(directory, sessionId, severity, now) {
  writeFileSync(
    getPreemptiveCooldownFilePath(directory, sessionId),
    JSON.stringify({ lastWarningTime: now, severity }),
    { mode: 0o600 },
  );
}

function shouldSuppressPreemptiveWarning(directory, sessionId, severity, now) {
  const cooldownState = readPreemptiveCooldownState(directory, sessionId);
  if (!cooldownState) return false;
  if (now - cooldownState.lastWarningTime >= PREEMPTIVE_COOLDOWN_MS) return false;
  return !(cooldownState.severity === 'warning' && severity === 'critical');
}

function buildPreemptiveContextMessage(percentUsed, severity) {
  if (severity === 'critical') {
    return `[OMC CRITICAL] Context at ${percentUsed}% (critical threshold: ${getPreemptiveCriticalThreshold()}%). Run /compact now before continuing with more tools or agent fan-out.`;
  }

  return `[OMC WARNING] Context at ${percentUsed}% (warning threshold: ${getPreemptiveWarningThreshold()}%). Plan a /compact soon to preserve room for the next large tool output.`;
}

function maybeBuildPreemptiveCompactionMessage(toolName, data, directory) {
  if (!PREEMPTIVE_LARGE_OUTPUT_TOOLS.has(String(toolName || '').toLowerCase())) {
    return '';
  }

  const percentFromTranscript = readTranscriptUsage(
    resolveTranscriptPath(data.transcript_path || data.transcriptPath, directory),
  );
  const percentUsed =
    percentFromTranscript ?? readContextUsageFromHookInput(data);
  const warningThreshold = getPreemptiveWarningThreshold();
  const criticalThreshold = getPreemptiveCriticalThreshold();

  if (percentUsed === null || percentUsed < warningThreshold) {
    return '';
  }

  const severity = percentUsed >= criticalThreshold ? 'critical' : 'warning';
  const now = Date.now();
  const sessionId = data.session_id || data.sessionId || 'unknown';

  if (shouldSuppressPreemptiveWarning(directory, sessionId, severity, now)) {
    return '';
  }

  writePreemptiveCooldownState(directory, sessionId, severity, now);
  return buildPreemptiveContextMessage(percentUsed, severity);
}

function getInvokedSkillName(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const rawSkill =
    toolInput.skill ||
    toolInput.skill_name ||
    toolInput.skillName ||
    toolInput.command ||
    null;
  if (typeof rawSkill !== 'string' || !rawSkill.trim()) return null;
  const normalized = rawSkill.trim();
  return normalized.includes(':')
    ? normalized.split(':').at(-1).toLowerCase()
    : normalized.toLowerCase();
}

function getSkillInvocationArgs(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const candidates = [
    toolInput.args,
    toolInput.arguments,
    toolInput.argument,
    toolInput.skill_args,
    toolInput.skillArgs,
    toolInput.prompt,
    toolInput.description,
    toolInput.input,
  ];
  return candidates.find(value => typeof value === 'string' && value.trim().length > 0)?.trim() || '';
}

function isConsensusPlanningSkillInvocation(skillName, toolInput) {
  if (!skillName) return false;
  if (skillName === 'ralplan') return true;
  if (skillName !== 'plan' && skillName !== 'omc-plan') return false;
  return getSkillInvocationArgs(toolInput).toLowerCase().includes('--consensus');
}

function getSkillActiveStatePaths(directory, sessionId) {
  const stateDir = join(directory, '.omc', 'state');
  const safeSessionId = sessionId && SESSION_ID_ALLOWLIST.test(sessionId) ? sessionId : '';
  return [
    safeSessionId ? join(stateDir, 'sessions', safeSessionId, 'skill-active-state.json') : null,
    join(stateDir, 'skill-active-state.json'),
  ].filter(Boolean);
}

function readSkillActiveState(directory, sessionId) {
  for (const statePath of getSkillActiveStatePaths(directory, sessionId)) {
    try {
      if (!existsSync(statePath)) continue;
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      if (state && typeof state === 'object') return state;
    } catch {
      // Ignore malformed or unreadable state; cleanup remains best-effort
    }
  }
  return null;
}

function clearSkillActiveState(directory, sessionId) {
  for (const statePath of getSkillActiveStatePaths(directory, sessionId)) {
    try {
      unlinkSync(statePath);
    } catch {
      // Best-effort cleanup; never fail the hook
    }
  }
}

function getRalplanStatePaths(directory, sessionId) {
  const stateDir = join(directory, '.omc', 'state');
  const safeSessionId = sessionId && SESSION_ID_ALLOWLIST.test(sessionId) ? sessionId : '';
  return [
    safeSessionId ? join(stateDir, 'sessions', safeSessionId, 'ralplan-state.json') : null,
    join(stateDir, 'ralplan-state.json'),
  ].filter(Boolean);
}

function deactivateRalplanState(directory, sessionId) {
  const safeSessionId = sessionId && SESSION_ID_ALLOWLIST.test(sessionId) ? sessionId : '';
  const terminalPhases = new Set(['complete', 'completed', 'failed', 'cancelled', 'done']);
  const now = new Date().toISOString();

  for (const statePath of getRalplanStatePaths(directory, sessionId)) {
    try {
      if (!existsSync(statePath)) continue;
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      if (!state || typeof state !== 'object') continue;
      if (safeSessionId && typeof state.session_id === 'string' && state.session_id !== safeSessionId) {
        continue;
      }
      const currentPhase = typeof state.current_phase === 'string' ? state.current_phase : '';
      const nextPhase = terminalPhases.has(currentPhase.toLowerCase()) ? currentPhase : 'complete';
      writeFileSync(
        statePath,
        JSON.stringify(
          {
            ...state,
            active: false,
            current_phase: nextPhase,
            completed_at: typeof state.completed_at === 'string' ? state.completed_at : now,
            deactivated_reason:
              typeof state.deactivated_reason === 'string'
                ? state.deactivated_reason
                : 'skill_completed',
          },
          null,
          2,
        ),
      );
    } catch {
      // Best-effort cleanup; never fail the hook
    }
  }
}

export function summarizeAgentResult(output, maxChars = AGENT_OUTPUT_SUMMARY_LIMIT) {
  if (!output || typeof output !== 'string') return '';

  const normalized = output
    .replace(/\r/g, '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, 6)
    .join(' | ');

  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 20)).trimEnd()} … [truncated]`;
}

function clipToolOutputForAnalysis(toolName, output) {
  if (typeof output !== 'string') return { clipped: '', wasTruncated: false };

  const isAgentResultTool = toolName === 'Task' || toolName === 'TaskCreate' || toolName === 'TaskUpdate' || toolName === 'TaskOutput';
  if (!isAgentResultTool || output.length <= AGENT_OUTPUT_ANALYSIS_LIMIT) {
    return { clipped: output, wasTruncated: false };
  }

  return {
    clipped: `${output.slice(0, AGENT_OUTPUT_ANALYSIS_LIMIT)}\n...[agent output truncated by OMC context guard]`,
    wasTruncated: true,
  };
}

/**
 * Process <remember> tags from agent output
 * <remember>content</remember> -> Working Memory
 * <remember priority>content</remember> -> Priority Context
 */
function processRememberTags(output, directory) {
  if (!setPriorityContext || !addWorkingMemoryEntry) {
    return; // Notepad module not available
  }

  if (!output || !directory) {
    return;
  }

  // Process priority remember tags first
  const priorityRegex = /<remember\s+priority>([\s\S]*?)<\/remember>/gi;
  let match;
  while ((match = priorityRegex.exec(output)) !== null) {
    const content = match[1].trim();
    if (content) {
      try {
        setPriorityContext(directory, content);
      } catch {}
    }
  }

  // Process regular remember tags
  const regularRegex = /<remember>([\s\S]*?)<\/remember>/gi;
  while ((match = regularRegex.exec(output)) !== null) {
    const content = match[1].trim();
    if (content) {
      try {
        addWorkingMemoryEntry(directory, content);
      } catch {}
    }
  }
}

// Detect write failure
// Patterns are tightened to tool-level failure phrases to avoid false positives
// when edited file content contains error-handling code (issue #1005)
export function detectWriteFailure(output) {
  const cleaned = stripQuotedSpans(stripClaudeTempCwdErrors(output));
  const errorPatterns = [
    /\berror:/i,              // "error:" with word boundary — avoids "setError", "console.error"
    /\bfailed to\b/i,        // "failed to write" — avoids "failedOidc", UI strings
    /\bwrite failed\b/i,     // explicit write failure
    /\boperation failed\b/i, // explicit operation failure
    /permission denied/i,    // keep as-is (specific enough)
    /read-only/i,            // keep as-is
    /\bno such file\b/i,     // more specific than "not found"
    /\bdirectory not found\b/i,
  ];

  return errorPatterns.some(pattern => pattern.test(cleaned));
}

// Get agent completion summary from tracking state
function getAgentCompletionSummary(directory, quietLevel = QUIET_LEVEL) {
  const trackingFile = join(directory, '.omc', 'state', 'subagent-tracking.json');
  try {
    if (existsSync(trackingFile)) {
      const data = JSON.parse(readFileSync(trackingFile, 'utf-8'));
      const agents = data.agents || [];
      const running = agents.filter(a => a.status === 'running');
      const completed = data.total_completed || 0;
      const failed = data.total_failed || 0;

      if (running.length === 0 && completed === 0 && failed === 0) return '';

      const parts = [];
      if (quietLevel < 2 && running.length > 0) {
        parts.push(`Running: ${running.length} [${running.map(a => a.agent_type.replace('oh-my-claudecode:', '')).join(', ')}]`);
      }
      if (quietLevel < 2 && completed > 0) parts.push(`Completed: ${completed}`);
      if (failed > 0) parts.push(`Failed: ${failed}`);

      return parts.join(' | ');
    }
  } catch {}
  return '';
}

// Generate contextual message
function generateMessage(toolName, toolOutput, sessionId, toolCount, directory, options = {}) {
  const { wasTruncated = false, rawLength = 0 } = options;
  let message = '';

  switch (toolName) {
    case 'Bash':
      if (isNonZeroExitWithOutput(toolOutput)) {
        // Non-zero exit with valid output — warning, not error (issue #960)
        const exitMatch = toolOutput.match(/Exit code (\d+)/);
        const code = exitMatch ? exitMatch[1] : 'non-zero';
        message = `Command exited with code ${code} but produced valid output. This may be expected behavior.`;
      } else if (detectBashFailure(toolOutput)) {
        message = 'Command failed. Please investigate the error and fix before continuing.';
      } else if (QUIET_LEVEL < 2 && detectBackgroundOperation(toolOutput)) {
        message = 'Background operation detected. Remember to verify results before proceeding.';
      }
      break;

    case 'Task':
    case 'TaskCreate':
    case 'TaskUpdate': {
      const agentSummary = getAgentCompletionSummary(directory, QUIET_LEVEL);
      if (detectWriteFailure(toolOutput)) {
        message = 'Task delegation failed. Verify agent name and parameters.';
      } else if (QUIET_LEVEL < 2 && detectBackgroundOperation(toolOutput)) {
        message = 'Background task launched. Use TaskOutput to check results when needed.';
      } else if (QUIET_LEVEL < 2 && toolCount > 5) {
        message = `Multiple tasks delegated (${toolCount} total). Track their completion status.`;
      }
      if (wasTruncated) {
        const truncationNote = `Agent result stream clipped for context safety (${rawLength} chars). Synthesize only key outcomes in main session.`;
        message = message ? `${message} | ${truncationNote}` : truncationNote;
      }
      if (agentSummary) {
        message = message ? `${message} | ${agentSummary}` : agentSummary;
      }
      break;
    }

    case 'TaskOutput': {
      const summary = summarizeAgentResult(toolOutput);
      if (QUIET_LEVEL < 2 && summary) {
        message = `TaskOutput summary: ${summary}`;
      }
      if (wasTruncated) {
        const truncationNote = `TaskOutput clipped (${rawLength} chars). Continue with concise synthesis and defer full logs to files.`;
        message = message ? `${message} | ${truncationNote}` : truncationNote;
      }
      break;
    }

    case 'Edit':
      if (detectWriteFailure(toolOutput)) {
        message = 'Edit operation failed. Verify file exists and content matches exactly.';
      } else if (QUIET_LEVEL === 0) {
        message = 'Code modified. Verify changes work as expected before marking complete.';
      }
      break;

    case 'Write':
      if (detectWriteFailure(toolOutput)) {
        message = 'Write operation failed. Check file permissions and directory existence.';
      } else if (QUIET_LEVEL === 0) {
        message = 'File written. Test the changes to ensure they work correctly.';
      }
      break;

    case 'TodoWrite':
      if (QUIET_LEVEL === 0 && /created|added/i.test(toolOutput)) {
        message = 'Todo list updated. Proceed with next task on the list.';
      } else if (QUIET_LEVEL === 0 && /completed|done/i.test(toolOutput)) {
        message = 'Task marked complete. Continue with remaining todos.';
      } else if (QUIET_LEVEL === 0 && /in_progress/i.test(toolOutput)) {
        message = 'Task marked in progress. Focus on completing this task.';
      }
      break;

    case 'Read':
      if (QUIET_LEVEL === 0 && toolCount > 10) {
        message = `Extensive reading (${toolCount} files). Consider using Grep for pattern searches.`;
      }
      break;

    case 'Grep':
      if (QUIET_LEVEL === 0 && /^0$|no matches/i.test(toolOutput)) {
        message = 'No matches found. Verify pattern syntax or try broader search.';
      }
      break;

    case 'Glob':
      if (QUIET_LEVEL === 0 && (!toolOutput.trim() || /no files/i.test(toolOutput))) {
        message = 'No files matched pattern. Verify glob syntax and directory.';
      }
      break;
  }

  return message;
}

function combineMessages(...messages) {
  return messages.filter(Boolean).join(' | ');
}

async function main() {
  // Skip guard: check OMC_SKIP_HOOKS env var (see issue #838)
  const _skipHooks = (process.env.OMC_SKIP_HOOKS || '').split(',').map(s => s.trim());
  if (process.env.DISABLE_OMC === '1' || _skipHooks.includes('post-tool-use')) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  try {
    const input = await readStdin();
    const data = JSON.parse(input);

    const toolName = data.tool_name || data.toolName || '';
    const rawResponse = data.tool_response || data.toolOutput || '';
    const toolOutput = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);
    const { clipped: clippedToolOutput, wasTruncated } = clipToolOutputForAnalysis(toolName, toolOutput);
    const sessionId = data.session_id || data.sessionId || 'unknown';
    const directory = data.cwd || data.directory || process.cwd();

    // Update session statistics
    const toolCount = updateStats(toolName, sessionId);

    // Append Bash commands to ~/.bash_history for terminal recall
    if ((toolName === 'Bash' || toolName === 'bash') && getBashHistoryConfig()) {
      const toolInput = data.tool_input || data.toolInput || {};
      const command = typeof toolInput === 'string' ? toolInput : (toolInput.command || '');
      appendToBashHistory(command);
    }

    // Process <remember> tags from Task agent output
    if (
      toolName === 'Task' ||
      toolName === 'task' ||
      toolName === 'TaskCreate' ||
      toolName === 'TaskUpdate'
    ) {
      processRememberTags(clippedToolOutput, directory);
    }

    if (toolName === 'Skill' || toolName === 'skill') {
      const toolInput = data.tool_input || data.toolInput || {};
      const skillName = getInvokedSkillName(toolInput);
      const currentState = readSkillActiveState(directory, sessionId);
      const completingSkill = (skillName ?? '')
        .toLowerCase()
        .replace(/^oh-my-claudecode:/, '');
      if (!currentState || !currentState.active || currentState.skill_name === completingSkill) {
        clearSkillActiveState(directory, sessionId);
      }
      if (isConsensusPlanningSkillInvocation(skillName, toolInput)) {
        deactivateRalplanState(directory, sessionId);
      }
    }

    // Generate contextual message
    const message = combineMessages(
      generateMessage(toolName, clippedToolOutput, sessionId, toolCount, directory, {
        wasTruncated,
        rawLength: toolOutput.length,
      }),
      maybeBuildPreemptiveCompactionMessage(toolName, data, directory),
    );

    // Build response - use hookSpecificOutput.additionalContext for PostToolUse
    const response = { continue: true };
    if (message) {
      response.hookSpecificOutput = {
        hookEventName: 'PostToolUse',
        additionalContext: message
      };
    } else {
      response.suppressOutput = true;
    }

    console.log(JSON.stringify(response, null, 2));
  } catch (error) {
    // On error, always continue
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

// Only run when executed directly (not when imported for testing)
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
