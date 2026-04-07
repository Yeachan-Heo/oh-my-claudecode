/**
 * Wiki Module — Public API
 *
 * LLM Wiki: persistent, self-maintained markdown knowledge base
 * that compounds project and session knowledge across sessions.
 */

// Types
export type {
  WikiPage,
  WikiPageFrontmatter,
  WikiLogEntry,
  WikiIngestInput,
  WikiIngestResult,
  WikiQueryOptions,
  WikiQueryMatch,
  WikiLintIssue,
  WikiLintReport,
  WikiCategory,
  WikiConfig,
  WikiScope,
} from './types.js';

export {
  WIKI_SCHEMA_VERSION,
  DEFAULT_WIKI_CONFIG,
  CATEGORY_DEFAULT_TTL,
  COMPACTION_THRESHOLD,
  COMPACTION_KEEP_RECENT,
  GLOBAL_SCOPE_CATEGORIES,
} from './types.js';

// Storage
export {
  getWikiDir,
  getGlobalWikiDir,
  ensureWikiDir,
  ensureGlobalWikiDir,
  withWikiLock,
  readPage,
  listPages,
  readAllPages,
  readAllGlobalPages,
  readIndex,
  readLog,
  writePage,
  deletePage,
  writeGlobalPage,
  deleteGlobalPage,
  appendLog,
  titleToSlug,
  parseFrontmatter,
  serializePage,
  // TTL & GC
  isPageExpired,
  cleanupExpiredPages,
  // Compaction
  countAppendSections,
  compactPage,
  compactAllPages,
  // Unsafe variants (for use inside withWikiLock)
  writePageUnsafe,
  deletePageUnsafe,
  updateIndexUnsafe,
  appendLogUnsafe,
} from './storage.js';

// Operations
export { ingestKnowledge } from './ingest.js';
export { queryWiki, tokenize } from './query.js';
export { lintWiki } from './lint.js';
