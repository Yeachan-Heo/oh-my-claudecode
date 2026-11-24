/** Quote-aware shell substitution discovery for lookout command parsing. */
export function decodeAnsiCQuote(value) {
    return value
        .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
        .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)))
        .replace(/\\([nrt\\'])/g, (_, escape) => ({ n: "\n", r: "\r", t: "\t", "\\": "\\", "'": "'" })[escape] ?? escape);
}
function isEscapedByOddBackslashes(text, index) {
    let count = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1)
        count += 1;
    return count % 2 === 1;
}
function findSubstitutionEnd(text, start) {
    let depth = 1;
    let quote = null;
    let sawCase = false;
    let casePatternPending = false;
    let word = "";
    for (let index = start + 2; index < text.length; index += 1) {
        const character = text[index] ?? "";
        if (quote === "'") {
            if (character === "'")
                quote = null;
            continue;
        }
        if (quote === '"') {
            if (character === "\\") {
                index += 1;
                continue;
            }
            if (character === '"')
                quote = null;
            continue;
        }
        if (character === "\\") {
            index += 1;
            continue;
        }
        if (character === "`") {
            const end = findBacktickEnd(text, index);
            if (end >= 0) {
                index = end;
                continue;
            }
        }
        if (text.startsWith("$((", index)) {
            index += 1;
            continue;
        }
        if (character === "'" || character === '"') {
            quote = character;
            continue;
        }
        if (/[A-Za-z]/.test(character)) {
            word += character;
            continue;
        }
        if (word === "case")
            sawCase = true;
        else if (word === "in" && sawCase)
            casePatternPending = true;
        else if (word === "esac")
            casePatternPending = false;
        word = "";
        if (text.startsWith(";;", index)) {
            if (sawCase)
                casePatternPending = true;
            index += 1;
            continue;
        }
        if (character === "(")
            depth += 1;
        else if (character === ")") {
            if (casePatternPending) {
                casePatternPending = false;
                continue;
            }
            depth -= 1;
            if (depth === 0)
                return index;
        }
    }
    return -1;
}
export function findNestedSubstitutions(clauses) {
    const nested = [];
    for (const clause of clauses) {
        let quote = null;
        for (let index = 0; index < clause.text.length; index += 1) {
            const character = clause.text[index] ?? "";
            if (quote === "'") {
                if (character === "'")
                    quote = null;
                continue;
            }
            if (quote === '"') {
                if (character === "\\") {
                    index += 1;
                    continue;
                }
                if (character === '"' && !isEscapedByOddBackslashes(clause.text, index))
                    quote = null;
            }
            else if (character === "'") {
                quote = "'";
            }
            else if (character === '"') {
                quote = '"';
            }
            if (quote === "'")
                continue;
            if (character === "\\") {
                index += 1;
                continue;
            }
            if (clause.text.startsWith("$((", index)) {
                index += 1;
                continue;
            }
            if (clause.text.startsWith("$(", index)) {
                const end = findSubstitutionEnd(clause.text, index);
                if (end >= 0) {
                    nested.push({ text: clause.text.slice(index + 2, end), index: clause.index + index + 2 });
                    index = end;
                }
            }
            else if (quote === null && (clause.text.startsWith("<(", index) || clause.text.startsWith(">(", index))) {
                const end = findSubstitutionEnd(clause.text, index);
                if (end >= 0) {
                    nested.push({ text: clause.text.slice(index + 2, end), index: clause.index + index + 2 });
                    index = end;
                }
            }
            else if (character === "`") {
                const end = findBacktickEnd(clause.text, index);
                if (end >= 0) {
                    nested.push({ text: clause.text.slice(index + 1, end), index: clause.index + index + 1 });
                    index = end;
                }
            }
        }
    }
    return nested;
}
function findBacktickEnd(text, start) {
    for (let index = start + 1; index < text.length; index += 1) {
        if (text[index] === "\\") {
            index += 1;
            continue;
        }
        if (text[index] === "`")
            return index;
    }
    return -1;
}
//# sourceMappingURL=substitution-parser.js.map