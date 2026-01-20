/**
 * Sisyphus Orchestrator Hook
 *
 * Enforces orchestrator behavior - delegation over direct implementation.
 * When an orchestrator agent tries to directly modify files outside .sisyphus/,
 * this hook injects reminders to delegate to subagents instead.
 *
 * Adapted from oh-my-opencode's sisyphus-orchestrator hook for shell-based hooks.
 */

import { execSync } from 'child_process';
import {
  HOOK_NAME,
  ALLOWED_PATH_PREFIX,
  WRITE_EDIT_TOOLS,
  DIRECT_WORK_REMINDER,
  ORCHESTRATOR_DELEGATION_REQUIRED,
  BOULDER_CONTINUATION_PROMPT,
  VERIFICATION_REMINDER,
  SINGLE_TASK_DIRECTIVE,
} from './constants.js';
import {
  readBoulderState,
  getPlanProgress,
} from '../../features/boulder-state/index.js';
import {
  addWorkingMemoryEntry,
  setPriorityContext,
} from '../notepad/index.js';

// Re-export constants
export * from './constants.js';

/**
 * Input for tool execution hooks
 */
export interface ToolExecuteInput {
  toolName: string;
  toolInput?: Record<string, unknown>;
  sessionId?: string;
  directory?: string;
}

/**
 * Output for tool execution hooks
 */
export interface ToolExecuteOutput {
  continue: boolean;
  message?: string;
  modifiedOutput?: string;
}

/**
 * Git file change statistics
 */
interface GitFileStat {
  path: string;
  added: number;
  removed: number;
  status: 'modified' | 'added' | 'deleted';
}

/**
 * Check if a file path is allowed for direct orchestrator modification
 */
export function isAllowedPath(filePath: string): boolean {
  if (!filePath) return true;
  return filePath.includes(ALLOWED_PATH_PREFIX);
}

/**
 * Check if a tool is a write/edit tool
 */
export function isWriteEditTool(toolName: string): boolean {
  return WRITE_EDIT_TOOLS.includes(toolName);
}

/**
 * Get git diff statistics for the working directory
 */
export function getGitDiffStats(directory: string): GitFileStat[] {
  try {
    const output = execSync('git diff --numstat HEAD', {
      cwd: directory,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    if (!output) return [];

    const statusOutput = execSync('git status --porcelain', {
      cwd: directory,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    const statusMap = new Map<string, 'modified' | 'added' | 'deleted'>();
    for (const line of statusOutput.split('\n')) {
      if (!line) continue;
      const status = line.substring(0, 2).trim();
      const filePath = line.substring(3);
      if (status === 'A' || status === '??') {
        statusMap.set(filePath, 'added');
      } else if (status === 'D') {
        statusMap.set(filePath, 'deleted');
      } else {
        statusMap.set(filePath, 'modified');
      }
    }

    const stats: GitFileStat[] = [];
    for (const line of output.split('\n')) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;

      const [addedStr, removedStr, path] = parts;
      const added = addedStr === '-' ? 0 : parseInt(addedStr, 10);
      const removed = removedStr === '-' ? 0 : parseInt(removedStr, 10);

      stats.push({
        path,
        added,
        removed,
        status: statusMap.get(path) ?? 'modified',
      });
    }

    return stats;
  } catch {
    return [];
  }
}

/**
 * Format file changes for display
 */
export function formatFileChanges(stats: GitFileStat[]): string {
  if (stats.length === 0) return '[FILE CHANGES SUMMARY]\nNo file changes detected.\n';

  const modified = stats.filter((s) => s.status === 'modified');
  const added = stats.filter((s) => s.status === 'added');
  const deleted = stats.filter((s) => s.status === 'deleted');

  const lines: string[] = ['[FILE CHANGES SUMMARY]'];

  if (modified.length > 0) {
    lines.push('Modified files:');
    for (const f of modified) {
      lines.push(`  ${f.path}  (+${f.added}, -${f.removed})`);
    }
    lines.push('');
  }

  if (added.length > 0) {
    lines.push('Created files:');
    for (const f of added) {
      lines.push(`  ${f.path}  (+${f.added})`);
    }
    lines.push('');
  }

  if (deleted.length > 0) {
    lines.push('Deleted files:');
    for (const f of deleted) {
      lines.push(`  ${f.path}  (-${f.removed})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build verification reminder with session context
 */
export function buildVerificationReminder(sessionId?: string): string {
  let reminder = VERIFICATION_REMINDER;

  if (sessionId) {
    reminder += `

---

**If ANY verification fails, resume the subagent with the fix:**
Task tool with resume="${sessionId}", prompt="fix: [describe the specific failure]"`;
  }

  return reminder;
}

/**
 * Build orchestrator reminder with plan progress
 */
export function buildOrchestratorReminder(
  planName: string,
  progress: { total: number; completed: number },
  sessionId?: string
): string {
  const remaining = progress.total - progress.completed;
  return `
---

**State:** Plan: ${planName} | ${progress.completed}/${progress.total} done, ${remaining} left

---

${buildVerificationReminder(sessionId)}

ALL pass? → commit atomic unit, mark \`[x]\`, next task.`;
}

/**
 * Build boulder continuation message
 */
export function buildBoulderContinuation(
  planName: string,
  remaining: number,
  total: number
): string {
  return BOULDER_CONTINUATION_PROMPT.replace(/{PLAN_NAME}/g, planName) +
    `\n\n[Status: ${total - remaining}/${total} completed, ${remaining} remaining]`;
}

/**
 * Detect and process <remember> tags from agent output
 * <remember>content</remember> -> Working Memory
 * <remember priority>content</remember> -> Priority Context
 */
function processRememberTags(output: string, directory: string): void {
  // Match priority remember tags
  const priorityMatches = output.matchAll(/<remember\s+priority>([\s\S]*?)<\/remember>/gi);
  for (const match of priorityMatches) {
    const content = match[1].trim();
    if (content) {
      setPriorityContext(directory, content);
    }
  }

  // Match regular remember tags
  const regularMatches = output.matchAll(/<remember>([\s\S]*?)<\/remember>/gi);
  for (const match of regularMatches) {
    const content = match[1].trim();
    if (content) {
      addWorkingMemoryEntry(directory, content);
    }
  }
}

/**
 * Process pre-tool-use hook for orchestrator
 * Returns warning message if orchestrator tries to modify non-allowed paths
 */
export function processOrchestratorPreTool(input: ToolExecuteInput): ToolExecuteOutput {
  const { toolName, toolInput } = input;

  // Only check write/edit tools
  if (!isWriteEditTool(toolName)) {
    return { continue: true };
  }

  // Extract file path from tool input
  const filePath = (toolInput?.filePath ?? toolInput?.path ?? toolInput?.file) as string | undefined;

  // Allow if path is in allowed prefix
  if (!filePath || isAllowedPath(filePath)) {
    return { continue: true };
  }

  // Inject warning for non-allowed path modifications
  const warning = ORCHESTRATOR_DELEGATION_REQUIRED.replace('$FILE_PATH', filePath);

  return {
    continue: true,
    message: warning,
  };
}

/**
 * Process post-tool-use hook for orchestrator
 * Adds reminders after file modifications and Task delegations
 */
export function processOrchestratorPostTool(
  input: ToolExecuteInput,
  output: string
): ToolExecuteOutput {
  const { toolName, toolInput, directory } = input;
  const workDir = directory || process.cwd();

  // Handle write/edit tools
  if (isWriteEditTool(toolName)) {
    const filePath = (toolInput?.filePath ?? toolInput?.path ?? toolInput?.file) as string | undefined;

    if (filePath && !isAllowedPath(filePath)) {
      return {
        continue: true,
        modifiedOutput: output + DIRECT_WORK_REMINDER,
      };
    }
  }

  // Handle Task tool completion
  if (toolName === 'Task' || toolName === 'task') {
    // Check for background task launch
    const isBackgroundLaunch = output.includes('Background task launched') || output.includes('Background task resumed');
    if (isBackgroundLaunch) {
      return { continue: true };
    }

    // Process <remember> tags from agent output
    processRememberTags(output, workDir);

    // Get git stats and build enhanced output
    const gitStats = getGitDiffStats(workDir);
    const fileChanges = formatFileChanges(gitStats);

    // Check for boulder state
    const boulderState = readBoulderState(workDir);

    if (boulderState) {
      const progress = getPlanProgress(boulderState.active_plan);

      const enhancedOutput = `
## SUBAGENT WORK COMPLETED

${fileChanges}
<system-reminder>
${buildOrchestratorReminder(boulderState.plan_name, progress)}
</system-reminder>`;

      return {
        continue: true,
        modifiedOutput: enhancedOutput,
      };
    }

    // No boulder state - add standalone verification reminder
    return {
      continue: true,
      modifiedOutput: output + `\n<system-reminder>\n${buildVerificationReminder()}\n</system-reminder>`,
    };
  }

  return { continue: true };
}

/**
 * Check if boulder has incomplete tasks and build continuation prompt
 */
export function checkBoulderContinuation(directory: string): {
  shouldContinue: boolean;
  message?: string;
} {
  const boulderState = readBoulderState(directory);

  if (!boulderState) {
    return { shouldContinue: false };
  }

  const progress = getPlanProgress(boulderState.active_plan);

  if (progress.isComplete) {
    return { shouldContinue: false };
  }

  const remaining = progress.total - progress.completed;

  return {
    shouldContinue: true,
    message: buildBoulderContinuation(boulderState.plan_name, remaining, progress.total),
  };
}

/**
 * Create sisyphus orchestrator hook handlers
 */
export function createSisyphusOrchestratorHook(directory: string) {
  return {
    /**
     * Hook name identifier
     */
    name: HOOK_NAME,

    /**
     * Pre-tool execution handler
     */
    preTool: (toolName: string, toolInput: Record<string, unknown>) => {
      return processOrchestratorPreTool({
        toolName,
        toolInput,
        directory,
      });
    },

    /**
     * Post-tool execution handler
     */
    postTool: (toolName: string, toolInput: Record<string, unknown>, output: string) => {
      return processOrchestratorPostTool(
        { toolName, toolInput, directory },
        output
      );
    },

    /**
     * Check for boulder continuation on session idle
     */
    checkContinuation: () => {
      return checkBoulderContinuation(directory);
    },

    /**
     * Get single task directive for subagent prompts
     */
    getSingleTaskDirective: () => SINGLE_TASK_DIRECTIVE,
  };
}
