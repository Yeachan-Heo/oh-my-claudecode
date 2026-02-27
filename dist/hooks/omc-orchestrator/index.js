/**
 * OMC Orchestrator Hook
 *
 * Enforces orchestrator behavior - delegation over direct implementation.
 * When an orchestrator agent tries to directly modify files outside .omc/,
 * this hook injects reminders to delegate to subagents instead.
 *
 * Adapted from oh-my-opencode's omc-orchestrator hook for shell-based hooks.
 */
import * as path from 'path';
import { execSync } from 'child_process';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { getClaudeConfigDir } from '../../utils/paths.js';
import { existsSync, readFileSync } from 'fs';
import { HOOK_NAME, ALLOWED_PATH_PATTERNS, WARNED_EXTENSIONS, WRITE_EDIT_TOOLS, DIRECT_WORK_REMINDER, ORCHESTRATOR_DELEGATION_REQUIRED, BOULDER_CONTINUATION_PROMPT, VERIFICATION_REMINDER, SINGLE_TASK_DIRECTIVE, } from './constants.js';
import { readBoulderState, getPlanProgress, } from '../../features/boulder-state/index.js';
import { addWorkingMemoryEntry, setPriorityContext, } from '../notepad/index.js';
import { logAuditEntry } from './audit.js';
import { getWorktreeRoot } from '../../lib/worktree-paths.js';
import { toForwardSlash } from '../../utils/paths.js';
// Re-export constants
export * from './constants.js';
// Config caching (30s TTL)
let enforcementCache = null;
const CACHE_TTL_MS = 30_000; // 30 seconds
/**
 * Clear enforcement level cache (for testing)
 * @internal
 */
export function clearEnforcementCache() {
    enforcementCache = null;
}
/**
 * Read enforcement level from config
 * Checks: .omc/config.json → ~/.claude/.omc-config.json → default (warn)
 */
function getEnforcementLevel(directory) {
    const now = Date.now();
    // Return cached value if valid
    if (enforcementCache &&
        enforcementCache.directory === directory &&
        (now - enforcementCache.timestamp) < CACHE_TTL_MS) {
        return enforcementCache.level;
    }
    const localConfig = path.join(getOmcRoot(directory), 'config.json');
    const globalConfig = path.join(getClaudeConfigDir(), '.omc-config.json');
    let level = 'warn'; // Default
    for (const configPath of [localConfig, globalConfig]) {
        if (existsSync(configPath)) {
            try {
                const content = readFileSync(configPath, 'utf-8');
                const config = JSON.parse(content);
                const configLevel = config.delegationEnforcementLevel ?? config.enforcementLevel;
                if (['off', 'warn', 'strict'].includes(configLevel)) {
                    level = configLevel;
                    break; // Found valid level, stop searching
                }
            }
            catch {
                // Continue to next config
            }
        }
    }
    // Update cache
    enforcementCache = { level, directory, timestamp: now };
    return level;
}
/**
 * Check if a file path is allowed for direct orchestrator modification
 */
export function isAllowedPath(filePath, directory) {
    if (!filePath)
        return true;
    // Convert backslashes first (so path.normalize resolves .. on all platforms),
    // then normalize to collapse .. segments, then ensure forward slashes.
    const normalized = toForwardSlash(path.normalize(toForwardSlash(filePath)));
    // Reject explicit traversal that escapes (e.g. "../foo")
    if (normalized.startsWith('../') || normalized === '..')
        return false;
    // Fast path: check relative patterns
    if (ALLOWED_PATH_PATTERNS.some(pattern => pattern.test(normalized)))
        return true;
    // Absolute path: strip worktree root, then re-check
    if (path.isAbsolute(filePath)) {
        const root = directory ? getWorktreeRoot(directory) : getWorktreeRoot();
        if (root) {
            const rel = toForwardSlash(path.relative(root, filePath));
            if (rel.startsWith('../') || rel === '..' || path.isAbsolute(rel))
                return false;
            return ALLOWED_PATH_PATTERNS.some(pattern => pattern.test(rel));
        }
    }
    return false;
}
/**
 * Check if a file path is a source file that should trigger delegation warning
 */
export function isSourceFile(filePath) {
    if (!filePath)
        return false;
    const ext = path.extname(filePath).toLowerCase();
    return WARNED_EXTENSIONS.includes(ext);
}
/**
 * Check if a tool is a write/edit tool
 */
export function isWriteEditTool(toolName) {
    return WRITE_EDIT_TOOLS.includes(toolName);
}
/**
 * Get git diff statistics for the working directory
 */
export function getGitDiffStats(directory) {
    try {
        const output = execSync('git diff --numstat HEAD', {
            cwd: directory,
            encoding: 'utf-8',
            timeout: 5000,
        }).trim();
        if (!output)
            return [];
        const statusOutput = execSync('git status --porcelain', {
            cwd: directory,
            encoding: 'utf-8',
            timeout: 5000,
        }).trim();
        const statusMap = new Map();
        for (const line of statusOutput.split('\n')) {
            if (!line)
                continue;
            const status = line.substring(0, 2).trim();
            const filePath = line.substring(3);
            if (status === 'A' || status === '??') {
                statusMap.set(filePath, 'added');
            }
            else if (status === 'D') {
                statusMap.set(filePath, 'deleted');
            }
            else {
                statusMap.set(filePath, 'modified');
            }
        }
        const stats = [];
        for (const line of output.split('\n')) {
            const parts = line.split('\t');
            if (parts.length < 3)
                continue;
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
    }
    catch {
        return [];
    }
}
/**
 * Format file changes for display
 */
export function formatFileChanges(stats) {
    if (stats.length === 0)
        return '[FILE CHANGES SUMMARY]\nNo file changes detected.\n';
    const modified = stats.filter((s) => s.status === 'modified');
    const added = stats.filter((s) => s.status === 'added');
    const deleted = stats.filter((s) => s.status === 'deleted');
    const lines = ['[FILE CHANGES SUMMARY]'];
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
export function buildVerificationReminder(sessionId) {
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
export function buildOrchestratorReminder(planName, progress, sessionId) {
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
export function buildBoulderContinuation(planName, remaining, total) {
    return BOULDER_CONTINUATION_PROMPT.replace(/{PLAN_NAME}/g, planName) +
        `\n\n[Status: ${total - remaining}/${total} completed, ${remaining} remaining]`;
}
/**
 * Detect and process <remember> tags from agent output
 * <remember>content</remember> -> Working Memory
 * <remember priority>content</remember> -> Priority Context
 */
function processRememberTags(output, directory) {
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
 * Suggest agent based on file extension
 */
function suggestAgentForFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const suggestions = {
        '.ts': 'executor-low (simple) or executor (complex)',
        '.tsx': 'designer-low (simple) or designer (complex UI)',
        '.js': 'executor-low',
        '.jsx': 'designer-low',
        '.py': 'executor-low (simple) or executor (complex)',
        '.vue': 'designer',
        '.svelte': 'designer',
        '.css': 'designer-low',
        '.scss': 'designer-low',
        '.md': 'writer (documentation)',
        '.json': 'executor-low',
    };
    return suggestions[ext] || 'executor';
}
/**
 * Process pre-tool-use hook for orchestrator
 * Returns warning message if orchestrator tries to modify non-allowed paths
 */
export function processOrchestratorPreTool(input) {
    const { toolName, toolInput, sessionId } = input;
    const directory = input.directory || process.cwd();
    const enforcementLevel = getEnforcementLevel(directory);
    // Early exit if enforcement is off
    if (enforcementLevel === 'off') {
        return { continue: true };
    }
    // Only check write/edit tools
    if (!isWriteEditTool(toolName)) {
        return { continue: true };
    }
    // Extract file path from tool input.
    // Claude Code sends file_path (snake_case) for Write/Edit tools and notebook_path for NotebookEdit.
    // toolInput is the tool's own parameter object, NOT normalized by normalizeHookInput.
    const filePath = (toolInput?.file_path ?? toolInput?.filePath ?? toolInput?.path ?? toolInput?.file ?? toolInput?.notebook_path);
    // Allow if path is in allowed prefix
    if (!filePath || isAllowedPath(filePath, directory)) {
        // Log allowed operation
        if (filePath) {
            logAuditEntry({
                tool: toolName,
                filePath,
                decision: 'allowed',
                reason: 'allowed_path',
                enforcementLevel,
                sessionId,
            });
        }
        return { continue: true };
    }
    // Log warned/blocked operation
    const isSource = isSourceFile(filePath);
    logAuditEntry({
        tool: toolName,
        filePath,
        decision: enforcementLevel === 'strict' ? 'blocked' : 'warned',
        reason: isSource ? 'source_file' : 'other',
        enforcementLevel,
        sessionId,
    });
    // Build warning with agent suggestion
    const agentSuggestion = suggestAgentForFile(filePath);
    const warning = ORCHESTRATOR_DELEGATION_REQUIRED.replace('$FILE_PATH', filePath) +
        `\n\nSuggested agent: ${agentSuggestion}`;
    // Block if strict mode, warn otherwise
    if (enforcementLevel === 'strict') {
        return {
            continue: false,
            reason: 'DELEGATION_REQUIRED',
            message: warning,
        };
    }
    else {
        return {
            continue: true,
            message: warning,
        };
    }
}
/**
 * Process post-tool-use hook for orchestrator
 * Adds reminders after file modifications and Task delegations
 */
export function processOrchestratorPostTool(input, output) {
    const { toolName, toolInput, directory } = input;
    const workDir = directory || process.cwd();
    // Handle write/edit tools
    if (isWriteEditTool(toolName)) {
        const filePath = (toolInput?.filePath ?? toolInput?.path ?? toolInput?.file);
        if (filePath && !isAllowedPath(filePath, workDir)) {
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
export function checkBoulderContinuation(directory) {
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
 * Create omc orchestrator hook handlers
 */
export function createOmcOrchestratorHook(directory) {
    return {
        /**
         * Hook name identifier
         */
        name: HOOK_NAME,
        /**
         * Pre-tool execution handler
         */
        preTool: (toolName, toolInput) => {
            return processOrchestratorPreTool({
                toolName,
                toolInput,
                directory,
            });
        },
        /**
         * Post-tool execution handler
         */
        postTool: (toolName, toolInput, output) => {
            return processOrchestratorPostTool({ toolName, toolInput, directory }, output);
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
//# sourceMappingURL=index.js.map