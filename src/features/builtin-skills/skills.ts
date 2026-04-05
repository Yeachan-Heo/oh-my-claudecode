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
import { isSkininthegamebrosUser } from '../../utils/skininthegamebros-user.js';
import { getClaudeConfigDir } from '../../utils/config-dir.js';

function getPackageDir(): string {
  if (typeof __dirname !== 'undefined' && __dirname) {
    const currentDirName = basename(__dirname);
    const parentDirName = basename(dirname(__dirname));
    const grandparentDirName = basename(dirname(dirname(__dirname)));

    if (currentDirName === 'bridge') {
      return join(__dirname, '..');
    }

    if (
      currentDirName === 'builtin-skills'
      && parentDirName === 'features'
      && (grandparentDirName === 'src' || grandparentDirName === 'dist')
    ) {
      return join(__dirname, '..', '..', '..');
    }
  }

  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    return join(__dirname, '..', '..', '..');
  } catch {
    return process.cwd();
  }
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

const SKININTHEGAMEBROS_ONLY_SKILLS = new Set([
  'remember',
  'verify',
  'debug',
  'skillify',
]);

const DEFAULT_DEEP_INTERVIEW_AMBIGUITY_THRESHOLD = 0.2;

function toSafeSkillName(name: string): string {
  const normalized = name.trim();
  return CC_NATIVE_COMMANDS.has(normalized.toLowerCase())
    ? `omc-${normalized}`
    : normalized;
}

function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readDeepInterviewThresholdFromSettings(path: string): number | null {
  const settings = readJsonObject(path);
  const omc = settings?.omc;
  if (!omc || typeof omc !== 'object' || Array.isArray(omc)) {
    return null;
  }

  const deepInterview = (omc as Record<string, unknown>).deepInterview;
  if (!deepInterview || typeof deepInterview !== 'object' || Array.isArray(deepInterview)) {
    return null;
  }

  const threshold = (deepInterview as Record<string, unknown>).ambiguityThreshold;
  return typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 0 && threshold <= 1
    ? threshold
    : null;
}

function getDeepInterviewAmbiguityThreshold(): number {
  const profileThreshold = readDeepInterviewThresholdFromSettings(join(getClaudeConfigDir(), 'settings.json'));
  const projectThreshold = readDeepInterviewThresholdFromSettings(join(process.cwd(), '.claude', 'settings.json'));
  return projectThreshold ?? profileThreshold ?? DEFAULT_DEEP_INTERVIEW_AMBIGUITY_THRESHOLD;
}

function formatThresholdPercent(threshold: number): string {
  return `${(threshold * 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

function applyDeepInterviewRuntimeSettings(template: string): string {
  const threshold = getDeepInterviewAmbiguityThreshold();
  const percent = formatThresholdPercent(threshold);

  return template
    .replace(
      '4. **Initialize state** via `state_write(mode="deep-interview")`:',
      [
        `3.5. **Load runtime settings** from \`~/.claude/settings.json\` and \`./.claude/settings.json\` before state init (project overrides profile). For this run, use \`ambiguityThreshold = ${threshold}\`.`,
        '4. **Initialize state** via `state_write(mode="deep-interview")`:',
      ].join('\n'),
    )
    .replace('"threshold": 0.2,', `"threshold": ${threshold},`)
    .replace(
      'We\'ll proceed to execution once ambiguity drops below 20%.',
      `We'll proceed to execution once ambiguity drops below ${percent}.`,
    );
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
    const renderedBody = safePrimaryName === 'deep-interview'
      ? applyDeepInterviewRuntimeSettings(rewriteOmcCliInvocations(body.trim()))
      : rewriteOmcCliInvocations(body.trim());
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
    return [];
  }

  const skills: BuiltinSkill[] = [];
  const seenNames = new Set<string>();

  try {
    const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKININTHEGAMEBROS_ONLY_SKILLS.has(entry.name) && !isSkininthegamebrosUser()) {
        continue;
      }

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
