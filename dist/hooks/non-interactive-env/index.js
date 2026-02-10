import { HOOK_NAME, NON_INTERACTIVE_ENV, SHELL_COMMAND_PATTERNS } from "./constants.js";
export * from "./constants.js";
export * from "./detector.js";
export * from "./types.js";
const BANNED_COMMAND_PATTERNS = SHELL_COMMAND_PATTERNS.banned
    .filter((cmd) => !cmd.includes("("))
    .map((cmd) => new RegExp(`\\b${cmd}\\b`));
function detectBannedCommand(command) {
    for (let i = 0; i < BANNED_COMMAND_PATTERNS.length; i++) {
        if (BANNED_COMMAND_PATTERNS[i].test(command)) {
            return SHELL_COMMAND_PATTERNS.banned[i];
        }
    }
    return undefined;
}
/**
 * Shell-escape a value for use in VAR=value prefix.
 * Wraps in single quotes if contains special chars.
 */
function shellEscape(value) {
    // Empty string needs quotes
    if (value === "")
        return "''";
    // If contains special chars, wrap in single quotes (escape existing single quotes)
    if (/[^a-zA-Z0-9_\-.:\/]/.test(value)) {
        return `'${value.replace(/'/g, "'\\''")}'`;
    }
    return value;
}
/**
 * Build export statement for environment variables.
 * Uses `export VAR1=val1 VAR2=val2;` format to ensure variables
 * apply to ALL commands in a chain (e.g., `cmd1 && cmd2`).
 *
 * Previous approach used VAR=value prefix which only applies to the first command.
 */
function buildEnvPrefix(env) {
    const exports = Object.entries(env)
        .map(([key, value]) => `${key}=${shellEscape(value)}`)
        .join(" ");
    return `export ${exports};`;
}
/**
 * Non-interactive environment hook for Claude Code.
 *
 * Detects and handles non-interactive environments (CI, cron, etc.) by:
 * - Warning about banned interactive commands (vim, less, etc.)
 * - Injecting environment variables to prevent git/tools from prompting
 * - Prepending export statements to git commands to block editors/pagers
 */
export const nonInteractiveEnvHook = {
    name: HOOK_NAME,
    async beforeCommand(command) {
        // Check for banned interactive commands
        const bannedCmd = detectBannedCommand(command);
        const warning = bannedCmd
            ? `Warning: '${bannedCmd}' is an interactive command that may hang in non-interactive environments.`
            : undefined;
        // Only prepend env vars for git commands (editor blocking, pager, etc.)
        const isGitCommand = /\bgit\b/.test(command);
        if (!isGitCommand) {
            return { command, warning };
        }
        // Prepend export statement to command to ensure non-interactive behavior
        // Uses `export VAR=val;` format to ensure variables apply to ALL commands
        // in a chain (e.g., `git add file && git rebase --continue`).
        const envPrefix = buildEnvPrefix(NON_INTERACTIVE_ENV);
        const modifiedCommand = `${envPrefix} ${command}`;
        return { command: modifiedCommand, warning };
    },
};
//# sourceMappingURL=index.js.map