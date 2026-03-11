/**
 * Shared frontmatter parsing utilities
 *
 * Parses YAML-like frontmatter from markdown files.
 * Used by both the builtin-skills loader and the auto-slash-command executor.
 */
/**
 * Remove surrounding single or double quotes from a trimmed value.
 */
export declare function stripOptionalQuotes(value: string): string;
/**
 * Parse YAML-like frontmatter from markdown content.
 * Returns { metadata, body } where metadata is a flat string map.
 */
export declare function parseFrontmatter(content: string): {
    metadata: Record<string, string>;
    body: string;
};
/**
 * Parse the `aliases` frontmatter field into an array of strings.
 * Supports inline YAML list: `aliases: [foo, bar]` or single value.
 */
export declare function parseFrontmatterAliases(rawAliases: string | undefined): string[];
/**
 * Parse a generic frontmatter list field into an array of strings.
 * Supports inline YAML list syntax: `[foo, bar]` or a single scalar value.
 */
export declare function parseFrontmatterList(rawValue: string | undefined): string[];
//# sourceMappingURL=frontmatter.d.ts.map