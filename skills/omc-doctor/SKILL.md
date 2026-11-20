---
name: omc-doctor
description: Diagnose and fix oh-my-claudecode installation issues
level: 3
---

# Doctor Skill

Note: All `~/.claude/...` paths in this guide respect `CLAUDE_CONFIG_DIR` when that environment variable is set. Surrounding spaces are ignored and an empty value means `~/.claude`. A value that is `~`, or starts with `~/` or `~\`, means the home directory (OMC's runtime reads it that way; the shell does not expand a `~` stored in a variable), and a `~` anywhere else is literal. The `node -e` commands below expand it with one shared expression and each shell block starts with the same expansion line; expand a path you read or write yourself the same way. A `..` in the value is folded as text, as the runtime does, in the commands and in the shell blocks alike (a path that goes through a link and then `..` names the parent of the link, not of its target). Run every `node -e` command exactly as written, whole and in one Bash call: its lines belong together, and the sections headed `// == <name> (shared) ==` are copies of the same text in every command that needs them. Run every shell block whole too, in one Bash call: the tool keeps no variable from one call to the next, so a line that uses `$C` alone, without the first line of its block that sets it, sees an empty value.

## Task: Run Installation Diagnostics

You are the OMC Doctor - diagnose and fix installation issues.

### Step 1: Check Plugin Version

```bash
# Get the plugin ID, install channel (marketplace, plugin-dir or npm), installed version, the channel's latest version and its updater (cross-platform)
node -e "
// omc-doctor Step 1: which install this is (marketplace, plugin-dir, npm or unknown), its installed version, the
// latest version of its own channel and the command that updates it. Prints one block of lines per plugin.
// == config dir (shared) ==
// CLAUDE_CONFIG_DIR expanded like getClaudeConfigDir() in scripts/lib/config-dir.mjs: surrounding spaces are
// ignored, an empty value means the .claude directory of the home directory, a value that is ~ or starts with ~/ or
// ~ and a backslash means the home directory, and any other value is used as given, normalized as text like the
// runtime does (a .. after a link folds the link away, a ~ anywhere else is literal).
const path = require('path');
const fs = require('fs');
const home = require('os').homedir();
const configured = (process.env.CLAUDE_CONFIG_DIR || '').trim();
const configDir = !configured
  ? path.join(home, '.claude')
  : configured === '~'
    ? home
    : /^~[/\x5c]/.test(configured)
      ? path.join(home, configured.slice(2))
      : path.normalize(configured);
// == plugin ids (shared) ==
// The plugin IDs the installer accepts (OMC_PLUGIN_IDS in src/installer/index.ts), compared in lower case.
const OMC_IDS = ['oh-my-claudecode@omc', 'oh-my-claudecode', 'oh-my-claudecode@oh-my-claudecode'];
// The marketplace of a plugin ID: the part after the @ in lower case, omc for the bare ID.
const marketplaceOf = (id) => {
  const lower = id.toLowerCase();
  return lower.includes('@') ? lower.slice(lower.indexOf('@') + 1) : 'omc';
};
// The plugin cache directory of a marketplace.
const cacheDirOf = (market) => path.join(configDir, 'plugins', 'cache', market, 'oh-my-claudecode');
// == version grammar (shared) ==
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
// == version order (shared) ==
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
// == read file (shared) ==
// Reads a regular file only: a FIFO or another special file is never opened, so a read cannot hang.
const readFile = (file) => {
  if (!fs.statSync(file).isFile()) throw 0;
  return fs.readFileSync(file, 'utf8');
};
// == registry entry shape (shared) ==
// An entry of installed_plugins.json is malformed unless it has a non-blank string version or installPath
// (a null field counts as missing, a non-string or blank one is malformed).
const entryShapeBad = (entry) => {
  const fields = [entry?.version, entry?.installPath];
  return (
    fields.every((field) => field == undefined) ||
    fields.some((field) => field != undefined && (typeof field != 'string' || !field.trim()))
  );
};
// == path resolver (shared) ==
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

// == readers ==
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
  const last = installPath.split(/[\x5c/]+/).filter(Boolean).pop() || '';
  return (isVersionDir(last) && semver(last)) || manifestVersion(installPath);
};
// A malformed entry. strict is for an entry of a supported plugin ID: its version has to be a semver, and an entry
// that has only an installPath must not name a version that is not one.
const entryBad = (entry, strict) =>
  entryShapeBad(entry) ||
  (!!strict && (entry.version != undefined ? !semver(entry.version) : installPathVersion(entry) === null));

// == directories and identity ==
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

// == registry ==
// supported: [key, entries] of the supported plugin IDs. unreadable: the file is not usable. malformed: a
// supported ID has an unusable entry list. ambiguous: another key could be an OMC install (a look-alike key, an
// empty or non-array list, a malformed entry), so npm cannot be assumed.
// Limits kept on purpose, because the installer reads the registry the same way (resolveInstalledOmcPluginRoots in
// src/installer): an installPath is used as written (a relative one is not resolved against the configuration
// directory), scope and projectPath are not read (every entry of a supported ID counts, so the highest version is
// Installed, whichever project it was installed for), and two spellings of one plugin ID are two plugins that print
// a block each. The Updater line carries no CLAUDE_CONFIG_DIR: run it in the environment that holds the profile.
let unreadable = false;
let malformed = false;
let ambiguous = false;
const supported = [];
try {
  const json = JSON.parse(readFile(path.join(configDir, 'plugins', 'installed_plugins.json')));
  const plugins = json ? json.plugins ?? json : 0;
  if (!plugins || typeof plugins != 'object' || Array.isArray(plugins)) throw 0;
  for (const [key, entries] of Object.entries(plugins)) {
    const lower = key.toLowerCase();
    if (OMC_IDS.includes(lower)) {
      supported.push([key, entries]);
      if (!Array.isArray(entries) || !entries.length || entries.some((entry) => entryBad(entry, true))) malformed = true;
      continue;
    }
    if (!Array.isArray(entries) || !entries.length || lower.includes('oh-my-claudecode')) ambiguous = true;
    else if (entries.some((entry) => entryBad(entry, false))) ambiguous = true;
  }
} catch (error) {
  unreadable = !(error && error.code == 'ENOENT');
}

// == plugin roots ==
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

// == output ==
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
  for (const [key, entries] of supported) {
    const market = marketplaceOf(key);
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
      'Plugin: ' + key,
      'Channel: marketplace ' + market,
      'Installed: ' + (installed || '(none)'),
      'Latest: ' + (latest || '(unavailable)') + ' (marketplace clone)',
      'Updater: claude plugin marketplace update ' + market + ' && claude plugin update ' + key,
    );
  }
}
for (const line of out) console.log(line);
"
# npm latest: for a Channel: npm install only; a marketplace channel's latest is its own Latest: line above, never this one
node -e "
// omc-doctor Step 1, npm channel only: the latest version of the npm package, or (unavailable).
// == version grammar (shared) ==
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

// == npm latest ==
// npm view gets 20 seconds: it normally answers in a few, and a hanging network must not stall the diagnosis. Only a
// semantic version of the grammar above is an answer; an error, a timeout or anything else on stdout is
// (unavailable), never a bare string.
const { spawnSync } = require('child_process');
const view = ['view', 'oh-my-claude-sisyphus', 'version'];
const options = { encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL' };
// npm is a .cmd file on Windows, which only a shell can start.
const run =
  process.platform == 'win32' ? spawnSync('npm ' + view.join(' '), { ...options, shell: true }) : spawnSync('npm', view, options);
const latest = run.status === 0 ? semver(run.stdout) : '';
console.log('npm latest: ' + (latest || '(unavailable)'));
"
```

**Diagnosis**:
- Read the `Channel:` line of each plugin before any rule below: it decides what that plugin's other lines mean, and a rule that reads `Installed:`, `Latest:` or `Updater:` applies only to the channels it names. `Channel: unknown` prints none of the three lines (none of them is missing). `Channel: plugin-dir` is a loaded checkout: it has no install record and no update channel, its `Installed:` is whatever version the checkout's own files hold, and `Latest: (unavailable)` and `Updater: none` are fixed answers, not failed checks. `Channel: npm` and `Channel: marketplace` are installs, so `Installed: (none)` means nothing is installed
- If no version installed (`Installed: (none)` under `Channel: npm` or `Channel: marketplace`, never under `Channel: plugin-dir`): CRITICAL - plugin not installed
- If `Channel: unknown`: CRITICAL - the install channel cannot be established, so the install cannot be diagnosed. Step 1 reads `installed_plugins.json` by the rules of the cache commands below: it must be a regular file (a FIFO is never opened) holding valid JSON, and every entry list under a supported plugin ID must be a non-empty array of entries that each have a non-blank string `version` or `installPath`, and a `version` there must be a semantic version of the grammar of the `Latest:` line below (`999x.0.0`, `1.2` and `1.2.3.4` are not), as must be the version an entry that has only an `installPath` gets from it when that path names one (the version `package.json` or `.claude-plugin/plugin.json` holds there); a `version` of an entry under another plugin's key is not an OMC version and has to be a non-blank string only; otherwise the channel is unknown (an existing `OMC_PLUGIN_ROOT` that is not a registry install answers first, see the next item). It is unknown too when the registry has no supported plugin ID but holds an empty or non-array entry list under some key, a malformed entry in a list under some other key (the rule of the cache commands, stricter than the installer's resolver, which skips the entries of other plugins: `null`, not an object, a nested array, neither field, or a blank or non-string one; a `null` field counts as missing), or a look-alike key such as `oh-my-claudecode-fork` (the installer's resolver calls that ambiguous, so npm is not assumed from it), unless `OMC_PLUGIN_ROOT` or `CLAUDE_PLUGIN_ROOT` names the active checkout (next item); and when the two variables name different existing directories (two spellings of one directory are one directory, compared by filesystem identity, and two directories whose names differ only in letter case are two directories on a volume that tells letter case apart; a variable that names no existing directory is ignored, see the next item), whatever the registry holds. Say so, name no updater and do not compare versions
- If `Channel: plugin-dir`: the session loads the checkout named by `OMC_PLUGIN_ROOT` (or `CLAUDE_PLUGIN_ROOT`). A variable whose path is not an existing directory names no checkout (the runtime wrapper skips it and falls through to the managed cache; it skips an existing root without a built HUD too, which Step 1 does not test), so Step 1 ignores it everywhere: it makes no plugin-dir install, no conflict and no channel, and an npm or marketplace install is diagnosed as if the variable were unset. `OMC_PLUGIN_ROOT` is the explicit override, the highest-priority root of the runtime resolution (`omc --plugin-dir` sets it; the runtime skips a root that does not exist), so Step 1 takes an existing one before the registry's channel, whatever the registry holds (a stale supported entry or a registry that cannot be read included), unless it names the install a supported entry pins: its `installPath`, or the cache directory `plugins/cache/<marketplace>/oh-my-claudecode/<version>` that its `version` names, compared by filesystem identity (by exact text where the file system reports inode 0) so that a link counts, and a letter-case alias counts where the volume ignores letter case. Every path Step 1 compares or reads (the variables, an `installPath`, a pinned version's directory) is resolved in the order the file system reads its components, so `<dir>/shortcut/..` with `shortcut` pointing to `5.9.0/nested` names `5.9.0`, the parent of the link's target, and not `<dir>`, the folder that holds the link (on win32 `..` is folded as text first, as Windows does). That is the registry's own install and the registry decides its channel. Where a directory lies excuses nothing else: another cache version than the pinned one (cache `5.7.0` while the registry pins `5.8.0`), a directory in the cache of another plugin and a path below a version are explicit roots like any other, so Step 1 reports `Channel: plugin-dir` for them, and the cache commands still keep that directory protected. Only when the registry cannot be read completely, a root inside `plugins/cache/` cannot be told from the pinned install, and Step 1 then says `Channel: unknown`. `CLAUDE_PLUGIN_ROOT` is only a locator (Claude Code sets it for marketplace installs too), so it names the checkout only when the registry parses and holds no supported plugin ID (a malformed entry under another key does not make it unreadable here). `Installed:` is the version in that checkout's `package.json` or `.claude-plugin/plugin.json` (`(none)` means it has neither, or that the version it holds is not a semantic version of that grammar, or that reading it failed), there is no channel latest, so no outdated WARN, and the `npm latest:` line is ignored. `Installed: (none)` here is an unknown version of a checkout the session is running, not a missing install: it is never `CRITICAL - plugin not installed`, the Plugin Version check is OK with the detail `plugin-dir checkout, version unknown`, and the report names the checkout (`Plugin root:`) and does not call the plugin absent
- LATEST comes from the install channel the registry records, never from a fixed source: for `Channel: marketplace` it is the `Latest:` line the command prints (the version in that marketplace clone, accepted only when it is a semantic version in the grammar of the runtime's `parseSemver` in `scripts/session-start.mjs`: optional leading `v`, three numeric parts without leading zeros, optional prerelease and build metadata; Step 1 drops the `v`, and anything else, such as `999x.0.0`, `1.2`, `1.2.3.4` or `01.2.3`, is `Latest: (unavailable)`, which no update is recommended from), and `npm view` (the `npm latest:` line, printed by a command of its own that gives npm 20 seconds) is consulted only for `Channel: npm`, so ignore that line for a marketplace install. Only a latest version is a target an update is recommended to, so only a latest version must be a semantic version of that grammar: an `npm latest:` value that is not one is a damaged answer and counts as `(unavailable)`: the command itself prints `(unavailable)` for an error, a timeout or a value that is not one, so the line is never a bare string. The versions that report what is installed (a registry `version`, a cache directory name, the `version` of a checkout's `package.json` or `.claude-plugin/plugin.json`) are shown as recorded and ordered by the rule below, and are never a target. A version a user's data claims, a registry `version` under a supported plugin ID or the `version` of a `package.json` or `plugin.json`, must be a semantic version of that same grammar (one definition, `semver`, in the shared version grammar section of Step 1, Step 4, Step 6 and both cache commands) before it is ordered, because the order ranks a core that is not numeric above the numeric ones: an entry whose `version` is not one is a damaged registry (`Channel: unknown`, no update recommended, nothing moved by the cache commands), and a checkout whose `version` is not one has none (`Installed: (none)`). A cache directory is a version directory only when its name is exactly a semantic version of that grammar (without a `v` and without spaces): Step 1, Step 4, Step 6 and the cache commands take no other name for a version, so `1e3`, `4.15.7L` or `v5.7.0` takes no part in the order, is not counted and is never moved (the runtime reads such a name as 0 or below, never as the newest), and for an entry that has only an `installPath` the last component of the path names the version only when it is one of that grammar (otherwise its `package.json` is read). A marketplace install is never compared with an npm-only release, because the marketplace update cannot install one. If Step 1 lists several plugin IDs, judge each against its own `Latest:` line
- Order versions as semantic versions, never as text: numeric parts compare as numbers of any size (`5.10.0` is newer than `5.9.0`, and `5.1000000000000000000000.0` is newer than `5.999999999999999999999.0`: the commands compare digit strings, leading zeros dropped, the longer one is the larger number and equal lengths compare as text, because a number past 2^53 is not exact) and a prerelease is older than the stable release it precedes (`5.9.0-beta` is older than `5.9.0`, `5.9.0-beta.2` is older than `5.9.0-beta.10`). `Installed:` is the highest version in that order, among the registry entries of a plugin ID (among the cache versions of its marketplace when no entry of it names a version) or, for the npm channel, among the cache versions, and the `Latest cached plugin version` of Step 4 is chosen the same way. Steps 4 and 6 read the cache of the marketplace Step 1 names (`plugins/cache/<marketplace>/oh-my-claudecode`, where `<marketplace>` is the part after the `@` of each supported plugin ID the registry holds: `omc` for the bare `oh-my-claudecode`, and when the registry holds none or cannot be read); with several IDs Step 4 takes the last one whose cache holds a version and Step 6 prints one line per marketplace, led by its name. A directory named `<version>.omc-stale-<pid>` (what an interrupted cache relink leaves) is no version in Step 1, Step 4, Step 6 or the cache commands: none of them lists, counts, names it as the newest, dates or moves it. When a plugin ID has entries for several scopes and `OMC_PLUGIN_ROOT` or `CLAUDE_PLUGIN_ROOT` names an existing directory that is the `installPath` of some of them or lies inside it (compared by filesystem identity), `Installed:` comes from those entries alone, because the session runs that install and not a newer entry of another scope; if they name no version it is `(none)`, never the highest of the others or of the cache. Two names that are the same version in that order (`5.9` and `5.9.0`, or build metadata only) are told apart by their text, so the choice does not depend on the order of the directory listing. A leading `v` is dropped in one place (`dropV`), everywhere a version is compared, validated or named: `v5.8.0` and `5.8.0` are one version, as in the runtime (`parseSemver` in `scripts/session-start.mjs` and `parseVersion` in `src/utils/semver-compare.ts` both accept the optional `v`), so with the registry entries `v5.8.0` and `5.9.0` in different scopes `Installed:` is `5.9.0`. Step 1 prints the bare form on the `Installed:` line as it does on the `Latest:` line, which is how the runtime shows a version (its update notice writes `v` in front of a bare one). A cache directory is named by the bare version, so a version `v5.8.0` recorded in the registry names the directory `5.8.0`, and Step 4 compares the `OMC:VERSION` marker with the cached version without the `v` of either
- If INSTALLED is older than LATEST on the channel's own latest (same order): WARN - outdated plugin (it is updated through the `Updater:` line Step 1 printed for that plugin ID, see "Fix: Outdated Plugin"; the cache commands only clean up and never update it). If INSTALLED equals the channel's latest, there is no WARN, and there is none when it is newer than that latest either. If `Latest: (unavailable)` on a marketplace channel or `npm latest: (unavailable)` on the npm channel: report that the latest version could not be checked, not a WARN
- If multiple versions exist: WARN - stale cache

### Step 2: Check for Legacy Hooks in settings files

Read the profile-level `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json` and the primary working directory's `.claude/settings.json`, then resolve every project-local settings file Claude Code may read before checking hooks. In a normal checkout, inspect the repository-root `.claude/settings.local.json`. In a linked Git worktree, inspect the main checkout root's `.claude/settings.local.json`, not just the linked worktree's file; identify the main checkout with `git worktree list --porcelain`. On Windows, and whenever Claude Code keeps the local file beside the shared `.claude/settings.json`, inspect `.claude/settings.local.json` beside that shared settings file, including in a worktree. Also inspect any starting-directory `.claude/settings.local.json` left by Claude Code versions before 2.1.211; Claude Code can still read it alongside the root file. Deduplicate identical paths. If the main checkout root or any applicable local settings file cannot be resolved or read, treat settings and script references as inconclusive and do not remove hooks or scripts. Check whether any applicable file has a `"hooks"` key with entries like:
- `bash ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/keyword-detector.sh`
- `bash ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/persistent-mode.sh`
- `bash ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/session-start.sh`
- `bash ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/stop-continuation.sh`
- `bash ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/silent-auto-update.sh`

Also recognize standalone Node hook registrations under the active config directory's `hooks/` folder: `.mjs` files named `keyword-detector`, `persistent-mode`, `session-start`, `session-end`, `pre-tool-use`, `post-tool-use`, `post-tool-use-failure`, `code-simplifier`, or `stop-continuation`. For the historical `keyword-detector`, `persistent-mode`, `session-start`, and `stop-continuation` basenames, `.cjs` and `.js` variants are legacy too. For example, `node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/keyword-detector.mjs"` is a legacy registration. On Windows, recognize paths such as `node "%USERPROFILE%\.claude\hooks\keyword-detector.mjs"` and `%CLAUDE_CONFIG_DIR%\hooks\<filename>` (or their expanded absolute equivalents) with backslash separators as the same active config directory. Match only exact listed filenames invoked with `node` from that directory; do not match plugin-root commands or similarly named scripts in other directories.

A command is an auto-fix candidate only when it is a plain direct invocation of exactly one listed file: `bash <exact .sh path>`, `node <exact Node path>`, or the exact executable script path alone when the target has execute permission (for example, `$HOME/.claude/hooks/keyword-detector.sh`). No form may include extra arguments, shell operators, or other commands. If a command merely mentions the path, adds custom behavior (for example, `bash legacy.sh && run-my-check`), or cannot be parsed unambiguously, report it for manual cleanup and leave the hook object unchanged.

Before diagnosing a standalone registration as a duplicate, resolve plugin enablement with the runtime's precedence: managed and command-line settings first (read-only), then every applicable project-local settings file resolved above, then the primary working directory's `./.claude/settings.json`, then `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`. Include the main-checkout, Windows side-by-side, and legacy starting-directory local paths when they apply. For duplicate keys between the root local file and a pre-2.1.211 starting-directory file, the root local value wins; never ignore a `false` from the effective local file or fall through to a project/profile `true`. The first scope that explicitly mentions any supported OMC ID decides; unmentioned scopes are transparent. The supported marketplace IDs are `oh-my-claudecode`, `oh-my-claudecode@omc`, and `oh-my-claudecode@oh-my-claudecode`. When the current session loads OMC from an inline source such as `--plugin-dir`, `--plugin-url`, or `CLAUDE_CODE_PLUGIN_DIRS`, also consider `oh-my-claudecode@inline` only after the active root's `.claude-plugin/plugin.json` has `"name": "oh-my-claudecode"` and the session source confirms that root is loaded. Treat that inline plugin as active for the session unless its manifest sets `"defaultEnabled": false` or an applicable settings source disables it; an explicit applicable `true` overrides the manifest default. `CLAUDE_PLUGIN_ROOT` is only a locator, not proof that a plugin is enabled; an explicit effective `false` always blocks automatic removal. Within each scope, `enabledPlugins` is canonical, and legacy `plugins` is consulted only if `enabledPlugins` does not mention any supported OMC ID. Thus a canonical `false` overrides a stale legacy `true`, and a higher-precedence `false` overrides any lower-precedence `true`. If applicable local sources conflict and the effective value cannot be determined, supported IDs in the winning field conflict, a relevant file is unreadable or malformed, or no effective enabled result can be established, treat plugin activity as inconclusive and do not auto-remove. Inspect every hook source for the active root read-only: the optional `.claude-plugin/plugin.json` `hooks` field accepts a path, an inline hooks object, or an array mixing paths and inline objects; resolve declared file paths relative to the plugin root and include `hooks/hooks.json` when present. A malformed, unreadable, or unresolved declared source makes event ownership inconclusive. A cached plugin version is insufficient. Also resolve the standalone script file and compare its bytes or SHA-256 with the shipped OMC payload for that exact filename; for historical `.sh` files, use the versioned fingerprints below. A matching name or path alone does not prove ownership. If the plugin is inactive, does not provide that event, no payload or fingerprint exists, the target cannot be read, or the content differs, treat the entry as potentially user-owned and do not recommend removal.

For known standalone payloads, verify the expected plugin event as well as the payload identity. The known OMC filename-to-event mapping is:

| Standalone payload basename | Canonical plugin event |
|---|---|
| `keyword-detector` | `UserPromptSubmit` |
| `session-start` | `SessionStart` |
| `session-end` | `SessionEnd` |
| `pre-tool-use` | `PreToolUse` |
| `post-tool-use` | `PostToolUse` |
| `post-tool-use-failure` | `PostToolUseFailure` |
| `persistent-mode`, `stop-continuation`, `code-simplifier` | `Stop` |

For a historical payload, verify its event mapping from that version's trusted manifest or installer source; if unavailable, leave it for manual review. The active plugin must provide the canonical or specifically verified equivalent handler under the registration's event, and that handler must replace the payload's behavior. Merely finding any plugin handler for that event is insufficient. For example, a `session-start` script registered under `Stop` is not a duplicate even if the active plugin defines unrelated `Stop` handlers. If event or behavior equivalence is uncertain, preserve the hook and script.

The tracked historical OMC Bash-hook payload fingerprints (SHA-256) are:
- `keyword-detector.sh`: `abe4dd5e4b16231060166264d271a51e781f08a31c6aa402b26976f9c40d424e` (`96266316`), `748463911b2a8b7fffed51137c9731c962b656d490a1e4b27ef7ab10dbbbaff5` (`3a02feb1`), `1eaced21774916c31bec5b149a87009d014ffd8027ecf8e9d6ae6a36bdd79a40` (`bef486f1`)
- `persistent-mode.sh`: `c131c6846573f0f69b6e39aed1e6db8f05279131a8976f604c1511a46f564ce5` (`96266316`), `219e50bf42b7a7a0e52fb142844dce21faca7c327d9acf346fa70f074ac982ac` (`3a02feb1`), `02f4d0d63a9ce092fe5be02ce6e79f275710b773d4b8d75ff33f272540451eff` (`bef486f1`)
- `session-start.sh`: `d87571c326c43cc43b6948aca661a9616faa6943cfe1d1131f482bd30f638134` (`96266316`), `a9607c64a14d9f8e9fa990b9f38879ef095d85652f548b1232e28d14641214eb` (`3a02feb1`), `cf7aa2b008829784c8942766c3f00d348ef33a1aab66dd3f96536e95560fd56b` (`bef486f1`)
- `stop-continuation.sh`: `f74deb67479c7861b0966bc959ffd3917152b8872ac83d9243a03c7cb707b51f` (`96266316`)

No tracked OMC payload fingerprint is available for `silent-auto-update.sh` or historical `.js`/`.cjs` variants. Treat those files as ownership-inconclusive; do not automatically remove their hook registrations or files.

For Node hooks, compare against the active plugin payload, any validated retained package under `${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/cache/omc/oh-my-claudecode/<version>/` (`omc` is the marketplace of the legacy and the bare plugin ID; for another supported ID it is the part after the `@`, as Step 1 derives it), and the adjacent `node-hook-fingerprints.json` index. The index records SHA-256 fingerprints with exact stable release-tag provenance for every shipped Node module under `templates/hooks/**/*.mjs`, including hook helpers; search by payload path and inspect only that block rather than loading the entire index. If it is missing, malformed, or has no matching fingerprint, leave the entry for manual review. Preserve these additional trusted historical `keyword-detector.mjs` fingerprints from commits not necessarily represented by a release tag: `22d612620f54f360797e42fe608bf7f98155b92a3b0bba187fd89e216395d65a` (`fb125b37`), `180fc09840baa8ada1661bcc5a13821c9ca802f43ac52cb4e517ca2cba75838a` (`387956a4`), and `71a01806c1b0e29d8e553797de3900b7172654091980ae644d74e5e9291b8af2` (`0b46a595`).

**Diagnosis**:
- If a direct command is verified as OMC-owned and the active plugin provides the payload's canonical or specifically verified equivalent handler under the registration's event: CRITICAL - duplicate legacy hook
- If a composite or ambiguous command mentions a legacy path: WARN - manual cleanup required; never remove it automatically
- If the plugin is inactive, does not provide the event, or ownership cannot be verified: WARN - standalone hook may be active or user-owned; do not recommend removal

### Step 3: Check for Legacy Bash Hook Scripts

```bash
C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; C=${C#"${C%%[![:space:]]*}"}; C=${C%"${C##*[![:space:]]}"}; case "$C" in '') C=$HOME/.claude;; '~') C=$HOME;; '~/'*|'~\'*) C=$HOME/${C#??};; esac; L=$(CDPATH= cd -- "$C" 2>/dev/null && pwd -L) && C=$L
ls -la "$C"/hooks/*.sh 2>/dev/null
```

**Diagnosis**:
- If a listed script exists, call it a duplicate only when the active plugin provides the payload's canonical or specifically verified equivalent handler under the registration's event and the file matches a shipped payload or historical fingerprint; otherwise mark ownership as unknown or treat it as an active standalone hook.

### Step 4: Check CLAUDE.md

First check whether CLAUDE.md management is disabled. Read `${CLAUDE_CONFIG_DIR:-~/.claude}/.omc-config.json`; only an explicit `"claudeMdEnabled": false` disables it (missing file, missing key, or any other value means enabled).

```bash
# Check if the user opted out of global CLAUDE.md management (cross-platform; expands ~ in CLAUDE_CONFIG_DIR like getClaudeConfigDir)
node -e "const path = require('path'); const fs = require('fs'); const home = require('os').homedir(); const configured = (process.env.CLAUDE_CONFIG_DIR || '').trim(); const configDir = !configured ? path.join(home, '.claude') : configured === '~' ? home : /^~[/\x5c]/.test(configured) ? path.join(home, configured.slice(2)) : path.normalize(configured); const readFile = (file) => { if (!fs.statSync(file).isFile()) throw 0; return fs.readFileSync(file, 'utf8'); }; let off = false; try { off = JSON.parse(readFile(path.join(configDir, '.omc-config.json'))).claudeMdEnabled === false; } catch {} console.log(off ? 'CLAUDE.md management disabled by claudeMdEnabled: false' : 'CLAUDE.md management enabled');"
```

Continue with the CLAUDE.md checks below only when the probe printed exactly `CLAUDE.md management enabled`.

- If it prints `CLAUDE.md management disabled by claudeMdEnabled: false`, report that line as INFO, skip the rest of this step and the "Fix: Missing/Outdated CLAUDE.md" fix, and never create or overwrite `CLAUDE.md` or `CLAUDE-omc.md`.
- If it prints neither line, or the command fails (for example `node` is not on `PATH`, which Step 5 diagnoses), report WARN - could not check the `claudeMdEnabled` opt-out, skip the rest of this step and the "Fix: Missing/Outdated CLAUDE.md" fix, and never create or overwrite `CLAUDE.md` or `CLAUDE-omc.md`.

```bash
C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; C=${C#"${C%%[![:space:]]*}"}; C=${C%"${C##*[![:space:]]}"}; case "$C" in '') C=$HOME/.claude;; '~') C=$HOME;; '~/'*|'~\'*) C=$HOME/${C#??};; esac; L=$(CDPATH= cd -- "$C" 2>/dev/null && pwd -L) && C=$L
# Check if CLAUDE.md exists
ls -la "$C"/CLAUDE.md 2>/dev/null

# Check for OMC markers (<!-- OMC:START --> is the canonical marker)
grep -q "<!-- OMC:START -->" "$C/CLAUDE.md" 2>/dev/null && echo "Has OMC config" || echo "Missing OMC config in CLAUDE.md"

# Check CLAUDE.md (or deterministic companion) version marker and compare with latest installed plugin cache version
node -e "
// omc-doctor Step 4: the OMC version marker of CLAUDE.md (or its companion file) against the newest plugin cache version.
// == config dir (shared) ==
// CLAUDE_CONFIG_DIR expanded like getClaudeConfigDir() in scripts/lib/config-dir.mjs: surrounding spaces are
// ignored, an empty value means the .claude directory of the home directory, a value that is ~ or starts with ~/ or
// ~ and a backslash means the home directory, and any other value is used as given, normalized as text like the
// runtime does (a .. after a link folds the link away, a ~ anywhere else is literal).
const path = require('path');
const fs = require('fs');
const home = require('os').homedir();
const configured = (process.env.CLAUDE_CONFIG_DIR || '').trim();
const configDir = !configured
  ? path.join(home, '.claude')
  : configured === '~'
    ? home
    : /^~[/\x5c]/.test(configured)
      ? path.join(home, configured.slice(2))
      : path.normalize(configured);
// == plugin ids (shared) ==
// The plugin IDs the installer accepts (OMC_PLUGIN_IDS in src/installer/index.ts), compared in lower case.
const OMC_IDS = ['oh-my-claudecode@omc', 'oh-my-claudecode', 'oh-my-claudecode@oh-my-claudecode'];
// The marketplace of a plugin ID: the part after the @ in lower case, omc for the bare ID.
const marketplaceOf = (id) => {
  const lower = id.toLowerCase();
  return lower.includes('@') ? lower.slice(lower.indexOf('@') + 1) : 'omc';
};
// The plugin cache directory of a marketplace.
const cacheDirOf = (market) => path.join(configDir, 'plugins', 'cache', market, 'oh-my-claudecode');
// == version grammar (shared) ==
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
// == version order (shared) ==
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
// == read file (shared) ==
// Reads a regular file only: a FIFO or another special file is never opened, so a read cannot hang.
const readFile = (file) => {
  if (!fs.statSync(file).isFile()) throw 0;
  return fs.readFileSync(file, 'utf8');
};
// == registry marketplaces (shared) ==
// The marketplaces of the supported plugin IDs in installed_plugins.json, each once, in the order of their last
// occurrence. It is omc when the registry holds none and when it cannot be read (missing, a FIFO, bad JSON).
const registryMarketplaces = (() => {
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
})();

// == CLAUDE.md sources ==
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

// == plugin cache ==
// The newest version in the cache of each marketplace the registry names; the last one that has a version wins.
let pluginVersion = '(none)';
for (const market of registryMarketplaces) {
  try {
    const names = fs.readdirSync(cacheDirOf(market)).filter(isVersionDir).sort(compareVersions);
    pluginVersion = names.length ? names[names.length - 1] : pluginVersion;
  } catch {}
}

// == output ==
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
"

# Check companion files for file-split pattern (e.g. CLAUDE-omc.md)
find "$C" -maxdepth 1 -type f -name 'CLAUDE-*.md' -print 2>/dev/null
while IFS= read -r f; do
  grep -q "<!-- OMC:START -->" "$f" 2>/dev/null && echo "Has OMC config in companion: $f"
done < <(find "$C" -maxdepth 1 -type f -name 'CLAUDE-*.md' -print 2>/dev/null)

# Check if CLAUDE.md references a companion file
grep -o "CLAUDE-[^ )]*\.md" "$C/CLAUDE.md" 2>/dev/null
```

**Diagnosis**:
- If CLAUDE.md missing: CRITICAL - CLAUDE.md not configured
- If `<!-- OMC:START -->` found in CLAUDE.md: OK
- If `<!-- OMC:START -->` found in a companion file (e.g. `CLAUDE-omc.md`): OK - file-split pattern detected
- If no OMC markers in CLAUDE.md or any companion file: WARN - outdated CLAUDE.md
- If `OMC:VERSION` marker is missing from deterministic CLAUDE source scan (base + referenced companion): WARN - cannot verify CLAUDE.md freshness
- If `CLAUDE.md OMC version` != `Latest cached plugin version`: WARN - version drift detected (run `omc update` or `omc setup`); a leading `v` on either version is ignored, as in Step 1

### Step 5: Check Ralph Runtime Prerequisites

Ralph is an agent-driven persistence loop, not a compiled program: its only hard runtime prerequisites are the Node runtime that executes OMC's hook scripts (`persistent-mode.mjs`, `keyword-detector.mjs`) and a writable config directory for `.omc/state/` state files such as `ralph-state.json`.

```bash
C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; C=${C#"${C%%[![:space:]]*}"}; C=${C%"${C##*[![:space:]]}"}; case "$C" in '') C=$HOME/.claude;; '~') C=$HOME;; '~/'*|'~\'*) C=$HOME/${C#??};; esac; L=$(CDPATH= cd -- "$C" 2>/dev/null && pwd -L) && C=$L
node --version || echo "Node for Ralph: MISSING"
mkdir -p "$C" 2>/dev/null
touch "$C/.omc-write-probe" 2>/dev/null && rm -f "$C/.omc-write-probe" && echo "Config dir writable" || echo "Config dir NOT writable"
```

**Diagnosis**:
- If Node runs and prints a version: OK - Ralph runtime prerequisite present
- If `node` is missing or fails: CRITICAL - OMC hooks and Ralph cannot run without Node (see https://nodejs.org for installers; nvm/fnm users need Node on the PATH of non-interactive shells)
- If the config dir is not writable: WARN - Ralph state persistence will fail until it is writable

### Step 6: Check for Stale Plugin Cache

```bash
# Count versions in cache (cross-platform)
node -e "
// omc-doctor Step 6: the version directories of the plugin cache, per marketplace.
// == config dir (shared) ==
// CLAUDE_CONFIG_DIR expanded like getClaudeConfigDir() in scripts/lib/config-dir.mjs: surrounding spaces are
// ignored, an empty value means the .claude directory of the home directory, a value that is ~ or starts with ~/ or
// ~ and a backslash means the home directory, and any other value is used as given, normalized as text like the
// runtime does (a .. after a link folds the link away, a ~ anywhere else is literal).
const path = require('path');
const fs = require('fs');
const home = require('os').homedir();
const configured = (process.env.CLAUDE_CONFIG_DIR || '').trim();
const configDir = !configured
  ? path.join(home, '.claude')
  : configured === '~'
    ? home
    : /^~[/\x5c]/.test(configured)
      ? path.join(home, configured.slice(2))
      : path.normalize(configured);
// == plugin ids (shared) ==
// The plugin IDs the installer accepts (OMC_PLUGIN_IDS in src/installer/index.ts), compared in lower case.
const OMC_IDS = ['oh-my-claudecode@omc', 'oh-my-claudecode', 'oh-my-claudecode@oh-my-claudecode'];
// The marketplace of a plugin ID: the part after the @ in lower case, omc for the bare ID.
const marketplaceOf = (id) => {
  const lower = id.toLowerCase();
  return lower.includes('@') ? lower.slice(lower.indexOf('@') + 1) : 'omc';
};
// The plugin cache directory of a marketplace.
const cacheDirOf = (market) => path.join(configDir, 'plugins', 'cache', market, 'oh-my-claudecode');
// == version grammar (shared) ==
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
// == read file (shared) ==
// Reads a regular file only: a FIFO or another special file is never opened, so a read cannot hang.
const readFile = (file) => {
  if (!fs.statSync(file).isFile()) throw 0;
  return fs.readFileSync(file, 'utf8');
};
// == registry marketplaces (shared) ==
// The marketplaces of the supported plugin IDs in installed_plugins.json, each once, in the order of their last
// occurrence. It is omc when the registry holds none and when it cannot be read (missing, a FIFO, bad JSON).
const registryMarketplaces = (() => {
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
})();

// == output ==
// With more than one marketplace every line is led by its name.
for (const market of registryMarketplaces) {
  const lead = registryMarketplaces.length > 1 ? market + ': ' : '';
  try {
    const names = fs.readdirSync(cacheDirOf(market)).filter(isVersionDir);
    console.log(lead + names.length + ' version(s):', names.join(', '));
  } catch {
    console.log(lead + '0 versions');
  }
}
"
```

**Diagnosis**:
- If > 1 version (on any line when several marketplaces are printed): WARN - multiple cached versions (cleanup recommended)

### Step 7: Check for Legacy Curl-Installed Content

Check for legacy agents, commands, and skills installed via curl (before plugin system).
**Important**: Only flag files whose names match actual plugin-provided names. Do NOT flag user's custom agents/commands/skills that are unrelated to OMC.

```bash
C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; C=${C#"${C%%[![:space:]]*}"}; C=${C%"${C##*[![:space:]]}"}; case "$C" in '') C=$HOME/.claude;; '~') C=$HOME;; '~/'*|'~\'*) C=$HOME/${C#??};; esac; L=$(CDPATH= cd -- "$C" 2>/dev/null && pwd -L) && C=$L
# Check for legacy agents directory
ls -la "$C"/agents/ 2>/dev/null

# Check for legacy commands directory
ls -la "$C"/commands/ 2>/dev/null

# Check for legacy skills directory
ls -la "$C"/skills/ 2>/dev/null
```

**Diagnosis**:
- If `~/.claude/agents/` exists with files matching plugin agent names: WARN - legacy agents (now provided by plugin)
- If `~/.claude/commands/` exists with files matching plugin command names: WARN - legacy commands (now provided by plugin)
- If `~/.claude/skills/` exists with files matching plugin skill names: WARN - legacy skills (now provided by plugin)
- If custom files exist that do NOT match plugin names: OK - these are user custom content, do not flag them

**Known plugin agent names** (check agents/ for these):
`architect.md`, `document-specialist.md`, `explore.md`, `executor.md`, `debugger.md`, `planner.md`, `analyst.md`, `critic.md`, `verifier.md`, `test-engineer.md`, `designer.md`, `writer.md`, `qa-tester.md`, `scientist.md`, `security-reviewer.md`, `code-reviewer.md`, `git-master.md`, `code-simplifier.md`

**Known plugin skill names** (check skills/ for these):
`ai-slop-cleaner`, `ask`, `autopilot`, `cancel`, `configure-notifications`, `deep-interview`, `deepinit`, `external-context`, `hud`, `omc-doctor`, `omc-setup`, `plan`, `project-session-manager`, `ralph`, `ralplan`, `release`, `skill`, `team`, `visual-verdict`, `wiki`

**Known plugin command names** (check commands/ for these):
`deepsearch.md`

---

## Report Format

After running all checks, output a report:

```
## OMC Doctor Report

### Summary
[HEALTHY / ISSUES FOUND]

### Checks

| Check | Status | Details |
|-------|--------|---------|
| Plugin Version | OK/WARN/CRITICAL | ... |
| Legacy Hooks (settings.json) | OK/WARN/CRITICAL | ... |
| Legacy Scripts (~/.claude/hooks/) | OK/WARN | ... |
| CLAUDE.md | OK/INFO/WARN/CRITICAL | ... |
| Ralph Runtime Prerequisites (Node, config dir) | OK/CRITICAL | ... |
| Plugin Cache | OK/WARN | ... |
| Legacy Agents (~/.claude/agents/) | OK/WARN | ... |
| Legacy Commands (~/.claude/commands/) | OK/WARN | ... |
| Legacy Skills (~/.claude/skills/) | OK/WARN | ... |

### Issues Found
1. [Issue description]
2. [Issue description]

### Recommended Fixes
[List fixes based on issues]
```

---

## Auto-Fix (if user confirms)

If issues found, ask user: "Would you like me to fix these issues automatically?"

If yes, apply fixes. For each affected profile-level, project-level, or project-local settings file, approval of this general question is not enough to authorize removing hooks: show the exact matching hook objects and the non-OMC entries/groups that will remain, then ask for explicit confirmation of that scoped change. Include every applicable project-local file in the proposal, including main-checkout, Windows side-by-side, and legacy starting-directory files when present; changes to the main checkout's local file affect its linked worktrees. Before writing, verify the target is a regular non-symlink file. Create a timestamped backup beside the original with exclusive, no-follow semantics (for example, an `open` using `wx`), without overwriting an existing path. Give the backup permissions no broader than the source (for example, use `0600` for a `0600` source, and retain any stricter mode or ACL); do not rely on the process umask or default file mode. Write the replacement through a same-directory exclusive/no-follow temporary file and atomic replacement, preserving the original mode and restrictive ACLs or applying stricter protections. On Windows, preserve the source ACLs using platform-appropriate operations. If the backup or replacement cannot be kept no broader than the original, leave the settings file untouched and do not apply cleanup. Never edit managed settings or MDM/server policy. If no legacy entries match, leave the file untouched.

### Fix: Legacy Hooks in settings.json
For each affected profile-level, project-level, or project-local settings file:
1. Remove a hook only when all Step 2 checks pass: the command is a plain direct invocation (including the direct executable-path form only when the target has execute permission), the active plugin provides the payload's canonical or specifically verified equivalent handler under the registration's event, and the target file matches a shipped or trusted versioned OMC payload. A same-event handler that implements unrelated behavior does not qualify. Do not match other scripts merely because they are under a `hooks/` directory, plugin-root commands, or similarly named scripts in other directories.
2. Remove only those matching objects from their `hooks.<event>[].hooks[]` arrays. Preserve every unmatched hook object and every matcher group that still has hooks, including user and third-party hooks. If a command is composite or ambiguous, leave it unchanged and report it for manual cleanup. If removing matched objects leaves a matcher group with no hooks, remove that now-empty group; remove an event key when no groups remain and remove the top-level `"hooks"` key when no events remain. Leave all other settings unchanged.

### Fix: Legacy Script Files
Before deleting any script, inspect active session-scoped hook references in skill and subagent frontmatter, enabled plugin manifests, and settings sources. Skill frontmatter hooks remain active for the rest of the session after invocation; subagent frontmatter hooks remain active while that subagent runs. Inspect the source frontmatter of every active skill and running subagent for commands referencing the candidate script. If an active hook references the script, keep it until that skill or subagent is no longer active, then repeat the reference check. If active skill/subagent sources cannot be conclusively enumerated or read, leave the script in place.

Also enumerate every enabled or loaded plugin root, including marketplace plugins and local/inline plugins supplied through `--plugin-dir`, `--plugin-url`, or `CLAUDE_CODE_PLUGIN_DIRS`. Resolve marketplace installs through the effective plugin registry (for example, `${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/installed_plugins.json` and its recorded install paths), and include active `@skills-dir` plugin roots under user or project `.claude/skills/`. Read each plugin's `.claude-plugin/plugin.json` and `hooks/hooks.json` read-only. Parse the manifest's optional `hooks` field as a `.json` path, an inline hooks object, or an array mixing paths and inline objects; resolve every declared file path relative to that plugin root and inspect the command handlers from every declared source and the default `hooks/hooks.json` for references to the candidate script, resolving config/home environment variables and platform path separators. A registry entry under any plugin ID, also an unrelated one, that is not an object, has neither a `version` nor an `installPath`, or has one that is not a non-blank string cannot be read, so it counts as not conclusively enumerated (an entry with only a `version` names no root to read). If any enabled/loaded plugin root, manifest, or declared hook source cannot be conclusively enumerated, resolved, or read, leave the script in place; if any source references it, leave the script in place.

Claude Code retains the current session's hook snapshot after a settings file is edited. If this session removes a matching hook registration, keep its script in place until the user restarts Claude Code; never delete a target in the same session that removed its settings hook. In a later session, repeat the complete reference scan and final checks below before deleting the script.

The canonical event and equivalent-handler requirements from Step 2 also gate script deletion; an unrelated plugin handler under the same event cannot justify deleting a standalone payload.

The settings scan alone does not establish that no references remain; the active skill/subagent and enabled-plugin manifest scans above must also be complete and clean before deleting the target. A plugin manifest reference blocks deletion even when its command is registered under a different event.

After handling every relevant user/project settings file, re-check `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`, the primary working directory's `.claude/settings.json`, every applicable project-local `.claude/settings.local.json` path resolved above (main-checkout, Windows side-by-side, and legacy starting-directory paths where applicable), for references to each legacy script, including references in composite or ambiguous commands. Also inspect managed hook sources read-only: `/etc/claude-code/managed-settings.json` on Linux/WSL, `/Library/Application Support/ClaudeCode/managed-settings.json` on macOS, `C:\Program Files\ClaudeCode\managed-settings.json` on Windows, and any applicable MDM, server-managed, or command-line `--settings` sources (see [Claude Code managed-settings locations](https://code.claude.com/docs/en/managed-settings#deploy-a-managed-settings-file)). Never edit those sources. Remove a script only when no configured hook references remain in any source, the active plugin provides the same event, and its content matches the shipped OMC payload already verified in Step 2. If any applicable project-local path, main checkout root, managed source, or command-line source cannot be resolved or inspected, if any source references the script, the user declined the relevant settings change, a file could not be updated, no shipped payload exists, or verification is inconclusive, leave the corresponding script in place. Never run an unconditional `rm -f` based on basename.

### Fix: Outdated Plugin
**Update first**: moving cache directories does not update the plugin, and the installed version is normally pinned in `installed_plugins.json`, so the command below often has nothing to move. Tell the user to run the `Updater:` line that Step 1 printed for the active plugin ID, then restart Claude Code. The line is derived from the registry entry of that install (for a marketplace install it refreshes the marketplace clone named in the entry and then updates that plugin ID; for a `Channel: npm` install it is `omc update`), so do not substitute a fixed marketplace or plugin ID. If Step 1 printed `Channel: unknown`, say so and do not guess an updater; for `Channel: plugin-dir` there is no updater line to run, so tell the user to update and rebuild that checkout and run `omc setup --plugin-dir-mode`, and the cache command cannot update it (it only cleans up the other cached versions and keeps that directory when it lies in the cache); if it listed several plugin IDs, update the one that is enabled (resolved with the precedence rules of Step 2). Do not report the plugin as fixed until a later run of Step 1 shows INSTALLED equal to that channel's `Latest:`. The cache command below is only the cleanup of old cached versions afterwards.

**Cache guard**: Diagnostics do not authorize removal or setup changes. Do not prune cache versions by age, lexical/version order, or presence of a newer version. A cache version is protected and must never be moved aside when it is pinned in `${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/installed_plugins.json` (by `version` or by `installPath`, under any supported OMC plugin ID: `oh-my-claudecode@omc`, `oh-my-claudecode` or `oh-my-claudecode@oh-my-claudecode`, in any letter case; the registry is read like the installer reads it, from its `plugins` object or, when there is none, from its top level), when the `installPath` of any other plugin or `OMC_PLUGIN_ROOT` or `CLAUDE_PLUGIN_ROOT` points into it, or when a running session occupies it (a record in `${CLAUDE_CONFIG_DIR:-~/.claude}/.omc/cache-occupancy/` whose plugin root is that version or inside it; a record is ignored only when its owner is proven gone: the process id no longer exists, on Linux the process start time differs from the recorded one, or the record is dated more than 5 minutes in the future; an old date alone never ignores a record, and this command never deletes one). Paths are compared after resolving symlinks one link at a time, and every link on the way is protected, not only the final directory (a pin on `5.7.0` in `5.7.0 -> 5.8.0 -> 5.9.0` protects all three; more than 40 links or a loop counts as unresolvable; the components of a path are read in the order the file system reads them, so a `..` after a link (`<dir>/shortcut/..`, where `shortcut` points to `5.9.0/nested`) names the parent of the link's target, and a `..` in a link's own target is read the same way, never folded as text first, except on win32, where Windows folds `..` first; every path that protects (the `installPath` of a pin or of another plugin, `OMC_PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, an occupancy record) protects what it names read that way and also what the runtime reads from it, the same text folded, so `<cache>/ext/../5.9.0`, where `ext` is a link to a directory outside the cache, protects `5.9.0` by its text; a pinned `version` written with a leading `v` also pins the directory of the bare version, `v5.8.0` pins `5.8.0`); a link that nothing refers to is not protected just because its target is. Paths that exist are also compared by filesystem identity (device and inode), so two spellings of one directory are that directory on a volume that ignores letter case even where the platform reports `linux` (WSL2 on a Windows drive), and two directories whose names differ only in letter case stay two directories on a volume that tells letter case apart even where the platform reports `darwin` or `win32` (a case-sensitive volume): letter case is never folded by the name of the platform; the one exception only adds protection: the SessionStart publisher stores the plugin root of an occupancy record in lower case on win32 and the runtime compares records in that form, so on win32 a record also protects the version it names or lies inside by a lower-case comparison. Where a file system reports inode 0 (or a `stat` of the path fails) it gives no identity, on either side of a comparison, and nothing is then guessed from the spelling of a path: a path is judged by its exact text only when that text lies inside a cache version (or above the cache directory, where it names no version), and on win32 an occupancy record is also judged by the lower-case form above; every other path that protects or may protect a version, whatever the source (the `installPath` of a pin or of another plugin, `OMC_PLUGIN_ROOT` or `CLAUDE_PLUGIN_ROOT`, an occupancy record, a link on the way, a pinned `version` that names no directory by its exact spelling but a directory by another letter case; a path that does not exist is judged by its nearest existing parent), could be another name of a cached version that cannot be ruled out, so the command prints `Nothing moved: identity unavailable` and moves nothing, also when that path lies outside the cache on such a file system (two names of one directory that differ in letter case are then different, so the two variables naming one directory by two spellings count as a conflict and nothing moves). An exact spelling still protects the version it names and the free versions still move. If `installed_plugins.json`, an occupancy record or a path in them cannot be read or resolved completely (a path that does not exist adds no protection of its own, only through its nearest existing parent as described above; a key that contains `oh-my-claudecode` without being a supported ID, an empty or non-array entry list under any key, an entry under any key (also of an unrelated plugin) that is not an object or has neither a `version` nor an `installPath` or has one that is not a non-blank string (a `null` field counts as missing), and under a supported plugin ID a `version` that is not a semantic version (`999x.0.0`, `1.2`, `1.2.3.4`; the grammar of Step 1's `Latest:`, with the optional `v`; a `version` of another plugin has to be a non-blank string only), and, under a supported plugin ID, an `installPath` written as a Windows path (a drive letter such as `C:` followed by a backslash, or a UNC path) on a system other than Windows, where it names nothing that can be read (a registry written by Windows and read from WSL, say), and `OMC_PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` naming different directories (a variable that names no existing directory takes no part in that comparison, as in Step 1, but a path it names still protects the version it points into) all count as unreadable; the two variables are compared after resolving links and by filesystem identity, so two names of one directory are not a conflict), move nothing, and the message names the first cause it found in the registry (the key and the `version` or `installPath` of the entry, or that the file is not a regular file or not JSON of the expected shape); the cause may also be an entry of an unrelated plugin, an occupancy record or a plugin root variable, which the message does not name. The registry pins, the occupancy records and the plugin root variables are read again just before each version is moved, and a version that has become protected, or whose protection can no longer be read completely, is skipped and reported; only the instant between that last read and the rename remains open, because a SessionStart that has not yet published its record cannot be seen and the command holds no lock shared with the publisher. A version directory is not moved either when it, or any entry anywhere below it, was modified in the last 10 minutes (the same threshold, `STALE_THRESHOLD_MS` in `src/utils/paths.ts`, that SessionStart's own cleanup uses to leave a directory alone while an update may still be installing it; every entry at any depth counts because an update that refreshes an existing version overwrites its files in place and need not change the date of the directory itself or of any level above the file; a link is dated itself and never followed, and so is the version directory when it is a link: a redirect that SessionStart created a moment ago, such as `5.7.0 -> 5.8.0`, is as new as the link whatever the dates in its target and is left in place, and an old one is moved as the link only, so its target, in or outside the cache, is not touched): it is left in place and reported, and the command can be run again later; a version with a modification date more than 5 minutes in the future (a wrong clock, or files extracted from an archive) is left in place too and reported as that, not as a recent change. A version with more than 20000 entries (a cached version holds about 9000), or one whose entries cannot all be read, cannot be judged: it is left in place and reported (`Could not judge`). The updater (`copyPluginSyncPayload` in `src/installer/index.ts`) copies into the version directory in place and leaves no marker or lock file that the command could test, so an update that starts writing after the date scan has read the files it rewrites, up to the rename (the rest of the scan and the re-read of the registry, the records and the root variables run in between), cannot be seen; closing that window needs a lock or marker shared with the updater, which is a change in `src/installer` and not in this skill. The registry is read before any cache directory is looked for: when it cannot be read completely the command says so and stops, whatever namespace the cache lies in. The cache directory is `${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/cache/<marketplace>/oh-my-claudecode`, where `<marketplace>` is the part after the `@` of each supported plugin ID the registry holds (`omc` for the bare `oh-my-claudecode`, and when the registry holds none): every such directory that exists is handled in turn, a pinned version protects the version of that name in each of them, and a backup from a marketplace other than `omc` carries its name in front (`<marketplace>-<version>-<time>`), and when more than one such directory exists every report line starts with `<marketplace>:` and its counts are those of that directory. A directory named `<version>.omc-stale-<pid>` (a name ending in `.omc-stale-` and a pid, what an interrupted cache relink leaves beside a missing or unusable original path) is not a version: the command does not list, protect, date or move it, because the reconciliation of SessionStart's own purge (`purgeStalePluginCacheVersions` in `src/utils/paths.ts`) restores it as the only intact copy and moving it to `plugins/backups` would prevent that. A directory whose name is not a semantic version of the grammar of Step 1 (`1e3`, `4.15.7L`, `v5.7.0`) is no version either: the command does not list, protect, date or move it, and leaves it where it is. A cache directory that exists but cannot be read (any error other than its absence, such as `EACCES` or `EIO`, or a file where the directory should be) is not an absent cache: the command prints `Nothing moved: could not read <directory> (<error code>)`, moves nothing and stops, and `No plugin cache found` or `No cache to clean` is printed only for a directory that does not exist (`ENOENT`). Every refusal (`Nothing moved: ... could not be read completely`, `identity unavailable`, `could not read <directory>`) and a failed move (`Cache move failed`) ends the command with exit code 1, so that it cannot be taken for a success; a finished move, `Nothing to move`, `Nothing moved: no pinned ...` and a missing cache end with 0. If every cached version is protected, move nothing and report the protection instead of running the command below. Backups go to `${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/backups/oh-my-claudecode/`, outside `plugins/cache/`: OMC's stale cache purge can remove any cache directory that is not the active version, so a backup left inside the cache may not survive.
```bash
# Move unprotected cache versions to plugins/backups (cross-platform); keep versions pinned in installed_plugins.json; never delete
node -e "
// omc-doctor cache repair for an outdated plugin: moves the cached versions that nothing protects to plugins/backups.
// == config dir (shared) ==
// CLAUDE_CONFIG_DIR expanded like getClaudeConfigDir() in scripts/lib/config-dir.mjs: surrounding spaces are
// ignored, an empty value means the .claude directory of the home directory, a value that is ~ or starts with ~/ or
// ~ and a backslash means the home directory, and any other value is used as given, normalized as text like the
// runtime does (a .. after a link folds the link away, a ~ anywhere else is literal).
const path = require('path');
const fs = require('fs');
const home = require('os').homedir();
const configured = (process.env.CLAUDE_CONFIG_DIR || '').trim();
const configDir = !configured
  ? path.join(home, '.claude')
  : configured === '~'
    ? home
    : /^~[/\x5c]/.test(configured)
      ? path.join(home, configured.slice(2))
      : path.normalize(configured);
// == plugin ids (shared) ==
// The plugin IDs the installer accepts (OMC_PLUGIN_IDS in src/installer/index.ts), compared in lower case.
const OMC_IDS = ['oh-my-claudecode@omc', 'oh-my-claudecode', 'oh-my-claudecode@oh-my-claudecode'];
// The marketplace of a plugin ID: the part after the @ in lower case, omc for the bare ID.
const marketplaceOf = (id) => {
  const lower = id.toLowerCase();
  return lower.includes('@') ? lower.slice(lower.indexOf('@') + 1) : 'omc';
};
// The plugin cache directory of a marketplace.
const cacheDirOf = (market) => path.join(configDir, 'plugins', 'cache', market, 'oh-my-claudecode');
// == version grammar (shared) ==
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
// == read file (shared) ==
// Reads a regular file only: a FIFO or another special file is never opened, so a read cannot hang.
const readFile = (file) => {
  if (!fs.statSync(file).isFile()) throw 0;
  return fs.readFileSync(file, 'utf8');
};
// == registry entry shape (shared) ==
// An entry of installed_plugins.json is malformed unless it has a non-blank string version or installPath
// (a null field counts as missing, a non-string or blank one is malformed).
const entryShapeBad = (entry) => {
  const fields = [entry?.version, entry?.installPath];
  return (
    fields.every((field) => field == undefined) ||
    fields.some((field) => field != undefined && (typeof field != 'string' || !field.trim()))
  );
};
// == path resolver (shared) ==
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

// == messages (the only part that differs between the two cache commands) ==
const messages = {
  movedEnd: '.',
  allProtected: 'Nothing to move: every cached version is pinned in installed_plugins.json or in use by a running session',
  noPin: 'Nothing moved: no pinned cache version found, so nothing is moved',
  noCache: 'No plugin cache found',
  footer: 'This command only cleans up cached versions and does not update the plugin. To update, run the Updater line that Step 1 printed, then restart Claude Code.',
};

// == repair constants (shared) ==
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

// == repair registry (shared) ==
// pins: the entries of the supported plugin IDs. other: the installPath of every entry of another plugin. ids: the
// supported IDs. unreadable: the file is not a regular file, is not JSON of the expected shape, or holds a
// malformed entry anywhere; reason names the first such entry. A missing file is no pins and not unreadable.
// A Windows path (a drive letter or a UNC path) in the installPath of an entry of OMC cannot be read on another
// system, so it counts as unreadable instead of protecting nothing.
const foreignPath = (target) => process.platform != 'win32' && /^(?:[A-Za-z]:[/\x5c]|\x5c\x5c)/.test(target);
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

// == occupancy records (shared) ==
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

// == modification dates (shared) ==
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

// == protection (shared) ==
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

// == repair run (shared) ==
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
"
```

### Fix: Stale Cache (multiple versions)
**Stale cache guard**: Diagnostics do not authorize removal or setup changes. Do not prune cache versions by age, lexical/version order, or presence of a newer version. A cache version is protected when it is pinned in `${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/installed_plugins.json` (by `version` or by `installPath`, under any supported OMC plugin ID: `oh-my-claudecode@omc`, `oh-my-claudecode` or `oh-my-claudecode@oh-my-claudecode`, in any letter case; the registry is read like the installer reads it, from its `plugins` object or, when there is none, from its top level), when the `installPath` of any other plugin or `OMC_PLUGIN_ROOT` or `CLAUDE_PLUGIN_ROOT` points into it, or when a running session occupies it (a record in `${CLAUDE_CONFIG_DIR:-~/.claude}/.omc/cache-occupancy/` whose plugin root is that version or inside it; a record is ignored only when its owner is proven gone: the process id no longer exists, on Linux the process start time differs from the recorded one, or the record is dated more than 5 minutes in the future; an old date alone never ignores a record, and this command never deletes one); move aside only unprotected versions, and report the protected versions kept. Paths are compared after resolving symlinks one link at a time, and every link on the way is protected, not only the final directory (a pin on `5.7.0` in `5.7.0 -> 5.8.0 -> 5.9.0` protects all three; more than 40 links or a loop counts as unresolvable; the components of a path are read in the order the file system reads them, so a `..` after a link (`<dir>/shortcut/..`, where `shortcut` points to `5.9.0/nested`) names the parent of the link's target, and a `..` in a link's own target is read the same way, never folded as text first, except on win32, where Windows folds `..` first; every path that protects (the `installPath` of a pin or of another plugin, `OMC_PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, an occupancy record) protects what it names read that way and also what the runtime reads from it, the same text folded, so `<cache>/ext/../5.9.0`, where `ext` is a link to a directory outside the cache, protects `5.9.0` by its text; a pinned `version` written with a leading `v` also pins the directory of the bare version, `v5.8.0` pins `5.8.0`); a link that nothing refers to is not protected just because its target is. Paths that exist are also compared by filesystem identity (device and inode), so two spellings of one directory are that directory on a volume that ignores letter case even where the platform reports `linux` (WSL2 on a Windows drive), and two directories whose names differ only in letter case stay two directories on a volume that tells letter case apart even where the platform reports `darwin` or `win32` (a case-sensitive volume): letter case is never folded by the name of the platform; the one exception only adds protection: the SessionStart publisher stores the plugin root of an occupancy record in lower case on win32 and the runtime compares records in that form, so on win32 a record also protects the version it names or lies inside by a lower-case comparison. Where a file system reports inode 0 (or a `stat` of the path fails) it gives no identity, on either side of a comparison, and nothing is then guessed from the spelling of a path: a path is judged by its exact text only when that text lies inside a cache version (or above the cache directory, where it names no version), and on win32 an occupancy record is also judged by the lower-case form above; every other path that protects or may protect a version, whatever the source (the `installPath` of a pin or of another plugin, `OMC_PLUGIN_ROOT` or `CLAUDE_PLUGIN_ROOT`, an occupancy record, a link on the way, a pinned `version` that names no directory by its exact spelling but a directory by another letter case; a path that does not exist is judged by its nearest existing parent), could be another name of a cached version that cannot be ruled out, so the command prints `Nothing moved: identity unavailable` and moves nothing, also when that path lies outside the cache on such a file system (two names of one directory that differ in letter case are then different, so the two variables naming one directory by two spellings count as a conflict and nothing moves). An exact spelling still protects the version it names and the free versions still move. If `installed_plugins.json`, an occupancy record or a path in them cannot be read or resolved completely (a path that does not exist adds no protection of its own, only through its nearest existing parent as described above; a key that contains `oh-my-claudecode` without being a supported ID, an empty or non-array entry list under any key, an entry under any key (also of an unrelated plugin) that is not an object or has neither a `version` nor an `installPath` or has one that is not a non-blank string (a `null` field counts as missing), and under a supported plugin ID a `version` that is not a semantic version (`999x.0.0`, `1.2`, `1.2.3.4`; the grammar of Step 1's `Latest:`, with the optional `v`; a `version` of another plugin has to be a non-blank string only), and, under a supported plugin ID, an `installPath` written as a Windows path (a drive letter such as `C:` followed by a backslash, or a UNC path) on a system other than Windows, where it names nothing that can be read (a registry written by Windows and read from WSL, say), and `OMC_PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` naming different directories (a variable that names no existing directory takes no part in that comparison, as in Step 1, but a path it names still protects the version it points into) all count as unreadable; the two variables are compared after resolving links and by filesystem identity, so two names of one directory are not a conflict), move nothing, and the message names the first cause it found in the registry (the key and the `version` or `installPath` of the entry, or that the file is not a regular file or not JSON of the expected shape); the cause may also be an entry of an unrelated plugin, an occupancy record or a plugin root variable, which the message does not name. The registry pins, the occupancy records and the plugin root variables are read again just before each version is moved, and a version that has become protected, or whose protection can no longer be read completely, is skipped and reported; only the instant between that last read and the rename remains open, because a SessionStart that has not yet published its record cannot be seen and the command holds no lock shared with the publisher. A version directory is not moved either when it, or any entry anywhere below it, was modified in the last 10 minutes (the same threshold, `STALE_THRESHOLD_MS` in `src/utils/paths.ts`, that SessionStart's own cleanup uses to leave a directory alone while an update may still be installing it; every entry at any depth counts because an update that refreshes an existing version overwrites its files in place and need not change the date of the directory itself or of any level above the file; a link is dated itself and never followed, and so is the version directory when it is a link: a redirect that SessionStart created a moment ago, such as `5.7.0 -> 5.8.0`, is as new as the link whatever the dates in its target and is left in place, and an old one is moved as the link only, so its target, in or outside the cache, is not touched): it is left in place and reported, and the command can be run again later; a version with a modification date more than 5 minutes in the future (a wrong clock, or files extracted from an archive) is left in place too and reported as that, not as a recent change. A version with more than 20000 entries (a cached version holds about 9000), or one whose entries cannot all be read, cannot be judged: it is left in place and reported (`Could not judge`). The updater (`copyPluginSyncPayload` in `src/installer/index.ts`) copies into the version directory in place and leaves no marker or lock file that the command could test, so an update that starts writing after the date scan has read the files it rewrites, up to the rename (the rest of the scan and the re-read of the registry, the records and the root variables run in between), cannot be seen; closing that window needs a lock or marker shared with the updater, which is a change in `src/installer` and not in this skill. The registry is read before any cache directory is looked for: when it cannot be read completely the command says so and stops, whatever namespace the cache lies in. The cache directory is `${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/cache/<marketplace>/oh-my-claudecode`, where `<marketplace>` is the part after the `@` of each supported plugin ID the registry holds (`omc` for the bare `oh-my-claudecode`, and when the registry holds none): every such directory that exists is handled in turn, a pinned version protects the version of that name in each of them, and a backup from a marketplace other than `omc` carries its name in front (`<marketplace>-<version>-<time>`), and when more than one such directory exists every report line starts with `<marketplace>:` and its counts are those of that directory. A directory named `<version>.omc-stale-<pid>` (a name ending in `.omc-stale-` and a pid, what an interrupted cache relink leaves beside a missing or unusable original path) is not a version: the command does not list, protect, date or move it, because the reconciliation of SessionStart's own purge (`purgeStalePluginCacheVersions` in `src/utils/paths.ts`) restores it as the only intact copy and moving it to `plugins/backups` would prevent that. A directory whose name is not a semantic version of the grammar of Step 1 (`1e3`, `4.15.7L`, `v5.7.0`) is no version either: the command does not list, protect, date or move it, and leaves it where it is. A cache directory that exists but cannot be read (any error other than its absence, such as `EACCES` or `EIO`, or a file where the directory should be) is not an absent cache: the command prints `Nothing moved: could not read <directory> (<error code>)`, moves nothing and stops, and `No plugin cache found` or `No cache to clean` is printed only for a directory that does not exist (`ENOENT`). Every refusal (`Nothing moved: ... could not be read completely`, `identity unavailable`, `could not read <directory>`) and a failed move (`Cache move failed`) ends the command with exit code 1, so that it cannot be taken for a success; a finished move, `Nothing to move`, `Nothing moved: no pinned ...` and a missing cache end with 0. Backups go to `${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/backups/oh-my-claudecode/`, outside `plugins/cache/`: OMC's stale cache purge can remove any cache directory that is not the active version, so a backup left inside the cache may not survive.
```bash
# Keep protected versions; never prune by age, lexical/version order, or presence of a newer version; move only unprotected versions to plugins/backups
node -e "
// omc-doctor cache repair for a stale cache: moves the cached versions that nothing protects to plugins/backups.
// == config dir (shared) ==
// CLAUDE_CONFIG_DIR expanded like getClaudeConfigDir() in scripts/lib/config-dir.mjs: surrounding spaces are
// ignored, an empty value means the .claude directory of the home directory, a value that is ~ or starts with ~/ or
// ~ and a backslash means the home directory, and any other value is used as given, normalized as text like the
// runtime does (a .. after a link folds the link away, a ~ anywhere else is literal).
const path = require('path');
const fs = require('fs');
const home = require('os').homedir();
const configured = (process.env.CLAUDE_CONFIG_DIR || '').trim();
const configDir = !configured
  ? path.join(home, '.claude')
  : configured === '~'
    ? home
    : /^~[/\x5c]/.test(configured)
      ? path.join(home, configured.slice(2))
      : path.normalize(configured);
// == plugin ids (shared) ==
// The plugin IDs the installer accepts (OMC_PLUGIN_IDS in src/installer/index.ts), compared in lower case.
const OMC_IDS = ['oh-my-claudecode@omc', 'oh-my-claudecode', 'oh-my-claudecode@oh-my-claudecode'];
// The marketplace of a plugin ID: the part after the @ in lower case, omc for the bare ID.
const marketplaceOf = (id) => {
  const lower = id.toLowerCase();
  return lower.includes('@') ? lower.slice(lower.indexOf('@') + 1) : 'omc';
};
// The plugin cache directory of a marketplace.
const cacheDirOf = (market) => path.join(configDir, 'plugins', 'cache', market, 'oh-my-claudecode');
// == version grammar (shared) ==
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
// == read file (shared) ==
// Reads a regular file only: a FIFO or another special file is never opened, so a read cannot hang.
const readFile = (file) => {
  if (!fs.statSync(file).isFile()) throw 0;
  return fs.readFileSync(file, 'utf8');
};
// == registry entry shape (shared) ==
// An entry of installed_plugins.json is malformed unless it has a non-blank string version or installPath
// (a null field counts as missing, a non-string or blank one is malformed).
const entryShapeBad = (entry) => {
  const fields = [entry?.version, entry?.installPath];
  return (
    fields.every((field) => field == undefined) ||
    fields.some((field) => field != undefined && (typeof field != 'string' || !field.trim()))
  );
};
// == path resolver (shared) ==
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

// == messages (the only part that differs between the two cache commands) ==
const messages = {
  movedEnd: '',
  allProtected: 'Nothing to move: keep every pinned version; do not prune cache versions by age, lexical/version order, or presence of a newer version',
  noPin: 'Nothing moved: no pinned version found; manual review instead of pruning',
  noCache: 'No cache to clean',
  footer: '',
};

// == repair constants (shared) ==
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

// == repair registry (shared) ==
// pins: the entries of the supported plugin IDs. other: the installPath of every entry of another plugin. ids: the
// supported IDs. unreadable: the file is not a regular file, is not JSON of the expected shape, or holds a
// malformed entry anywhere; reason names the first such entry. A missing file is no pins and not unreadable.
// A Windows path (a drive letter or a UNC path) in the installPath of an entry of OMC cannot be read on another
// system, so it counts as unreadable instead of protecting nothing.
const foreignPath = (target) => process.platform != 'win32' && /^(?:[A-Za-z]:[/\x5c]|\x5c\x5c)/.test(target);
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

// == occupancy records (shared) ==
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

// == modification dates (shared) ==
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

// == protection (shared) ==
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

// == repair run (shared) ==
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
"
```

### Fix: Missing/Outdated CLAUDE.md
Skip this fix unless Step 4 printed `CLAUDE.md management enabled`: skip it when Step 4 reported `CLAUDE.md management disabled by claudeMdEnabled: false` or could not check the opt-out.

Fetch latest from GitHub and write to `${CLAUDE_CONFIG_DIR:-~/.claude}/CLAUDE.md`:
```
WebFetch(url: "https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/docs/CLAUDE.md", prompt: "Return the complete raw markdown content exactly as-is")
```

### Fix: Legacy Curl-Installed Content

**Legacy content guard**: Diagnostics do not authorize deletion or setup changes. Before moving anything, record the exact target, its ownership evidence, and its contents (a file list of what is being moved and why).
Do not move entire `agents/`, `commands/`, or `skills/` roots to resolve a mixed installation. Never touch `agents/` or `skills/` roots containing any file that is not a verified OMC payload (those roots hold user custom agents and skills); with any such file present, report the mixed installation instead of fixing it.
The only allowed cleanup is a reversible move to a sibling `.bak` copy (`mv`); deletion (`rm -rf`, `rm`) is never allowed. Move a whole root with `mv` only when every file inside matches a name shipped in the active plugin's own `agents/`, `commands/`, or `skills/` directory. A `commands/` root that also holds a custom (non-OMC) file is not moved as a whole: move only individually verified OMC-owned files, one by one, into `commands.bak/` and leave every other file in place. An `agents/` or `skills/` root that holds a custom file is only reported, as stated above: nothing in it is moved.

```bash
C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; C=${C#"${C%%[![:space:]]*}"}; C=${C%"${C##*[![:space:]]}"}; case "$C" in '') C=$HOME/.claude;; '~') C=$HOME;; '~/'*|'~\'*) C=$HOME/${C#??};; esac; L=$(CDPATH= cd -- "$C" 2>/dev/null && pwd -L) && C=$L
# Backup first (optional - ask user)
# mv "$C"/agents "$C"/agents.bak
# mv "$C"/commands "$C"/commands.bak
# mv "$C"/skills "$C"/skills.bak
# Never rm -rf here: the only allowed form is the reversible mv above, after the guards above
```

**Note**: Only move (never delete) if these contain oh-my-claudecode-related files. If user has custom agents/commands/skills, warn them and ask before moving.

---

## Post-Fix

After applying fixes, inform user:
> Fixes applied. **Restart Claude Code** for changes to take effect.
