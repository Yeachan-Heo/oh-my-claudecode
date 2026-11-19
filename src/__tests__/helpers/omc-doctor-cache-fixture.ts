import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, lutimesSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

// The commands leave a version directory alone when it, or an entry in its first two levels, was modified
// in the last 10 minutes, so a fixture version and everything inside it is dated an hour back unless a test
// wants it fresh. Creating an entry changes the dates again; call this after such a change. Links are
// dated themselves and never followed.
export function ageTree(entry: string, then: Date) {
  const stat = lstatSync(entry);
  if (stat.isDirectory()) for (const name of readdirSync(entry)) ageTree(path.join(entry, name), then);
  lutimesSync(entry, then, then);
}

export function ageVersions(cache: string, ageMs = 3_600_000) {
  const then = new Date(Date.now() - ageMs);
  for (const name of readdirSync(cache)) ageTree(path.join(cache, name), then);
}

// Adds the versions to the cache of a marketplace, the marketplace part of the plugin ID (`omc` for
// oh-my-claudecode@omc), and dates them an hour back.
export function addCache(dir: string, versions: string[], market = 'omc') {
  const cache = path.join(dir, 'plugins', 'cache', market, 'oh-my-claudecode');
  for (const v of versions) {
    mkdirSync(path.join(cache, v), { recursive: true });
    writeFileSync(path.join(cache, v, 'package.json'), JSON.stringify({ version: v }));
  }
  ageVersions(cache);
  return cache;
}

export function makeCache(versions: string[], market = 'omc') {
  const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-skill-'));
  return { dir, cache: addCache(dir, versions, market) };
}

export function writeRegistryFile(dir: string, content: unknown) {
  writeFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

export function writeRegistry(dir: string, plugins: Record<string, unknown>) {
  writeRegistryFile(dir, { version: 2, plugins });
}


// WSL2 reports `linux` while a config directory on a Windows drive ignores letter case, and a case-sensitive test
// volume has no such alias. This preload makes the process see one: a path that does not exist is looked up again,
// component by component, ignoring letter case (the same stat answers as for the real name, so device and inode match;
// a link reached through the alias is read the same way).
export const caseFoldPreload = `const fs = require('fs'), path = require('path');
const fold = (target) => {
  const abs = path.resolve(String(target));
  const root = path.parse(abs).root;
  let current = root;
  try {
    for (const part of abs.slice(root.length).split(path.sep).filter(Boolean)) {
      const exact = path.join(current, part);
      if (fs.existsSync(exact)) { current = exact; continue; }
      const hit = fs.readdirSync(current).find((name) => name.toLowerCase() === part.toLowerCase());
      if (!hit) return abs;
      current = path.join(current, hit);
    }
  } catch (error) { return abs; }
  return current;
};
for (const name of ['statSync', 'lstatSync', 'readlinkSync']) {
  const real = fs[name];
  fs[name] = function (target, ...rest) {
    try { return real.call(fs, target, ...rest); } catch (error) {
      if (error && error.code === 'ENOENT' && typeof target === 'string') {
        const folded = fold(target);
        if (folded !== path.resolve(target)) return real.call(fs, folded, ...rest);
      }
      throw error;
    }
  };
}
`;

// A file system that reports inode 0 for every path gives no identity: existing paths then compare by their exact text.
// Preload it after the case fold preload (it wraps whatever `statSync` and `lstatSync` are then).
export const zeroInodePreload = `const fs = require('fs');
for (const name of ['statSync', 'lstatSync']) {
  const real = fs[name];
  fs[name] = function (target, options) {
    const stat = real.call(fs, target, options);
    if (options && options.bigint) stat.ino = 0n;
    return stat;
  };
}
`;

export function writeZeroInodePreload(dir: string) {
  const file = path.join(dir, 'zero-inode.cjs');
  writeFileSync(file, zeroInodePreload);
  return file;
}

export function writeCaseFoldPreload(dir: string) {
  const file = path.join(dir, 'casefold.cjs');
  writeFileSync(file, caseFoldPreload);
  return file;
}

// Whether the volume under `dir` ignores letter case (NTFS, the usual APFS, a casefold ext4 directory, a Windows drive
// seen from WSL2): a file created as `CaseProbe` is found as `caseprobe`. The commands compare existing paths by device
// and inode, so a spelling in another letter case names the same directory wherever the volume folds it and another
// directory wherever it does not, whatever platform name the process reports: they never fold letter case by the name
// of the platform. The commands call `statSync` and `lstatSync`, which answer alike for the regular probe file.
export function volumeFoldsCase(dir: string = tmpdir()): boolean {
  const probe = mkdtempSync(path.join(dir, 'omc-case-probe-'));
  try {
    writeFileSync(path.join(probe, 'CaseProbe'), '');
    try {
      statSync(path.join(probe, 'caseprobe'));
      return true;
    } catch {
      return false;
    }
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

// `target` spelled in upper case below the parent of the fixture directory `dir`. Only that part is on the volume under
// test: the ancestors of the temporary directory may sit on another volume with other case rules (a casefold directory
// in a case-sensitive tree, a drive mounted under /mnt), so upper-casing the whole path would name nothing there.
export const upperBelow = (dir: string, target: string): string => {
  const base = path.dirname(dir);
  const below = path.relative(base, target);
  return below.startsWith('..') || path.isAbsolute(below) ? target.toUpperCase() : path.join(base, below.toUpperCase());
};
