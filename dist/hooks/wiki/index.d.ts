/**
 * Wiki Module — Public API
 *
 * LLM Wiki: persistent, self-maintained markdown knowledge base
 * that compounds project and session knowledge across sessions.
 */
export type { WikiPage, WikiPageFrontmatter, WikiLogEntry, WikiIngestInput, WikiIngestResult, WikiQueryOptions, WikiQueryMatch, WikiLintIssue, WikiLintReport, WikiCategory, WikiConfig, } from './types.js';
export { WIKI_SCHEMA_VERSION, DEFAULT_WIKI_CONFIG } from './types.js';
export { getWikiDir, ensureWikiDir, withWikiLock, readPage, listPages, readAllPages, readIndex, readLog, writePage, deletePage, appendLog, titleToSlug, parseFrontmatter, serializePage, writePageUnsafe, deletePageUnsafe, updateIndexUnsafe, appendLogUnsafe, } from './storage.js';
export { ingestKnowledge } from './ingest.js';
export { queryWiki, tokenize } from './query.js';
export { lintWiki } from './lint.js';
//# sourceMappingURL=index.d.ts.map