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
 * Key shapes that the regex rules above do not cover, found by one linear scan
 * (no regular expressions, so no backtracking). Applied after those rules.
 *
 * - Prefixed keys: the prefix stays visible and the rest is replaced by `****`
 *   (for example `sk-****`). The minimum length counts the characters after the prefix.
 * - JWTs: three base64url segments, the first starting with `eyJ`; masked as `eyJ***`.
 * - NAME=value and NAME: value, where NAME contains KEY, TOKEN, SECRET, PASSWORD,
 *   PASSWD, PASS, PWD or CREDENTIALS (matched case-insensitively, anywhere in the name).
 *   Quoted values are masked up to the matching quote on the same line.
 */
function redactKeyShapes(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return input;
  const n = input.length;
  const ranges: Array<[start: number, end: number, mask: string]> = [];
  let i = 0;
  // After a failed JWT check the token run [i, j) has no dot after its first segment, so every "eyJ"
  // starting inside it fails the same way; skip them to keep the scan linear.
  let jwtSkipUntil = -1;
  while (i < n) {
    if (i > 0 && isWordChar(input.charCodeAt(i - 1))) { i++; continue; } // not a word boundary (\b)
    let hit: [number, number, string] | null = null;
    for (const [prefix, minLength] of REDACT_KEY_SHAPES_PREFIXES) {
      if (!input.startsWith(prefix, i)) continue;
      let j = i + prefix.length;
      while (j < n && isTokenChar(input.charCodeAt(j))) j++;
      if (j - (i + prefix.length) >= minLength) hit = [i + prefix.length, j, '****'];
      break; // at most one prefix can match at a position
    }
    if (!hit && i >= jwtSkipUntil && input.startsWith('eyJ', i)) {
      let j = i + 3;
      while (j < n && isTokenChar(input.charCodeAt(j))) j++;
      if (j - i >= 11 && input[j] === '.') {
        let k = j + 1;
        while (k < n && isTokenChar(input.charCodeAt(k))) k++;
        if (k - (j + 1) >= 8 && input[k] === '.') {
          let m = k + 1;
          while (m < n && isTokenChar(input.charCodeAt(m))) m++;
          if (m - (k + 1) >= 8) hit = [i + 3, m, '***'];
        }
      }
      if (!hit) jwtSkipUntil = j;
    }
    if (!hit) {
      // NAME=value or NAME: value, with an optional ["index"] or quotes after the name
      let j = i;
      while (j < n && j - i < 64 && isWordChar(input.charCodeAt(j))) j++;
      const name = input.slice(i, j).toUpperCase();
      if (j - i >= 3 && REDACT_KEY_SHAPES_PHRASES.some((phrase) => name.includes(phrase))) {
        let k = j;
        // Scan through optional quotes and brackets (e.g. NAME["index"] or NAME['key'])
        // to find the assignment separator. Bound the total scan to avoid quadratic retries
        // on inputs like 'KEY' + '[KEY]'.repeat(10000).
        const maxBracketScan = Math.min(256, n - k); // limit lookahead to 256 chars from name end
        const scanEnd = k + maxBracketScan;
        while (k < scanEnd && (input[k] === '"' || input[k] === "'" || input[k] === '[' || input[k] === ']')) {
          if (input[k] === '[') {
            let z = k + 1;
            while (z < n && z - k <= 64 && input[z] !== ']') z++;
            k = input[z] === ']' ? z + 1 : k + 1;
          } else {
            k++;
          }
        }
        while (k < n && (input[k] === ' ' || input[k] === '\t')) k++;
        if (input[k] === '=' || input[k] === ':') {
          k++;
          while (k < n && (input[k] === ' ' || input[k] === '\t')) k++;
          const quote = input[k] === '"' || input[k] === "'" ? input[k] : '';
          if (quote) k++;
          const valueStart = k;
          let valueEnd = valueStart;
          if (quote) {
            // quoted value: up to the matching closing quote (not escaped) on the same line, or to line/input end
            while (valueEnd < n && input[valueEnd] !== '\n') {
              if (input[valueEnd] === '\\' && valueEnd + 1 < n) {
                // Skip escaped character (including escaped quotes)
                valueEnd += 2;
              } else if (input[valueEnd] === quote) {
                // Found closing quote
                break;
              } else {
                valueEnd++;
              }
            }
            // Mask if we found content, even if the closing quote is missing (truncated input)
            if (valueEnd > valueStart) hit = [valueStart, valueEnd, '****'];
          } else {
            // bare value: up to a separator, like [^\s"'&;|),}]+
            while (valueEnd < n && !' \t\r\n"\'&;|,)}'.includes(input[valueEnd])) valueEnd++;
            if (valueEnd > valueStart) hit = [valueStart, valueEnd, '****'];
          }
        }
      }
    }
    if (hit) {
      ranges.push(hit);
      i = hit[1];
      continue;
    }
    i++;
  }
  if (ranges.length === 0) return input;
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [start, end, mask] of ranges) {
    if (start < pos) continue; // overlap: the earlier mask wins
    out += input.slice(pos, start) + mask;
    pos = end;
  }
  return out + input.slice(pos);
}
