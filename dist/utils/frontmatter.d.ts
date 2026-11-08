/**
 * Shared frontmatter parsing utilities
 *
 * Parses YAML-like frontmatter from markdown files.
 * Used by both the builtin-skills loader and the auto-slash-command executor.
 */
import { stripLeadingUtf8Bom } from "../../scripts/lib/utf8-bom.mjs";
export { stripLeadingUtf8Bom };
/** Remove matching YAML quotes while preserving the scalar's inner whitespace. */
export declare function unquoteYamlScalar(value: string): string;
/** Escape a string for use inside YAML double quotes. */
export declare function escapeYamlString(value: string): string;
/** Escape a string for use inside YAML single quotes. */
export declare function escapeYamlSingleQuoted(value: string): string;
/** Decode the YAML string escapes supported by the frontmatter parsers. */
export declare function unescapeYamlString(value: string): string;
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
 * Split the inside of an inline flow sequence (`[a, "b, c"]` without the
 * brackets) on top-level commas. A comma inside a quoted item is kept; a quote
 * only opens at the start of an item, so a bare apostrophe (`don't`) is literal.
 */
export declare function splitFlowSequenceItems(inner: string): string[];
/**
 * Parse a generic frontmatter list field into an array of strings.
 * Supports inline YAML list syntax: `[foo, bar]` or a single scalar value.
 */
export declare function parseFrontmatterList(rawValue: string | undefined): string[];
//# sourceMappingURL=frontmatter.d.ts.map