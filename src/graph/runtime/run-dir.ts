/**
 * Run-directory containment for graph runtime persistence (P1-3).
 *
 * Every persisted artifact lives under `<runsRoot>/<run_id>/`. A run_id is
 * descriptor-supplied and therefore untrusted: resolving it must never let a
 * traversal-shaped id or a symlinked run directory redirect writes outside
 * the runs root. resolveRunDir validates, creates, and containment-checks
 * the directory with directory-FD-relative operations, failing closed on any escape or
 * on platforms without that primitive.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
} from "fs";
import { join, resolve, sep } from "path";
import {
  directoryOperations,
  containedFsPlatformSupported,
} from "./contained-fd.js";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const DIRECTORY_FLAGS =
  fsConstants.O_RDONLY |
  (fsConstants.O_DIRECTORY ?? 0) |
  (fsConstants.O_NOFOLLOW ?? 0);

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Open an existing directory without following its final pathname component. */
function openDirectory(path: string, label: string): number {
  try {
    return openSync(path, DIRECTORY_FLAGS);
  } catch (error) {
    // Linux reports ENOTDIR (rather than ELOOP) for O_DIRECTORY|O_NOFOLLOW
    // when the final component is a symlink to a directory. The lstat is only
    // used to preserve the fail-closed diagnostic; creation remains FD-bound.
    if (isErrno(error, "ELOOP") || (isErrno(error, "ENOTDIR") && isSymbolicLink(path))) {
      throw new Error(`${label} must not be a symbolic link`);
    }
    throw error;
  }
}

/**
 * Open or create one directory component below an already-open directory.
 * Both the mkdir and the subsequent open are anchored at the parent FD, so a
 * pathname replacement cannot redirect creation through a symlink.
 */
function openOrCreateDirectoryAt(parentFd: number, name: string, label: string): number {
  const operations = directoryOperations(parentFd);
  const open = (): number => {
    try {
      return operations.open(name, DIRECTORY_FLAGS);
    } catch (error) {
      if (isErrno(error, "ELOOP") || (isErrno(error, "ENOTDIR") && operations.lstat(name).isSymbolicLink())) {
        throw new Error(`${label} must not be a symbolic link`);
      }
      throw error;
    }
  };
  try {
    return open();
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    try {
      operations.mkdir(name);
    } catch (mkdirError) {
      if (!isErrno(mkdirError, "EEXIST")) throw mkdirError;
    }
    return open();
  }
}

/**
 * Securely open or create runsRoot one component at a time from `/`.
 * This replaces recursive pathname mkdir, which can follow a component that
 * is swapped for a symlink while the root is being created.
 */
function openOrCreateRunsRoot(runsRoot: string): number {
  const absoluteRoot = resolve(runsRoot);
  const rootName = absoluteRoot.slice(0, 1) === sep ? sep : "";
  const components = absoluteRoot
    .slice(rootName.length)
    .split(sep)
    .filter((component) => component.length > 0);
  let directoryFd = openDirectory(rootName || sep, "runs root");
  try {
    for (const component of components) {
      const nextFd = openOrCreateDirectoryAt(
        directoryFd,
        component,
        "runs root",
      );
      closeSync(directoryFd);
      directoryFd = nextFd;
    }
    return directoryFd;
  } catch (error) {
    closeSync(directoryFd);
    throw error;
  }
}

export interface RunDirHandle {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

/**
 * Resolve (and create) the contained run directory for one run.
 *
 * Returns the plain `join(runsRoot, runId)` path so existing relative
 * behaviors stay stable; containment is enforced against an open directory
 * FD before returning. Throws RangeError("invalid run_id") on malformed ids
 * and Error on symlinked or escaping directories.
 */
export function resolveRunDir(runsRoot: string, runId: string): string {
  return resolveRunDirHandle(runsRoot, runId).path;
}

/** Resolve a run directory and capture the directory identity for safe I/O. */
export function resolveRunDirHandle(
  runsRoot: string,
  runId: string,
): RunDirHandle {
  // Charset check plus defense-in-depth separators/dot segments: the regex
  // already excludes them, but reject explicitly so traversal can never ride
  // on a future pattern relaxation.
  if (
    typeof runId !== "string" ||
    !RUN_ID_PATTERN.test(runId) ||
    runId.includes("/") ||
    runId.includes("\\") ||
    runId === "." ||
    runId === ".."
  ) {
    throw new RangeError("invalid run_id");
  }

  if (!containedFsPlatformSupported(process.platform)) {
    throw new Error(
      `contained directory-FD traversal is unavailable on ${process.platform}; refusing pathname fallback`,
    );
  }

  const target = join(runsRoot, runId);
  const runsRootFd = openOrCreateRunsRoot(runsRoot);
  try {
    const runsRootReal = directoryOperations(runsRootFd).realpath();
    // Keep the target directory open while both containment and identity are
    // checked. Creation is rooted at the runs-root FD rather than at `target`.
    // Thus replacing the root pathname or target pathname during mkdir cannot
    // redirect creation through an attacker-controlled symlink.
    const directoryFd = openOrCreateDirectoryAt(
      runsRootFd,
      runId,
      "run directory",
    );
    try {
      const resolved = directoryOperations(directoryFd).realpath();
      const prefixCmp = runsRootReal === sep ? sep : `${runsRootReal}${sep}`;
      if (!resolved.startsWith(prefixCmp)) {
        throw new Error(
          `run directory ${resolved} escapes the persistence root ${runsRootReal}`,
        );
      }

      const identity = fstatSync(directoryFd);
      return { path: target, device: identity.dev, inode: identity.ino };
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    closeSync(runsRootFd);
  }
}
