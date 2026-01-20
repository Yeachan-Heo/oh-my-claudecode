/**
 * Command Expansion Utilities
 *
 * Provides SDK-compatible access to slash commands by reading
 * command templates and expanding them with arguments.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface CommandInfo {
  name: string;
  description: string;
  template: string;
  filePath: string;
}

export interface ExpandedCommand {
  name: string;
  prompt: string;
  description: string;
}

/**
 * Get the commands directory path
 */
export function getCommandsDir(): string {
  return join(homedir(), '.claude', 'commands');
}

/**
 * Parse command frontmatter and content
 */
function parseCommandFile(content: string): { description: string; template: string } {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (!frontmatterMatch) {
    return { description: '', template: content };
  }

  const frontmatter = frontmatterMatch[1];
  const template = frontmatterMatch[2];

  // Extract description from frontmatter
  const descMatch = frontmatter.match(/description:\s*(.+)/);
  const description = descMatch ? descMatch[1].trim() : '';

  return { description, template };
}

/**
 * Get a specific command by name
 */
export function getCommand(name: string): CommandInfo | null {
  const commandsDir = getCommandsDir();
  const filePath = join(commandsDir, `${name}.md`);

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const { description, template } = parseCommandFile(content);

    return {
      name,
      description,
      template,
      filePath
    };
  } catch (error) {
    console.error(`Error reading command ${name}:`, error);
    return null;
  }
}

/**
 * Get all available commands
 */
export function getAllCommands(): CommandInfo[] {
  const commandsDir = getCommandsDir();

  if (!existsSync(commandsDir)) {
    return [];
  }

  try {
    const files = readdirSync(commandsDir).filter(f => f.endsWith('.md'));
    const commands: CommandInfo[] = [];

    for (const file of files) {
      const name = file.replace('.md', '');
      const command = getCommand(name);
      if (command) {
        commands.push(command);
      }
    }

    return commands;
  } catch (error) {
    console.error('Error listing commands:', error);
    return [];
  }
}

/**
 * List available command names
 */
export function listCommands(): string[] {
  return getAllCommands().map(c => c.name);
}

/**
 * Expand a command template with arguments
 *
 * @param name - Command name (without leading slash)
 * @param args - Arguments to substitute for $ARGUMENTS
 * @returns Expanded command ready for SDK query
 *
 * @example
 * ```typescript
 * import { expandCommand } from 'oh-my-claudecode';
 *
 * const prompt = expandCommand('ralph', 'Build a REST API');
 * // Returns the full ralph template with "Build a REST API" substituted
 * ```
 */
export function expandCommand(name: string, args: string = ''): ExpandedCommand | null {
  const command = getCommand(name);

  if (!command) {
    return null;
  }

  // Replace $ARGUMENTS placeholder with actual arguments
  const prompt = command.template.replace(/\$ARGUMENTS/g, args);

  return {
    name,
    prompt: prompt.trim(),
    description: command.description
  };
}

/**
 * Expand a command and return just the prompt string
 * Convenience function for direct use with SDK query
 *
 * @example
 * ```typescript
 * import { expandCommandPrompt } from 'oh-my-claudecode';
 * import { query } from '@anthropic-ai/claude-agent-sdk';
 *
 * const prompt = expandCommandPrompt('ultrawork', 'Refactor the auth module');
 *
 * for await (const msg of query({ prompt })) {
 *   console.log(msg);
 * }
 * ```
 */
export function expandCommandPrompt(name: string, args: string = ''): string | null {
  const expanded = expandCommand(name, args);
  return expanded ? expanded.prompt : null;
}

/**
 * Check if a command exists
 */
export function commandExists(name: string): boolean {
  return getCommand(name) !== null;
}

/**
 * Batch expand multiple commands
 */
export function expandCommands(commands: Array<{ name: string; args?: string }>): ExpandedCommand[] {
  return commands
    .map(({ name, args }) => expandCommand(name, args))
    .filter((c): c is ExpandedCommand => c !== null);
}
