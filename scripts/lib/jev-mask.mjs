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
  // The structured rules run first, so that the word rules do not break the opening of a value that they read whole.
  return maskNamedValues(maskPrivateKeys(text))
    .replace(/((?:api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|password|passwd|token|secret|has(?:[łl]|\\+u014[12])o|klucz|sekret|passwort|kennwort|contrase(?:[ñn]|\\+u00d1|\\+u00f1)a)(?:\\*["'])?\s*[:=]\s*(?:\\*["'])?)(?:[^\s"'&;|,}\\]|\\(?!["']))+/gi, '$1***')
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
    .replace(/(\b(?=[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?))[A-Za-z0-9_]+\b["'\]]*\s*[=:]\s*["']?)[^\s"'&;|)]+/gi, '$1***')
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
  return String(text ?? '').replace(/(-{4,5} ?BEGIN +(?:[A-Z0-9]+(?: +|-))*PRIVATE KEY(?: BLOCK)? ?-{4,5})[\s\S]*?(-{4,5} ?END +(?:[A-Z0-9]+(?: +|-))*PRIVATE KEY(?: BLOCK)? ?-{4,5}|$)/g, '$1***$2');
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
// Whitespace between the parts of a pair: also as JSON writes it into a string (`\\n`, `\\t`, `\\r`, any number of backslashes).
const WS = String.raw`(?:\s|\\+[ntr])`;
const PAIR_SEPARATOR = new RegExp(String.raw`^${WS}*,${WS}*$`);
const PAIR_FORMS = QUOTE_DEPTHS.map((d) =>
  new RegExp(String.raw`${d}(${stringBody(d)}*)${d}${WS}*:${WS}*(${d}${stringBody(d)}*${d}${AFTER_CLOSE}|${d}[^\n]*?(?=,${WS}*${d}${stringBody(d)}*${d}${WS}*:|[}\]]|\n|$)|[^,{}\[\]\s"\\]+)`, 'g'));
// JSON `\uXXXX` escapes of the name are read first (`DB_PASS\u0057ORD`), with any number of backslashes before the u.
const decodeUnicode = (text) => text.replace(/(?<!\\)\\+u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
const secretPairName = (name) => /key|token|secret|pass|pwd|credential|^securestring$/i.test(decodeUnicode(name));

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
        const m = /^([\w.-]*)(?:name|key|type)$/i.exec(decodeUnicode(f.key));
        if (!m || !f.quote) continue;
        const prefix = m[1].toLowerCase();
        names.add(prefix);
        if (secretPairName(unquoted(f.value, f.quote))) secret.add(prefix);
      }
      if (secret.size) {
        for (const f of group) {
          const m = /^([\w.-]*)(?:value|val)$/i.exec(decodeUnicode(f.key));
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
