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

/**
 * Keywords whose script writes each listed token as a standalone word.
 *
 * Only Latin qualifies, and only Latin needs it: every observed false positive is a
 * Latin keyword sitting inside an English word, where Portuguese 'pense' fires inside
 * "expense" and Italian 'pensa' inside "compensate".
 *
 * Every other script keeps substring matching, because anchoring it loses ordinary
 * requests. Arabic and Hebrew attach clitics directly to the word, so the Arabic
 * definite article in 'التفكير' and the Hebrew conjunction in 'ולחשוב' sit exactly where
 * a boundary expects a separator; Russian prefixes ('обдумать') and Hindi suffixes
 * ('सोचना') do the same; and Han, Hiragana, Katakana, Hangul and Thai run words
 * together with no separator at all.
 */
const ANCHORED_SCRIPTS = /\p{Script=Latin}/u;

/** Escape a keyword so that regex metacharacters match literally. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a matcher for a single think keyword.
 *
 * Latin keywords are anchored on both sides so they only match whole words. Keywords
 * in every other script keep substring matching, because anchoring them would stop
 * ordinary requests matching at all.
 */
function buildKeywordPattern(keyword: string): RegExp {
  const escaped = escapeRegExp(keyword);
  if (!ANCHORED_SCRIPTS.test(keyword)) {
    return new RegExp(escaped, 'iu');
  }
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu');
}

/** Combined patterns including multilingual support */
const MULTILINGUAL_PATTERNS = MULTILINGUAL_KEYWORDS.map(buildKeywordPattern);
const THINK_PATTERNS = [...ENGLISH_PATTERNS, ...MULTILINGUAL_PATTERNS];

/** Regex patterns for code blocks */
const CODE_BLOCK_PATTERN = /```[\s\S]*?```/g;
const INLINE_CODE_PATTERN = /`[^`]+`/g;

/**
 * Remove code blocks from text to avoid false positive keyword detection.
 */
export function removeCodeBlocks(text: string): string {
  return text.replace(CODE_BLOCK_PATTERN, '').replace(INLINE_CODE_PATTERN, '');
}

/**
 * Detect if text contains a think keyword (excluding code blocks).
 */
export function detectThinkKeyword(text: string): boolean {
  const textWithoutCode = removeCodeBlocks(text);
  return THINK_PATTERNS.some((pattern) => pattern.test(textWithoutCode));
}

/**
 * Extract text content from message parts.
 */
export function extractPromptText(
  parts: Array<{ type: string; text?: string }>
): string {
  return parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text || '')
    .join('');
}

/**
 * Check if the text contains the ultrathink keyword specifically.
 */
export function detectUltrathinkKeyword(text: string): boolean {
  const textWithoutCode = removeCodeBlocks(text);
  return /\bultrathink\b/i.test(textWithoutCode);
}
