/**
 * Builtin Skills Definitions
 *
 * Loads skills from bundled SKILL.md files in the skills directory.
 * This provides a single source of truth for skill definitions.
 *
 * Skills are loaded from project_root/skills/SKILLNAME/SKILL.md
 *
 * Adapted from oh-my-opencode's builtin-skills feature.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
// Get the project root directory (go up from src/features/builtin-skills/)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const SKILLS_DIR = join(PROJECT_ROOT, 'skills');
/**
 * Parse YAML-like frontmatter from markdown file
 */
function parseFrontmatter(content) {
    const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
    const match = content.match(frontmatterRegex);
    if (!match) {
        return { data: {}, body: content };
    }
    const [, yamlContent, body] = match;
    const data = {};
    for (const line of yamlContent.split('\n')) {
        const colonIndex = line.indexOf(':');
        if (colonIndex === -1)
            continue;
        const key = line.slice(0, colonIndex).trim();
        let value = line.slice(colonIndex + 1).trim();
        // Remove surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        data[key] = value;
    }
    return { data, body };
}
/**
 * Load a single skill from a SKILL.md file
 */
function loadSkillFromFile(skillPath, skillName) {
    try {
        const content = readFileSync(skillPath, 'utf-8');
        const { data, body } = parseFrontmatter(content);
        const resolvedName = data.name || skillName;
        // Prefix skills whose short name would shadow a CC native command
        const safeName = CC_NATIVE_COMMANDS.has(resolvedName.toLowerCase())
            ? `omc-${resolvedName}`
            : resolvedName;
        return {
            name: safeName,
            description: data.description || '',
            template: body.trim(),
            // Optional fields from frontmatter
            model: data.model,
            agent: data.agent,
            argumentHint: data['argument-hint'],
        };
    }
    catch {
        return null;
    }
}
/**
 * Claude Code native commands that must not be shadowed by OMC skill short names.
 * Skills with these names will still load but their name will be prefixed with 'omc-'
 * to avoid overriding built-in /review, /plan, /security-review etc.
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
    'memory',
]);
/**
 * Load all skills from the skills/ directory
 */
function loadSkillsFromDirectory() {
    if (!existsSync(SKILLS_DIR)) {
        return [];
    }
    const skills = [];
    try {
        const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const skillPath = join(SKILLS_DIR, entry.name, 'SKILL.md');
            if (existsSync(skillPath)) {
                const skill = loadSkillFromFile(skillPath, entry.name);
                if (skill) {
                    skills.push(skill);
                }
            }
        }
    }
    catch {
        // Return empty array if directory read fails
        return [];
    }
    return skills;
}
// Cache loaded skills to avoid repeated file reads
let cachedSkills = null;
/**
 * Get all builtin skills
 *
 * Skills are loaded from bundled SKILL.md files in the skills/ directory.
 * Results are cached after first load.
 */
export function createBuiltinSkills() {
    if (cachedSkills === null) {
        cachedSkills = loadSkillsFromDirectory();
    }
    return cachedSkills;
}
/**
 * Get a skill by name
 */
export function getBuiltinSkill(name) {
    const skills = createBuiltinSkills();
    return skills.find(s => s.name.toLowerCase() === name.toLowerCase());
}
/**
 * List all builtin skill names
 */
export function listBuiltinSkillNames() {
    return createBuiltinSkills().map(s => s.name);
}
/**
 * Clear the skills cache (useful for testing)
 */
export function clearSkillsCache() {
    cachedSkills = null;
}
/**
 * Get the skills directory path (useful for debugging)
 */
export function getSkillsDir() {
    return SKILLS_DIR;
}
//# sourceMappingURL=skills.js.map