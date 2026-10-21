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
 * Keywords whose script can collide with English prose.
 *
 * Only Latin qualifies, and only Latin needs it: every observed false positive is a
 * Latin keyword sitting inside an English word, where Portuguese 'pense' fires inside
 * "expense" and Italian 'pensa' inside "compensate". A keyword in any other script
 * cannot occur inside a Latin word at all.
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

const WORD_CHARACTER_CLASS = String.raw`[\p{L}\p{M}\p{N}_]`;

/** Build a case-insensitive matcher that requires a Unicode-aware word start. */
function buildWordStartPattern(keyword: string): RegExp {
  const escaped = escapeRegExp(keyword);
  return new RegExp(`(?<!${WORD_CHARACTER_CLASS})${escaped}`, 'iu');
}

/** Build a case-insensitive keyword matcher with Unicode-aware word boundaries. */
function buildWordPattern(keyword: string): RegExp {
  const escaped = escapeRegExp(keyword);
  return new RegExp(`(?<!${WORD_CHARACTER_CLASS})${escaped}(?!${WORD_CHARACTER_CLASS})`, 'iu');
}

/** English patterns for think keywords */
const ULTRATHINK_PATTERN = buildWordPattern('ultrathink');
const ENGLISH_PATTERNS = [ULTRATHINK_PATTERN, buildWordPattern('think')];

/**
 * Build a matcher for a single think keyword.
 *
 * Latin keywords must start at a word start. That is the whole of the observed
 * false-positive class, because every one of them has the keyword preceded by
 * letters -- 'pense' inside "expense", 'pensa' inside "compensate", "dispense",
 * "suspense". A trailing boundary is deliberately not required: MULTILINGUAL_KEYWORDS
 * stores stems, and the agglutinative Latin-script languages only ever write them
 * with a suffix attached, so Turkish 'dusunun', Finnish 'ajattelen' and Hungarian
 * 'gondolkodjunk' would stop matching at all.
 *
 * Keywords in every other script keep substring matching, because anchoring them
 * loses ordinary requests on either side.
 */
function buildKeywordPattern(keyword: string): RegExp {
  const escaped = escapeRegExp(keyword);
  if (!ANCHORED_SCRIPTS.test(keyword)) {
    return new RegExp(escaped, 'iu');
  }
  return buildWordStartPattern(keyword);
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
