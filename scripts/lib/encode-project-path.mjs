/**
 * Claude Code project-directory name encoding (hook-runtime mirror).
 *
 * Mirror of `src/utils/encode-project-path.ts` — keep the two in sync. The TS
 * helper is the source of truth; this `.mjs` copy exists because the hook
 * runtime loads raw scripts and cannot import the compiled `dist/` util.
 *
 * Claude Code stores a project's transcripts under
 * `~/.claude/projects/<encoded>` where `<encoded>` is the project's absolute
 * path with path separators, dots, and the Windows drive colon all replaced
 * by `-`. For example:
 *
 *   POSIX:    /home/me/proj      -> -home-me-proj
 *   POSIX:    /home/me/my.proj   -> -home-me-my-proj
 *   Windows:  C:\Users\me\proj   -> C--Users-me-proj
 *
 * Dropping the dot or the drive colon produces a name that never matches the
 * real directory, so any lookup keyed on the encoded name (e.g. worktree
 * transcript resolution) silently finds nothing.
 */
export function encodeProjectPath(projectPath) {
  return projectPath.replace(/[/\\.:]/g, '-');
}
