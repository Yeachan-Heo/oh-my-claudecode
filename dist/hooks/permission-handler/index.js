import * as fs from 'fs';
import * as path from 'path';
import { getOmcRoot, probeGitTopLevel } from '../../lib/worktree-paths.js';
import { getClaudeConfigDir } from '../../utils/config-dir.js';
const SAFE_PATTERNS = [
    /^git status$/,
    /^gh (issue|pr) (view|list|status)(?=$|\s)/,
    /^ls( |$)/,
    // REMOVED: cat, head, tail - they allow reading arbitrary files
];
// Shell metacharacters that enable command chaining and injection
// See GitHub Issue #146 for full list of dangerous characters
// Note: Quotes ("') intentionally excluded - they're needed for paths with spaces
// and command substitution is already caught by $ detection
const DANGEROUS_SHELL_CHARS = /[;&|`$()<>\n\r\t\0\\{}\[\]*?~!#]/;
const SAFE_RIPGREP_FLAGS = new Set([
    '-n',
    '--line-number',
    '-S',
    '--smart-case',
    '-F',
    '--fixed-strings',
    '-i',
    '--ignore-case',
    '--no-heading',
]);
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
function readPermissionStringEntries(filePath, key) {
    try {
        if (!fs.existsSync(filePath)) {
            return [];
        }
        const settings = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const entries = settings?.permissions?.[key] ?? settings?.[key];
        return Array.isArray(entries) ? entries.filter((entry) => typeof entry === 'string') : [];
    }
    catch {
        return [];
    }
}
export function getClaudePermissionAllowEntries(directory) {
    const projectSettingsPath = path.join(directory, '.claude', 'settings.local.json');
    const globalConfigDir = getClaudeConfigDir();
    const candidatePaths = [
        projectSettingsPath,
        path.join(globalConfigDir, 'settings.local.json'),
        path.join(globalConfigDir, 'settings.json'),
    ];
    const allowEntries = new Set();
    for (const candidatePath of candidatePaths) {
        for (const entry of readPermissionStringEntries(candidatePath, 'allow')) {
            allowEntries.add(entry.trim());
        }
    }
    return [...allowEntries];
}
function hasGenericToolPermission(allowEntries, toolName) {
    return allowEntries.some(entry => entry === toolName || entry.startsWith(`${toolName}(`));
}
export function hasClaudePermissionApproval(directory, toolName, command) {
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
export function getClaudePermissionAskEntries(directory) {
    const projectSettingsPath = path.join(directory, '.claude', 'settings.local.json');
    const globalConfigDir = getClaudeConfigDir();
    const candidatePaths = [
        projectSettingsPath,
        path.join(globalConfigDir, 'settings.local.json'),
        path.join(globalConfigDir, 'settings.json'),
    ];
    const askEntries = new Set();
    for (const candidatePath of candidatePaths) {
        for (const entry of readPermissionStringEntries(candidatePath, 'ask')) {
            askEntries.add(entry.trim());
        }
    }
    return [...askEntries];
}
function commandMatchesPermissionPattern(command, pattern) {
    const trimmedPattern = pattern.trim();
    if (!trimmedPattern) {
        return false;
    }
    if (!trimmedPattern.includes('*')) {
        return command === trimmedPattern;
    }
    const normalizedPrefix = trimmedPattern.replace(/[\s:]*\*+$/, '').trimEnd();
    if (!normalizedPrefix) {
        return false;
    }
    if (!command.startsWith(normalizedPrefix)) {
        return false;
    }
    const nextChar = command.charAt(normalizedPrefix.length);
    return nextChar === '' || /[\s:=(["']/.test(nextChar);
}
export function hasClaudePermissionAsk(directory, toolName, command) {
    const askEntries = getClaudePermissionAskEntries(directory);
    if (toolName !== 'Bash') {
        return hasGenericToolPermission(askEntries, toolName);
    }
    const trimmedCommand = command?.trim();
    if (!trimmedCommand) {
        return false;
    }
    return askEntries.some(entry => {
        if (entry === 'Bash') {
            return true;
        }
        if (!entry.startsWith('Bash(') || !entry.endsWith(')')) {
            return false;
        }
        return commandMatchesPermissionPattern(trimmedCommand, entry.slice(5, -1));
    });
}
export function getBackgroundTaskPermissionFallback(directory, subagentType) {
    const normalizedSubagentType = subagentType?.trim().toLowerCase();
    if (!normalizedSubagentType || !BACKGROUND_MUTATION_SUBAGENTS.has(normalizedSubagentType)) {
        return { shouldFallback: false, missingTools: [] };
    }
    const missingTools = ['Edit', 'Write'].filter(toolName => !hasClaudePermissionApproval(directory, toolName));
    return {
        shouldFallback: missingTools.length > 0,
        missingTools,
    };
}
export function getBackgroundBashPermissionFallback(directory, command) {
    if (!command) {
        return { shouldFallback: false, missingTools: [] };
    }
    if (hasClaudePermissionAsk(directory, 'Bash', command)) {
        return { shouldFallback: true, missingTools: ['Bash'] };
    }
    if (isSafeAutoApprovedCommand(command, directory)) {
        return { shouldFallback: false, missingTools: [] };
    }
    return hasClaudePermissionApproval(directory, 'Bash', command)
        ? { shouldFallback: false, missingTools: [] }
        : { shouldFallback: true, missingTools: ['Bash'] };
}
function tokenizeShellCommand(command) {
    const tokens = [];
    let current = '';
    let quote = null;
    for (const char of command.trim()) {
        if (quote) {
            if (char === quote) {
                quote = null;
            }
            else {
                current += char;
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (/\s/.test(char)) {
            if (current) {
                tokens.push(current);
                current = '';
            }
            continue;
        }
        current += char;
    }
    if (quote) {
        return null;
    }
    if (current) {
        tokens.push(current);
    }
    return tokens.length > 0 ? tokens : null;
}
const SENSITIVE_REPO_BASENAMES = new Set([
    'id_rsa',
    'id_dsa',
    'id_ecdsa',
    'id_ed25519',
    '.npmrc',
    '.netrc',
    '.pgpass',
]);
const SENSITIVE_REPO_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx'];
function isSensitiveRepoRelativePath(repoRelativePath) {
    const normalized = repoRelativePath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    if (!normalized || normalized === '.') {
        return false;
    }
    const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
    if (SENSITIVE_REPO_BASENAMES.has(basename) ||
        SENSITIVE_REPO_EXTENSIONS.some((extension) => basename.endsWith(extension))) {
        return true;
    }
    return (normalized === '.git' ||
        normalized.startsWith('.git/') ||
        normalized.includes('/.git/') ||
        normalized === '.ssh' ||
        normalized.startsWith('.ssh/') ||
        normalized.includes('/.ssh/') ||
        normalized === 'secrets' ||
        normalized.startsWith('secrets/') ||
        normalized.includes('/secrets/') ||
        normalized === '.env' ||
        normalized.startsWith('.env.') ||
        normalized.includes('/.env') ||
        normalized.includes('/.env.') ||
        normalized === 'node_modules/.cache' ||
        normalized.startsWith('node_modules/.cache/') ||
        normalized.includes('/node_modules/.cache/'));
}
function isSafeRepoPath(cwd, inputPath, options = {}) {
    const { allowDirectory = false, requireExisting = true } = options;
    if (!inputPath) {
        return false;
    }
    // Literal git toplevel (no submodule→superproject climb) so the containment
    // boundary stays the actual repo the path lives in (#3349 / PR #3350).
    const worktreeProbe = probeGitTopLevel(cwd);
    if (worktreeProbe.status !== 'ok') {
        return false;
    }
    const worktreeRoot = worktreeProbe.root;
    const resolvedPath = path.resolve(cwd, inputPath);
    let canonicalPath = resolvedPath;
    const exists = fs.existsSync(resolvedPath);
    if (exists) {
        try {
            canonicalPath = fs.realpathSync(resolvedPath);
        }
        catch {
            return false;
        }
    }
    else if (requireExisting) {
        return false;
    }
    const relativePath = path.relative(worktreeRoot, canonicalPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return false;
    }
    if (!relativePath || relativePath === '.') {
        return allowDirectory;
    }
    if (isSensitiveRepoRelativePath(relativePath)) {
        return false;
    }
    if (!allowDirectory && exists) {
        try {
            if (fs.statSync(resolvedPath).isDirectory()) {
                return false;
            }
        }
        catch {
            return false;
        }
    }
    return true;
}
function areSafeRepoPaths(cwd, args, options = {}) {
    const pathArgs = args.filter(arg => arg !== '--');
    return pathArgs.length > 0 && pathArgs.every(arg => !arg.startsWith('-') && isSafeRepoPath(cwd, arg, options));
}
function isSafeCatCommand(tokens, cwd) {
    return tokens[0] === 'cat' && areSafeRepoPaths(cwd, tokens.slice(1));
}
function isSafeHeadOrTailCommand(tokens, cwd) {
    if (tokens[0] !== 'head' && tokens[0] !== 'tail') {
        return false;
    }
    let index = 1;
    if (tokens[index] === '-n') {
        index += 2;
    }
    else if (/^-n\d+$/.test(tokens[index] ?? '')) {
        index += 1;
    }
    return areSafeRepoPaths(cwd, tokens.slice(index));
}
function isSafeSedInspectionCommand(tokens, cwd) {
    if (tokens[0] !== 'sed' || tokens[1] !== '-n') {
        return false;
    }
    const script = tokens[2];
    if (!script || !/^\d+(,\d+)?p$/.test(script)) {
        return false;
    }
    return areSafeRepoPaths(cwd, tokens.slice(3));
}
function isSafeRipgrepInspectionCommand(tokens, cwd) {
    if (tokens[0] !== 'rg') {
        return false;
    }
    let index = 1;
    while (index < tokens.length) {
        const token = tokens[index];
        if (token === '--') {
            index += 1;
            break;
        }
        if (!token.startsWith('-')) {
            break;
        }
        if (!SAFE_RIPGREP_FLAGS.has(token)) {
            return false;
        }
        index += 1;
    }
    const pattern = tokens[index];
    if (!pattern || pattern.startsWith('-')) {
        return false;
    }
    const searchPaths = tokens.slice(index + 1);
    return areSafeRepoPaths(cwd, searchPaths, { allowDirectory: false });
}
export function isSafeRepoInspectionCommand(command, cwd) {
    const trimmed = command.trim();
    if (!trimmed || DANGEROUS_SHELL_CHARS.test(trimmed)) {
        return false;
    }
    const tokens = tokenizeShellCommand(trimmed);
    if (!tokens) {
        return false;
    }
    return isSafeCatCommand(tokens, cwd)
        || isSafeHeadOrTailCommand(tokens, cwd)
        || isSafeSedInspectionCommand(tokens, cwd)
        || isSafeRipgrepInspectionCommand(tokens, cwd);
}
export function isSafeAutoApprovedCommand(command, cwd) {
    return isSafeCommand(command)
        || isSafeRepoInspectionCommand(command, cwd);
}
/**
 * Check if a command matches safe patterns
 */
export function isSafeCommand(command) {
    const trimmed = command.trim();
    // SECURITY: Reject ANY command with shell metacharacters
    // These allow command chaining that bypasses safe pattern checks
    if (DANGEROUS_SHELL_CHARS.test(trimmed)) {
        return false;
    }
    return SAFE_PATTERNS.some(pattern => pattern.test(trimmed));
}
/**
 * Check if an active supported mode is running
 */
export function isActiveModeRunning(directory) {
    const stateDir = path.join(getOmcRoot(directory), 'state');
    if (!fs.existsSync(stateDir)) {
        return false;
    }
    const activeStateFiles = [
        'autopilot-state.json',
        'ralph-state.json',
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
            }
            catch (_error) {
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
export function processPermissionRequest(input) {
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
    const shouldAskBashPermission = hasClaudePermissionAsk(input.cwd, 'Bash', command);
    // Auto-allow safe commands
    if (!shouldAskBashPermission && isSafeAutoApprovedCommand(command, input.cwd)) {
        return {
            continue: true,
            hookSpecificOutput: {
                hookEventName: 'PermissionRequest',
                decision: {
                    behavior: 'allow',
                    reason: 'Safe read-only command',
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
export async function handlePermissionRequest(input) {
    return processPermissionRequest(input);
}
//# sourceMappingURL=index.js.map