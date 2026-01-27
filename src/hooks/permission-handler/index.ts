import * as fs from 'fs';
import * as path from 'path';

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
const DANGEROUS_SHELL_CHARS = /[;&|`$()<>\n\\]/;

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
 * Check if an active mode (autopilot/ultrawork/ralph/swarm) is running
 */
export function isActiveModeRunning(directory: string): boolean {
  const stateDir = path.join(directory, '.omc', 'state');

  if (!fs.existsSync(stateDir)) {
    return false;
  }

  const activeStateFiles = [
    'autopilot-state.json',
    'ultrapilot-state.json',
    'ralph-state.json',
    'ultrawork-state.json',
    'swarm-active.marker',
  ];

  for (const stateFile of activeStateFiles) {
    const statePath = path.join(stateDir, stateFile);
    if (fs.existsSync(statePath)) {
      // Marker files: existence alone indicates active mode
      if (stateFile.endsWith('.marker')) {
        return true;
      }

      // JSON state files: check active/status fields
      try {
        const content = fs.readFileSync(statePath, 'utf-8');
        const state = JSON.parse(content);

        // Check if mode is active
        if (state.active === true || state.status === 'running' || state.status === 'active') {
          return true;
        }
      } catch (error) {
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
  if (input.tool_name !== 'proxy_Bash') {
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

  // Default: let normal permission flow handle it
  return { continue: true };
}

/**
 * Main hook entry point
 */
export async function handlePermissionRequest(input: PermissionRequestInput): Promise<HookOutput> {
  return processPermissionRequest(input);
}
