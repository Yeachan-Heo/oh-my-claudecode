/**
 * Auto Slash Command Constants
 *
 * Configuration values for slash command detection.
 *
 * Adapted from oh-my-opencode's auto-slash-command hook.
 */
export declare const HOOK_NAME: "auto-slash-command";
/** XML tags to mark auto-expanded slash commands */
export declare const AUTO_SLASH_COMMAND_TAG_OPEN = "<auto-slash-command>";
export declare const AUTO_SLASH_COMMAND_TAG_CLOSE = "</auto-slash-command>";
/** Pattern to detect slash commands at start of message */
export declare const SLASH_COMMAND_PATTERN: RegExp;
/**
 * Commands that should NOT be auto-expanded
 * (they have special handling elsewhere or are now skills with oh-my-claudecode: prefix)
 */
export declare const EXCLUDED_COMMANDS: Set<string>;
//# sourceMappingURL=constants.d.ts.map