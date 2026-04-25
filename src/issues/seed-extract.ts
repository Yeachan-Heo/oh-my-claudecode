import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { basename, dirname, join, posix, relative, sep } from 'node:path';
import {
  IssueDraft,
  computeContentHash,
  renderDraftToMarkdown,
  writeDraftFile,
  appendManifestEntry,
  ManifestEntry,
} from './draft-writer.js';

export interface Section {
  level: number;
  heading: string;
  body: string;
  startLine: number;
  endLine: number;
}

export interface ExtractOptions {
  rootDir: string;
  outputDir: string;
  manifestPath: string;
  milestone?: string;
  alsoMarkReady?: boolean;
  maxIssues?: number;
  excludedFiles?: string[];
}

export interface ExtractResult {
  drafts: IssueDraft[];
  manifestEntries: ManifestEntry[];
  skipped: string[];
}

const STRUCTURAL_HEADINGS = [
  'overview',
  'background',
  'introduction',
  'table of contents',
  'toc',
  'contents',
  'changelog',
  'license',
  'glossary',
  'references',
  'appendix',
];

const ROADMAP_KEYWORDS = ['todo', 'roadmap', 'planned', 'upcoming'];

const ACCEPTANCE_KEYWORDS = [
  'must',
  'should',
  'shall',
  'can ',
  'allow',
  'support',
  'enable',
  'provide',
];

export const DEFAULT_EXCLUDED_FILES = [
  'docs/PRODUCT-PRINCIPLES.md',
];

export function shouldSkipHeading(heading: string): boolean {
  const lower = heading.toLowerCase().trim();
  return STRUCTURAL_HEADINGS.some((s) => lower === s || lower.startsWith(`${s}:`));
}

export function parseMarkdownHeadings(content: string): Section[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const sections: Section[] = [];
  let current: Section | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^(#{2,3})\s+(.*?)\s*$/.exec(line);
    if (m) {
      if (current) {
        current.endLine = i;
        sections.push(current);
      }
      current = {
        level: m[1].length,
        heading: m[2].trim(),
        body: '',
        startLine: i + 1,
        endLine: lines.length,
      };
    } else if (current) {
      current.body += (current.body ? '\n' : '') + line;
    }
  }
  if (current) {
    current.endLine = lines.length;
    sections.push(current);
  }
  return sections;
}

export function slugifyTitle(prefix: string, heading: string, maxLen = 80): string {
  const headingClean = heading.replace(/\s+/g, ' ').trim();
  const full = `${prefix} ${headingClean}`;
  if (full.length <= maxLen) return full;
  const room = maxLen - prefix.length - 1 - 3;
  return `${prefix} ${headingClean.slice(0, Math.max(0, room))}...`;
}

function extractAcceptanceCriteria(body: string): string[] {
  const lines = body.split('\n');
  const criteria: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    const numbered = /^\d+\.\s+(.+)$/.exec(line);
    const text = bullet?.[1] ?? numbered?.[1] ?? null;
    if (!text) continue;
    const lower = text.toLowerCase();
    if (ACCEPTANCE_KEYWORDS.some((kw) => lower.includes(kw))) {
      criteria.push(text.trim());
    }
  }
  return criteria;
}

function summarize(body: string, maxChars = 600): string {
  const trimmed = body.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).replace(/\s+\S*$/, '')}...`;
}

function deriveAreaSlug(sourceFile: string): { areaPrefix: string; areaLabel: string } {
  const norm = sourceFile.replace(/\\/g, '/');
  if (/BASES-PRD\.md$/i.test(norm)) {
    return { areaPrefix: 'area:bases', areaLabel: 'area:bases' };
  }
  const mockup = /docs\/mock-ups\/([^/]+)\//i.exec(norm) || /docs\/mock-ups\/([^/]+)$/i.exec(norm);
  if (mockup) {
    return { areaPrefix: `area:ui/${mockup[1]}`, areaLabel: 'area:ui' };
  }
  if (/(^|\/)README\.md$/i.test(norm)) {
    return { areaPrefix: 'area:docs', areaLabel: 'area:docs' };
  }
  return { areaPrefix: 'area:general', areaLabel: 'area:general' };
}

function buildBody(opts: {
  summary: string;
  criteria: string[];
  sourceFile: string;
  sourceHeading: string;
  startLine: number;
  endLine: number;
}): string {
  const criteriaSection = opts.criteria.length > 0
    ? opts.criteria.map((c) => `- [ ] ${c}`).join('\n')
    : '- [ ] (To be refined during planning)';
  return [
    '## Summary',
    '',
    opts.summary,
    '',
    '## Acceptance Criteria',
    '',
    criteriaSection,
    '',
    '## Source',
    '',
    `- **Document:** \`${opts.sourceFile}\``,
    `- **Section:** \`${opts.sourceHeading}\``,
    `- **Line range:** L${opts.startLine}-L${opts.endLine}`,
    '',
    '---',
    '',
    '> This issue was seeded from project documentation by `omc-seed-issues`.',
    '> Label `omc-seeded` indicates OMC created this; add `omc-ready` after review for execution via `/omc-issue <N>`.',
  ].join('\n');
}

function processFile(
  absPath: string,
  rootDir: string,
  options: { milestone?: string; alsoMarkReady?: boolean },
): IssueDraft[] {
  if (!existsSync(absPath)) return [];
  const content = readFileSync(absPath, 'utf-8');
  const relPath = relative(rootDir, absPath).split(sep).join('/');
  if (DEFAULT_EXCLUDED_FILES.some((p) => relPath === p)) return [];
  const sections = parseMarkdownHeadings(content);
  const normPath = relPath.replace(/\\/g, '/');
  const isMockupReadme = /docs\/mock-ups\/[^/]+\/README\.md$/i.test(normPath);
  const isReadme = /(^|\/)README\.md$/i.test(relPath);
  const drafts: IssueDraft[] = [];
  const labelsBase = ['omc-seeded'];
  if (options.alsoMarkReady) labelsBase.push('omc-ready');
  const { areaPrefix, areaLabel } = deriveAreaSlug(relPath);
  const milestone = options.milestone ?? 'OMC Bootstrap';

  if (isMockupReadme) {
    const titleMatch = /^#\s+(.+)$/m.exec(content);
    const heading = titleMatch ? titleMatch[1].trim() : basename(dirname(relPath));
    const summary = summarize(content);
    const criteria = extractAcceptanceCriteria(content);
    const title = slugifyTitle(`[${areaPrefix}]`, heading);
    const body = buildBody({
      summary,
      criteria,
      sourceFile: relPath,
      sourceHeading: heading,
      startLine: 1,
      endLine: content.split('\n').length,
    });
    const hash = computeContentHash(`${heading}\n${content}`);
    const labels = [...labelsBase, areaLabel];
    if (areaPrefix !== areaLabel) labels.push(areaPrefix);
    drafts.push({
      title,
      body,
      labels,
      milestone,
      source: 'docs',
      contentHash: hash,
      frontmatter: {
        title,
        labels,
        milestone,
        source: 'docs',
        source_file: relPath,
        source_heading: heading,
        content_hash: hash,
      },
    });
    return drafts;
  }

  for (const sec of sections) {
    if (shouldSkipHeading(sec.heading)) continue;
    if (isReadme) {
      const lower = sec.heading.toLowerCase();
      if (!ROADMAP_KEYWORDS.some((kw) => lower.includes(kw))) continue;
    }
    const summary = summarize(sec.body);
    if (!summary) continue;
    const criteria = extractAcceptanceCriteria(sec.body);
    const title = slugifyTitle(`[${areaPrefix}]`, sec.heading);
    const body = buildBody({
      summary,
      criteria,
      sourceFile: relPath,
      sourceHeading: sec.heading,
      startLine: sec.startLine,
      endLine: sec.endLine,
    });
    const hash = computeContentHash(`${sec.heading}\n${sec.body}`);
    const labels = [...labelsBase, areaLabel];
    if (areaPrefix !== areaLabel) labels.push(areaPrefix);
    drafts.push({
      title,
      body,
      labels,
      milestone,
      source: 'docs',
      contentHash: hash,
      frontmatter: {
        title,
        labels,
        milestone,
        source: 'docs',
        source_file: relPath,
        source_heading: sec.heading,
        content_hash: hash,
      },
    });
  }
  return drafts;
}

function expandPaths(rootDir: string, inputs: string[]): string[] {
  const out: string[] = [];
  for (const inp of inputs) {
    const abs = join(rootDir, inp);
    if (!existsSync(abs)) continue;
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(abs)) {
        const child = join(abs, entry);
        if (statSync(child).isDirectory()) {
          const readme = join(child, 'README.md');
          if (existsSync(readme)) out.push(readme);
        } else if (entry.toLowerCase().endsWith('.md')) {
          out.push(child);
        }
      }
    } else {
      out.push(abs);
    }
  }
  return out;
}

export function extractIssuesFromDocs(
  docInputs: string[],
  options: ExtractOptions,
): IssueDraft[] {
  const expanded = expandPaths(options.rootDir, docInputs);
  const drafts: IssueDraft[] = [];
  for (const file of expanded) {
    const fileDrafts = processFile(file, options.rootDir, {
      milestone: options.milestone,
      alsoMarkReady: options.alsoMarkReady,
    });
    drafts.push(...fileDrafts);
    if (options.maxIssues && drafts.length >= options.maxIssues) {
      drafts.length = options.maxIssues;
      break;
    }
  }
  return drafts;
}

export function writeDraftsAndManifest(
  drafts: IssueDraft[],
  options: ExtractOptions,
): ExtractResult {
  const manifestEntries: ManifestEntry[] = [];
  drafts.forEach((draft, idx) => {
    const seq = idx + 1;
    const draftPath = writeDraftFile(draft, options.outputDir, seq);
    const relDraftPath = posix.join(
      options.outputDir.replace(/\\/g, '/'),
      `${String(seq).padStart(3, '0')}.md`,
    );
    const entry: ManifestEntry = appendManifestEntry(options.manifestPath, {
      seq,
      title: draft.title,
      draft_path: relDraftPath || draftPath.replace(/\\/g, '/'),
      content_hash: draft.contentHash,
      status: 'draft',
      issue_number: null,
      source: 'docs',
      source_file: draft.frontmatter.source_file as string | undefined,
      source_heading: draft.frontmatter.source_heading as string | undefined,
    });
    manifestEntries.push(entry);
  });
  return { drafts, manifestEntries, skipped: [] };
}

// Render-only helper for tests / dry-run preview.
export function renderDraft(draft: IssueDraft): string {
  return renderDraftToMarkdown(draft);
}

export function basenameOf(p: string): string {
  return basename(p);
}

export function dirnameOf(p: string): string {
  return dirname(p);
}
