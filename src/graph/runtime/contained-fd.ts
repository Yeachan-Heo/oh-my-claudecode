import { constants as fsConstants, statSync } from "fs";

/**
 * Return the kernel-provided path for an already-open directory FD.
 *
 * Both Linux procfs and Darwin devfs resolve the descriptor at lookup time,
 * so the returned path remains anchored to the opened directory rather than
 * to its mutable pathname. No pathname fallback is provided.
 */
export function containedFdPath(
  directoryFd: number,
  platform: NodeJS.Platform,
  child?: string,
): string {
  const root = platform === "linux" ? "/proc/self/fd" : "/dev/fd";
  return child === undefined
    ? `${root}/${directoryFd}`
    : `${root}/${directoryFd}/${child}`;
}

export function containedFsPlatformSupported(platform: NodeJS.Platform): boolean {
  if (platform === "linux") return true;
  if (platform !== "darwin") return false;
  if (
    typeof fsConstants.O_DIRECTORY !== "number" ||
    typeof fsConstants.O_NOFOLLOW !== "number"
  ) {
    return false;
  }
  try {
    return statSync("/dev/fd").isDirectory();
  } catch {
    return false;
  }
}
