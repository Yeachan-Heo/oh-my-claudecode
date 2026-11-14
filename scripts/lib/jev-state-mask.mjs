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
/** A string longer than maxChars plus this is cut before it is masked: the part beyond is never sent. */
export const WINDOW_MARGIN = 512;

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
// camelCase humps or acronym ends (accessToken, DBPassword, api_key, Client-Secret, AWS_SECRET_ACCESS_KEY,
// password2): a digit run may follow. The plural counts for the strong words and for "tokens" as the last word
// (accessTokens, refresh_tokens), not for pass and pwd. Not "tokenizer", "secretary", "passwordless", "bypass",
// "compass", "passenger", "passes" or "tokens_used". "secretsManager" and "cookieJar" are secret keys on purpose:
// what they hold is secrets. A key that ends with "tokens" is also a counter (COUNTER_KEY): a number under it stays,
// a string, array or object under it is masked.
const SECRET_KEY = new RegExp(
  '(?:(?:passwords?|passwd|passphrases?|secrets?|token|credentials?|apikeys?)\\d*(?:[^a-z0-9]|$)' +
  '|(?:^|[^a-z0-9])(?:pass|pwds?|cookies?|bearer|api[_ -]?keys?|access[_ -]?keys?|private[_ -]?keys?|client[_ -]?secrets?|authorization)\\d*(?:[^a-z0-9]|$)' +
  '|tokens\\d*$)',
);
// A number under such a key that counts or measures something (token_count, password_length, tokenBudget) stays.
const COUNTER_KEY = /(?:tokens|(?:^|[^a-z0-9])(?:count|length|len|budget|usage|size))$/;
const MARKER = /\[(?:key|line) omitted: [^\]]*\]/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeKey(key) {
  return key.replace(MARKER, '').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

// 'secret' (the value is masked, a number too), 'counter' (a number stays) or false, for the name of a key or of a pair.
function secretKind(name) {
  const normalized = normalizeKey(name);
  if (!SECRET_KEY.test(normalized)) return false;
  return COUNTER_KEY.test(normalized) ? 'counter' : 'secret';
}

// Pairs: the value of { name: 'DB_PASSWORD', value: x }, { key: 'apiToken', value: x }, { Name, Value },
// { ParameterKey, ParameterValue } and the second element of a ['Authorization', 'Basic abc'] pair is masked when the
// name is a secret name. The bare name "pass" is not one here (['pass', 'fail'] is a list of results).
const PAIR_NAME = new Set(['name', 'key', 'parameter_key']);
const PAIR_VALUE = new Set(['value', 'parameter_value']);
function pairNameKind(name) {
  return typeof name === 'string' && name.length <= 200 && normalizeKey(name) !== 'pass' ? secretKind(name) : false;
}
// Arguments of a command written as an array: what maskSecrets masks in the same command line as a string, which its
// rules cannot see when each element is masked alone. The element after a secret flag is a value; after -u or --user
// the part of "user:password" after the colon; for a command of the mysql family or sshpass, the element after -p and
// the password stuck to -p (-phunter2). -p takes a password only for these commands (docker login -p is left alone,
// as it is in a string).
const SECRET_FLAG = /^--(?:password|passwd|pass|token|secret|api-key|apikey|access-token|auth-token|client-secret)$/i;
const USER_FLAG = /^(?:-u|--user)$/;
const USER_PASSWORD = /^([^\s:"']+:)[^\s"']+/;
const GLUED_P = /^(-p)[^\s"']/;
const P_COMMANDS = new Set(['mysql', 'mariadb', 'mysqldump', 'mysqladmin', 'sshpass']);
// Map: index of an element -> 'value' (all of it), 'user' (after the colon) or 'glued' (after -p)
function secretArguments(array) {
  const modes = new Map();
  let command = -1;
  for (let i = 0; i < array.length; i++) {
    const element = array[i];
    if (typeof element !== 'string') continue;
    if (command < 0 && P_COMMANDS.has(element.split(/[\\/]/).pop().toLowerCase())) command = i;
    if (SECRET_FLAG.test(element)) {
      if (i + 1 < array.length) modes.set(i + 1, 'value');
    } else if (USER_FLAG.test(element)) {
      if (typeof array[i + 1] === 'string' && USER_PASSWORD.test(array[i + 1])) modes.set(i + 1, 'user');
    } else if (command >= 0 && i > command) {
      if (element === '-p') {
        if (i + 1 < array.length) modes.set(i + 1, 'value');
      } else if (GLUED_P.test(element)) {
        modes.set(i, 'glued');
      }
    }
  }
  if (array.length === 2 && pairNameKind(array[0])) modes.set(1, 'value');
  return modes;
}
function maskArgument(item, mode) {
  if (mode === 'user') return item.replace(USER_PASSWORD, '$1***');
  if (mode === 'glued') return item.replace(/^(-p)[^\s"']+/, '$1***');
  return item;
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
 * does not take away. The cut removes context only at its tail, so only the tail has to be made safe:
 * - the last line, when it is cut: the secret path is looked for in the whole original line, and a hit omits it;
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
    const next = text.indexOf('\n', end);
    const line = text.slice(lineStart, next === -1 ? text.length : next);
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
function maskString(text, maxChars, plain) {
  const cutText = maxChars !== undefined && text.length > maxChars + WINDOW_MARGIN;
  const cut = cutText ? cutAndCloseTail(text, maxChars + WINDOW_MARGIN) : text;
  if (plain === 'cwd') return omitSecretLines(cut);
  const omitted = omitSecretLines(maskPrivateKeys(cut));
  const masked = maskSecrets(omitted, { keepGitHashes: true });
  return cutText ? masked.replace(/(\/\/[^/\s:@]+:)[^/\s@]+$/, '$1***') : masked;
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
 * masked (the cost of the mask then does not grow with the size of the state).
 */
export function maskJevState(state, { maxChars } = {}) {
  let nodes = 0;
  const ancestors = new Set();

  // secretKey: false, 'secret' or 'counter'; plain: 'uuid' (a session id key) or 'cwd'
  const walk = (input, key, depth, secretKey, plain) => {
    let value = input;
    if (value !== null && typeof value === 'object' && typeof value.toJSON === 'function') value = value.toJSON(key);
    if (typeof value === 'function' || typeof value === 'symbol' || value === undefined) return undefined;
    if (++nodes > MAX_STATE_NODES) throw new JevStateMaskError(`state has more than ${MAX_STATE_NODES} nodes`);
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
      if (plain === 'uuid' && UUID.test(value)) return value;
      const masked = maskString(value, maxChars, plain);
      if (fieldOmitted(masked, maxChars)) throw new JevStateFieldOmittedError('a string of the state is a secret path');
      return masked;
    }
    if (ancestors.has(value)) throw new JevStateMaskError('state has a cycle');
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const modes = secretArguments(value);
        return value.map((item, i) => {
          const mode = modes.get(i);
          return walk(mode && mode !== 'value' ? maskArgument(item, mode) : item, String(i), depth + 1, mode === 'value' ? 'secret' : false, false) ?? null;
        });
      }
      const out = {};
      const keys = Object.keys(value);
      let pairKind = false;
      for (const k of keys) {
        if (PAIR_NAME.has(normalizeKey(k))) pairKind = pairNameKind(value[k]) || pairKind;
      }
      // names that collide after masking get the next free " #n" of their base, kept in one place so many collisions stay linear
      const nextSuffix = new Map();
      for (const k of keys) {
        const normalized = normalizeKey(k);
        const secret = secretKind(k) || (PAIR_VALUE.has(normalized) ? pairKind : false);
        const kind = normalized === 'session_id' ? 'uuid' : normalized === 'cwd' ? 'cwd' : false;
        const masked = walk(value[k], k, depth + 1, secret, kind);
        if (masked === undefined) continue;
        const base = SECRET_PATH.test(k) ? KEY_OMITTED : maskString(k, maxChars, false);
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
