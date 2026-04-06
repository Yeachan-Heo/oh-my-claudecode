/**
 * Claude Code Configuration Directory Resolution
 *
 * Resolves the active Claude Code configuration directory, honouring
 * CLAUDE_CONFIG_DIR (absolute path, or ~-prefixed) with fallback to
 * ~/.claude.  Trailing separators are stripped; filesystem roots are
 * preserved.
 *
 * Multi-surface mirrors (keep in sync):
 *   scripts/lib/config-dir.mjs   — ESM hook/HUD runtime
 *   scripts/lib/config-dir.cjs   — CJS bridge runtime
 *   scripts/lib/config-dir.sh    — POSIX shell runtime
 */
import { join, normalize, parse, sep } from 'path';
import { homedir } from 'os';
/**
 * Strip a single trailing path separator (preserve filesystem root).
 * @internal Shared with scripts/lib/config-dir.{mjs,cjs,sh} — keep in sync.
 */
function stripTrailingSep(p) {
    if (!p.endsWith(sep)) {
        return p;
    }
    return p === parse(p).root ? p : p.slice(0, -1);
}
/**
 * Resolve the Claude Code configuration directory.
 *
 * Honours CLAUDE_CONFIG_DIR (absolute path, or ~-prefixed) with fallback
 * to ~/.claude.  Trailing separators are stripped; filesystem roots are
 * preserved.
 */
export function getClaudeConfigDir() {
    const home = homedir();
    const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
    if (!configured) {
        return stripTrailingSep(normalize(join(home, '.claude')));
    }
    if (configured === '~') {
        return stripTrailingSep(normalize(home));
    }
    if (configured.startsWith('~/') || configured.startsWith('~\\')) {
        return stripTrailingSep(normalize(join(home, configured.slice(2))));
    }
    return stripTrailingSep(normalize(configured));
}
//# sourceMappingURL=config-dir.js.map