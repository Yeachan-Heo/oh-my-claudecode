/**
 * Simple JSONC (JSON with Comments) parser
 *
 * Strips single-line (//) and multi-line (slash-star) comments and trailing
 * commas from JSONC before parsing with standard JSON.parse.
 */
/**
 * Parse JSONC content by stripping comments and parsing as JSON
 */
export function parseJsonc(content) {
    const cleaned = stripJsoncComments(content);
    return JSON.parse(cleaned);
}
/**
 * Strip comments and trailing commas from JSONC content
 * Handles single-line (//) and multi-line comments, and trailing commas
 * before a closing brace or bracket. Commas inside string literals are
 * preserved because string contents are copied verbatim.
 */
export function stripJsoncComments(content) {
    return stripTrailingCommas(stripComments(content));
}
/**
 * Strip single-line (//) and multi-line comments, leaving string literals
 * (including any comment-like or comma characters inside them) untouched.
 */
function stripComments(content) {
    let result = '';
    let i = 0;
    while (i < content.length) {
        // Check for single-line comment
        if (content[i] === '/' && content[i + 1] === '/') {
            // Skip until end of line
            while (i < content.length && content[i] !== '\n') {
                i++;
            }
            continue;
        }
        // Check for multi-line comment start
        if (content[i] === '/' && content[i + 1] === '*') {
            // Skip until end of comment
            i += 2;
            while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) {
                i++;
            }
            i += 2;
            continue;
        }
        // Handle strings to avoid stripping comments inside strings
        if (content[i] === '"') {
            result += content[i];
            i++;
            while (i < content.length && content[i] !== '"') {
                if (content[i] === '\\') {
                    result += content[i];
                    i++;
                    if (i < content.length) {
                        result += content[i];
                        i++;
                    }
                    continue;
                }
                result += content[i];
                i++;
            }
            if (i < content.length) {
                result += content[i];
                i++;
            }
            continue;
        }
        result += content[i];
        i++;
    }
    return result;
}
/**
 * Remove trailing commas that appear before a closing brace or bracket.
 * Runs on comment-free input. String literals are copied verbatim so commas
 * inside strings are never removed.
 */
function stripTrailingCommas(content) {
    let result = '';
    let i = 0;
    while (i < content.length) {
        // Copy string literals verbatim so their contents are never altered.
        if (content[i] === '"') {
            result += content[i];
            i++;
            while (i < content.length && content[i] !== '"') {
                if (content[i] === '\\') {
                    result += content[i];
                    i++;
                    if (i < content.length) {
                        result += content[i];
                        i++;
                    }
                    continue;
                }
                result += content[i];
                i++;
            }
            if (i < content.length) {
                result += content[i];
                i++;
            }
            continue;
        }
        // Drop a comma followed only by whitespace before a closing brace/bracket.
        if (content[i] === ',') {
            let j = i + 1;
            while (j < content.length && /\s/.test(content[j])) {
                j++;
            }
            if (content[j] === '}' || content[j] === ']') {
                i++; // skip the comma; whitespace is preserved by the next iteration
                continue;
            }
        }
        result += content[i];
        i++;
    }
    return result;
}
//# sourceMappingURL=jsonc.js.map