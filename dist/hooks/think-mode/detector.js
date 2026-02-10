/**
 * Think Mode Detector
 *
 * Detects think/ultrathink keywords in prompts.
 * Supports multiple languages for global accessibility.
 *
 * Ported from oh-my-opencode's think-mode hook.
 */
/** English patterns for think keywords */
const ENGLISH_PATTERNS = [/\bultrathink\b/i, /\bthink\b/i];
/** Multilingual think keywords for global support */
const MULTILINGUAL_KEYWORDS = [
    // Korean
    '생각', '고민', '검토', '제대로',
    // Chinese (Simplified & Traditional)
    '思考', '考虑', '考慮',
    // Japanese
    '考え', '熟考',
    // Hindi
    'सोच', 'विचार',
    // Arabic
    'تفكير', 'تأمل',
    // Bengali
    'চিন্তা', 'ভাবনা',
    // Russian
    'думать', 'думай', 'размышлять', 'размышляй',
    // Portuguese
    'pensar', 'pense', 'refletir', 'reflita',
    // Spanish
    'piensa', 'reflexionar', 'reflexiona',
    // French
    'penser', 'réfléchir', 'réfléchis',
    // German
    'denken', 'denk', 'nachdenken',
    // Vietnamese
    'suy nghĩ', 'cân nhắc',
    // Turkish
    'düşün', 'düşünmek',
    // Italian
    'pensare', 'pensa', 'riflettere', 'rifletti',
    // Thai
    'คิด', 'พิจารณา',
    // Polish
    'myśl', 'myśleć', 'zastanów',
    // Dutch
    'nadenken',
    // Indonesian/Malay
    'berpikir', 'pikir', 'pertimbangkan',
    // Ukrainian
    'думати', 'роздумувати',
    // Greek
    'σκέψου', 'σκέφτομαι',
    // Czech
    'myslet', 'mysli', 'přemýšlet',
    // Romanian
    'gândește', 'gândi', 'reflectă',
    // Swedish
    'tänka', 'tänk', 'fundera',
    // Hungarian
    'gondolkodj', 'gondolkodni',
    // Finnish
    'ajattele', 'ajatella', 'pohdi',
    // Danish
    'tænk', 'tænke', 'overvej',
    // Norwegian
    'tenk', 'tenke', 'gruble',
    // Hebrew
    'חשוב', 'לחשוב', 'להרהר',
];
/** Combined patterns including multilingual support */
const MULTILINGUAL_PATTERNS = MULTILINGUAL_KEYWORDS.map((kw) => new RegExp(kw, 'i'));
const THINK_PATTERNS = [...ENGLISH_PATTERNS, ...MULTILINGUAL_PATTERNS];
/** Regex patterns for code blocks */
const CODE_BLOCK_PATTERN = /```[\s\S]*?```/g;
const INLINE_CODE_PATTERN = /`[^`]+`/g;
/**
 * Remove code blocks from text to avoid false positive keyword detection.
 */
export function removeCodeBlocks(text) {
    return text.replace(CODE_BLOCK_PATTERN, '').replace(INLINE_CODE_PATTERN, '');
}
/**
 * Detect if text contains a think keyword (excluding code blocks).
 */
export function detectThinkKeyword(text) {
    const textWithoutCode = removeCodeBlocks(text);
    return THINK_PATTERNS.some((pattern) => pattern.test(textWithoutCode));
}
/**
 * Extract text content from message parts.
 */
export function extractPromptText(parts) {
    return parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text || '')
        .join('');
}
/**
 * Check if the text contains the ultrathink keyword specifically.
 */
export function detectUltrathinkKeyword(text) {
    const textWithoutCode = removeCodeBlocks(text);
    return /\bultrathink\b/i.test(textWithoutCode);
}
//# sourceMappingURL=detector.js.map