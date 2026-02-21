/**
 * Auto Slash Command Executor
 *
 * Discovers and executes slash commands from various sources.
 *
 * Adapted from oh-my-opencode's auto-slash-command hook.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { getClaudeConfigDir } from '../../utils/paths.js';
import type {
  ParsedSlashCommand,
  CommandInfo,
  CommandMetadata,
  CommandScope,
  ExecuteResult,
} from './types.js';
import { resolveLiveData } from './live-data.js';

/** Claude config directory */
const CLAUDE_CONFIG_DIR = getClaudeConfigDir();

/**
 * Parse YAML-like frontmatter from markdown file
 * Simple implementation - supports basic key: value format
 */
function parseFrontmatter(content: string): { data: Record<string, string>; body: string } {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { data: {}, body: content };
  }

  const [, yamlContent, body] = match;
  const data: Record<string, string> = {};

  for (const line of yamlContent.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();

    // Remove surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    data[key] = value;
  }

  return { data, body };
}

function stripOptionalQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function getFrontmatterString(
  data: Record<string, string>,
  key: string,
): string | undefined {
  const value = data[key];
  if (!value) return undefined;
  const normalized = stripOptionalQuotes(value);
  return normalized.length > 0 ? normalized : undefined;
}

function getFrontmatterAliases(data: Record<string, string>): string[] {
  const rawAliases = getFrontmatterString(data, 'aliases');
  if (!rawAliases) return [];

  if (rawAliases.startsWith('[') && rawAliases.endsWith(']')) {
    const inner = rawAliases.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(',')
      .map(alias => stripOptionalQuotes(alias))
      .filter(alias => alias.length > 0);
  }

  return [rawAliases];
}

/**
 * Discover commands from a directory
 */
function discoverCommandsFromDir(
  commandsDir: string,
  scope: CommandScope
): CommandInfo[] {
  if (!existsSync(commandsDir)) {
    return [];
  }

  let entries;
  try {
    entries = readdirSync(commandsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const commands: CommandInfo[] = [];

  for (const entry of entries) {
    // Only process .md files
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

    const commandPath = join(commandsDir, entry.name);
    const commandName = basename(entry.name, '.md');

    try {
      const content = readFileSync(commandPath, 'utf-8');
      const { data, body } = parseFrontmatter(content);

      const metadata: CommandMetadata = {
        name: commandName,
        description: data.description || '',
        argumentHint: data['argument-hint'],
        model: data.model,
        agent: data.agent,
      };

      commands.push({
        name: commandName,
        path: commandPath,
        metadata,
        content: body,
        scope,
      });
    } catch {
      continue;
    }
  }

  return commands;
}

/**
 * Discover all available commands from multiple sources
 */
export function discoverAllCommands(): CommandInfo[] {
  const userCommandsDir = join(CLAUDE_CONFIG_DIR, 'commands');
  const projectCommandsDir = join(process.cwd(), '.claude', 'commands');
  const skillsDir = join(CLAUDE_CONFIG_DIR, 'skills');

  const userCommands = discoverCommandsFromDir(userCommandsDir, 'user');
  const projectCommands = discoverCommandsFromDir(projectCommandsDir, 'project');

  // Discover skills (each skill directory may have a SKILL.md)
  const skillCommands: CommandInfo[] = [];
  if (existsSync(skillsDir)) {
    try {
      const skillDirs = readdirSync(skillsDir, { withFileTypes: true });
      for (const dir of skillDirs) {
        if (!dir.isDirectory()) continue;

        const skillPath = join(skillsDir, dir.name, 'SKILL.md');
        if (existsSync(skillPath)) {
          try {
            const content = readFileSync(skillPath, 'utf-8');
            const { data, body } = parseFrontmatter(content);

            const canonicalName = getFrontmatterString(data, 'name') || dir.name;
            const aliases = Array.from(new Set(
              getFrontmatterAliases(data).filter(
                alias => alias.toLowerCase() !== canonicalName.toLowerCase()
              )
            ));
            const commandNames = [canonicalName, ...aliases];
            const description = getFrontmatterString(data, 'description') || '';
            const argumentHint = getFrontmatterString(data, 'argument-hint');
            const model = getFrontmatterString(data, 'model');
            const agent = getFrontmatterString(data, 'agent');

            for (const commandName of commandNames) {
              const isAlias = commandName !== canonicalName;
              const metadata: CommandMetadata = {
                name: commandName,
                description,
                argumentHint,
                model,
                agent,
                aliases: isAlias ? undefined : aliases,
                aliasOf: isAlias ? canonicalName : undefined,
                deprecatedAlias: isAlias || undefined,
                deprecationMessage: isAlias
                  ? `Alias "/${commandName}" is deprecated. Use "/${canonicalName}" instead.`
                  : undefined,
              };

              skillCommands.push({
                name: commandName,
                path: skillPath,
                metadata,
                content: body,
                scope: 'skill',
              });
            }
          } catch {
            continue;
          }
        }
      }
    } catch {
      // Ignore errors reading skills directory
    }
  }

  // Priority: project > user > skills
  const prioritized = [...projectCommands, ...userCommands, ...skillCommands];
  const seen = new Set<string>();

  return prioritized.filter((command) => {
    const key = command.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Find a specific command by name
 */
export function findCommand(commandName: string): CommandInfo | null {
  const allCommands = discoverAllCommands();
  return (
    allCommands.find(
      (cmd) => cmd.name.toLowerCase() === commandName.toLowerCase()
    ) ?? null
  );
}

/**
 * Resolve $ARGUMENTS placeholder in command content
 */
function resolveArguments(content: string, args: string): string {
  return content.replace(/\$ARGUMENTS/g, args || '(no arguments provided)');
}

/**
 * Format command template with metadata header
 */
function formatCommandTemplate(cmd: CommandInfo, args: string): string {
  const sections: string[] = [];

  sections.push(`<command-name>/${cmd.name}</command-name>\n`);

  if (cmd.metadata.description) {
    sections.push(`**Description**: ${cmd.metadata.description}\n`);
  }

  if (args) {
    sections.push(`**Arguments**: ${args}\n`);
  }

  if (cmd.metadata.model) {
    sections.push(`**Model**: ${cmd.metadata.model}\n`);
  }

  if (cmd.metadata.agent) {
    sections.push(`**Agent**: ${cmd.metadata.agent}\n`);
  }

  sections.push(`**Scope**: ${cmd.scope}\n`);

  if (cmd.metadata.aliasOf) {
    sections.push(
      `⚠️ **Deprecated Alias**: \`/${cmd.name}\` is deprecated and will be removed in a future release. Use \`/${cmd.metadata.aliasOf}\` instead.\n`
    );
  }

  sections.push('---\n');

  // Resolve arguments in content, then execute any live-data commands
  const resolvedContent = resolveArguments(cmd.content || '', args);
  const injectedContent = resolveLiveData(resolvedContent);
  sections.push(injectedContent.trim());

  if (args && !cmd.content?.includes('$ARGUMENTS')) {
    sections.push('\n\n---\n');
    sections.push('## User Request\n');
    sections.push(args);
  }

  return sections.join('\n');
}

/**
 * Execute a slash command and return replacement text
 */
export function executeSlashCommand(parsed: ParsedSlashCommand): ExecuteResult {
  const command = findCommand(parsed.command);

  if (!command) {
    return {
      success: false,
      error: `Command "/${parsed.command}" not found. Available commands are in $CLAUDE_CONFIG_DIR/commands/ (or ~/.claude/commands/ by default) or .claude/commands/`,
    };
  }

  try {
    const template = formatCommandTemplate(command, parsed.args);
    return {
      success: true,
      replacementText: template,
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to load command "/${parsed.command}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/**
 * List all available commands
 */
export function listAvailableCommands(): Array<{
  name: string;
  description: string;
  scope: CommandScope;
}> {
  return listAvailableCommandsWithOptions();
}

export function listAvailableCommandsWithOptions(options?: {
  includeAliases?: boolean;
}): Array<{
  name: string;
  description: string;
  scope: CommandScope;
}> {
  const { includeAliases = false } = options ?? {};
  const commands = discoverAllCommands();
  const visibleCommands = includeAliases
    ? commands
    : commands.filter((cmd) => !cmd.metadata.aliasOf);

  return visibleCommands.map((cmd) => ({
    name: cmd.name,
    description: cmd.metadata.description,
    scope: cmd.scope,
  }));
}
