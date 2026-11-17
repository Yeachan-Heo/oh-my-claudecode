/**
 * Secret masking for text the Jev compaction point sends or keeps: private keys, URL credentials,
 * Authorization and Cookie headers, bearer tokens, password flags, common token prefixes,
 * `*KEY=`-style assignments and long mixed letter-digit strings.
 *
 * Field names are matched by the name list in the `name: value` / `name=value` rule; the list is open: a name in
 * another language is one more entry of LOCAL_NAMES, from which every rule that reads a name is built (hasło, klucz, sekret,
 * passwort, kennwort and contraseña as examples).
 *
 * Each rule reads the text once: where a match fails, the rule consumes the run, segment or gap it scanned, so the
 * next attempt does not read it again (src/__tests__/jev-mask.test.mjs times the shapes that once took seconds).
 * In a reading no rule reads the output of another: they all read the same text and report the parts they would mask, and the
 * parts are joined, so a rule that rewrites the start of a key (a token prefix) or a marker cannot take away what a field rule
 * or a contextual rule reads. The long-string rule then reads the result (so a token whose kind stays visible, `sk-***`, is not
 * masked again), and the whole is read once more when it changed anything, which only adds masking. A quoted key is read whole,
 * up to its closing quote, and decoded, before it is classified.
 * scripts/lib/shell-checks.mjs keeps a copy of these rules.
 *
 * No imports and no Node APIs: the Claude Code hooks module hooks/jev-compaction.mjs imports this
 * file too, and a hooks module may import only plain files of its plugin.
 */
export function maskSecrets(text, { keepGitHashes = false } = {}) {
  // The private key blocks run first (a pair value holding a key block is masked as a block). Every other rule then reads that same
  // text and only reports what it would mask, so none can erase the field name, the separator, the quote or the marker that another
  // one needs, whatever their order (src/__tests__/jev-mask.test.mjs pins it with keys that start with each kind of token). What each
  // rule masks is joined with the rest, and a part masked twice is masked once. Then the long-string rule reads the result, and the
  // whole is read once more, which only adds masking.
  return maskRules(maskPrivateKeys(text), [
    // [pattern, what of a match stays (a length, or a function of the match; by default its first group), what replaces the rest].
    // URL credentials, headers, flags and the word rules that need a marker:
    [/(\/\/[^/\s:@]+:)[^/\s@]+(?=@)/g],
    [/((?:authorization|proxy-authorization)\s*:\s*(?:(?:bearer|basic|token)\s*)?)[^\s"']+/gi],
    [/((?:set-)?cookie\s*:\s*)[^\r\n"']+/gi],
    [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi],
    [/((?:^|\s)(?:-u|--user)(?:\s+|=)["']?[^\s:"']+:)[^\s"']+/g],
    [/((?:^|\s)--(?:password|passwd|pass|token|secret|api-key|apikey|access-token|auth-token|client-secret)(?:\s+|=)["']?)[^\s"']+/gi],
    // At each step ` -p` and a value is tried before the segment end (\n | ; &); a word without a value keeps its segment
    // unchanged, as a later mysql word of the same segment cannot find a value the earlier one missed.
    [/(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n|;&]*?)(?:(\s-p)[^\s"']+|(?=[\n|;&]|$))/g, (m) => m[1].length + (m[2]?.length ?? Infinity)],
    [/(\bsshpass\s+-p\s*["']?)[^\s"']+/g],
    // Token prefixes:
    [/\b(sk-(?:ant-|proj-)?)[A-Za-z0-9_-]{12,}/g],
    [/\b(gh[pousr]_|github_pat_|glpat-|xox[abprs]-)[A-Za-z0-9_-]{10,}/g],
    [/\b((?:sk|rk|pk)_(?:live|test)_|hf_|npm_)[A-Za-z0-9]{16,}/g],
    [/\bAKIA[0-9A-Z]{16}\b/g, 4],
    // A JWT, or else the rest of the run kept unchanged; the run class has no dot, so a match with a dot is the JWT.
    [/\beyJ(?:[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]*)/g, (m) => m[0].includes('.') ? 3 : Infinity],
    // A whole word containing a keyword: the lookahead finds the keyword once, then the word is read to its end.
    [KEYWORD_ASSIGNMENT, undefined, (m) => m[2] || m[3] ? '*** ***' : '***'],
    [NAMED_VALUE],
  ], [
    // The long mixed letter-digit strings, read on what the rules above made: `sk-***` is not one.
    [/(^|[^A-Za-z0-9+_-])(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])([A-Za-z0-9+_-]{32,}={0,2})/g, (m) =>
      keepGitHashes && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(m[2]) ? Infinity : m[1].length],
  ]);
}

/**
 * Private key blocks only: a PEM, PGP (`PRIVATE KEY BLOCK`) or SSH2 (`---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----`) one, with
 * 4 or 5 hyphens, the type being words of letters and digits (a run of them stops at a double hyphen, so the rule stays linear),
 * to their END line or the end of the text, keeping both header lines so a second pass
 * changes nothing: the first step of maskSecrets, also for a caller that drops lines before masking.
 */
export function maskPrivateKeys(text) {
  return String(text ?? '').replace(/(-{4,5} ?BEGIN +(?:[A-Z0-9]+(?: +|-))*[A-Z0-9]*PRIVATE KEY(?: BLOCK)? ?-{4,5})[\s\S]*?(-{4,5} ?END +(?:[A-Z0-9]+(?: +|-))*[A-Z0-9]*PRIVATE KEY(?: BLOCK)? ?-{4,5}|$)/g, '$1***$2');
}

// Field names in other languages. This list is the one source of every rule that reads a name: the word that is a key of its own
// (NEXT_KEY), the `name: value` rule and the classifier of a pair name are all built from it, so a name added here is known to each of
// them. A letter with a diacritic is read as itself (the precomposed letter), as its base letter alone (`haslo`, `contrasena`) and as its
// base letter followed by combining marks (`n` and U+0303, the decomposed form of `ñ`); a rule that reads JSON `\uXXXX` escapes reads
// them in a name too.
const LOCAL_NAMES = ['hasło', 'klucz', 'sekret', 'passwort', 'kennwort', 'contraseña'];
const BASE_LETTERS = { 'ł': 'l', 'ñ': 'n' };
const ENGLISH_KEYWORDS = String.raw`KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?`;
const localNames = (escapes) => {
  const marks = escapes ? String.raw`(?:[\u0300-\u036f]|\\+u03[0-6][0-9a-fA-F])*` : String.raw`[\u0300-\u036f]*`;
  const code = (letter) => letter.codePointAt(0).toString(16).padStart(4, '0');
  const letter = (ch) => {
    const base = BASE_LETTERS[ch];
    if (!base) return ch;
    const escaped = escapes ? String.raw`|\\+u(?:${code(ch)}|${code(ch.toUpperCase())})` : '';
    return `(?:${ch}${escaped}|${base}${marks})`;
  };
  return LOCAL_NAMES.map((name) => [...name.normalize('NFC')].map(letter).join('')).join('|');
};

// The `*KEY=` rule. A word that holds a secret keyword, a separator and a value; the word after a value that ends in `=` or `:` is
// taken too (`secret: x-api-key: YWJjZA=`) unless it is a key of its own: a word that holds a keyword and either ends in a separator
// (and backslashes) or has a separator after it (spaces, quotes). Whether the next word is a key is decided in one pass over that
// word: the first keyword is found by a scan that stops there (a keyword is a whole `\uXXXX` escape or a name, so a run of backslashes
// is not rescanned from each of its characters), then the word is read to its end once, and that end is tested. The test does not
// depend on where the keyword is, so a word that holds many keywords is not read again from each of them.
const WORD = String.raw`[^\s"'&;|)]`;
// After an opening quote the word is read to the closing quote or a space: a separator, a parenthesis, a comma or a brace inside the
// quotes is content, so a value that holds them is masked whole, also where the text ends before the quote. The lookbehind reads only
// the quote (never a run of spaces before the position), which keeps the rules linear.
const AFTER_QUOTE = String.raw`(?<=["'])`;
const QUOTED_WORD = String.raw`[^\s"']+`;
const VALUE_WORD = String.raw`(?:${AFTER_QUOTE}${QUOTED_WORD}|${WORD}+)`;
const KEYWORD = String.raw`${ENGLISH_KEYWORDS}|${localNames(false)}|\\u[0-9a-fA-F]{4}`;
const NEXT_KEY = String.raw`(?:(?!${KEYWORD})${WORD})*(?:${KEYWORD})${WORD}*(?!${WORD})(?:(?<=[:=]\\*)|(?:\\*["']|\s)+[:=])`;
const KEYWORD_ASSIGNMENT = new RegExp(String.raw`(\b(?=[A-Za-z0-9_]*(?:${ENGLISH_KEYWORDS}))[A-Za-z0-9_]+\b["'\]]*\s*[=:]\s*(?:\\*["'])?)(?:${AFTER_QUOTE}(?:(bearer|basic)[ \t]+)?${QUOTED_WORD}|(?:(bearer|basic)[ \t]+)?${WORD}+)(?:(?:(?<=[:=])|[ \t]+[:=])[ \t]*(?:\\*["'])?(?!${NEXT_KEY})${VALUE_WORD})?`, 'gi');

// Whitespace between the parts of a field (the name, its separator, the value): a space or a line break, also as JSON writes it into
// a string (`\n`, `\t`, `\r`, `\f` or `\uXXXX` of a whitespace character), with any number of backslashes (the run doubles each time the
// text goes through a string).
const WS_CODES = String.raw`000[9a-dA-D]|0020|00[aA]0|1680|200[0-9aA]|202[89fF]|205[fF]|3000|[fF][eE][fF][fF]`;
const WS = String.raw`(?:\s|\\+(?:[ntrf]|u(?:${WS_CODES})))`;

// The `name: value` / `name=value` rule: it masks the first word of a value (the other rules read the same text, so the marker of a
// contextual rule in that word is still read by it), and it adds the names of other languages and whitespace written as JSON writes
// it into a string.
// A value is read to the first whitespace, quote or separator. When that first word is itself a field key (`"password": "x"` inside the
// value of `hasło:`, or `x-api-key: x`), the word after its separator is the secret and is masked too, as the `KEY=` rule does, unless
// that word is a key of its own (it ends in a separator or has one after it), which is left to the rule that reads it.
const VALUE = String.raw`(?:[^\s"'&;|,}\\]|\\+(?![\\"']))+`;
// After an opening quote the word is read as in the `KEY=` rule: the closing quote or a space ends it, and a comma, a closing brace or a
// shell separator inside the quotes is content.
const QUOTED_VALUE = String.raw`(?:[^\s"'\\]|\\+(?![\\"']))+`;
const FIELD_VALUE = String.raw`(?:${AFTER_QUOTE}${QUOTED_VALUE}|${VALUE})`;
const NEXT_FIELD = String.raw`(?:(?:\\*["'])?${WS}*[:=]|(?<=[^=][:=]))${WS}*(?:\\*["'])?(?!(?=(?<word>${VALUE}))\k<word>(?:(?<=[:=])|(?:\\*["']|${WS})*[:=]))${VALUE}`;
const NAMED_VALUE = new RegExp(String.raw`((?:api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|password|passwd|token|secret|${localNames(true)})(?:\\*["'])?${WS}*[:=]${WS}*(?:\\*["'])?(?:(?:bearer|basic)[ \t]+)?)${FIELD_VALUE}(?:${NEXT_FIELD})?`, 'gi');

// A field key that holds JSON `\uXXXX` escapes in any of its letters (`h\u0061s\u0142o`, `p\u0061ssword`), which the name list above does not
// read: the key is decoded and classified as the key of a pair is, and the value is masked when it names a secret. The key is a run of
// word characters and escapes (not of whitespace, which stays the separator; a key that holds spaces or punctuation is quoted, and a quoted
// key is read whole by the pair scanner, below), read from its start only, so each character is read once. A key that is not read whole is not read past its
// separator either, so what follows it is read as the text it is: `m\u0079:p\u0061ssword=x` holds the key `m\u0079` and then the key
// `p\u0061ssword`. A key starts after a whitespace escape as after a space.
const KEY_ESCAPE = String.raw`\\+u(?!(?:${WS_CODES}))[0-9a-fA-F]{4}`;
const KEY_CHAR = String.raw`[^\s\x00-\x2c\x2e\x2f\x3a-\x40\x5b-\x5e\x60\x7b-\x7f]`;
const ESCAPED_KEY = new RegExp(String.raw`(?:(?<!${KEY_CHAR}|\\)|(?<=\\+u(?:${WS_CODES})))((?=(?:${KEY_CHAR}|${KEY_ESCAPE})*${KEY_ESCAPE})(?:${KEY_CHAR}|${KEY_ESCAPE})+)((?:\\*["'])?${WS}*[:=]${WS}*(?:\\*["'])?)`, 'g');
const FIELD_VALUE_AT = new RegExp(FIELD_VALUE, 'y');
// The masked part (from, to, replacement) of the value of each field whose escaped key names a secret.
function keyParts(source) {
  const parts = [];
  // A key that starts inside a value that is masked already is masked with it, so each value is read once.
  let masked = 0;
  for (const m of source.matchAll(ESCAPED_KEY)) {
    if (m.index < masked || !secretPairName(m[1])) continue;
    FIELD_VALUE_AT.lastIndex = m.index + m[0].length;
    const value = FIELD_VALUE_AT.exec(source);
    if (!value) continue;
    masked = FIELD_VALUE_AT.lastIndex;
    parts.push([masked - value[0].length, masked, '***']);
  }
  return parts;
}

// A quote delimiter at escaping depth 0 (a plain quote), 1 (inside a JSON string: `\"`), 2 (shell-escaped before it went into the
// JSON string: `\\\"`), 3 (7 backslashes) and so on up to 8 (255 backslashes): a maximal run of backslashes whose length is 2^depth - 1 plus a multiple of 2^(depth + 1),
// then the quote. Runs of other lengths are escaped quotes inside the string (the raw text has an odd run before its quote), so the
// string body is every character that does not start a delimiter, and a scan stops at the next delimiter, which keeps the rules linear.
const QUOTE_DEPTHS = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((depth) => String.raw`(?<!\\)(?:\\{${2 << depth}})*\\{${(1 << depth) - 1}}"`);
const stringBody = (delim) => String.raw`(?:(?!${delim})[^\n])`;

// In a pair, a closing quote counts only when a terminator follows it (a space, a comma, a bracket, a separator, another quote or the
// end); if another character follows, the close was misread, and the value is masked up to the next field instead.
const AFTER_CLOSE = String.raw`(?=[\s,}\])&;|"'\\]|$)`;

// Name/value pairs in JSON text, `{"Name":"DB_PASSWORD","Value":"hunter2zz"}` or the AWS SSM form with `"Type":"SecureString"`:
// the value is masked when the name holds a secret word. The scalar fields of one flat object (consecutive `"key": scalar` fields,
// separated by commas only) are read once, in order; a key ending in `name`, `key` or `type` is a name, one ending in `value` or `val`
// a value, and a value goes with the names of its own prefix (`oldName` and `oldValue`), or else with the names without a prefix.
// The text is read at each quote depth, so the same pair inside a JSON string (as a tool input is sent) is found too. There is no
// length cap and no cutoff in the number of fields, and each character is read a constant number of times.
// A prefix of a pair-field key (`old` in `oldName`, `paramètre-` in `paramètre-name`): word characters, hyphens, dots and non-ASCII characters
// that are not whitespace, so a key in another language pairs as an English one does.
const PAIR_PREFIX = String.raw`[^\s\x00-\x2c\x2f\x3a-\x40\x5b-\x5e\x60\x7b-\x7f]*`;
const PAIR_NAME_FIELD = new RegExp(String.raw`^(${PAIR_PREFIX})(?:name|key|type)$`, 'i');
const PAIR_VALUE_FIELD = new RegExp(String.raw`^(${PAIR_PREFIX})(?:value|val)$`, 'i');
const PLAIN_KEY = /^[A-Za-z0-9_]+$/;
const PAIR_SEPARATOR = new RegExp(String.raw`^${WS}*,${WS}*$`);
// The value of a pair field at quote depth d: a complete quoted string, or else a value whose quote is open or was misread.
// The text sent to a model is often clipped, so a value can end where the text does, and what closes a value (a bracket, a comma, a
// parenthesis) is content for as long as its quote is open: with no delimiter in the value, nothing ends it before the end of the line
// (or the next field), however many brackets and commas it holds. Only after a delimiter that no terminator followed (the close was
// misread) does a bracket that ends an object end the scan, so the next object of an array is its own group; such a bracket comes right
// after a delimiter (an escaped quote or an apostrophe is none), or is followed by the end, or by one more bracket at most and then the
// end or a comma and the start of the next member (a quote, a brace, a bracket): `abc"def},hunter2zz` is a value that goes on.
const pairValue = (d) => {
  const nextField = String.raw`,${WS}*${d}${stringBody(d)}*${d}${WS}*:`;
  const objectEnd = String.raw`[}\]](?:(?<=${d}[}\]])|(?=(?:${WS}*[}\]])?${WS}*(?:,${WS}*(?:["{\[\\]|$)|$)))`;
  return String.raw`${d}${stringBody(d)}*${d}${AFTER_CLOSE}|${d}(?:${stringBody(d)}*?(?=${nextField}|\n|$)|${stringBody(d)}*${d}[^\n]*?(?=${nextField}|${objectEnd}|\n|$))|[^,{}\[\]\s"\\]+`;
};
const PAIR_FORMS = QUOTE_DEPTHS.map((d) =>
  new RegExp(String.raw`${d}(${stringBody(d)}*)${d}${WS}*:${WS}*(${pairValue(d)})`, 'g'));
// JSON `\uXXXX` escapes of the name are read first (`DB_PASS\u0057ORD`), with any number of backslashes before the u.
const decodeUnicode = (text) => text.replace(/(?<!\\)\\+u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
const SECRET_PAIR_NAME = new RegExp(String.raw`${ENGLISH_KEYWORDS}|${localNames(false)}|^securestring$`, 'i');
const secretPairName = (name) => SECRET_PAIR_NAME.test(decodeUnicode(name));
// A quoted key read whole: decoded, it is classified by the word it ends in (the part the word rules read before a separator), so
// punctuation, spaces and escapes in front of that word do not change the result.
const keyNamesSecret = (key) => secretPairName(decodeUnicode(key).split(/[^\p{L}\p{N}\p{M}_]+/u).findLast(Boolean) ?? '');

// The text of a quoted value without its quotes and without the backslashes of an escaped closing quote.
function unquoted(value, quote) {
  let end = value.length;
  if (value.endsWith('"') && end > quote.length) {
    end--;
    while (end > quote.length && value[end - 1] === '\\') end--;
  }
  return value.slice(quote.length, end);
}

// Applies the rules to one text, and then once more to what it made (a value that only shows once the first value of a field is
// masked, as in `key: a'= b`, is found by the second pass, which only adds masking). A rule is [pattern, keep, replacement]: each
// match of the pattern keeps its first `keep` characters (by default its first group) and the rest is replaced; a rule that keeps all of
// a match masks nothing there. The replacement is a string or a function of the match. The pair scanner and the scanners of quoted and
// escaped keys add their own parts. Parts that overlap or touch are joined and take the replacement of the part that starts first (the
// longer one on a tie, then the one that came first). The last rules read the result of the others: a token that a rule masked and
// kept the kind of (`sk-***`) is no longer a long string.
function maskRules(source, rules, lastRules) {
  const pass = (text) => maskParts(maskParts(text, rules, (t) => pairParts(t).concat(keyParts(t))), lastRules, () => []);
  const once = pass(source);
  return once === source ? once : pass(once);
}
function maskParts(source, rules, scan) {
  const parts = [];
  for (const [pattern, keep = (m) => m[1].length, replacement = '***'] of rules) {
    for (const m of source.matchAll(pattern)) {
      const from = m.index + (typeof keep === 'function' ? keep(m) : keep);
      const to = m.index + m[0].length;
      if (from < to) parts.push([from, to, typeof replacement === 'function' ? replacement(m) : replacement]);
    }
  }
  const all = parts.concat(scan(source));
  all.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = '';
  let at = 0;
  for (let i = 0; i < all.length;) {
    const [from, , replacement] = all[i];
    let to = all[i][1];
    for (i++; i < all.length && all[i][0] <= to; i++) to = Math.max(to, all[i][1]);
    out += source.slice(at, from) + replacement;
    at = to;
  }
  return out + source.slice(at);
}

// The masked part (from, to, replacement) of the value of each field of a name/value pair whose name names a secret, and of each
// field whose key names a secret: the keys are read whole, at every quote depth.
function pairParts(source) {
  const parts = [];
  if (!source.includes('"')) return parts;
  for (const [depth, field] of PAIR_FORMS.entries()) {
    if (depth && !source.includes('\\'.repeat((1 << depth) - 1) + '"')) continue;
    const cuts = [];
    let group = [];
    const flush = () => {
      const names = new Set();
      const secret = new Set();
      for (const f of group) {
        const m = PAIR_NAME_FIELD.exec(decodeUnicode(f.key));
        if (!m || !f.quote) continue;
        const prefix = m[1].toLowerCase();
        names.add(prefix);
        if (secretPairName(unquoted(f.value, f.quote))) secret.add(prefix);
      }
      if (secret.size) {
        for (const f of group) {
          const m = PAIR_VALUE_FIELD.exec(decodeUnicode(f.key));
          if (!m) continue;
          const prefix = m[1].toLowerCase();
          if (secret.has(prefix) || (!names.has(prefix) && secret.has(''))) cuts.push(f);
        }
      }
      group = [];
    };
    field.lastIndex = 0;
    let end = 0;
    let m;
    while ((m = field.exec(source))) {
      if (group.length && !PAIR_SEPARATOR.test(source.slice(end, m.index))) flush();
      end = m.index + m[0].length;
      const quote = /^\\*"/.exec(m[2])?.[0] ?? '';
      const f = { key: m[1], value: m[2], quote, start: end - m[2].length, end };
      group.push(f);
      // A key is read whole, up to its closing quote, and decoded: a key that ends in a secret word masks its value, whatever stands
      // inside the key (a colon, a space, escapes). A key that is one plain word (letters, digits and underscores) is left to the
      // rules that read a word, as before.
      if (!PLAIN_KEY.test(f.key) && keyNamesSecret(f.key)) cuts.push(f);
    }
    flush();
    // The text inside the quotes is what is masked, so the quotes stay where they are when another rule masks the same value; a value
    // whose quote is not closed gets its closing quote.
    for (const f of cuts) {
      if (/^\s*\*[*\s]*$/.test(unquoted(f.value, f.quote))) continue;
      const closed = f.quote && f.value.length >= 2 * f.quote.length && f.value.endsWith(f.quote);
      parts.push([f.start + f.quote.length, closed ? f.end - f.quote.length : f.end, closed || !f.quote ? '***' : '***' + f.quote]);
    }
  }
  return parts;
}
