/**
 * Tests for CJK tokenization in wiki query.
 *
 * The default whitespace-split tokenizer produces zero tokens for CJK text
 * (Korean, Chinese, Japanese) because these languages don't use spaces
 * between words. This causes wiki_query to return 0 results for CJK queries.
 *
 * Fix: bi-gram tokenizer that generates 2-character sliding windows for CJK
 * segments, plus individual characters for single-char query support.
 */
export {};
//# sourceMappingURL=cjk-tokenize.test.d.ts.map