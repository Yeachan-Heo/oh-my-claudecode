import { existsSync, readdirSync } from 'fs';
import { dirname, relative } from 'path';

const MAX_RESOURCE_ENTRIES = 12;

function toDisplayPath(pathValue: string): string {
  const relativeToCwd = relative(process.cwd(), pathValue);
  if (
    relativeToCwd &&
    relativeToCwd !== '' &&
    !relativeToCwd.startsWith('..') &&
    relativeToCwd !== '.'
  ) {
    return relativeToCwd;
  }

  return pathValue;
}

export interface SkillResourceSummary {
  skillDirectory: string;
  entries: string[];
}

export function summarizeSkillResources(skillFilePath: string): SkillResourceSummary | undefined {
  const skillDirectory = dirname(skillFilePath);
  if (!existsSync(skillDirectory)) {
    return undefined;
  }

  let directoryEntries: string[] = [];
  try {
    directoryEntries = readdirSync(skillDirectory, { withFileTypes: true })
      .filter((entry) => entry.name !== 'SKILL.md' && !entry.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_RESOURCE_ENTRIES)
      .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name);
  } catch {
    return undefined;
  }

  if (directoryEntries.length === 0) {
    return undefined;
  }

  return {
    skillDirectory: toDisplayPath(skillDirectory),
    entries: directoryEntries,
  };
}

export function renderSkillResourcesGuidance(skillFilePath: string): string {
  const summary = summarizeSkillResources(skillFilePath);
  if (!summary) {
    return '';
  }

  const lines = [
    '## Skill Resources',
    `Skill directory: \`${summary.skillDirectory}\``,
    'Bundled resources:',
    ...summary.entries.map((entry) => `- \`${entry}\``),
    '',
    'Prefer reusing these bundled resources when they fit the task instead of recreating them from scratch.',
  ];

  return lines.join('\n');
}
