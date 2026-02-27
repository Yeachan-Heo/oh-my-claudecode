/**
 * Return the user's full interactive-shell PATH, falling back to
 * process.env.PATH when resolution fails.
 *
 * Parses `env` output instead of `echo $PATH` to avoid stdout noise
 * from interactive dotfiles (conda init, greeting messages).
 *
 * Note: On fish shell, the `-ilc` combined flags are not supported
 * (fish requires `--login --interactive -c`), so resolution falls
 * back to process.env.PATH. On Windows, SHELL is unset and
 * resolution also falls back gracefully.
 */
export declare function resolveShellPath(): string;
/**
 * Return a copy of process.env with the resolved PATH merged in.
 * Handles Windows where the key may be `Path` instead of `PATH`.
 */
export declare function resolvedEnv(extra?: Record<string, string>): NodeJS.ProcessEnv;
/** @internal For testing only. Resets the cached PATH so the next call re-resolves. */
export declare function _resetShellPathCache(): void;
//# sourceMappingURL=shell-path.d.ts.map