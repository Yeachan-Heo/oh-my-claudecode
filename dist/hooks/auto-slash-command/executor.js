/**
 * Auto Slash Command Executor
 *
 * Discovers and executes slash commands from various sources.
 *
 * Adapted from oh-my-opencode's auto-slash-command hook.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { getClaudeConfigDir } from '../../utils/config-dir.js';
import { resolveLiveData } from './live-data.js';
import { parseFrontmatter, parseFrontmatterAliases, stripOptionalQuotes } from '../../utils/frontmatter.js';
import { formatOmcCliInvocation, rewriteOmcCliInvocations } from '../../utils/omc-cli-rendering.js';
import { parseSkillPipelineMetadata, renderSkillPipelineGuidance } from '../../utils/skill-pipeline.js';
import { renderSkillResourcesGuidance } from '../../utils/skill-resources.js';
import { renderSkillRuntimeGuidance } from '../../features/builtin-skills/runtime-guidance.js';
import { getSkillsDir } from '../../features/builtin-skills/skills.js';
/** Claude config directory */
const CLAUDE_CONFIG_DIR = getClaudeConfigDir();
/**
 * Claude Code native commands that must not be shadowed by user skills.
 * Skills whose canonical name or alias matches one of these will be prefixed
 * with `omc-` to avoid overriding built-in CC slash commands.
 */
const CC_NATIVE_COMMANDS = new Set([
    'review',
    'plan',
    'security-review',
    'init',
    'doctor',
    'help',
    'config',
    'clear',
    'compact',
    'memory',
]);
function toSafeSkillName(name) {
    const normalized = name.trim();
    return CC_NATIVE_COMMANDS.has(normalized.toLowerCase())
        ? `omc-${normalized}`
        : normalized;
}
function getFrontmatterString(data, key) {
    const value = data[key];
    if (!value)
        return undefined;
    const normalized = stripOptionalQuotes(value);
    return normalized.length > 0 ? normalized : undefined;
}
/**
 * Discover commands from a directory
 */
function discoverCommandsFromDir(commandsDir, scope) {
    if (!existsSync(commandsDir)) {
        return [];
    }
    let entries;
    try {
        entries = readdirSync(commandsDir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const commands = [];
    for (const entry of entries) {
        // Only process .md files
        if (!entry.isFile() || !entry.name.endsWith('.md'))
            continue;
        const commandPath = join(commandsDir, entry.name);
        const commandName = basename(entry.name, '.md');
        try {
            const content = readFileSync(commandPath, 'utf-8');
            const { metadata: fm, body } = parseFrontmatter(content);
            const commandMetadata = {
                name: commandName,
                description: fm.description || '',
                argumentHint: fm['argument-hint'],
                model: fm.model,
                agent: fm.agent,
            };
            commands.push({
                name: commandName,
                path: commandPath,
                metadata: commandMetadata,
                content: body,
                scope,
            });
        }
        catch {
            continue;
        }
    }
    return commands;
}
function discoverSkillsFromDir(skillsDir) {
    if (!existsSync(skillsDir)) {
        return [];
    }
    const skillCommands = [];
    try {
        const skillDirs = readdirSync(skillsDir, { withFileTypes: true });
        for (const dir of skillDirs) {
            if (!dir.isDirectory())
                continue;
            const skillPath = join(skillsDir, dir.name, 'SKILL.md');
            if (!existsSync(skillPath))
                continue;
            try {
                const content = readFileSync(skillPath, 'utf-8');
                const { metadata: fm, body } = parseFrontmatter(content);
                const rawName = getFrontmatterString(fm, 'name') || dir.name;
                const canonicalName = toSafeSkillName(rawName);
                const aliases = Array.from(new Set(parseFrontmatterAliases(fm.aliases)
                    .map((alias) => toSafeSkillName(alias))
                    .filter((alias) => alias.toLowerCase() !== canonicalName.toLowerCase())));
                const commandNames = [canonicalName, ...aliases];
                const description = getFrontmatterString(fm, 'description') || '';
                const argumentHint = getFrontmatterString(fm, 'argument-hint');
                const model = getFrontmatterString(fm, 'model');
                const agent = getFrontmatterString(fm, 'agent');
                const pipeline = parseSkillPipelineMetadata(fm);
                for (const commandName of commandNames) {
                    const isAlias = commandName !== canonicalName;
                    const metadata = {
                        name: commandName,
                        description,
                        argumentHint,
                        model,
                        agent,
                        pipeline: isAlias ? undefined : pipeline,
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
            }
            catch {
                continue;
            }
        }
    }
    catch {
        return [];
    }
    return skillCommands;
}
/**
 * Discover all available commands from multiple sources
 */
export function discoverAllCommands() {
    const userCommandsDir = join(CLAUDE_CONFIG_DIR, 'commands');
    const projectCommandsDir = join(process.cwd(), '.claude', 'commands');
    const projectOmcSkillsDir = join(process.cwd(), '.omc', 'skills');
    const projectAgentSkillsDir = join(process.cwd(), '.agents', 'skills');
    const userSkillsDir = join(CLAUDE_CONFIG_DIR, 'skills');
    const userCommands = discoverCommandsFromDir(userCommandsDir, 'user');
    const projectCommands = discoverCommandsFromDir(projectCommandsDir, 'project');
    const projectOmcSkills = discoverSkillsFromDir(projectOmcSkillsDir);
    const projectAgentSkills = discoverSkillsFromDir(projectAgentSkillsDir);
    const userSkills = discoverSkillsFromDir(userSkillsDir);
    const builtinSkills = discoverSkillsFromDir(getSkillsDir());
    // Priority: project commands > user commands > project OMC skills > project compatibility skills > user skills > builtin skills
    const prioritized = [
        ...projectCommands,
        ...userCommands,
        ...projectOmcSkills,
        ...projectAgentSkills,
        ...userSkills,
        ...builtinSkills,
    ];
    const seen = new Set();
    return prioritized.filter((command) => {
        const key = command.name.toLowerCase();
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
/**
 * Find a specific command by name
 */
export function findCommand(commandName) {
    const allCommands = discoverAllCommands();
    return (allCommands.find((cmd) => cmd.name.toLowerCase() === commandName.toLowerCase()) ?? null);
}
/**
 * Resolve $ARGUMENTS placeholder in command content
 */
function resolveArguments(content, args) {
    return content.replace(/\$ARGUMENTS/g, args || '(no arguments provided)');
}
function hasInvocationFlag(args, flag) {
    const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|\\s)${escaped}(?=\\s|$)`).test(args);
}
function stripInvocationFlag(args, flag) {
    const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return args
        .replace(new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, 'g'), ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
function renderDeepInterviewAutoresearchGuidance(args) {
    const missionSeed = stripInvocationFlag(args, '--autoresearch');
    const lines = [
        '## Autoresearch Setup Mode',
        `This deep-interview invocation was launched as the zero-learning-curve setup lane for \`${formatOmcCliInvocation('autoresearch')}\`.`,
        '',
        'Required behavior in this mode:',
        '- If the mission is not already clear, start by asking: "What should autoresearch improve or prove for this repo?"',
        '- Treat evaluator clarity as a required readiness gate before launch.',
        '- When the mission and evaluator are ready, launch direct execution with:',
        `  \`${formatOmcCliInvocation('autoresearch --mission "<mission>" --eval "<evaluator>" [--keep-policy <policy>] [--slug <slug>]')}\``,
        '- Do **not** hand off to `omc-plan`, `autopilot`, `ralph`, or `team` in this mode.',
    ];
    if (missionSeed) {
        lines.push('', `Mission seed from invocation: \`${missionSeed}\``);
    }
    return lines.join('\n');
}
/**
 * Format command template with metadata header
 */
function formatCommandTemplate(cmd, args) {
    const sections = [];
    const isDeepInterviewAutoresearch = cmd.scope === 'skill'
        && cmd.metadata.name.toLowerCase() === 'deep-interview'
        && hasInvocationFlag(args, '--autoresearch');
    const displayArgs = isDeepInterviewAutoresearch
        ? stripInvocationFlag(args, '--autoresearch')
        : args;
    sections.push(`<command-name>/${cmd.name}</command-name>\n`);
    if (cmd.metadata.description) {
        sections.push(`**Description**: ${cmd.metadata.description}\n`);
    }
    if (displayArgs) {
        sections.push(`**Arguments**: ${displayArgs}\n`);
    }
    if (cmd.metadata.model) {
        sections.push(`**Model**: ${cmd.metadata.model}\n`);
    }
    if (cmd.metadata.agent) {
        sections.push(`**Agent**: ${cmd.metadata.agent}\n`);
    }
    sections.push(`**Scope**: ${cmd.scope}\n`);
    if (cmd.metadata.aliasOf) {
        sections.push(`⚠️ **Deprecated Alias**: \`/${cmd.name}\` is deprecated and will be removed in a future release. Use \`/${cmd.metadata.aliasOf}\` instead.\n`);
    }
    sections.push('---\n');
    // Resolve arguments in content, then execute any live-data commands
    const resolvedContent = resolveArguments(cmd.content || '', displayArgs);
    const injectedContent = rewriteOmcCliInvocations(resolveLiveData(resolvedContent));
    const runtimeGuidance = cmd.scope === 'skill' && !isDeepInterviewAutoresearch
        ? renderSkillRuntimeGuidance(cmd.metadata.name)
        : '';
    const pipelineGuidance = cmd.scope === 'skill' && !isDeepInterviewAutoresearch
        ? renderSkillPipelineGuidance(cmd.metadata.name, cmd.metadata.pipeline)
        : '';
    const resourceGuidance = cmd.scope === 'skill' && cmd.path
        ? renderSkillResourcesGuidance(cmd.path)
        : '';
    const invocationGuidance = isDeepInterviewAutoresearch
        ? renderDeepInterviewAutoresearchGuidance(args)
        : '';
    sections.push([injectedContent.trim(), invocationGuidance, runtimeGuidance, pipelineGuidance, resourceGuidance]
        .filter((section) => section.trim().length > 0)
        .join('\n\n'));
    if (displayArgs && !cmd.content?.includes('$ARGUMENTS')) {
        sections.push('\n\n---\n');
        sections.push('## User Request\n');
        sections.push(displayArgs);
    }
    return sections.join('\n');
}
/**
 * Execute a slash command and return replacement text
 */
export function executeSlashCommand(parsed) {
    const command = findCommand(parsed.command);
    if (!command) {
        return {
            success: false,
            error: `Command "/${parsed.command}" not found. Available commands are in ${CLAUDE_CONFIG_DIR}/commands/ or .claude/commands/`,
        };
    }
    try {
        const template = formatCommandTemplate(command, parsed.args);
        return {
            success: true,
            replacementText: template,
        };
    }
    catch (err) {
        return {
            success: false,
            error: `Failed to load command "/${parsed.command}": ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
/**
 * List all available commands
 */
export function listAvailableCommands() {
    return listAvailableCommandsWithOptions();
}
export function listAvailableCommandsWithOptions(options) {
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
//# sourceMappingURL=executor.js.map