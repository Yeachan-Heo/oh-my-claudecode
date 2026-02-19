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
import type { BuiltinSkill } from './types.js';

// Get the project root directory (go up from src/features/builtin-skills/)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const SKILLS_DIR = join(PROJECT_ROOT, 'skills');

/**
 * Parse YAML-like frontmatter from markdown file
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

function parseFrontmatterAliases(rawAliases: string | undefined): string[] {
  if (!rawAliases) return [];

  const trimmed = rawAliases.trim();
  if (!trimmed) return [];

  // Supports inline YAML list: aliases: [psm, swarm]
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];

    return inner
      .split(',')
      .map((alias) => stripOptionalQuotes(alias))
      .filter((alias) => alias.length > 0);
  }

  // Fallback single alias value
  const singleAlias = stripOptionalQuotes(trimmed);
  return singleAlias ? [singleAlias] : [];
}

function toSafeSkillName(name: string): string {
  const normalized = name.trim();
  return CC_NATIVE_COMMANDS.has(normalized.toLowerCase())
    ? `omc-${normalized}`
    : normalized;
}

/**
 * Load a single skill from a SKILL.md file
 */
function loadSkillFromFile(skillPath: string, skillName: string): BuiltinSkill[] {
  try {
    const content = readFileSync(skillPath, 'utf-8');
    const { data, body } = parseFrontmatter(content);

    const resolvedName = data.name || skillName;
    const safePrimaryName = toSafeSkillName(resolvedName);
    const safeAliases = Array.from(
      new Set(
        parseFrontmatterAliases(data.aliases)
          .map(alias => toSafeSkillName(alias))
          .filter(alias => alias.length > 0 && alias.toLowerCase() !== safePrimaryName.toLowerCase())
      )
    );

    const allNames = [safePrimaryName, ...safeAliases];
    const skillEntries: BuiltinSkill[] = [];
    const seen = new Set<string>();

    for (const name of allNames) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      skillEntries.push({
        name,
        aliases: name === safePrimaryName ? safeAliases : undefined,
        aliasOf: name === safePrimaryName ? undefined : safePrimaryName,
        description: data.description || '',
        template: body.trim(),
        // Optional fields from frontmatter
        model: data.model,
        agent: data.agent,
        argumentHint: data['argument-hint'],
      });
    }

    return skillEntries;
  } catch {
    return [];
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
function loadSkillsFromDirectory(): BuiltinSkill[] {
  if (!existsSync(SKILLS_DIR)) {
    return [];
  }

  const skills: BuiltinSkill[] = [];
  const seenNames = new Set<string>();

  try {
    const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillPath = join(SKILLS_DIR, entry.name, 'SKILL.md');
      if (existsSync(skillPath)) {
        const skillEntries = loadSkillFromFile(skillPath, entry.name);
        for (const skill of skillEntries) {
          const key = skill.name.toLowerCase();
          if (seenNames.has(key)) continue;
          seenNames.add(key);
          skills.push(skill);
        }
      }
    }
  } catch {
    // Return empty array if directory read fails
    return [];
  }

  return skills;
}

// Cache loaded skills to avoid repeated file reads
let cachedSkills: BuiltinSkill[] | null = null;

/**
 * Get all builtin skills
 *
 * Skills are loaded from bundled SKILL.md files in the skills/ directory.
 * Results are cached after first load.
 */
export function createBuiltinSkills(): BuiltinSkill[] {
  if (cachedSkills === null) {
    cachedSkills = loadSkillsFromDirectory();
  }
  return cachedSkills;
}

/**
 * Get a skill by name
 */
export function getBuiltinSkill(name: string): BuiltinSkill | undefined {
  const skills = createBuiltinSkills();
  return skills.find(s => s.name.toLowerCase() === name.toLowerCase());
}

/**
 * List all builtin skill names
 */
export function listBuiltinSkillNames(): string[] {
  return createBuiltinSkills().map(s => s.name);
}

/**
 * Clear the skills cache (useful for testing)
 */
export function clearSkillsCache(): void {
  cachedSkills = null;
}

/**
 * Get the skills directory path (useful for debugging)
 */
export function getSkillsDir(): string {
  return SKILLS_DIR;
}
