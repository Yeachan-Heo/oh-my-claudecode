/**
 * Markdown extraction helpers for python_repl / scientist documentation parity.
 *
 * Documentation parity checks must only judge the guidance that actually
 * describes python_repl or the scientist agent. Blacklisting terms across a
 * whole document is wrong: unrelated sections legitimately mention pandas,
 * numpy, or file-IO APIs (other tools, other agents, historical notes), so a
 * whole-file assertion either fails on innocent prose or forces unrelated docs
 * to stay artificially term-free.
 */
/**
 * Extract every part of `markdown` that describes python_repl or the scientist
 * agent:
 * - a heading whose own text is relevant contributes its whole section,
 *   including nested subsections (until the next heading of equal or lower
 *   level);
 * - any other line or fenced code block contributes only when its own text is
 *   relevant, so a table's unrelated rows are never pulled in.
 */
export declare function extractPythonGuidance(markdown: string): string;
//# sourceMappingURL=guidance-sections.d.ts.map