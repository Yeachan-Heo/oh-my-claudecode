/**
 * Wiki Query
 *
 * Keyword + tag search across all wiki pages.
 * Returns matching pages with relevance snippets.
 *
 * NO vector embeddings — search is keyword-based only (hard constraint).
 * The LLM caller synthesizes answers from returned matches.
 */
import { type WikiQueryOptions, type WikiQueryMatch } from './types.js';
/**
 * Tokenize text for search, with CJK bi-gram support.
 *
 * Latin/numeric words: split on whitespace.
 * CJK characters (Han, Hangul, Kana): bi-grams (2-char sliding window)
 * plus individual characters for single-char query support.
 * Other scripts (Cyrillic, Arabic, Thai, etc.): whitespace split (fallback).
 */
export declare function tokenize(text: string): string[];
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
export declare function queryWiki(root: string, queryText: string, options?: WikiQueryOptions): WikiQueryMatch[];
//# sourceMappingURL=query.d.ts.map