/**
 * Rules Parser
 *
 * Parses YAML frontmatter from rule files.
 * Supports multiple formats for compatibility.
 *
 * Ported from oh-my-opencode's rules-injector hook.
 */
/**
 * Parse YAML frontmatter from rule file content.
 * Supports:
 * - Single string: globs: "**\/*.py"
 * - Inline array: globs: ["**\/*.py", "src/**\/*.ts"]
 * - Multi-line array with dashes
 * - Comma-separated: globs: "**\/*.py, src/**\/*.ts"
 * - Claude Code 'paths' field (alias for globs)
 */
export function parseRuleFrontmatter(content) {
    const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
    const match = content.match(frontmatterRegex);
    if (!match) {
        return { metadata: {}, body: content };
    }
    const yamlContent = match[1];
    const body = match[2];
    try {
        const metadata = parseYamlContent(yamlContent);
        return { metadata, body };
    }
    catch {
        return { metadata: {}, body: content };
    }
}
/**
 * Parse YAML content without external library.
 */
function parseYamlContent(yamlContent) {
    const lines = yamlContent.split('\n');
    const metadata = {};
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const colonIndex = line.indexOf(':');
        if (colonIndex === -1) {
            i++;
            continue;
        }
        const key = line.slice(0, colonIndex).trim();
        const rawValue = line.slice(colonIndex + 1).trim();
        if (key === 'description') {
            metadata.description = parseStringValue(rawValue);
        }
        else if (key === 'alwaysApply') {
            metadata.alwaysApply = rawValue === 'true';
        }
        else if (key === 'globs' || key === 'paths' || key === 'applyTo') {
            const { value, consumed } = parseArrayOrStringValue(rawValue, lines, i);
            // Merge paths into globs (Claude Code compatibility)
            metadata.globs = mergeGlobs(metadata.globs, value);
            i += consumed;
            continue;
        }
        i++;
    }
    return metadata;
}
/**
 * Parse a string value, removing surrounding quotes.
 */
function parseStringValue(value) {
    if (!value)
        return '';
    // Remove surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}
/**
 * Parse array or string value from YAML.
 * Returns the parsed value and number of lines consumed.
 */
function parseArrayOrStringValue(rawValue, lines, currentIndex) {
    // Case 1: Inline array ["a", "b", "c"]
    if (rawValue.startsWith('[')) {
        return { value: parseInlineArray(rawValue), consumed: 1 };
    }
    // Case 2: Multi-line array (value is empty, next lines start with "  - ")
    if (!rawValue || rawValue === '') {
        const arrayItems = [];
        let consumed = 1;
        for (let j = currentIndex + 1; j < lines.length; j++) {
            const nextLine = lines[j];
            // Check if this is an array item (starts with whitespace + dash)
            const arrayMatch = nextLine.match(/^\s+-\s*(.*)$/);
            if (arrayMatch) {
                const itemValue = parseStringValue(arrayMatch[1].trim());
                if (itemValue) {
                    arrayItems.push(itemValue);
                }
                consumed++;
            }
            else if (nextLine.trim() === '') {
                // Skip empty lines within array
                consumed++;
            }
            else {
                // Not an array item, stop
                break;
            }
        }
        if (arrayItems.length > 0) {
            return { value: arrayItems, consumed };
        }
    }
    // Case 3: Comma-separated patterns in single string
    const stringValue = parseStringValue(rawValue);
    if (stringValue.includes(',')) {
        const items = stringValue
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        return { value: items, consumed: 1 };
    }
    // Case 4: Single string value
    return { value: stringValue, consumed: 1 };
}
/**
 * Parse inline JSON-like array: ["a", "b", "c"]
 */
function parseInlineArray(value) {
    const endIdx = value.lastIndexOf(']');
    if (endIdx === -1)
        return [];
    const content = value.slice(1, endIdx).trim();
    if (!content)
        return [];
    const items = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';
    for (let i = 0; i < content.length; i++) {
        const char = content[i];
        if (!inQuote && (char === '"' || char === "'")) {
            inQuote = true;
            quoteChar = char;
        }
        else if (inQuote && char === quoteChar) {
            inQuote = false;
            quoteChar = '';
        }
        else if (!inQuote && char === ',') {
            const trimmed = current.trim();
            if (trimmed) {
                items.push(parseStringValue(trimmed));
            }
            current = '';
        }
        else {
            current += char;
        }
    }
    // Don't forget the last item
    const trimmed = current.trim();
    if (trimmed) {
        items.push(parseStringValue(trimmed));
    }
    return items;
}
/**
 * Merge two globs values (for combining paths and globs).
 */
function mergeGlobs(existing, newValue) {
    if (!existing)
        return newValue;
    const existingArray = Array.isArray(existing) ? existing : [existing];
    const newArray = Array.isArray(newValue) ? newValue : [newValue];
    return [...existingArray, ...newArray];
}
//# sourceMappingURL=parser.js.map