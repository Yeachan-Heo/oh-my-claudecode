import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
} from "fs";
import { isAbsolute, join, normalize, win32 } from "path";
import { directoryOperations, type DirectoryOperations, containedFdPath, containedFsPlatformSupported } from "./contained-fd.js";
import type { RunDirHandle } from "./run-dir.js";

const NO_FOLLOW = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;

const UNSAFE_CONTROL = /[\u0000-\u001f\u007f]/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;

/** Fail closed before acquiring any run-scoped locks on unsupported platforms. */
export function assertContainedFsSupported(
  platform: NodeJS.Platform = process.platform,
): void {
  if (!containedFsPlatformSupported(platform)) {
    throw new Error(
      `contained directory-FD traversal is unavailable on ${platform}; refusing pathname fallback`,
    );
  }
}

/**
 * Validate the untrusted final component before it reaches any path API.
 * Contained artifacts are deliberately a single portable basename: allowing
 * either platform separator would make the contract depend on the host that
 * happens to process the descriptor, and Windows also treats `:` as an ADS
 * separator. Require canonical NFC so the same artifact name has one portable
 * byte-level spelling across Linux, macOS, and Windows; reject normalization-
 * changing values rather than attempting to canonicalize untrusted input.
 */
export function assertSafeContainedFileName(
  fileName: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (
    typeof fileName !== "string" ||
    fileName.length === 0 ||
    fileName === "." ||
    fileName === ".." ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName.includes("\0") ||
    UNSAFE_CONTROL.test(fileName) ||
    fileName.normalize("NFC") !== fileName ||
    isAbsolute(fileName) ||
    win32.isAbsolute(fileName) ||
    normalize(fileName) !== fileName ||
    win32.normalize(fileName) !== fileName ||
    (platform === "win32" && fileName.includes(":")) ||
    (platform === "win32" && WINDOWS_DEVICE_NAME.test(fileName)) ||
    (fileName.endsWith(".") || fileName.endsWith(" "))
  ) {
    throw new RangeError(`invalid contained artifact fileName: ${JSON.stringify(fileName)}`);
  }
}

/** Open a runtime artifact without following a symlink at the final path. */
export function openNoFollow(
  filePath: string,
  flags: number,
  mode = 0o600,
): number {
  if (process.platform === "win32") {
    throw new Error(
      "atomic no-follow file opens are unavailable on win32; refusing pathname fallback",
    );
  }
  return openSync(filePath, flags | NO_FOLLOW, mode);
}

/** Reject special files and hardlinks that escape the run-directory inode. */
export function assertPrivateRegularFile(
  fileDescriptor: number,
  filePath: string,
): void {
  const stats = fstatSync(fileDescriptor);
  if (!stats.isFile() || stats.nlink !== 1) {
    throw new Error(`contained artifact is not a private regular file: ${filePath}`);
  }
}

/** Read a runtime artifact without following a symlink at the final path. */
export function readFileNoFollow(filePath: string): string {
  const fd = openNoFollow(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    assertPrivateRegularFile(fd, filePath);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Resolve a path for an already-open run directory without changing the
 * process-wide platform state. Linux exposes directory FDs as traversable
 * procfs directories. Platforms without that primitive fail closed instead of
 * falling back to a raceable pathname.
 */
export function containedPathForPlatform(
  directoryFd: number,
  runDirPath: string,
  fileName: string,
  platform: NodeJS.Platform = process.platform,
): string {
  assertSafeContainedFileName(fileName, platform);
  assertContainedFsSupported(platform);
  return join(containedFdPath(directoryFd, platform), fileName);
}

/**
 * Run a synchronous operation against a directory FD on Linux. If the
 * directory is renamed or its parent path is replaced while the operation is
 * in flight, the FD still refers to the originally validated directory.
 * Platforms without a traversable directory FD fail closed.
 */
export function withContainedPath<T>(
  runDir: RunDirHandle,
  fileName: string,
  operation: (filePath: string) => T,
): T {
  return withContainedPathForPlatform(
    runDir,
    fileName,
    operation,
    process.platform,
  );
}

/** Legacy Linux-only path callback; use withContainedOperations for portable I/O. */
export function withContainedDirectory<T>(
  runDir: RunDirHandle,
  operation: (directoryPath: string) => T,
  platform: NodeJS.Platform = process.platform,
): T {
  assertContainedFsSupported(platform);
  const directoryFd = openNoFollow(
    runDir.path,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0),
  );
  try {
    const stats = fstatSync(directoryFd);
    if (stats.dev !== runDir.device || stats.ino !== runDir.inode) {
      throw new Error("run directory identity changed");
    }
    return operation(containedFdPath(directoryFd, platform));
  } finally {
    closeSync(directoryFd);
  }
}

export function withContainedPathForPlatform<T>(
  runDir: RunDirHandle,
  fileName: string,
  operation: (filePath: string) => T,
  platform: NodeJS.Platform,
): T {
  assertSafeContainedFileName(fileName, platform);
  assertContainedFsSupported(platform);
  const directoryFd = openNoFollow(
    runDir.path,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0),
  );
  try {
    const stats = fstatSync(directoryFd);
    if (stats.dev !== runDir.device || stats.ino !== runDir.inode) {
      throw new Error("run directory identity changed");
    }
    return operation(
      containedPathForPlatform(directoryFd, runDir.path, fileName, platform),
    );
  } finally {
    closeSync(directoryFd);
  }
}

/** Read a named artifact through a validated run-directory handle. */
export function readContainedFileNoFollow(
  runDir: RunDirHandle,
  fileName: string,
): string {
  return withContainedOperations(runDir, (operations) => readOperationFileNoFollow(operations, fileName));
}

/**
 * Bind synchronous operations to one identity-checked directory descriptor.
 * The callback must not return a Promise. Retained operations fail closed after
 * callback return, before the OS can reuse the closed descriptor number.
 */
export function withContainedOperations<T>(runDir: RunDirHandle, operation: (operations: DirectoryOperations) => T): T {
  assertContainedFsSupported();
  const fd = openNoFollow(runDir.path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  let active = true;
  const checkActive = (): void => {
    if (!active) throw new Error("contained operations used outside synchronous callback");
  };
  try {
    const stats = fstatSync(fd);
    if (stats.dev !== runDir.device || stats.ino !== runDir.inode) throw new Error("run directory identity changed");
    const operations = directoryOperations(fd);
    const check = (name: string): string => { checkActive(); assertSafeContainedFileName(name); return name; };
    return operation({ ...operations,
      open: (name, flags, mode) => operations.open(check(name), flags, mode),
      mkdir: (name, mode) => operations.mkdir(check(name), mode),
      lstat: (name) => operations.lstat(check(name)),
      rename: (source, destination) => operations.rename(check(source), check(destination)),
      unlink: (name) => operations.unlink(check(name)),
      link: (source, destination) => operations.link(check(source), check(destination)),
      readDir: () => { checkActive(); return operations.readDir(); },
      realpath: () => { checkActive(); return operations.realpath(); },
      sync: () => { checkActive(); operations.sync(); },
    });
  } finally { active = false; closeSync(fd); }
}

export function readOperationFileNoFollow(operations: DirectoryOperations, name: string): string {
  const fd = operations.open(name, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  try { assertPrivateRegularFile(fd, name); return readFileSync(fd, "utf8"); }
  finally { closeSync(fd); }
}
