/**
 * Wiki Query
 *
 * Keyword + tag search across all wiki pages.
 * Returns matching pages with relevance snippets.
 *
 * NO vector embeddings — search is keyword-based only (hard constraint).
 * The LLM caller synthesizes answers from returned matches.
 */

import {
  type WikiQueryOptions,
  type WikiQueryMatch,
  type WikiConfig,
  DEFAULT_WIKI_CONFIG,
} from './types.js';
import {
  readAllPages,
  readAllGlobalPages,
  appendLog,
  isPageExpired,
} from './storage.js';

/**
 * Tokenize text for search, with CJK bi-gram support.
 *
 * Latin/numeric words: split on whitespace.
 * CJK characters (Han, Hangul, Kana): extract bi-grams (2-char sliding window).
 * Single CJK characters are also included to avoid missing single-char matches.
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];

  // Latin/numeric tokens
  const latinMatches = lower.match(/[a-z0-9]+/g);
  if (latinMatches) tokens.push(...latinMatches);

  // CJK segments (Han + Hangul + Katakana + Hiragana)
  const cjkMatches = lower.match(/[\u3000-\u9FFF\uAC00-\uD7AF\u3040-\u30FF]+/g);
  if (cjkMatches) {
    for (const segment of cjkMatches) {
      // Always include individual characters for single-char queries
      for (let i = 0; i < segment.length; i++) {
        tokens.push(segment[i]);
      }
      // Add bi-grams for better phrase matching
      for (let i = 0; i < segment.length - 1; i++) {
        tokens.push(segment.slice(i, i + 2));
      }
    }
  }

  return tokens;
}

/**
 * Search wiki pages by keyword and/or tags.
 *
 * Matching strategy:
 * 1. Tag match: pages whose tags intersect with query tags (highest weight)
 * 2. Title match: pages whose title contains the query text
 * 3. Content match: pages whose content contains the query text
 *
 * Searches both local and global tiers. Local results get a score boost.
 * Expired pages are filtered out.
 *
 * @param root - Project root directory
 * @param queryText - Search text (matched against title + content)
 * @param options - Optional filters (tags, category, limit)
 * @param config - Wiki configuration (for global tier toggle)
 * @returns Matching pages with snippets, sorted by relevance
 */
export function queryWiki(
  root: string,
  queryText: string,
  options: WikiQueryOptions = {},
  config: WikiConfig = DEFAULT_WIKI_CONFIG,
): WikiQueryMatch[] {
  const { tags: filterTags, category, limit = 20 } = options;

  // Collect pages from both tiers
  const localPages = readAllPages(root);
  const globalPages = config.enableGlobalTier ? readAllGlobalPages() : [];

  // Tag pages with their source tier for score boosting
  const tieredPages: Array<{ page: typeof localPages[0]; boost: number }> = [
    ...localPages.map(page => ({ page, boost: 1.5 })),   // Local pages get 1.5x boost
    ...globalPages.map(page => ({ page, boost: 1.0 })),
  ];

  const queryLower = queryText.toLowerCase();
  const queryTerms = tokenize(queryText);

  const matches: WikiQueryMatch[] = [];
  const seenFilenames = new Set<string>();

  for (const { page, boost } of tieredPages) {
    // Skip expired pages
    if (isPageExpired(page)) continue;

    // Category filter
    if (category && page.frontmatter.category !== category) continue;

    // Deduplicate: if same filename exists in both tiers, prefer local (higher boost)
    if (seenFilenames.has(page.filename)) continue;
    seenFilenames.add(page.filename);

    let score = 0;
    let snippet = '';

    // Tag matching (weight: 3 per matching tag)
    if (filterTags && filterTags.length > 0) {
      const tagOverlap = filterTags.filter(t =>
        page.frontmatter.tags.some(pt => pt.toLowerCase() === t.toLowerCase())
      );
      score += tagOverlap.length * 3;
    }

    // Also match query terms against page tags
    for (const term of queryTerms) {
      if (page.frontmatter.tags.some(t => t.toLowerCase().includes(term))) {
        score += 2;
      }
    }

    // Title matching (weight: 5)
    const titleLower = page.frontmatter.title.toLowerCase();
    if (titleLower.includes(queryLower)) {
      score += 5;
    } else {
      for (const term of queryTerms) {
        if (titleLower.includes(term)) score += 2;
      }
    }

    // Content matching (weight: 1 per unique term match)
    const contentLower = page.content.toLowerCase();
    for (const term of queryTerms) {
      const idx = contentLower.indexOf(term);
      if (idx !== -1) {
        score += 1;
        // Extract snippet around first match
        if (!snippet) {
          const start = Math.max(0, idx - 40);
          const end = Math.min(contentLower.length, idx + term.length + 80);
          const raw = page.content.slice(start, end).replace(/\n+/g, ' ').trim();
          snippet = (start > 0 ? '...' : '') + raw + (end < contentLower.length ? '...' : '');
        }
      }
    }

    if (score > 0) {
      if (!snippet) {
        // Default snippet: first non-empty line
        snippet = page.content.split('\n').find(l => l.trim().length > 0)?.trim() || '';
        if (snippet.length > 120) snippet = snippet.slice(0, 117) + '...';
      }

      matches.push({ page, snippet, score: Math.round(score * boost) });
    }
  }

  // Sort by score descending
  matches.sort((a, b) => b.score - a.score);
  const limited = matches.slice(0, limit);

  // Log the query operation
  appendLog(root, {
    timestamp: new Date().toISOString(),
    operation: 'query',
    pagesAffected: limited.map(m => m.page.filename),
    summary: `Query "${queryText}" → ${limited.length} results (of ${matches.length} total, ${localPages.length} local + ${globalPages.length} global)`,
  });

  return limited;
}
