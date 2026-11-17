/**
 * Token Redaction Utility
 *
 * Masks sensitive tokens in strings to prevent exposure in logs, error messages,
 * and persisted state. Covers Slack, Telegram, and generic Bearer/Bot tokens.
 *
 * @see https://github.com/Yeachan-Heo/oh-my-claudecode/issues/1162
 */

/**
 * Redact sensitive tokens from a string.
 *
 * Patterns masked:
 * - Slack bot tokens: xoxb-...
 * - Slack app tokens: xapp-...
 * - Slack user/workspace tokens: xoxp-..., xoxa-...
 * - Telegram bot tokens in URL paths: /bot123456:ABC.../method
 * - Telegram bot tokens standalone: 123456789:AAF-abc123...
 * - Bearer and Bot authorization values
 * - With OMC_REDACT_KEY_SHAPES=1 (opt-in): key shapes and NAME=value assignments
 *   (see redactKeyShapes)
 */
export function redactTokens(input: string): string {
  const masked = input
    // Slack tokens: xoxb-..., xapp-..., xoxp-..., xoxa-...
    .replace(/\b(xox[bpae]-)[A-Za-z0-9-]+/g, '$1****')
    .replace(/\b(xapp-)[A-Za-z0-9-]+/g, '$1****')
    // Telegram bot tokens in URL paths: /bot123456:ABC.../
    .replace(/\/bot(\d+):[A-Za-z0-9_-]+/g, '/bot$1:****')
    // Telegram bot tokens standalone: 123456789:AAHfoo-bar_Baz
    .replace(/\b(\d{8,12}):[A-Za-z0-9_-]{20,}\b/g, '$1:****')
    // Bearer/Bot authorization values in error strings
    .replace(/(Bearer\s+)\S+/gi, '$1****')
    .replace(/(Bot\s+)\S+/gi, '$1****')
    // Anthropic API keys: sk-ant-api...
    .replace(/\b(sk-ant-api)[A-Za-z0-9_-]+/g, '$1****')
    // GitHub tokens: ghp_, gho_, ghs_, github_pat_
    .replace(/\b(ghp_)[A-Za-z0-9]+/g, '$1****')
    .replace(/\b(gho_)[A-Za-z0-9]+/g, '$1****')
    .replace(/\b(ghs_)[A-Za-z0-9]+/g, '$1****')
    .replace(/\b(github_pat_)[A-Za-z0-9_]+/g, '$1****')
    // AWS access key IDs: AKIA...
    .replace(/\b(AKIA)[A-Z0-9]{16}\b/g, '$1****');
  return process.env.OMC_REDACT_KEY_SHAPES === '1' ? redactKeyShapes(masked) : masked;
}

/**
 * The start of `text` for a log line: its first `max` characters, followed by `...` when there is more.
 * `cut` is how many characters of `text` the caller really uses (for example what it types into a pane);
 * the rest is ignored.
 *
 * With OMC_REDACT_KEY_SHAPES=1 the whole text is redacted before it is cut, so a key that starts shortly
 * before the cut cannot leave a fragment that is too short to be recognized as a key. Without the switch the
 * text is cut first, and the caller's own redaction masks what is left, so the output does not change.
 */
export function redactedPreview(text: string, max: number, cut: number = text.length): string {
  const shown = (process.env.OMC_REDACT_KEY_SHAPES === '1' ? redactTokens(text) : text).slice(0, cut);
  return `${shown.slice(0, max)}${shown.length > max ? '...' : ''}`;
}

// Key prefixes and the minimum number of characters that must follow each prefix.
const REDACT_KEY_SHAPES_PREFIXES: ReadonlyArray<readonly [prefix: string, minLength: number]> = [
  ['sk-', 8],
  ['sk_live_', 16],
  ['sk_test_', 16],
  ['rk_', 16],
  ['AIza', 20],
  ['gsk_', 20],
  ['xai-', 20],
  ['hf_', 20],
];

// Name fragments that make a NAME=value or NAME: value assignment a candidate (matched case-insensitively).
const REDACT_KEY_SHAPES_PHRASES = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'PASS', 'PWD', 'CREDENTIALS'];

function isWordChar(code: number): boolean {
  return code === 95 || (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122); // [A-Za-z0-9_]
}

function isTokenChar(code: number): boolean {
  return code === 45 || isWordChar(code); // [A-Za-z0-9_-]
}

/**
 * The end of the NAME that starts at word boundary `i`, or -1 when no assignment name starts there. NAME is
 * the whole run of letters, digits and underscores (whatever its length) and contains one of the phrases.
 * Every run is read once, from its own boundary, so the total cost over an input is linear.
 */
function assignmentNameEnd(input: string, i: number): number {
  const n = input.length;
  let j = i;
  while (j < n && isWordChar(input.charCodeAt(j))) j++;
  if (j - i < 3) return -1; // shorter than every phrase
  const name = input.slice(i, j).toUpperCase();
  return REDACT_KEY_SHAPES_PHRASES.some((phrase) => name.includes(phrase)) ? j : -1;
}

/** Tables over one input that are built the first time an assignment needs them. */
interface KeyShapeTables {
  /** Per quote character: for every position, the end of a value scanned from there (see valueEnds). */
  ends: Map<string, Int32Array>;
  /** For every position p, the index of the first `]` at or after p, or -1. */
  closeFrom?: Int32Array;
  /** Positions of the quote and bracket run after a name that have been followed already. */
  followed?: Uint8Array;
}

function isSkippable(c: string | undefined): boolean {
  return c === '"' || c === "'" || c === '[' || c === ']';
}

/**
 * The positions of the separators (`=` or `:`) that can belong to the NAME that ends at `from`. Quotes, `]` and
 * `[index]` parts of any length may stand between the name and the separator, and spaces and tabs may stand
 * before the separator. A `[` is read both ways: as the start of an index, which is jumped over up to the next
 * `]`, and as an ordinary character, so that an index that swallows the separator (`PASSWORD[=x ]`) cannot
 * hide it. Every position is followed at most once for the whole input (a position gives the same separators
 * whichever name led to it), so the total cost is linear however many names and brackets there are.
 */
function separatorsAfter(input: string, from: number, tables: KeyShapeTables): number[] {
  const n = input.length;
  const found: number[] = [];
  const leaf = (start: number): void => {
    let k = start;
    while (k < n && (input[k] === ' ' || input[k] === '\t')) k++;
    if (input[k] === '=' || input[k] === ':') found.push(k);
  };
  if (!isSkippable(input[from])) { // the usual case: nothing stands between the name and the separator
    leaf(from);
    return found;
  }
  const followed = (tables.followed ??= new Uint8Array(n + 1));
  const stack = [from];
  while (stack.length > 0) {
    const k = stack.pop() as number;
    if (followed[k]) continue;
    followed[k] = 1;
    if (!isSkippable(input[k])) {
      leaf(k);
      continue;
    }
    if (input[k] === '[') {
      const close = (tables.closeFrom ??= closeIndexes(input))[k + 1];
      if (close >= 0) stack.push(close + 1);
    }
    stack.push(k + 1);
  }
  return found;
}

function closeIndexes(input: string): Int32Array {
  const n = input.length;
  const closeFrom = new Int32Array(n + 1);
  closeFrom[n] = -1;
  for (let p = n - 1; p >= 0; p--) closeFrom[p] = input.charCodeAt(p) === 93 ? p : closeFrom[p + 1];
  return closeFrom;
}

/**
 * For every position p of `input`, the end of a value that is scanned from p (`ends[p]`), so that the end of
 * any value is found in constant time and values that contain other values never make the scan quadratic.
 * A quoted value ends at the next matching quote or line break; in double quotes a backslash escapes the
 * next character, but never a line break; in single quotes it is literal. A bare value ends at a space, tab,
 * line break, quote, `&`, `;`, `|`, `,`, `)` or `}`.
 */
function valueEnds(input: string, quote: string): Int32Array {
  const n = input.length;
  const ends = new Int32Array(n + 1);
  ends[n] = n;
  for (let p = n - 1; p >= 0; p--) {
    const c = input[p];
    if (quote ? c === quote || c === '\n' : ' \t\r\n"\'&;|,)}'.includes(c)) ends[p] = p;
    else if (quote === '"' && c === '\\' && p + 1 < n && input[p + 1] !== '\n') ends[p] = ends[p + 2];
    else ends[p] = ends[p + 1];
  }
  return ends;
}

/**
 * Key shapes that the regex rules above do not cover, found in linear time
 * (no regular expressions, so no backtracking). Applied after those rules.
 *
 * - Prefixed keys: the prefix stays visible and the rest is replaced by `****`
 *   (for example `sk-****`). The minimum length counts the characters after the prefix.
 * - JWTs: three base64url segments, the first starting with `eyJ`; masked as `eyJ***`.
 * - NAME=value and NAME: value, where NAME contains KEY, TOKEN, SECRET, PASSWORD,
 *   PASSWD, PASS, PWD or CREDENTIALS (matched case-insensitively, anywhere in the name). The name and the
 *   quotes and `[index]` parts between it and the separator have no length limit (see separatorsAfter).
 *   A quoted value runs to the matching quote on the same line, or to the end of the line when the quote is
 *   missing (a truncated preview); see valueEnds for escapes and for where a bare value ends.
 *
 * Every word boundary is examined on its own, by all three rules, so that nothing a rule has already matched
 * can hide a later one: a value can contain the name of another assignment (a quote that opens the next value
 * was taken as the closing quote, `abc:TOKEN="x"`), and a key can be followed by one (`sk-...-PASSWORD=x`).
 * Masks that overlap are merged into one. The only starts that are skipped are those that provably end where
 * the start before them ended (inside the run of characters of a key or of a JWT's first segment), so their
 * masks lie inside masks that were already made.
 */
function redactKeyShapes(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return input;
  const n = input.length;
  const ranges: Array<[start: number, end: number, mask: string]> = [];
  const tables: KeyShapeTables = { ends: new Map() };
  let keySkipUntil = 0;
  let jwtSkipUntil = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0 && isWordChar(input.charCodeAt(i - 1))) continue; // not a word boundary (\b)
    const nameEnd = assignmentNameEnd(input, i);
    if (nameEnd >= 0) {
      for (const separator of separatorsAfter(input, nameEnd, tables)) {
        let valueStart = separator + 1;
        while (valueStart < n && (input[valueStart] === ' ' || input[valueStart] === '\t')) valueStart++;
        const quote = input[valueStart] === '"' || input[valueStart] === "'" ? input[valueStart] : '';
        if (quote) valueStart++;
        let table = tables.ends.get(quote);
        if (!table) tables.ends.set(quote, (table = valueEnds(input, quote)));
        if (table[valueStart] > valueStart) ranges.push([valueStart, table[valueStart], '****']);
      }
    }
    if (i >= keySkipUntil) {
      for (const [prefix, minLength] of REDACT_KEY_SHAPES_PREFIXES) {
        if (!input.startsWith(prefix, i)) continue;
        let j = i + prefix.length;
        while (j < n && isTokenChar(input.charCodeAt(j))) j++;
        if (j - (i + prefix.length) >= minLength) {
          ranges.push([i + prefix.length, j, '****']);
          keySkipUntil = j;
        }
        break; // at most one prefix can match at a position
      }
    }
    if (i >= jwtSkipUntil && input.startsWith('eyJ', i)) {
      let j = i + 3;
      while (j < n && isTokenChar(input.charCodeAt(j))) j++;
      jwtSkipUntil = j; // an "eyJ" inside this run ends its first segment at j as well and meets the same later segments
      if (j - i >= 11 && input[j] === '.') {
        let k = j + 1;
        while (k < n && isTokenChar(input.charCodeAt(k))) k++;
        if (k - (j + 1) >= 8 && input[k] === '.') {
          let m = k + 1;
          while (m < n && isTokenChar(input.charCodeAt(m))) m++;
          if (m - (k + 1) >= 8) ranges.push([i + 3, m, '***']);
        }
      }
    }
  }
  if (ranges.length === 0) return input;
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [start, end, mask] of ranges) {
    if (start < pos) { // overlap: merge into the earlier mask
      if (end > pos) pos = end;
      continue;
    }
    out += input.slice(pos, start) + mask;
    pos = end;
  }
  return out + input.slice(pos);
}
