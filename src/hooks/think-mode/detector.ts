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
  'piensa', 'repiensa', 'malpensar', 'reflexionar', 'reflexiona',
  // French. 'surpens' is a bare stem, unlike its neighbours here, because the 'sur'
  // prefix already disambiguates it: no English word contains 'surpens' at all, while 35
  // contain 'pense', which is why the unprefixed stems are listed as whole forms and
  // anchored instead. As a stem it covers the whole regular -er conjugation in one entry,
  // superseding the separate 'surpenser' and 'surpense' entries.
  'penser', 'repenser', 'repense', 'surpens', 'réfléchir', 'réfléchis',
  // German
  'denken', 'denk', 'nachdenken', 'überdenken', 'überdenke',
  // Vietnamese
  'suy nghĩ', 'cân nhắc',
  // Turkish
  'düşün', 'düşünmek',
  // Italian
  'pensare', 'pensa', 'ripensare', 'ripensa', 'strapens', 'riflettere', 'rifletti',
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
 * Productive prefixes that may precede an anchored stem at a word start.
 *
 * Kept deliberately explicit: word-initial 're' and 'ri' support the existing Romance
 * conjugations, while 'sobre' and 'contra' support productive Portuguese and Spanish
 * compounds ('sobrepensar' to overthink, 'contrapensar' to think against). The specific
 * Spanish 'malpensar' form is listed as a keyword instead of admitting 'mal' generally,
 * which would also match common adjectives like 'malpensado' and 'malpensante'.
 * Arbitrary infixes remain blocked by the anchor.
 *
 * The 'sobre' and 'contra' allowances are safe because, against the system word list, no
 * English word starts with 'sobrepens' or 'contrapens'. The separated forms need no
 * allowance -- in 'pense sobre isso' and 'sobre pensar nisso' the stem already starts a
 * word, so the anchor admits it without help.
 *
 * Broadening it further was tried and reverted. An accented prefix such as 'pré' is not
 * robust: a prompt in NFD form decomposes the accent into a base letter plus U+0301, so
 * the literal prefix no longer appears and the match is lost. An unaccented 'pre' is
 * worse, because it admits "prepense" -- the very collision the anchor exists to
 * suppress -- and 'dé' admits 'dépenser', which means to spend, not to think.
 *
 * A prefixed form that is worth supporting is therefore listed as its own keyword
 * instead, the way 'repenser', 'surpens', 'strapens' and 'überdenken' are. An accent-free
 * keyword is identical in NFC and NFD, so it has no normalization hazard at all.
 *
 * Listing it as a stem rather than one form matters. A prefixed infinitive only covers
 * the forms built on the infinitive, so 'surpenser' left the present, imperative,
 * participles and imperfect unmatched, and adding 'surpense' beside it still left
 * 'surpensons', 'surpensé', 'surpensant' and the imperfect out. The stem covers all of
 * them at once, which is why the paradigm is enumerated in a test rather than in a list.
 */
const ROMANCE_PREFIXES = 're|ri|sobre|contra';

/**
 * Latin stems whose embedded forms collide with ordinary English words. 'repense' is
 * included because it occurs inside "prepense" and "prepensely".
 *
 * Membership requires a collision the anchor can actually suppress, which means an
 * English word containing the stem somewhere other than its start. Measured against the
 * system word list, each entry here has one: 'pensa' 52, 'pense' 33, 'penser' 11,
 * 'repense' 2, 'pensar' 1.
 *
 * Two stems are deliberately omitted because they fail that test. 'gruble' collides only
 * with "grubless", and 'denk' only with "goldenknop" -- both words begin with the stem,
 * so a word-start anchor could never exclude them, and anchoring only cost the ordinary
 * prefixed forms 'begruble', 'bedenke', 'umdenken' and 'überdenken'.
 */
const ENGLISH_COLLIDING_KEYWORDS = new Set([
  'pensa',
  'pensar',
  'pense',
  'penser',
  'repense',
]);

/** Escape a keyword so that regex metacharacters match literally. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Marks that decorate rather than compose a letter, so they must not be traversed as
// part of a grapheme: the variation selectors, and every enclosing mark (\p{Me} covers
// U+20E3 COMBINING ENCLOSING KEYCAP and U+20DD COMBINING ENCLOSING CIRCLE alike).
//
// Traversing them turns a decorated number into word adjacency: '1\u{FE0F}\u{20E3}think'
// and '1\u{20DD}think' would find the ASCII '1' inside the enclosure. Combining
// diacritics stay traversable, since U+0301 and friends are \p{Mn}, not \p{Me}.
//
// \p{Variation_Selector} rather than the [\uFE00-\uFE0F] range: the selectors also live
// at U+180B-U+180D and U+180F (Mongolian) and U+E0100-U+E01EF (VS17-VS256, used by
// ideographic variation sequences). All 260 of them are \p{M}, so the narrower range let
// 'think\u{E0100}' and 'think\u180B' suppress a visible trigger while 'think\u{FE0F}'
// did not. The property matches exactly those four ranges, so it adds no code point that
// composes a letter.
const LETTER_MARK = String.raw`(?:(?!\p{Variation_Selector}|\p{Me})\p{M})`;

// A Latin *letter*, not merely a Latin-script code point. U+2170 ROMAN NUMERAL ONE is
// Script=Latin but \p{Nl}, a list marker rather than identifier text, so '\u{2170}think'
// must still activate -- matching how \p{Nd} already treats it on the multilingual side.
const LATIN_LETTER = String.raw`(?:(?=\p{L})\p{Script=Latin})`;

// Only Latin word graphemes suppress an anchored Latin stem. Non-Latin script
// transitions remain boundaries so code-switched prompts can trigger without spaces.
const LATIN_GRAPHEME_BEFORE = String.raw`(?<!(?:${LATIN_LETTER}|[0-9_])${LETTER_MARK}*)`;

// Same rule for the anchored multilingual stems, except that digits stay \p{Nd} rather
// than [0-9]. A decimal digit beside a stem is word adjacency in any script, which is
// what the predecessor these stems previously used encoded; reusing the English
// lookbehind verbatim narrowed it to ASCII and let '٣pense', '३pense' and '３pense'
// match where they had not. Number-Other and Number-Letter code points stay excluded:
// those are list markers, so '\u{2170}pense' is still a boundary.
const ANCHORED_GRAPHEME_BEFORE = String.raw`(?<!(?:${LATIN_LETTER}|[\p{Nd}_])${LETTER_MARK}*)`;
const LATIN_GRAPHEME_AFTER = String.raw`(?!${LETTER_MARK}|${LATIN_LETTER}|[0-9_])`;


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
 * Anchor only stems that collide with English words. Word-initial 're' and 'ri' allow
 * Romance conjugations, while 'sobre' and 'contra' allow productive Portuguese and
 * Spanish compounds; no trailing boundary is used because multilingual keywords are
 * stems with productive suffixes.
 */
function buildKeywordPattern(keyword: string): RegExp {
  if (!ENGLISH_COLLIDING_KEYWORDS.has(keyword.toLowerCase())) {
    return new RegExp(escapeRegExp(keyword), 'iu');
  }
  return new RegExp(
    `${ANCHORED_GRAPHEME_BEFORE}(?:${ROMANCE_PREFIXES})?${escapeRegExp(keyword)}`,
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
