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
/**
 * Keywords that occur inside ordinary English words, so a substring match on them is
 * a false positive. Measured against the 235,976-entry system word list: 'pensa'
 * appears inside 53 English words ("compensate", "dispensary"), 'pense' inside 35
 * ("expense", "suspense", "prepense"), 'penser' inside 11 ("dispenser"), 'repense'
 * inside two ("prepense", "prepensely"), and 'pensar', 'denk' and 'gruble' inside one
 * each ("dispensary", "goldenknop", "grubless").
 *
 * Re-derive after adding a Latin keyword: a new stem that occurs inside an English
 * word belongs here, or it will fire on English prose.
 *
 * Nothing else needs anchoring, and anchoring more has repeatedly cost ordinary
 * requests: 'denken' occurs inside no English word at all, so requiring a word start
 * for it silently disabled every German prefixed form -- 'bedenken', 'umdenken',
 * 'nachdenken', 'überdenken' -- one productive prefix at a time. Leaving it as a
 * substring covers them all without a per-prefix list.
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
// Latin word characters: the letters and combining marks associated with Latin, plus
// ASCII digits and underscore.
//
// A bare \p{M} counted a mark from any script, which suppressed the boundary in
// 'कृपयाthinkकरें', 'นี่thinkให้ลึกๆ', NFD 'がthinkして' and '❤️think'. Script_Extensions=Latin
// alone over-corrects the other way: it also matches separators and punctuation merely
// associated with Latin, so U+202F NARROW NO-BREAK SPACE in 'Please\u202Fthink' and
// U+00B7 in 'think·deeply' counted as adjacency and suppressed the boundary there.
//
// Intersecting with [\p{L}\p{M}] keeps U+0301 and friends, which are marks, and drops
// U+202F and U+00B7, which are neither letters nor marks. ASCII digits and underscore
// are listed explicitly because neither is Script_Extensions=Latin; that also keeps a
// non-Latin digit a boundary, matching the \b this replaced.
const LATIN_WORD_CHARACTER_CLASS = String.raw`[[\p{Script_Extensions=Latin}&&[\p{L}\p{M}]]0-9_]`;

/**
 * Build an English whole-word matcher. Non-Latin scripts count as boundaries so
 * English triggers remain usable in unspaced CJK prompts.
 */
function buildWordPattern(keyword: string): RegExp {
  const escaped = escapeRegExp(keyword);
  // The 'v' flag is required for the set intersection in LATIN_WORD_CHARACTER_CLASS.
  // Only the two ASCII English keywords reach here, so the stricter class-escaping
  // rules of 'v' mode cannot affect the escaped keyword.
  return new RegExp(
    `(?<!${LATIN_WORD_CHARACTER_CLASS})${escaped}(?!${LATIN_WORD_CHARACTER_CLASS})`,
    'iv',
  );
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
 * Common prefixed forms are listed explicitly instead of allowing arbitrary prefixes,
 * which would reintroduce the English false positives.
 *
 * Keywords in every other script keep substring matching, because anchoring them
 * loses ordinary requests on either side.
 */
function buildKeywordPattern(keyword: string): RegExp {
  if (!ENGLISH_COLLIDING_KEYWORDS.has(keyword.toLowerCase())) {
    return new RegExp(escapeRegExp(keyword), 'iu');
  }
  const start = `(?<!${UNICODE_WORD_CHARACTER_CLASS})`;
  // An anchored stem may also follow a word-initial Romance 're'/'ri', so the
  // conjugated prefixed forms match: 'repensons', 'repensamos', 'ripensiamo'. The
  // 're' must itself begin the word, so "prepense" and "recompense" stay rejected.
  return new RegExp(
    `(?:${start}|(?<=${start}[rR][eEiI]))${escapeRegExp(keyword)}`,
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
