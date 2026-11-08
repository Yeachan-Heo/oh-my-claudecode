/**
 * Wiki Module — Public API
 *
 * LLM Wiki: persistent, self-maintained markdown knowledge base
 * that compounds project and session knowledge across sessions.
 */
export { WIKI_SCHEMA_VERSION, DEFAULT_WIKI_CONFIG } from './types.js';
// Storage
export { getWikiDir, ensureWikiDir, withWikiLock, readPage, listPages, readAllPages, readIndex, readLog, writePage, deletePage, appendLog, titleToSlug, parseFrontmatter, serializePage, 
// Unsafe variants (for use inside withWikiLock)
writePageUnsafe, deletePageUnsafe, updateIndexUnsafe, appendLogUnsafe, } from './storage.js';
// Operations
export { ingestKnowledge } from './ingest.js';
export { queryWiki, tokenize } from './query.js';
export { lintWiki } from './lint.js';
//# sourceMappingURL=index.js.map