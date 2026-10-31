import { basename, dirname, isAbsolute, join, parse, resolve } from 'path';
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, statSync, type BigIntStats } from 'fs';

/**
 * The hook runner's required entry points. Keep this aligned with isPluginRoot()
 * in scripts/run.cjs; a stale root is not a valid fallback for any of them.
 */
const PLUGIN_ROOT_REQUIREMENTS = [join('hooks', 'hooks.json'), join('scripts', 'run.cjs'), 'scripts'];

const OMC_PLUGIN_CACHE_IDENTITIES = new Set(['oh-my-claudecode@omc', 'oh-my-claudecode@oh-my-claudecode']);
const FILESYSTEM_JUNK_NAMES = new Set(['.ds_store', 'desktop.ini', 'thumbs.db']);

export function isOmcPluginCacheIdentity(pluginName: string, marketplace: string): boolean {
  return OMC_PLUGIN_CACHE_IDENTITIES.has(`${pluginName}@${marketplace}`.toLowerCase());
}

export function sameFileSystemIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    typeof left.dev === 'bigint' &&
    typeof left.ino === 'bigint' &&
    left.ino !== 0n &&
    typeof right.dev === 'bigint' &&
    typeof right.ino === 'bigint' &&
    right.ino !== 0n &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

export function hasAncestorWithIdentity(path: string, identity: BigIntStats): boolean {
  let currentPath = path;
  while (true) {
    if (sameFileSystemIdentity(statSync(currentPath, { bigint: true }), identity)) return true;
    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) return false;
    currentPath = parentPath;
  }
}

export function firstChildBelowDirectoryIdentity(path: string, directoryIdentity: BigIntStats): string | undefined {
  // Relative install paths retain the existing lexical-only matching semantics.
  if (!isAbsolute(path)) return undefined;
  let currentPath = resolve(path);
  while (true) {
    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) return undefined;
    try {
      if (sameFileSystemIdentity(statSync(parentPath, { bigint: true }), directoryIdentity)) return basename(currentPath);
    } catch {
      // The registered version can be missing while its namespace still exists.
    }
    currentPath = parentPath;
  }
}

/** Includes the server and share, which win32.parse omits for extended UNC roots. */
export function pathRootForTraversal(path: string): string {
  const extendedUnc = /^(\\\\\?\\UNC\\|\/\/\?\/UNC\/)([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]|$)/i.exec(path);
  if (extendedUnc) {
    const separator = extendedUnc[1].includes('\\') ? '\\' : '/';
    return `${extendedUnc[1]}${extendedUnc[2]}${separator}${extendedUnc[3]}${separator}`;
  }
  return parse(path).root;
}

function pathTraversesFileSystemIdentity(path: string, identity: BigIntStats): boolean {
  let currentPath: string;
  let components: string[];
  const splitComponents = (value: string, root: string): string[] =>
    value
      .slice(root.length)
      .split(process.platform === 'win32' ? /[\\/]+/ : /\/+/)
      .filter(Boolean);

  if (isAbsolute(path)) {
    const pathRoot = pathRootForTraversal(path);
    currentPath = process.platform === 'win32' && pathRoot === '\\' ? parse(resolve(path)).root : pathRoot;
    components = splitComponents(path, pathRoot);
  } else {
    const pathRoot = pathRootForTraversal(path);
    if (process.platform === 'win32' && pathRoot) {
      // Resolve the drive's current directory without normalizing the target components.
      const driveCwd = resolve(`${pathRoot}.`);
      const driveRoot = parse(driveCwd).root;
      currentPath = driveRoot;
      components = [...splitComponents(driveCwd, driveRoot), ...splitComponents(path, pathRoot)];
    } else {
      const cwd = process.cwd();
      const cwdRoot = parse(cwd).root;
      currentPath = cwdRoot;
      components = [...splitComponents(cwd, cwdRoot), ...splitComponents(path, pathRoot)];
    }
  }

  type TraversalStep = string | { endLink: string };
  const steps: TraversalStep[] = [];
  for (let index = components.length - 1; index >= 0; index--) steps.push(components[index]);
  const activeLinks = new Set<string>();

  try {
    if (sameFileSystemIdentity(lstatSync(currentPath, { bigint: true }), identity)) return true;
  } catch {
    return false;
  }

  while (steps.length > 0) {
    const step = steps.pop()!;
    if (typeof step !== 'string') {
      activeLinks.delete(step.endLink);
      continue;
    }
    if (step === '' || step === '.') continue;
    if (step === '..') {
      currentPath = dirname(currentPath);
      continue;
    }

    const nextPath = join(currentPath, step);
    let nextStats: BigIntStats;
    try {
      nextStats = lstatSync(nextPath, { bigint: true });
    } catch {
      // Earlier components have already been checked; a missing suffix cannot traverse a later link.
      return false;
    }
    if (!nextStats.isSymbolicLink()) {
      if (sameFileSystemIdentity(nextStats, identity)) return true;
      currentPath = nextPath;
      continue;
    }

    const linkKey =
      typeof nextStats.dev === 'bigint' && typeof nextStats.ino === 'bigint' && nextStats.ino !== 0n
        ? `inode:${nextStats.dev}:${nextStats.ino}`
        : `path:${process.platform === 'win32' ? nextPath.toLowerCase() : nextPath}`;
    if (activeLinks.has(linkKey)) return false;
    let linkTarget: string;
    try {
      linkTarget = readlinkSync(nextPath);
    } catch {
      // An unreadable link is rejected by the target's normal usability check.
      return false;
    }

    activeLinks.add(linkKey);
    steps.push({ endLink: linkKey });
    const targetPathRoot = pathRootForTraversal(linkTarget);
    let targetComponents: string[];
    if (isAbsolute(linkTarget)) {
      currentPath =
        process.platform === 'win32' && targetPathRoot === '\\' ? parse(resolve(linkTarget)).root : targetPathRoot;
      targetComponents = splitComponents(linkTarget, targetPathRoot);
    } else if (process.platform === 'win32' && targetPathRoot) {
      const driveCwd = resolve(`${targetPathRoot}.`);
      const driveRoot = parse(driveCwd).root;
      currentPath = driveRoot;
      targetComponents = [...splitComponents(driveCwd, driveRoot), ...splitComponents(linkTarget, targetPathRoot)];
    } else {
      targetComponents = splitComponents(linkTarget, targetPathRoot);
    }
    for (let index = targetComponents.length - 1; index >= 0; index--) steps.push(targetComponents[index]);
  }

  return false;
}

/**
 * True when `path` is a usable plugin root. When supplied, the stale identity
 * also prevents required paths from traversing the version being demoted.
 */
export function isUsableVersionPath(path: string, staleVersionIdentity?: BigIntStats): boolean {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return false;
  }
  if (!stats.isDirectory() && !stats.isSymbolicLink()) return false;
  const hasRequiredEntries = PLUGIN_ROOT_REQUIREMENTS.every((required) => {
    const requiredPath = join(path, required);
    return (
      existsSync(requiredPath) &&
      (staleVersionIdentity === undefined || !pathTraversesFileSystemIdentity(requiredPath, staleVersionIdentity))
    );
  });
  if (!hasRequiredEntries) return false;
  if (staleVersionIdentity === undefined) return true;
  return (
    hasResolvablePluginSymlinks(path, staleVersionIdentity) &&
    hasUsableOmcHookTargets(path, staleVersionIdentity)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasUsableOmcHookTargets(path: string, staleVersionIdentity: BigIntStats): boolean {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(path, 'hooks', 'hooks.json'), 'utf8'));
  } catch {
    return false;
  }
  if (!isRecord(manifest)) return false;
  if (manifest.hooks === undefined) return true;
  if (!isRecord(manifest.hooks)) return false;

  // A partial extraction must not pass validation while a manifest target is absent.
  for (const groups of Object.values(manifest.hooks)) {
    if (!Array.isArray(groups)) return false;
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) return false;
      for (const hook of group.hooks) {
        if (!isRecord(hook)) return false;
        if (typeof hook.command !== 'string') continue;
        for (const match of hook.command.matchAll(/\$(?:\{CLAUDE_PLUGIN_ROOT\}|CLAUDE_PLUGIN_ROOT)["']?([\\/][^"'`\s]+)/g)) {
          const reference = match[1];
          if (!reference) return false;
          const pathParts = reference.split(/[\\/]+/).filter(Boolean);
          if (pathParts.includes('..')) return false;
          const targetPath = join(path, ...pathParts);
          try {
            const targetStats = statSync(targetPath);
            if (
              !targetStats.isFile() ||
              targetStats.size <= 0 ||
              pathTraversesFileSystemIdentity(targetPath, staleVersionIdentity)
            ) {
              return false;
            }
          } catch {
            return false;
          }
        }
      }
    }
  }
  return true;
}

interface PayloadScan {
  found: boolean;
}

function hasResolvablePluginSymlinks(
  directory: string,
  staleVersionIdentity: BigIntStats,
  ancestors: BigIntStats[] = [],
  payload?: PayloadScan,
): boolean {
  const directoryStats = statSync(directory, { bigint: true });
  if (ancestors.some((identity) => sameFileSystemIdentity(directoryStats, identity))) return false;
  const branch = [...ancestors, directoryStats];
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const entryStats = statSync(entryPath, { bigint: true });
      if (pathTraversesFileSystemIdentity(entryPath, staleVersionIdentity)) return false;
      if (entryStats.isDirectory()) {
        if (branch.some((identity) => sameFileSystemIdentity(entryStats, identity))) continue;
        if (!hasResolvablePluginSymlinks(entryPath, staleVersionIdentity, branch, payload)) return false;
      } else if (
        payload &&
        entryStats.isFile() &&
        entryStats.size > 0n &&
        !FILESYSTEM_JUNK_NAMES.has(entry.name.toLowerCase())
      ) {
        payload.found = true;
      }
    } else if (entry.isDirectory()) {
      if (!hasResolvablePluginSymlinks(entryPath, staleVersionIdentity, branch, payload)) return false;
    } else if (payload && entry.isFile() && !FILESYSTEM_JUNK_NAMES.has(entry.name.toLowerCase())) {
      if (statSync(entryPath).size > 0) payload.found = true;
    }
  }
  return true;
}

export function isUsableGenericPluginTarget(target: string, staleVersionIdentity: BigIntStats): boolean {
  const payload = { found: false };
  return hasResolvablePluginSymlinks(target, staleVersionIdentity, [], payload) && payload.found;
}
