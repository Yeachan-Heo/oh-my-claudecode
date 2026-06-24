/**
 * Claude Code project-directory character sanitization.
 *
 * Claude Code stores a project's transcripts under
 * `~/.claude/projects/<encoded>`. For normal-length project paths, this helper
 * mirrors Claude Code's character replacement step: every character that is not
 * an ASCII letter or digit is replaced by `-`. That covers path separators,
 * dots, and the Windows drive colon, but also — importantly — underscores,
 * spaces, and non-ASCII characters. For
 * example:
 *
 *   POSIX:    /home/me/proj        -> -home-me-proj
 *   POSIX:    /home/me/my.proj     -> -home-me-my-proj
 *   POSIX:    /home/me/00_proj     -> -home-me-00-proj
 *   Windows:  C:\Users\me\proj     -> C--Users-me-proj
 *
 * Any character left unsanitized produces a name that never matches the real
 * directory, so any lookup keyed on the encoded name finds zero transcripts.
 * Replacing only `/ \ . :` left underscores intact, which broke `session_search`
 * in `current` scope for every project whose path contained `_` (see #3329); the
 * earlier drive-colon-only fix had the same shape on Windows.
 *
 * This helper intentionally mirrors only Claude Code's normal-length character
 * replacement/sanitization step, not its full long-path contract (which also
 * truncates very long encoded names and appends a hash). It remains the single
 * source of truth for that normal-length encoding: both the session history
 * search (`features/session-history-search`) and the worktree transcript
 * resolver (`lib/worktree-paths`) must encode identically — keeping
 * the rule in one place prevents the two from drifting apart (the drive-colon
 * fix originally landed only in session-history-search; see PR #3274).
 */
export declare function encodeProjectPath(projectPath: string): string;
//# sourceMappingURL=encode-project-path.d.ts.map