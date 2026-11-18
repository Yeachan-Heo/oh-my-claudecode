/**
 * Secret masking for the state a Jev point sends to the API and keeps in the shadow log: every line that
 * names a secret path is omitted, every string goes through maskSecrets, and the value under a key that
 * names a secret (password, token, ...) is replaced. Fail closed: a state this cannot mask completely
 * (a cycle, too deep, too large, a throwing toJSON) is an error, never a partial result.
 *
 * No Node imports and no Node APIs, like jev-mask.mjs. The first part of SECRET_PATH is a copy of the
 * expression in hooks/jev-compaction.mjs (a hooks module may import only plain files of its plugin, and the
 * test of that module pins its imports); src/__tests__/jev-state-mask.test.mjs checks that everything the
 * compaction expression catches is caught here too.
 */

import { maskPrivateKeys, maskSecrets } from './jev-mask.mjs';

// Secret paths: SSH keys (every file in a .ssh directory but known_hosts*, authorized_keys*, config, config.d/,
// environment, rc and *.pub, and an id_rsa, id_dsa, id_ecdsa or id_ed25519 key anywhere), git and gh credentials,
// Claude Code credentials, AWS credentials, .netrc (_netrc on Windows), .env and .envrc files (not a .example
// template), each also as a renamed copy (a prefix or a copy suffix: old_id_rsa, id_rsa.bak, backup.ssh/,
// .ssh.bak/, .ssh2/, .sshkeys/, old.netrc, backup.env, my-app.env, .env.production.local; a .ssh directory name goes
// on only with a digit, a punctuation mark, a copy word or keys, so .sshuttle/ is not one). A .netrc or .env name starts after a
// separator, a quote, or a shell or prose delimiter, never inside a code identifier (`ctx.env`, `ctx.app.env`). A
// .env name ends before such a delimiter, a glob or backup mark (* ~ #) or a dot that ends a sentence
// (`/repo/.env:2:` of grep, "edit .env, then", "in `.env`."), not before a slash (a `.env/` directory). Every prefix
// and suffix is bounded, so the check stays linear.
const SECRET_START = String.raw`(?:^|[\s"'\x60\\/=;|&<>()[\]{},:@*])`;
const SECRET_NAME = String.raw`[^\s"'\x60\\/=;|&<>()[\]{},:@*]`;
const SECRET_FILE = String.raw`[^\s"'\x60\\/;|&<>()[\]{},:]`;
const SECRET_ENV = String.raw`\.env(?:rc)?(?:[._-](?!example(?![a-z0-9]))[a-z0-9]+){0,4}(?=$|[\s"'\x60;|&<>()[\]{},:!?*~#]|\.(?![a-z0-9_-]))`;
const COMPACTION_SECRET_PATH = new RegExp([
  String.raw`[\\/][^\s"'\\/]{0,80}\.ssh(?:(?:[^a-z\s"'\\/]|bak|backup|old|orig|save|copy|prev|new|tmp|temp|keys?|archive)[^\s"'\\/]{0,80})?[\\/]+(?!known_hosts|authorized_keys|(?:config|environment|rc)(?!${SECRET_FILE})|config\.d[\\/])(?!${SECRET_FILE}{0,255}\.pub(?!${SECRET_FILE}))${SECRET_FILE}+`,
  `${SECRET_START}${SECRET_NAME}{0,80}id_(?:rsa|dsa|ecdsa|ed25519)(?![a-z])(?!${SECRET_NAME}{0,80}\\.pub(?!${SECRET_NAME}))`,
  String.raw`\.git-credentials\b`,
  String.raw`[\\/]\.config[\\/]+gh[\\/]+hosts\.ya?ml\b`,
  String.raw`\.credentials\.json\b`,
  String.raw`[\\/][^\s"'\\/]{0,80}\.aws[^\s"'\\/]{0,80}[\\/]+credentials\b`,
  `${SECRET_START}${SECRET_NAME}{0,80}[._]netrc\\b`,
  `${SECRET_START}${SECRET_ENV}`,
  // a named env file (prod.env, backup.env, my-app.env, x_1.env); its prefix has no dot, so code such as ctx.app.env is not one
  `${SECRET_START}[^\\s"'\\x60\\\\/=;|&<>()[\\]{},:@*.]{0,80}(?:prod|production|dev|development|staging|stage|test|local|secrets?|private|credentials?|app|docker|db|database|api|backup|bak|copy|old|orig|save|[-_0-9])${SECRET_ENV}`,
].join('|'), 'i');

// More general secret paths than the compaction module knows, for the state of every point (the compaction
// module is not changed): a secrets directory (/run/secrets/x, ./secrets/a, src/secrets/b.ts too: code under
// such a directory is cut as well, on purpose), a file named exactly credentials, and a passwords file
// (passwords, passwords.txt, passwords.kdbx, but not passwords.ts or passwords.test.mjs). A name in code
// (ctx.credentials, credentials.ts, getCredentials(), secretsManager) is none of these.
const PATH_END = String.raw`(?=$|[\s"'\x60;|&<>()[\]{},:!?*~#]|\.(?![a-z0-9_-]))`;
const PASSWORDS_EXT = String.raw`(?:txt|csv|tsv|kdbx?|json|ya?ml|xlsx?|ods|db|sqlite3?|dat|bak|old|enc|gpg|asc)`;
export const SECRET_PATH = new RegExp([
  COMPACTION_SECRET_PATH.source,
  `${SECRET_START}secrets[\\\\/]+${SECRET_FILE}`,
  `[\\\\/]credentials${PATH_END}`,
  `[\\\\/]passwords(?:\\.${PASSWORDS_EXT})?${PATH_END}`,
  `${SECRET_START}passwords\\.${PASSWORDS_EXT}${PATH_END}`,
].join('|'), 'i');

/** What a line that names a secret path becomes (the path and the rest of the line stay out). */
export const SECRET_LINE = '[line omitted: secret path]';
/** What the value under a key that names a secret becomes. */
export const MASKED_VALUE = '***';
/** What a key that names a secret path becomes (numbered when several keys collide). It names no secret word, so a second pass leaves its value alone. */
export const KEY_OMITTED = '[key omitted: path]';
export const MAX_STATE_DEPTH = 64;
export const MAX_STATE_NODES = 50_000;
/**
 * With a window (maxChars), the most characters the mask reads in all: a string counts for at most its window
 * (maxChars + WINDOW_MARGIN + LINE_EXTENSION), once for each time a rule reads it (a string is read at most twice: to
 * classify it and to mask it; the end of an argument of a command is read once more, up to PATH_TAIL, to tell its
 * program, and that counts when it goes beyond the window). A state that needs more is an error, so the work of the mask
 * has a bound that does not depend on the size of the state. Never less than sixteen windows, so a large window that
 * the caller asked for does not refuse a state by its size alone.
 */
export const MAX_STATE_CHARS = 4_000_000;
/** A string longer than maxChars plus this is cut before it is masked: the part beyond is never sent. */
export const WINDOW_MARGIN = 512;
/** How far past the cut the last line of a cut text is read, to find a secret path in it: the rest of a longer line is not read. */
export const LINE_EXTENSION = 4096;
/**
 * How far from its end an argument of a command is read to tell its program (the base name: what follows the last / or \).
 * A path that long is rare (PATH_MAX is 4096 on Linux, a file name is at most 255 characters). An argument longer than this
 * with no separator in its last PATH_TAIL characters has a base name that starts further back: it is taken for a program
 * that takes a password (fail closed: the mask hides more, never less, than it would with the whole argument).
 */
export const PATH_TAIL = 4096;

export class JevStateMaskError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'JevStateMaskError';
  }
}

/** A string of the state that is not empty was replaced whole by SECRET_LINE: what is left says nothing, so the state is not sent. */
export class JevStateFieldOmittedError extends JevStateMaskError {
  constructor(message, options) {
    super(message, options);
    this.name = 'JevStateFieldOmittedError';
  }
}

// A key names a secret when it has one of the strong words (password, passwd, passphrase, secret, token,
// credential, apikey), alone or glued to a prefix (dbpassword, apitoken, clientsecret, mypassphrase), or one of
// the weak words (pass, pwd, cookie, bearer, api key, access key, private key, authorization) between separators,
// camelCase humps or acronym ends (accessToken, DBPassword, api_key, api.key, Client-Secret, AWS_SECRET_ACCESS_KEY,
// password2): a digit run may follow, and the words of "api key" and the like may be set apart by any one
// character that is no letter or digit. The plural counts for the strong words and for "tokens" as the last word
// (accessTokens, refresh_tokens), not for pass and pwd. Not "tokenizer", "secretary", "passwordless", "bypass",
// "compass", "passenger", "passes" or "tokens_used". "secretsManager" and "cookieJar" are secret keys on purpose:
// what they hold is secrets. A key that ends with "tokens" is also a counter (COUNTER_KEY): a number under it stays,
// a string, array or object under it is masked.
const SECRET_KEY = new RegExp(
  '(?:(?:passwords?|passwd|passphrases?|secrets?|token|credentials?|apikeys?)\\d*(?:[^a-z0-9]|$)' +
  '|(?:^|[^a-z0-9])(?:pass|pwds?|cookies?|bearer|api[^a-z0-9]?keys?|access[^a-z0-9]?keys?|private[^a-z0-9]?keys?|client[^a-z0-9]?secrets?|authorization)\\d*(?:[^a-z0-9]|$)' +
  '|tokens\\d*$)',
);
// A number under such a key that counts or measures something (token_count, password_length, tokenBudget) stays, at any
// depth: a number is no text, and a number under a key that names no secret is left as well, so this is no gap that
// the name opens. A string, array or object under a counter key is masked.
const COUNTER_KEY = /(?:tokens|(?:^|[^a-z0-9])(?:count|length|len|budget|usage|size))$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// What a key name does here, all of it: the value under a key that names a secret is replaced (at any depth); a number
// under a key that counts something stays (above); and an exact UUID under the key `session_id` of the state itself
// (its top level: the loop-continuation point puts the id of the session there) stays, which maskSecrets would take for
// a token. No key name lets a string skip a rule of the text mask: under `toolInput`, `args`, in an array or anywhere
// deeper than the top, a `session_id` or a `cwd` is a string like any other (the grid test in
// src/__tests__/jev-state-mask.test.mjs covers every such key at every depth and parent). With a window, a name longer than
// the window is not read at all: it names a secret (see maskJevState).

/**
 * The name of a key as the classification reads it: our own two markers taken out (they name no secret, and
 * "[line omitted: secret path]" would make a second pass see one), the words split at camelCase humps and acronym
 * ends, in lower case. The markers go by exact text (a key that only looks like one, "[key omitted: password]",
 * keeps its words) and the rest is one pass over the key with no backtracking, so the cost grows with the length of
 * the key and no more (maskJevState calls it only for a name that fits the window).
 */
export function normalizeKey(key) {
  const cleaned = key.split(KEY_OMITTED).join('').split(SECRET_LINE).join('');
  // Linear-time acronym splitter: insert underscores at word boundaries without backtracking regexes.
  // Boundaries: (1) uppercase sequence before an uppercase+lowercase pair, (2) lowercase/digit before uppercase.
  const chars = cleaned.split('');
  const result = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const prev = i > 0 ? chars[i - 1] : '';
    const next = i < chars.length - 1 ? chars[i + 1] : '';
    // Insert underscore before uppercase letter if preceded by lowercase/digit or if part of acronym break
    if (c === c.toUpperCase() && c !== c.toLowerCase() && i > 0) {
      const prevIsLower = prev === prev.toLowerCase() && prev !== prev.toUpperCase();
      const prevIsDigit = /[0-9]/.test(prev);
      const nextIsLower = next === next.toLowerCase() && next !== next.toUpperCase();
      const prevIsUpper = prev === prev.toUpperCase() && prev !== prev.toLowerCase();
      // Break before uppercase if preceded by lowercase/digit, or if this is the start of a new acronym (preceded by uppercase, followed by lowercase)
      if (prevIsLower || prevIsDigit || (prevIsUpper && nextIsLower)) {
        result.push('_');
      }
    }
    result.push(c.toLowerCase());
  }
  return result.join('');
}

// What a name says about its value, 'secret' (the value is masked, a number too), 'counter' (a number stays) or false: the
// label of a value. A normalized name is null when the name is longer than the window (see maskJevState): such a name
// cannot be read in full for a cost that stays bounded, so it names a secret.
function secretKindOf(normalized) {
  if (normalized === null) return 'secret';
  if (!SECRET_KEY.test(normalized)) return false;
  return COUNTER_KEY.test(normalized) ? 'counter' : 'secret';
}
// Two labels of the same value (several names beside it): the stricter one wins, so the result does not depend on the
// order of the names. 'secret' beats 'counter' beats false.
function stricter(a, b) {
  return a === 'secret' || b === 'secret' ? 'secret' : a || b;
}

// What becomes of a value: the one place where everything that classifies it meets, used for the value under a key, in a pair
// of an object, in an array and in a pair of two elements. The label says what its name makes of it ('secret', 'counter' or
// false, see stricter) and the argument what its place among the arguments of a command makes of it ('secret' for the
// element after an option whose value is a credential, or 'partial' for an element that holds a credential in part of it, see
// CREDENTIAL_OPTIONS). The order, strongest first, is the same everywhere:
//   1. a secret label or a secret argument: the value is replaced whole, a number too;
//   2. a counter label: a number stays, anything else (a string, an array, an object) is replaced whole;
//   3. a partial argument: the credential in the element is replaced and the rest of the element is judged by the
//      text rules. It applies only when 1 and 2 do not: a label always decides over a partial argument;
//   4. nothing: a string goes through the text rules, an array or an object is walked, a number stays.
// Returns 'secret', 'counter', 'partial', or false.
export function treatment(label, argument) {
  const whole = stricter(label, argument === 'secret' ? 'secret' : false);
  return whole || argument || false;
}

// Pairs: the value of { name: 'DB_PASSWORD', value: x }, { key: 'apiToken', value: x }, { Name, Value },
// { ParameterKey, ParameterValue } and the second element of a ['Authorization', 'Basic abc'] pair is masked when the
// name is a secret name, "pass" too (the same word as a key masks the value of the key, and Object.entries turns a key and
// its value into such a pair, so a list of results such as ['pass', 'fail'] loses its second element: that is the price).
const PAIR_NAME = new Set(['name', 'key', 'parameter_key']);
const PAIR_VALUE = new Set(['value', 'parameter_value']);
// Options of a command line that carry a credential, in ONE table: the rules for the text (maskOptions) and the rules for an array
// of arguments (secretArguments) are both built from it, so an option that one of them knows is known to the other in every way it
// can be written:
//   - apart: the value is the next word or argument (`--user u:p`, `-u u:p`, `-p x`);
//   - joined: a long name with `=` (`--user=u:p`), a short letter with the value stuck to it (`-uu:p`, `-px`) or with `=` (`-u=u:p`);
//   - in a cluster of flags that take no value, the letter last (`-sSu u:p`, `-sSuu:p`);
//   - in text, the value or the whole option in quotes (a quoted value runs to its closing quote, white space included), a backslash
//     before a space, each element quoted (`'-u' 'u:p'`, `"-p", "x"`); in an array the element is the value, white space and quotes
//     included. After `--` nothing changes: what looks like an option is masked all the same (fail closed).
// A long name is read in any case, a short letter is case sensitive (`-U` is not `-u`, and `-P` of mysql takes a port). `value` is 'all'
// (the value is the credential) or 'user' (`name:password`: the password, the part after the first colon, is). `program`: the option
// is a credential only after a program of this kind in the same command (in an array: before it in the list; in text: before it in
// the same command, which a new line, `|`, `;` or `&` outside quotes ends), as -p is for the mysql family and sshpass (docker login -p
// and ssh -p are not). `flags` are the short flags of the program that take no value and may stand before the letter in a cluster.
// To know another option, add a row here: both paths and the grid test (src/__tests__/jev-state-mask-options.test.mjs) take it from it.
export const PROGRAMS = Object.freeze({
  mysql: Object.freeze(['mysql', 'mysqldump', 'mysqladmin', 'mariadb', 'sshpass']),
  curl: Object.freeze(['curl']),
  'redis-cli': Object.freeze(['redis-cli']),
});
const CURL_FLAGS = '0123469aBfgGhiIjJklLMnNOpqRsSvVZ#';
const MYSQL_FLAGS = '?ABbCcEfGHiILnNoqrstTUvVwWX';
export const CREDENTIAL_OPTIONS = Object.freeze([
  { names: Object.freeze(['password', 'passwd', 'pass', 'token', 'secret', 'api-key', 'apikey', 'access-token', 'auth-token', 'client-secret', 'http-password', 'ftp-password', 'proxy-password', 'oauth2-bearer', 'cookie']), value: 'all' },
  { names: Object.freeze(['user', 'proxy-user']), value: 'user' },
  { letter: 'u', flags: CURL_FLAGS, value: 'user' },
  { letter: 'U', flags: CURL_FLAGS, value: 'user', program: 'curl' },
  { letter: 'b', flags: CURL_FLAGS, value: 'all', program: 'curl' },
  { letter: 'p', flags: MYSQL_FLAGS, value: 'all', program: 'mysql' },
  { letter: 'a', flags: '', value: 'all', program: 'redis-cli' },
].map(Object.freeze));

const PROGRAM_KINDS = Object.keys(PROGRAMS);
// What the program of a command looks like: in an array the base name of an argument (see programsOf), in text a word of its own.
const PROGRAM_NAME = Object.fromEntries(PROGRAM_KINDS.map((kind) => [kind, new RegExp(`^(?:${PROGRAMS[kind].join('|')})(?![a-z0-9_])`, 'i')]));
// In text: a program of the kind, as a word of its own (what the lexer reports, see lexShell).
const PROGRAM_EVENTS = Object.fromEntries(PROGRAM_KINDS.map((kind) => [kind, new RegExp(`(?<![A-Za-z0-9_])(?:${PROGRAMS[kind].join('|')})(?![A-Za-z0-9_])`, 'gi')]));
const OPTION_RULES = CREDENTIAL_OPTIONS.map((option) => {
  const long = option.names !== undefined;
  const name = long ? `--(?:${option.names.join('|')})` : `-${option.flags ? `[${option.flags}]*` : ''}${option.letter}`;
  const flags = long ? 'i' : '';
  return {
    program: option.program,
    value: option.value,
    // an argument that is the option alone: the value is the next argument
    alone: new RegExp(`^${name}$`, flags),
    // an argument that holds the option and its value: the first group stays, the rest is the value
    joined: new RegExp(`^(${name}${long ? '=' : ''})([\\s\\S]+)$`, flags),
    // text: the option at the start of a word (after white space, a quote or the start of the text); a long name ends before what follows it
    text: new RegExp(`(?<![^\\s'"])${name}${long ? `(?=[=\\s'",]|$)` : ''}`, `g${flags}`),
    long,
  };
});

/**
 * The credential of a value of an option, replaced: all of it ('all'), or the password of `name:password` ('user': the part after the
 * first colon; no colon, or nothing after it, leaves the value as it is). A value in quotes keeps its closing quote, and what closes a
 * list or a call after it (a "-u", "name:password", of a list written out as text), so that the quotes of the text stay in pairs.
 * `closeAt(i)` tells where the quote that opens at index i of the value closes (-1: nowhere), as the lexer reads it.
 */
function maskCredential(kind, value, closeAt = (i) => lexShell(value).closeAt(i)) {
  if (kind === 'all') return MASKED_VALUE;
  const colon = value.indexOf(':');
  if (colon === -1) return value;
  // the value may open with an = (-u='name:password'), then the quote, which a $ may stand before ($'name:password')
  let at = value[0] === '=' ? 1 : 0;
  if (value[at] === '$' && value[at + 1] === "'") at++;
  const quote = value[at] === "'" || value[at] === '"' ? value[at] : '';
  const close = quote ? closeAt(at) : -1;
  if (close !== -1 && colon < close) {
    if (colon === close - 1) return value;
    const after = value.slice(close + 1);
    return value.slice(0, colon + 1) + MASKED_VALUE + quote + (/^[,\])}]*$/.test(after) ? after : '');
  }
  return colon === value.length - 1 ? value : value.slice(0, colon + 1) + MASKED_VALUE;
}

/** The first index at or after `i` that is no space or tab (and no comma, between the elements of a list written out as text). */
function skipBlanks(text, i, comma) {
  while (i < text.length && (text[i] === ' ' || text[i] === '\t' || (comma && text[i] === ','))) i++;
  return i;
}

// The kinds of region that the lexer opens. A quote of an outer shell holds the text of an inner one (sh -c "mysql -p x") or of JSON:
// the pass does not read inside it (OPAQUE), and a word that starts there ends at its close.
const SQ = 1;
const ANSI = 2;
const DQ = 3;
const SUB = 4;
const BACK = 5;
const GROUP = 6;
const LEX_MAX_DEPTH = 64;
const WHITE = /\s/;

/**
 * THE lexer of this file: one linear pass over a text as a POSIX shell reads it, with no backtracking, and every rule that needs the
 * end of a quote, the end of a word, the end of a command or the program of a command asks it (nothing else looks for one). It knows
 * single quotes (no escapes inside), double quotes (a backslash escapes the next character, `$(` and a back quote open a region
 * inside), ANSI-C quotes $'...' (a backslash escapes), a backslash outside quotes (it is part of the word), `$(...)`, back quotes and
 * (...) groups, and a word is what runs to white space outside all of these: `a"b c"d` is one word. A command ends at a new line,
 * `;`, `&` or `|` that is outside quotes, and a region of commands ($( ), ` ` and ( )) is a command of its own whose end gives the
 * outer command back, so `curl $(a; b) -U u:p` is still curl. A quote that never closes runs to the end of the text (fail closed), and
 * so does everything beyond the nesting depth LEX_MAX_DEPTH. Returns:
 *   closeAt(i)       the index of the quote that closes the quote opening at i, or -1;
 *   wordEnd(start)   the end of the word that starts at `start`; a word that starts inside the quotes of an outer shell ends at their
 *                    close, and a quote or a backslash in that text, which is a shell of its own, takes the rest of it (fail closed);
 *   programSeenAt(kind)  a function that tells, at an offset (they only grow), whether a program of the kind (PROGRAMS) was named in
 *                    the same command before it; a program counts inside quotes too.
 */
function lexShell(text) {
  const n = text.length;
  // close[i] is one more than the index of the character that closes the region opened at i (-1: it opened and never closes, 0: none opened)
  const close = new Int32Array(n + 1);
  const regionOpen = [];
  const regionKind = [];
  const regionParent = [];
  const regionClose = [];
  const stack = [];
  // pairs of [index, what]: 0 a command ends, 1 a region of commands opens, 2 it closes
  const marks = [];
  let tooDeep = -1;
  const open = (kind, at) => {
    if (stack.length >= LEX_MAX_DEPTH) {
      tooDeep = at;
      return;
    }
    regionParent.push(stack.length > 0 ? stack[stack.length - 1] : -1);
    stack.push(regionOpen.length);
    regionOpen.push(at);
    regionKind.push(kind);
    regionClose.push(-1);
    close[at] = -1;
    if (kind >= SUB) marks.push(at, 1);
  };
  const shut = (at) => {
    const id = stack.pop();
    regionClose[id] = at;
    close[regionOpen[id]] = at + 1;
    if (regionKind[id] >= SUB) marks.push(at, 2);
  };
  let dollar = -2;
  let i = 0;
  while (i < n && tooDeep < 0) {
    const kind = stack.length > 0 ? regionKind[stack[stack.length - 1]] : 0;
    if (kind === SQ) {
      const end = text.indexOf("'", i);
      if (end === -1) break;
      shut(end);
      i = end + 1;
      continue;
    }
    const c = text[i];
    if (kind === ANSI || kind === DQ) {
      if (c === '\\') i += 2;
      else if (c === (kind === ANSI ? "'" : '"')) {
        shut(i);
        i++;
      } else if (kind === DQ && c === '$' && text[i + 1] === '(') {
        open(SUB, i + 1);
        i += 2;
      } else if (kind === DQ && c === '`') {
        open(BACK, i);
        i++;
      } else i++;
      continue;
    }
    // a region of commands, or the top
    if (c === '\\') i += 2;
    else if (c === "'") {
      open(dollar === i - 1 ? ANSI : SQ, i);
      i++;
    } else if (c === '"') {
      open(DQ, i);
      i++;
    } else if (c === '`') {
      if (kind === BACK) shut(i);
      else open(BACK, i);
      i++;
    } else if (c === '$') {
      dollar = i;
      if (text[i + 1] === '(') {
        open(SUB, i + 1);
        i += 2;
      } else i++;
    } else if (c === '(') {
      open(GROUP, i);
      i++;
    } else if (c === ')') {
      if (kind === SUB || kind === GROUP) shut(i);
      i++;
    } else {
      if (c === ';' || c === '&' || c === '|' || c === '\n') marks.push(i, 0);
      i++;
    }
  }

  // The innermost region that holds index p (-1: none): the last region that opened before p, or the nearest one around it that is
  // still open at p. The nesting is bounded, so this is a short walk.
  const innermost = (p) => {
    let lo = 0;
    let hi = regionOpen.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (regionOpen[mid] < p) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    while (found !== -1 && regionClose[found] !== -1 && regionClose[found] < p) found = regionParent[found];
    return found;
  };
  const limitOf = (region) => (region === -1 || regionClose[region] === -1 ? n : regionClose[region]);
  const programIndexes = new Map();

  return {
    text,
    // whether a quote opens at `at` (it may never close)
    opens(at) {
      if (close[at] !== 0) return true;
      const quote = text[at];
      if (tooDeep >= 0 && at >= tooDeep) return false;
      // a quote that the pass did not open stands inside the text of an outer quote (the words of an inner shell, a JSON string), where
      // it opens one of its own; anywhere else it closes a quote and opens nothing
      if (quote !== '"' && quote !== "'") return false;
      const region = innermost(at);
      return region !== -1 && regionKind[region] <= DQ;
    },
    // the index of the quote that closes the one opening at `at` (-1: it never closes, or none opens there)
    closeAt(at) {
      if (close[at] > 0) return close[at] - 1;
      if (close[at] < 0 || !this.opens(at)) return -1;
      // closes at its own next quote, within the text it stands in
      const quote = text[at];
      const limit = limitOf(innermost(at));
      for (let j = at + 1; j < limit; j++) {
        if (text[j] === '\\' && quote === '"') j++;
        else if (text[j] === quote) return j;
      }
      // it does not close before the quote around it does (an inner shell's quote written as \" in an outer one): the close of the outer one
      return limit < n ? limit : -1;
    },
    wordEnd(start) {
      if (tooDeep >= 0 && start >= tooDeep) return n;
      const region = innermost(start);
      const limit = limitOf(region);
      const opaque = region !== -1 && regionKind[region] <= DQ;
      let j = start;
      while (j < limit) {
        const c = text[j];
        if (WHITE.test(c)) break;
        if (opaque) {
          // the text of an inner shell: its quotes and escapes are not read here, the word takes the rest of the text (fail closed)
          if (c === "'" || c === '"' || c === '\\' || c === '`' || (c === '$' && text[j + 1] === '(')) return limit;
          j++;
        } else if (c === '\\') j += 2;
        else if (c === "'" || c === '"' || c === '`') {
          if (close[j] < 1) return limit;
          j = close[j];
        } else if (c === '(' || (c === '$' && text[j + 1] === '(')) {
          const at = c === '(' ? j : j + 1;
          if (close[at] > 0) j = close[at];
          else if (c === '(') j++;
          else return limit;
        } else j++;
      }
      return Math.min(j, limit);
    },
    programSeenAt(kind) {
      let programs = programIndexes.get(kind);
      if (programs === undefined) {
        programs = Array.from(text.matchAll(PROGRAM_EVENTS[kind]), (found) => found.index);
        programIndexes.set(kind, programs);
      }
      const seen = [false];
      let p = 0;
      let m = 0;
      return (offset) => {
        if (tooDeep >= 0 && offset >= tooDeep) return true;
        for (;;) {
          const nextProgram = p < programs.length ? programs[p] : Infinity;
          const nextMark = m < marks.length ? marks[m] : Infinity;
          if (Math.min(nextProgram, nextMark) >= offset) break;
          if (nextMark < nextProgram) {
            const what = marks[m + 1];
            if (what === 0) seen[seen.length - 1] = false;
            else if (what === 1) seen.push(false);
            else if (seen.length > 1) seen.pop();
            m += 2;
          } else {
            seen[seen.length - 1] = true;
            p++;
          }
        }
        return seen[seen.length - 1];
      };
    },
  };
}

/** The text with the credential of every option of the table replaced, in every way the option can be written (see CREDENTIAL_OPTIONS). */
function maskOptions(text) {
  let result = text;
  let lexed;
  for (const rule of OPTION_RULES) {
    const pattern = rule.text;
    pattern.lastIndex = 0;
    let out = '';
    let last = 0;
    let seenAt;
    let lex;
    for (let found = pattern.exec(result); found !== null; found = pattern.exec(result)) {
      // the one lexer, for the text as it stands (made when a rule first needs it, again after a rule has changed the text)
      if (lexed?.text !== result) lexed = lexShell(result);
      lex = lexed;
      if (rule.program !== undefined) {
        seenAt ??= lex.programSeenAt(rule.program);
        if (!seenAt(found.index)) continue;
      }
      let start = found.index + found[0].length;
      let end;
      const quote = found.index > 0 ? result[found.index - 1] : '';
      if ((quote === "'" || quote === '"') && lex.opens(found.index - 1)) {
        // the option is quoted itself: its value is inside the same quotes ("--user=u:p w", "-pa b") or it is the next element ('-u' 'u:p', "-p", "x")
        const close = lex.closeAt(found.index - 1);
        if (close === start) {
          start = skipBlanks(result, start + 1, true);
          end = lex.wordEnd(start);
        } else {
          start = result[start] === '=' && rule.long ? start + 1 : skipBlanks(result, start, false);
          end = close === -1 ? result.length : close;
        }
      } else if (rule.long) {
        if (result[start] === '=') start++;
        else if (result[start] === ' ' || result[start] === '\t') start = skipBlanks(result, start, false);
        else continue;
        end = lex.wordEnd(start);
      } else {
        start = skipBlanks(result, start, false);
        end = lex.wordEnd(start);
      }
      if (end <= start) continue;
      out += result.slice(last, start) + maskCredential(rule.value, result.slice(start, end), (i) => {
        const at = lex.closeAt(start + i);
        return at === -1 ? -1 : at - start;
      });
      last = end;
      pattern.lastIndex = end;
    }
    if (last > 0) result = out + result.slice(last);
  }
  return result;
}

// Headers that carry a credential, in ONE table (a header name, and the schemes that stay before the credential): the value of the header
// is replaced to the end of the header, whatever it holds (quotes, white space, `;` and `,` of a cookie) and however it starts. The end of
// the header is the end of the line; when the header is the start of a quoted argument or string (-H "Cookie: a=b", 'X-Api-Key: k', a
// "Cookie": "a=b" of JSON text) it is the close of that quote as the lexer reads it (an escaped quote does not close it). maskSecrets
// knows the single word after Bearer, Basic and Token and a cookie up to a quote; the rest is this, and what this leaves is a fixed point
// of maskSecrets (a test checks it), so a second pass changes nothing.
const HEADER_NAME = String.raw`(?:proxy-)?authorization|(?:set-)?cookie|x-api-key|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token|private-token`;
const HEADERS = new RegExp(String.raw`(?<![A-Za-z0-9_-])(${HEADER_NAME})(["']?)[ \t]*:[ \t]*`, 'gi');
// the schemes of an Authorization header that stay before its credential, so that a second pass changes nothing; the name of any other scheme goes with its credential
const AUTH_SCHEME = /(?:bearer|basic|token)[ \t]+(?=\S)/iy;
const AUTH_NAME = /authorization$/i;

/** The end of the line that holds index `from`. */
function lineEnd(text, from) {
  let i = from;
  while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
  return i;
}

function maskHeaders(text) {
  HEADERS.lastIndex = 0;
  let lex;
  let out = '';
  let last = 0;
  for (let found = HEADERS.exec(text); found !== null; found = HEADERS.exec(text)) {
    lex ??= lexShell(text);
    let start = found.index + found[0].length;
    const before = found.index > 0 ? text[found.index - 1] : '';
    let end;
    if (found[2] !== '') {
      // the name is a key of JSON text ("Cookie": "a=b"): a value in quotes runs to its closing quote, any other to the end of the line
      if ((text[start] === '"' || text[start] === "'") && lex.opens(start)) {
        const close = lex.closeAt(start);
        end = close === -1 ? text.length : close;
        start++;
      } else end = lineEnd(text, start);
    } else if ((before === '"' || before === "'") && lex.opens(found.index - 1)) {
      const close = lex.closeAt(found.index - 1);
      end = Math.min(close === -1 ? text.length : close, lineEnd(text, start));
    } else end = lineEnd(text, start);
    if (end <= start) continue;
    let scheme = 0;
    if (AUTH_NAME.test(found[1])) {
      AUTH_SCHEME.lastIndex = start;
      scheme = AUTH_SCHEME.exec(text)?.[0].length ?? 0;
    }
    if (start + scheme >= end) continue;
    out += `${text.slice(last, start + scheme)}${MASKED_VALUE}`;
    last = end;
    HEADERS.lastIndex = end;
  }
  return last > 0 ? out + text.slice(last) : text;
}

// URL userinfo (RFC 3986 `userinfo@host`, after `//`): the name may be empty (`//:pw@host`), the password is everything after the first
// colon up to the LAST `@` of the authority (a `@` may stand in a password: `//u:p@ss@host`, which the URL parser reads as one password),
// and an authority ends at a `/` or white space. An empty password (`//u:@host`) stays. One function for the whole text and for the
// text of a cut: an authority that runs to the end of a cut text may go on past it, so an `@` in it proves nothing and the password is
// masked from its colon to the end.
const USERINFO = /(\/\/[^/\s:]*:)[^/\s]+@/g;
const USERINFO_CUT = /(\/\/[^/\s:]*:)[^/\s]*$/;

function maskUserinfo(text, cut) {
  return (cut ? text.replace(USERINFO_CUT, `$1${MASKED_VALUE}`) : text).replace(USERINFO, `$1${MASKED_VALUE}@`);
}

/**
 * Whether a string can be the program of a command, and of which kinds (PROGRAMS): the base name (what follows the last / or \) starts
 * with the name of one. The base name is at the end of the string, so it is looked for from the end, in the last `limit` characters,
 * and the cost does not grow with the length of the string. With no separator in them and more string before, the base name starts
 * further back than they reach: it can be any, and the answer is every kind (fail closed).
 */
function programsOf(text, limit) {
  const tail = text.length > limit ? text.slice(-limit) : text;
  const cut = Math.max(tail.lastIndexOf('/'), tail.lastIndexOf('\\'));
  if (cut === -1 && tail.length < text.length) return PROGRAM_KINDS;
  const base = tail.slice(cut + 1);
  return PROGRAM_KINDS.filter((kind) => PROGRAM_NAME[kind].test(base));
}

// What an array of arguments says about its elements, by the table: the elements whose whole value is the credential (`whole`), and
// the elements that hold it in part, as they are with it replaced (`partial`). The elements are the strings as the rules read them
// (the window of each one, see maskJevState) and what is no string; programsAt(i) tells the kinds of programs that element i can be
// (it reads the end of the whole element, which a window does not hold). The name of a pair is not looked at here (see treatment).
function secretArguments(array, programsAt) {
  const whole = new Set();
  const partial = new Map();
  const first = new Map();
  const replace = (i, text) => {
    if (text !== (partial.get(i) ?? array[i])) partial.set(i, text);
  };
  // The kinds of program that an option of the array needs. Only an element that can be such an option asks which program there is, and
  // the ends of the elements are read (and paid for, see maskJevState) only until each of these kinds is found: an array with no such
  // option reads none, and the first program of the one kind it needs ends the reading, as it did when -p was the only one.
  const needed = new Set();
  for (const element of array) {
    if (typeof element !== 'string') continue;
    for (const rule of OPTION_RULES) {
      if (rule.program !== undefined && !needed.has(rule.program) && (rule.alone.test(element) || rule.joined.test(element))) needed.add(rule.program);
    }
  }
  for (let i = 0; i < array.length; i++) {
    const element = array[i];
    if (typeof element !== 'string') continue;
    if (first.size < needed.size) {
      for (const kind of programsAt(i)) if (needed.has(kind) && !first.has(kind)) first.set(kind, i);
    }
    for (const rule of OPTION_RULES) {
      if (rule.program !== undefined && !(first.get(rule.program) < i)) continue;
      if (rule.alone.test(element)) {
        if (i + 1 >= array.length) continue;
        if (rule.value === 'all') whole.add(i + 1);
        else if (typeof array[i + 1] === 'string') replace(i + 1, maskCredential('user', partial.get(i + 1) ?? array[i + 1]));
      } else {
        const joined = rule.joined.exec(element);
        if (joined) replace(i, joined[1] + maskCredential(rule.value, joined[2]));
      }
    }
  }
  return { whole, partial };
}

function omitSecretLines(text) {
  if (!SECRET_PATH.test(text)) return text;
  return text.split('\n').map((line) => (SECRET_PATH.test(line) ? SECRET_LINE : line)).join('\n');
}

// The characters of a token as the rules of maskSecrets see it: the union of what their token classes take inside a
// secret (a test checks it by the behavior of maskSecrets for every printable ASCII character): tokens, API keys,
// JWTs, base64, bearer values (which also take ~). Not the class of the URL rule, which takes much more.
export const TOKEN_CHAR = /[A-Za-z0-9+/=_.~-]/;
/** How far past the cut a run of token characters is followed to its end; a longer run is replaced by *** instead. */
export const RUN_EXTENSION = 4096;

/**
 * The text cut to the part that can reach the first maxChars after masking (maxChars + WINDOW_MARGIN: the
 * mask shortens the text, so more than maxChars of the original can end up in what is sent), with its tail made
 * safe. The rule the mask keeps: every character that is sent was judged by every rule with the whole context
 * that the rule needs. The context of a rule is the rest of the same string without white space (a URL with
 * its "@", a JWT, a long token with the letter and the digit that may come later, "AKIA..." with its end), the
 * same line (a secret path), the text up to a closing mark (a private key block, masked to the end of the text),
 * or what stands before the value (KEY=, authorization:, --password, -u, mysql -p, cookie), which a cut value
 * does not take away. The cut removes context only at its tail, so only the tail has to be made safe, and the
 * tail is read only so far (LINE_EXTENSION, RUN_EXTENSION): the cost of the mask is the window and no more, however
 * long the text is:
 * - the last line, when it is cut: the secret path is looked for in the part of the line that is sent and in the
 *   next LINE_EXTENSION characters of it, and a hit omits the part that is sent (a secret path that starts further
 *   on is nowhere near what is sent);
 * - otherwise the last run of token characters, when the cut is inside one (the next character is one too):
 *   the cut moves to the end of the run, so that every rule sees the whole token (its end, a digit beyond the
 *   old cut); a run longer than RUN_EXTENSION past the cut becomes "***" (fail closed);
 * - maskString then masks a "//user:value" that runs to the end of a cut text (the URL rule needs the "@",
 *   and its value class covers more than token characters, such as ! and #).
 * The tail is looked at on the original text, not after the key block rule has joined lines.
 */
function cutAndCloseTail(text, end) {
  const cut = text.slice(0, end);
  if (text[end] !== '\n') {
    const lineStart = cut.lastIndexOf('\n') + 1;
    const ahead = text.slice(end, end + LINE_EXTENSION);
    const newline = ahead.indexOf('\n');
    const line = cut.slice(lineStart) + (newline === -1 ? ahead : ahead.slice(0, newline));
    if (SECRET_PATH.test(line)) return cut.slice(0, lineStart) + SECRET_LINE;
  }
  if (TOKEN_CHAR.test(cut[end - 1]) && TOKEN_CHAR.test(text[end])) {
    // the cut is inside a run of token characters: let every rule see the whole run when it is short enough
    let stop = end;
    while (stop < text.length && stop - end < RUN_EXTENSION && TOKEN_CHAR.test(text[stop])) stop++;
    if (stop === text.length || !TOKEN_CHAR.test(text[stop])) return text.slice(0, stop);
    let start = end;
    while (start > 0 && TOKEN_CHAR.test(cut[start - 1])) start--;
    return cut.slice(0, start) + '***';
  }
  return cut;
}

/**
 * The text with secret-path lines omitted and secrets masked. Cut to maxChars + WINDOW_MARGIN first when
 * maxChars is given: the caller sends only the first maxChars characters (see cutAndCloseTail).
 */
function maskString(text, maxChars) {
  const cutText = maxChars !== undefined && text.length > maxChars + WINDOW_MARGIN;
  const cut = cutText ? cutAndCloseTail(text, maxChars + WINDOW_MARGIN) : text;
  const omitted = omitSecretLines(maskPrivateKeys(cut));
  return maskSecrets(maskUserinfo(maskHeaders(maskOptions(omitted)), cutText), { keepGitHashes: true });
}

/**
 * Whether what is sent of a masked string says nothing: every non-empty line of its first maxChars characters
 * (all of it without maxChars) is SECRET_LINE. A marker that the edge of the window cut short counts as one.
 */
function fieldOmitted(masked, maxChars) {
  const windowCut = maxChars !== undefined && masked.length > maxChars;
  const lines = (windowCut ? masked.slice(0, maxChars) : masked).split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every((line, i) => line === SECRET_LINE || (windowCut && i === lines.length - 1 && SECRET_LINE.startsWith(line)));
}

/**
 * A new value for a Jev point's state, as JSON would carry it (toJSON honored, functions, symbols and
 * undefined left out of objects, null in arrays). The input is not changed.
 * Throws JevStateMaskError when the state cannot be masked completely, and JevStateFieldOmittedError when a
 * non-empty string was omitted whole. With maxChars, a string is cut to maxChars + WINDOW_MARGIN before it is
 * masked, and no rule reads more of a string than that window (plus LINE_EXTENSION of its tail): the cost of the mask
 * then does not grow with the size of the state (it has a bound: MAX_STATE_NODES nodes, MAX_STATE_CHARS characters). A
 * name longer than the window (a key, the name of a pair, the first of two elements) is not read: it names a secret.
 */
export function maskJevState(state, { maxChars } = {}) {
  let nodes = 0;
  const ancestors = new Set();
  // With a window, a string is read up to cap characters (and its tail up to LINE_EXTENSION more) and the reads of the whole
  // state are paid for from one budget: the work of the mask has a bound that does not depend on the size of the input.
  const cap = maxChars === undefined ? Infinity : maxChars + WINDOW_MARGIN;
  const budget = maxChars === undefined ? Infinity : Math.max(MAX_STATE_CHARS, 16 * (cap + LINE_EXTENSION));
  let charsLeft = budget;
  const pay = (length) => {
    charsLeft -= length;
    if (charsLeft < 0) throw new JevStateMaskError(`state has more than ${budget} characters to read`);
  };
  const charge = (text) => pay(Math.min(text.length, cap + LINE_EXTENSION));
  // the part of a string that a classification reads: all of it, or its window
  const head = (text) => {
    charge(text);
    return text.length > cap ? text.slice(0, cap) : text;
  };
  // A name as the classification reads it. A name longer than the window is not read at all (null, which names a secret): the
  // words of a name can be anywhere in it, and reading all of it would cost as much as the name is long.
  const nameOf = (name) => {
    charge(name);
    return name.length > cap ? null : normalizeKey(name);
  };
  const pairNameKind = (name) => (typeof name === 'string' ? secretKindOf(nameOf(name)) : false);
  // The kinds of program that a string can be the name of: its base name is at the end of it, which the window does not hold, so it
  // is read from the end, up to PATH_TAIL characters (see programsOf); what the window already paid for is not paid again.
  const pathTail = maxChars === undefined ? Infinity : PATH_TAIL;
  const programsAt = (text) => {
    if (text.length > cap) pay(Math.min(text.length, pathTail));
    return programsOf(text, pathTail);
  };
  const tooMany = () => new JevStateMaskError(`state has more than ${MAX_STATE_NODES} nodes`);

  // secretKey: false, 'secret' or 'counter'; sessionId: the value of the key `session_id` of the state itself
  const walk = (input, key, depth, secretKey, sessionId) => {
    let value = input;
    if (value !== null && typeof value === 'object' && typeof value.toJSON === 'function') value = value.toJSON(key);
    if (typeof value === 'function' || typeof value === 'symbol' || value === undefined) return undefined;
    if (++nodes > MAX_STATE_NODES) throw tooMany();
    if (depth > MAX_STATE_DEPTH) throw new JevStateMaskError(`state is deeper than ${MAX_STATE_DEPTH} levels`);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') throw new JevStateMaskError('state has a BigInt');
    if (typeof value === 'number') {
      // A counter (total_tokens, token_count) stays a number even under a key that also names a secret word.
      if (secretKey === 'secret') return MASKED_VALUE;
      return Number.isFinite(value) ? value : null;
    }
    if (secretKey) return MASKED_VALUE;
    if (typeof value === 'string') {
      // A session id is no secret and a UUID looks like one to maskSecrets.
      if (sessionId && UUID.test(value)) return value;
      charge(value);
      const masked = maskString(value, maxChars);
      if (fieldOmitted(masked, maxChars)) throw new JevStateFieldOmittedError('a string of the state is a secret path');
      return masked;
    }
    if (ancestors.has(value)) throw new JevStateMaskError('state has a cycle');
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        // more elements than nodes are allowed: no rule reads them before the node limit would have refused the state
        if (value.length > MAX_STATE_NODES) throw tooMany();
        const heads = value.map((item) => (typeof item === 'string' ? head(item) : item));
        const { whole: wholeIndexes, partial } = secretArguments(heads, (i) => programsAt(value[i]));
        // the first of two elements is the name of the second
        const label = value.length === 2 ? pairNameKind(value[0]) : false;
        return value.map((item, i) => {
          const how = treatment(i === 1 ? label : false, wholeIndexes.has(i) ? 'secret' : partial.has(i) ? 'partial' : false);
          const whole = how === 'secret' || how === 'counter';
          return walk(how && !whole ? partial.get(i) : item, String(i), depth + 1, whole ? how : false, false) ?? null;
        });
      }
      const out = {};
      const keys = Object.keys(value);
      if (keys.length > MAX_STATE_NODES) throw tooMany();
      const normalizedKeys = keys.map(nameOf);
      // the names of a pair, whatever their order: the stricter label of all of them
      let pairKind = false;
      keys.forEach((k, i) => {
        if (PAIR_NAME.has(normalizedKeys[i])) pairKind = stricter(pairKind, pairNameKind(value[k]));
      });
      // names that collide after masking get the next free " #n" of their base, kept in one place so many collisions stay linear
      const nextSuffix = new Map();
      for (const [i, k] of keys.entries()) {
        const normalized = normalizedKeys[i];
        const secret = treatment(stricter(secretKindOf(normalized), PAIR_VALUE.has(normalized) ? pairKind : false), false);
        const masked = walk(value[k], k, depth + 1, secret, depth === 0 && normalized === 'session_id');
        if (masked === undefined) continue;
        charge(k);
        // the secret path of a key is looked for as far as a cut key is read
        const base = SECRET_PATH.test(k.length > cap + LINE_EXTENSION ? k.slice(0, cap + LINE_EXTENSION) : k) ? KEY_OMITTED : maskString(k, maxChars);
        let name = base;
        if (Object.hasOwn(out, name)) {
          let n = nextSuffix.get(base) ?? 2;
          while (Object.hasOwn(out, `${base} #${n}`)) n++;
          name = `${base} #${n}`;
          nextSuffix.set(base, n + 1);
        }
        Object.defineProperty(out, name, { value: masked, enumerable: true, writable: true, configurable: true });
      }
      return out;
    } finally {
      ancestors.delete(value);
    }
  };

  try {
    return walk(state, '', 0, false, false);
  } catch (error) {
    // A throwing toJSON or getter is a state that cannot be read completely: the same failure.
    if (error instanceof JevStateMaskError) throw error;
    throw new JevStateMaskError(`state cannot be read: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
