/**
 * Claude Code project-directory name encoding.
 *
 * Claude Code stores a project's transcripts under
 * `~/.claude/projects/<encoded>` where `<encoded>` is the project's absolute
 * path with path separators, dots, and the Windows drive colon all replaced
 * by `-`. For example:
 *
 *   POSIX:    /home/me/proj      -> -home-me-proj
 *   Windows:  C:\Users\me\proj   -> C--Users-me-proj
 *
 * The drive colon matters: omitting `:` produces `C:-Users-me-proj`, which
 * never matches the real directory, so any lookup keyed on the encoded name
 * finds zero transcripts on Windows. POSIX paths contain no colon, so the
 * colon replacement is a no-op there.
 *
 * This is the single source of truth for that encoding. Both the session
 * history search (`features/session-history-search`) and the worktree
 * transcript resolver (`lib/worktree-paths`) must encode identically — keeping
 * the rule in one place prevents the two from drifting apart (the drive-colon
 * fix originally landed only in session-history-search; see PR #3274).
 */
export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/[/\\.:]/g, '-');
}
