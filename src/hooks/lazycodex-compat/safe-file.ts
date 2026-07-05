import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';

export class LazyCodexSinkSafetyError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`unsafe .lazycodex sink: ${reason}: ${path}`);
    this.name = 'LazyCodexSinkSafetyError';
    this.path = path;
  }
}

function isInsideDirectory(directoryPath: string, candidate: string): boolean {
  const relativePath = relative(directoryPath, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function pathSegmentsBetween(root: string, candidate: string): readonly string[] {
  const relativePath = relative(root, candidate);
  if (relativePath === '') {
    return [];
  }
  return relativePath.split(/[\\/]/).filter((segment) => segment.length > 0);
}

function assertExistingParentsSafe(lazycodexRoot: string, parentPath: string, sinkPath: string): void {
  let current = lazycodexRoot;
  const paths = [current, ...pathSegmentsBetween(lazycodexRoot, parentPath).map((segment) => {
    current = join(current, segment);
    return current;
  })];

  for (const path of paths) {
    if (!existsSync(path)) {
      return;
    }
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new LazyCodexSinkSafetyError(sinkPath, `parent component is a symbolic link: ${path}`);
    }
    if (!stat.isDirectory()) {
      throw new LazyCodexSinkSafetyError(sinkPath, `parent component is not a directory: ${path}`);
    }
  }
}

function prepareLazyCodexSink(cwd: string, sinkPath: string): string {
  const lazycodexRoot = resolve(cwd, '.lazycodex');
  const resolved = resolve(sinkPath);
  if (!isInsideDirectory(lazycodexRoot, resolved)) {
    throw new LazyCodexSinkSafetyError(sinkPath, 'path escapes .lazycodex');
  }

  const parentPath = dirname(resolved);
  assertExistingParentsSafe(lazycodexRoot, parentPath, sinkPath);
  mkdirSync(parentPath, { recursive: true });
  assertExistingParentsSafe(lazycodexRoot, parentPath, sinkPath);

  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new LazyCodexSinkSafetyError(sinkPath, 'leaf path is a symbolic link');
  }

  return resolved;
}

export function safeWriteLazyCodexJson(cwd: string, sinkPath: string, value: unknown): void {
  const resolved = prepareLazyCodexSink(cwd, sinkPath);
  const tempPath = join(dirname(resolved), `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    renameSync(tempPath, resolved);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export function safeAppendLazyCodexJsonLine(cwd: string, sinkPath: string, value: unknown): void {
  const resolved = prepareLazyCodexSink(cwd, sinkPath);
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const fd = openSync(resolved, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow, 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
  } finally {
    closeSync(fd);
  }
}
