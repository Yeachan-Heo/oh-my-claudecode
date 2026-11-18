/**
 * Vitest global setup: run the suite against a throwaway home directory.
 *
 * Many modules resolve storage from os.homedir() (~/.omc, ~/.claude,
 * ~/.cache). A test that does not redirect HOME itself then writes fixture
 * state into the developer's real home (#5089). This setup points HOME and
 * USERPROFILE at a per-run directory before any worker starts, so the workers
 * and the child processes they spawn inherit it.
 *
 * The directory is a visible folder inside the current home. It cannot live
 * under os.tmpdir() or in a dot-folder: isSensitiveStateLocation() rejects
 * both, and many tests create fixtures with mkdtemp(join(homedir(), ...)).
 *
 * Only the variables in LOCATION_VARS are unset. Every other OMC_* variable
 * is inherited as is; workflow-drift-guard-script.test.ts passes one to a
 * nested vitest run as a sentinel.
 *
 * Not covered: APPDATA and LOCALAPPDATA on Windows, and code that reaches the
 * home directory without HOME (os.userInfo()).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Per-run homes are named `<prefix><host tag>-<pid of the vitest process>-<random>`,
 * where the host tag is hostTag(pidScope()).
 */
export const TEST_HOME_PREFIX = 'omc-vitest-home-';

/**
 * Variables that move a storage root or a stored file. An inherited value
 * would still point at the developer's real directories. Tests that need one
 * set it themselves.
 */
export const LOCATION_VARS = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_MCP_CONFIG_PATH',
  'OMC_STATE_DIR',
  'OMC_HOME',
  'OMC_MCP_REGISTRY_PATH',
  'OMC_JOBS_DIR',
  'CODEX_HOME',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  // Set by Claude Code for hooks. setup-init appends to it.
  'CLAUDE_ENV_FILE',
] as const;

/**
 * A home from another PID scope cannot be probed for liveness. It is removed
 * once its folder has not changed for this long. A running suite keeps
 * creating fixture folders in its home, which updates the folder's mtime.
 */
export const FOREIGN_HOME_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// `<prefix><host tag>-<pid>-<random>`.
const TEST_HOME_NAME = new RegExp(`^${TEST_HOME_PREFIX}[0-9a-f]{16}-\\d+-`);

// Same name as WORKSPACE_MARKER in src/lib/worktree-paths.ts. Not imported, so
// the setup loads no product code.
const WORKSPACE_MARKER = '.omc-workspace';

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  // A `..` component, not a name that starts with two dots (`~/..work`).
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * findWorkspaceRoot() walks up from the checkout and stops at homedir(). With
 * HOME moved to a child folder, a walk that used to stop at `home` (checkout
 * at or below it) passes it and every folder above it. Returns the first
 * workspace marker the walk would newly see, or null. Checks the literal and
 * the canonical paths: with a symlinked home (mounted or NFS homes) homedir()
 * is the link while process.cwd() is the real path.
 */
export function findExposedWorkspaceMarker(home: string, cwd: string): string | null {
  const pairs: Array<[string, string]> = [
    [resolve(home), resolve(cwd)],
    [canonical(home), canonical(cwd)],
  ];
  for (const [h, c] of pairs) {
    if (h !== c && !isInside(h, c)) continue;
    let cursor = h;
    while (true) {
      const marker = join(cursor, WORKSPACE_MARKER);
      if (existsSync(marker)) return marker;
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  return null;
}

/**
 * Identifies the PID scope in per-run home names, so cleanup only probes PIDs
 * it can see. A hash of the full input: truncating a hostname would let two
 * hosts that share a home and a long name prefix remove each other's running
 * homes.
 */
export function hostTag(scope: string): string {
  return createHash('sha256').update(scope).digest('hex').slice(0, 16);
}

/**
 * Where a PID is looked up. Containers can share a home and a hostname while
 * each has its own PID namespace, in which the other's PIDs look dead. On
 * Linux this adds the kernel boot id (one per machine) and the PID namespace;
 * elsewhere only the hostname is available.
 */
export function pidScope(host: string = hostname()): string {
  const bootId = readOrNull('/proc/sys/kernel/random/boot_id')?.trim() ?? '';
  let pidNamespace = '';
  try {
    pidNamespace = readlinkSync('/proc/self/ns/pid');
  } catch {
    // Not Linux, or /proc is not mounted.
  }
  return [host, bootId, pidNamespace].join('\0');
}

function isOlderThan(path: string, ageMs: number, now: number): boolean {
  try {
    return now - statSync(path).mtimeMs > ageMs;
  } catch {
    return false;
  }
}

/**
 * Remove homes left by runs that were killed before teardown. A home created
 * in this PID scope (see pidScope()) is removed when its process no longer
 * exists, so a concurrent run keeps its own, also when the home is shared with
 * another machine or a container. A home from another scope (another host, or
 * this host before a reboot or hostname change) is removed only after
 * FOREIGN_HOME_MAX_AGE_MS without changes.
 */
export function removeStaleTestHomes(outerHome: string, ownPrefix: string, now: number = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(outerHome);
  } catch {
    return;
  }
  for (const name of names) {
    let stale: boolean;
    if (name.startsWith(ownPrefix)) {
      const match = /^(\d+)-/.exec(name.slice(ownPrefix.length));
      stale = match !== null && !isProcessAlive(Number(match[1]));
    } else {
      stale = TEST_HOME_NAME.test(name) && isOlderThan(join(outerHome, name), FOREIGN_HOME_MAX_AGE_MS, now);
    }
    if (!stale) continue;
    try {
      rmSync(join(outerHome, name), { recursive: true, force: true });
    } catch {
      // Best effort: a leftover folder must not stop the run.
    }
  }
}

export default function setup(): () => void {
  const outerHome = homedir();
  // A vitest run started by a test (workflow-drift-guard-script.test.ts)
  // already has a per-run home. The checks on the real home do not apply.
  const nested = basename(outerHome).startsWith(TEST_HOME_PREFIX);

  // findWorkspaceRoot() stops its upward walk at homedir(). Once HOME moves,
  // a walk from the checkout passes the real home and would adopt a marker
  // there or above it, which anchors state outside the per-run home.
  const exposedMarker = nested ? null : findExposedWorkspaceMarker(outerHome, process.cwd());
  if (exposedMarker) {
    throw new Error(
      `${exposedMarker} exists. With HOME redirected for the test run, ` +
        'tests started from this checkout would write state outside the per-run home. ' +
        'Remove the marker and run again.',
    );
  }

  // The installer stamps this file, and the suite used to overwrite it. This
  // is a tripwire for one known write, not a check of the whole home.
  const canaryPath = join(outerHome, '.omc', 'template-version.json');
  const canaryBefore = nested ? null : readOrNull(canaryPath);

  const ownPrefix = `${TEST_HOME_PREFIX}${hostTag(pidScope())}-`;
  removeStaleTestHomes(outerHome, ownPrefix);

  const saved = (['HOME', 'USERPROFILE', ...LOCATION_VARS] as const).map(
    (name) => [name, process.env[name]] as const,
  );

  // realpath: on Windows homedir() can be an 8.3 short path, and tests compare
  // paths under the home with their canonical form.
  const testHome = realpathSync.native(mkdtempSync(join(outerHome, `${ownPrefix}${process.pid}-`)));
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  for (const name of LOCATION_VARS) delete process.env[name];

  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }

    const canaryChanged = !nested && readOrNull(canaryPath) !== canaryBefore;

    try {
      rmSync(testHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      // The next run removes it.
      console.warn(`Could not remove ${testHome}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (canaryChanged) {
      // Vitest reports an error thrown here but still exits 0, so set the
      // exit code as well.
      process.exitCode = 1;
      throw new Error(
        `Test run changed ${canaryPath}. A test wrote to the home directory outside ` +
          `the per-run ${TEST_HOME_PREFIX}* folder (#5089). If something else rewrote ` +
          'the file during the run (an OMC install or update), run the suite again.',
      );
    }
  };
}
