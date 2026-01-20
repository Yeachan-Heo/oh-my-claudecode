/**
 * Skill Parser
 *
 * Parses YAML frontmatter from skill files.
 */

import type { SkillMetadata } from './types.js';

export interface SkillParseResult {
  metadata: Partial<SkillMetadata>;
  content: string;
  valid: boolean;
  errors: string[];
}

/**
 * Parse skill file frontmatter and content.
 */
export function parseSkillFile(rawContent: string): SkillParseResult {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
  const match = rawContent.match(frontmatterRegex);

  if (!match) {
    return {
      metadata: {},
      content: rawContent,
      valid: false,
      errors: ['Missing YAML frontmatter'],
    };
  }

  const yamlContent = match[1];
  const content = match[2].trim();
  const errors: string[] = [];

  try {
    const metadata = parseYamlMetadata(yamlContent);

    // Validate required fields
    if (!metadata.id) errors.push('Missing required field: id');
    if (!metadata.name) errors.push('Missing required field: name');
    if (!metadata.description) errors.push('Missing required field: description');
    if (!metadata.triggers || metadata.triggers.length === 0) {
      errors.push('Missing required field: triggers');
    }
    if (!metadata.source) errors.push('Missing required field: source');

    return {
      metadata,
      content,
      valid: errors.length === 0,
      errors,
    };
  } catch (e) {
    return {
      metadata: {},
      content: rawContent,
      valid: false,
      errors: [`YAML parse error: ${e}`],
    };
  }
}

/**
 * Parse YAML metadata without external library.
 */
function parseYamlMetadata(yamlContent: string): Partial<SkillMetadata> {
  const lines = yamlContent.split('\n');
  const metadata: Partial<SkillMetadata> = {};

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const colonIndex = line.indexOf(':');

    if (colonIndex === -1) {
      i++;
      continue;
    }

    const key = line.slice(0, colonIndex).trim();
    const rawValue = line.slice(colonIndex + 1).trim();

    switch (key) {
      case 'id':
        metadata.id = parseStringValue(rawValue);
        break;
      case 'name':
        metadata.name = parseStringValue(rawValue);
        break;
      case 'description':
        metadata.description = parseStringValue(rawValue);
        break;
      case 'source':
        metadata.source = parseStringValue(rawValue) as 'extracted' | 'promoted' | 'manual';
        break;
      case 'createdAt':
        metadata.createdAt = parseStringValue(rawValue);
        break;
      case 'sessionId':
        metadata.sessionId = parseStringValue(rawValue);
        break;
      case 'quality':
        metadata.quality = parseInt(rawValue, 10) || undefined;
        break;
      case 'usageCount':
        metadata.usageCount = parseInt(rawValue, 10) || 0;
        break;
      case 'triggers':
      case 'tags': {
        const { value, consumed } = parseArrayValue(rawValue, lines, i);
        if (key === 'triggers') {
          metadata.triggers = Array.isArray(value) ? value : [value];
        } else {
          metadata.tags = Array.isArray(value) ? value : [value];
        }
        i += consumed - 1;
        break;
      }
    }

    i++;
  }

  return metadata;
}

function parseStringValue(value: string): string {
  if (!value) return '';
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseArrayValue(
  rawValue: string,
  lines: string[],
  currentIndex: number
): { value: string | string[]; consumed: number } {
  // Inline array: ["a", "b"]
  if (rawValue.startsWith('[')) {
    const content = rawValue.slice(1, rawValue.lastIndexOf(']')).trim();
    if (!content) return { value: [], consumed: 1 };

    const items = content.split(',').map(s => parseStringValue(s.trim())).filter(Boolean);
    return { value: items, consumed: 1 };
  }

  // Multi-line array
  if (!rawValue || rawValue === '') {
    const items: string[] = [];
    let consumed = 1;

    for (let j = currentIndex + 1; j < lines.length; j++) {
      const nextLine = lines[j];
      const arrayMatch = nextLine.match(/^\s+-\s*(.*)$/);

      if (arrayMatch) {
        const itemValue = parseStringValue(arrayMatch[1].trim());
        if (itemValue) items.push(itemValue);
        consumed++;
      } else if (nextLine.trim() === '') {
        consumed++;
      } else {
        break;
      }
    }

    if (items.length > 0) {
      return { value: items, consumed };
    }
  }

  // Single value
  return { value: parseStringValue(rawValue), consumed: 1 };
}

/**
 * Generate YAML frontmatter for a skill.
 */
export function generateSkillFrontmatter(metadata: SkillMetadata): string {
  const lines = [
    '---',
    `id: "${metadata.id}"`,
    `name: "${metadata.name}"`,
    `description: "${metadata.description}"`,
    `source: ${metadata.source}`,
    `createdAt: "${metadata.createdAt}"`,
  ];

  if (metadata.sessionId) {
    lines.push(`sessionId: "${metadata.sessionId}"`);
  }

  if (metadata.quality !== undefined) {
    lines.push(`quality: ${metadata.quality}`);
  }

  if (metadata.usageCount !== undefined) {
    lines.push(`usageCount: ${metadata.usageCount}`);
  }

  lines.push('triggers:');
  for (const trigger of metadata.triggers) {
    lines.push(`  - "${trigger}"`);
  }

  if (metadata.tags && metadata.tags.length > 0) {
    lines.push('tags:');
    for (const tag of metadata.tags) {
      lines.push(`  - "${tag}"`);
    }
  }

  lines.push('---');
  return lines.join('\n');
}
