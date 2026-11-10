/**
 * Secret masking for text the Jev compaction point sends or keeps: private keys, URL credentials,
 * Authorization and Cookie headers, bearer tokens, password flags, common token prefixes,
 * `*KEY=`-style assignments and long mixed letter-digit strings.
 *
 * No imports and no Node APIs: the Claude Code hooks module hooks/jev-compaction.mjs imports this
 * file too, and a hooks module may import only plain files of its plugin.
 */
export function maskSecrets(text, { keepGitHashes = false } = {}) {
  return String(text ?? '')
    .replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '$1***')
    .replace(/(\/\/[^/\s:@]+:)[^/\s@]+@/g, '$1***@')
    .replace(/((?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic|token)?\s*)[^\s"']+/gi, '$1***')
    .replace(/((?:set-)?cookie\s*:\s*)[^\r\n"']+/gi, '$1***')
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(/((?:^|\s)(?:-u|--user)(?:\s+|=)["']?[^\s:"']+:)[^\s"']+/g, '$1***')
    .replace(/((?:^|\s)--(?:password|passwd|pass|token|secret|api-key|apikey|access-token|auth-token|client-secret)(?:\s+|=)["']?)[^\s"']+/gi, '$1***')
    .replace(/(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n|;&]*?\s-p)(?=\S)[^\s"']+/g, '$1***')
    .replace(/(\bsshpass\s+-p\s*["']?)[^\s"']+/g, '$1***')
    .replace(/\b(sk-(?:ant-|proj-)?)[A-Za-z0-9_-]{12,}/g, '$1***')
    .replace(/\b(gh[pousr]_|github_pat_|glpat-|xox[abprs]-)[A-Za-z0-9_-]{10,}/g, '$1***')
    .replace(/\b((?:sk|rk|pk)_(?:live|test)_|hf_|npm_)[A-Za-z0-9]{16,}/g, '$1***')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'eyJ***')
    .replace(/(\b[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?)[A-Za-z0-9_]*["'\]]*\s*[=:]\s*["']?)[^\s"'&;|)]+/gi, '$1***')
    .replace(/((?:api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|password|passwd|token|secret)["']?\s*[:=]\s*["']?)[^\s"'&;|,}]+/gi, '$1***')
    .replace(/(^|[^A-Za-z0-9+_-])(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])([A-Za-z0-9+_-]{32,}={0,2})/g, (whole, before, token) =>
      keepGitHashes && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(token) ? whole : before + '***');
}
