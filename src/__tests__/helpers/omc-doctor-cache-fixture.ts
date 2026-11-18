import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, lutimesSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

// The two `node -e` cache commands of the omc-doctor skill.
export const commands = read('skills/omc-doctor/SKILL.md')
  .split('\n')
  .filter((l) => l.startsWith('node -e ') && l.includes("'installed_plugins.json'") && l.includes("'oh-my-claudecode'") && l.includes("'backups'"));

// The JavaScript of a `node -e "..."` line. It is run by Node directly, without a shell, so the
// same case runs on every platform; one POSIX test below runs the unchanged line through bash.
export const scriptOf = (command: string) => command.slice('node -e "'.length, -1);

// Preload scripts (--require) change the process the command runs in, e.g. to report another platform.
export function runCommand(command: string, configDir: string, options: { env?: Record<string, string>; preloads?: string[]; timeout?: number } = {}) {
  return spawnSync(process.execPath, [...(options.preloads ?? []).flatMap((file) => ['--require', file]), '-e', scriptOf(command)], {
    encoding: 'utf8',
    timeout: options.timeout,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDir,
      HOME: configDir,
      USERPROFILE: configDir,
      OMC_PLUGIN_ROOT: '',
      CLAUDE_PLUGIN_ROOT: '',
      ...options.env,
    },
  });
}

export const digitVersions = (cache: string) => readdirSync(cache).filter((n) => /^\d/.test(n)).sort().join(',');
export const backupDir = (dir: string) => path.join(dir, 'plugins', 'backups', 'oh-my-claudecode');
export const movedAside = (dir: string) => (existsSync(backupDir(dir)) ? readdirSync(backupDir(dir)).length : 0);

// The protection set of both commands is the union of every source that says a
// cache version is in use. A source that cannot be read completely makes the
// command move nothing instead of acting on a partial set.
export const PLUGIN_ID = 'oh-my-claudecode@omc';

// The commands leave a version directory modified in the last 10 minutes alone, so a fixture version
// is dated an hour back unless a test wants it fresh. Creating an entry inside a version changes the
// date again; call this after such a change.
export function ageVersions(cache: string, ageMs = 3_600_000) {
  const then = new Date(Date.now() - ageMs);
  for (const name of readdirSync(cache)) lutimesSync(path.join(cache, name), then, then);
}

export function makeCache(versions: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-skill-'));
  const cache = path.join(dir, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
  for (const v of versions) {
    mkdirSync(path.join(cache, v), { recursive: true });
    writeFileSync(path.join(cache, v, 'package.json'), JSON.stringify({ version: v }));
  }
  ageVersions(cache);
  return { dir, cache };
}

export function writeRegistryFile(dir: string, content: unknown) {
  writeFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

export function writeRegistry(dir: string, plugins: Record<string, unknown>) {
  writeRegistryFile(dir, { version: 2, plugins });
}

