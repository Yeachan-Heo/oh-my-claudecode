/**
 * Shared frontmatter parsing utilities
 *
 * Parses YAML-like frontmatter from markdown files.
 * Used by both the builtin-skills loader and the auto-slash-command executor.
 */

/**
 * Remove surrounding single or double quotes from a trimmed value.
 */
export function stripOptionalQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * Parse YAML-like frontmatter from markdown content.
 * Returns { metadata, body } where metadata is a flat string map.
 */
export function parseFrontmatter(content: string): { metadata: Record<string, string>; body: string } {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { metadata: {}, body: content };
  }

  const [, yamlContent, body] = match;
  const metadata: Record<string, string> = {};

  for (const line of yamlContent.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const value = stripOptionalQuotes(line.slice(colonIndex + 1));

    metadata[key] = value;
  }

  return { metadata, body };
}

/**
 * Parse the `aliases` frontmatter field into an array of strings.
 * Supports inline YAML list: `aliases: [foo, bar]` or single value.
 */
export function parseFrontmatterAliases(rawAliases: string | undefined): string[] {
  if (!rawAliases) return [];

  const trimmed = rawAliases.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];

    return inner
      .split(',')
      .map((alias) => stripOptionalQuotes(alias))
      .filter((alias) => alias.length > 0);
  }

  const singleAlias = stripOptionalQuotes(trimmed);
  return singleAlias ? [singleAlias] : [];
}
