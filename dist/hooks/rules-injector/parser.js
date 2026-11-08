/**
 * Rules Parser
 *
 * Parses YAML frontmatter from rule files.
 * Supports multiple formats for compatibility.
 *
 * Ported from oh-my-opencode's rules-injector hook.
 */
import { stripLeadingUtf8Bom } from '../../utils/frontmatter.js';
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
    // A UTF-8 BOM (Windows editors) would otherwise hide the opening `---`.
    const match = stripLeadingUtf8Bom(content).match(frontmatterRegex);
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
    // Split on CRLF or LF so a trailing "\r" from a Windows-authored rule file
    // never leaks into a line. The multi-line array matcher (/^\s+-\s*(.*)$/)
    // stops at "\r", which would otherwise collapse a "  - pattern" list to ''.
    const lines = yamlContent.split(/\r?\n/);
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
        const rawValue = stripTrailingComment(line.slice(colonIndex + 1));
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
 * Trim a YAML value and drop a trailing ` # comment`. A `#` only starts a
 * comment at the start of the value or after whitespace, and never inside quotes.
 */
function stripTrailingComment(value) {
    let quoteChar = '';
    let canStartQuote = true;
    const flowArrayOpenerIndex = value.search(/\S/);
    const isFlowArray = value[flowArrayOpenerIndex] === '[';
    for (let i = 0; i < value.length; i++) {
        const char = value[i];
        if (quoteChar) {
            if (char === '\\' && quoteChar === '"')
                i++;
            else if (quoteChar === "'" && char === "'" && value[i + 1] === "'")
                i++;
            else if (char === quoteChar) {
                quoteChar = '';
                canStartQuote = false;
            }
        }
        else if ((char === '"' || char === "'") && canStartQuote) {
            quoteChar = char;
        }
        else if (char === '#' && (i === 0 || /\s/.test(value[i - 1]))) {
            return value.slice(0, i).trim();
        }
        else if (isFlowArray && i === flowArrayOpenerIndex && char === '[') {
            canStartQuote = true;
        }
        else if (char === ',') {
            canStartQuote = true;
        }
        else if (!/\s/.test(char)) {
            canStartQuote = false;
        }
    }
    return value.trim();
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
            const arrayMatch = nextLine.match(/^\s*-\s*(.*)$/);
            if (arrayMatch) {
                const itemValue = parseStringValue(stripTrailingComment(arrayMatch[1]));
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
        const items = splitOutsideBraces(stringValue)
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        return { value: items, consumed: 1 };
    }
    // Case 4: Single string value
    return { value: stringValue, consumed: 1 };
}
/**
 * Split on commas that are not inside a `{...}` brace group, so a glob such as
 * `src/**\/*.{ts,tsx}` stays one pattern while `a/*.ts, b/*.ts` still splits.
 */
function splitOutsideBraces(value, respectQuotes = false) {
    const { openings, closings } = findBalancedBraceIndices(value, respectQuotes);
    const items = [];
    let current = '';
    let depth = 0;
    let quoteChar = '';
    // Inline-array quotes only start at item boundaries; apostrophes in plain globs are literal.
    let canStartQuote = true;
    for (let i = 0; i < value.length; i++) {
        const char = value[i];
        if (char === '\\' && i + 1 < value.length) {
            current += char + value[++i];
            if (!quoteChar)
                canStartQuote = false;
            continue;
        }
        if (respectQuotes && quoteChar) {
            current += char;
            if (char === quoteChar) {
                quoteChar = '';
                canStartQuote = false;
            }
            continue;
        }
        if (respectQuotes && canStartQuote && (char === '"' || char === "'")) {
            quoteChar = char;
            current += char;
            continue;
        }
        if (openings.has(i)) {
            depth++;
            canStartQuote = false;
        }
        else if (closings.has(i)) {
            depth--;
            canStartQuote = false;
        }
        if (char === ',' && depth === 0) {
            items.push(current);
            current = '';
            canStartQuote = true;
        }
        else {
            current += char;
            if (!/\s/.test(char))
                canStartQuote = false;
        }
    }
    items.push(current);
    return items;
}
/** Find only balanced, unescaped brace pairs, ignoring brace characters in quotes. */
function findBalancedBraceIndices(value, respectQuotes) {
    const openings = new Set();
    const closings = new Set();
    const stack = [];
    let quoteChar = '';
    let canStartQuote = true;
    for (let i = 0; i < value.length; i++) {
        const char = value[i];
        if (char === '\\' && i + 1 < value.length) {
            i++;
            if (!quoteChar)
                canStartQuote = false;
            continue;
        }
        if (respectQuotes && quoteChar) {
            if (char === quoteChar) {
                quoteChar = '';
                canStartQuote = false;
            }
            continue;
        }
        if (respectQuotes && canStartQuote && (char === '"' || char === "'")) {
            quoteChar = char;
        }
        else if (char === '{') {
            stack.push(i);
            canStartQuote = false;
        }
        else if (char === '}' && stack.length > 0) {
            openings.add(stack.pop());
            closings.add(i);
            canStartQuote = false;
        }
        else if (char === ',' && stack.length === 0) {
            canStartQuote = true;
        }
        else if (!/\s/.test(char)) {
            canStartQuote = false;
        }
    }
    return { openings, closings };
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
    return splitOutsideBraces(content, true)
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .map(parseStringValue);
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