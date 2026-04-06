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
} from './types.js';
import {
  readAllPages,
  appendLog,
} from './storage.js';

/**
 * Search wiki pages by keyword and/or tags.
 *
 * Matching strategy:
 * 1. Tag match: pages whose tags intersect with query tags (highest weight)
 * 2. Title match: pages whose title contains the query text
 * 3. Content match: pages whose content contains the query text
 *
 * Results are scored and sorted by relevance (descending).
 *
 * @param root - Project root directory
 * @param queryText - Search text (matched against title + content)
 * @param options - Optional filters (tags, category, limit)
 * @returns Matching pages with snippets, sorted by relevance
 */
export function queryWiki(
  root: string,
  queryText: string,
  options: WikiQueryOptions = {},
): WikiQueryMatch[] {
  const { tags: filterTags, category, limit = 20 } = options;
  const pages = readAllPages(root);
  const queryLower = queryText.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter(Boolean);

  const matches: WikiQueryMatch[] = [];

  for (const page of pages) {
    // Category filter
    if (category && page.frontmatter.category !== category) continue;

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

      matches.push({ page, snippet, score });
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
    summary: `Query "${queryText}" → ${limited.length} results (of ${matches.length} total)`,
  });

  return limited;
}
