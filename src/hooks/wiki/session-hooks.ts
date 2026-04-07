/**
 * Wiki Session Hooks
 *
 * SessionStart: load wiki context, inject relevant pages, lazy index rebuild,
 *   feed project-memory into wiki environment.md
 * SessionEnd: bounded append-only capture of session metadata
 * PreCompact: inject wiki summary for compaction survival
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { getClaudeConfigDir } from '../../utils/config-dir.js';
import {
  getWikiDir,
  readIndex,
  readPage,
  readAllPages,
  listPages,
  withWikiLock,
  writePageUnsafe,
  updateIndexUnsafe,
  appendLogUnsafe,
} from './storage.js';
import { WIKI_SCHEMA_VERSION, DEFAULT_WIKI_CONFIG } from './types.js';
import type { WikiConfig } from './types.js';

/**
 * Load wiki config from .omc-config.json.
 * Returns defaults if config doesn't exist or wiki section is missing.
 */
function loadWikiConfig(root: string): WikiConfig {
  try {
    const configPath = join(getOmcRoot(root), '.omc-config.json');
    // Try active Claude config too
    const activeConfigPath = join(getClaudeConfigDir(), '.omc-config.json');

    for (const path of [configPath, activeConfigPath]) {
      if (existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        if (raw?.wiki) {
          return { ...DEFAULT_WIKI_CONFIG, ...raw.wiki };
        }
      }
    }
  } catch {
    // Ignore config errors, use defaults
  }
  return DEFAULT_WIKI_CONFIG;
}

/**
 * SessionStart hook: inject wiki context into session.
 *
 * 1. Read wiki index, rebuild if stale
 * 2. Feed project-memory into environment.md if newer
 * 3. Return context summary for injection
 */
export function onSessionStart(data: { cwd?: string }): { additionalContext?: string } {
  try {
    const root = data.cwd || process.cwd();
    const wikiDir = getWikiDir(root);

    if (!existsSync(wikiDir)) {
      return {}; // No wiki yet, nothing to inject
    }

    // Lazy index rebuild
    const pages = listPages(root);
    if (pages.length > 0) {
      const indexContent = readIndex(root);
      if (!indexContent) {
        // Index missing — rebuild
        withWikiLock(root, () => { updateIndexUnsafe(root); });
      }
    }

    // Feed project-memory into wiki
    feedProjectMemory(root);

    // Build context summary
    const index = readIndex(root);
    if (!index || pages.length === 0) return {};

    const summary = [
      `[LLM Wiki: ${pages.length} pages at .omc/wiki/]`,
      '',
      'Use wiki_query to search, wiki_list to browse, wiki_read to view pages.',
      '',
      index.split('\n').slice(0, 30).join('\n'), // First 30 lines of index
    ].join('\n');

    return { additionalContext: summary };
  } catch {
    return {};
  }
}

/**
 * SessionEnd hook: bounded append-only capture of session metadata.
 *
 * Captures raw session data as a session-log page.
 * Does NOT do LLM-judged curation — that happens via skill on next session.
 * Hard timeout: 3s via Promise.race pattern (sync version uses try/catch + time check).
 */
export function onSessionEnd(data: { cwd?: string; session_id?: string }): { continue: boolean } {
  const startTime = Date.now();
  const TIMEOUT_MS = 3_000;

  try {
    const root = data.cwd || process.cwd();
    const config = loadWikiConfig(root);

    if (!config.autoCapture) {
      return { continue: true };
    }

    const wikiDir = getWikiDir(root);
    if (!existsSync(wikiDir)) {
      // Don't create wiki dir just for session logging
      return { continue: true };
    }

    const sessionId = data.session_id || `session-${Date.now()}`;
    const now = new Date().toISOString();
    const dateSlug = now.split('T')[0]; // YYYY-MM-DD
    const filename = `session-log-${dateSlug}-${sessionId.slice(-8)}.md`;

    withWikiLock(root, () => {
      // Time check inside lock
      if (Date.now() - startTime > TIMEOUT_MS) return;

      writePageUnsafe(root, {
        filename,
        frontmatter: {
          title: `Session Log ${dateSlug}`,
          tags: ['session-log', 'auto-captured'],
          created: now,
          updated: now,
          sources: [sessionId],
          links: [],
          category: 'session-log',
          confidence: 'medium',
          schemaVersion: WIKI_SCHEMA_VERSION,
        },
        content: `\n# Session Log ${dateSlug}\n\nAuto-captured session metadata.\nSession ID: ${sessionId}\n\nReview and promote significant findings to curated wiki pages via \`wiki_ingest\`.\n`,
      });

      appendLogUnsafe(root, {
        timestamp: now,
        operation: 'ingest',
        pagesAffected: [filename],
        summary: `Auto-captured session log for ${sessionId}`,
      });

      // Do NOT rebuild index here — keep SessionEnd fast
    });
  } catch {
    // Silently fail — session end should never block
  }

  return { continue: true };
}

/**
 * PreCompact hook: inject wiki summary for compaction survival.
 */
export function onPreCompact(data: { cwd?: string }): { additionalContext?: string } {
  try {
    const root = data.cwd || process.cwd();
    const pages = listPages(root);

    if (pages.length === 0) return {};

    const allPages = readAllPages(root);
    const categories = [...new Set(allPages.map(p => p.frontmatter.category))];
    const latestUpdate = allPages
      .map(p => p.frontmatter.updated)
      .sort()
      .reverse()[0] || 'unknown';

    return {
      additionalContext: `[Wiki: ${pages.length} pages | categories: ${categories.join(', ')} | last updated: ${latestUpdate}]`,
    };
  } catch {
    return {};
  }
}

/**
 * Feed project-memory auto-detected facts into wiki environment.md.
 * Only updates if project-memory is newer than existing environment.md.
 */
function feedProjectMemory(root: string): void {
  try {
    const pmPath = join(getOmcRoot(root), 'project-memory.json');
    if (!existsSync(pmPath)) return;

    const pm = JSON.parse(readFileSync(pmPath, 'utf-8'));
    if (!pm.lastScanned) return;

    const envSlug = 'environment.md';
    const existing = readPage(root, envSlug);

    // Skip if environment.md exists and is newer than project-memory
    if (existing) {
      const existingTime = new Date(existing.frontmatter.updated).getTime();
      const pmTime = new Date(pm.lastScanned).getTime();
      if (existingTime >= pmTime) return;
    }

    // Build environment content from project-memory
    const lines: string[] = ['\n# Project Environment\n'];

    if (pm.techStack) {
      const ts = pm.techStack;
      if (ts.languages?.length) lines.push(`**Languages:** ${ts.languages.join(', ')}`);
      if (ts.frameworks?.length) lines.push(`**Frameworks:** ${ts.frameworks.join(', ')}`);
      if (ts.packageManager) lines.push(`**Package Manager:** ${ts.packageManager}`);
      if (ts.runtime) lines.push(`**Runtime:** ${ts.runtime}`);
      lines.push('');
    }

    if (pm.build) {
      lines.push('## Build Commands');
      for (const [key, val] of Object.entries(pm.build)) {
        if (val) lines.push(`- **${key}:** \`${val}\``);
      }
      lines.push('');
    }

    const now = new Date().toISOString();

    withWikiLock(root, () => {
      writePageUnsafe(root, {
        filename: envSlug,
        frontmatter: {
          title: 'Project Environment',
          tags: ['environment', 'auto-detected'],
          created: existing?.frontmatter.created || now,
          updated: now,
          sources: ['project-memory-auto-detect'],
          links: [],
          category: 'environment',
          confidence: 'high',
          schemaVersion: WIKI_SCHEMA_VERSION,
        },
        content: lines.join('\n'),
      });
      updateIndexUnsafe(root);
    });
  } catch {
    // Silently fail — project-memory feeding is best-effort
  }
}
