// omc-lokalne N11 (review rec-A2b-panel BLOCKER 1 and 2, 11.11.2026; review rec-N11-panel-sekrety, N11b): the one source of the secret
// patterns and of the cleaning of what goes to Jev.
// Users: scripts/lib/jev-panel-wejscie.mjs imports this module; hooks/jev-compaction.ts cannot import (no Node, no dynamic import), so it
// holds a copy of the block between the markers, word for word (testy/panel.mjs compares the two blocks and fails on any difference;
// after a change here copy the block there). The archive (A15) and the pastes (A17) of the compaction module take the same block.
// SECRET_PATH covers at least the secret-folder rule of the tool gate of the patched plugin it was written for (paths d:/vault, ~/.vault,
// and every file of the secrets folder), written for free text (commands, result lines, agent texts) instead of canonical paths: Linux and
// Windows forms, both slashes, a doubled backslash of JSON text, a relative path. Added: the files of the review (rclone.conf, .netrc,
// .pgpass, .npmrc, .aws/credentials, .docker/config.json) with their Windows names (_netrc, pgpass.conf, %APPDATA%\GitHub CLI\hosts.yml),
// the host keys of sshd, the bare ~/.ssh directory, the extras of the A15 archive (.gnupg) and of the A17 pastes
// (/etc/shadow, .pypirc, .kube/config); N11b (MEDIUM 2): OAuth token files (token*.json), service
// account and client secret files, key stores (*.pem, *.p12, *.pfx, *.jks, *.keystore, *.kdbx, *.ppk, a *.key file with a path or a key
// name), .envrc and named env files (prod.env, /srv/app/x.env), id_rsa outside ~/.ssh; N11c: copies (kopia.netrc, .netrc-old, x.pgpass,
// .pgpass2, .npmrc-old, .pypirc.bak) and bare relative forms (gnupg/); N11e and N11g: a name
// glued to a prefix without a separator (kopia.npmrc, x.kube/config, backup.env, stary_id_rsa, kopia.vault, backup.ssh/), a copy of a
// private key (id_rsa.bak, id_rsa2; never *.pub), a named env file with a prefix (my-app.env, x_1.env). Every repetition is
// bounded (LOW 3: no quadratic backtracking on a long token). secretPathIn also tests the text without quotes and backslashes
// ("~/.va""ult", ~/.va\ult) and, for tool input (command), fails closed on a glob inside a hidden directory name (/.s*/, /.va?lt,
// ~/.s?h; LOW 2).
// SECRET_KEY: a key of a JSON object whose value is a secret, camelCase too (N11b MEDIUM 1: encryptionKey, dbPass, userPwd, basicAuth,
// sessionId). secretJsonReplacer(clean) is a JSON.stringify replacer: the value of a secret key is replaced whole whatever its type, a
// short value under code or kod too (one-time codes), a name/value pair whose name is secret ({name: 'DB_PASS', value: ...},
// ParameterKey/ParameterValue) loses its value, an argument after a secret flag in an array (['--password', x], mysql -p x) and the second
// item of a pair ['Authorization', x] are replaced, a key naming a secret path is cleaned, and every other string goes through clean.
// cleanSecretText(text, mask, marker) is the cleaning of a text for Jev (N11b HIGH 1, MEDIUM 3): private key blocks are masked in the whole
// text first (N11h), then a text or a line that is JSON is parsed and serialised with the replacer (JSON that nothing changed stays as it was
// written), a secret path in any other line is replaced IN PLACE by `marker` (K2, J1e: only the token of the path, the rest of
// the line stays as it was; before, the whole line became a marker), then maskSecretText (a name/value pair and a secret key with an object,
// array or number value in JSON text that does not parse, PGP and PEM private key blocks, a long base64 run with / or +; LOW 1) and mask
// (maskSecrets of the caller; after maskSecretText, which needs the JSON text intact). secretJson(value, mask, marker) is the same for a value.
// `marker` is the replacement of a secret path (default SECRET_PATH_MARK); it is no longer a line marker. Nothing is cut any more: a text of
// any length goes through whole (every rule is linear, see maskSecrets), a name of an object that was a secret path is replaced in place and
// kept apart from the others (`marker#2`), so no field is lost. A key block header with no END no longer costs the whole value: secretStructural masks it over the value tree (valid JSON). maskSecretPaths(text, marker, command) is the in-place replacement alone;
// countMaskedPlaces(before, after) counts the places a cleaning replaced (`***` and the path marker; the field maska_miejsc of the log row).
// maskSecrets(text) is the one source of the token patterns (moved here from scripts/lib/jev-shell.mjs and the hooks module): the same rules
// as before, the three that read the rest of the text again from every failed start (Authorization, mysql -p, eyJ) read it once.
// <jev-sekrety>
const SECRET_TOKEN_CHAR = String.raw`[^\s"'\x60;|&<>(),:\]}]`
const SECRET_NAME_CHAR = String.raw`[^\s"'\x60\\/;|&<>(),:\]}]`
const SECRET_BOUNDARY = String.raw`(?:^|[\\/\s"'\x60=:(;|&,<>])`
const SECRET_END = `(?!${SECRET_TOKEN_CHAR})`
// MEDIUM-1 of rec-3b: a name glued to a prefix (kopia.npmrc, backup.env) is found by its keyword alone, the prefix is not read (it was
// SECRET_NAME_CHAR{0,80} in every branch, with = in both the boundary and the prefix: quadratic-like cost on a run of =, 8.8 s on 600 000
// characters). A prefix is spelled out only where it carries a rule (LOW-1 of rec-3b: a separator before id_, a slash after a glued .ssh).
const SECRET_SSH_FILE = `(?!known_hosts|authorized_keys|(?:config|environment|rc)${SECRET_END}|config\\.d[\\\\/])(?!${SECRET_TOKEN_CHAR}{0,255}\\.pub${SECRET_END})${SECRET_TOKEN_CHAR}+`
const SECRET_PATH = new RegExp([
  String.raw`[\\/]\.?vault(?![a-z0-9_])`, // D:\Vault, /mnt/d/Vault, /d/vault, D:\VAULT~1, ~/.vault, /home/user/.vault, C:\Users\u\.vault
  String.raw`\.vault(?![a-z0-9_])|(?:^|[\s"'\x60=:(;|&,<>])vault[\\/]`, // relative: .vault, .vault/x, vault/x, kopia.vault (N11g)
  // every file in .ssh but known_hosts*, authorized_keys*, config, config.d/, environment, rc and *.pub (the gate), and the bare directory
  // (only at a boundary; glued to a prefix only as a directory, backup.ssh/, not self.ssh); the .pub test looks at most 255 characters
  // ahead, a longer token counts as a key (fail closed)
  `${SECRET_BOUNDARY}\\.ssh${SECRET_END}|\\.ssh[\\\\/]+(?:${SECRET_SSH_FILE})?${SECRET_END}`,
  String.raw`ssh_host_[^\s"'\\/]{0,64}_key(?![a-z0-9_.-])`, // /etc/ssh/ssh_host_ed25519_key, C:\ProgramData\ssh\ssh_host_rsa_key (not .pub)
  // a private key outside ~/.ssh with any ending (id_rsa.bak, id_rsa2; N11g) and a prefix set off by anything but a letter or a digit (stary_id_rsa,
  // kopia.id_rsa, *id_rsa, {id_rsa,x}; not valid_rsa_signature or android_rsa_key; LOW-1 of rec-3b), never *.pub (the .pub test looks at most 255 characters ahead)
  `(?:^|[^a-z0-9])id_(?:rsa|dsa|ecdsa|ed25519)(?![a-z])(?!${SECRET_TOKEN_CHAR}{0,255}\\.pub${SECRET_END})`,
  String.raw`\.git-credentials(?![a-z0-9_-])`,
  `${SECRET_BOUNDARY}gh[\\\\/]+hosts\\.ya?ml\\b|github cli[\\\\/]+hosts\\.ya?ml\\b`, // ~/.config/gh/hosts.yml, %APPDATA%\GitHub CLI\hosts.yml, backupGitHub CLI\hosts.yml
  String.raw`\.credentials\.json\b`, // ~/.claude*/.credentials.json
  String.raw`context-mode[\\/]+platform\.json\b`,
  // .env, .env.local, .env.production (not .env.example, .sample, .template, .dist, .default(s), .tpl, and not a directory .env/), .envrc,
  // a named env file (prod.env, secrets.env) and any *.env after a path separator (not a property such as ctx.env in code)
  `${SECRET_BOUNDARY}\\.env(?:\\.(?!(?:example|sample|template|dist|defaults?|tpl)(?!${SECRET_NAME_CHAR}))${SECRET_NAME_CHAR}{1,255})?${SECRET_END}`,
  `${SECRET_BOUNDARY}\\.envrc${SECRET_END}`,
  // N11g: a named env file or its copy with any prefix (backup.env, kopia.env, my-app.env, x_1.env, backup.env.bak), not a bare identifier
  // (ctx.env, this.env, import.meta.env are code, nor python3.env or cfg_v2.env: LOW-1 of rec-3b) and not a template (backup.env.example). A
  // digit counts after a listed word (prod2.env, app1.env), after - or _ (x_1.env) and alone (1.env), not after another letter (python3, node18, _v2).
  // M1 of the second round of rec-3b.
  `(?:(?:prod|production|dev|development|staging|stage|test|local|secrets?|private|credentials?|app|docker|db|database|api|backup|bak|kopia|copy|old|orig|stary|save)\\d{0,9}|[-_]\\d{0,9}|(?:^|[^a-z0-9])\\d{1,9})\\.env(?:\\.(?!(?:example|sample|template|dist|defaults?|tpl)(?!${SECRET_NAME_CHAR}))${SECRET_NAME_CHAR}{1,255})?${SECRET_END}`,
  `[\\\\/]${SECRET_NAME_CHAR}{1,120}\\.env${SECRET_END}`,
  String.raw`rclone\.conf\b`, // ~/.config/rclone/rclone.conf, %APPDATA%\rclone\rclone.conf
  // N11c: a copy keeps the name with any prefix or ending (kopia.netrc, .netrc-old, .netrc.bak, x.pgpass, .pgpass2, .npmrc-old); N11e (sonda
  // fala3b, removal of the A15 and A17 lists): the same prefix for .npmrc, .pypirc, .kube/config, .aws/credentials, .docker/config.json
  String.raw`[._]netrc(?![a-z])`, // ~/.netrc, %USERPROFILE%\_netrc
  String.raw`\.pgpass(?![a-z])|pgpass\.conf\b`, // ~/.pgpass, %APPDATA%\postgresql\pgpass.conf
  String.raw`\.npmrc(?![a-z])`, // ~/.npmrc, kopia.npmrc
  String.raw`\.aws[\\/]+credentials\b`,
  String.raw`\.docker[\\/]+config\.json\b`,
  `\\.gnupg(?![a-z0-9_-])|(?:[\\\\/]|${SECRET_BOUNDARY})gnupg[\\\\/]`, // ~/.gnupg, %APPDATA%\gnupg\, gnupg/
  String.raw`[\\/]etc[\\/]+g?shadow\b`, // the extras of the A17 pastes: /etc/shadow, /etc/gshadow
  String.raw`\.pypirc(?![a-z])|\.kube[\\/]+config\b`, // ~/.pypirc, .pypirc.bak, backup.pypirc, ~/.kube/config
  // N11b MEDIUM 2: OAuth tokens (token.json, token_<scope>.json), service account and client secret files
  `token(?!iz)${SECRET_NAME_CHAR}{0,80}\\.json\\b`, // not tokenizer.json
  `${SECRET_BOUNDARY}(?:sa-key|service[-_]?account${SECRET_NAME_CHAR}{0,80}|client_secret${SECRET_NAME_CHAR}{0,80}|credentials)\\.json\\b`,
  // key stores; a *.key only after a path separator or with a key-like name, because obj.key is code
  `\\.(?:pem|p12|pfx|jks|keystore|kdbx|ppk)${SECRET_END}`,
  `(?:[\\\\/]${SECRET_NAME_CHAR}{1,120}|${SECRET_BOUNDARY}(?:priv|private|server|client|tls|ssl|signing|id)${SECRET_NAME_CHAR}{0,80})\\.key${SECRET_END}`,
].join('|'), 'i')
const SECRET_GLOB = /\/\.[^/\s"']{0,64}[*?[]/ // a glob inside a hidden name: /.v*/x, /.va?lt, ~/.s?h, /.[v]ault, ~/.* (not \.[a-z] of a regex)
function secretPathIn(text, command) {
  const s = String(text ?? '')
  return SECRET_PATH.test(s) || (/["'\\]/.test(s) && SECRET_PATH.test(s.replace(/["'\\]/g, ''))) || Boolean(command && SECRET_GLOB.test(s))
}
// K2 (J1e): a secret path is replaced IN PLACE, the token of the path only (before: the whole line). The span is the match widened to
// the delimiters of a path token on both sides (a space, a quote, ; | & < > ( ) , [ ] { }; on the left also = and :, a drive letter before the
// colon stays in; on the right also :), so the file name under a secret directory goes with it. A path found only after quotes and
// backslashes were removed ("~/.va""ult") is widened over quotes and backslashes too (fail closed, a little more than the path). With
// `command` a glob in a hidden name (SECRET_GLOB) is replaced the same way.
const SECRET_PATH_GLOBAL = new RegExp(SECRET_PATH.source, 'gi')
const SECRET_GLOB_GLOBAL = new RegExp(SECRET_GLOB.source, 'g')
const SECRET_STOP = /[\s"'\x60;|&<>(),[\]{}]/
const SECRET_STOP_WIDE = /[\s;|&<>(),[\]{}]/
function secretPathSpans(text, command) {
  const spans = []
  const widen = (from, to, wide) => {
    const stop = wide ? SECRET_STOP_WIDE : SECRET_STOP
    let a = from
    while (a > 0 && !stop.test(text[a - 1]) && text[a - 1] !== '=' && text[a - 1] !== ':') a--
    if (a === from && text[a - 1] === ':' && /[A-Za-z]/.test(text[a - 2] ?? '') && (a < 3 || !/\w/.test(text[a - 3]))) a -= 2
    let b = to
    while (b < text.length && !stop.test(text[b]) && text[b] !== ':') b++
    // A quoted path runs to its closing quote on the same line (a file name with spaces: "~/.vault/moj klucz.txt").
    const q = a > 0 ? text[a - 1] : ''
    if (q === '"' || q === "'" || q === '\x60') {
      const close = text.indexOf(q, b)
      if (close !== -1 && !text.slice(b, close).includes('\n')) b = close
    }
    // A line that opens with the path and goes on with ':' is a grep or a listing of that file (path:line:text): what follows is the file's
    // content, a value, so it goes with the path.
    if ((a === 0 || text[a - 1] === '\n') && text[b] === ':') {
      const eol = text.indexOf('\n', b)
      b = eol === -1 ? text.length : eol
    }
    spans.push([a, b])
  }
  const scan = (rx, hay, map, wide) => {
    rx.lastIndex = 0
    let m
    while ((m = rx.exec(hay))) {
      if (m[0].length === 0) { rx.lastIndex++; continue }
      widen(map ? map[m.index] : m.index, map ? map[m.index + m[0].length - 1] + 1 : m.index + m[0].length, wide)
      if (rx.lastIndex < spans[spans.length - 1][1] && !map) rx.lastIndex = spans[spans.length - 1][1]
    }
  }
  scan(SECRET_PATH_GLOBAL, text, null, false)
  if (/["'\\]/.test(text)) {
    const keep = []
    let bare = ''
    for (let i = 0; i < text.length; i++) { const c = text[i]; if (c !== '"' && c !== "'" && c !== '\\') { bare += c; keep.push(i) } }
    if (SECRET_PATH.test(bare)) scan(SECRET_PATH_GLOBAL, bare, keep, true)
  }
  if (command) scan(SECRET_GLOB_GLOBAL, text, null, false)
  return spans
}
function maskSecretPaths(text, marker = SECRET_PATH_MARK, command = false) {
  const s = String(text ?? '')
  if (!secretPathIn(s, command)) return s
  const spans = secretPathSpans(s, command).sort((x, y) => x[0] - y[0] || y[1] - x[1])
  let out = ''
  let at = 0
  for (const [a, b] of spans) {
    if (b <= at) continue
    out += s.slice(at, Math.max(a, at)) + marker
    at = b
  }
  return out + s.slice(at)
}
const SECRET_KEY = /key(?!word|board|stroke|frame)|token|secret|passw|pass(?:[_-]?(?:phrase|wd|code)|$|[^a-z])|pwd|credential|auth(?!ors?(?:$|[^i]))|cookie|session(?:[_-]?id)?$|^sid$|^otp$|otp[_-]?(?:code|secret)|pin(?:[_-]?code)?$|has[łl]o|klucz|sekret|signature|private/i
const SECRET_CODE_KEY = /^(?:code|kod)$/i // a one-time code: masked when the value is short (python_repl code stays)
const SECRET_CODE_VALUE = /^\s*[A-Za-z0-9]{4,10}(?:-[A-Za-z0-9]{4,10})?\s*$/
const SECRET_PAIR_NAME = /(?:^|[a-z_])(?:name|key|type)$|^(?:nazwa|klucz|label|field|header|variable|zmienna)$/i // the name of a name/value pair
const SECRET_PAIR_VALUE = /(?:^|[a-z_])(?:value|values|val)$|^(?:wartosc|wartość|text|content|data)$/i // its value
const SECRET_PAIR_TYPE = /^securestring$/i // aws ssm: {Name, Type: 'SecureString', Value}
const secretPairName = (x) => typeof x === 'string' && (SECRET_KEY.test(x) || SECRET_PAIR_TYPE.test(x))
const SECRET_FLAG = /^--?(?:password|passwd|pass|pwd|token|secret|api-?key|access-token|auth-token|client-secret|passphrase)$/i
const SECRET_MYSQL = /^(?:.*[\\/])?(?:mysql|mysqldump|mysqladmin|mariadb)(?:\.exe)?$/i
const SECRET_JSON_MAX = 1000000
const SECRET_PATH_MARK = '[ścieżka ukryta]' // replaces a secret path (the token) in place
function secretArray(v) {
  const mysql = v.some((x) => typeof x === 'string' && SECRET_MYSQL.test(x))
  const out = v.map((x, i) => {
    const prev = i > 0 && typeof v[i - 1] === 'string' ? v[i - 1] : ''
    if (x === null || x === undefined || typeof x === 'boolean') return x
    if (prev && (SECRET_FLAG.test(prev) || (mysql && prev === '-p'))) return '***'
    if (mysql && typeof x === 'string' && /^-p\S/.test(x)) return '-p***'
    return x
  })
  if (v.length === 2 && typeof v[0] === 'string' && SECRET_KEY.test(v[0]) && v[1] !== null && v[1] !== undefined && typeof v[1] !== 'boolean') out[1] = '***'
  return out.some((x, i) => x !== v[i]) ? out : v
}
function secretJsonReplacer(clean) {
  return (key, v) => {
    if (v === null || v === undefined || typeof v === 'boolean') return v
    if (key && (SECRET_KEY.test(key) || (SECRET_CODE_KEY.test(key) && SECRET_CODE_VALUE.test(String(v))))) return '***'
    if (typeof v === 'string') return clean(v)
    if (Array.isArray(v)) return secretArray(v)
    if (typeof v === 'object') {
      const entries = Object.entries(v)
      const pair = entries.some(([k, x]) => SECRET_PAIR_NAME.test(k) && secretPairName(x))
      if (!pair && !entries.some(([k]) => secretPathIn(k))) return v
      // a name that was a secret path is cleaned in place; two of them (or one and a plain name) must not become one key, so the field is kept as `name#2`
      const taken = new Set(entries.filter(([k]) => !secretPathIn(k)).map(([k]) => k))
      return Object.fromEntries(entries.map(([k, x]) => {
        let name = secretPathIn(k) ? clean(k) : k
        if (name !== k) { const base = name; for (let n = 2; taken.has(name); n++) name = `${base}#${n}`; taken.add(name) }
        return [name, pair && SECRET_PAIR_VALUE.test(k) && x !== null && typeof x !== 'boolean' ? '***' : x]
      }))
    }
    return v
  }
}
// The end of a JSON value starting at i in a text: a string to its closing quote, an object or array to its closing bracket (at most 2000
// characters, else to the end of the line: fail closed), a literal to the next , } ] or space.
function secretValueEnd(text, i) {
  const c = text[i]
  if (c === '"') {
    for (let j = i + 1; j < text.length && j < i + 4000; j++) {
      if (text[j] === '\\') j++
      else if (text[j] === '"') return j + 1
      else if (text[j] === '\n') return j
    }
    return Math.min(text.length, i + 4000)
  }
  if (c === '{' || c === '[') {
    let depth = 0
    let quoted = false
    for (let j = i; j < text.length && j < i + 2000; j++) {
      const ch = text[j]
      if (quoted) { if (ch === '\\') j++; else if (ch === '"') quoted = false; continue }
      if (ch === '"') quoted = true
      else if (ch === '{' || ch === '[') depth++
      else if ((ch === '}' || ch === ']') && --depth === 0) return j + 1
    }
    const line = text.indexOf('\n', i + 2000)
    return line < 0 ? text.length : line
  }
  const literal = /^[^,}\]\s]{1,200}/.exec(text.slice(i, i + 200))
  return literal && !/^(?:true|false|null)$/.test(literal[0]) ? i + literal[0].length : i
}
// up to 6 simple fields between the name and the value of a pair; forward the nearest value, backward the farthest name (same object)
const SECRET_PAIR_GAP = String.raw`((?:\s*,\s*"[^"\\\n]{0,40}"\s*:\s*(?:"[^"\\\n]{0,200}"|[^,{}\[\]\s"]{1,40})){0,6}?\s*,\s*)`
const SECRET_PAIR_GAP_BACK = SECRET_PAIR_GAP.replace('{0,6}?', '{0,6}')
const SECRET_PAIR_NAME_TEXT = String.raw`"([A-Za-z_]{0,40}(?:name|key|type))"(\s*:\s*)"([^"\\\n]{0,200})"`
const SECRET_PAIR_VALUE_TEXT = String.raw`"([A-Za-z_]{0,40}(?:value|val))"(\s*:\s*)("(?:[^"\\\n]|\\.){0,4000}"|[^,}\]\s]{1,200})`
const SECRET_PAIR_TEXT = new RegExp(SECRET_PAIR_NAME_TEXT + SECRET_PAIR_GAP + SECRET_PAIR_VALUE_TEXT, 'gi')
const SECRET_PAIR_TEXT_BACK = new RegExp(SECRET_PAIR_VALUE_TEXT + SECRET_PAIR_GAP_BACK + SECRET_PAIR_NAME_TEXT, 'gi')
const secretPairGap = (gap) => [...gap.matchAll(new RegExp(SECRET_PAIR_NAME_TEXT, 'gi'))].some((m) => secretPairName(m[3]))
// A PEM, PGP or SSH2 private key block from BEGIN to END, without END to the end of the text; the type is words with a space or a hyphen
// between them (NEW-STYLE), so a run of them stops at a double hyphen and the rule stays linear. cleanSecretText applies it to the whole text
// first, secretJson to the whole JSON text first (N11h, Codex P1 on PR #4992, review rec-N11h): a header on a line or in a string with a
// secret path became the marker before the mask saw it, and the key body on the next lines went to Jev with only the token patterns over it.
const SECRET_PEM = /(-{4,5} ?BEGIN (?:[A-Z0-9]+[ -])*PRIVATE KEY(?: BLOCK)? ?-{4,5})[\s\S]*?(-{4,5} ?END (?:[A-Z0-9]+[ -])*PRIVATE KEY(?: BLOCK)? ?-{4,5}|$)/g
const SECRET_TEXT_RULES = [
  [SECRET_PEM, '$1***$2'],
  [/(^|[^A-Za-z0-9+/=])(?=[A-Za-z0-9+/]{0,200}[A-Z])(?=[A-Za-z0-9+/]{0,200}[a-z])(?=[A-Za-z0-9+/]{0,200}\d)(?=[A-Za-z0-9+/]{0,200}[+/])[A-Za-z0-9+/]{40,}={0,2}/g, '$1***'],
]
function maskSecretText(text) {
  let s = String(text ?? '')
  s = s.replace(SECRET_PAIR_TEXT, (all, nk, s1, nv, gap, vk, s2, vv) => ((secretPairName(nv) || secretPairGap(gap)) && vv !== '"***"' ? `"${nk}"${s1}"${nv}"${gap}"${vk}"${s2}"***"` : all))
  s = s.replace(SECRET_PAIR_TEXT_BACK, (all, vk, s1, vv, gap, nk, s2, nv) => ((secretPairName(nv) || secretPairGap(gap)) && vv !== '"***"' ? `"${vk}"${s1}"***"${gap}"${nk}"${s2}"${nv}"` : all))
  const key = /"([^"\\\n]{1,100})"\s*:\s*/g
  let out = ''
  let last = 0
  let m
  while ((m = key.exec(s))) {
    const start = m.index + m[0].length
    const code = !SECRET_KEY.test(m[1]) && SECRET_CODE_KEY.test(m[1])
    if (!code && !SECRET_KEY.test(m[1])) continue
    const end = secretValueEnd(s, start)
    if (code && !SECRET_CODE_VALUE.test(s.slice(start, end).replace(/^"|"$/g, ''))) continue
    if (end <= start || s.slice(start, end) === '"***"') continue
    out += `${s.slice(last, start)}"***"`
    last = end
    key.lastIndex = end
  }
  if (last) s = out + s.slice(last)
  for (const [re, to] of SECRET_TEXT_RULES) s = s.replace(re, to)
  return s
}
// LOW-2 of rec-3b (M2 of the second round): `mask` is applied to every string; `maskWhole` (by default the same) to the serialised JSON text. A mask
// that may take a backslash into its value (maskSecretProse) goes as `mask` only, so that it cannot break the JSON text.
function secretJson(value, mask, marker, maskWhole = mask) {
  try {
    const raw = JSON.stringify(value) ?? ''
    // A key block (a header, its body, an END) can sit in one string or run over several. T2: such a value is cleaned over its tree (secretStructural),
    // not by cutting its JSON text: a header with no END took the rest of the text with it, the text no longer parsed and the callers lost the whole value
    // (maskJevState sent no query at all for a brief that only mentions "-----BEGIN ... PRIVATE KEY-----"); a block over several strings made its fields vanish.
    if (raw.includes('PRIVATE KEY') && raw.replace(SECRET_PEM, '$1***$2') !== raw) return secretStructural(JSON.parse(raw), mask, marker, maskWhole)
    return maskWhole(maskSecretText(JSON.stringify(value, secretJsonReplacer((x) => cleanSecretText(x, mask, marker, maskWhole))) ?? ''))
  } catch {
    return ''
  }
}
// T2: the key block rule over a value tree instead of its JSON text: from a BEGIN header to the next END, in the same string or in a later one; without
// an END the rest of the tree is masked (every later string value becomes ***; keys and other types stay). The header and the END stay, as SECRET_PEM
// leaves them. The result is always valid JSON.
const SECRET_PEM_BEGIN = /-{4,5} ?BEGIN (?:[A-Z0-9]+[ -])*PRIVATE KEY(?: BLOCK)? ?-{4,5}/g
const SECRET_PEM_END = /-{4,5} ?END (?:[A-Z0-9]+[ -])*PRIVATE KEY(?: BLOCK)? ?-{4,5}/g
function maskKeyBlocks(text, block) {
  let out = ''
  let pos = 0
  for (;;) {
    if (block.open) {
      SECRET_PEM_END.lastIndex = pos
      const end = SECRET_PEM_END.exec(text)
      if (!end) return `${out}***`
      out += `***${end[0]}`
      pos = end.index + end[0].length
      block.open = false
    } else {
      SECRET_PEM_BEGIN.lastIndex = pos
      const begin = SECRET_PEM_BEGIN.exec(text)
      if (!begin) return out + text.slice(pos)
      const headEnd = begin.index + begin[0].length
      out += text.slice(pos, headEnd)
      pos = headEnd
      block.open = true
    }
  }
}
function secretStructural(tree, mask, marker, maskWhole) {
  const block = { open: false }
  const walk = (v) => {
    if (typeof v === 'string') return maskKeyBlocks(v, block)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return JSON.stringify(walk(tree), secretJsonReplacer((x) => cleanSecretText(x, mask, marker, maskWhole))) ?? ''
}
function secretJsonText(text, mask, marker, maskWhole) {
  const t = text.trim()
  if ((t[0] !== '{' && t[0] !== '[') || t.length > SECRET_JSON_MAX) return null
  try {
    const parsed = JSON.parse(t)
    const out = secretJson(parsed, mask, marker, maskWhole)
    return out === JSON.stringify(parsed) ? text : out // JSON that nothing changed keeps the way it was written
  } catch { return null }
}
function cleanSecretText(text, mask, marker = SECRET_PATH_MARK, maskWhole = mask) {
  // Private key blocks first (N11h), then a JSON text or a JSON line through secretJson, a secret path in any other line in place, the rest masked.
  // No cut (K2): the rules are linear, so a text of any length is cleaned whole.
  const s = String(text ?? '').replace(SECRET_PEM, '$1***$2')
  const whole = secretJsonText(s, mask, marker, maskWhole)
  if (whole !== null) return whole
  const lines = s.split('\n').map((line) => secretJsonText(line, mask, marker, maskWhole) ?? maskSecretPaths(line, marker))
  return mask(maskSecretText(lines.join('\n')))
}
// Free text (an agent's answer, an owner's sentence; review rec-0d-0e MEDIUM-5): a secret word with its value but without the "name: value"
// shape the text masks need ("password Abc12345", "Hasło do panelu to Zaq12wsx", "client_secret Xy9-pQ7_rT2", "PIN telefonu 482913"). The
// value carries a digit and a letter (a word without a digit is prose: "token limit", "hasło jest za krótkie"); digits alone (4 or more) only
// after a PIN or password word; words between the secret word and its value only with "to", "jest", "is", ":" or "=" before the value, or a
// PIN with digits ("PIN telefonu 482913"). Longer words ("tokeny", "hasła") and "PIN-y" are not secret words. maskSecretProse(text) masks
// the value as ***; stage 0e of the compaction module applies it after maskSecrets, the panel and cleanForJev as the `mask` of cleanSecretText and secretJson (strings and plain text only). Every repetition before
// the value is bounded (panel-sekrety review: unbounded ones cost quadratic time on a long token of repeated secret words; 160 000
// characters took 101 s); a value found in its first 200 characters is masked to the end of its token.
const SECRET_PROSE_WORD = String.raw`password|passwd|passphrase|passcode|has[łl]o|pin|token|secret|client[_ -]?secret|api[_ -]?key|klucz(?:[ \t]+api)?|sekret`
const SECRET_PROSE_LINK = String.raw`[:=]|(?:to|jest|is|was|wynosi|brzmi)(?![\p{L}\p{N}_])`
const SECRET_PROSE = new RegExp(String.raw`(^|[^\p{L}\p{N}_])(${SECRET_PROSE_WORD})(?![\p{L}\p{N}_])((?:[ \t\r\n]{1,20}\p{L}{1,15}){0,3}?[ \t\r\n]{0,20}(?:(?:${SECRET_PROSE_LINK})[ \t\r\n]{0,20})?["']?)(?=[^\s"'\x60,;()<>\[\]{}]{0,200}\d)([^\s"'\x60,;()<>\[\]{}]{4,200}[^\s"'\x60,;()<>\[\]{}]*)`, 'giu')
const SECRET_PROSE_LINKED = new RegExp(String.raw`(?:^|[ \t\r\n])?(?:${SECRET_PROSE_LINK})[ \t\r\n]*["']?$`, 'iu')
function maskSecretProse(text) {
  return String(text ?? '').replace(SECRET_PROSE, (all, lead, word, mid, value) => {
    // MEDIUM-2 of rec-3b: a value at the end of a sentence carries its full stop ("PIN do karty to 4829."), one in a string a backslash before or after it; the tests and the mask take the core.
    let end = value.length // loops, not a regex: a long run of dots inside the value must not cost quadratic time
    while (end > 0 && '.!?…\\'.includes(value[end - 1])) end--
    let start = 0
    while (start < end && value[start] === '\\') start++
    const head = value.slice(0, start)
    const core = value.slice(start, end)
    const tail = value.slice(end)
    if (core.length < 4) return all
    const digits = /^\d+$/.test(core)
    // M2 of the second round: digits alone also after any secret word standing on a line of its own or in a tab-separated field ("token\n482913").
    if (digits ? !(/^(?:pin|has[łl]o|password|passwd|passcode)$/iu.test(word) || /[\t\r\n]/.test(mid)) : !/\p{L}/u.test(core)) return all
    const between = mid.trim().replace(/["']$/, '')
    const linked = SECRET_PROSE_LINKED.test(between)
    const words = between.replace(SECRET_PROSE_LINKED, '').trim()
    if (words && !linked && !(digits && /^pin$/iu.test(word))) return all
    return `${lead}${word}${mid}${head}***${tail}`
  })
}
// The token patterns (moved here from scripts/lib/jev-shell.mjs and the hooks module: one source). The rules and their order are those of
// jev-shell.mjs (N11j bounded names in the KEY= rule, the Polish names of A3) plus the prefixes of a few more providers' tokens of the hooks
// module. Every rule reads a text once: the three that read the rest of it again from every start that failed (Authorization followed by
// spaces, mysql -p words without a value, eyJ without the three parts; 100 000 characters took 4 to 18 s, 1 000 000 more than 60 s) consume
// the run they scanned and leave it unchanged (branch fix/jev-mask-linear of the fork); the result is the same byte for byte.
function maskSecrets(text) {
  return String(text ?? '')
    .replace(SECRET_PEM, '$1***$2') // END stays, so a later mask of JSON text does not take the rest (N11h)
    .replace(/(\/\/[^/\s:@]+:)[^/\s@]+@/g, '$1***@')
    .replace(/((?:authorization|proxy-authorization)\s*:\s*(?:(?:bearer|basic|token)\s*)?)[^\s"']+/gi, '$1***')
    .replace(/((?:set-)?cookie\s*:\s*)[^\r\n"']+/gi, '$1***')
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(/((?:^|\s)(?:-u|--user)(?:\s+|=)["']?[^\s:"']+:)[^\s"']+/g, '$1***')
    .replace(/((?:^|\s)--(?:password|passwd|pass|token|secret|api-key|apikey|access-token|auth-token|client-secret)(?:\s+|=)["']?)[^\s"']+/gi, '$1***')
    // At each step ` -p` and a value is tried before the segment end; a word without a value keeps its segment unchanged (a later mysql word of the same segment cannot find a value the earlier one missed).
    .replace(/(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n|;&]*?)(?:(\s-p)[^\s"']+|(?=[\n|;&]|$))/g, (whole, head, flag) => (flag ? head + flag + '***' : whole))
    .replace(/(\bsshpass\s+-p\s*["']?)[^\s"']+/g, '$1***')
    .replace(/\b(sk-(?:ant-|proj-)?)[A-Za-z0-9_-]{12,}/g, '$1***')
    .replace(/\b(gh[pousr]_|github_pat_|glpat-|xox[abprs]-)[A-Za-z0-9_-]{10,}/g, '$1***')
    .replace(/\b((?:sk|rk|pk)_(?:live|test)_|hf_|npm_)[A-Za-z0-9]{16,}/g, '$1***')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***')
    // A JWT, or else the rest of the run kept unchanged; the run class has no dot, so a match with a dot is the JWT.
    .replace(/\beyJ(?:[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]*)/g, (whole) => (whole.includes('.') ? 'eyJ***' : whole))
    .replace(/(\b[A-Za-z0-9_]{0,64}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?)[A-Za-z0-9_]{0,64}["'\]]*\s*[=:]\s*["']?)[^\s"'&;|)]+/gi, '$1***') // omc-lokalne N11j: bounded names
    .replace(/((?:api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|password|passwd|token|secret)["']?\s*[:=]\s*["']?)[^\s"'&;|,}]+/gi, '$1***')
    // omc-lokalne A3 (rec-panel L7): Polish names, "nazwa: wartość" and "nazwa=wartość" (hasło/haslo, klucz API/klucz, PIN, token, sekret)
    .replace(/((?:^|[^\p{L}\p{N}_])(?:has[łl]o|klucz(?:[ \t]+API)?|PIN|token|sekret)[ \t]*[:=][ \t]*["']?)[^\s"'&;|,}]+/giu, '$1***')
    .replace(/(?<![A-Za-z0-9+_-])(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{32,}={0,2}/g, '***')
}
// The number of places a cleaning replaced: the `***` and the path markers of the text after, less those of the text before (the field
// maska_miejsc of the log row). `marker` is the replacement of a secret path the cleaning used.
function countMaskedPlaces(before, after, marker = SECRET_PATH_MARK) {
  const count = (text, part) => { let n = 0; for (let i = text.indexOf(part); i >= 0; i = text.indexOf(part, i + part.length)) n++; return n }
  const places = (text) => { const s = String(text ?? ''); return count(s, '***') + (marker ? count(s, marker) : 0) }
  return Math.max(0, places(after) - places(before))
}
// </jev-sekrety>

export { SECRET_PATH, SECRET_KEY, SECRET_PEM, SECRET_PATH_MARK, secretPathIn, maskSecretPaths, secretJsonReplacer, maskSecretText, secretJson, cleanSecretText, maskSecretProse, maskSecrets, countMaskedPlaces };
