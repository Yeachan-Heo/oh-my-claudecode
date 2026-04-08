import { existsSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';

const EPHEMERAL_NODE_PATH_MARKERS = ['hostedtoolcache', '/runner/', '\\runner\\'];

function isKnownEphemeralNodePath(nodePath: string): boolean {
  return EPHEMERAL_NODE_PATH_MARKERS.some(marker => nodePath.includes(marker));
}

/**
 * Resolve the absolute path to the Node.js binary.
 *
 * Priority order:
 * 1. which/where node  — if Node is on PATH (usually the most stable symlink)
 * 2. process.execPath  — current Node.js process when PATH lookup is unavailable
 * 3. nvm versioned paths (~/.nvm/versions/node/<latest>/bin/node)
 * 4. fnm versioned paths (~/.fnm/node-versions/<latest>/installation/bin/node)
 * 5. Homebrew / system paths (/opt/homebrew/bin/node, /usr/local/bin/node, /usr/bin/node)
 * 6. Fallback: bare 'node' (lets the shell resolve at runtime)
 *
 * This is used at setup time to embed the absolute node path into the HUD
 * statusLine command and into .omc-config.json so that hook scripts can
 * locate node even when it is not on PATH (nvm/fnm users, non-interactive
 * shells, issue #892). We prefer PATH resolution first because process.execPath
 * can point at ephemeral CI runner toolcache paths or Homebrew Cellar
 * version-specific paths that disappear after upgrades (issue #2396).
 *
 * @returns Absolute path to the node binary, or 'node' as a last-resort fallback.
 */
export function resolveNodeBinary(): string {
  // 1. Prefer the PATH-resolved node because it typically points to a stable
  // symlink (for example /opt/homebrew/bin/node instead of a Cellar version).
  try {
    const cmd = process.platform === 'win32' ? 'where node' : 'which node';
    const result = execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' })
      .trim()
      .split('\n')[0]
      .trim();
    if (result && existsSync(result)) {
      return result;
    }
  } catch {
    // node not on PATH — continue to process.execPath and manager fallbacks
  }

  // 2. Current process's node — usable fallback, but not preferred because it
  // may point to unstable locations (CI toolcache, runner paths, Cellar bins).
  if (process.execPath && existsSync(process.execPath) && !isKnownEphemeralNodePath(process.execPath)) {
    return process.execPath;
  }

  // Unix-only fallbacks below (nvm and fnm are not used on Windows)
  if (process.platform === 'win32') {
    return 'node';
  }

  const home = homedir();

  // 3. nvm: ~/.nvm/versions/node/<version>/bin/node
  const nvmBase = join(home, '.nvm', 'versions', 'node');
  if (existsSync(nvmBase)) {
    try {
      const latest = pickLatestVersion(readdirSync(nvmBase));
      if (latest) {
        const nodePath = join(nvmBase, latest, 'bin', 'node');
        if (existsSync(nodePath)) return nodePath;
      }
    } catch {
      // ignore directory read errors
    }
  }

  // 4. fnm: multiple possible base directories
  const fnmBases = [
    join(home, '.fnm', 'node-versions'),
    join(home, 'Library', 'Application Support', 'fnm', 'node-versions'),
    join(home, '.local', 'share', 'fnm', 'node-versions'),
  ];
  for (const fnmBase of fnmBases) {
    if (existsSync(fnmBase)) {
      try {
        const latest = pickLatestVersion(readdirSync(fnmBase));
        if (latest) {
          const nodePath = join(fnmBase, latest, 'installation', 'bin', 'node');
          if (existsSync(nodePath)) return nodePath;
        }
      } catch {
        // ignore directory read errors
      }
    }
  }

  // 5. Common system / Homebrew paths
  for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    if (existsSync(p)) return p;
  }

  // 6. Last-resort fallback
  return 'node';
}

/**
 * Pick the latest semver version from a list of version strings.
 * Handles both "v20.0.0" and "20.0.0" formats.
 * Returns undefined if the list is empty.
 */
export function pickLatestVersion(versions: string[]): string | undefined {
  if (versions.length === 0) return undefined;

  return versions
    .filter(v => /^v?\d/.test(v))
    .sort((a, b) => {
      const pa = a.replace(/^v/, '').split('.').map(s => parseInt(s, 10) || 0);
      const pb = b.replace(/^v/, '').split('.').map(s => parseInt(s, 10) || 0);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    })[0];
}
