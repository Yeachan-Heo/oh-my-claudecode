/**
 * The masks of a series of traces in the Jev compaction point (hooks/jev-compaction.mjs): what a merged series holds can name
 * files, commands and words of the conversation, so the text sent to Jev goes through cleanForJevLong, and the text written to
 * the file of the series through archiveMaskedLong and maskResidualLines.
 *
 * cleanForJevLong: private key blocks, JSON values and name/value pairs under secret names, a line that names a secret path
 * replaced whole, the token shapes of maskSecrets, and a secret word followed by its value in free text ("the password is X").
 * A text longer than the mask reads at once is masked in pieces of whole lines.
 * archiveMaskedLong: the same, repeated until nothing changes, plus a value after a secret word and a link word.
 * maskResidualLines: a line where a secret word is still followed by a value with a letter and a digit is replaced whole.
 *
 * Words of other languages than English in the patterns (written as \u escapes) are the secret words and link words they find.
 * No imports and no Node APIs: a hooks module may import only plain files of its plugin.
 */
const SECRET_TOKEN_CHAR = String.raw`[^\s"'\x60;|&<>(),:\]}]`
const SECRET_NAME_CHAR = String.raw`[^\s"'\x60\\/;|&<>(),:\]}]`
const SECRET_BOUNDARY = String.raw`(?:^|[\\/\s"'\x60=:(;|&,<>])`
const SECRET_END = `(?!${SECRET_TOKEN_CHAR})`
const SECRET_SSH_FILE = `(?!known_hosts|authorized_keys|(?:config|environment|rc)${SECRET_END}|config\\.d[\\\\/])(?!${SECRET_TOKEN_CHAR}{0,255}\\.pub${SECRET_END})${SECRET_TOKEN_CHAR}+`
const SECRET_PATH = new RegExp([
  `${SECRET_BOUNDARY}\\.ssh${SECRET_END}|\\.ssh[\\\\/]+(?:${SECRET_SSH_FILE})?${SECRET_END}`,
  String.raw`ssh_host_[^\s"'\\/]{0,64}_key(?![a-z0-9_.-])`,
  `(?:^|[^a-z0-9])id_(?:rsa|dsa|ecdsa|ed25519)(?![a-z])(?!${SECRET_TOKEN_CHAR}{0,255}\\.pub${SECRET_END})`,
  String.raw`\.git-credentials(?![a-z0-9_-])`,
  `${SECRET_BOUNDARY}gh[\\\\/]+hosts\\.ya?ml\\b|github cli[\\\\/]+hosts\\.ya?ml\\b`,
  String.raw`\.credentials\.json\b`,
  `${SECRET_BOUNDARY}\\.env(?:\\.(?!(?:example|sample|template|dist|defaults?|tpl)(?!${SECRET_NAME_CHAR}))${SECRET_NAME_CHAR}{1,255})?${SECRET_END}`,
  `${SECRET_BOUNDARY}\\.envrc${SECRET_END}`,
  `(?:(?:prod|production|dev|development|staging|stage|test|local|secrets?|private|credentials?|app|docker|db|database|api|backup|bak|kopia|copy|old|orig|stary|save)\\d{0,9}|[-_]\\d{0,9}|(?:^|[^a-z0-9])\\d{1,9})\\.env(?:\\.(?!(?:example|sample|template|dist|defaults?|tpl)(?!${SECRET_NAME_CHAR}))${SECRET_NAME_CHAR}{1,255})?${SECRET_END}`,
  `[\\\\/]${SECRET_NAME_CHAR}{1,120}\\.env${SECRET_END}`,
  String.raw`rclone\.conf\b`,
  String.raw`[._]netrc(?![a-z])`,
  String.raw`\.pgpass(?![a-z])|pgpass\.conf\b`,
  String.raw`\.npmrc(?![a-z])`,
  String.raw`\.aws[\\/]+credentials\b`,
  String.raw`\.docker[\\/]+config\.json\b`,
  String.raw`\.config[\\/]+typesafe(?![a-z])`,
  `\\.gnupg(?![a-z0-9_-])|(?:[\\\\/]|${SECRET_BOUNDARY})gnupg[\\\\/]`,
  String.raw`typesafe[\\/]+env\b|[\\/]etc[\\/]+g?shadow\b`,
  String.raw`\.pypirc(?![a-z])|\.kube[\\/]+config\b`,
  `token(?!iz)${SECRET_NAME_CHAR}{0,80}\\.json\\b`,
  `${SECRET_BOUNDARY}(?:sa-key|service[-_]?account${SECRET_NAME_CHAR}{0,80}|client_secret${SECRET_NAME_CHAR}{0,80}|credentials)\\.json\\b`,
  `\\.(?:pem|p12|pfx|jks|keystore|kdbx|ppk)${SECRET_END}`,
  `(?:[\\\\/]${SECRET_NAME_CHAR}{1,120}|${SECRET_BOUNDARY}(?:priv|private|server|client|tls|ssl|signing|id)${SECRET_NAME_CHAR}{0,80})\\.key${SECRET_END}`,
].join('|'), 'i')
const SECRET_GLOB = /\/\.[^/\s"']{0,64}[*?[]/
function secretPathIn(text, command) {
  const s = String(text ?? '')
  return SECRET_PATH.test(s) || (/["'\\]/.test(s) && SECRET_PATH.test(s.replace(/["'\\]/g, ''))) || Boolean(command && SECRET_GLOB.test(s))
}
const SECRET_KEY = /key(?!word|board|stroke|frame)|token|secret|passw|pass(?:[_-]?(?:phrase|wd|code)|$|[^a-z])|pwd|credential|auth(?!ors?(?:$|[^i]))|cookie|session(?:[_-]?id)?$|^sid$|^otp$|otp[_-]?(?:code|secret)|pin(?:[_-]?code)?$|has[\u0142l]o|klucz|sekret|signature|private/i
const SECRET_CODE_KEY = /^(?:code|kod)$/i
const SECRET_CODE_VALUE = /^\s*[A-Za-z0-9]{4,10}(?:-[A-Za-z0-9]{4,10})?\s*$/
const SECRET_PAIR_NAME = /(?:^|[a-z_])(?:name|key|type)$|^(?:nazwa|klucz|label|field|header|variable|zmienna)$/i
const SECRET_PAIR_VALUE = /(?:^|[a-z_])(?:value|values|val)$|^(?:wartosc|warto\u015b\u0107|text|content|data)$/i
const SECRET_PAIR_TYPE = /^securestring$/i
const secretPairName = (x) => typeof x === 'string' && (SECRET_KEY.test(x) || SECRET_PAIR_TYPE.test(x))
const SECRET_FLAG = /^--?(?:password|passwd|pass|pwd|token|secret|api-?key|access-token|auth-token|client-secret|passphrase)$/i
const SECRET_MYSQL = /^(?:.*[\\/])?(?:mysql|mysqldump|mysqladmin|mariadb)(?:\.exe)?$/i
const SECRET_JSON_MAX = 1000000
const SECRET_TEXT_HALF = 100000
const SECRET_LINE_EXTRA = 4000
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
      return Object.fromEntries(entries.map(([k, x]) => [secretPathIn(k) ? clean(k) : k, pair && SECRET_PAIR_VALUE.test(k) && x !== null && typeof x !== 'boolean' ? '***' : x]))
    }
    return v
  }
}
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
const SECRET_PAIR_GAP = String.raw`((?:\s*,\s*"[^"\\\n]{0,40}"\s*:\s*(?:"[^"\\\n]{0,200}"|[^,{}\[\]\s"]{1,40})){0,6}?\s*,\s*)`
const SECRET_PAIR_GAP_BACK = SECRET_PAIR_GAP.replace('{0,6}?', '{0,6}')
const SECRET_PAIR_NAME_TEXT = String.raw`"([A-Za-z_]{0,40}(?:name|key|type))"(\s*:\s*)"([^"\\\n]{0,200})"`
const SECRET_PAIR_VALUE_TEXT = String.raw`"([A-Za-z_]{0,40}(?:value|val))"(\s*:\s*)("(?:[^"\\\n]|\\.){0,4000}"|[^,}\]\s]{1,200})`
const SECRET_PAIR_TEXT = new RegExp(SECRET_PAIR_NAME_TEXT + SECRET_PAIR_GAP + SECRET_PAIR_VALUE_TEXT, 'gi')
const SECRET_PAIR_TEXT_BACK = new RegExp(SECRET_PAIR_VALUE_TEXT + SECRET_PAIR_GAP_BACK + SECRET_PAIR_NAME_TEXT, 'gi')
const secretPairGap = (gap) => [...gap.matchAll(new RegExp(SECRET_PAIR_NAME_TEXT, 'gi'))].some((m) => secretPairName(m[3]))
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
function secretJson(value, mask, marker, maskWhole = mask) {
  try {
    const raw = JSON.stringify(value) ?? ''
    const cut = raw.replace(SECRET_PEM, '$1***$2')
    if (cut !== raw) {
      try { value = JSON.parse(cut) } catch { return cleanSecretText(cut, mask, marker, maskWhole) }
    }
    return maskWhole(maskSecretText(JSON.stringify(value, secretJsonReplacer((x) => cleanSecretText(x, mask, marker, maskWhole))) ?? ''))
  } catch {
    return ''
  }
}
function secretJsonText(text, mask, marker, maskWhole) {
  const t = text.trim()
  if ((t[0] !== '{' && t[0] !== '[') || t.length > SECRET_JSON_MAX) return null
  try { return secretJson(JSON.parse(t), mask, marker, maskWhole) } catch { return null }
}
function cleanSecretText(text, mask, marker, maskWhole = mask) {
  let s = String(text ?? '').replace(SECRET_PEM, '$1***$2')
  if (s.length > 2 * SECRET_TEXT_HALF) {
    const a = s.indexOf('\n', SECRET_TEXT_HALF - 1)
    const end = a < 0 || a > SECRET_TEXT_HALF + SECRET_LINE_EXTRA ? SECRET_TEXT_HALF + SECRET_LINE_EXTRA : a
    const b = s.lastIndexOf('\n', s.length - SECRET_TEXT_HALF)
    const start = b < s.length - SECRET_TEXT_HALF - SECRET_LINE_EXTRA ? s.length - SECRET_TEXT_HALF - SECRET_LINE_EXTRA : b + 1
    if (end < start) {
      let head = s.slice(0, end)
      let tail = s.slice(start)
      let omitted = start - end
      if (s[end] !== '\n') { const keep = head.lastIndexOf('\n') + 1; omitted += end - keep; head = `${head.slice(0, keep)}${marker}` }
      if (s[start - 1] !== '\n') { const n = tail.indexOf('\n'); omitted += n < 0 ? tail.length : n; tail = n < 0 ? marker : `${marker}${tail.slice(n)}` }
      s = `${head}\n[... ${omitted} chars omitted ...]\n${tail}`
    }
  }
  const whole = secretJsonText(s, mask, marker, maskWhole)
  if (whole !== null) return whole
  const lines = s.split('\n').map((line) => (secretPathIn(line) ? marker : secretJsonText(line, mask, marker, maskWhole) ?? line))
  return mask(maskSecretText(lines.join('\n')))
}
const SECRET_PROSE_WORD = String.raw`password|passwd|passphrase|passcode|has[\u0142l]o|pin|token|secret|client[_ -]?secret|api[_ -]?key|klucz(?:[ \t]+api)?|sekret`
const SECRET_PROSE_LINK = String.raw`[:=]|(?:to|jest|is|was|wynosi|brzmi)(?![\p{L}\p{N}_])`
const SECRET_PROSE = new RegExp(String.raw`(^|[^\p{L}\p{N}_])(${SECRET_PROSE_WORD})(?![\p{L}\p{N}_])((?:[ \t\r\n]{1,20}\p{L}{1,15}){0,3}?[ \t\r\n]{0,20}(?:(?:${SECRET_PROSE_LINK})[ \t\r\n]{0,20})?["']?)(?=[^\s"'\x60,;()<>\[\]{}]{0,200}\d)([^\s"'\x60,;()<>\[\]{}]{4,200}[^\s"'\x60,;()<>\[\]{}]*)`, 'giu')
const SECRET_PROSE_LINKED = new RegExp(String.raw`(?:^|[ \t\r\n])?(?:${SECRET_PROSE_LINK})[ \t\r\n]*["']?$`, 'iu')
function maskSecretProse(text) {
  return String(text ?? '').replace(SECRET_PROSE, (all, lead, word, mid, value) => {
    let end = value.length
    while (end > 0 && '.!?\u2026\\'.includes(value[end - 1])) end--
    let start = 0
    while (start < end && value[start] === '\\') start++
    const head = value.slice(0, start)
    const core = value.slice(start, end)
    const tail = value.slice(end)
    if (core.length < 4) return all
    const digits = /^\d+$/.test(core)
    if (digits ? !(/^(?:pin|has[\u0142l]o|password|passwd|passcode)$/iu.test(word) || /[\t\r\n]/.test(mid)) : !/\p{L}/u.test(core)) return all
    const between = mid.trim().replace(/["']$/, '')
    const linked = SECRET_PROSE_LINKED.test(between)
    const words = between.replace(SECRET_PROSE_LINKED, '').trim()
    if (words && !linked && !(digits && /^pin$/iu.test(word))) return all
    return `${lead}${word}${mid}${head}***${tail}`
  })
}
const SECRET_WORD = /(?<![\p{L}\p{N}_])(?:has[\u0142l](?:o|a|em|u|ach|ami|om)?|has[e\u0119][\u0142l]|ha\u015ble|klucz(?:a|e|em|u|y|om|ami|ach)?|pin(?:u|em|y|\u00f3w)?|token(?:a|u|em|ie)?|sekret(?:u|em|y|\u00f3w|ami|ach)?|secrets?|passwords?|passwd|passphrase|passcode|api[ _-]?keys?|apikeys?|private[ _-]?keys?|credentials?)(?![\p{L}\p{N}_])/iu
const SECRET_LINE = '[line omitted: secret path]'
function maskSecrets(text) {
  return String(text ?? '')
    .replace(/(-{4,5} ?BEGIN (?:[A-Z0-9]+[ -])*PRIVATE KEY(?: BLOCK)? ?-{4,5})[\s\S]*?(-{4,5} ?END (?:[A-Z0-9]+[ -])*PRIVATE KEY(?: BLOCK)? ?-{4,5}|$)/g, '$1***$2')
    .replace(/(\/\/[^/\s:@]+:)[^/\s@]+@/g, '$1***@')
    .replace(/((?:authorization|proxy-authorization)\s*:\s*(?:(?:bearer|basic|token)\s*)?)[^\s"']+/gi, '$1***')
    .replace(/((?:set-)?cookie\s*:\s*)[^\r\n"']+/gi, '$1***')
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(/((?:^|\s)(?:-u|--user)(?:\s+|=)["']?[^\s:"']+:)[^\s"']+/g, '$1***')
    .replace(/((?:^|\s)--(?:password|passwd|pass|token|secret|api-key|apikey|access-token|auth-token|client-secret)(?:\s+|=)["']?)[^\s"']+/gi, '$1***')
    .replace(/(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n|;&]*?)(?:(\s-p)[^\s"']+|(?=[\n|;&]|$))/g, (whole, head, flag) => (flag ? head + flag + '***' : whole))
    .replace(/(\bsshpass\s+-p\s*["']?)[^\s"']+/g, '$1***')
    .replace(/\b(sk-(?:ant-|proj-)?)[A-Za-z0-9_-]{12,}/g, '$1***')
    .replace(/\b(gh[pousr]_|github_pat_|glpat-|xox[abprs]-)[A-Za-z0-9_-]{10,}/g, '$1***')
    .replace(/\b((?:sk|rk|pk)_(?:live|test)_|hf_|npm_)[A-Za-z0-9]{16,}/g, '$1***')
    .replace(/\b(gsk_|xai-)[A-Za-z0-9_-]{8,}/g, '$1***')
    .replace(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '$1***')
    .replace(/\beyJ(?:[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]*)/g, (match) => (match.includes('.') ? 'eyJ***' : match))
    .replace(/(\b(?=[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?))[A-Za-z0-9_]+\b["'\]]*\s*[=:]\s*["']?)[^\s"'&;|)]+/gi, '$1***')
    .replace(/((?:api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|password|passwd|token|secret)["']?\s*[:=]\s*["']?)[^\s"'&;|,}]+/gi, '$1***')
    .replace(/((?:^|[^\p{L}\p{N}_])(?:has[\u0142l]o|klucz(?:[ \t]+API)?|PIN|token|sekret)[ \t]*[:=][ \t]*["']?)[^\s"'&;|,}]+/giu, '$1***')
    .replace(/(^|[^A-Za-z0-9+_-])(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{32,}={0,2}/g, '$1***')
}
const cleanForJev = (text) => cleanSecretText(text, (x) => maskSecretProse(maskSecrets(x)), SECRET_LINE, maskSecrets)
const LINKED_VALUE = String.raw`[^\s"'\x60,;()<>\[\]{}]`
const LINKED_PROSE = new RegExp(String.raw`((?:^|[^\p{L}\p{N}_])(?:${SECRET_PROSE_WORD})(?![\p{L}\p{N}_])(?:[ \t]{1,20}\p{L}{1,15}){0,3}?[ \t]{0,20}(?:[:=][ \t]{0,20}["'\x60]?(?!\*\*\*)(?=${LINKED_VALUE}{4})|(?<![\p{L}\p{N}_])(?:to|jest|is|was|wynosi|brzmi)(?![\p{L}\p{N}_])[ \t]{0,20}["'\x60]?(?!\*\*\*)(?=${LINKED_VALUE}{0,200}\d|${LINKED_VALUE}{10})))${LINKED_VALUE}{4,}`, 'giu')
const RESIDUAL_SECRET = new RegExp(String.raw`${SECRET_WORD.source}[^\n]{0,40}?(?<![\p{L}\p{N}_*])(?=[\p{L}\p{N}_+/=-]{0,80}\p{L})(?=[\p{L}\p{N}_+/=-]{0,80}\p{N})(?![^\s]{0,80}\*\*\*)[\p{L}\p{N}_+/=-]{6,}`, 'iu')
const MASK_CHUNK = 150000
const MASK_JOIN = 1500
function maskByChunks(text, mask) {
  const whole = text.replace(SECRET_PEM, '$1***$2')
  if (whole.length <= 2 * SECRET_TEXT_HALF) return mask(whole)
  const parts = []
  for (let at = 0; at < whole.length;) {
    let end = Math.min(whole.length, at + MASK_CHUNK)
    if (end < whole.length) {
      const nl = whole.lastIndexOf('\n', end - 1)
      if (nl >= at) end = nl + 1
      else { const next = whole.indexOf('\n', end - 1); end = next < 0 ? whole.length : next + 1 }
    }
    parts.push(whole.slice(at, end))
    at = end
  }
  const done = parts.map(mask)
  if (done.some((x) => x === undefined)) return undefined
  for (let k = 1; k < done.length; k++) {
    const tail = done[k - 1].slice(-MASK_JOIN)
    const head = done[k].slice(0, MASK_JOIN)
    const joined = mask(tail + head)
    if (joined === undefined) return undefined
    done[k - 1] = done[k - 1].slice(0, done[k - 1].length - tail.length)
    done[k] = joined + done[k].slice(head.length)
  }
  return done.join('')
}
const ARCHIVE_MASK_ROUNDS = 3
const archiveMask = (s) => cleanForJev(s).replace(LINKED_PROSE, '$1***')
function archiveMaskedLong(text) { return maskByChunks(text, archiveMasked) }
const cleanForJevLong = (text) => maskByChunks(text, cleanForJev)
function archiveMasked(text) {
  if (text.length > 2 * SECRET_TEXT_HALF) return undefined
  let s = text
  for (let k = 0; k < ARCHIVE_MASK_ROUNDS; k++) {
    if (s.length > 2 * SECRET_TEXT_HALF) return undefined
    const next = archiveMask(s)
    if (next === s) return s
    s = next
  }
  return archiveMask(s) === s ? s : undefined
}
const RESIDUAL_LINE = '*** [line with a possible secret replaced]'
function maskResidualLines(text) {
  const re = new RegExp(RESIDUAL_SECRET.source, 'giu')
  const ranges = []
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const from = text.lastIndexOf('\n', m.index) + 1
    const nl = text.indexOf('\n', m.index + m[0].length)
    const end = nl < 0 ? text.length : nl
    const last = ranges[ranges.length - 1]
    if (last && from <= last[1]) last[1] = Math.max(last[1], end); else ranges.push([from, end])
    re.lastIndex = Math.max(end, m.index + 1)
  }
  if (!ranges.length) return text
  let out = ''
  let at = 0
  for (const [from, end] of ranges) { out += text.slice(at, from) + RESIDUAL_LINE; at = end }
  return out + text.slice(at)
}

export { cleanForJevLong, archiveMaskedLong, maskResidualLines, RESIDUAL_SECRET };
