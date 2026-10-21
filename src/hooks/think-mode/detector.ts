/**
 * Think Mode Detector
 *
 * Detects think/ultrathink keywords in prompts.
 * Supports multiple languages for global accessibility.
 *
 * Ported from oh-my-opencode's think-mode hook.
 */

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
  'pensar', 'pense', 'repensar', 'refletir', 'reflita',
  // Spanish
  'piensa', 'repiensa', 'reflexionar', 'reflexiona',
  // French
  'penser', 'repenser', 'repense', 'réfléchir', 'réfléchis',
  // German
  'denken', 'denk', 'nachdenken', 'überdenken', 'überdenke',
  // Vietnamese
  'suy nghĩ', 'cân nhắc',
  // Turkish
  'düşün', 'düşünmek',
  // Italian
  'pensare', 'pensa', 'ripensare', 'ripensa', 'riflettere', 'rifletti',
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
 * Latin stems whose embedded forms collide with ordinary English words. 'repense' is
 * included because it occurs inside "prepense" and "prepensely". 'denk' is deliberately
 * omitted: its rare hit in "goldenknop" is not worth rejecting common German forms such
 * as "bedenke", "umdenken" and "überdenken".
 */
const ENGLISH_COLLIDING_KEYWORDS = new Set([
  'pensa',
  'pensar',
  'pense',
  'penser',
  'repense',
  'gruble',
]);

/** Escape a keyword so that regex metacharacters match literally. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const UNICODE_WORD_CHARACTER_CLASS = String.raw`[\p{L}\p{M}\p{N}_]`;
// A Latin grapheme next to the keyword, rather than a Latin code point.
//
// Every earlier attempt asked the wrong question of a single character class.
// A bare \p{M} counted a mark from any script, suppressing the boundary in
// 'कृपयाthinkकरें' and '❤️think'. Script_Extensions=Latin over-corrected, matching
// separators merely associated with Latin, so U+202F in 'Please\u202Fthink' and U+00B7
// in 'think·deeply' suppressed it. Intersecting with [\p{L}\p{M}] fixed those but still
// misread an inherited mark: combining marks are Script=Inherited and take the script of
// their base, so NFD 'άthink' (α + U+0301) and NFD 'йthink' (и + U+0306) put a
// Latin-extension mark next to the keyword even though the grapheme is Greek or
// Cyrillic, and normalization alone disabled think mode.
//
// A mark cannot be classified without its base, so the assertions look at the whole
// grapheme. Leading: reject a Latin letter, ASCII digit or underscore followed by any
// marks. Trailing: reject a mark (it would attach to the final letter and make a
// different word) or a Latin letter, ASCII digit or underscore. ASCII digits and
// underscore are explicit, which keeps a non-Latin digit a boundary, matching the \b
// this replaced.
const LATIN_GRAPHEME_BEFORE = String.raw`(?<![\p{Script=Latin}0-9_]\p{M}*)`;
const LATIN_GRAPHEME_AFTER = String.raw`(?![\p{M}\p{Script=Latin}0-9_])`;

/**
 * Build an English whole-word matcher. A non-Latin grapheme counts as a boundary so
 * English triggers remain usable in unspaced mixed-script prompts, in either
 * normalization form.
 */
function buildWordPattern(keyword: string): RegExp {
  const escaped = escapeRegExp(keyword);
  return new RegExp(`${LATIN_GRAPHEME_BEFORE}${escaped}${LATIN_GRAPHEME_AFTER}`, 'iu');
}

/** English patterns for think keywords */
const ULTRATHINK_PATTERN = buildWordPattern('ultrathink');
const ENGLISH_PATTERNS = [ULTRATHINK_PATTERN, buildWordPattern('think')];

/**
 * Anchor only stems that collide with English words. A word-initial 're' or 'ri' is
 * allowed before an anchored stem for Romance conjugations; no trailing boundary is
 * used because the multilingual keywords are stems with productive suffixes.
 */
function buildKeywordPattern(keyword: string): RegExp {
  if (!ENGLISH_COLLIDING_KEYWORDS.has(keyword.toLowerCase())) {
    return new RegExp(escapeRegExp(keyword), 'iu');
  }
  return new RegExp(
    `(?<!${UNICODE_WORD_CHARACTER_CLASS})(?:re|ri)?${escapeRegExp(keyword)}`,
    'iu',
  );
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
  return ULTRATHINK_PATTERN.test(textWithoutCode);
}
