import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, lutimesSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

export const skillText = read('skills/omc-doctor/SKILL.md');
// The guide file beside the script: the details of the rules that the skill leaves out (Step 1 in the rarer cases, the
// rest of the cache guard, the folding of a `..` and the locator). The skill names each section where a rule needs it.
export const guideText = read('scripts/omc-doctor-guide.md');
// What a rule of the skill says together with the details it leaves to the guide.
export const skillAndGuide = `${skillText}\n${guideText}`;
// The text of the section "## <name>" of the guide file, heading line included.
export const guideSection = (name: string, text: string = guideText): string => {
  const hits = text.split(/^(?=## )/m).filter((part) => part.startsWith(`## ${name}\n`));
  if (hits.length !== 1) throw new Error(`expected exactly one guide section ${name}, found ${hits.length}`);
  return hits[0].trimEnd();
};
// The two lines the skill uses for the guide: the template call of the Guide block, and the check that stops a cache repair
// block when the guide cannot be printed.
export const GUIDE_CALL = 'node "$S" guide SECTION';
export const GUIDE_GUARD = 'node "$S" guide cache-guard >/dev/null || exit 1';

// The commands of the doctor script that the skill runs, one per Bash call (scripts/omc-doctor.mjs).
export const SCRIPT = path.join(ROOT, 'scripts', 'omc-doctor.mjs');
export const scriptText = read('scripts/omc-doctor.mjs');
export const STEP1 = 'step1';
export const NPM_LATEST = 'npm-latest';
export const CLAUDE_MD_OPTOUT = 'claude-md-optout';
export const CLAUDE_MD_VERSION = 'claude-md-version';
export const CACHE_VERSIONS = 'cache-versions';
// The two cache commands: the outdated-plugin one and the stale-cache one.
export const commands = ['cache-outdated', 'cache-stale'];
// The seven commands, in the order the skill runs them.
export const allCommands = [STEP1, NPM_LATEST, CLAUDE_MD_OPTOUT, CLAUDE_MD_VERSION, CACHE_VERSIONS, ...commands];

// The code between the heading `// == <name> ==` of the script and the next heading, heading line included.
export function scriptSection(name: string, text: string = scriptText): string {
  const sections = text.split(/^(?=\/\/ == )/m);
  const hits = sections.filter((section) => section.startsWith(`// == ${name} ==\n`));
  if (hits.length !== 1) throw new Error(`expected exactly one section ${name} in the script, found ${hits.length}`);
  return hits[0].trimEnd();
}

// The code of the script as text: whole-line comments dropped.
export const codeOf = (text: string = scriptText): string => text.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');

// Code as one line: whole-line comments and indentation dropped, the lines joined by one space.
export const flatCode = (code: string): string =>
  code.split('\n').filter((line) => !/^\s*\/\//.test(line)).map((line) => line.trim()).filter(Boolean).join(' ');

// The shell blocks of the skill (the fenced bash blocks), as written.
export const bashBlocks = (text: string = skillText): string[] => [...text.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((match) => match[1]);

// The locator line every block that runs the script starts with (the line that sets S).
export const locatorLine = bashBlocks().flatMap((block) => block.split('\n')).find((line) => line.startsWith('S=; ')) ?? '';

// Runs a command of the doctor script in a synthetic environment. Preload scripts (--require) change the process the
// command runs in, e.g. to report another platform.
export function runCommand(command: string, configDir: string, options: { env?: Record<string, string>; preloads?: string[]; timeout?: number; cwd?: string } = {}) {
  return spawnSync(process.execPath, [...(options.preloads ?? []).flatMap((file) => ['--require', file]), SCRIPT, command], {
    encoding: 'utf8',
    timeout: options.timeout,
    cwd: options.cwd,
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

// The shell block of the skill that runs a command of the script, exactly as written.
export const blockOf = (command: string): string => {
  const hits = bashBlocks().filter((block) => block.split('\n').includes(`node "$S" ${command}`));
  if (hits.length !== 1) throw new Error(`expected exactly one shell block that runs ${command}, found ${hits.length}`);
  return hits[0];
};

// Runs that block through bash, whole and in one call, as the Bash tool does. The plugin root is this checkout unless
// `env` says otherwise.
export function runBlock(command: string, configDir: string, options: { env?: Record<string, string>; cwd?: string; timeout?: number } = {}) {
  // The locator needs a plugin root that holds the script, and the version check reads the package of that root like the runtime does: this
  // checkout (outside every cache) would be a --plugin-dir session. So the version check gets, as its root, a directory in the omc cache of the
  // configuration directory, the place a real session runs from, that holds only a link to the scripts of this checkout (a junction on Windows, which
  // needs no privilege; a plain link elsewhere) and no package.json, so the cached versions name the version, as for a root that carries no package.
  let root = ROOT;
  let linked = false;
  if (command === CLAUDE_MD_VERSION && options.env?.CLAUDE_PLUGIN_ROOT === undefined) {
    root = path.join(configDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', 'block-root');
    if (!existsSync(root)) {
      mkdirSync(root, { recursive: true });
      symlinkSync(path.join(ROOT, 'scripts'), path.join(root, 'scripts'), 'junction');
      linked = true;
    }
  }
  const result = spawnSync('bash', ['-c', blockOf(command)], {
    encoding: 'utf8',
    timeout: options.timeout,
    cwd: options.cwd,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDir,
      HOME: configDir,
      USERPROFILE: configDir,
      OMC_PLUGIN_ROOT: '',
      CLAUDE_PLUGIN_ROOT: root,
      ...options.env,
    },
  });
  // The link is the fixture's own: it is not left in the cache the test goes on to read or clean.
  if (linked) rmSync(root, { recursive: true, force: true });
  return result;
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
