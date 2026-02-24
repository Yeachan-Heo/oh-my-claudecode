#!/usr/bin/env node

/**
 * PostToolUse Hook: Verification Reminder System (Node.js)
 * Monitors tool execution and provides contextual guidance
 * Cross-platform: Windows, macOS, Linux
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { readStdin } from './lib/stdin.mjs';

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
const cfgDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
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
const CLAUDE_EXIT_CODE_PREFIX = /^Error: Exit code \d+\s*$/gm;

/**
 * Detect non-zero exit code with valid stdout (issue #960).
 * Returns true when output has Claude Code's "Error: Exit code N" prefix
 * AND substantial content that doesn't itself indicate real errors.
 * Example: `gh pr checks` exits 8 (pending) but outputs valid CI status.
 */
export function isNonZeroExitWithOutput(output) {
  if (!output) return false;
  const cleaned = stripClaudeTempCwdErrors(output);

  // Must contain Claude Code's exit code prefix
  if (!CLAUDE_EXIT_CODE_PREFIX.test(cleaned)) return false;
  // Reset regex state (global flag)
  CLAUDE_EXIT_CODE_PREFIX.lastIndex = 0;

  // Strip exit code prefix line(s) and check remaining content
  const remaining = cleaned.replace(CLAUDE_EXIT_CODE_PREFIX, '').trim();
  CLAUDE_EXIT_CODE_PREFIX.lastIndex = 0;

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

  return !contentErrorPatterns.some(p => p.test(remaining));
}

// Detect failures in Bash output
export function detectBashFailure(output) {
  const cleaned = stripClaudeTempCwdErrors(output);
  const errorPatterns = [
    /error:/i,
    /failed/i,
    /cannot/i,
    /permission denied/i,
    /command not found/i,
    /no such file/i,
    /exit code: [1-9]/i,
    /exit status [1-9]/i,
    /fatal:/i,
    /abort/i,
  ];

  return errorPatterns.some(pattern => pattern.test(cleaned));
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
  const cleaned = stripClaudeTempCwdErrors(output);
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
function getAgentCompletionSummary(directory) {
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
      if (running.length > 0) {
        parts.push(`Running: ${running.length} [${running.map(a => a.agent_type.replace('oh-my-claudecode:', '')).join(', ')}]`);
      }
      if (completed > 0) parts.push(`Completed: ${completed}`);
      if (failed > 0) parts.push(`Failed: ${failed}`);

      return parts.join(' | ');
    }
  } catch {}
  return '';
}

// Generate contextual message
function generateMessage(toolName, toolOutput, sessionId, toolCount, directory) {
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
      } else if (detectBackgroundOperation(toolOutput)) {
        message = 'Background operation detected. Remember to verify results before proceeding.';
      }
      break;

    case 'Task':
    case 'TaskCreate':
    case 'TaskUpdate': {
      const agentSummary = getAgentCompletionSummary(directory);
      if (detectWriteFailure(toolOutput)) {
        message = 'Task delegation failed. Verify agent name and parameters.';
      } else if (detectBackgroundOperation(toolOutput)) {
        message = 'Background task launched. Use TaskOutput to check results when needed.';
      } else if (toolCount > 5) {
        message = `Multiple tasks delegated (${toolCount} total). Track their completion status.`;
      }
      if (agentSummary) {
        message = message ? `${message} | ${agentSummary}` : agentSummary;
      }
      break;
    }

    case 'Edit':
      if (detectWriteFailure(toolOutput)) {
        message = 'Edit operation failed. Verify file exists and content matches exactly.';
      } else {
        message = 'Code modified. Verify changes work as expected before marking complete.';
      }
      break;

    case 'Write':
      if (detectWriteFailure(toolOutput)) {
        message = 'Write operation failed. Check file permissions and directory existence.';
      } else {
        message = 'File written. Test the changes to ensure they work correctly.';
      }
      break;

    case 'TodoWrite':
      if (/created|added/i.test(toolOutput)) {
        message = 'Todo list updated. Proceed with next task on the list.';
      } else if (/completed|done/i.test(toolOutput)) {
        message = 'Task marked complete. Continue with remaining todos.';
      } else if (/in_progress/i.test(toolOutput)) {
        message = 'Task marked in progress. Focus on completing this task.';
      }
      break;

    case 'Read':
      if (toolCount > 10) {
        message = `Extensive reading (${toolCount} files). Consider using Grep for pattern searches.`;
      }
      break;

    case 'Grep':
      if (/^0$|no matches/i.test(toolOutput)) {
        message = 'No matches found. Verify pattern syntax or try broader search.';
      }
      break;

    case 'Glob':
      if (!toolOutput.trim() || /no files/i.test(toolOutput)) {
        message = 'No files matched pattern. Verify glob syntax and directory.';
      }
      break;
  }

  return message;
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
      processRememberTags(toolOutput, directory);
    }

    // Generate contextual message
    const message = generateMessage(toolName, toolOutput, sessionId, toolCount, directory);

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
