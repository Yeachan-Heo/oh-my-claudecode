/**
 * Secret masking for text the Jev compaction point sends or keeps: private keys, URL credentials,
 * Authorization and Cookie headers, bearer tokens, password flags, common token prefixes,
 * `*KEY=`-style assignments and long mixed letter-digit strings.
 *
 * Field names are matched by the name list in the `name: value` / `name=value` rule; the list is open: a name in
 * another language is one more alternative there (hasło, klucz, sekret, passwort, kennwort and contraseña as examples).
 *
 * Each rule reads the text once: where a match fails, the rule consumes the run, segment or gap it scanned, so the
 * next attempt does not read it again (src/__tests__/jev-mask.test.mjs times the shapes that once took seconds).
 * scripts/lib/shell-checks.mjs keeps a copy of these rules.
 *
 * No imports and no Node APIs: the Claude Code hooks module hooks/jev-compaction.mjs imports this
 * file too, and a hooks module may import only plain files of its plugin.
 */
export function maskSecrets(text, { keepGitHashes = false } = {}) {
  // The private key blocks and the pairs run first (a pair value holding a key block is masked as a block). The named values come
  // after the contextual rules and only add masking: every rule before them sees the text as it was, so the first word of a value
  // (`secret='Cookie: ...'`, `hasło: DB_PASSWORD=...`) is still the marker of the rule that needs it. The word rule opens on a serialized
  // quote (`\"`), takes the scheme of `token: Bearer ...` along, and a first word that is itself a field key (`secret: "x-api-key: ..."`,
  // `hasło: "p\u0061ssword": "..."`) with its value. The long mixed letter-digit string is the last rule, so a key that is such a string
  // is still read by the rules that find the field.
  return maskNamedValues(maskPrivateKeys(text))
    .replace(/(\/\/[^/\s:@]+:)[^/\s@]+@/g, '$1***@')
    .replace(/((?:authorization|proxy-authorization)\s*:\s*(?:(?:bearer|basic|token)\s*)?)[^\s"']+/gi, '$1***')
    .replace(/((?:set-)?cookie\s*:\s*)[^\r\n"']+/gi, '$1***')
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(/((?:^|\s)(?:-u|--user)(?:\s+|=)["']?[^\s:"']+:)[^\s"']+/g, '$1***')
    .replace(/((?:^|\s)--(?:password|passwd|pass|token|secret|api-key|apikey|access-token|auth-token|client-secret)(?:\s+|=)["']?)[^\s"']+/gi, '$1***')
    // At each step ` -p` and a value is tried before the segment end (\n | ; &); a word without a value keeps its segment
    // unchanged, as a later mysql word of the same segment cannot find a value the earlier one missed.
    .replace(/(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n|;&]*?)(?:(\s-p)[^\s"']+|(?=[\n|;&]|$))/g, (whole, head, flag) =>
      flag ? head + flag + '***' : whole)
    .replace(/(\bsshpass\s+-p\s*["']?)[^\s"']+/g, '$1***')
    .replace(/\b(sk-(?:ant-|proj-)?)[A-Za-z0-9_-]{12,}/g, '$1***')
    .replace(/\b(gh[pousr]_|github_pat_|glpat-|xox[abprs]-)[A-Za-z0-9_-]{10,}/g, '$1***')
    .replace(/\b((?:sk|rk|pk)_(?:live|test)_|hf_|npm_)[A-Za-z0-9]{16,}/g, '$1***')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***')
    // A JWT, or else the rest of the run kept unchanged; the run class has no dot, so a match with a dot is the JWT.
    .replace(/\beyJ(?:[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]*)/g, (m) => m.includes('.') ? 'eyJ***' : m)
    // A whole word containing a keyword: the lookahead finds the keyword once, then the word is read to its end.
    .replace(/(\b(?=[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?))[A-Za-z0-9_]+\b["'\]]*\s*[=:]\s*(?:\\*["'])?)(?:(bearer|basic)[ \t]+)?[^\s"'&;|)]+(?:(?:(?<=[:=])|[ \t]+[:=])[ \t]*(?:\\*["'])?(?![^\s"'&;|)]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?|has[łl]o|klucz|sekret|passwort|kennwort|contrase[ñn]a|\\+u[0-9a-fA-F]{4})[^\s"'&;|)]*(?:[:=]\\*(?![^\s"'&;|)])|(?:\\*["']|\s)+[:=]))[^\s"'&;|)]+)?/gi, (whole, head, scheme) => head + (scheme ? '*** ***' : '***'))
    .replace(NAMED_VALUE, '$1***')
    .replace(ESCAPED_KEY, (whole, key, separator) => secretPairName(key) ? key + separator + '***' : whole)
    // The long mixed letter-digit strings come after the field-name rules: a key such as `service_01234567890123456789_klucz` is a long
    // string itself, and the rules above must read it (to find the field and mask its value) before this one masks it.
    .replace(/(^|[^A-Za-z0-9+_-])(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])([A-Za-z0-9+_-]{32,}={0,2})/g, (whole, before, token) =>
      keepGitHashes && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(token) ? whole : before + '***');
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

// Whitespace between the parts of a field (the name, its separator, the value): a space or a line break, also as JSON writes it into
// a string (`\n`, `\t`, `\r`, `\f` or `\uXXXX` of a whitespace character), with any number of backslashes (the run doubles each time the
// text goes through a string).
const WS = String.raw`(?:\s|\\+(?:[ntrf]|u(?:000[9a-dA-D]|0020|00[aA]0|1680|200[0-9aA]|202[89fF]|205[fF]|3000|[fF][eE][fF][fF])))`;

// The `name: value` / `name=value` rule, the last one of the chain: it masks the first word of a value, so every other rule runs
// before it, and it adds the names of other languages and whitespace written as JSON writes it into a string.
// A value is read to the first whitespace, quote or separator. When that first word is itself a field key (`"password": "x"` inside the
// value of `hasło:`, or `x-api-key: x`), the word after its separator is the secret and is masked too, as the `KEY=` rule does, unless
// that word is a key of its own (it ends in a separator or has one after it), which is left to the rule that reads it.
const VALUE = String.raw`(?:[^\s"'&;|,}\\]|\\(?!["']))+`;
const NEXT_FIELD = String.raw`(?:(?:\\*["'])?${WS}*[:=]|(?<=[^=][:=]))${WS}*(?:\\*["'])?(?!(?=(?<word>${VALUE}))\k<word>(?:(?<=[:=])|(?:\\*["']|${WS})*[:=]))${VALUE}`;
const NAMED_VALUE = new RegExp(String.raw`((?:api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|password|passwd|token|secret|has(?:[łl]|\\+u014[12])o|klucz|sekret|passwort|kennwort|contrase(?:[ñn]|ñ|n\\+u0303|\\+u00d1|\\+u00f1)a)(?:\\*["'])?${WS}*[:=]${WS}*(?:\\*["'])?(?:(?:bearer|basic)[ \t]+)?)${VALUE}(?:${NEXT_FIELD})?`, 'gi');

// A field key that holds JSON `\uXXXX` escapes in any of its letters (`h\u0061s\u0142o`, `p\u0061ssword`), which the name list above does not
// read: the key is decoded and classified as the key of a pair is, and the value is masked when it names a secret. The key is a run of
// word characters and escapes (not of whitespace, which stays the separator), read from its start only, so each character is read once.
const KEY_ESCAPE = String.raw`\\+u(?!(?:000[9a-dA-D]|0020|00[aA]0|1680|200[0-9aA]|202[89fF]|205[fF]|3000|[fF][eE][fF][fF]))[0-9a-fA-F]{4}`;
const KEY_CHAR = String.raw`[^\s\x00-\x2c\x2e\x2f\x3a-\x40\x5b-\x5e\x60\x7b-\x7f]`;
const ESCAPED_KEY = new RegExp(String.raw`(?<!${KEY_CHAR}|\\)((?=(?:${KEY_CHAR}|${KEY_ESCAPE})*${KEY_ESCAPE})(?:${KEY_CHAR}|${KEY_ESCAPE})+)((?:\\*["'])?${WS}*[:=]${WS}*(?:\\*["'])?)${VALUE}`, 'g');

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
const PAIR_SEPARATOR = new RegExp(String.raw`^${WS}*,${WS}*$`);
const PAIR_FORMS = QUOTE_DEPTHS.map((d) =>
  new RegExp(String.raw`${d}(${stringBody(d)}*)${d}${WS}*:${WS}*(${d}${stringBody(d)}*${d}${AFTER_CLOSE}|${d}[^\n]*?(?=,${WS}*${d}${stringBody(d)}*${d}${WS}*:|[}\]](?:(?<=["'][}\]])|(?=${WS}*(?:[,{}\[\]]|$)))|\n|$)|[^,{}\[\]\s"\\]+)`, 'g'));
// JSON `\uXXXX` escapes of the name are read first (`DB_PASS\u0057ORD`), with any number of backslashes before the u.
const decodeUnicode = (text) => text.replace(/(?<!\\)\\+u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
const secretPairName = (name) => /key|token|secret|pass|pwd|credential|has[łl]o|klucz|sekret|kennwort|contrase(?:ñ|n\u0303?)a|^securestring$/i.test(decodeUnicode(name));

// The text of a quoted value without its quotes and without the backslashes of an escaped closing quote.
function unquoted(value, quote) {
  let end = value.length;
  if (value.endsWith('"') && end > quote.length) {
    end--;
    while (end > quote.length && value[end - 1] === '\\') end--;
  }
  return value.slice(quote.length, end);
}

function maskNamedValues(text) {
  let out = text;
  if (!out.includes('"')) return out;
  for (const [depth, field] of PAIR_FORMS.entries()) {
    if (depth && !out.includes('\\'.repeat((1 << depth) - 1) + '"')) continue;
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
          if (!m || f.value === f.quote + '***' + f.quote) continue;
          const prefix = m[1].toLowerCase();
          if (secret.has(prefix) || (!names.has(prefix) && secret.has(''))) cuts.push(f);
        }
      }
      group = [];
    };
    field.lastIndex = 0;
    let end = 0;
    let m;
    while ((m = field.exec(out))) {
      if (group.length && !PAIR_SEPARATOR.test(out.slice(end, m.index))) flush();
      end = m.index + m[0].length;
      const quote = /^\\*"/.exec(m[2])?.[0] ?? '';
      group.push({ key: m[1], value: m[2], quote, start: end - m[2].length, end });
    }
    flush();
    if (cuts.length) {
      let masked = '';
      let at = 0;
      for (const f of cuts) {
        masked += out.slice(at, f.start) + f.quote + '***' + f.quote;
        at = f.end;
      }
      out = masked + out.slice(at);
    }
  }
  return out;
}
