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
    ralph: /\b(ralph)\b/i,
    autopilot: /\b(autopilot|auto[\s-]?pilot|fullsend|full\s+auto)\b/i,
    ultrapilot: /\b(ultrapilot|ultra-pilot)\b|\bparallel\s+build\b|\bswarm\s+build\b/i,
    ultrawork: /\b(ultrawork|ulw)\b/i,
    swarm: /\bswarm\s+\d+\s+agents?\b|\bcoordinated\s+agents\b|\bteam\s+mode\b/i,
    team: /(?<!\b(?:my|the|our|a|his|her|their|its)\s)\bteam\b|\bcoordinated\s+team\b/i,
    pipeline: /\bagent\s+pipeline\b|\bchain\s+agents\b/i,
    ralplan: /\b(ralplan)\b/i,
    plan: /\bplan\s+(this|the)\b/i,
    tdd: /\b(tdd)\b|\btest\s+first\b/i,
    ultrathink: /\b(ultrathink)\b/i,
    deepsearch: /\b(deepsearch)\b|\bsearch\s+the\s+codebase\b|\bfind\s+in\s+(the\s+)?codebase\b/i,
    analyze: /\b(deep[\s-]?analyze|deepanalyze)\b/i,
    ccg: /\b(ccg|claude-codex-gemini)\b/i,
    codex: /\b(ask|use|delegate\s+to)\s+(codex|gpt)\b/i,
    gemini: /\b(ask|use|delegate\s+to)\s+gemini\b/i
};
/**
 * Priority order for keyword detection
 */
const KEYWORD_PRIORITY = [
    'cancel', 'ralph', 'autopilot', 'ultrapilot', 'team', 'ultrawork',
    'swarm', 'pipeline', 'ccg', 'ralplan', 'plan', 'tdd',
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
 * Detect keywords in text and return matches with type info
 */
export function detectKeywordsWithType(text, _agentName) {
    const detected = [];
    const cleanedText = sanitizeForKeywordDetection(text);
    // Check each keyword type
    for (const type of KEYWORD_PRIORITY) {
        // Skip team-related types when team feature is disabled
        if ((type === 'team' || type === 'ultrapilot' || type === 'swarm') && !isTeamEnabled()) {
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
            // Legacy ultrapilot/swarm also activate team mode internally
            if (type === 'ultrapilot' || type === 'swarm') {
                detected.push({
                    type: 'team',
                    keyword: match[0],
                    position: match.index
                });
            }
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
    // Mutual exclusion: team beats autopilot (ultrapilot/swarm now map to team at detection)
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
//# sourceMappingURL=index.js.map