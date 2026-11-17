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
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';

/** Per-run homes are named `<prefix><host>-<pid of the vitest process>-<random>`. */
export const TEST_HOME_PREFIX = 'omc-vitest-home-';

/**
 * Variables that move a storage root. An inherited value would still point at
 * the developer's real directories. Tests that need one set it themselves.
 */
export const LOCATION_VARS = [
  'CLAUDE_CONFIG_DIR',
  'OMC_STATE_DIR',
  'OMC_HOME',
  'CODEX_HOME',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
] as const;

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

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Remove homes left by runs that were killed before teardown. A home is only
 * removed when it was created on this host and its process no longer exists,
 * so a concurrent run keeps its own, also when the home is shared with
 * another machine or a container.
 */
function removeStaleTestHomes(outerHome: string, ownPrefix: string): void {
  let names: string[];
  try {
    names = readdirSync(outerHome);
  } catch {
    return;
  }
  for (const name of names) {
    const match = name.startsWith(ownPrefix) ? /^(\d+)-/.exec(name.slice(ownPrefix.length)) : null;
    if (!match || isProcessAlive(Number(match[1]))) continue;
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
  // there, which anchors state at the real ~/.omc.
  if (!nested && isInside(outerHome, process.cwd()) && existsSync(join(outerHome, WORKSPACE_MARKER))) {
    throw new Error(
      `${join(outerHome, WORKSPACE_MARKER)} exists. With HOME redirected for the test run, ` +
        'tests started from this checkout would write state into the real ~/.omc. ' +
        'Remove the marker and run again.',
    );
  }

  // The installer stamps this file, and the suite used to overwrite it. This
  // is a tripwire for one known write, not a check of the whole home.
  const canaryPath = join(outerHome, '.omc', 'template-version.json');
  const canaryBefore = nested ? null : readOrNull(canaryPath);

  const ownPrefix = `${TEST_HOME_PREFIX}${hostname().replace(/[^A-Za-z0-9]/g, '').slice(0, 16)}-`;
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
