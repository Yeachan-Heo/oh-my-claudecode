/**
 * Random cases for the differential test of scripts/lib/jev-state-mask.mjs (src/__tests__/jev-state-mask.test.mjs):
 * a secret of a random kind, with body characters drawn from everything its rule takes, placed around the edge of
 * the window (maxChars and maxChars + 512), after a text that the mask shortens or not, in a string, a key, an
 * array, a nested object, a pair of name and value or the arguments of a command. The generator takes a function
 * that returns numbers in [0, 1), so a seed gives the same cases every time. Not a test file.
 */

export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = LOWER.toUpperCase();
const DIGITS = '0123456789';
const ALNUM = LOWER + UPPER + DIGITS;
const printable = (excluded) => Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) => String.fromCharCode(0x21 + i)).filter((c) => !excluded.includes(c)).join('');
// every secret avoids "*", so that no fragment of it can be a fragment of the *** that the mask writes
const ALPHABETS = {
  url: printable('/@*'),
  bearer: LOWER + UPPER + DIGITS + '._~+/=-',
  token: ALNUM + '_-',
  alnum: ALNUM,
  upper: UPPER + DIGITS,
  mixed: ALNUM + '+_-',
  value: printable('"\'&;|)*,}'),
  word: printable('"\'*'),
};

export function makeBody(next, alphabet, min, max) {
  const chars = ALPHABETS[alphabet];
  const length = min + Math.floor(next() * (max - min + 1));
  return Array.from({ length }, () => chars[Math.floor(next() * chars.length)]).join('');
}
const pick = (next, list) => list[Math.floor(next() * list.length)];

// [kind, build(next) => { text, secret }]: the secret is what must not be sent, in 6-character fragments
const TEXT_KINDS = [
  ['url', (n) => { const s = makeBody(n, 'url', 8, 700); return { text: `https://user:${s}@host/x`, secret: s }; }],
  ['bearer', (n) => { const s = makeBody(n, 'bearer', 8, 700); return { text: `curl -H x Bearer ${s}`, secret: s }; }],
  ['sk', (n) => { const s = makeBody(n, 'token', 12, 400); return { text: pick(n, ['sk-', 'sk-ant-', 'sk-proj-']) + s, secret: s }; }],
  ['ghp', (n) => { const s = makeBody(n, 'token', 10, 400); return { text: pick(n, ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'glpat-', 'xoxb-', 'xoxp-']) + s, secret: s }; }],
  ['sk_live', (n) => { const s = makeBody(n, 'alnum', 16, 300); return { text: pick(n, ['sk_live_', 'rk_test_', 'pk_live_', 'hf_', 'npm_']) + s, secret: s }; }],
  ['akia', (n) => { const s = makeBody(n, 'upper', 16, 16); return { text: `id AKIA${s} end`, secret: s }; }],
  ['jwt', (n) => { const a = makeBody(n, 'token', 8, 40); const b = makeBody(n, 'token', 8, 700); const c = makeBody(n, 'token', 8, 60); return { text: `eyJ${a}.${b}.${c}`, secret: b + c }; }],
  ['mixed token', (n) => { const s = makeBody(n, 'mixed', 32, 800) + '7'; return { text: s + makeBody(n, 'mixed', 0, 20), secret: s }; }],
  ['KEY=', (n) => { const s = makeBody(n, 'value', 8, 80); return { text: `export ${pick(n, ['API_KEY', 'SECRET_TOKEN', 'DB_PASSWORD', 'MY_PASS'])}=${s}`, secret: s }; }],
  ['authorization', (n) => { const s = makeBody(n, 'word', 8, 200); return { text: `Authorization: ${pick(n, ['Bearer ', 'Basic ', 'token ', ''])}${s}`, secret: s }; }],
  ['cookie', (n) => { const s = makeBody(n, 'word', 8, 200); return { text: `Cookie: sid=${s}`, secret: s }; }],
  ['--password', (n) => { const s = makeBody(n, 'word', 8, 200); return { text: `run ${pick(n, ['--password', '--token', '--api-key', '--client-secret'])} ${s} now`, secret: s }; }],
  ['mysql -p', (n) => { const s = makeBody(n, 'word', 8, 100); return { text: `mysql -u root -p${s}`, secret: s }; }],
  ['sshpass -p', (n) => { const s = makeBody(n, 'word', 8, 100); return { text: `sshpass -p ${s} ssh host`, secret: s }; }],
  ['-u user:pw', (n) => { const s = makeBody(n, 'word', 8, 100); return { text: `curl -u user:${s} http://h`, secret: s }; }],
  ['private key', (n) => { const s = Array.from({ length: 5 + Math.floor(n() * 40) }, () => makeBody(n, 'bearer', 64, 64)).join('\n'); return { text: `-----BEGIN RSA PRIVATE KEY-----\n${s}\n-----END RSA PRIVATE KEY-----`, secret: s }; }],
  ['value before a secret path', (n) => { const s = 'hunter' + makeBody(n, 'alnum', 2, 8); return { text: `echo ${s} > ${'x '.repeat(Math.floor(n() * 400))}${pick(n, ['~/.ssh/id_ed25519', '/srv/app/.env', '/home/u/.aws/credentials', '~/.netrc', '/run/secrets/db'])}`, secret: s }; }],
];

const SECRET_KEY_NAMES = ['password', 'passwd', 'DBPassword', 'APIToken', 'accessTokens', 'refresh_tokens', 'idTokens', 'apiTokens', 'authTokens', 'api_key', 'apiKeys', 'secret', 'secrets', 'clientSecret', 'private-key', 'authorization', 'Cookie', 'credentials', 'dbpassword', 'userpassword', 'passphrase', 'password2', 'token1', 'bearer', 'pwd', 'pass', 'secretsManager', 'cookieJar'];
const PAIR_SHAPES = [
  (name, value) => ({ name, value }),
  (name, value) => ({ key: name, value }),
  (name, value) => ({ Name: name, Value: value }),
  (name, value) => ({ ParameterKey: name, ParameterValue: value }),
];
const PAIR_NAMES = ['DB_PASSWORD', 'apiToken', 'AWS_SECRET_ACCESS_KEY', 'client_secret', 'dbPassword', 'accessTokens'];
const FLAGS = ['--password', '--token', '--api-key', '--secret', '--access-token'];

// structural cases: [kind, build(next) => { state, secret }]
const STRUCTURE_KINDS = [
  ['secret key', (n) => { const s = makeBody(n, 'alnum', 8, 60); const name = pick(n, SECRET_KEY_NAMES); return { state: { id: 1, [name]: pick(n, [s, [s, 'x' + s], { nested: s }]) }, secret: s }; }],
  ['pair', (n) => { const s = makeBody(n, 'word', 8, 80); return { state: { env: [pick(n, PAIR_SHAPES)(pick(n, PAIR_NAMES), s)] }, secret: s }; }],
  ['flag argument', (n) => { const s = makeBody(n, 'word', 8, 80); return { state: { argv: ['run', pick(n, FLAGS), s, 'x'] }, secret: s }; }],
  ['-p argument', (n) => { const s = makeBody(n, 'word', 8, 80); return { state: { argv: [pick(n, ['mysql', 'mariadb', 'mysqldump', 'mysqladmin', 'sshpass']), '-p', s] }, secret: s }; }],
  ['-u argument', (n) => { const s = makeBody(n, 'word', 8, 80); return { state: { argv: [pick(n, ['curl', 'http', 'wget']), pick(n, ['-u', '--user']), `${pick(n, ['user', 'u', 'admin'])}:${s}`, 'http://h'] }, secret: s }; }],
  ['glued -p argument', (n) => { const s = makeBody(n, 'word', 8, 80); return { state: { argv: [pick(n, ['sudo', 'docker', 'mysql']), pick(n, ['mysql', 'mariadb', 'mysqldump', 'mysqladmin', 'sshpass']), '-u', 'root', `-p${s}`, 'db'] }, secret: s }; }],
  ['tuple', (n) => { const s = makeBody(n, 'word', 8, 80); return { state: { headers: [[pick(n, ['Authorization', 'X-Api-Key', 'Cookie', 'x-auth-token']), s]] }, secret: s }; }],
  ['headers', (n) => { const s = makeBody(n, 'word', 8, 80); return { state: { headers: { [pick(n, ['Authorization', 'X-Api-Key', 'Cookie', 'Proxy-Authorization'])]: s } }, secret: s }; }],
];

const SHRINK = 'Q9'.repeat(300); // 600 characters that the mask turns into ***

/** One random case: { kind, state, secret, maxChars }. */
export function makeCase(next) {
  const maxChars = pick(next, [100, 200, 700, 1000]);
  if (next() < 0.3) {
    const [kind, build] = pick(next, STRUCTURE_KINDS);
    const { state, secret } = build(next);
    return { kind, state, secret, maxChars };
  }
  const [kind, build] = pick(next, TEXT_KINDS);
  const { text, secret } = build(next);
  const edge = pick(next, [maxChars, maxChars + 512, Math.floor(next() * (maxChars + 700))]);
  const offset = Math.max(0, edge + Math.floor(next() * 120) - 60);
  const heads = Math.floor(next() * 3);
  let head = '';
  for (let i = 0; i < heads && head.length + SHRINK.length + 1 <= offset; i++) head += SHRINK + ' ';
  const fill = 'w '.repeat(Math.ceil((offset - head.length) / 2)).slice(0, Math.max(0, offset - head.length));
  const input = head + fill + ' ' + text + ' tail ' + 'w '.repeat(Math.floor(next() * 1200));
  const embedding = pick(next, ['string', 'string', 'key', 'array', 'nested']);
  const state = {
    string: { t: input },
    key: { [input]: 1 },
    array: { a: ['x', input] },
    nested: { a: { b: input } },
  }[embedding];
  return { kind: `${kind} in ${embedding}`, state, secret, maxChars };
}

function bound(value, max) {
  if (typeof value === 'string') return value.length > max ? value.slice(0, max) : value;
  if (Array.isArray(value)) return value.map((item) => bound(item, max));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bound(v, max)]));
  return value;
}
function haystack(value, parts = []) {
  if (typeof value === 'string') parts.push(value);
  else if (Array.isArray(value)) for (const item of value) haystack(item, parts);
  else if (value !== null && typeof value === 'object') for (const [k, v] of Object.entries(value)) { parts.push(k); haystack(v, parts); }
  else if (typeof value === 'number') parts.push(String(value));
  return parts.join('\u0000');
}
function shows(maskJevState, state, secret, options) {
  let masked;
  try {
    masked = maskJevState(state, options);
  } catch (error) {
    if (error?.name === 'JevStateFieldOmittedError') return []; // not sent at all
    throw error;
  }
  const sent = haystack(options?.maxChars === undefined ? masked : bound(masked, options.maxChars));
  const found = [];
  for (let i = 0; i + 6 <= secret.length; i++) {
    const gram = secret.slice(i, i + 6);
    if (sent.includes(gram)) found.push(gram);
  }
  return found;
}

/**
 * Checks one case: the mask without a window must hide the secret (otherwise the case says something about the
 * rules, not about the cut: { gap: true }), and then the part of the masked state that is sent (strings cut to
 * maxChars, keys whole) must show no 6-character fragment of it.
 */
export function checkCase(maskJevState, c) {
  const whole = shows(maskJevState, c.state, c.secret, undefined);
  if (whole.length) return { gap: true, shown: whole.slice(0, 3) };
  const shown = shows(maskJevState, c.state, c.secret, { maxChars: c.maxChars });
  return shown.length ? { error: true, shown: shown.slice(0, 3) } : { ok: true };
}
