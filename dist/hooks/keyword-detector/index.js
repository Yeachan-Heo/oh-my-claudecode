/**
 * Keyword Detector Hook
 *
 * Detects magic keywords in user prompts and returns the appropriate
 * mode message to inject into context.
 *
 * Ported from oh-my-opencode's keyword-detector hook.
 */
import { isTeamEnabled } from '../../features/auto-update.js';
import { classifyTaskSize, isHeavyMode, } from '../task-size-detector/index.js';
/**
 * Keyword patterns for each mode
 */
const KEYWORD_PATTERNS = {
    cancel: /\b(cancelomc|stopomc)\b/i,
    ralph: /\b(ralph)\b(?!-)/i,
    autopilot: /\b(autopilot|auto[\s-]?pilot|fullsend|full\s+auto)\b/i,
    ultrawork: /\b(ultrawork|ulw)\b/i,
    team: /(?<!\b(?:my|the|our|a|his|her|their|its)\s)\bteam\b|\bcoordinated\s+team\b/i,
    ralplan: /\b(ralplan)\b/i,
    tdd: /\b(tdd)\b|\btest\s+first\b/i,
    ultrathink: /\b(ultrathink)\b/i,
    deepsearch: /\b(deepsearch)\b|\bsearch\s+the\s+codebase\b|\bfind\s+in\s+(the\s+)?codebase\b/i,
    analyze: /\b(deep[\s-]?analyze|deepanalyze)\b/i,
    ccg: /\b(ccg|claude-codex-gemini)\b/i,
    codex: /\b(ask|use|delegate\s+to)\s+(codex|gpt)\b/i,
    gemini: /\b(ask|use|delegate\s+to)\s+gemini\b/i
};
/**
 * Patterns for deprecated keywords that trigger deprecation warnings.
 * These modes were removed in #1131 (pipeline unification).
 */
const DEPRECATED_KEYWORD_PATTERNS = {
    ultrapilot: /\b(ultrapilot|ultra-pilot)\b|\bparallel\s+build\b|\bswarm\s+build\b/i,
    swarm: /\bswarm\s+\d+\s+agents?\b|\bcoordinated\s+agents\b|\bteam\s+mode\b/i,
    pipeline: /\bagent\s+pipeline\b|\bchain\s+agents\b/i,
};
/** Deprecation messages for removed modes. */
export const DEPRECATION_MESSAGES = {
    ultrapilot: '[DEPRECATED] /ultrapilot has been removed. Use /autopilot or /team instead.',
    swarm: '[DEPRECATED] /swarm has been removed. Use /team instead.',
    pipeline: '[DEPRECATED] /pipeline has been removed. Use /autopilot instead.',
};
/**
 * Priority order for keyword detection
 */
const KEYWORD_PRIORITY = [
    'cancel', 'ralph', 'autopilot', 'team', 'ultrawork',
    'ccg', 'ralplan', 'tdd',
    'ultrathink', 'deepsearch', 'analyze', 'codex', 'gemini'
];
/**
 * Remove code blocks from text to prevent false positives
 * Handles both fenced code blocks and inline code
 */
export function removeCodeBlocks(text) {
    // Remove fenced code blocks (``` or ~~~)
    let result = text.replace(/```[\s\S]*?```/g, '');
    result = result.replace(/~~~[\s\S]*?~~~/g, '');
    // Remove inline code (single backticks)
    result = result.replace(/`[^`]+`/g, '');
    return result;
}
/**
 * Regex matching non-Latin script characters for prompt translation detection.
 * Uses Unicode script ranges (not raw non-ASCII) to avoid false positives on emoji and accented Latin.
 * Covers: CJK (Japanese/Chinese), Korean, Cyrillic, Arabic, Devanagari, Thai, Myanmar.
 */
export const NON_LATIN_SCRIPT_PATTERN = 
// eslint-disable-next-line no-misleading-character-class -- Intentional: detecting script presence, not matching grapheme clusters
/[\u3000-\u9FFF\uAC00-\uD7AF\u0400-\u04FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u1000-\u109F]/u;
/**
* Sanitize text for keyword detection by removing structural noise.
 * Strips XML tags, URLs, file paths, and code blocks.
 */
export function sanitizeForKeywordDetection(text) {
    // Remove XML tag blocks (opening + content + closing; tag names must match)
    let result = text.replace(/<(\w[\w-]*)[\s>][\s\S]*?<\/\1>/g, '');
    // Remove self-closing XML tags
    result = result.replace(/<\w[\w-]*(?:\s[^>]*)?\s*\/>/g, '');
    // Remove URLs
    result = result.replace(/https?:\/\/\S+/g, '');
    // Remove file paths — requires leading / or ./ or multi-segment dir/file.ext
    result = result.replace(/(^|[\s"'`(])(?:\.?\/(?:[\w.-]+\/)*[\w.-]+|(?:[\w.-]+\/)+[\w.-]+\.\w+)/gm, '$1');
    // Remove code blocks (fenced and inline)
    result = removeCodeBlocks(result);
    return result;
}
/**
 * Extract prompt text from message parts
 */
export function extractPromptText(parts) {
    return parts
        .filter(p => p.type === 'text' && p.text)
        .map(p => p.text)
        .join(' ');
}
/**
 * Detect deprecated keywords in text and return deprecation warnings.
 * Returns an array of deprecation messages for any matched deprecated keywords.
 */
export function detectDeprecatedKeywords(text) {
    const cleanedText = sanitizeForKeywordDetection(text);
    const warnings = [];
    for (const [type, pattern] of Object.entries(DEPRECATED_KEYWORD_PATTERNS)) {
        if (pattern.test(cleanedText)) {
            warnings.push(DEPRECATION_MESSAGES[type]);
        }
    }
    return warnings;
}
/**
 * Detect keywords in text and return matches with type info
 */
export function detectKeywordsWithType(text, _agentName) {
    const detected = [];
    const cleanedText = sanitizeForKeywordDetection(text);
    // Check each keyword type
    for (const type of KEYWORD_PRIORITY) {
        // Skip team when team feature is disabled
        if (type === 'team' && !isTeamEnabled()) {
            continue;
        }
        const pattern = KEYWORD_PATTERNS[type];
        const match = cleanedText.match(pattern);
        if (match && match.index !== undefined) {
            detected.push({
                type,
                keyword: match[0],
                position: match.index
            });
        }
    }
    return detected;
}
/**
 * Check if text contains any magic keyword
 */
export function hasKeyword(text) {
    return detectKeywordsWithType(text).length > 0;
}
/**
 * Get all detected keywords with conflict resolution applied
 */
export function getAllKeywords(text) {
    const detected = detectKeywordsWithType(text);
    if (detected.length === 0)
        return [];
    let types = [...new Set(detected.map(d => d.type))];
    // Exclusive: cancel suppresses everything
    if (types.includes('cancel'))
        return ['cancel'];
    // Mutual exclusion: team beats autopilot
    if (types.includes('team') && types.includes('autopilot')) {
        types = types.filter(t => t !== 'autopilot');
    }
    // Sort by priority order
    return KEYWORD_PRIORITY.filter(k => types.includes(k));
}
/**
 * Get all keywords with task-size-based filtering applied.
 * For small tasks, heavy orchestration modes (ralph/autopilot/team/ultrawork etc.)
 * are suppressed to avoid over-orchestration.
 *
 * This is the recommended function to use in the bridge hook for keyword detection.
 */
export function getAllKeywordsWithSizeCheck(text, options = {}) {
    const { enabled = true, smallWordLimit = 50, largeWordLimit = 200, suppressHeavyModesForSmallTasks = true, } = options;
    const keywords = getAllKeywords(text);
    if (!enabled || !suppressHeavyModesForSmallTasks || keywords.length === 0) {
        return { keywords, taskSizeResult: null, suppressedKeywords: [] };
    }
    const thresholds = { smallWordLimit, largeWordLimit };
    const taskSizeResult = classifyTaskSize(text, thresholds);
    // Only suppress heavy modes for small tasks
    if (taskSizeResult.size !== 'small') {
        return { keywords, taskSizeResult, suppressedKeywords: [] };
    }
    const suppressedKeywords = [];
    const filteredKeywords = keywords.filter(keyword => {
        if (isHeavyMode(keyword)) {
            suppressedKeywords.push(keyword);
            return false;
        }
        return true;
    });
    return {
        keywords: filteredKeywords,
        taskSizeResult,
        suppressedKeywords,
    };
}
/**
 * Get the highest priority keyword detected with conflict resolution
 */
export function getPrimaryKeyword(text) {
    const allKeywords = getAllKeywords(text);
    if (allKeywords.length === 0) {
        return null;
    }
    // Get the highest priority keyword type
    const primaryType = allKeywords[0];
    // Find the original detected keyword for this type
    const detected = detectKeywordsWithType(text);
    const match = detected.find(d => d.type === primaryType);
    return match || null;
}
/**
 * Execution mode keywords subject to the ralplan-first gate (issue #997).
 * These modes spin up heavy orchestration and should not run on vague requests.
 */
export const EXECUTION_GATE_KEYWORDS = new Set([
    'ralph',
    'autopilot',
    'team',
    'ultrawork',
]);
/**
 * Escape hatch prefixes that bypass the ralplan gate.
 */
const GATE_BYPASS_PREFIXES = ['force:', '!'];
/**
 * Positive signals that the prompt IS well-specified enough for direct execution.
 * If ANY of these are present, the prompt auto-passes the gate (fast path).
 */
const WELL_SPECIFIED_SIGNALS = [
    // References specific files by extension
    /\b[\w/.-]+\.(?:ts|js|py|go|rs|java|tsx|jsx|vue|svelte|rb|c|cpp|h|css|scss|html|json|yaml|yml|toml)\b/,
    // References specific paths with directory separators
    /(?:src|lib|test|spec|app|pages|components|hooks|utils|services|api|dist|build|scripts)\/\w+/,
    // References specific functions/classes/methods by keyword
    /\b(?:function|class|method|interface|type|const|let|var|def|fn|struct|enum)\s+\w{2,}/i,
    // CamelCase identifiers (likely symbol names: processKeyword, getUserById)
    /\b[a-z]+(?:[A-Z][a-z]+)+\b/,
    // PascalCase identifiers (likely class/type names: KeywordDetector, UserModel)
    /\b[A-Z][a-z]+(?:[A-Z][a-z0-9]*)+\b/,
    // snake_case identifiers with 2+ segments (likely symbol names: user_model, get_user)
    /\b[a-z]+(?:_[a-z]+)+\b/,
    // Bare issue/PR number (#123, #42)
    /(?:^|\s)#\d+\b/,
    // Has numbered steps or bullet list (structured request)
    /(?:^|\n)\s*(?:\d+[.)]\s|-\s+\S|\*\s+\S)/m,
    // Has acceptance criteria or test spec keywords
    /\b(?:acceptance\s+criteria|test\s+(?:spec|plan|case)|should\s+(?:return|throw|render|display|create|delete|update))\b/i,
    // Has specific error or issue reference
    /\b(?:error:|bug\s*#?\d+|issue\s*#\d+|stack\s*trace|exception|TypeError|ReferenceError|SyntaxError)\b/i,
    // Has a code block with substantial content.
    // NOTE: In the bridge.ts integration, cleanedText has code blocks pre-stripped by
    // removeCodeBlocks(), so this regex will not match there. It remains useful for
    // direct callers of isUnderspecifiedForExecution() that pass raw prompt text.
    /```[\s\S]{20,}?```/,
    // PR or commit reference
    /\b(?:PR\s*#\d+|commit\s+[0-9a-f]{7}|pull\s+request)\b/i,
    // "in <specific-path>" pattern
    /\bin\s+[\w/.-]+\.(?:ts|js|py|go|rs|java|tsx|jsx)\b/,
    // Test runner commands (explicit test target)
    /\b(?:npm\s+test|npx\s+(?:vitest|jest)|pytest|cargo\s+test|go\s+test|make\s+test)\b/i,
];
/**
 * Check if a prompt is underspecified for direct execution.
 * Returns true if the prompt lacks enough specificity for heavy execution modes.
 *
 * Conservative: only gates clearly vague prompts. Borderline cases pass through.
 */
export function isUnderspecifiedForExecution(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return true;
    // Escape hatch: force: or ! prefix bypasses the gate
    for (const prefix of GATE_BYPASS_PREFIXES) {
        if (trimmed.startsWith(prefix))
            return false;
    }
    // If any well-specified signal is present, pass through
    if (WELL_SPECIFIED_SIGNALS.some(p => p.test(trimmed)))
        return false;
    // Strip mode keywords for effective word counting
    const stripped = trimmed
        .replace(/\b(?:ralph|autopilot|team|ultrawork|ulw)\b/gi, '')
        .trim();
    const effectiveWords = stripped.split(/\s+/).filter(w => w.length > 0).length;
    // Short prompts without well-specified signals are underspecified
    if (effectiveWords <= 15)
        return true;
    return false;
}
/**
 * Apply the ralplan-first gate (issue #997): if execution keywords are present
 * but the prompt is underspecified, redirect to ralplan.
 *
 * Returns the modified keyword list and gate metadata.
 */
export function applyRalplanGate(keywords, text) {
    if (keywords.length === 0) {
        return { keywords, gateApplied: false, gatedKeywords: [] };
    }
    // Don't gate if cancel is present (cancel always wins)
    if (keywords.includes('cancel')) {
        return { keywords, gateApplied: false, gatedKeywords: [] };
    }
    // Don't gate if ralplan is already in the list
    if (keywords.includes('ralplan')) {
        return { keywords, gateApplied: false, gatedKeywords: [] };
    }
    // Check if any execution keywords are present
    const executionKeywords = keywords.filter(k => EXECUTION_GATE_KEYWORDS.has(k));
    if (executionKeywords.length === 0) {
        return { keywords, gateApplied: false, gatedKeywords: [] };
    }
    // Check if prompt is underspecified
    if (!isUnderspecifiedForExecution(text)) {
        return { keywords, gateApplied: false, gatedKeywords: [] };
    }
    // Gate: replace execution keywords with ralplan
    const filtered = keywords.filter(k => !EXECUTION_GATE_KEYWORDS.has(k));
    if (!filtered.includes('ralplan')) {
        filtered.push('ralplan');
    }
    return { keywords: filtered, gateApplied: true, gatedKeywords: executionKeywords };
}
//# sourceMappingURL=index.js.map