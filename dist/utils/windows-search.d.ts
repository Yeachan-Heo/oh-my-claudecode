/**
 * Windows Executable Search Hardening
 *
 * On Windows a child spawned by bare name (`git`, `npm`, `gh`) is looked up in
 * the current directory before PATH unless NoDefaultCurrentDirectoryInExePath
 * is set, so a `git.exe` or `git.cmd` planted in the project folder runs
 * instead of the real one. libuv's own lookup (no shell) reads the parent's
 * environment (libuv 1.48+, i.e. Node 21.7+/22+; Node 20's libuv ignores it);
 * cmd.exe (`shell: true`, exec) reads the child's env block.
 * Every entry point therefore hardens its own environment first, and any
 * explicit `env:` built without process.env goes through childEnv().
 * ESM evaluates every import before the entry's body calls the hardening, so
 * nothing an entry point imports may spawn at module-load time.
 *
 * Multi-surface mirrors (keep in sync):
 *   scripts/lib/windows-search.mjs   — ESM hook/script runtime
 *   scripts/lib/windows-search.cjs   — CJS hook runtime
 */
/** Turn off the current-directory search for this process and every child that inherits its env. No-op off win32. */
export declare function hardenWindowsExeSearch(): void;
/** A copy of `env` that keeps the current-directory search off in the child (win32 only). */
export declare function childEnv<T extends Record<string, string | undefined>>(env: T): T;
//# sourceMappingURL=windows-search.d.ts.map