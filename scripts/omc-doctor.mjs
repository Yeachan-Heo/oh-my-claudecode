#!/usr/bin/env node
// The commands behind the checks of the omc-doctor skill (skills/omc-doctor/SKILL.md). The skill runs one command per
// Bash call: node omc-doctor.mjs <command>. Every command prints the lines the skill's diagnosis reads and ends with
// exit code 0, except the two cache commands, which end with 1 when they refuse to move anything or a move fails,
// and an unknown command, which ends with 2.
//
//   step1              the install channel (marketplace, plugin-dir, npm or unknown), the installed version, the
//                      channel's latest version and the command that updates it, one block of lines per plugin
//   npm-latest         the latest version of the npm package (only for a Channel: npm install)
//   claude-md-optout   whether CLAUDE.md management is switched off by claudeMdEnabled: false
//   claude-md-version  the OMC version marker of CLAUDE.md (or its companion file) against the newest cached version
//   cache-versions     the version directories of the plugin cache, per marketplace
//   cache-outdated     moves the unprotected cached versions to plugins/backups after an update (never deletes)
//   cache-stale        the same cleanup for a stale cache with several versions
//
// Everything is plain Node (no shell), so it runs the same on Windows and POSIX. The sections below hold the code
// the commands share: each of them exists once, here.

import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

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

// == read file ==
// Reads a regular file only: a FIFO or another special file is never opened, so a read cannot hang.
const readFile = (file) => {
  if (!fs.statSync(file).isFile()) throw 0;
  return fs.readFileSync(file, 'utf8');
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
// through: each link on the way and the end of the chain. A .. after a link names the parent of the link target,
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
    let next = null;
    for (let i = 0; i < parts.length && !next; i++) {
      if (parts[i] == '..') {
        at = path.dirname(at);
        continue;
      }
      at = path.join(at, parts[i]);
      let info;
      try {
        info = fs.lstatSync(at);
      } catch (error) {
        if (!(error && ['ENOENT', 'ENOTDIR'].includes(error.code))) unreadable = true;
        paths.push(path.resolve(at, ...parts.slice(i + 1)));
        return { paths, unreadable };
      }
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

// == marketplaces of the registry ==
// The marketplaces of the supported plugin IDs in installed_plugins.json, each once, in the order of their last
// occurrence. It is omc when the registry holds none and when it cannot be read (missing, a FIFO, bad JSON).
const registryMarketplaces = () => {
  try {
    const json = JSON.parse(readFile(path.join(configDir, 'plugins', 'installed_plugins.json')));
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
// The highest version directory name in a cache directory, or null.
const highestCached = (dir) => {
  try {
    const names = fs.readdirSync(dir).filter(isVersionDir).sort(compareVersions);
    return names.length ? names[names.length - 1] : null;
  } catch {
    return null;
  }
};
// The version in package.json or .claude-plugin/plugin.json under a directory: the first file that has a non-blank
// string version decides. Returns its bare semver, null when it is not one, or '' when no file names a version.
const manifestVersion = (dir) => {
  for (const name of ['package.json', '.claude-plugin/plugin.json']) {
    try {
      const version = JSON.parse(readFile([dir, name].join(path.sep))).version;
      if (typeof version == 'string' && version.trim()) return semver(version) || null;
    } catch {}
  }
  return '';
};
// The version a registry entry names through its installPath: the last component when it is a version directory
// name, else the manifest under it. '' without an installPath, null when the version found is not a semver.
const installPathVersion = (entry) => {
  const installPath = typeof entry.installPath == 'string' ? entry.installPath.trim() : '';
  if (!installPath) return '';
  const last = installPath.split(/[\\/]+/).filter(Boolean).pop() || '';
  return (isVersionDir(last) && semver(last)) || manifestVersion(installPath);
};
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
// Whether two paths name one directory: the same real path, or the same identity (a link, another spelling).
const sameDirectory = (a, b) => realPath(a) == realPath(b) || (!!identity(a) && identity(a) == identity(b));
// Whether target is dir or lies inside it: by identity when dir has one (an ancestor of target has it too),
// otherwise by the real paths.
const isInside = (target, dir) => {
  const id = identity(dir);
  let up = realPath(target);
  for (let parent; id; up = parent) {
    if (identity(up) == id) return true;
    parent = path.dirname(up);
    if (parent == up) break;
  }
  const a = realPath(target);
  const b = realPath(dir);
  return a == b || a.startsWith(b + path.sep);
};
const inCache = (target) => isInside(target, path.join(configDir, 'plugins', 'cache'));
// The cache directory a registry version names, as written and without a leading v.
const versionDirPaths = (market, version) =>
  [...new Set([version, dropV(version)])].map((name) => cacheDirOf(market) + path.sep + name);
// The paths a registry entry names as its install: its installPath and the cache directory its version names.
const entryInstallPaths = (market, entry) =>
  [
    entry?.installPath,
    ...(typeof entry?.version == 'string' && entry.version.trim() ? versionDirPaths(market, entry.version.trim()) : []),
  ]
    .filter((target) => typeof target == 'string' && target.trim())
    .map((target) => target.trim());

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
  try {
    const json = JSON.parse(readFile(path.join(configDir, 'plugins', 'installed_plugins.json')));
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
    unreadable = !(error && error.code == 'ENOENT');
  }
  return { unreadable, malformed, ambiguous, supported: [...merged] };
};

// == Step 1: the install channel ==
const step1 = () => {
  const { unreadable, malformed, ambiguous, supported } = readChannelRegistry();
  // The plugin root variables that name an existing directory. OMC_PLUGIN_ROOT (--plugin-dir) is the explicit one.
  // CLAUDE_PLUGIN_ROOT is only a locator here: Claude Code sets it for marketplace installs too, so it names a checkout
  // only when the registry holds no supported plugin ID. The installer's resolver also counts a lone CLAUDE_PLUGIN_ROOT
  // as an explicit root; the difference is deliberate, a marketplace install must not be reported as a checkout.
  const roots = [process.env.OMC_PLUGIN_ROOT, process.env.CLAUDE_PLUGIN_ROOT]
    .map((root) => (root || '').trim())
    .filter(Boolean)
    .filter(isDirectory);
  const explicitRoot = (process.env.OMC_PLUGIN_ROOT || '').trim();
  // A loaded checkout: an existing OMC_PLUGIN_ROOT answers before the registry, whatever the registry holds, unless
  // it is the install a supported entry pins (its installPath, or the cache directory its version names), or the
  // registry cannot be read completely and the root lies inside the plugin cache.
  const registryUnusable = unreadable || (supported.length > 0 && malformed);
  const isPlugindir =
    !!explicitRoot &&
    isDirectory(explicitRoot) &&
    !(registryUnusable && inCache(explicitRoot)) &&
    !supported.some(
      ([key, entries]) =>
        Array.isArray(entries) &&
        entries.some((entry) => entryInstallPaths(marketplaceOf(key), entry).some((target) => sameDirectory(target, explicitRoot))),
    );
  const out = [];
  if (roots.length > 1 && !sameDirectory(roots[0], roots[1])) {
    out.push('Channel: unknown (OMC_PLUGIN_ROOT and CLAUDE_PLUGIN_ROOT name different directories; do not guess an updater)');
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
    out.push(
      'Channel: npm',
      'Installed: ' + (highestCached(cacheDirOf('omc')) || '(none)'),
      'Updater: omc update',
    );
  } else {
    for (const [id, entries] of supported) {
      const market = marketplaceOf(id);
      // The entries the session runs: those whose install holds an existing plugin root. Without a match all count.
      const active = entries.filter((entry) =>
        entryInstallPaths(market, entry).some((target) => roots.some((root) => isInside(root, target))),
      );
      const versions = (active.length ? active : entries)
        .map((entry) =>
          typeof entry.version == 'string' && entry.version.trim() ? dropV(entry.version.trim()) : installPathVersion(entry),
        )
        .filter(Boolean)
        .sort(compareVersions);
      // The latest version is the one the marketplace clone advertises, when it is a semver.
      let latest = null;
      try {
        const manifest = JSON.parse(
          readFile(path.join(configDir, 'plugins', 'marketplaces', market, '.claude-plugin', 'marketplace.json')),
        );
        const found = Array.isArray(manifest.plugins) ? manifest.plugins.find((x) => x && x.name == 'oh-my-claudecode') : null;
        latest = found && typeof found.version == 'string' ? semver(found.version) || null : null;
      } catch {}
      const installed = versions.length ? versions[versions.length - 1] : active.length ? '' : highestCached(cacheDirOf(market));
      out.push(
        'Plugin: ' + id,
        'Channel: marketplace ' + market,
        'Installed: ' + (installed || '(none)'),
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
const claudeMdOptOut = () => {
  let off = false;
  try {
    off = JSON.parse(readFile(path.join(configDir, '.omc-config.json'))).claudeMdEnabled === false;
  } catch {}
  console.log(off ? 'CLAUDE.md management disabled by claudeMdEnabled: false' : 'CLAUDE.md management enabled');
};

// The OMC version marker of CLAUDE.md (or its companion file) against the newest plugin cache version.
const claudeMdVersion = () => {
  const markets = registryMarketplaces();
  // Only regular files are read (readFile), so a FIFO or a directory in place of one is skipped like a missing file.
  // The candidate files, in order: CLAUDE.md, the CLAUDE-*.md file it references, otherwise CLAUDE-omc.md and then
  // every CLAUDE-*.md of the config directory in name order.
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
    if (fs.existsSync(defaultCompanion)) candidates.push(defaultCompanion);
    try {
      const others = fs
        .readdirSync(configDir)
        .filter((name) => /^CLAUDE-.*[.]md(?![^])/i.test(name))
        .sort()
        .map((name) => path.join(configDir, name));
      for (const other of others) {
        if (candidates.includes(other) === false) candidates.push(other);
      }
    } catch {}
  }
  // The first candidate that carries the marker decides.
  let claudeVersion = '(missing)';
  let claudeSource = '(none)';
  for (const file of candidates) {
    try {
      const marker = readFile(file).match(/<!--\s*OMC:VERSION:([^\s]+)\s*-->/i);
      if (marker) {
        claudeVersion = marker[1];
        claudeSource = file;
        break;
      }
    } catch {}
  }
  if (claudeVersion === '(missing)' && candidates.length > 0) {
    claudeVersion = '(missing marker)';
    claudeSource = 'scanned deterministic CLAUDE sources';
  }
  // The newest version in the cache of each marketplace the registry names; the last one that has a version wins.
  let pluginVersion = '(none)';
  for (const market of markets) {
    try {
      const names = fs.readdirSync(cacheDirOf(market)).filter(isVersionDir).sort(compareVersions);
      pluginVersion = names.length ? names[names.length - 1] : pluginVersion;
    } catch {}
  }
  console.log('CLAUDE.md OMC version:', claudeVersion);
  console.log('OMC version source:', claudeSource);
  console.log('Latest cached plugin version:', pluginVersion);
  if (claudeVersion === '(missing)' || claudeVersion === '(missing marker)' || pluginVersion === '(none)') {
    console.log('VERSION CHECK SKIPPED: missing CLAUDE marker or plugin cache');
  } else if (dropV(claudeVersion) === dropV(pluginVersion)) {
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
      const names = fs.readdirSync(cacheDirOf(market)).filter(isVersionDir);
      console.log(lead + names.length + ' version(s):', names.join(', '));
    } catch {
      console.log(lead + '0 versions');
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
const windowsPath = (target) => /^(?:[A-Za-z]:[/\\]|\\\\)/.test(target);
const foreignPath = (target) => process.platform != 'win32' && windowsPath(target);
const relativePath = (target) => !path.isAbsolute(target) && !windowsPath(target);
const readRegistry = () => {
  let unreadable = false;
  let reason = '';
  let pins = [];
  let other = [];
  let ids = [];
  try {
    const json = JSON.parse(readFile(registryFile));
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
    unreadable = !(error && error.code == 'ENOENT');
    if (unreadable && !reason) reason = 'the file is not a regular file or not JSON of the expected shape';
  }
  return { unreadable, reason, pins, other, ids };
};

// == occupancy records ==
// A record is ignored only when its owner is proven gone: the process does not exist, on Linux its start time
// differs from the recorded one, or the record is dated more than 5 minutes in the future.
const ownerGone = (record) => {
  if (Number.isSafeInteger(record.pid) && record.pid > 0) {
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
  return typeof record.updatedAt == 'string' && Date.parse(record.updatedAt) - Date.now() > 300000;
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
// protectionOf(dir, versions) reads every source of protection again and returns { unreadable, reason, noIdentity,
// pinned, kept }: unreadable (with the reason, when the registry names one) and noIdentity stop the command, pinned
// are the versions the registry pins (or a path of a pin reaches), kept are all protected versions. dir is the cache
// directory and versions the version directory names in it.
const protectionOf = (dir, versions) => {
  let unreadable = false;
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
  // win32 only: the SessionStart publisher stores the plugin root of a record in lower case.
  const isUnderLowercase = (target, parent) => {
    if (process.platform != 'win32') return false;
    target = path.resolve(target).toLowerCase();
    parent = path.resolve(parent).toLowerCase();
    return target === parent || target.startsWith(parent + path.sep);
  };
  const realDir = chainOf(dir).pop();
  // The plugin root variables: two different existing directories cannot be told apart from a conflict.
  const rootVars = [process.env.OMC_PLUGIN_ROOT, process.env.CLAUDE_PLUGIN_ROOT]
    .map((root) => (root || '').trim())
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
    if (path.resolve(first) != path.resolve(second) && !(identityOf(first) && identityOf(first) == identityOf(second))) unreadable = true;
  }
  const registry = readRegistry();
  unreadable = unreadable || registry.unreadable;
  let names = [];
  try {
    names = fs.readdirSync(occupancyDir);
  } catch (error) {
    unreadable = unreadable || !(error && error.code == 'ENOENT');
  }
  // The plugin roots of the records of running sessions.
  const held = [];
  for (const name of names) {
    if (name.length == 69 && /^[a-f0-9]{64}[.]json/.test(name)) {
      try {
        if (!fs.lstatSync(path.join(occupancyDir, name)).isFile()) continue;
        const record = JSON.parse(fs.readFileSync(path.join(occupancyDir, name), 'utf8'));
        if (ownerGone(record)) continue;
        if (typeof record.pluginRoot != 'string' || !record.pluginRoot.trim()) throw 0;
        held.push(record.pluginRoot, path.resolve(record.pluginRoot));
      } catch (error) {
        if (!(error && error.code == 'ENOENT')) unreadable = true;
      }
    }
  }
  // The paths that pin: the directory of every pinned version (as written and without a leading v) that exists or
  // may exist, and every installPath of a pin.
  const pinPaths = [];
  for (const pin of registry.pins) {
    const version = pin.version?.trim();
    for (const name of version ? [...new Set([version, dropV(version)])] : []) {
      const listed = versions.find((x) => x === name);
      const written = dir + path.sep + name;
      if (listed) pinPaths.push(path.join(dir, listed));
      else if (identityOf(written) || lacksIdentity(written)) pinPaths.push(written);
    }
    if (pin.installPath != undefined) pinPaths.push(...bothForms(pin.installPath.trim()));
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
  return { unreadable, reason: registry.unreadable ? registry.reason : '', noIdentity, pinned, kept };
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
  // the whole command has to stop.
  let moveStarted = false;
  const cleanCache = (market, dir, lead) => {
    let moved = 0;
    let skipped = 0;
    let fresh = 0;
    let future = 0;
    let unjudged = 0;
    try {
      const versions = fs.readdirSync(dir).filter(isVersionDir);
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
      if (state.kept.length) {
        console.log(lead + 'Kept protected cache versions (pinned in installed_plugins.json or in use by a running session):', state.kept.join(', '));
      }
      if (state.pinned.length && free.length) {
        moveStarted = true;
        fs.mkdirSync(backups, { recursive: true });
        free.forEach((name) => {
          let newest;
          try {
            newest = newestChange(path.join(dir, name));
          } catch (error) {
            unjudged++;
            return;
          }
          if (newest - Date.now() > FUTURE_MS) {
            future++;
            return;
          }
          if (Date.now() - newest < FRESH_MS) {
            fresh++;
            return;
          }
          // Everything is read again just before the move: a version that became protected is skipped.
          const again = protectionOf(dir, versions);
          if (again.unreadable || again.noIdentity || !again.pinned.length || again.kept.includes(name)) {
            skipped++;
            return;
          }
          fs.renameSync(path.join(dir, name), path.join(backups, (market == 'omc' ? '' : market + '-') + name + '-' + Date.now()));
          moved++;
        });
        console.log(lead + 'Moved', moved, 'unprotected version(s) to', backups + messages.movedEnd);
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
      } else {
        console.log(lead + (state.pinned.length ? messages.allProtected : messages.noPin));
      }
    } catch (error) {
      const code = error && error.code;
      const text =
        lead +
        (moveStarted
          ? 'Cache move failed (' + moved + ' moved before the error): ' + error.message
          : code == 'ENOENT'
            ? messages.noCache + (market == 'omc' ? '' : ' in plugins/cache/' + market)
            : 'Nothing moved: could not read ' + dir + ' (' + (code || 'unknown error') + ')');
      // A missing cache is nothing to clean, not a failure; a failed move or an unreadable directory is.
      if (moveStarted || code != 'ENOENT') refuse(text);
      else console.log(text);
      return true;
    }
    return false;
  };
  // Every cache directory that exists (or cannot be told from one) is handled in turn; with none the first
  // marketplace is still tried, so that a missing cache is reported.
  const registry = readRegistry();
  const markets = registry.ids.length ? [...new Set(registry.ids.map(marketplaceOf))] : ['omc'];
  const caches = markets
    .map((market) => [market, cacheDirOf(market)])
    .filter(([, dir]) => {
      try {
        fs.statSync(dir);
        return true;
      } catch (error) {
        return !(error && error.code == 'ENOENT');
      }
    });
  if (!caches.length) caches.push([markets[0], cacheDirOf(markets[0])]);
  if (registry.unreadable) refuse(stopUnreadable(registry.reason));
  else {
    for (const [market, dir] of caches) {
      if (cleanCache(market, dir, caches.length > 1 ? market + ': ' : '')) break;
    }
  }
  if (messages.footer) console.log(messages.footer);
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
};
const name = process.argv[2];
if (Object.hasOwn(COMMANDS, name)) {
  COMMANDS[name]();
} else {
  console.error('omc-doctor.mjs: unknown command ' + JSON.stringify(name) + '; use one of ' + Object.keys(COMMANDS).join(', '));
  process.exitCode = 2;
}
