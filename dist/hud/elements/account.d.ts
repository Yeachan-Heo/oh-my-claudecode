/**
 * OMC HUD - Account Element
 *
 * Opt-in element that displays the signed-in Claude account's email address.
 * Useful when switching between accounts or profiles via CLAUDE_CONFIG_DIR.
 *
 * Security mitigations:
 * - Plain-email allowlist: rejects whitespace, C0/C1 controls, ESC, and bidi controls
 * - ~64-char middle-ellipsis cap
 * - O_NOFOLLOW | O_NONBLOCK open (no symlink/TOCTOU attacks)
 * - fstat verify: regular file only, size check
 * - Cache source path and metadata (mtimeMs, size, inode) to avoid stale emails
 * - Renders nothing when signed out or when auth comes from ANTHROPIC_API_KEY
 */
/**
 * Render the account email element.
 *
 * Format: acct:<email>
 *
 * Returns null if:
 * - No email is available
 * - Email validation fails
 * - Signed out (no .claude.json or no oauthAccount)
 * - Auth comes from API key (email would not be present)
 */
export declare function renderAccount(): string | null;
//# sourceMappingURL=account.d.ts.map