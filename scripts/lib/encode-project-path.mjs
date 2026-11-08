/**
 * Claude Code project-directory character sanitization (hook-runtime mirror).
 *
 * Mirror of `src/utils/encode-project-path.ts` — keep the two in sync. The TS
 * helper is the source of truth; this `.mjs` copy exists because the hook
 * runtime loads raw scripts and cannot import the compiled `dist/` util.
 *
 * Claude Code stores a project's transcripts under
 * `~/.claude/projects/<encoded>`. For normal-length project paths, this helper
 * mirrors Claude Code's character replacement step: every character that is not
 * an ASCII letter or digit is replaced by `-` (path separators, dots, the
 * Windows drive colon, and also underscores, spaces, and non-ASCII characters).
 * For example:
 *
 *   POSIX:    /home/me/proj        -> -home-me-proj
 *   POSIX:    /home/me/my.proj     -> -home-me-my-proj
 *   POSIX:    /home/me/00_proj     -> -home-me-00-proj
 *   Windows:  C:\Users\me\proj     -> C--Users-me-proj
 *
 * Any character left unsanitized produces a name that never matches the real
 * directory, so any lookup keyed on the encoded name silently finds nothing.
 * This helper intentionally mirrors only Claude Code's normal-length character
 * replacement/sanitization step, not its full long-path contract (which also
 * truncates very long encoded names and appends a hash).
 */
export function encodeProjectPath(projectPath) {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}
