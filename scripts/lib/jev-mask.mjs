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
  return maskPrivateKeys(text)
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
    .replace(/((?:api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|password|passwd|token|secret|has[łl]o|klucz|sekret|passwort|kennwort|contrase[ñn]a)(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)(?:(?<=\\")(?:[^\\\n]|\\(?!"))*(?=\\")|(?<=")(?:[^"\\\n]|\\.)*(?=")|(?<=')(?:[^'\\\n]|\\.|'')*(?=')|[^\s"'&;|,}]+)/gi, '$1***')
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
  return String(text ?? '').replace(/(-{4,5} ?BEGIN (?:[A-Z0-9]+[ -])*PRIVATE KEY(?: BLOCK)? ?-{4,5})[\s\S]*?(-{4,5} ?END (?:[A-Z0-9]+[ -])*PRIVATE KEY(?: BLOCK)? ?-{4,5}|$)/g, '$1***$2');
}
