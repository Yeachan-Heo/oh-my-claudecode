/**
 * Keyword Detector Hook
 *
 * Detects magic keywords in user prompts and returns the appropriate
 * mode message to inject into context.
 *
 * Ported from oh-my-opencode's keyword-detector hook.
 */
import { isEcomodeEnabled } from '../../features/auto-update.js';
/**
 * Autopilot keywords
 */
const AUTOPILOT_KEYWORDS = [
    'autopilot',
    'auto pilot',
    'auto-pilot',
    'autonomous',
    'full auto',
    'fullsend',
];
const AUTOPILOT_PHRASE_PATTERNS = [
    /\bbuild\s+me\s+/i,
    /\bcreate\s+me\s+/i,
    /\bmake\s+me\s+/i,
    /\bi\s+want\s+a\s+/i,
    /\bi\s+want\s+an\s+/i,
    /\bhandle\s+it\s+all\b/i,
    /\bend\s+to\s+end\b/i,
    /\be2e\s+this\b/i,
];
/**
 * Keyword patterns for each mode
 */
const KEYWORD_PATTERNS = {
    cancel: /\b(cancelomc|stopomc)\b/i,
    ralph: /\b(ralph|don't stop|must complete|until done)\b/i,
    autopilot: /\b(autopilot|auto pilot|auto-pilot|autonomous|full auto|fullsend)\b/i,
    team: /\b(team)\b|\bcoordinated\s+team\b|\b(ultrapilot|ultra-pilot)\b|\bparallel\s+build\b|\bswarm\s+build\b|\bswarm\s+\d+\s+agents?\b|\bcoordinated\s+agents\b/i,
    ultrawork: /\b(ultrawork|ulw|uw)\b/i,
    ecomode: /\b(eco|ecomode|eco-mode|efficient|save-tokens|budget)\b/i,
    pipeline: /\b(pipeline)\b|\bchain\s+agents\b/i,
    ralplan: /\b(ralplan)\b/i,
    plan: /\bplan\s+(this|the)\b/i,
    tdd: /\b(tdd)\b|\btest\s+first\b|\bred\s+green\b/i,
    research: /\b(research)\b|\banalyze\s+data\b|\bstatistics\b/i,
    ultrathink: /\b(ultrathink|think hard|think deeply)\b/i,
    deepsearch: /\b(deepsearch)\b|\bsearch\s+(the\s+)?(codebase|code|files?|project)\b|\bfind\s+(in\s+)?(codebase|code|all\s+files?)\b/i,
    analyze: /\b(deep\s*analyze)\b|\binvestigate\s+(the|this|why)\b|\bdebug\s+(the|this|why)\b/i,
    codex: /\b(ask|use|delegate\s+to)\s+(codex|gpt)\b/i,
    gemini: /\b(ask|use|delegate\s+to)\s+gemini\b/i
};
/**
 * Priority order for keyword detection
 * Higher priority keywords take precedence
 */
const KEYWORD_PRIORITY = [
    'cancel', 'ralph', 'autopilot', 'team', 'ultrawork', 'ecomode',
    'pipeline', 'ralplan', 'plan', 'tdd', 'research',
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
 * Sanitize text for keyword detection by removing XML tags, URLs, file paths,
 * and code blocks to prevent false positives
 */
export function sanitizeForKeywordDetection(text) {
    return text
        // Strip XML-style tag blocks
        .replace(/<(\w[\w-]*)[\s>][\s\S]*?<\/\1>/g, '')
        // Strip self-closing XML tags
        .replace(/<\w[\w-]*(?:\s[^>]*)?\s*\/>/g, '')
        // Strip URLs
        .replace(/https?:\/\/[^\s)>\]]+/g, '')
        // Strip file paths — uses capture group + $1 replacement instead of lookbehind
        // for broader engine compatibility (the .mjs runtime uses lookbehind instead)
        .replace(/(^|[\s"'`(])(?:\/)?(?:[\w.-]+\/)+[\w.-]+/gm, '$1')
        // Strip markdown code blocks
        .replace(/```[\s\S]*?```/g, '')
        .replace(/~~~[\s\S]*?~~~/g, '')
        // Strip inline code
        .replace(/`[^`]+`/g, '');
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
    // Check for autopilot keywords
    const hasAutopilot = AUTOPILOT_KEYWORDS.some(kw => cleanedText.toLowerCase().includes(kw.toLowerCase()));
    // Check for autopilot phrase patterns
    const hasAutopilotPhrase = AUTOPILOT_PHRASE_PATTERNS.some(pattern => pattern.test(cleanedText));
    if (hasAutopilot || hasAutopilotPhrase) {
        const keyword = hasAutopilot ? 'autopilot' : 'build-phrase';
        const position = cleanedText.toLowerCase().indexOf(keyword.toLowerCase());
        detected.push({
            type: 'autopilot',
            keyword,
            position: position >= 0 ? position : 0
        });
    }
    // Check each keyword type
    for (const type of KEYWORD_PRIORITY) {
        // Skip ecomode detection if disabled in config
        if (type === 'ecomode' && !isEcomodeEnabled()) {
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
    // Mutual exclusion: ecomode beats ultrawork (only if ecomode is enabled)
    if (types.includes('ecomode') && types.includes('ultrawork') && isEcomodeEnabled()) {
        types = types.filter(t => t !== 'ultrawork');
    }
    // Mutual exclusion: team beats autopilot (legacy ultrapilot semantics)
    if (types.includes('team') && types.includes('autopilot')) {
        types = types.filter(t => t !== 'autopilot');
    }
    // Sort by priority order
    return KEYWORD_PRIORITY.filter(k => types.includes(k));
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