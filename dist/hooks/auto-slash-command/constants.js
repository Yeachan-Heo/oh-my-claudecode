/**
 * Auto Slash Command Constants
 *
 * Configuration values for slash command detection.
 *
 * Adapted from oh-my-opencode's auto-slash-command hook.
 */
export const HOOK_NAME = 'auto-slash-command';
/** XML tags to mark auto-expanded slash commands */
export const AUTO_SLASH_COMMAND_TAG_OPEN = '<auto-slash-command>';
export const AUTO_SLASH_COMMAND_TAG_CLOSE = '</auto-slash-command>';
/** Pattern to detect slash commands at start of message */
export const SLASH_COMMAND_PATTERN = /^\/([a-zA-Z][\w-]*)\s*(.*)/;
/**
 * Commands that should NOT be auto-expanded
 * (they have special handling elsewhere or are now skills with oh-my-claudecode: prefix)
 */
export const EXCLUDED_COMMANDS = new Set([
    'ralph',
    'oh-my-claudecode:ralplan',
    'oh-my-claudecode:ultraqa',
    'oh-my-claudecode:learner',
    'oh-my-claudecode:plan',
    'oh-my-claudecode:cancel',
    // Claude Code built-in commands that shouldn't be expanded
    'help',
    'clear',
    'history',
    'exit',
    'quit',
]);
//# sourceMappingURL=constants.js.map