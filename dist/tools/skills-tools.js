/**
 * Skills Tools
 *
 * MCP tools for loading and listing OMC learned skills
 * from local (.omc/skills/) and global (~/.omc/skills/) directories.
 */
import { z } from 'zod';
import { resolve, normalize, sep } from 'path';
import { homedir } from 'os';
import { loadAllSkills } from '../hooks/learner/loader.js';
import { MAX_SKILL_CONTENT_LENGTH } from '../hooks/learner/constants.js';
/** Allowed boundary directories for projectRoot validation */
const ALLOWED_BOUNDARIES = [process.cwd(), homedir()];
/** Role boundary tags that could be used for prompt injection */
const ROLE_BOUNDARY_PATTERN = /^<\s*\/?\s*(system|human|assistant|user|tool_use|tool_result)\b[^>]*>/i;
/**
 * Validate projectRoot is within allowed directories.
 * Prevents path traversal attacks.
 */
function validateProjectRoot(input) {
    const normalized = normalize(resolve(input));
    // Reject path traversal sequences in raw input
    if (input.includes('..')) {
        throw new Error('Invalid project root: path traversal not allowed');
    }
    // Positive boundary validation: resolved path must be under cwd or HOME
    const isWithinAllowed = ALLOWED_BOUNDARIES.some(boundary => {
        const normalizedBoundary = normalize(boundary);
        return normalized === normalizedBoundary ||
            normalized.startsWith(normalizedBoundary + sep);
    });
    if (!isWithinAllowed) {
        throw new Error('Invalid project root: path is outside allowed directories');
    }
    return normalized;
}
/**
 * Sanitize skill content to prevent prompt injection.
 */
function sanitizeSkillContent(content) {
    // Truncate to max length
    const truncated = content.length > MAX_SKILL_CONTENT_LENGTH
        ? content.slice(0, MAX_SKILL_CONTENT_LENGTH) + '\n[truncated]'
        : content;
    // Strip role boundary tags
    return truncated
        .split('\n')
        .filter(line => !ROLE_BOUNDARY_PATTERN.test(line.trim()))
        .join('\n');
}
// Schema definitions
const loadLocalSchema = {
    projectRoot: z.string()
        .max(500)
        .optional()
        .describe('Project root directory (defaults to cwd)'),
};
// Empty ZodRawShape: SDK expects plain object of z-types; {} means no parameters
const loadGlobalSchema = {};
const listSkillsSchema = {
    projectRoot: z.string()
        .max(500)
        .optional()
        .describe('Project root directory (defaults to cwd)'),
};
/**
 * Format skills into readable markdown output.
 */
function formatSkillOutput(skills) {
    if (skills.length === 0) {
        return 'No skills found in the searched directories.';
    }
    const lines = [];
    for (const skill of skills) {
        lines.push(`### ${skill.metadata.id}`);
        lines.push(`- **Name:** ${skill.metadata.name}`);
        lines.push(`- **Description:** ${skill.metadata.description}`);
        lines.push(`- **Triggers:** ${skill.metadata.triggers.join(', ')}`);
        if (skill.metadata.tags?.length) {
            lines.push(`- **Tags:** ${skill.metadata.tags.join(', ')}`);
        }
        lines.push(`- **Scope:** ${skill.scope}`);
        lines.push(`- **Path:** ${skill.relativePath}`);
        lines.push('');
    }
    return lines.join('\n');
}
// Tool 1: load_omc_skills_local
export const loadLocalTool = {
    name: 'load_omc_skills_local',
    description: 'Load and list skills from the project-local .omc/skills/ directory. Returns skill metadata (id, name, description, triggers, tags) for all discovered project-scoped skills.',
    schema: loadLocalSchema,
    handler: async (args) => {
        const projectRoot = args.projectRoot ? validateProjectRoot(args.projectRoot) : process.cwd();
        const allSkills = loadAllSkills(projectRoot);
        const projectSkills = allSkills.filter(s => s.scope === 'project');
        return {
            content: [{
                    type: 'text',
                    text: `## Project Skills (${projectSkills.length})\n\n${formatSkillOutput(projectSkills)}`,
                }],
        };
    },
};
// Tool 2: load_omc_skills_global
export const loadGlobalTool = {
    name: 'load_omc_skills_global',
    description: 'Load and list skills from global user directories (~/.omc/skills/ and ~/.claude/skills/omc-learned/). Returns skill metadata for all discovered user-scoped skills.',
    schema: loadGlobalSchema,
    handler: async (_args) => {
        const allSkills = loadAllSkills(null);
        const userSkills = allSkills.filter(s => s.scope === 'user');
        return {
            content: [{
                    type: 'text',
                    text: `## Global User Skills (${userSkills.length})\n\n${formatSkillOutput(userSkills)}`,
                }],
        };
    },
};
// Tool 3: list_omc_skills
export const listSkillsTool = {
    name: 'list_omc_skills',
    description: 'List all available skills (both project-local and global user skills). Project skills take priority over user skills with the same ID.',
    schema: listSkillsSchema,
    handler: async (args) => {
        const projectRoot = args.projectRoot ? validateProjectRoot(args.projectRoot) : process.cwd();
        const skills = loadAllSkills(projectRoot);
        const projectSkills = skills.filter(s => s.scope === 'project');
        const userSkills = skills.filter(s => s.scope === 'user');
        let output = `## All Available Skills (${skills.length} total)\n\n`;
        if (projectSkills.length > 0) {
            output += `### Project Skills (${projectSkills.length})\n\n${formatSkillOutput(projectSkills)}\n`;
        }
        if (userSkills.length > 0) {
            output += `### User Skills (${userSkills.length})\n\n${formatSkillOutput(userSkills)}`;
        }
        if (skills.length === 0) {
            output = '## No Skills Found\n\nNo skill files were discovered in any searched directories.\n\nSearched:\n- Project: .omc/skills/\n- Global: ~/.omc/skills/\n- Legacy: ~/.claude/skills/omc-learned/';
        }
        return {
            content: [{
                    type: 'text',
                    text: output,
                }],
        };
    },
};
/** All skills tools for registration in omc-tools-server */
export const skillsTools = [loadLocalTool, loadGlobalTool, listSkillsTool];
//# sourceMappingURL=skills-tools.js.map