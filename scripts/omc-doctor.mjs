#!/usr/bin/env node
// The commands behind the checks of the omc-doctor skill (skills/omc-doctor/SKILL.md). The skill runs one command per
// Bash call: node omc-doctor.mjs <command>. Every command prints the lines the skill's diagnosis reads and ends with
// exit code 0, except the two cache commands, which end with 1 when they refuse to move anything or a move fails,
// and an unknown command, which ends with 2. The guide command ends with 1 when its file is missing and with 2 for an
// unknown section. A command that needs the working directory to resolve a relative path, after that directory was
// deleted, says so and ends with 1.
//
//   step1              the install channel (marketplace, plugin-dir, npm or unknown), the installed version, the
//                      channel's latest version and the command that updates it, one block of lines per plugin
//   npm-latest         the latest version of the npm package (only for a Channel: npm install)
//   claude-md-optout   whether CLAUDE.md management is switched off by claudeMdEnabled: false
//   claude-md-version  the OMC version marker of CLAUDE.md (or its companion file) against the newest cached version
//                      of the marketplace the session runs
//   cache-versions     the version directories of the plugin cache, per marketplace
//   cache-outdated     moves the unprotected cached versions to plugins/backups after an update (never deletes)
//   cache-stale        the same cleanup for a stale cache with several versions
//   guide <section>    prints one section of omc-doctor-guide.md, the details the skill leaves out
//
// Everything is plain Node (no shell), so it runs the same on Windows and POSIX. The sections below hold the code
// the commands share: each of them exists once, here.

import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// == config dir ==
// CLAUDE_CONFIG_DIR expanded like getClaudeConfigDir() in scripts/lib/config-dir.mjs: surrounding spaces are
// ignored, an empty value means the .claude directory of the home directory, a value that is ~ or starts with ~/ or
// ~ and a backslash means the home directory, and any other value is used as given, normalized as text like the
// runtime does (a .. after a link folds the link away, a ~ anywhere else is literal).
const home = os.homedir();
const configured = (process.env.CLAUDE_CONFIG_DIR || '').trim();
const configDir = !configured
  ? path.join(home, '.claude')
  : configured === '~'
    ? home
    : /^~[/\\]/.test(configured)
      ? path.join(home, configured.slice(2))
      : path.normalize(configured);

// == plugin ids ==
// The plugin IDs the installer accepts (OMC_PLUGIN_IDS in src/installer/index.ts), compared in lower case.
const OMC_IDS = ['oh-my-claudecode@omc', 'oh-my-claudecode', 'oh-my-claudecode@oh-my-claudecode'];
// The marketplace of a plugin ID: the part after the @ in lower case, omc for the bare ID.
const marketplaceOf = (id) => {
  const lower = id.toLowerCase();
  return lower.includes('@') ? lower.slice(lower.indexOf('@') + 1) : 'omc';
};
// A plugin root variable as it was set: a value of nothing but white space names no root, any other is kept exactly (a directory name may end in a space).
const rootOf = (value) => (value && value.trim() ? value : '');
// The plugin cache directory of a marketplace.
const cacheDirOf = (market) => path.join(configDir, 'plugins', 'cache', market, 'oh-my-claudecode');

// == version grammar ==
// A leading v is dropped here and nowhere else.
const dropV = (text) => text.replace(/^v(?=[0-9])/, '');
// The grammar of parseSemver in scripts/session-start.mjs: an optional v, three numeric parts without leading
// zeros, an optional prerelease and optional build metadata. Returns the bare version, or '' for anything else.
const semver = (text) => {
  const trimmed = text.trim();
  const grammar = /^v?(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:[.][0-9A-Za-z-]+)*)?(?:[+][0-9A-Za-z-]+(?:[.][0-9A-Za-z-]+)*)?(?![^])/;
  return grammar.test(trimmed) ? dropV(trimmed) : '';
};
// A cache directory is a version directory when its name is exactly a semantic version of that grammar (no v, no
// spaces) and is not a leftover of an interrupted cache relink, which is named <version>.omc-stale-<pid>. A name that
// is no version (1e3, 4.15.7L, v5.7.0) takes no part in the order and is never moved as a version.
const isVersionDir = (name) => semver(name) == name && !/[.]omc-stale-[0-9]+(?![^])/.test(name);
// The version directories of a cache directory: the entries whose name is a version, except those that certainly are no directory
// (a regular file or a FIFO named like a version, as a link to one is also, is no installed version). An entry that cannot be
// resolved (a link to nothing, a loop, no permission) stays listed: it may be an installation that is broken, so the cache commands
// keep it when something protects it and refuse when it cannot be judged, as for any other version.
const versionDirs = (dir) =>
  fs.readdirSync(dir).filter(isVersionDir).filter((name) => {
    try {
      return fs.statSync(dir + path.sep + name).isDirectory();
    } catch {
      return true;
    }
  });

// == version order ==
// Semantic version precedence as a comparison function. Numeric parts compare as digit strings (leading zeros
// dropped, the longer one is larger, equal lengths compare as text), never as numbers: a number past 2^53 is not
// exact. A prerelease is older than its release and build metadata does not count. Two names that are equal in
// this order are told apart by their text, so the result does not depend on the order of a directory listing.
const compareVersions = (a, b) => {
  const split = (name) => {
    const bare = dropV(name).split('+')[0];
    const dash = bare.indexOf('-');
    return [(dash < 0 ? bare : bare.slice(0, dash)).split('.'), dash < 0 ? null : bare.slice(dash + 1).split('.')];
  };
  const isDigits = (part) => part != '' && !part.replace(/[0-9]/g, '');
  const comparePart = (x, y) => {
    if (isDigits(x) && isDigits(y)) {
      x = x.replace(/^0+(?=[0-9])/, '');
      y = y.replace(/^0+(?=[0-9])/, '');
      return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
    }
    return isDigits(x) ? -1 : isDigits(y) ? 1 : x < y ? -1 : x > y ? 1 : 0;
  };
  const [coreA, preA] = split(a);
  const [coreB, preB] = split(b);
  for (let i = 0; i < Math.max(coreA.length, coreB.length); i++) {
    const result = comparePart(coreA[i] ?? '0', coreB[i] ?? '0');
    if (result) return result;
  }
  if (!preA || !preB) return preA ? -1 : preB ? 1 : a < b ? -1 : a > b ? 1 : 0;
  for (let i = 0; i < Math.max(preA.length, preB.length); i++) {
    if (preA[i] === undefined) return -1;
    if (preB[i] === undefined) return 1;
    const result = comparePart(preA[i], preB[i]);
    if (result) return result;
  }
  return a < b ? -1 : a > b ? 1 : 0;
};

// == runtime order of cached versions ==
// getLatestPluginCacheVersion in scripts/session-start.mjs picks the version SessionStart compares with the CLAUDE.md marker: the names of
// the omc cache that are digits.digits.digits with an optional -prerelease, whose package.json names exactly that name, sorted with its
// semverCompare (which says 0 for a name its parser rejects, so the result depends on the order of the listing) and the last one taken.
// The doctor repeats that rule exactly where it names that version (Step 4): parseSemver and semverCompare below are copies, and
// src/__tests__/omc-doctor-runtime-parity.test.ts runs both on the same cache and requires the same answer.
function runtimeParseSemver(version) {
  if (typeof version !== 'string') return null;
  const match = version.trim().match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) return null;
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split('.') ?? [],
  };
}

function runtimeSemverCompare(a, b) {
  const pa = runtimeParseSemver(a);
  const pb = runtimeParseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i];
  }
  if (pa.prerelease.length === 0 || pb.prerelease.length === 0) {
    return pb.prerelease.length - pa.prerelease.length;
  }
  for (let i = 0; i < Math.max(pa.prerelease.length, pb.prerelease.length); i++) {
    const aPart = pa.prerelease[i];
    const bPart = pb.prerelease[i];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    if (aPart === bPart) continue;
    const aNumeric = /^\d+$/.test(aPart);
    const bNumeric = /^\d+$/.test(bPart);
    if (aNumeric && bNumeric) return Number(aPart) - Number(bPart);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aPart.localeCompare(bPart);
  }
  return 0;
}

// == read file ==
// Reads a regular file only: a FIFO or another special file is never opened, so a read cannot hang.
const readFile = (file) => {
  if (!fs.statSync(file).isFile()) throw 0;
  return fs.readFileSync(file, 'utf8');
};

// == read JSON ==
// Every JSON file the commands read goes through here: a regular file, as the runtime reads it (utf-8 text, then JSON.parse,
// as in isClaudeMdEnabledInConfig and readJsonFile). A byte order mark is not stripped, because the runtime does not strip
// it either: its parse fails on a file that starts with one, and it takes such a file for a missing config, so a file with one
// cannot be told to hold the setting it carries. UTF-8 with a mark (Windows PowerShell 5.1 and many editors) arrives as U+FEFF,
// UTF-16 with a mark (the default of > and Out-File there, FF FE or FE FF) as two U+FFFD. The error is a SyntaxError that says
// so (bom), so a caller that prints the reason can tell it from text that is no JSON, and one that does not still sees a
// SyntaxError.
const readJson = (file) => {
  const text = readFile(file);
  if (text.startsWith('\uFEFF') || text.startsWith('\uFFFD\uFFFD')) throw Object.assign(new SyntaxError('byte order mark'), { bom: true });
  return JSON.parse(text);
};

// == registry entry shape ==
// An entry of installed_plugins.json is malformed unless it has a non-blank string version or installPath
// (a null field counts as missing, a non-string or blank one is malformed).
const entryShapeBad = (entry) => {
  const fields = [entry?.version, entry?.installPath];
  return (
    fields.every((field) => field == undefined) ||
    fields.some((field) => field != undefined && (typeof field != 'string' || !field.trim()))
  );
};

// == path resolver ==
// resolveFrom(...parts): the parts joined as the file system would resolve them, relative ones against the
// working directory. On win32 Windows folds .. as text, so path.resolve is used.
const resolveFrom = (...parts) => {
  if (process.platform == 'win32') return path.resolve(...parts);
  const lastAbsolute = parts.map((part) => path.isAbsolute(part)).lastIndexOf(true);
  return (lastAbsolute < 0 ? [process.cwd(), ...parts] : parts.slice(lastAbsolute)).join(path.sep);
};
// linkChain(start) reads a path one component at a time, as the file system does, and returns every path it goes
// through: each link on the way, each directory a .. leaves, and the end of the chain. A .. after a link names the parent of the link target,
// a .. inside a link target is read the same way. unreadable is true when a component cannot be examined or when
// more than 40 links are followed (a loop). A component that does not exist ends the chain without being unreadable.
const linkChain = (start) => {
  const paths = [];
  let unreadable = false;
  let current = resolveFrom(start);
  for (let hop = 0; hop < 41; hop++) {
    const root = path.parse(current).root;
    const parts = current.slice(root.length).split(path.sep).filter((part) => part && part != '.');
    let at = root;
    // Whether the component read last is a directory (the root and a parent of one are).
    let atIsDirectory = true;
    let next = null;
    for (let i = 0; i < parts.length && !next; i++) {
      if (parts[i] == '..') {
        // The directory left here has to exist for the path to resolve, so it is on the way like a link is. A component that is no
        // directory (a regular file) cannot be left: the file system answers ENOTDIR for <file>/../x, so the spelling names nothing and
        // what follows is kept as written, like what follows a missing component.
        if (at != root) paths.push(at);
        if (!atIsDirectory) {
          paths.push([at, ...parts.slice(i)].join(path.sep));
          return { paths, unreadable };
        }
        at = path.dirname(at);
        atIsDirectory = true;
        continue;
      }
      at = path.join(at, parts[i]);
      atIsDirectory = false;
      let info;
      try {
        info = fs.lstatSync(at);
      } catch (error) {
        if (!(error && ['ENOENT', 'ENOTDIR'].includes(error.code))) unreadable = true;
        // What lies after the missing component is kept as written: a .. there is not folded away, because the file system
        // answers ENOENT for <missing>/../x and so the spelling names nothing.
        const after = parts.slice(i + 1);
        paths.push(after.includes('..') ? [at, ...after].join(path.sep) : path.resolve(at, ...after));
        return { paths, unreadable };
      }
      atIsDirectory = info.isDirectory();
      if (info.isSymbolicLink()) {
        const rest = parts.slice(i + 1);
        const dots = rest.indexOf('..');
        paths.push(path.join(at, ...(dots < 0 ? rest : rest.slice(0, dots))));
        try {
          next = resolveFrom(path.dirname(at), fs.readlinkSync(at), ...rest);
        } catch (error) {
          unreadable = true;
          return { paths, unreadable };
        }
      }
    }
    if (!next) {
      paths.push(at);
      return { paths, unreadable };
    }
    current = next;
  }
  return { paths, unreadable: true };
};

// == absence ==
// An ENOENT does not say that nothing is at a path: a link on the way that points at nothing (a dangling link) gives
// it too, and then something is there that cannot be read. nothingAt(target) reads the path one component at a time, as
// the file system does, and is true only when the first missing component lies in a directory that exists (a link to
// one counts); a link that cannot be followed, or any other error on the way, makes it false. absent(error, target) is
// whether a failed read of target says "nothing is there", the one reading that may be taken for "none": every other
// failure is "cannot be read", which the cache commands answer with a refusal and Step 1 with unknown.
const nothingAt = (target) => {
  const whole = resolveFrom(target);
  const root = path.parse(whole).root;
  let at = root;
  for (const part of whole.slice(root.length).split(path.sep)) {
    if (!part || part == '.') continue;
    at += (at.endsWith(path.sep) ? '' : path.sep) + part;
    let info;
    try {
      info = fs.lstatSync(at);
    } catch (error) {
      return !!error && error.code == 'ENOENT';
    }
    if (info.isSymbolicLink()) {
      try {
        fs.statSync(at);
      } catch {
        return false;
      }
    }
  }
  return false;
};
const absent = (error, target) => !!error && error.code == 'ENOENT' && nothingAt(target);

// == marketplaces of the registry ==
// The marketplaces of the supported plugin IDs in installed_plugins.json, each once, in the order of their last
// occurrence. It is omc when the registry holds none and when it cannot be read (missing, a FIFO, bad JSON).
const registryMarketplaces = () => {
  try {
    const json = readJson(path.join(configDir, 'plugins', 'installed_plugins.json'));
    const plugins = json ? json.plugins ?? json : 0;
    const names = Object.keys(plugins && typeof plugins == 'object' && !Array.isArray(plugins) ? plugins : {})
      .filter((key) => OMC_IDS.includes(key.toLowerCase()))
      .map(marketplaceOf);
    return names.length ? names.filter((name, i) => names.lastIndexOf(name) == i) : ['omc'];
  } catch {
    return ['omc'];
  }
};

// == Step 1: helpers ==
// The highest version directory name in a cache directory, '' when it holds none (or does not exist), null when it
// cannot be read.
// complete: only a directory whose package.json names exactly that version counts, as the runtime counts a cached version
// (getLatestPluginCacheVersion): a half-written directory is no version there.
// complete is the runtime rule, getLatestPluginCacheVersion, applied exactly (see runtime order of cached versions): the names it counts,
// the package.json that must name that name, its ordering and its choice of the last one.
const RUNTIME_CACHE_NAME = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const highestCached = (dir, complete = false) => {
  try {
    if (complete) {
      const versions = fs
        .readdirSync(dir)
        .filter((name) => RUNTIME_CACHE_NAME.test(name))
        .filter((name) => {
          try {
            return readJson([dir, name, 'package.json'].join(path.sep)).version === name;
          } catch {
            return false;
          }
        })
        .sort(runtimeSemverCompare)
        .reverse();
      return versions[0] || '';
    }
    const names = versionDirs(dir).sort(compareVersions);
    return names.length ? names[names.length - 1] : '';
  } catch (error) {
    return absent(error, dir) ? '' : null;
  }
};
const MANIFEST_FILES = ['package.json', '.claude-plugin/plugin.json'];
// The version in package.json or .claude-plugin/plugin.json under a directory: the first file that has a non-blank
// string version decides. Returns its bare semver, null when it is not one, or '' when no file names a version.
const manifestVersion = (dir) => {
  for (const name of MANIFEST_FILES) {
    try {
      const version = readJson([dir, name].join(path.sep)).version;
      if (typeof version == 'string' && version.trim()) return semver(version) || null;
    } catch {}
  }
  return '';
};
// The version getPluginVersion (scripts/session-start.mjs) takes from the package of the loaded root: pkg?.version when it is truthy,
// whatever its type (a damaged package.json may hold a number or an object); '' for no package, an unreadable one or a falsy version.
const loadedPackageVersion = (root) => {
  try {
    // The runtime joins the root and the file name as text (join folds a .. after a link away), so the path is folded the same way here.
    return readJson(path.join(root, 'package.json')).version || '';
  } catch {
    return '';
  }
};
// How a version of any type is printed: a string as written, anything else as JSON.
const shownVersion = (version) => (typeof version == 'string' ? version : JSON.stringify(version));
// Whether a directory holds a manifest file (a regular file, as in readFile): one that names no usable version is
// told apart from no manifest at all.
// A manifest that is a link to nothing, or that cannot be read, is there and holds no usable version.
const hasManifest = (dir) =>
  MANIFEST_FILES.some((name) => {
    const file = [dir, name].join(path.sep);
    try {
      return fs.statSync(file).isFile();
    } catch (error) {
      return !!error && error.code != 'ENOTDIR' && !absent(error, file);
    }
  });
// The version a registry entry names through its installPath: the last component when it is a version directory
// name, else the manifest under it. '' without an installPath, null when the version found is not a semver.
const installPathVersion = (entry) => {
  const installPath = typeof entry.installPath == 'string' ? entry.installPath.trim() : '';
  if (!installPath) return '';
  const last = installPath.split(/[\\/]+/).filter(Boolean).pop() || '';
  return (isVersionDir(last) && semver(last)) || manifestVersion(installPath);
};
// The versions an entry names: its own version and the version its installPath names (installPathVersion), the ones that
// are semantic versions. The two of one entry have to agree; where they do not and no manifest settles it, Step 1 does
// not choose one of them.
const claimsOf = (entry) => [typeof entry.version == 'string' && entry.version.trim() ? dropV(entry.version.trim()) : '', installPathVersion(entry)].filter(Boolean);
// Build metadata (after a +) does not make a version another one, so it is left out of the comparison.
const sameVersion = (a, b) => compareVersions(a.replace(/[+].*$/, ''), b.replace(/[+].*$/, '')) == 0;
// A malformed entry. strict is for an entry of a supported plugin ID: its version has to be a semver, and an entry
// that has only an installPath must not name a version that is not one.
const entryBad = (entry, strict) =>
  entryShapeBad(entry) ||
  (!!strict && (entry.version != undefined ? !semver(entry.version) : installPathVersion(entry) === null));
// The device and inode of a path, or '' when it has none (it does not exist, or the file system reports inode 0).
const identity = (target) => {
  try {
    const stat = fs.statSync(target, { bigint: true });
    return stat.ino ? stat.dev + ':' + stat.ino : '';
  } catch {
    return '';
  }
};
// Whether anything is at a path, a link included (a path that cannot be examined counts as taken).
const taken = (target) => {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    return error.code != 'ENOENT';
  }
};
const isDirectory = (target) => {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
};
// The end of the link chain of a path, or its plain resolution when the chain cannot be read.
const realPath = (target) => {
  const chain = linkChain(target);
  return chain.unreadable ? path.resolve(target) : chain.paths[chain.paths.length - 1];
};
// Whether a path exists and the file system gives it no identity (inode 0, or a stat that failed for another reason
// than the path not existing).
const blind = (target) => {
  try {
    return !fs.statSync(target, { bigint: true }).ino;
  } catch (error) {
    return !(error && ['ENOENT', 'ENOTDIR'].includes(error.code));
  }
};
// A real path as a file system that ignores letter case or Unicode normalization reads it.
const folded = (target) => target.normalize('NFC').toLowerCase();
// The comparisons of paths answer 'yes', 'no' or 'unknown', and every decision that rests on one treats 'unknown' as
// neither: it ends in a Channel: unknown line (see STEP1_BLIND). askSame(a, b) is whether two paths name one directory:
// the same real path, or the same identity (a link, another spelling). askInside(target, dir) is whether target is dir
// or lies inside it: by identity when dir has one (an ancestor of target has it too), otherwise by the real paths.
// Without an identity a second spelling of a directory is told only by its text, and the one thing a file system
// itself adds to a name is folding (letter case, Unicode normalization), so the answer is 'unknown' exactly when a
// path that exists has no identity and the real paths agree after folding but not as written. Paths that differ after
// folding are two directories (a bind mount or a Windows 8.3 name on a volume without inodes is not seen, as before).
// The cache commands are stricter on purpose, see protectionOf: moving a version someone runs costs more than a
// wrong label, so they refuse whenever a path that may protect one has no identity and its spelling does not place it.
// A path whose link chain cannot be read (a loop, a component that cannot be examined) names nothing the file system can resolve,
// so no comparison of its folded text may say anything: the answer is unknown.
const unresolvable = (...targets) => targets.some((target) => linkChain(target).unreadable);
const askSame = (a, b) => {
  if (unresolvable(a, b)) return 'unknown';
  const x = realPath(a);
  const y = realPath(b);
  if (x == y || (identity(a) && identity(a) == identity(b))) return 'yes';
  return (blind(a) || blind(b)) && folded(x) == folded(y) ? 'unknown' : 'no';
};
const askInside = (target, dir) => {
  if (unresolvable(target, dir)) return 'unknown';
  const a = realPath(target);
  const b = realPath(dir);
  if (a == b || a.startsWith(b + path.sep)) return 'yes';
  const id = identity(dir);
  for (let up = a, parent; id; up = parent) {
    if (identity(up) == id) return 'yes';
    parent = path.dirname(up);
    if (parent == up) break;
  }
  return blind(dir) && (folded(a) == folded(b) || folded(a).startsWith(folded(b) + path.sep)) ? 'unknown' : 'no';
};
// The answer of several comparisons to one question: 'yes' when one says so, 'unknown' when none does and one cannot
// tell, otherwise 'no'.
const anyOf = (answers) => (answers.includes('yes') ? 'yes' : answers.includes('unknown') ? 'unknown' : 'no');
// The cache directory a registry version names, as written and without a leading v.
const versionDirPaths = (market, version) =>
  [...new Set([version, dropV(version)])].map((name) => cacheDirOf(market) + path.sep + name);
// The paths a registry entry names as its install: its installPath, or, for an entry that has none, the cache directory
// its version names (an installPath says where the install is, so the version must not name a second place).
const entryInstallPaths = (market, entry) =>
  [
    ...(typeof entry?.installPath == 'string' && entry.installPath.trim()
      ? [entry.installPath]
      : typeof entry?.version == 'string' && entry.version.trim()
        ? versionDirPaths(market, entry.version.trim())
        : []),
  ]
    .filter((target) => typeof target == 'string' && target.trim())
    .map((target) => target.trim());
// The plugin root variables that name an existing directory, OMC_PLUGIN_ROOT (--plugin-dir) first. CLAUDE_PLUGIN_ROOT is
// only a locator in Step 1: Claude Code sets it for marketplace installs too, so it names a checkout only when the
// registry holds no supported plugin ID. The installer's resolver also counts a lone CLAUDE_PLUGIN_ROOT as an explicit
// root; the difference is deliberate, a marketplace install must not be reported as a checkout.
const pluginRoots = () =>
  [process.env.OMC_PLUGIN_ROOT, process.env.CLAUDE_PLUGIN_ROOT]
    .map(rootOf)
    .filter(Boolean)
    .filter(isDirectory);
// The entries of a plugin ID that the session runs: those whose install (entryInstallPaths) holds one of the existing
// plugin roots. unknown is true when no entry certainly holds one and a comparison could not be made (askInside): which
// install the session runs is then not known, and nothing is judged from the entries.
const activeEntries = (id, entries, roots) => {
  const answers = entries.map((entry) =>
    anyOf(entryInstallPaths(marketplaceOf(id), entry).flatMap((target) => roots.map((root) => askInside(root, target)))),
  );
  return { active: entries.filter((entry, i) => answers[i] == 'yes'), unknown: anyOf(answers) == 'unknown' };
};

// == Step 1: the registry ==
// supported: [id, entries] of the supported plugin IDs, the id in lower case. unreadable: the file is not usable.
// malformed: a supported ID has an unusable entry list. ambiguous: another key could be an OMC install (a look-alike
// key, an empty or non-array list, a malformed entry), so npm cannot be assumed.
// Two spellings of one plugin ID are one plugin, as the runtime reads them (auto-update.ts and the installer compare
// the IDs in lower case): their entries are merged into one block, so the highest version of all of them is
// Installed, and the block names the ID in lower case, which is the ID its Updater line passes to the CLI.
// Limits kept on purpose, because the installer reads the registry the same way (resolveInstalledOmcPluginRoots in
// src/installer): an installPath is used as written (a relative one is not resolved against the configuration
// directory), and scope and projectPath are not read (every entry of a supported ID counts, so the highest version
// is Installed, whichever project it was installed for). The Updater line carries no CLAUDE_CONFIG_DIR: run it in
// the environment that holds the profile.
const readChannelRegistry = () => {
  let unreadable = false;
  let malformed = false;
  let ambiguous = false;
  const merged = new Map();
  const file = path.join(configDir, 'plugins', 'installed_plugins.json');
  try {
    const json = readJson(file);
    const plugins = json ? json.plugins ?? json : 0;
    if (!plugins || typeof plugins != 'object' || Array.isArray(plugins)) throw 0;
    for (const [key, entries] of Object.entries(plugins)) {
      const lower = key.toLowerCase();
      if (OMC_IDS.includes(lower)) {
        merged.set(lower, (merged.get(lower) ?? []).concat(Array.isArray(entries) ? entries : []));
        if (!Array.isArray(entries) || !entries.length || entries.some((entry) => entryBad(entry, true))) malformed = true;
        continue;
      }
      if (!Array.isArray(entries) || !entries.length || lower.includes('oh-my-claudecode')) ambiguous = true;
      else if (entries.some((entry) => entryBad(entry, false))) ambiguous = true;
    }
  } catch (error) {
    unreadable = !absent(error, file);
  }
  return { unreadable, malformed, ambiguous, supported: [...merged] };
};

// == Step 1: the install channel ==
// The answer when a comparison of paths cannot be made (see askSame): no channel, no updater.
const STEP1_BLIND =
  'Channel: unknown (the file system gives no identity to a plugin root or an install path whose spelling differs from another only in letter case or Unicode form, so the two cannot be told apart; do not guess an updater)';
const step1 = () => {
  const { unreadable, malformed, ambiguous, supported } = readChannelRegistry();
  const roots = pluginRoots();
  const explicitRoot = rootOf(process.env.OMC_PLUGIN_ROOT);
  // A loaded checkout: an existing OMC_PLUGIN_ROOT answers before the registry, whatever the registry holds, unless
  // it is the install a supported entry pins (its installPath, or the cache directory its version names), or the
  // registry cannot be read completely and the root lies inside the plugin cache. Whether it is one of those can be
  // unknown (askSame), and that is no checkout either.
  const registryUnusable = unreadable || (supported.length > 0 && malformed);
  const rootIsInstall =
    explicitRoot && isDirectory(explicitRoot)
      ? anyOf([
          ...(registryUnusable ? [askInside(explicitRoot, path.join(configDir, 'plugins', 'cache'))] : []),
          ...supported.flatMap(([key, entries]) =>
            (Array.isArray(entries) ? entries : []).flatMap((entry) =>
              entryInstallPaths(marketplaceOf(key), entry).map((target) => askSame(target, explicitRoot)),
            ),
          ),
        ])
      : 'no';
  const isPlugindir = !!explicitRoot && isDirectory(explicitRoot) && rootIsInstall == 'no';
  const out = [];
  const sameRoots = roots.length > 1 ? askSame(roots[0], roots[1]) : 'yes';
  if (sameRoots == 'no') {
    out.push('Channel: unknown (OMC_PLUGIN_ROOT and CLAUDE_PLUGIN_ROOT name different directories; do not guess an updater)');
  } else if (sameRoots == 'unknown' || rootIsInstall == 'unknown') {
    out.push(STEP1_BLIND);
  } else if (!isPlugindir && registryUnusable) {
    out.push('Channel: unknown (installed_plugins.json could not be read completely; do not guess an updater)');
  } else if (isPlugindir || (!supported.length && roots.length)) {
    out.push(
      'Plugin root: ' + roots[0],
      'Channel: plugin-dir',
      'Installed: ' + (manifestVersion(roots[0]) || '(none)'),
      'Latest: (unavailable) (a --plugin-dir checkout has no update channel)',
      'Updater: none (update and rebuild that checkout, then run omc setup --plugin-dir-mode)',
    );
  } else if (!supported.length && ambiguous) {
    out.push('Channel: unknown (installed_plugins.json could not be read completely; do not guess an updater)');
  } else if (!supported.length) {
    // (none) is for nothing installed: a cache that cannot be read says nothing about that, so its version is unknown.
    const cached = highestCached(cacheDirOf('omc'));
    out.push(
      'Channel: npm',
      'Installed: ' + (cached === null ? '(unknown)' : cached || '(none)'),
      ...(cached === null ? ['Note: the plugin cache ' + cacheDirOf('omc') + ' cannot be read, so it is unknown whether a version is installed'] : []),
      'Updater: omc update',
    );
  } else if (supported.some(([id, entries]) => activeEntries(id, entries, roots).unknown)) {
    out.push(STEP1_BLIND);
  } else {
    for (const [id, entries] of supported) {
      const market = marketplaceOf(id);
      // The entries the session runs: those whose install holds an existing plugin root. Without a match all count.
      const { active } = activeEntries(id, entries, roots);
      const claims = (active.length ? active : entries).map(claimsOf);
      const recorded = claims.map((names) => names[0]).filter(Boolean).sort(compareVersions);
      // The code the session loads is the one in that root, so its manifest decides the installed version when it
      // holds a semantic version; the registry only says which version was recorded, and a partial update or a damaged
      // registry can make the two differ. A root deeper below the install has no manifest of its own: the registry
      // stays the answer there, as it does for a manifest that holds no usable version (said in a Note line).
      const root = active.length ? roots[0] : '';
      const loaded = root ? manifestVersion(root) : '';
      const differing = [...new Set(loaded ? recorded.filter((version) => !sameVersion(version, loaded)) : [])];
      // Without such a manifest an entry whose own version and the version its installPath names differ gives no answer:
      // neither is the code, so the installed version is unknown instead of one of the two (a partial update, a damaged registry).
      const torn = loaded ? [] : [...new Set(claims.filter((names) => names.some((name) => !sameVersion(name, names[0]))).flat())].sort(compareVersions);
      const versions = loaded ? [loaded] : recorded;
      // The latest version is the one the marketplace clone advertises, when it is a semver.
      let latest = null;
      try {
        const manifest = readJson(path.join(configDir, 'plugins', 'marketplaces', market, '.claude-plugin', 'marketplace.json'));
        const found = Array.isArray(manifest.plugins) ? manifest.plugins.find((x) => x && x.name == 'oh-my-claudecode') : null;
        latest = found && typeof found.version == 'string' ? semver(found.version) || null : null;
      } catch {}
      // A registry entry is an install, so a version nothing names is unknown, never (none): the install is there, loaded
      // or not, and only its version cannot be established (an entry with only an installPath that names none, a manifest
      // without a usable version, a cache that cannot be read).
      const cached = versions.length || active.length ? '' : highestCached(cacheDirOf(market));
      const installed = versions.length ? versions[versions.length - 1] : cached || '';
      const noVersion = !torn.length && !installed;
      out.push(
        'Plugin: ' + id,
        'Channel: marketplace ' + market,
        'Installed: ' + (torn.length || !installed ? '(unknown)' : installed),
        ...(differing.length
          ? [
              'Registry mismatch: the registry records ' + differing.join(', ') + ' for the install the session runs (' + root + '), but the manifest there holds ' + loaded + ', so Installed is ' + loaded + ' (a partial update or a damaged registry: update or reinstall the plugin with the Updater line, then restart Claude Code)',
            ]
          : []),
        ...(torn.length
          ? [
              'Registry mismatch: the registry names ' + torn.join(', ') + ' for one install (the version of an entry and the version its installPath names differ) and no manifest settles which is installed, so Installed is unknown (a partial update or a damaged registry: update or reinstall the plugin with the Updater line, then restart Claude Code)',
            ]
          : []),
        ...(root && !loaded && !torn.length && versions.length && hasManifest(root)
          ? ['Note: the manifest in ' + root + ' holds no usable version, so Installed is the version the registry records']
          : []),
        ...(noVersion
          ? [
              'Note: the registry records no version for this install' +
                (root ? ', and the running root ' + root + (hasManifest(root) ? ' has a manifest that holds no usable version' : ' has no manifest') : '') +
                (cached === null ? ', and the plugin cache cannot be read' : '') +
                ', so Installed is unknown (the plugin is registered, it is not missing: update or reinstall it with the Updater line to record a version)',
            ]
          : []),
        'Latest: ' + (latest || '(unavailable)') + ' (marketplace clone)',
        'Updater: claude plugin marketplace update ' + market + ' && claude plugin update ' + id,
      );
    }
  }
  for (const line of out) console.log(line);
};

// == Step 1: npm latest ==
// npm view gets 20 seconds: it normally answers in a few, and a hanging network must not stall the diagnosis. Only a
// semantic version of the grammar above is an answer; an error, a timeout or anything else on stdout is
// (unavailable), never a bare string.
// On POSIX npm runs in a process group of its own, and a timeout kills the whole group, so a process npm started
// (a registry helper, a proxy) does not outlive the command. On Windows the timeout ends the shell that starts
// npm.cmd and not the processes below it: there the limit protects the diagnosis, it does not clean up the tree.
const npmLatest = () => {
  const view = ['view', 'oh-my-claude-sisyphus', 'version'];
  const windows = process.platform == 'win32';
  const options = { encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL', detached: !windows };
  // npm is a .cmd file on Windows, which only a shell can start.
  const run = windows
    ? childProcess.spawnSync('npm ' + view.join(' '), { ...options, shell: true })
    : childProcess.spawnSync('npm', view, options);
  if (!windows && run.error && run.pid) {
    try {
      process.kill(-run.pid, 'SIGKILL');
    } catch {}
  }
  const latest = run.status === 0 ? semver(run.stdout) : '';
  console.log('npm latest: ' + (latest || '(unavailable)'));
};

// == Step 4 ==
// Whether CLAUDE.md management is disabled: only an explicit claudeMdEnabled: false in .omc-config.json disables it.
// A file that is there but cannot be read (a link to nothing, EACCES), is not a regular file (a directory, a FIFO) or is
// not JSON (an empty file, and one that starts with a byte order mark, included) may hold the opt-out, so that is neither line.
const claudeMdOptOut = () => {
  const file = path.join(configDir, '.omc-config.json');
  let off = false;
  let cannotRead = '';
  try {
    off = readJson(file)?.claudeMdEnabled === false;
  } catch (error) {
    // readFile throws 0 for a file that is not a regular one.
    if (error === 0) cannotRead = 'not a regular file';
    else if (error instanceof SyntaxError) cannotRead = error.bom ? 'has a byte order mark' : 'not valid JSON';
    else if (error && error.code && !absent(error, file)) cannotRead = error.code;
  }
  console.log(
    cannotRead
      ? 'CLAUDE.md management unknown: could not read .omc-config.json (' + cannotRead + ')'
      : off
        ? 'CLAUDE.md management disabled by claudeMdEnabled: false'
        : 'CLAUDE.md management enabled',
  );
};

// The OMC version marker of CLAUDE.md (or its companion file) against the newest plugin cache version of the marketplace
// the session runs: the one whose registry entry holds the plugin root (activeEntries, as in Step 1; the runtime takes the
// version from that root too, getPluginVersion in scripts/session-start.mjs). Where no entry holds one (no root, a checkout
// outside the registry) the last supported ID of the registry whose cache holds a version names it; the registry has no other order.
const claudeMdVersion = () => {
  const markets = registryMarketplaces();
  // Only regular files are read (readFile), so a file that is not one is never opened. CLAUDE.md and the file it names are
  // there and cannot be used when they are a directory or a FIFO (unreadable, below). The files that are scanned, CLAUDE-omc.md
  // and every other CLAUDE-*.md, are companions only when they are a regular file or a link to one: a directory, a FIFO or a link
  // to either is not a companion and is skipped, like the shell block of Step 4 (find -L -type f); a link that cannot be followed
  // (to nothing, a loop, no permission) claims to be one and is unreadable below.
  const isCompanion = (file) => {
    try {
      const info = fs.lstatSync(file);
      if (!info.isSymbolicLink()) return info.isFile();
      try {
        return fs.statSync(file).isFile();
      } catch {
        return true;
      }
    } catch {
      return false;
    }
  };
  // The candidate files, in order: CLAUDE.md, the CLAUDE-*.md file it references, otherwise CLAUDE-omc.md and then every
  // CLAUDE-*.md of the config directory in name order. CLAUDE-omc.md is the name the runtime opens (the file system decides
  // about letter case: on a volume that ignores it, Claude-Omc.md is that file), and the scan matches names in either case.
  const base = path.join(configDir, 'CLAUDE.md');
  let baseContent = '';
  try {
    baseContent = readFile(base);
  } catch {}
  const candidates = [base];
  const referenced = baseContent.match(/CLAUDE-[^ )]*[.]md/);
  if (referenced) {
    candidates.push(path.join(configDir, referenced[0]));
  } else {
    const defaultCompanion = path.join(configDir, 'CLAUDE-omc.md');
    if (isCompanion(defaultCompanion)) candidates.push(defaultCompanion);
    try {
      const names = fs.readdirSync(configDir).filter((name) => /^CLAUDE-.*[.]md(?![^])/i.test(name)).sort();
      for (const name of names) {
        const other = path.join(configDir, name);
        if (candidates.includes(other) === false && isCompanion(other)) candidates.push(other);
      }
    } catch {}
  }
  // The first candidate that carries the marker decides. One ahead of it that is there but cannot be read as a regular file
  // (a link to nothing, a directory, no permission) may hold the marker that would decide, so the version is unreadable;
  // one that is not there is skipped.
  let claudeVersion = '(missing)';
  let markerExact = true;
  let claudeSource = '(none)';
  let cannotRead = '';
  let variant = null;
  for (const file of candidates) {
    try {
      const text = readFile(file);
      // The runtime (extractOmcVersion in scripts/session-start.mjs) reads only the exact, case-sensitive, spaced form with a
      // digit first, and the first such marker decides, wherever a variant spelling stands; the marker chosen and its exactness are
      // one match. Where no exact marker exists, any other spelling is a marker it cannot read, which it reports as instruction drift.
      const exact = text.match(/<!-- OMC:VERSION:(\d+\.\d+\.\d+[^\s]*?) -->/);
      if (exact) {
        markerExact = true;
        claudeVersion = exact[1];
        claudeSource = file;
        variant = null;
        break;
      }
      // A variant spelling is a marker the runtime cannot read: it counts only when no later candidate holds an exact marker, which would decide.
      const other = !variant && text.match(/<!--\s*OMC:VERSION:([^\s]+)\s*-->/i);
      if (other) variant = { file, version: other[1], cannotRead };
    } catch (error) {
      if (!cannotRead && !absent(error, file)) cannotRead = file + ' (' + ((error && error.code) || 'not a regular file') + ')';
    }
  }
  if (variant) {
    markerExact = false;
    claudeVersion = variant.version;
    claudeSource = variant.file;
    cannotRead = variant.cannotRead;
  }
  if (cannotRead) {
    claudeVersion = '(unreadable)';
    claudeSource = cannotRead;
  } else if (claudeVersion === '(missing)' && candidates.length > 0) {
    claudeVersion = '(missing marker)';
    claudeSource = 'scanned deterministic CLAUDE sources';
  }
  const roots = pluginRoots();
  const registry = readChannelRegistry();
  const states = registry.supported.map(([id, entries]) => [marketplaceOf(id), activeEntries(id, entries, roots)]);
  const running = [...new Set(states.filter(([, state]) => state.active.length).map(([market]) => market))];
  let pluginVersion = '(none)';
  // The version of a package the runtime compares with the marker as written, not by its bare form.
  let literal = false;
  // The package of the loaded root names a version that is no string: the runtime returns it as it is and its strict comparison with
  // the marker (a string) always reports drift.
  let notString = false;
  // A registry that cannot be used (as in Step 1) leaves open which marketplace the session runs, and a cache that cannot be
  // read may hold the newest version, so no version is named while either is unreadable.
  const registryUnusable = registry.unreadable || (registry.supported.length > 0 ? registry.malformed : registry.ambiguous);
  // The checkout Step 1 reports as plugin-dir: an existing OMC_PLUGIN_ROOT that is no install a supported entry names.
  const explicitRoot = rootOf(process.env.OMC_PLUGIN_ROOT);
  // With no supported plugin ID in the registry a CLAUDE_PLUGIN_ROOT alone is the plugin-dir checkout too (Step 1), and the runtime
  // reads its package, so no cache beside it is a reference.
  const claudeOnly = !registry.supported.length && !explicitRoot && roots.length > 0;
  const checkout = claudeOnly || (!!explicitRoot && isDirectory(explicitRoot) && !registry.supported.some(([id, entries]) => entries.some((entry) => entryInstallPaths(marketplaceOf(id), entry).some((target) => askSame(target, explicitRoot) != 'no'))));
  // The runtime (isManagedPluginCacheRoot in scripts/session-start.mjs) classifies a root by its text, never through a link, and
  // only the omc cache counts as managed: any other root is read through its own package.
  const lexicallyManaged = (root) => {
    const text = root.replace(/[\\/]+$/, '');
    const inside = path.relative(path.resolve(cacheDirOf('omc')), path.resolve(text));
    if (inside === '' || (inside && !inside.startsWith('..') && !path.isAbsolute(inside))) return true;
    return /\/plugins\/cache\/omc\/oh-my-claudecode\/\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(text.replace(/\\/g, '/'));
  };
  // The runtime reads CLAUDE_PLUGIN_ROOT alone, so that root decides (the other one only where it is absent).
  // A root spelled inside the omc cache is managed whether or not its directory still exists (the runtime classifies it by its text), so a
  // missing one is kept and compared with the omc cache, not replaced by another marketplace.
  const claudeRoot = rootOf(process.env.CLAUDE_PLUGIN_ROOT);
  const loadedRoot = claudeRoot && (isDirectory(claudeRoot) || lexicallyManaged(claudeRoot)) ? claudeRoot : roots[0];
  // A loaded root that exists and lies outside the omc cache is external whether or not an entry holds it (a raw --plugin-dir session beside a
  // valid registration): the runtime reads its own package, whatever the registry says. loadedRoot is undefined where there is neither an existing root nor a missing one in the omc cache.
  const external = (running.length == 1 || running.length == 0) && !!loadedRoot && !lexicallyManaged(loadedRoot);
  const sameRoots = roots.length > 1 ? askSame(roots[0], roots[1]) : 'yes';
  const rootsConflict = sameRoots == 'no';
  let unreadableCache = '';
  const latestIn = (market) => {
    const latest = highestCached(cacheDirOf(market), true);
    if (latest === null && !unreadableCache) unreadableCache = cacheDirOf(market);
    return latest;
  };
  if (registryUnusable) {
    pluginVersion = '(unknown)';
  } else if (states.some(([, state]) => state.unknown)) {
    // As in Step 1: among the entries of one plugin ID a certain match decides, but a match that is unknown for any ID
    // leaves open which marketplace the session runs.
    pluginVersion = '(unknown)';
  } else if (checkout) {
    // As in Step 1 (Channel: plugin-dir): the session runs the explicit checkout, which the runtime reads, so a cache beside it is no answer.
    pluginVersion = '(unknown)';
  } else if (sameRoots != 'yes') {
    // As in Step 1 (Channel: unknown): the session runs one of two different roots (or two that cannot be told apart), and the runtime reads CLAUDE_PLUGIN_ROOT alone.
    pluginVersion = '(unknown)';
  } else if (running.length > 1) {
    // Entries of several marketplaces hold the same root: which of their caches the session runs is not told by the root.
    pluginVersion = '(unknown)';
  } else if (external) {
    // The matched root lies outside the managed cache (a registered external install): the runtime reads the package of that root,
    // so its manifest names the version, not the highest cache beside it.
    // The runtime compares the raw version of that package with the marker (getPluginVersion), so it is kept as written.
    const raw = loadedPackageVersion(loadedRoot);
    pluginVersion = raw ? shownVersion(raw) : '(unknown)';
    notString = !!raw && typeof raw != 'string';
  } else if (running.length || (!!loadedRoot && lexicallyManaged(loadedRoot))) {
    // The runtime (getPluginVersion) scans the omc cache whatever registry key records the root (or none does), once the root is spelled inside it
    // (that is what makes it managed), and keeps the raw package version of the root it loaded unless a complete cached version is newer
    // in its own order: a managed root refreshed in place may hold a package version other than its directory name, and that root is no
    // cached version by its name.
    const latest = latestIn('omc') || '';
    const loaded = loadedPackageVersion(loadedRoot);
    if (latest && (!loaded || runtimeSemverCompare(latest, loaded) > 0)) {
      pluginVersion = latest;
    } else if (loaded) {
      pluginVersion = shownVersion(loaded);
      notString = typeof loaded != 'string';
      literal = true;
    } else {
      pluginVersion = '(none)';
    }
  } else {
    for (const market of markets) pluginVersion = latestIn(market) || pluginVersion;
  }
  if (unreadableCache) pluginVersion = '(unknown)';
  console.log('CLAUDE.md OMC version:', claudeVersion);
  console.log('OMC version source:', claudeSource);
  console.log('Latest cached plugin version:', pluginVersion);
  if (registryUnusable) {
    console.log('Note: installed_plugins.json cannot be used, so it is unknown which plugin install the session runs');
    console.log('VERSION CHECK SKIPPED: installed_plugins.json cannot be used, so no cache is chosen');
  } else if (unreadableCache) {
    console.log('Note: the plugin cache ' + unreadableCache + ' cannot be read, so its version is unknown');
    console.log('VERSION CHECK SKIPPED: the plugin cache cannot be read, so no version is compared');
  } else if (claudeVersion === '(unreadable)') {
    console.log('VERSION CHECK SKIPPED: a CLAUDE source cannot be read, so its OMC:VERSION marker is unknown (see OMC version source)');
  } else if (checkout && sameRoots == 'yes') {
    console.log('VERSION CHECK SKIPPED: the session runs a plugin-dir checkout (OMC_PLUGIN_ROOT outside the registry), so the plugin cache says nothing about it and no cache is chosen');
  } else if (running.length > 1 && !rootsConflict) {
    console.log('VERSION CHECK SKIPPED: the plugin root the session runs is recorded by more than one marketplace, so it is unknown which cache is the install and no cache is chosen');
  } else if (rootsConflict) {
    console.log('VERSION CHECK SKIPPED: OMC_PLUGIN_ROOT and CLAUDE_PLUGIN_ROOT name different directories, so it is unknown which plugin install the session runs and no cache is chosen');
  } else if (external && pluginVersion === '(unknown)') {
    console.log('VERSION CHECK SKIPPED: the plugin root the session runs lies outside the plugin cache and its manifest names no usable version, so no cache is chosen');
  } else if (pluginVersion === '(unknown)') {
    console.log('VERSION CHECK SKIPPED: which plugin install the session runs is unknown (the file system gives no identity to a plugin root or an install path), so no cache is chosen');
  } else if (claudeVersion === '(missing)' || claudeVersion === '(missing marker)' || pluginVersion === '(none)') {
    console.log('VERSION CHECK SKIPPED: missing CLAUDE marker or plugin cache');
  } else if (dropV(claudeVersion) === dropV(pluginVersion) && /^\d/.test(claudeVersion) && markerExact && !notString && (!(external || literal) || claudeVersion === pluginVersion)) {
    console.log('VERSION MATCH: CLAUDE and plugin cache are aligned');
  } else {
    console.log('VERSION DRIFT: CLAUDE.md and plugin versions differ');
  }
};

// == Step 6 ==
const cacheVersions = () => {
  const markets = registryMarketplaces();
  // With more than one marketplace every line is led by its name.
  for (const market of markets) {
    const lead = markets.length > 1 ? market + ': ' : '';
    try {
      const names = versionDirs(cacheDirOf(market));
      console.log(lead + names.length + ' version(s):', names.join(', '));
    } catch (error) {
      const dir = cacheDirOf(market);
      console.log(lead + (absent(error, dir) ? '0 versions' : 'could not read ' + dir + ' (' + ((error && error.code) || 'unknown error') + ')'));
    }
  }
};

// == repair constants ==
// Moves the cached plugin versions that nothing protects to plugins/backups, never deletes one. A version is
// protected when installed_plugins.json pins it, when the installPath of another plugin or a plugin root variable
// points into it, or when a running session holds it (an occupancy record). A source that cannot be read
// completely, or a version whose identity cannot be established, makes the command move nothing.
const backups = path.join(configDir, 'plugins', 'backups', 'oh-my-claudecode');
const registryFile = path.join(configDir, 'plugins', 'installed_plugins.json');
const occupancyDir = path.join(configDir, '.omc', 'cache-occupancy');
const stopUnreadable = (reason) =>
  'Nothing moved: installed_plugins.json, the cache occupancy records, the plugin root variables or a path in them could not be read completely; fix that first, then run this again' +
  (reason ? ' (cause: ' + reason + ')' : '');
const STOP_NO_IDENTITY =
  'Nothing moved: identity unavailable (the file system reports no inode, or a stat failed, for a cache version or for a path that may protect one, and the spelling of that path does not place it inside a version, so it cannot be ruled out as another name of a cached version); keep the cache and every path that points into it spelled alike, or use a file system that reports inodes, then run this again';
// The same threshold as STALE_THRESHOLD_MS in src/utils/paths.ts, which SessionStart's own cleanup uses.
const FRESH_MS = 600000;
// A modification date further ahead than this is a wrong clock or an archive, not an update in progress.
const FUTURE_MS = 300000;
// A refusal or a failure ends with exit code 1, so that it cannot be mistaken for a success.
const refuse = (text) => {
  process.exitCode = 1;
  console.log(text);
};

// == repair registry ==
// pins: the entries of the supported plugin IDs. other: the installPath of every entry of another plugin. ids: the
// supported IDs. unreadable: the file is not a regular file, is not JSON of the expected shape, or holds a
// malformed entry anywhere; reason names the first such entry. A missing file is no pins and not unreadable.
// A Windows path (a drive letter or a UNC path) in the installPath of an entry of OMC cannot be read on another
// system, so it counts as unreadable instead of protecting nothing. An installPath that is not absolute (and no
// Windows path) names another directory for each directory the command runs in, so it counts as unreadable too: the
// pin it carries could not be told from a version nothing protects.
// A UNC path may be written with forward slashes (//server/share); where that names an existing directory it is a POSIX path.
const windowsPath = (target) => /^(?:[A-Za-z]:[/\\]|\\\\|\/\/(?!\/))/.test(target);
const foreignPath = (target) => process.platform != 'win32' && windowsPath(target) && !(target.startsWith('//') && isDirectory(target));
// The same question for a path of an occupancy record or of a plugin root variable, answered by the system the command really
// runs on (the path module is the real one; process.platform may be reported otherwise, and a real Windows path is no foreign
// path on a real Windows host whatever platform is reported).
// On a Windows host the reverse holds: a rooted POSIX path (/mnt/c/..., written by a WSL or Linux session) is foreign, and
// resolved here it would name a directory of the current drive.
const foreignToHost = (target, windowsHost = path.sep == '\\') =>
  windowsHost
    ? !windowsPath(target) && target.startsWith('/')
    : windowsPath(target) && !(target.startsWith('//') && isDirectory(target));
const relativePath = (target) => !path.isAbsolute(target) && !windowsPath(target);
const readRegistry = () => {
  let unreadable = false;
  let reason = '';
  let pins = [];
  let other = [];
  let ids = [];
  try {
    const json = readJson(registryFile);
    const plugins = json ? json.plugins ?? json : 0;
    if (!plugins || typeof plugins != 'object' || Array.isArray(plugins)) throw 0;
    for (const [key, entries] of Object.entries(plugins)) {
      const id = key.toLowerCase();
      const isSupported = OMC_IDS.includes(id);
      if (!Array.isArray(entries) || !entries.length) {
        reason = key + ' has no list of entries';
        throw 0;
      }
      if (!isSupported && id.includes('oh-my-claudecode')) {
        reason = key + ' looks like OMC but is not a plugin ID the installer accepts';
        throw 0;
      }
      if (isSupported) ids.push(id);
      for (const entry of entries) {
        if (entryShapeBad(entry)) {
          reason = 'an entry of ' + key + ' has no usable version or installPath';
          throw 0;
        }
        if (isSupported && entry.version != undefined && !semver(entry.version)) {
          reason = 'an entry of ' + key + ' has version ' + JSON.stringify(entry.version) + ', which is not a semantic version';
          throw 0;
        }
        if (isSupported && typeof entry.installPath == 'string' && foreignPath(entry.installPath.trim())) {
          reason = 'an entry of ' + key + ' has the Windows path ' + JSON.stringify(entry.installPath) + ' as installPath, which this system cannot read';
          throw 0;
        }
        if (isSupported && typeof entry.installPath == 'string' && path.sep == '\\' && foreignToHost(entry.installPath.trim())) {
          reason = 'an entry of ' + key + ' has the POSIX path ' + JSON.stringify(entry.installPath) + ' as installPath, which this system cannot read';
          throw 0;
        }
        if (!isSupported && typeof entry.installPath == 'string' && (foreignPath(entry.installPath.trim()) || (path.sep == '\\' && foreignToHost(entry.installPath.trim()))) && /oh-my-claudecode|[/\\]plugins[/\\]cache[/\\]/i.test(entry.installPath)) {
          reason = 'an entry of ' + key + ' has the foreign path ' + JSON.stringify(entry.installPath) + ' as installPath, which names an OMC or plugin cache tree this system cannot read';
          throw 0;
        }
        if (typeof entry.installPath == 'string' && relativePath(entry.installPath.trim())) {
          reason = 'an entry of ' + key + ' has the relative path ' + JSON.stringify(entry.installPath) + ' as installPath, which names another directory for each directory the command runs in';
          throw 0;
        }
        if (!isSupported) {
          if (typeof entry.installPath == 'string') other.push(entry.installPath.trim());
        } else pins.push(entry);
      }
    }
  } catch (error) {
    pins = [];
    other = [];
    ids = [];
    unreadable = !absent(error, registryFile);
    if (unreadable && !reason) reason = error && error.code == 'ENOENT' ? 'a link on the way to the file points at nothing' : 'the file is not a regular file or not JSON of the expected shape';
  }
  return { unreadable, reason, pins, other, ids };
};

// == occupancy records ==
// Where this process runs, and whether a record names another place (copies of machineId, placeId and isForeignOwner of scripts/lib/cache-occupancy.mjs,
// because this script is plain Node with no import of the plugin's files; omc-doctor-cache-occupancy-records.test.ts runs both and compares).
const machineId = () => {
  let machine = '';
  for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      machine = fs.readFileSync(file, 'utf8').trim();
    } catch {}
    if (machine) break;
  }
  return machine || systemMachineId();
};
let systemMachine;
const systemMachineId = () => {
  if (systemMachine !== undefined) return systemMachine;
  systemMachine = '';
  try {
    const kind = os.type();
    const windows = kind === 'Windows_NT';
    if (windows || kind === 'Darwin') {
      // Absolute paths: a bare name would also be searched for in the working directory on Windows.
      const command = windows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe') : '/usr/sbin/ioreg';
      const args = windows ? ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'] : ['-rd1', '-c', 'IOPlatformExpertDevice'];
      const result = childProcess.spawnSync(command, args, { encoding: 'utf8', timeout: 1000, windowsHide: true });
      const found = result.status === 0 && (windows ? /MachineGuid\s+REG_SZ\s+(\S+)/ : /"IOPlatformUUID" = "([^"]+)"/).exec(result.stdout || '');
      if (found) systemMachine = kind + ':' + found[1];
    }
  } catch {}
  return systemMachine;
};
const placeId = () => {
  const machine = machineId();
  let namespace = '';
  try {
    namespace = fs.readlinkSync('/proc/self/ns/pid');
  } catch {}
  return os.hostname() + '|' + machine + '|' + namespace;
};
const isForeignOwner = (record) => typeof record?.host !== 'string' || record.host === '' || machineId() === '' || record.host !== placeId();
// A record is ignored only when its owner is proven gone: the process does not exist, on Linux its start time
// differs from the recorded one, or the record is dated more than 5 minutes in the future (not for a record of another place, whose clock this
// system cannot judge).
const ownerGone = (record) => {
  // A record of another host or PID namespace cannot be judged by a local probe (isForeignOwner, as the runtime reader treats it).
  if (Number.isSafeInteger(record.pid) && record.pid > 0 && !isForeignOwner(record)) {
    try {
      process.kill(record.pid, 0);
    } catch (error) {
      if (!(error && error.code == 'EPERM')) return true;
    }
    if (process.platform === 'linux' && typeof record.processStartIdentity == 'string' && record.processStartIdentity) {
      let stat = '';
      try {
        stat = fs.readFileSync('/proc/' + record.pid + '/stat', 'utf8');
      } catch (error) {}
      const close = stat.lastIndexOf(')');
      const start = close < 0 ? '' : stat.substring(close + 2).split(' ')[19];
      if (start && start != record.processStartIdentity) return true;
    }
  }
  // The clock of another host is not judged here: a record of another place is not ignored for its date.
  return typeof record.updatedAt == 'string' && Date.parse(record.updatedAt) - Date.now() > 300000 && !isForeignOwner(record);
};

// == modification dates ==
// The newest modification time of an entry and of everything below it, at any depth. A link is dated itself and
// never followed. Throws when more than 20000 entries are found or an entry cannot be read.
const newestChange = (root) => {
  let newest = 0;
  let count = 0;
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i];
    const stat = fs.lstatSync(entry);
    newest = Math.max(newest, stat.mtimeMs);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(entry)) {
        if (++count > 20000) throw 0;
        queue.push(path.join(entry, name));
      }
    }
  }
  return newest;
};

// == protection ==
// protectionOf(dir, versions, foldCase) reads every source of protection again and returns { unreadable, reason, noIdentity,
// pinned, kept }: unreadable (with the reason, when the registry names one) and noIdentity stop the command, pinned
// are the versions the registry pins (or a path of a pin reaches), kept are all protected versions. dir is the cache
// directory and versions the version directory names in it. foldCase is explained at isUnderLowercase.
const protectionOf = (dir, versions, foldCase = false) => {
  let unreadable = false;
  let unmapped = '';
  // A path that goes through a link and then .. names the parent of the link target on the file system and the
  // parent of the link as text. The chain reads it the first way, the runtime folds an occupancy record the second
  // way, so every path that protects is read both ways, like a record.
  const bothForms = (target) => [...new Set([target, path.resolve(target)])];
  const chainOf = (target) => {
    const chain = linkChain(target);
    if (chain.unreadable) unreadable = true;
    return chain.paths;
  };
  // The identity of a path without following a link at its end, and whether a path has none (inode 0, or a stat
  // that failed for another reason than the path not existing).
  const identityOf = (target) => {
    try {
      const stat = fs.lstatSync(target, { bigint: true });
      return stat.ino ? stat.dev + ':' + stat.ino : '';
    } catch (error) {
      return '';
    }
  };
  const lacksIdentity = (target) => {
    try {
      return !fs.lstatSync(target, { bigint: true }).ino;
    } catch (error) {
      return !(error && ['ENOENT', 'ENOTDIR'].includes(error.code));
    }
  };
  const isUnder = (target, parent) => {
    target = path.resolve(target);
    parent = path.resolve(parent);
    return target === parent || target.startsWith(parent + path.sep);
  };
  // win32 only: the SessionStart publisher stores the plugin root of a record in lower case. foldCase asks for the same comparison elsewhere:
  // the read made after a version was moved, on a volume that ignores letter case, where no identity can resolve another spelling any more.
  const isUnderLowercase = (target, parent) => {
    if (process.platform != 'win32' && !foldCase) return false;
    target = path.resolve(target).toLowerCase();
    parent = path.resolve(parent).toLowerCase();
    return target === parent || target.startsWith(parent + path.sep);
  };
  const realDir = chainOf(dir).pop();
  // The plugin root variables: two different existing directories cannot be told apart from a conflict.
  const rootVars = [process.env.OMC_PLUGIN_ROOT, process.env.CLAUDE_PLUGIN_ROOT]
    .map(rootOf)
    .filter(Boolean);
  if (
    rootVars.length > 1 &&
    rootVars.every((root) => {
      try {
        return fs.statSync(root).isDirectory();
      } catch (error) {
        return false;
      }
    })
  ) {
    const first = chainOf(rootVars[0]).pop();
    const second = chainOf(rootVars[1]).pop();
    if (askSame(first, second) != 'yes') unreadable = true;
  }
  // A plugin root variable written as a Windows path cannot be read here, and a relative one names another directory for each
  // directory the command runs in (as a relative installPath does): neither can protect a version reliably.
  if (rootVars.some((root) => foreignToHost(root) || relativePath(root))) unreadable = true;
  const registry = readRegistry();
  unreadable = unreadable || registry.unreadable;
  let names = [];
  try {
    names = fs.readdirSync(occupancyDir);
  } catch (error) {
    // A link to nothing in place of the directory (or of a directory above it) is not an absent registry of records.
    unreadable = unreadable || !absent(error, occupancyDir);
  }
  // The plugin roots of the records of running sessions.
  const held = [];
  const foreignRoots = [];
  for (const name of names) {
    if (name.length == 69 && /^[a-f0-9]{64}[.]json/.test(name)) {
      const file = path.join(occupancyDir, name);
      try {
        if (!fs.lstatSync(file).isFile()) continue;
        const record = readJson(file);
        // A record of a Windows session (a Windows or a relative plugin root, a tick-count start identity) cannot be judged here: neither
        // "owner gone" nor the root can be read, so the command stops instead of treating the record as gone or as relative.
        if ((typeof record.pluginRoot == 'string' && record.pluginRoot.trim() && (foreignToHost(record.pluginRoot.trim()) || relativePath(record.pluginRoot.trim()))) || (path.sep != '\\' && typeof record.processStartIdentity == 'string' && record.processStartIdentity.startsWith('ticks:'))) {
          unreadable = true;
          continue;
        }
        if (ownerGone(record)) continue;
        if (typeof record.pluginRoot != 'string' || !record.pluginRoot.trim()) throw 0;
        if (isForeignOwner(record)) foreignRoots.push(record.pluginRoot);
        held.push(record.pluginRoot, path.resolve(record.pluginRoot));
      } catch (error) {
        if (!absent(error, file)) unreadable = true;
      }
    }
  }
  // The paths that pin: the directory of every pinned version (as written and without a leading v) that exists or
  // may exist, and every installPath of a pin.
  // A version-only pin is read in the cache of every marketplace, not only in the one being cleaned: its directory there may be a
  // link into this one (or a link into another), and the target stays in place only when the link is followed.
  const spaces = [...new Set([dir, ...[...registry.ids.map(marketplaceOf), 'omc'].map(cacheDirOf)])];
  const pinPaths = [];
  for (const pin of registry.pins) {
    const version = pin.version?.trim();
    for (const name of version ? [...new Set([version, dropV(version)])] : []) {
      for (const space of spaces) {
        const listed = space == dir && versions.find((x) => x === name);
        const written = space + path.sep + name;
        if (listed) pinPaths.push(path.join(dir, listed));
        else if (identityOf(written) || lacksIdentity(written)) pinPaths.push(written);
      }
    }
    if (pin.installPath != undefined) pinPaths.push(...bothForms(pin.installPath.trim()));
  }
  // The plugin root of a record of another host is spelled as that host sees it, and a profile can be mounted under another path there. One
  // that does not lie in a cache of this system cannot be mapped to a version here, so nothing is moved while such a record is held.
  const insideCache = (target) => spaces.some((space) => [space, chainOf(space).pop()].some((parent) => [target, ...chainOf(target)].some((one) => isUnder(one, parent))));
  const stray = foreignRoots.find((root) => !insideCache(root));
  if (stray !== undefined) {
    unreadable = true;
    unmapped = 'an occupancy record of another host or PID namespace has the plugin root ' + JSON.stringify(stray) + ', which lies in no cache of this system (the profile may be mounted under another path there), so the version it holds cannot be told; delete the record from ' + occupancyDir + ' once that session has ended';
  }
  const pinChains = pinPaths.flatMap(chainOf);
  const otherChains = [...registry.other.flatMap(bothForms), ...held, ...rootVars.flatMap(bothForms)].flatMap(chainOf);
  // The versions a list of paths protects: a path that is, or lies inside, the version directory (as written or
  // through the real cache path), or an ancestor of a path with the identity of the version directory. lowercase
  // are the paths of records, which on win32 also protect by a lower-case comparison.
  const versionsReachedBy = (chains, lowercase = []) => {
    const ids = new Set();
    for (let up of chains) {
      for (;;) {
        const id = identityOf(up);
        if (id) ids.add(id);
        const parent = path.dirname(up);
        if (parent == up) break;
        up = parent;
      }
    }
    return versions.filter(
      (name) =>
        chains.some((target) => isUnder(target, path.join(dir, name)) || isUnder(target, path.join(realDir, name))) ||
        ids.has(identityOf(path.join(dir, name))) ||
        lowercase.some(
          (target) => isUnderLowercase(target, path.join(dir, name)) || isUnderLowercase(target, path.join(realDir, name)),
        ),
    );
  };
  const pinned = versionsReachedBy(pinChains);
  const kept = versionsReachedBy([...pinChains, ...otherChains], held);
  // When the file system reports no identity for a version directory, a protecting path has to be placed by its
  // exact text inside a version (or above the cache directory) or it may be another name of a cached version.
  const resolvedHeld = held.map((target) => path.resolve(target));
  const anyVersionLacksIdentity = versions.some((name) => lacksIdentity(path.join(dir, name)));
  const placed = (target, isHeld) =>
    versions.some((name) =>
      [dir, realDir].some((parent) => {
        const version = path.join(parent, name);
        return isUnder(target, version) || (isHeld && isUnderLowercase(target, version));
      }),
    ) ||
    isUnder(dir, target) ||
    isUnder(realDir, target) ||
    path.dirname(target) == target;
  const noIdentity =
    !unreadable &&
    [...pinChains, ...otherChains].some((target) => {
      let isHeld = resolvedHeld.includes(target);
      for (;;) {
        if (lacksIdentity(target)) return !placed(target, isHeld);
        if (identityOf(target)) return anyVersionLacksIdentity && !placed(target, isHeld);
        const parent = path.dirname(target);
        if (parent == target) return false;
        target = parent;
        isHeld = false;
      }
    });
  return { unreadable, reason: registry.unreadable ? registry.reason : unmapped, noIdentity, pinned, kept };
};

// == backup destination ==
// A version the cache commands move aside has to be safe from whatever removes, relinks or reads a cache version, so the
// backup directory is resolved first, the way the file system does (every link on the way; for what does not exist yet
// its nearest existing parent and the rest of the name), and has to lie outside every tree below. backupPlace(registry)
// answers { place, problem }: place is the real directory the moves go to, problem is empty when all is well and says
// why nothing is moved otherwise. The trees: the plugin cache (the cache of every marketplace lies inside it), the
// marketplace clones, every cache namespace (a link may take one out of the cache), the occupancy records, the plugin root variables and every installPath of the registry, each as
// written and as the file system reads it (a .. after a link). Both directions count (the destination inside a tree, a
// tree inside the destination); a destination the configuration itself writes inside a tree (an active root that is the
// configuration directory) is not an overlap that a link made. A destination that cannot be resolved (a link to nothing, a loop, no permission) or
// compared (no file system identity) is refused like an overlap, because a link may lead anywhere.
const resolvable = (target) => {
  try {
    fs.statSync(target);
    return true;
  } catch (error) {
    // A file where a directory should be is no link: the move fails there and says so (Cache move failed).
    return !!error && ((error.code == 'ENOENT' && nothingAt(target)) || error.code == 'ENOTDIR');
  }
};
const backupPlace = (registry) => {
  const chain = linkChain(backups);
  const place = chain.paths[chain.paths.length - 1];
  const stop = (reason) => ({ place, problem: 'Nothing moved: ' + reason + '; fix that first, then run this again' });
  const named = backups + (place == path.resolve(backups) ? '' : ' (really ' + place + ')');
  if (chain.unreadable) return stop('the backup directory ' + backups + ' cannot be resolved (a link loop, or a part of the path that cannot be examined)');
  if (!resolvable(backups)) return stop('the backup directory ' + backups + ' cannot be resolved (a link on the way to it points at nothing)');
  const bothForms = (target) => [...new Set([target, path.resolve(target)])];
  const installPaths = [...registry.pins.map((entry) => entry.installPath), ...registry.other]
    .filter((target) => typeof target == 'string' && target.trim())
    .map((target) => target.trim());
  const roots = [process.env.OMC_PLUGIN_ROOT, process.env.CLAUDE_PLUGIN_ROOT].map(rootOf).filter(Boolean);
  // A cache namespace (or the plugin directory in it) may be a link out of plugins/cache: its versions then lie
  // elsewhere, so each one is a tree of its own, resolved by the comparisons below.
  const namespaces = [...new Set([...registry.ids.map(marketplaceOf), 'omc'])].map(cacheDirOf);
  const cacheRoot = path.join(configDir, 'plugins', 'cache');
  try {
    for (const market of fs.readdirSync(cacheRoot)) namespaces.push(cacheDirOf(market), path.join(cacheRoot, market));
  } catch (error) {
    // A cache root that is not there has no namespaces; one that cannot be listed may hide namespaces the backup must lie outside of.
    if (!absent(error, cacheRoot)) return stop('the plugin cache ' + cacheRoot + ' could not be read completely');
  }
  // A version directory may be a link out of the cache too: the tree it leads to is a tree of its own. A link that leads nowhere (a loop,
  // a target that is gone) has no tree, and the entry is moved aside like any unused one.
  const versionTrees = [];
  for (const space of new Set(namespaces)) {
    try {
      for (const name of fs.readdirSync(space)) {
        const entry = path.join(space, name);
        try {
          if (fs.lstatSync(entry).isSymbolicLink() && fs.statSync(entry).isDirectory()) versionTrees.push(entry);
        } catch (error) {
          // No tree to compare.
        }
      }
    } catch (error) {
      // Not a readable directory: the cache commands report that themselves.
    }
  }
  const trees = [
    ['the plugin cache', cacheRoot],
    ...[...new Set(namespaces)].map((tree) => ['the plugin cache', tree]),
    ...[...new Set(versionTrees)].map((tree) => ['the plugin cache', tree]),
    ['the marketplace clones', path.join(configDir, 'plugins', 'marketplaces')],
    ['the occupancy records', occupancyDir],
    ...roots.flatMap(bothForms).map((root) => ['the plugin root', root]),
    ...installPaths.flatMap(bothForms).map((target) => ['an install path of the registry', target]),
  ];
  // What the configuration says without any link: a tree that holds this place already (an active root that is the
  // configuration directory itself) is no overlap that a link made. A link inside the tree that moved the place to
  // another spot of it is such a link: the place then is not where the tree, read through its own links, holds the written one.
  const written = path.resolve(backups);
  const holdsWritten = (tree) => {
    const from = path.resolve(tree);
    if (written != from && !written.startsWith(from + path.sep)) return false;
    const real = linkChain(tree).paths;
    return place == path.join(real[real.length - 1], path.relative(from, written));
  };
  let unknown = '';
  for (const [label, tree] of trees) {
    const inside = askInside(place, tree);
    const outside = askInside(tree, place);
    if (inside == 'yes' && !holdsWritten(tree)) return stop('the backup directory ' + named + ' is, or lies inside, ' + label + ' (' + tree + '), where a copy is not safe from the cleanup of cache versions');
    if (outside == 'yes') return stop('the backup directory ' + named + ' contains ' + label + ' (' + tree + '), so a copy kept there is not outside it');
    if (!unknown && (inside == 'unknown' || outside == 'unknown')) unknown = 'the file system gives no identity to the backup directory ' + named + ' or to ' + label + ' (' + tree + '), so it cannot be ruled out that they overlap';
  }
  return unknown ? stop(unknown) : { place, problem: '' };
};

// == repair run ==
// The texts in which the two cache commands differ: cache-outdated cleans up after an update of an outdated plugin,
// cache-stale cleans up a cache that holds several versions.
const REPAIR_MESSAGES = {
  outdated: {
    movedEnd: '.',
    allProtected: 'Nothing to move: every cached version is pinned in installed_plugins.json or in use by a running session',
    noPin: 'Nothing moved: no pinned cache version found, so nothing is moved',
    noCache: 'No plugin cache found',
    footer: 'This command only cleans up cached versions and does not update the plugin. To update, run the Updater line that Step 1 printed, then restart Claude Code.',
  },
  stale: {
    movedEnd: '',
    allProtected: 'Nothing to move: keep every pinned version; do not prune cache versions by age, lexical/version order, or presence of a newer version',
    noPin: 'Nothing moved: no pinned version found; manual review instead of pruning',
    noCache: 'No cache to clean',
    footer: '',
  },
};

// Moves the cached versions that nothing protects to plugins/backups. kind is outdated or stale.
const cacheRepair = (kind) => {
  const messages = REPAIR_MESSAGES[kind];
  // One cache directory: print what is protected, move the free versions to the backup directory. Returns true when
  // the whole command has to stop. With check set it only reads and judges (the cache, its protection, the backup
  // directory) and moves and prints nothing but a refusal, so that every cache is judged before any is touched.
  let moveStarted = false;
  const cleanCache = (market, dir, lead, check) => {
    let moved = 0;
    let skipped = 0;
    let fresh = 0;
    let future = 0;
    let unjudged = 0;
    try {
      const versions = versionDirs(dir);
      const state = protectionOf(dir, versions);
      if (state.unreadable) {
        refuse(stopUnreadable(state.reason));
        return true;
      }
      if (state.noIdentity) {
        refuse(lead + STOP_NO_IDENTITY);
        return true;
      }
      const free = versions.filter((name) => !state.kept.includes(name));
      if (state.kept.length && !check) {
        console.log(lead + 'Kept protected cache versions (pinned in installed_plugins.json or in use by a running session):', state.kept.join(', '));
      }
      if (state.pinned.length && free.length) {
        // Where the moves go is settled before the first one: a link in the way of the backup directory may lead into a
        // cache version, where the only recovery copy would be removed or relinked by the next cleanup.
        const target = backupPlace(registry);
        if (target.problem) {
          refuse(lead + target.problem);
          return true;
        }
        // A rename cannot cross file systems: refuse before the destination is created, not with the first move.
        let apart = '';
        try {
          let up = target.place;
          while (!taken(up) && path.dirname(up) != up) up = path.dirname(up);
          const there = fs.statSync(up, { bigint: true }).dev;
          const here = fs.statSync(dir, { bigint: true }).dev;
          if (there && here && there != here) apart = up;
        } catch {}
        if (apart) {
          refuse(lead + 'Nothing moved: the backup directory ' + backups + (target.place == path.resolve(backups) ? '' : ' (really ' + target.place + ')') + ' is on another file system than the cache ' + dir + ', and a version cannot be moved across file systems; point plugins/backups at a directory on the cache file system, then run this again');
          return true;
        }
        if (check) return false;
        const redirected = target.place != path.join(realPath(path.dirname(path.dirname(backups))), 'backups', 'oh-my-claudecode');
        moveStarted = true;
        fs.mkdirSync(target.place, { recursive: true });
        // Whether a version may be moved by its modification dates: counts what it leaves alone and answers false then. Asked for the choice, again
        // after the protection read before the last one, and once more on the version in the backup after the move (`at` names where it lies), because an
        // update may touch it between.
        const settled = (name, at = path.join(dir, name)) => {
          let newest;
          try {
            newest = newestChange(at);
          } catch (error) {
            unjudged++;
            return false;
          }
          if (newest - Date.now() > FUTURE_MS) {
            future++;
            return false;
          }
          if (Date.now() - newest < FRESH_MS) {
            fresh++;
            return false;
          }
          return true;
        };
        free.forEach((name) => {
          if (!settled(name)) return;
          // A backup goes to a destination that does not exist yet: a rename would replace an empty directory or a file
          // of that name, and the cleanup that keeps old versions aside must never erase an earlier copy.
          const backup = path.join(target.place, (market == 'omc' ? '' : market + '-') + name + '-' + Date.now());
          if (taken(backup)) throw new Error('the backup destination ' + backup + ' exists already, so nothing was moved to it');
          // Everything is read again just before the move: the backup directory (a change stops the command) and the
          // protection (a version that became protected is skipped).
          const current = readRegistry();
          if (current.unreadable) {
            // The registry turned unreadable: the protection below says so too, and the version stays.
            skipped++;
            return;
          }
          const here = backupPlace(current);
          if (here.problem || here.place != target.place) throw new Error('the backup directory changed or overlaps a cache tree now, so nothing more was moved: ' + (here.problem || here.place));
          const again = protectionOf(dir, versions);
          if (again.unreadable || again.noIdentity || !again.pinned.length || again.kept.includes(name)) {
            skipped++;
          } else if (settled(name)) {
            // The protection is read once more after the last date check, right before the rename: a session that started to occupy the
            // version in the meantime does not change its dates, so only this read can see it.
            const last = protectionOf(dir, versions);
            if (last.unreadable || last.noIdentity || !last.pinned.length || last.kept.includes(name)) {
              skipped++;
            } else {
              // Two signals, the dates and the protection, cannot be read in one instant, and each read leaves a window for the other one (an
              // update changes dates, a session that starts publishes a record and changes none). So the version is moved first and both are read
              // once more with it out of the cache, the dates first and the protection last; one that shows use is put back where it was.
              const original = path.join(dir, name);
              // Whether the volume ignores letter case here: the cache directory spelled in upper case names the same directory. Read before the move,
              // while the version still has an identity to compare.
              const alias = path.join(path.dirname(dir), path.basename(dir).toUpperCase(), name);
              const foldCase = !!identity(original) && identity(alias) == identity(original);
              fs.renameSync(original, backup);
              // A destination that was redirected in that instant no longer holds the copy at this path: there is nothing to read or to put back, and
              // the check of the destination before the next move stops the run.
              let back = taken(backup) && !settled(name, backup);
              if (!back && taken(backup)) {
                const after = protectionOf(dir, versions, foldCase);
                if (after.unreadable || after.noIdentity || !after.pinned.length || after.kept.includes(name)) {
                  skipped++;
                  back = true;
                }
              }
              if (back) {
                if (taken(original)) throw new Error('version ' + name + ' showed use right after it was moved and ' + original + ' exists again, so it could not be put back and stays in ' + backup);
                fs.renameSync(backup, original);
              } else {
                moved++;
              }
            }
          }
        });
        console.log(lead + 'Moved', moved, 'unprotected version(s) to', backups + (redirected ? ' (really ' + target.place + ')' : '') + messages.movedEnd);
        if (skipped) console.log(lead + 'Skipped', skipped, 'version(s) that became protected or unreadable just before the move');
        if (unjudged) {
          console.log(lead + 'Could not judge', unjudged, 'version(s) (more than 20000 entries, or an entry could not be read), so they were left in place');
        }
        if (fresh) {
          console.log(lead + 'Left', fresh, 'version(s) modified in the last 10 minutes alone: an update may still be installing them; run this again later');
        }
        if (future) {
          console.log(lead + 'Left', future, 'version(s) alone that have a modification date more than 5 minutes in the future (a wrong clock, or files extracted from an archive): check the dates, then run this again');
        }
      } else if (!check) {
        console.log(lead + (state.pinned.length ? messages.allProtected : messages.noPin));
      }
    } catch (error) {
      const code = error && error.code;
      const missing = absent(error, dir);
      const text =
        lead +
        (moveStarted
          ? 'Cache move failed (' + moved + ' moved before the error): ' + error.message
          : missing
            ? messages.noCache + (market == 'omc' ? '' : ' in plugins/cache/' + market)
            : 'Nothing moved: could not read ' + dir + ' (' + (code || 'unknown error') + (code == 'ENOENT' ? ': a link on the way points at nothing' : '') + ')');
      // A missing cache is nothing to clean, not a failure; a failed move or an unreadable directory is.
      if (moveStarted || !missing) refuse(text);
      else console.log(text);
      return true;
    }
    return false;
  };
  // Every cache directory that exists (or cannot be told from one) is handled in turn; with none the first
  // marketplace is still tried, so that a missing cache is reported. The turns go by the name of the marketplace, not
  // by the order of the registry: a refusal ends the command, so which caches were cleaned before it must not depend on it.
  const registry = readRegistry();
  const markets = registry.ids.length ? [...new Set(registry.ids.map(marketplaceOf))].sort() : ['omc'];
  const caches = markets
    .map((market) => [market, cacheDirOf(market)])
    .filter(([, dir]) => {
      try {
        fs.statSync(dir);
        return true;
      } catch (error) {
        return !absent(error, dir);
      }
    });
  if (!caches.length) caches.push([markets[0], cacheDirOf(markets[0])]);
  if (registry.unreadable) refuse(stopUnreadable(registry.reason));
  else {
    // A cache that cannot be read or judged stops the command before the first move from any of them, not after the caches before it.
    const lead = (market) => (caches.length > 1 ? market + ': ' : '');
    if (!caches.some(([market, dir]) => cleanCache(market, dir, lead(market), true))) {
      for (const [market, dir] of caches) {
        if (cleanCache(market, dir, lead(market))) break;
      }
    }
  }
  if (messages.footer) console.log(messages.footer);
};

// == guide ==
// The details that the skill leaves out are in omc-doctor-guide.md beside this script, one section per `## name` heading.
// `guide <name>` prints that section. A file that cannot be read ends with exit code 1 and a message, a name that is no
// section with 2 (naming the sections), so that a shell block that must have the guide can stop on it.
const guide = () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'omc-doctor-guide.md');
  let text;
  try {
    text = readFile(file).replace(/\r\n/g, '\n');
  } catch (error) {
    console.error(
      'omc-doctor: guide not found: ' + file + ' cannot be read (' + ((error && error.code) || 'not a regular file') +
        '). Reinstall or update the plugin (omc update, or claude plugin update oh-my-claudecode), restart Claude Code and run the doctor again',
    );
    process.exitCode = 1;
    return;
  }
  const sections = text.split(/^(?=## )/m).filter((part) => part.startsWith('## '));
  const nameOf = (part) => part.slice(3, part.indexOf('\n')).trim();
  const name = process.argv[3];
  const found = sections.find((part) => nameOf(part) === name);
  if (!found) {
    console.error('omc-doctor.mjs: unknown guide section ' + JSON.stringify(name) + '; use one of ' + sections.map(nameOf).join(', '));
    process.exitCode = 2;
    return;
  }
  console.log(found.trimEnd());
};

// == dispatch ==
const COMMANDS = {
  step1,
  'npm-latest': npmLatest,
  'claude-md-optout': claudeMdOptOut,
  'claude-md-version': claudeMdVersion,
  'cache-versions': cacheVersions,
  'cache-outdated': () => cacheRepair('outdated'),
  'cache-stale': () => cacheRepair('stale'),
  guide,
};
const name = process.argv[2];
if (Object.hasOwn(COMMANDS, name)) {
  try {
    COMMANDS[name]();
  } catch (error) {
    // process.cwd(), and every path.resolve of a relative path, throws ENOENT (uv_cwd) once the working directory is deleted.
    if (!error || error.syscall != 'uv_cwd') throw error;
    console.error('omc-doctor: current directory no longer exists, so a relative path (the configuration directory, a plugin root or an install path that is not absolute) cannot be resolved; change to a directory that exists and run the command again');
    process.exitCode = 1;
  }
} else {
  console.error('omc-doctor.mjs: unknown command ' + JSON.stringify(name) + '; use one of ' + Object.keys(COMMANDS).join(', '));
  process.exitCode = 2;
}
