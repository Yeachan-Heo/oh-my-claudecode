/**
 * Shared frontmatter parsing utilities
 *
 * Parses YAML-like frontmatter from markdown files.
 * Used by both the builtin-skills loader and the auto-slash-command executor.
 */
import { stripLeadingUtf8Bom } from "../../scripts/lib/utf8-bom.mjs";
export { stripLeadingUtf8Bom };
/** Remove matching YAML quotes while preserving the scalar's inner whitespace. */
export function unquoteYamlScalar(value) {
    if (value.startsWith('"') && value.endsWith('"'))
        return value.slice(1, -1);
    if (value.startsWith("'") && value.endsWith("'"))
        return value.slice(1, -1).replace(/''/g, "'");
    return value;
}
/** Escape a string for use inside YAML double quotes. */
export function escapeYamlString(value) {
    return value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r");
}
/** Escape a string for use inside YAML single quotes. */
export function escapeYamlSingleQuoted(value) {
    return value.replace(/'/g, "''");
}
/** Decode the YAML string escapes supported by the frontmatter parsers. */
export function unescapeYamlString(value) {
    return value.replace(/\\(\\|"|n|r)/g, (_, ch) => {
        if (ch === "n")
            return "\n";
        if (ch === "r")
            return "\r";
        return ch;
    });
}
/**
 * Remove surrounding single or double quotes from a trimmed value.
 */
export function stripOptionalQuotes(value) {
    const trimmed = value.trim();
    return unquoteYamlScalar(trimmed).trim();
}
/** `|` / `>` block scalar header with optional chomping/indent indicators and comment. */
const BLOCK_SCALAR_HEADER = /^([|>])(?:(?:([+-])([1-9])?)|(?:([1-9])([+-])?))?(?:[ \t]+#.*)?$/;
function parseBlockScalarHeader(rawValue) {
    const match = BLOCK_SCALAR_HEADER.exec(rawValue);
    if (!match)
        return null;
    const chompingIndicator = match[2] ?? match[5];
    const indentIndicator = match[3] ?? match[4];
    return {
        folded: match[1] === ">",
        chomping: chompingIndicator === "+"
            ? "keep"
            : chompingIndicator === "-"
                ? "strip"
                : "clip",
        ...(indentIndicator ? { indentIndicator: Number(indentIndicator) } : {}),
    };
}
function countLeadingYamlSpaces(line) {
    let count = 0;
    while (line[count] === " ")
        count++;
    return count;
}
function isBlankBlockScalarLine(line) {
    return countLeadingYamlSpaces(line) === line.length;
}
function getBlockScalarContentIndent(lines, startIndex, parentIndent, header) {
    if (header.indentIndicator !== undefined) {
        return { value: parentIndent + header.indentIndicator, isDetermined: true };
    }
    let leadingBlankIndent = parentIndent;
    for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i];
        const indent = countLeadingYamlSpaces(line);
        if (isBlankBlockScalarLine(line)) {
            leadingBlankIndent = Math.max(leadingBlankIndent, indent);
            continue;
        }
        if (indent > parentIndent) {
            if (line[indent] === "#" && indent < leadingBlankIndent) {
                return { value: leadingBlankIndent, isDetermined: false };
            }
            return { value: indent, isDetermined: true };
        }
        break;
    }
    return { value: parentIndent + 1, isDetermined: false };
}
/** Read literal/folded block lines and apply YAML chomping to their final breaks. */
function readBlockScalar(blockLines, header, contentIndent) {
    const rows = blockLines.map((line) => {
        const indent = countLeadingYamlSpaces(line);
        if (isBlankBlockScalarLine(line) && !contentIndent.isDetermined)
            return { text: "", moreIndented: false };
        const moreIndented = indent > contentIndent.value || line[contentIndent.value] === "\t";
        return {
            text: line.slice(Math.min(contentIndent.value, indent)),
            moreIndented,
        };
    });
    let value;
    if (header.folded) {
        value = foldBlockScalarRows(rows);
    }
    else {
        value =
            rows.map((row) => row.text).join("\n") + (rows.length > 0 ? "\n" : "");
    }
    if (header.chomping === "keep")
        return value;
    const withoutTrailingBreaks = value.replace(/\n+$/, "");
    if (header.chomping === "strip" || !rows.some((row) => row.text !== ""))
        return withoutTrailingBreaks;
    return `${withoutTrailingBreaks}\n`;
}
function foldBlockScalarRows(rows) {
    let value = "";
    let previous;
    let pendingEmptyLines = 0;
    for (const row of rows) {
        if (row.text === "") {
            pendingEmptyLines++;
            continue;
        }
        if (!previous) {
            value += "\n".repeat(pendingEmptyLines);
        }
        else if (pendingEmptyLines > 0) {
            const preservedBreak = previous.moreIndented || row.moreIndented ? 1 : 0;
            value += "\n".repeat(pendingEmptyLines + preservedBreak);
        }
        else {
            value += previous.moreIndented || row.moreIndented ? "\n" : " ";
        }
        value += row.text;
        previous = row;
        pendingEmptyLines = 0;
    }
    return (value + "\n".repeat(previous ? pendingEmptyLines + 1 : pendingEmptyLines));
}
/**
 * Parse YAML-like frontmatter from markdown content.
 * Returns { metadata, body } where metadata is a flat string map.
 */
export function parseFrontmatter(content) {
    const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;
    // Editors on Windows may prepend a UTF-8 BOM, which readFileSync keeps as U+FEFF.
    const match = stripLeadingUtf8Bom(content).match(frontmatterRegex);
    if (!match) {
        return { metadata: {}, body: content };
    }
    const [, yamlContent, body] = match;
    const metadata = {};
    const lines = yamlContent.split(/\r?\n/);
    const rootLine = lines.find((line) => {
        const trimmed = line.trimStart();
        return (trimmed.length > 0 && !trimmed.startsWith("#") && trimmed.includes(":"));
    });
    const rootIndent = rootLine === undefined
        ? undefined
        : rootLine.length - rootLine.trimStart().length;
    let flowDepth = 0;
    let quote = null;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        const trimmed = line.trimStart();
        const indent = line.length - trimmed.length;
        if (flowDepth === 0) {
            if (!trimmed || trimmed.startsWith("#"))
                continue;
            if (indent !== rootIndent)
                continue;
            const colonIndex = line.indexOf(":");
            if (colonIndex === -1)
                continue;
            const key = line.slice(0, colonIndex).trim();
            const rawValue = line.slice(colonIndex + 1).trim();
            const blockHeader = parseBlockScalarHeader(rawValue);
            if (blockHeader) {
                // `key: >-` / `key: |` — the value is the more-indented lines that follow.
                const contentIndent = getBlockScalarContentIndent(lines, lineIndex + 1, rootIndent, blockHeader);
                const blockLines = [];
                while (lineIndex + 1 < lines.length) {
                    const nextLine = lines[lineIndex + 1];
                    const nextIndent = countLeadingYamlSpaces(nextLine);
                    if (!isBlankBlockScalarLine(nextLine) &&
                        nextIndent < contentIndent.value)
                        break;
                    blockLines.push(lines[++lineIndex]);
                }
                metadata[key] = readBlockScalar(blockLines, blockHeader, contentIndent);
                continue;
            }
            metadata[key] = stripOptionalQuotes(rawValue);
        }
        else {
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
            const colonIndex = line.indexOf(":");
            const valueStart = colonIndex === -1 ? -1 : line.slice(colonIndex + 1).search(/\S/);
            if (colonIndex !== -1 && valueStart !== -1) {
                const firstValueChar = line[colonIndex + 1 + valueStart];
                if (firstValueChar === "{" || firstValueChar === "[") {
                    scanFrom = colonIndex + 1 + valueStart;
                }
            }
            if (scanFrom === 0)
                continue;
        }
        for (let i = scanFrom; i < line.length; i++) {
            const char = line[i];
            if (quote) {
                if (quote === '"' && char === "\\") {
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
            if (char === "#" &&
                (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
                break;
            }
            if (char === "{" || char === "[") {
                flowDepth++;
            }
            else if ((char === "}" || char === "]") && flowDepth > 0) {
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
export function parseFrontmatterAliases(rawAliases) {
    return parseFrontmatterList(rawAliases);
}
/**
 * Split the inside of an inline flow sequence (`[a, "b, c"]` without the
 * brackets) on top-level commas. A comma inside a quoted item is kept; a quote
 * only opens at the start of an item, so a bare apostrophe (`don't`) is literal.
 */
export function splitFlowSequenceItems(inner) {
    const items = [];
    let current = "";
    let quote = null;
    for (let i = 0; i < inner.length; i++) {
        const char = inner[i];
        if (quote) {
            current += char;
            if (quote === '"' && char === "\\" && i + 1 < inner.length) {
                current += inner[++i];
            }
            else if (quote === "'" && char === "'" && inner[i + 1] === "'") {
                current += inner[++i];
            }
            else if (char === quote) {
                quote = null;
            }
        }
        else if ((char === '"' || char === "'") && current.trim() === "") {
            quote = char;
            current += char;
        }
        else if (char === ",") {
            items.push(current);
            current = "";
        }
        else {
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
export function parseFrontmatterList(rawValue) {
    if (!rawValue)
        return [];
    const trimmed = rawValue.trim();
    if (!trimmed)
        return [];
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        const inner = trimmed.slice(1, -1).trim();
        if (!inner)
            return [];
        return splitFlowSequenceItems(inner)
            .map((item) => stripOptionalQuotes(item))
            .filter((item) => item.length > 0);
    }
    const singleValue = stripOptionalQuotes(trimmed);
    return singleValue ? [singleValue] : [];
}
//# sourceMappingURL=frontmatter.js.map