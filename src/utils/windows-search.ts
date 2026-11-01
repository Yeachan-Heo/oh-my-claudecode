/**
 * Windows Executable Search Hardening
 *
 * On Windows a child spawned by bare name (`git`, `npm`, `gh`) is looked up in
 * the current directory before PATH unless NoDefaultCurrentDirectoryInExePath
 * is set, so a `git.exe` or `git.cmd` planted in the project folder runs
 * instead of the real one. libuv's own lookup (no shell) reads the parent's
 * environment; cmd.exe (`shell: true`, exec) reads the child's env block.
 * Every entry point therefore hardens its own environment first, and any
 * explicit `env:` built without process.env goes through childEnv().
 * ESM evaluates every import before the entry's body calls the hardening, so
 * nothing an entry point imports may spawn at module-load time.
 *
 * Multi-surface mirrors (keep in sync):
 *   scripts/lib/windows-search.mjs   — ESM hook/script runtime
 *   scripts/lib/windows-search.cjs   — CJS hook runtime
 */

const VARIABLE = 'NoDefaultCurrentDirectoryInExePath';

function isVariable(key: string): boolean {
  return key.toUpperCase() === VARIABLE.toUpperCase();
}

/** Turn off the current-directory search for this process and every child that inherits its env. No-op off win32. */
export function hardenWindowsExeSearch(): void {
  if (process.platform !== 'win32') return;
  for (const key of Object.keys(process.env)) {
    if (isVariable(key)) delete process.env[key];
  }
  process.env[VARIABLE] = '1';
}

/** A copy of `env` that keeps the current-directory search off in the child (win32 only). */
export function childEnv<T extends Record<string, string | undefined>>(env: T): T {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (process.platform !== 'win32' || !isVariable(key)) out[key] = value;
  }
  if (process.platform === 'win32') out[VARIABLE] = '1';
  return out as T;
}
