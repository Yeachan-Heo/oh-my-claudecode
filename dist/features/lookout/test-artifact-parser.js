/** Narrow parser for rm commands targeting conventional test artifacts. */
import { findExecutableIndex, splitCommandClauses, tokenizeCommand } from "./command-parser.js";
import { decodeAnsiCQuote, findNestedSubstitutions } from "./substitution-parser.js";
const TEST_ARTIFACT = /^(?:tests?\/|__tests__\/|.+\.(?:test|spec)\.[cm]?[jt]sx?$)/i;
function collectNestedShellBodies(line, depth) {
    if (depth >= 8)
        return [];
    const matches = [];
    const scan = (pattern, decode = false, bodyGroup = 2) => {
        for (const match of line.matchAll(pattern)) {
            const rawBody = match[bodyGroup] ?? "";
            const body = decode ? decodeAnsiCQuote(rawBody) : rawBody;
            const bodyIndex = (match.index ?? 0) + (match[0]?.indexOf(rawBody) ?? 0);
            for (const nested of collectRmTestArtifacts(body, depth + 1)) {
                matches.push({ snippet: nested.snippet, index: bodyIndex + nested.index });
            }
        }
    };
    scan(/\b(?:bash|sh|dash|zsh|ksh)\b[^;&|\n]*\s(?:-c|--command)\s+(['"])([\s\S]*?)\1/g);
    scan(/\b(?:bash|sh|dash|zsh|ksh)\b[^;&|\n]*\s(?:-c|--command)\s+\$'((?:\\.|[^'])*)'/g, true, 1);
    for (const substitution of findNestedSubstitutions([{ text: line, index: 0 }])) {
        for (const nested of collectRmTestArtifacts(substitution.text, depth + 1)) {
            matches.push({ snippet: nested.snippet, index: substitution.index + nested.index });
        }
    }
    return matches;
}
const GIT_GLOBAL_VALUE_OPTION = /^(?:-C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--exec-path|--config-env)$/;
function collectGitRmTestArtifacts(clause, tokens) {
    const gitIndex = findExecutableIndex(tokens, "git");
    if (gitIndex < 0)
        return [];
    let index = gitIndex + 1;
    while (index < tokens.length) {
        const value = tokens[index].value;
        index += 1;
        if (value === "rm")
            break;
        if (value === "--" || /^(?:-h|--help|--version)$/.test(value))
            return [];
        if (GIT_GLOBAL_VALUE_OPTION.test(value)) {
            if (!tokens[index])
                return [];
            index += 1;
            continue;
        }
        if (value.startsWith("-"))
            continue;
        return [];
    }
    if (tokens[index - 1]?.value !== "rm")
        return [];
    let dryRun = false;
    let cached = false;
    let operandsOnly = false;
    const matches = [];
    for (; index < tokens.length; index += 1) {
        const token = tokens[index];
        const value = token.value;
        if (value === "--") {
            operandsOnly = true;
            continue;
        }
        if (!operandsOnly && value.startsWith("-")) {
            if (/^(?:-n|--dry-run)$/.test(value))
                dryRun = true;
            else if (value === "--cached")
                cached = true;
            else if (/^-[fFrRnq]+$/.test(value))
                continue;
            else if (value.startsWith("--pathspec-from-file"))
                return [];
            continue;
        }
        const path = token.value.replace(/^(?:\.\/)+/, "");
        if (TEST_ARTIFACT.test(path))
            matches.push({ snippet: `git rm ${path}`, index: clause.index + token.index });
    }
    return dryRun || cached ? [] : matches;
}
export function collectRmTestArtifacts(line, depth = 0) {
    const matches = [];
    for (const clause of splitCommandClauses(line)) {
        const tokens = tokenizeCommand(clause.text);
        const rmIndex = findExecutableIndex(tokens, "rm");
        if (rmIndex >= 0) {
            let operandsOnly = false;
            for (const token of tokens.slice(rmIndex + 1)) {
                if (token.value === "--") {
                    operandsOnly = true;
                    continue;
                }
                if (!operandsOnly && /^(?:-h|--help|--version)$/.test(token.value))
                    break;
                if (!operandsOnly && /^-[A-Za-z]+$/.test(token.value))
                    continue;
                const path = token.value.replace(/^(?:\.\/)+/, "");
                if (TEST_ARTIFACT.test(path))
                    matches.push({ snippet: `rm ${path}`, index: clause.index + token.index });
            }
        }
        matches.push(...collectGitRmTestArtifacts(clause, tokens));
    }
    return [...matches, ...collectNestedShellBodies(line, depth)];
}
//# sourceMappingURL=test-artifact-parser.js.map