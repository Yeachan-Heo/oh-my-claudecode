/**
 * Wiki Types
 *
 * Type definitions for the LLM Wiki knowledge layer.
 * Inspired by Karpathy's LLM Wiki concept — persistent, self-maintained
 * markdown knowledge base that compounds over time.
 */
// ============================================================================
// Page Schema
// ============================================================================
/** Current schema version for wiki pages. Bump on breaking frontmatter changes. */
export const WIKI_SCHEMA_VERSION = 1;
/** Default wiki configuration. */
export const DEFAULT_WIKI_CONFIG = {
    autoCapture: true,
    staleDays: 30,
    maxPageSize: 10_240, // 10KB
};
//# sourceMappingURL=types.js.map