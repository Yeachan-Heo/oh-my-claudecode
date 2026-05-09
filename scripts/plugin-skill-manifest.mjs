#!/usr/bin/env node

/**
 * Plugin Skill Manifest (SessionStart)
 *
 * Scans all installed plugin SKILL.md files and injects a compact tagged
 * manifest into session context. Reduces token overhead from the flat skill
 * name list injected by Claude Code's plugin system, and makes `find-skills`
 * more effective by surfacing tags and one-line descriptions up front.
 *
 * Output format: Markdown table — name | tags | description (one line each)
 * Injected once per session via hookSpecificOutput.additionalContext.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { getClaudeConfigDir } from './lib/config-dir.mjs';
import { readStdin } from './lib/stdin.mjs';

const cfgDir = getClaudeConfigDir();
const MARKETPLACES_DIR = join(cfgDir, 'plugins', 'marketplaces');

/** Max total chars for the manifest block to avoid over-consuming context. */
const MAX_MANIFEST_CHARS = 4000;

/**
 * Parse name, description, and tags from YAML frontmatter in a SKILL.md file.
 * Returns null if frontmatter is absent or name is missing.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const yaml = match[1];

  const nameMatch = yaml.match(/^name:\s*["']?([^"'\n]+)["']?/m);
  if (!nameMatch) return null;

  const descMatch = yaml.match(/^description:\s*["']?([^"'\n]+)["']?/m);

  // Tags: inline [a, b] or block list
  let tags = [];
  const inlineTags = yaml.match(/^tags:\s*\[([^\]]+)\]/m);
  if (inlineTags) {
    tags = inlineTags[1]
      .split(',')
      .map(t => t.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  } else {
    const blockTags = yaml.match(/^tags:\s*\n((?:[ \t]+-[ \t]*.+\n?)*)/m);
    if (blockTags) {
      tags = blockTags[1]
        .split('\n')
        .map(l => l.match(/^[ \t]+-[ \t]*["']?([^"'\n]+)["']?/))
        .filter(Boolean)
        .map(m => m[1].trim());
    }
  }

  return {
    name: nameMatch[1].trim(),
    description: descMatch ? descMatch[1].trim() : '',
    tags,
  };
}

/**
 * Find all SKILL.md files under a directory, up to maxDepth levels deep.
 */
function findSkillFiles(dir, maxDepth = 4, depth = 0) {
  if (depth > maxDepth || !existsSync(dir)) return [];

  const results = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findSkillFiles(fullPath, maxDepth, depth + 1));
      } else if (entry.name === 'SKILL.md') {
        results.push(fullPath);
      }
    }
  } catch { /* ignore permission/IO errors */ }

  return results;
}

/**
 * Truncate description to first sentence, capped at maxLen characters.
 */
function summarize(description, maxLen = 80) {
  if (!description) return '';
  const sentence = description.split(/[.!?]/)[0].trim();
  if (sentence.length <= maxLen) return sentence;
  return `${sentence.slice(0, maxLen - 1)}…`;
}

/**
 * Scan all installed plugin marketplaces and build a compact manifest table.
 * Returns null if no skills found or marketplaces directory is absent.
 */
function buildManifest() {
  if (!existsSync(MARKETPLACES_DIR)) return null;

  const entries = [];

  try {
    for (const marketplace of readdirSync(MARKETPLACES_DIR, { withFileTypes: true })) {
      if (!marketplace.isDirectory() || marketplace.name.startsWith('.')) continue;
      const marketplaceDir = join(MARKETPLACES_DIR, marketplace.name);

      for (const skillFile of findSkillFiles(marketplaceDir)) {
        try {
          const content = readFileSync(skillFile, 'utf-8');
          const meta = parseFrontmatter(content);
          if (!meta) continue;
          entries.push({
            name: meta.name,
            tags: meta.tags.length > 0 ? meta.tags.join(', ') : '—',
            summary: summarize(meta.description),
          });
        } catch { /* ignore unreadable files */ }
      }
    }
  } catch { /* ignore marketplace scan errors */ }

  if (entries.length === 0) return null;

  entries.sort((a, b) => a.name.localeCompare(b.name));

  const header = [
    '<plugin-skill-manifest>',
    '',
    `## Installed Plugin Skills — compact manifest (${entries.length} skills)`,
    '',
    'Use the `find-skills` skill to filter by keyword or tag. Invoke any skill with the `Skill` tool.',
    '',
    '| skill | tags | description |',
    '|-------|------|-------------|',
  ];

  const footer = ['', '</plugin-skill-manifest>'];
  const headerStr = header.join('\n');
  const footerStr = footer.join('\n');
  const budget = MAX_MANIFEST_CHARS - headerStr.length - footerStr.length;

  const rows = [];
  let used = 0;

  for (const { name, tags, summary } of entries) {
    const row = `| \`${name}\` | ${tags} | ${summary} |`;
    if (used + row.length + 1 > budget) {
      rows.push('| … | … | Additional skills omitted — use `find-skills` to discover all |');
      break;
    }
    rows.push(row);
    used += row.length + 1;
  }

  return [...header, ...rows, ...footer].join('\n');
}

async function main() {
  try {
    await readStdin(); // consume stdin even if unused

    const manifest = buildManifest();

    if (manifest) {
      console.log(JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: manifest,
        },
      }));
    } else {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    }
  } catch {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

main();
