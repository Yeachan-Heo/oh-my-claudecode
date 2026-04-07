/**
 * Wiki Storage
 *
 * File I/O layer for the LLM Wiki knowledge base.
 * All write operations go through a wiki-wide mutex (withWikiLock)
 * to prevent concurrent corruption.
 *
 * Storage layout:
 *   .omc/wiki/
 *   ├── index.md      (auto-maintained catalog)
 *   ├── log.md         (append-only operation chronicle)
 *   ├── page-slug.md   (knowledge pages)
 *   └── ...
 */

import { existsSync, readFileSync, readdirSync, unlinkSync, mkdirSync } from 'fs';
import { join, resolve, sep } from 'path';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { atomicWriteFileSync } from '../../lib/atomic-write.js';
import { lockPathFor, withFileLockSync } from '../../lib/file-lock.js';
import {
  type WikiPage,
  type WikiPageFrontmatter,
  type WikiLogEntry,
  WIKI_SCHEMA_VERSION,
} from './types.js';

// ============================================================================
// Constants
// ============================================================================

const WIKI_DIR = 'wiki';
const INDEX_FILE = 'index.md';
const LOG_FILE = 'log.md';
const ENVIRONMENT_FILE = 'environment.md';
const RESERVED_FILES = new Set([INDEX_FILE, LOG_FILE, ENVIRONMENT_FILE]);

// ============================================================================
// Path helpers
// ============================================================================

/** Get the wiki directory path. */
export function getWikiDir(root: string): string {
  return join(getOmcRoot(root), WIKI_DIR);
}

/** Ensure wiki directory exists and is git-ignored. */
export function ensureWikiDir(root: string): string {
  const wikiDir = getWikiDir(root);
  if (!existsSync(wikiDir)) {
    mkdirSync(wikiDir, { recursive: true });
  }

  // Ensure .omc/.gitignore includes wiki/
  const omcRoot = getOmcRoot(root);
  const gitignorePath = join(omcRoot, '.gitignore');
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    if (!content.includes('wiki/')) {
      atomicWriteFileSync(gitignorePath, content.trimEnd() + '\nwiki/\n');
    }
  } else {
    atomicWriteFileSync(gitignorePath, 'wiki/\n');
  }

  return wikiDir;
}

// ============================================================================
// Mutation Boundary
// ============================================================================

/**
 * Execute a function under the wiki-wide file lock.
 * All write operations MUST go through this boundary.
 *
 * Uses synchronous file lock (withFileLockSync) because wiki operations
 * are called from sync hook contexts (notepad pattern).
 */
export function withWikiLock<T>(root: string, fn: () => T): T {
  const wikiDir = ensureWikiDir(root);
  const lockPath = lockPathFor(join(wikiDir, '.wiki-lock'));
  return withFileLockSync(lockPath, fn, { timeoutMs: 5_000, retryDelayMs: 50 });
}

// ============================================================================
// Frontmatter Parsing
// ============================================================================

/**
 * Parse YAML frontmatter from markdown content.
 * Expects content starting with `---\n...\n---\n`.
 */
export function parseFrontmatter(raw: string): { frontmatter: WikiPageFrontmatter; content: string } | null {
  // Normalize CRLF to LF so files edited on Windows are still parseable
  const normalized = raw.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const yamlBlock = match[1];
  const content = match[2];

  try {
    const fm = parseSimpleYaml(yamlBlock);
    const frontmatter: WikiPageFrontmatter = {
      title: String(fm.title || ''),
      tags: parseYamlArray(fm.tags),
      created: String(fm.created || new Date().toISOString()),
      updated: String(fm.updated || new Date().toISOString()),
      sources: parseYamlArray(fm.sources),
      links: parseYamlArray(fm.links),
      category: (fm.category || 'reference') as WikiPageFrontmatter['category'],
      confidence: (fm.confidence || 'medium') as WikiPageFrontmatter['confidence'],
      schemaVersion: Number(fm.schemaVersion) || WIKI_SCHEMA_VERSION,
    };
    return { frontmatter, content };
  } catch {
    return null;
  }
}

/** Simple YAML parser for frontmatter (key: value pairs, no nesting). */
function parseSimpleYaml(yaml: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of yaml.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // Strip surrounding quotes and unescape
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).replace(/\\(\\|"|n|r)/g, (_, ch) => { if (ch === 'n') return '\n'; if (ch === 'r') return '\r'; return ch; });
    }
    if (key) result[key] = value;
  }
  return result;
}

/** Parse YAML array: [item1, item2] or bare string → string[]. */
function parseYamlArray(value: string | undefined): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map(s => s.trim().replace(/^["']|["']$/g, '').replace(/\\(\\|"|n|r)/g, (_, ch) => { if (ch === 'n') return '\n'; if (ch === 'r') return '\r'; return ch; }))
      .filter(Boolean);
  }
  return trimmed ? [trimmed] : [];
}

/** Escape a string for use inside YAML double quotes. */
function escapeYaml(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

/**
 * Serialize frontmatter + content to markdown string.
 */
export function serializePage(page: WikiPage): string {
  const fm = page.frontmatter;
  const yaml = [
    `title: "${escapeYaml(fm.title)}"`,
    `tags: [${fm.tags.map(t => `"${escapeYaml(t)}"`).join(', ')}]`,
    `created: ${fm.created}`,
    `updated: ${fm.updated}`,
    `sources: [${fm.sources.map(s => `"${escapeYaml(s)}"`).join(', ')}]`,
    `links: [${fm.links.map(l => `"${escapeYaml(l)}"`).join(', ')}]`,
    `category: ${fm.category}`,
    `confidence: ${fm.confidence}`,
    `schemaVersion: ${fm.schemaVersion}`,
  ].join('\n');

  return `---\n${yaml}\n---\n${page.content}`;
}

// ============================================================================
// Path Security
// ============================================================================

/**
 * Validate that a filename is safe (no path traversal).
 * Rejects filenames containing path separators or '..' sequences.
 * Returns the resolved path if safe, null otherwise.
 */
function safeWikiPath(wikiDir: string, filename: string): string | null {
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return null;
  }
  const filePath = join(wikiDir, filename);
  const resolved = resolve(filePath);
  if (!resolved.startsWith(resolve(wikiDir) + sep)) {
    return null;
  }
  return filePath;
}

// ============================================================================
// Read Operations (no lock needed)
// ============================================================================

/** Read a single wiki page by filename. Returns null if not found or unparseable. */
export function readPage(root: string, filename: string): WikiPage | null {
  const wikiDir = getWikiDir(root);
  const filePath = safeWikiPath(wikiDir, filename);
  if (!filePath) return null;

  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = parseFrontmatter(raw);
    if (!parsed) return null;

    return {
      filename,
      frontmatter: parsed.frontmatter,
      content: parsed.content,
    };
  } catch {
    return null;
  }
}

/** List all wiki page filenames (excluding index.md and log.md). */
export function listPages(root: string): string[] {
  const wikiDir = getWikiDir(root);
  if (!existsSync(wikiDir)) return [];

  return readdirSync(wikiDir)
    .filter(f => f.endsWith('.md') && !RESERVED_FILES.has(f))
    .sort();
}

/** Read all wiki pages. */
export function readAllPages(root: string): WikiPage[] {
  return listPages(root)
    .map(f => readPage(root, f))
    .filter((p): p is WikiPage => p !== null);
}

/** Read index.md content. Returns null if not found. */
export function readIndex(root: string): string | null {
  const indexPath = join(getWikiDir(root), INDEX_FILE);
  if (!existsSync(indexPath)) return null;
  return readFileSync(indexPath, 'utf-8');
}

/** Read log.md content. Returns null if not found. */
export function readLog(root: string): string | null {
  const logPath = join(getWikiDir(root), LOG_FILE);
  if (!existsSync(logPath)) return null;
  return readFileSync(logPath, 'utf-8');
}

// ============================================================================
// Write Operations (MUST be called inside withWikiLock)
// ============================================================================

/** Write a wiki page to disk. MUST be called inside withWikiLock. */
export function writePageUnsafe(root: string, page: WikiPage): void {
  if (RESERVED_FILES.has(page.filename)) {
    throw new Error(`Cannot write to reserved wiki file: ${page.filename}`);
  }
  const wikiDir = ensureWikiDir(root);
  const filePath = safeWikiPath(wikiDir, page.filename);
  if (!filePath) throw new Error(`Invalid wiki page filename: ${page.filename}`);
  atomicWriteFileSync(filePath, serializePage(page));
}

/** Delete a wiki page. MUST be called inside withWikiLock. */
export function deletePageUnsafe(root: string, filename: string): boolean {
  const wikiDir = getWikiDir(root);
  const filePath = safeWikiPath(wikiDir, filename);
  if (!filePath) return false;
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

/**
 * Regenerate index.md from all pages. MUST be called inside withWikiLock.
 *
 * Format:
 * # Wiki Index
 * ## Category
 * - [Title](filename) — first line of content
 */
export function updateIndexUnsafe(root: string): void {
  const pages = readAllPages(root);
  const byCategory = new Map<string, WikiPage[]>();

  for (const page of pages) {
    const cat = page.frontmatter.category;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(page);
  }

  const lines: string[] = [
    '# Wiki Index',
    '',
    `> ${pages.length} pages | Last updated: ${new Date().toISOString()}`,
    '',
  ];

  const sortedCategories = [...byCategory.keys()].sort();
  for (const cat of sortedCategories) {
    lines.push(`## ${cat}`);
    lines.push('');
    for (const page of byCategory.get(cat)!) {
      const summary = page.content.split('\n').find(l => l.trim().length > 0)?.trim() || '';
      const truncated = summary.length > 80 ? summary.slice(0, 77) + '...' : summary;
      lines.push(`- [${page.frontmatter.title}](${page.filename}) — ${truncated}`);
    }
    lines.push('');
  }

  const wikiDir = ensureWikiDir(root);
  atomicWriteFileSync(join(wikiDir, INDEX_FILE), lines.join('\n'));
}

/** Append a log entry to log.md. MUST be called inside withWikiLock. */
export function appendLogUnsafe(root: string, entry: WikiLogEntry): void {
  const wikiDir = ensureWikiDir(root);
  const logPath = join(wikiDir, LOG_FILE);

  const logLine = `## [${entry.timestamp}] ${entry.operation}\n` +
    `- **Pages:** ${entry.pagesAffected.join(', ') || 'none'}\n` +
    `- **Summary:** ${entry.summary}\n\n`;

  let existing = '';
  if (existsSync(logPath)) {
    existing = readFileSync(logPath, 'utf-8');
  } else {
    existing = '# Wiki Log\n\n';
  }

  atomicWriteFileSync(logPath, existing + logLine);
}

// ============================================================================
// Safe Write Operations (acquire lock internally)
// ============================================================================

/** Write a page with automatic locking and index/log update. */
export function writePage(root: string, page: WikiPage): void {
  withWikiLock(root, () => {
    writePageUnsafe(root, page);
    updateIndexUnsafe(root);
  });
}

/** Delete a page with automatic locking and index update. */
export function deletePage(root: string, filename: string): boolean {
  return withWikiLock(root, () => {
    const result = deletePageUnsafe(root, filename);
    if (result) {
      updateIndexUnsafe(root);
    }
    return result;
  });
}

/** Append a log entry with automatic locking. */
export function appendLog(root: string, entry: WikiLogEntry): void {
  withWikiLock(root, () => {
    appendLogUnsafe(root, entry);
  });
}

// ============================================================================
// Slug Utilities
// ============================================================================

/** Convert a title to a filename slug. */
export function titleToSlug(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);

  if (!base) {
    // Non-ASCII-only titles (CJK, Cyrillic, etc.) produce an empty base.
    // Generate a deterministic hash-based fallback to avoid all such titles
    // colliding on the same ".md" hidden dotfile.
    let hash = 0;
    for (let i = 0; i < title.length; i++) {
      hash = ((hash << 5) - hash + title.charCodeAt(i)) | 0;
    }
    return `page-${Math.abs(hash).toString(16).padStart(8, '0')}.md`;
  }

  return `${base}.md`;
}
