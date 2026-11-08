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
/**
 * Resolve the Claude Code configuration directory.
 *
 * Honours CLAUDE_CONFIG_DIR (absolute path, or ~-prefixed) with fallback
 * to ~/.claude.  Trailing separators are stripped; filesystem roots are
 * preserved.
 */
export declare function getClaudeConfigDir(): string;
/**
 * Resolve the OMC global configuration/cache directory under the active Claude
 * config dir. This keeps hook/updater/HUD caches aligned with CLAUDE_CONFIG_DIR
 * instead of mixing in ~/.omc.
 */
export declare function getOmcConfigDir(): string;
/** Resolve the canonical update-check cache file path. */
export declare function getUpdateCheckCachePath(): string;
//# sourceMappingURL=config-dir.d.ts.map