/**
 * Command Expansion Utilities
 *
 * Provides SDK-compatible access to slash commands by reading
 * command templates and expanding them with arguments.
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getClaudeConfigDir } from '../utils/config-dir.js';
const PACKAGED_COMMANDS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'commands');
/**
 * Get the commands directory path
 */
export function getCommandsDir() {
    return join(getClaudeConfigDir(), 'commands');
}
/**
 * Parse command frontmatter and content
 */
function parseCommandFile(content) {
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
function getCommandFilePath(name) {
    const configPath = join(getCommandsDir(), `${name}.md`);
    if (existsSync(configPath)) {
        return configPath;
    }
    const packagedPath = join(PACKAGED_COMMANDS_DIR, `${name}.md`);
    return existsSync(packagedPath) ? packagedPath : null;
}
/**
 * Get a specific command by name
 */
export function getCommand(name) {
    const filePath = getCommandFilePath(name);
    if (!filePath) {
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
    }
    catch (error) {
        console.error(`Error reading command ${name}:`, error);
        return null;
    }
}
/**
 * Get all available commands
 */
export function getAllCommands() {
    const commandNames = new Set();
    for (const commandsDir of [PACKAGED_COMMANDS_DIR, getCommandsDir()]) {
        if (!existsSync(commandsDir)) {
            continue;
        }
        try {
            for (const file of readdirSync(commandsDir).filter(f => f.endsWith('.md'))) {
                commandNames.add(file.replace('.md', ''));
            }
        }
        catch (error) {
            console.error(`Error listing commands in ${commandsDir}:`, error);
        }
    }
    return Array.from(commandNames)
        .map(name => getCommand(name))
        .filter((c) => c !== null);
}
/**
 * List available command names
 */
export function listCommands() {
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
export function expandCommand(name, args = '') {
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
 * This is a Node.js library helper for programmatic Agent SDK usage;
 * it does not invoke Claude Code slash commands or require the VS Code extension.
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
export function expandCommandPrompt(name, args = '') {
    const expanded = expandCommand(name, args);
    return expanded ? expanded.prompt : null;
}
/**
 * Check if a command exists
 */
export function commandExists(name) {
    return getCommand(name) !== null;
}
/**
 * Batch expand multiple commands
 */
export function expandCommands(commands) {
    return commands
        .map(({ name, args }) => expandCommand(name, args))
        .filter((c) => c !== null);
}
//# sourceMappingURL=index.js.map