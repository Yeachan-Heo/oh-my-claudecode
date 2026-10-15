/**
 * Shared frontmatter parsing utilities
 *
 * Parses YAML-like frontmatter from markdown files.
 * Used by both the builtin-skills loader and the auto-slash-command executor.
 */

/** Remove matching YAML quotes while preserving the scalar's inner whitespace. */
export function unquoteYamlScalar(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

/** Escape a string for use inside YAML double quotes. */
export function escapeYamlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

/** Escape a string for use inside YAML single quotes. */
export function escapeYamlSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

/** Decode the YAML string escapes supported by the frontmatter parsers. */
export function unescapeYamlString(value: string): string {
  return value.replace(/\\(\\|"|n|r)/g, (_, ch) => {
    if (ch === 'n') return '\n';
    if (ch === 'r') return '\r';
    return ch;
  });
}

/**
 * Remove surrounding single or double quotes from a trimmed value.
 */
export function stripOptionalQuotes(value: string): string {
  const trimmed = value.trim();
  return unquoteYamlScalar(trimmed).trim();
}

/**
 * Parse YAML-like frontmatter from markdown content.
 * Returns { metadata, body } where metadata is a flat string map.
 */
export function parseFrontmatter(content: string): { metadata: Record<string, string>; body: string } {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { metadata: {}, body: content };
  }

  const [, yamlContent, body] = match;
  const metadata: Record<string, string> = {};
  const lines = yamlContent.split(/\r?\n/);
  const rootLine = lines.find((line) => {
    const trimmed = line.trimStart();
    return trimmed.length > 0 && !trimmed.startsWith('#') && trimmed.includes(':');
  });
  const rootIndent = rootLine === undefined ? undefined : rootLine.length - rootLine.trimStart().length;

  let flowDepth = 0;
  let quote: "'" | '"' | null = null;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (flowDepth === 0) {
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (indent !== rootIndent) continue;

      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      const key = line.slice(0, colonIndex).trim();
      const value = stripOptionalQuotes(line.slice(colonIndex + 1));

      metadata[key] = value;
    } else {
      // Inside an unterminated multiline flow collection ({...} / [...]) every line is a
      // continuation member, never a root mapping key — even when it shares the root
      // indentation. Matches js-yaml, which nests these members under the opener.
    }

    // Track flow collection structure across lines. A root line opens a collection only
    // when its value starts with { or [ (`metadata: {`); a brace appearing later in a
    // plain scalar is literal text, as in js-yaml block context. Continuation lines are
    // scanned fully to find the collection end. Quoted scalars and comments never open
    // or close flow structure.
    let scanFrom = 0;
    if (flowDepth === 0) {
      const colonIndex = line.indexOf(':');
      const valueStart = colonIndex === -1 ? -1 : line.slice(colonIndex + 1).search(/\S/);
      if (colonIndex !== -1 && valueStart !== -1) {
        const firstValueChar = line[colonIndex + 1 + valueStart];
        if (firstValueChar === '{' || firstValueChar === '[') {
          scanFrom = colonIndex + 1 + valueStart;
        }
      }
      if (scanFrom === 0) continue;
    }

    for (let i = scanFrom; i < line.length; i++) {
      const char = line[i];

      if (quote) {
        if (quote === '"' && char === '\\') {
          i++;
          continue;
        }
        if (char === quote) {
          if (quote === "'" && line[i + 1] === "'") {
            i++;
            continue;
          }
          quote = null;
        }
        continue;
      }

      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
        break;
      }
      if (char === '{' || char === '[') {
        flowDepth++;
      } else if ((char === '}' || char === ']') && flowDepth > 0) {
        flowDepth--;
      }
    }
  }

  return { metadata, body };
}

/**
 * Parse the `aliases` frontmatter field into an array of strings.
 * Supports inline YAML list: `aliases: [foo, bar]` or single value.
 */
export function parseFrontmatterAliases(rawAliases: string | undefined): string[] {
  return parseFrontmatterList(rawAliases);
}

/**
 * Split the inside of an inline flow sequence (`[a, "b, c"]` without the
 * brackets) on top-level commas. A comma inside a quoted item is kept; a quote
 * only opens at the start of an item, so a bare apostrophe (`don't`) is literal.
 */
export function splitFlowSequenceItems(inner: string): string[] {
  const items: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (quote) {
      current += char;
      if (quote === '"' && char === '\\' && i + 1 < inner.length) {
        current += inner[++i];
      } else if (quote === "'" && char === "'" && inner[i + 1] === "'") {
        current += inner[++i];
      } else if (char === quote) {
        quote = null;
      }
    } else if ((char === '"' || char === "'") && current.trim() === '') {
      quote = char;
      current += char;
    } else if (char === ',') {
      items.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  items.push(current);
  return items;
}

/**
 * Parse a generic frontmatter list field into an array of strings.
 * Supports inline YAML list syntax: `[foo, bar]` or a single scalar value.
 */
export function parseFrontmatterList(rawValue: string | undefined): string[] {
  if (!rawValue) return [];

  const trimmed = rawValue.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];

    return splitFlowSequenceItems(inner)
      .map((item) => stripOptionalQuotes(item))
      .filter((item) => item.length > 0);
  }

  const singleValue = stripOptionalQuotes(trimmed);
  return singleValue ? [singleValue] : [];
}
