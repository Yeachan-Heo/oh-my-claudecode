/**
 * Auto Slash Command Detector
 *
 * Detects slash commands in user prompts.
 *
 * Adapted from oh-my-opencode's auto-slash-command hook.
 */

import {
  SLASH_COMMAND_PATTERN,
  EXCLUDED_COMMANDS,
} from './constants.js';
import type { ParsedSlashCommand } from './types.js';

/** Pattern to match code blocks */
const CODE_BLOCK_PATTERN = /```[\s\S]*?```/g;

/**
 * Remove code blocks from text to prevent false positives
 */
export function removeCodeBlocks(text: string): string {
  return text.replace(CODE_BLOCK_PATTERN, '');
}

/**
 * Parse a slash command from text
 */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const trimmed = text.trim();

  if (!trimmed.startsWith('/')) {
    return null;
  }

  const match = trimmed.match(SLASH_COMMAND_PATTERN);
  if (!match) {
    return null;
  }

  const [raw, command, args] = match;
  return {
    command: command.toLowerCase(),
    args: args.trim(),
    raw,
  };
}

/**
 * Check if a command should be excluded from auto-expansion
 */
export function isExcludedCommand(command: string): boolean {
  return EXCLUDED_COMMANDS.has(command.toLowerCase());
}

/**
 * Detect a slash command in user input text
 * Returns null if no command detected or if command is excluded
 */
export function detectSlashCommand(text: string): ParsedSlashCommand | null {
  // Remove code blocks first
  const textWithoutCodeBlocks = removeCodeBlocks(text);
  const trimmed = textWithoutCodeBlocks.trim();

  // Must start with slash
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const parsed = parseSlashCommand(trimmed);

  if (!parsed) {
    return null;
  }

  // Check exclusion list
  if (isExcludedCommand(parsed.command)) {
    return null;
  }

  return parsed;
}

/**
 * Extract text content from message parts array
 */
export function extractPromptText(
  parts: Array<{ type: string; text?: string }>
): string {
  return parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text || '')
    .join(' ');
}
