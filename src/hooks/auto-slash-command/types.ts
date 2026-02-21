/**
 * Auto Slash Command Types
 *
 * Type definitions for slash command detection and execution.
 *
 * Adapted from oh-my-opencode's auto-slash-command hook.
 */

/**
 * Input for auto slash command hook
 */
export interface AutoSlashCommandHookInput {
  sessionId?: string;
  messageId?: string;
  agent?: string;
}

/**
 * Output for auto slash command hook
 */
export interface AutoSlashCommandHookOutput {
  parts: Array<{ type: string; text?: string; [key: string]: unknown }>;
}

/**
 * Parsed slash command from user input
 */
export interface ParsedSlashCommand {
  /** The command name without the leading slash */
  command: string;
  /** Arguments passed to the command */
  args: string;
  /** Raw matched text */
  raw: string;
}

/**
 * Result of auto slash command detection
 */
export interface AutoSlashCommandResult {
  detected: boolean;
  parsedCommand?: ParsedSlashCommand;
  injectedMessage?: string;
}

/**
 * Command scope indicating where it was discovered
 */
export type CommandScope = 'user' | 'project' | 'skill';

/**
 * Command metadata from frontmatter
 */
export interface CommandMetadata {
  name: string;
  description: string;
  argumentHint?: string;
  model?: string;
  agent?: string;
  aliases?: string[];
  aliasOf?: string;
  deprecatedAlias?: boolean;
  deprecationMessage?: string;
}

/**
 * Discovered command information
 */
export interface CommandInfo {
  name: string;
  path?: string;
  metadata: CommandMetadata;
  content?: string;
  scope: CommandScope;
}

/**
 * Result of executing a slash command
 */
export interface ExecuteResult {
  success: boolean;
  replacementText?: string;
  error?: string;
}
