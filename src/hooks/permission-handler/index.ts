import * as fs from 'fs';
import * as path from 'path';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { getClaudeConfigDir } from '../../utils/paths.js';

export interface PermissionRequestInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: 'PermissionRequest';
  tool_name: string;
  tool_input: {
    command?: string;
    file_path?: string;
    content?: string;
    [key: string]: unknown;
  };
  tool_use_id: string;
}

export interface HookOutput {
  continue: boolean;
  hookSpecificOutput?: {
    hookEventName: string;
    decision?: {
      behavior: 'allow' | 'deny' | 'ask';
      reason?: string;
    };
  };
}

const SAFE_PATTERNS = [
  /^git (status|diff|log|branch|show|fetch)/,
  /^npm (test|run (test|lint|build|check|typecheck))/,
  /^pnpm (test|run (test|lint|build|check|typecheck))/,
  /^yarn (test|run (test|lint|build|check|typecheck))/,
  /^tsc( |$)/,
  /^eslint /,
  /^prettier /,
  /^cargo (test|check|clippy|build)/,
  /^pytest/,
  /^python -m pytest/,
  /^ls( |$)/,
  // REMOVED: cat, head, tail - they allow reading arbitrary files
];

// Shell metacharacters that enable command chaining and injection
// See GitHub Issue #146 for full list of dangerous characters
// Note: Quotes ("') intentionally excluded - they're needed for paths with spaces
// and command substitution is already caught by $ detection
const DANGEROUS_SHELL_CHARS = /[;&|`$()<>\n\r\t\0\\{}\[\]*?~!#]/;

// Heredoc operator detection (<<, <<-, <<~, with optional quoting of delimiter)
const HEREDOC_PATTERN = /<<[-~]?\s*['"]?\w+['"]?/;

/**
 * Patterns that are safe to auto-allow even when they contain heredoc content.
 * Matched against the first line of the command (before the heredoc body).
 * Issue #608: Prevents full heredoc body from being stored in settings.local.json.
 */
const SAFE_HEREDOC_PATTERNS = [
  /^git commit\b/,
  /^git tag\b/,
];

const BACKGROUND_MUTATION_SUBAGENTS = new Set([
  'executor',
  'designer',
  'writer',
  'debugger',
  'git-master',
  'test-engineer',
  'qa-tester',
  'document-specialist',
]);

function readPermissionAllowEntries(filePath: string): string[] {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const settings = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
      permissions?: { allow?: unknown };
    };
    const allow = settings?.permissions?.allow;
    return Array.isArray(allow) ? allow.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

export function getClaudePermissionAllowEntries(directory: string): string[] {
  const projectSettingsPath = path.join(directory, '.claude', 'settings.local.json');
  const globalConfigDir = getClaudeConfigDir();
  const candidatePaths = [
    projectSettingsPath,
    path.join(globalConfigDir, 'settings.local.json'),
    path.join(globalConfigDir, 'settings.json'),
  ];

  const allowEntries = new Set<string>();
  for (const candidatePath of candidatePaths) {
    for (const entry of readPermissionAllowEntries(candidatePath)) {
      allowEntries.add(entry.trim());
    }
  }

  return [...allowEntries];
}

function hasGenericToolPermission(allowEntries: string[], toolName: string): boolean {
  return allowEntries.some(entry => entry === toolName || entry.startsWith(`${toolName}(`));
}

export function hasClaudePermissionApproval(
  directory: string,
  toolName: 'Edit' | 'Write' | 'Bash',
  command?: string,
): boolean {
  const allowEntries = getClaudePermissionAllowEntries(directory);

  if (toolName !== 'Bash') {
    return hasGenericToolPermission(allowEntries, toolName);
  }

  if (allowEntries.includes('Bash')) {
    return true;
  }

  const trimmedCommand = command?.trim();
  if (!trimmedCommand) {
    return false;
  }

  return allowEntries.includes(`Bash(${trimmedCommand})`);
}

export interface BackgroundPermissionFallbackResult {
  shouldFallback: boolean;
  missingTools: string[];
}

export function getBackgroundTaskPermissionFallback(
  directory: string,
  subagentType?: string,
): BackgroundPermissionFallbackResult {
  const normalizedSubagentType = subagentType?.trim().toLowerCase();
  if (!normalizedSubagentType || !BACKGROUND_MUTATION_SUBAGENTS.has(normalizedSubagentType)) {
    return { shouldFallback: false, missingTools: [] };
  }

  const missingTools = ['Edit', 'Write'].filter(
    toolName => !hasClaudePermissionApproval(directory, toolName as 'Edit' | 'Write'),
  );

  return {
    shouldFallback: missingTools.length > 0,
    missingTools,
  };
}

export function getBackgroundBashPermissionFallback(
  directory: string,
  command?: string,
): BackgroundPermissionFallbackResult {
  if (!command || isSafeCommand(command) || isHeredocWithSafeBase(command)) {
    return { shouldFallback: false, missingTools: [] };
  }

  return hasClaudePermissionApproval(directory, 'Bash', command)
    ? { shouldFallback: false, missingTools: [] }
    : { shouldFallback: true, missingTools: ['Bash'] };
}

/**
 * Check if a command matches safe patterns
 */
export function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();

  // SECURITY: Reject ANY command with shell metacharacters
  // These allow command chaining that bypasses safe pattern checks
  if (DANGEROUS_SHELL_CHARS.test(trimmed)) {
    return false;
  }

  return SAFE_PATTERNS.some(pattern => pattern.test(trimmed));
}

/**
 * Check if a command is a heredoc command with a safe base command.
 * Issue #608: Heredoc commands contain shell metacharacters (<<, \n, $, etc.)
 * that cause isSafeCommand() to reject them. When they fall through to Claude
 * Code's native permission flow and the user approves "Always allow", the entire
 * heredoc body (potentially hundreds of lines) gets stored in settings.local.json.
 *
 * This function detects heredoc commands and checks whether the base command
 * (first line) matches known-safe patterns, allowing auto-approval without
 * polluting settings.local.json.
 */
export function isHeredocWithSafeBase(command: string): boolean {
  const trimmed = command.trim();

  // Heredoc commands from Claude Code are always multi-line
  if (!trimmed.includes('\n')) {
    return false;
  }

  // Must contain a heredoc operator
  if (!HEREDOC_PATTERN.test(trimmed)) {
    return false;
  }

  // Extract the first line as the base command
  const firstLine = trimmed.split('\n')[0].trim();

  // Check if the first line starts with a safe pattern
  return SAFE_HEREDOC_PATTERNS.some(pattern => pattern.test(firstLine));
}

/**
 * Check if an active mode (autopilot/ultrawork/ralph/team) is running
 */
export function isActiveModeRunning(directory: string): boolean {
  const stateDir = path.join(getOmcRoot(directory), 'state');

  if (!fs.existsSync(stateDir)) {
    return false;
  }

  const activeStateFiles = [
    'autopilot-state.json',
    'ralph-state.json',
    'ultrawork-state.json',
    'team-state.json',
    'omc-teams-state.json',
  ];

  for (const stateFile of activeStateFiles) {
    const statePath = path.join(stateDir, stateFile);
    if (fs.existsSync(statePath)) {
      // JSON state files: check active/status fields
      try {
        const content = fs.readFileSync(statePath, 'utf-8');
        const state = JSON.parse(content);

        // Check if mode is active
        if (state.active === true || state.status === 'running' || state.status === 'active') {
          return true;
        }
      } catch (_error) {
        // Ignore parse errors, continue checking
        continue;
      }
    }
  }

  return false;
}

/**
 * Process permission request and decide whether to auto-allow
 */
export function processPermissionRequest(input: PermissionRequestInput): HookOutput {
  // Only process Bash tool for command auto-approval
  // Normalize tool name - handle both proxy_ prefixed and unprefixed versions
  const toolName = input.tool_name.replace(/^proxy_/, '');
  if (toolName !== 'Bash') {
    return { continue: true };
  }

  const command = input.tool_input.command;
  if (!command || typeof command !== 'string') {
    return { continue: true };
  }

  // Auto-allow safe commands
  if (isSafeCommand(command)) {
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          reason: 'Safe read-only or test command',
        },
      },
    };
  }

  // Auto-allow heredoc commands with safe base commands (Issue #608)
  // This prevents the full heredoc body from being stored in settings.local.json
  if (isHeredocWithSafeBase(command)) {
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          reason: 'Safe command with heredoc content',
        },
      },
    };
  }

  // Default: let normal permission flow handle it
  return { continue: true };
}

/**
 * Main hook entry point
 */
export async function handlePermissionRequest(input: PermissionRequestInput): Promise<HookOutput> {
  return processPermissionRequest(input);
}
