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
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import type { BuiltinSkill } from './types.js';
import { parseFrontmatter, parseFrontmatterAliases } from '../../utils/frontmatter.js';
import { rewriteOmcCliInvocations } from '../../utils/omc-cli-rendering.js';
import { parseSkillPipelineMetadata, renderSkillPipelineGuidance } from '../../utils/skill-pipeline.js';
import { renderSkillResourcesGuidance } from '../../utils/skill-resources.js';
import { renderSkillRuntimeGuidance } from './runtime-guidance.js';

function getPackageDir(): string {
  // Strategy 1: Walk up from the current file to find the package root.
  // Works for both src/ and dist/ layouts, and handles npm global installs,
  // symlinks, and pnpm node_modules structures.
  try {
    const currentUrl = import.meta.url;
    const currentPath = currentUrl.startsWith('file://')
      ? fileURLToPath(currentUrl)
      : currentUrl;
    // currentPath is: <root>/[src|dist]/features/builtin-skills/skills.ts
    const thisDir = dirname(currentPath);
    // Walk up: builtin-skills -> features -> [src|dist] -> root
    const root = dirname(dirname(dirname(thisDir)));

    // Verify the root looks correct by checking for known markers
    if (existsSync(join(root, 'skills')) || existsSync(join(root, 'package.json'))) {
      return root;
    }
  } catch {
    // Fall through
  }

  // Strategy 2: Legacy __dirname check for CJS compatibility
  if (typeof __dirname !== 'undefined' && __dirname) {
    const currentDirName = basename(__dirname);
    const parentDirName = basename(dirname(__dirname));

    if (currentDirName === 'bridge') {
      return join(__dirname, '..');
    }

    if (currentDirName === 'builtin-skills' && parentDirName === 'features') {
      return join(__dirname, '..', '..', '..');
    }
  }

  // Strategy 3: Last resort — use cwd (will likely fail to find skills)
  return process.cwd();
}

const SKILLS_DIR = join(getPackageDir(), 'skills');

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
  'compact',
  'memory',
]);

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
    const { metadata, body } = parseFrontmatter(content);
    const resolvedName = metadata.name || skillName;
    const safePrimaryName = toSafeSkillName(resolvedName);
    const pipeline = parseSkillPipelineMetadata(metadata);
    const renderedBody = rewriteOmcCliInvocations(body.trim());
    const template = [
      renderedBody,
      renderSkillRuntimeGuidance(safePrimaryName),
      renderSkillPipelineGuidance(safePrimaryName, pipeline),
      renderSkillResourcesGuidance(skillPath),
    ].filter((section) => section.trim().length > 0).join('\n\n');

    const safeAliases = Array.from(
      new Set(
        parseFrontmatterAliases(metadata.aliases)
          .map((alias: string) => toSafeSkillName(alias))
          .filter((alias: string) => alias.length > 0 && alias.toLowerCase() !== safePrimaryName.toLowerCase())
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
        deprecatedAlias: name === safePrimaryName ? undefined : true,
        deprecationMessage: name === safePrimaryName
          ? undefined
          : `Skill alias "${name}" is deprecated. Use "${safePrimaryName}" instead.`,
        description: metadata.description || '',
        template,
        // Optional fields from frontmatter
        model: metadata.model,
        agent: metadata.agent,
        argumentHint: metadata['argument-hint'],
        pipeline: name === safePrimaryName ? pipeline : undefined,
      });
    }

    return skillEntries;
  } catch {
    return [];
  }
}

/**
 * Load all skills from the skills/ directory
 */
function loadSkillsFromDirectory(): BuiltinSkill[] {
  if (!existsSync(SKILLS_DIR)) {
    // Log diagnostic info to help debug npm/pnpm install path issues
    console.warn(
      `[omc] Skills directory not found at ${SKILLS_DIR}. ` +
      `Package dir resolved to: ${getPackageDir()}. ` +
      `Skills may not load correctly. Try running 'omc doctor' to diagnose.`
    );
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

export interface ListBuiltinSkillNamesOptions {
  includeAliases?: boolean;
}

/**
 * List all builtin skill names
 */
export function listBuiltinSkillNames(options?: ListBuiltinSkillNamesOptions): string[] {
  const { includeAliases = false } = options ?? {};
  const skills = createBuiltinSkills();
  if (includeAliases) {
    return skills.map((s) => s.name);
  }
  return skills.filter((s) => !s.aliasOf).map((s) => s.name);
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
