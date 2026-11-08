import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { inspect } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, relative, resolve } from 'node:path';
import {
  clearWorktreeCache,
  resolveWorkingDirectoryOrLinkedWorktree,
  validateWorkingDirectoryOrLinkedWorktree,
  ForeignWorkingDirectoryError,
  getCanonicalWorkingDirectoryRoots,
} from '../../lib/worktree-paths.js';
import { wikiQueryTool, wikiReadTool } from '../../tools/wiki-tools.js';

function git(cwd: string, command: string): void {
  execSync(`git ${command}`, { cwd, stdio: 'pipe' });
}

function canonical(path: string): string {
  return realpathSync(path);
}
function loggerLikeWrap(value: unknown): unknown {
  if (value instanceof Error) {
    const wrapped: Record<string, unknown> = { ...value };
    wrapped.name = value.name;
    wrapped.message = value.message;
    wrapped.cause = value.cause !== undefined ? loggerLikeWrap(value.cause) : undefined;
    return wrapped;
  }
  if (value !== null && typeof value === 'object') {
    return { ...value };
  }
  return value;
}

function assertOpaqueCanonicalSerialization(
  value: { callerLabel: string },
  opts: { providedRoot: string; trustedRoot: string; callerLabel: string },
): void {
  const roots = getCanonicalWorkingDirectoryRoots(value);
  expect(roots.providedRoot).toBe(opts.providedRoot);
  expect(roots.trustedRoot).toBe(opts.trustedRoot);
  expect(value.callerLabel).toBe(opts.callerLabel);

  expect(Object.getOwnPropertyDescriptor(value, 'providedRoot')).toBeUndefined();
  expect(Object.getOwnPropertyDescriptor(value, 'trustedRoot')).toBeUndefined();
  expect(Object.getOwnPropertyNames(value)).not.toContain('providedRoot');
  expect(Object.getOwnPropertyNames(value)).not.toContain('trustedRoot');
  expect(Reflect.ownKeys(value)).not.toContain('providedRoot');
  expect(Reflect.ownKeys(value)).not.toContain('trustedRoot');
  const caller = Object.getOwnPropertyDescriptor(value, 'callerLabel');
  expect(caller?.enumerable).toBe(true);
  expect(caller?.value).toBe(opts.callerLabel);
  expect(Object.keys(value)).not.toContain('providedRoot');
  expect(Object.keys(value)).not.toContain('trustedRoot');
  expect(Object.keys(value)).toContain('callerLabel');

  const spread = { ...value };
  expect(spread).not.toHaveProperty('providedRoot');
  expect(spread).not.toHaveProperty('trustedRoot');
  expect(spread.callerLabel).toBe(opts.callerLabel);

  const cloned = structuredClone(value);
  expect(() => getCanonicalWorkingDirectoryRoots(cloned as object)).toThrow();
  const wrappedError = new Error('logger wrap', { cause: value as unknown as Error });
  const clonedWrapper = structuredClone(wrappedError);
  const payloads = [
    JSON.stringify(value),
    JSON.stringify(spread),
    JSON.stringify(cloned),
    JSON.stringify(loggerLikeWrap(value)),
    JSON.stringify(loggerLikeWrap(wrappedError)),
    JSON.stringify({ err: value, cause: value }),
    JSON.stringify({ ...clonedWrapper, cause: clonedWrapper.cause }),
    inspect(value, { depth: 8, getters: true, showHidden: false }),
    inspect(value, { depth: 8, getters: true, showHidden: true, customInspect: false }),
  ];

  for (const path of [opts.providedRoot, opts.trustedRoot]) {
    for (const payload of payloads) {
      expect(payload).not.toContain(path);
    }
  }

  const parsed = JSON.parse(JSON.stringify(value)) as { callerLabel?: string };
  expect(parsed.callerLabel).toBe(opts.callerLabel);
  expect(parsed).not.toHaveProperty('providedRoot');
  expect(parsed).not.toHaveProperty('trustedRoot');
}


describe('shared resolver #3858: foreign repo, linked worktree, non-git, same-root', () => {
  let tempDir: string;
  let originalCwd: string;
  let sessionRepo: string;
  let foreignRepo: string;
  let linkedWorktree: string;
  let plainDir: string;
  let canonicalSession: string;
  let canonicalForeign: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), 'resolver-3858-'));
    clearWorktreeCache();

    sessionRepo = join(tempDir, 'session-project');
    mkdirSync(sessionRepo, { recursive: true });
    git(sessionRepo, 'init');
    git(sessionRepo, 'config user.email "test@example.com"');
    git(sessionRepo, 'config user.name "Test User"');
    writeFileSync(join(sessionRepo, 'README.md'), 'session\n');
    git(sessionRepo, 'add README.md');
    git(sessionRepo, 'commit -m initial');

    foreignRepo = join(tempDir, 'foreign-vault');
    mkdirSync(foreignRepo, { recursive: true });
    git(foreignRepo, 'init');
    git(foreignRepo, 'config user.email "test@example.com"');
    git(foreignRepo, 'config user.name "Test User"');
    writeFileSync(join(foreignRepo, 'README.md'), 'vault\n');
    git(foreignRepo, 'add README.md');
    git(foreignRepo, 'commit -m initial');

    linkedWorktree = join(tempDir, 'session-linked');
    git(sessionRepo, `worktree add -b linked ${linkedWorktree}`);

    plainDir = join(tempDir, 'plain-notes');
    mkdirSync(plainDir, { recursive: true });

    process.chdir(sessionRepo);
    clearWorktreeCache();
    canonicalSession = canonical(sessionRepo);
    canonicalForeign = canonical(foreignRepo);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    clearWorktreeCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolveWorkingDirectoryOrLinkedWorktree returns foreign_repository for a different repo, never a root', () => {
    const resolution = resolveWorkingDirectoryOrLinkedWorktree(foreignRepo);
    expect(resolution.status).toBe('foreign_repository');
    if (resolution.status !== 'foreign_repository') return;
    const foreignRoots = getCanonicalWorkingDirectoryRoots(resolution);
    expect(foreignRoots.providedRoot).toBe(canonicalForeign);
    expect(foreignRoots.trustedRoot).toBe(canonicalSession);
    expect(resolution.callerLabel).toBe(foreignRepo);
    expect('root' in resolution).toBe(false);
    expect(resolution).toEqual({
      status: 'foreign_repository',
      callerLabel: foreignRepo,
    });
  });

  it('validateWorkingDirectoryOrLinkedWorktree throws ForeignWorkingDirectoryError instead of substituting', () => {
    expect(() => validateWorkingDirectoryOrLinkedWorktree(foreignRepo)).toThrow(ForeignWorkingDirectoryError);
    try {
      validateWorkingDirectoryOrLinkedWorktree(foreignRepo);
      expect.unreachable('must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ForeignWorkingDirectoryError);
      const foreign = error as ForeignWorkingDirectoryError;
      expect(getCanonicalWorkingDirectoryRoots(foreign).providedRoot).toBe(canonicalForeign);
      expect(getCanonicalWorkingDirectoryRoots(foreign).trustedRoot).toBe(canonicalSession);
      expect(foreign.callerLabel).toBe(foreignRepo);
      expect(foreign.message).toContain('belongs to a different repository');
      expect(foreign.message).toContain('not used');
      expect(foreign.message).toContain(foreignRepo);
      expect(foreign.message).toContain(basename(sessionRepo));
      expect(foreign.message).not.toContain(canonicalSession);
    }
  });

  it('ForeignWorkingDirectoryError requires callerLabel and never renders canonical provided/trusted roots', () => {
    const error = new ForeignWorkingDirectoryError(
      '/canonical/foreign-vault',
      '/canonical/session-project',
      '../foreign-vault',
    );
    expect(error.callerLabel).toBe('../foreign-vault');
    expect(getCanonicalWorkingDirectoryRoots(error).providedRoot).toBe('/canonical/foreign-vault');
    expect(getCanonicalWorkingDirectoryRoots(error).trustedRoot).toBe('/canonical/session-project');
    expect(error.message).toContain('../foreign-vault');
    expect(error.message).toContain('session-project');
    expect(error.message).not.toContain('/canonical/foreign-vault');
    expect(error.message).not.toContain('/canonical/session-project');
    assertOpaqueCanonicalSerialization(error, {
      providedRoot: '/canonical/foreign-vault',
      trustedRoot: '/canonical/session-project',
      callerLabel: '../foreign-vault',
    });
    const inspected = inspect(error, { depth: 8, getters: true, showHidden: false });
    expect(inspected).toContain('at ');
    expect(inspected).toContain('../foreign-vault');
    expect(inspected).not.toContain('/canonical/foreign-vault');
    expect(inspected).not.toContain('/canonical/session-project');
    const sourceFile = fileURLToPath(import.meta.url);
    const sourceRoot = resolve(sourceFile, '../../../..');
    const overlapping = new ForeignWorkingDirectoryError(
      sourceFile,
      sourceRoot,
      '../foreign-vault',
    );
    const overlappingInspect = inspect(overlapping, { depth: 8, getters: true, showHidden: false });
    const rawInspect = inspect(overlapping, { depth: 8, customInspect: false, showHidden: false });
    expect(overlappingInspect).toContain('at ');
    expect(overlappingInspect).toContain('../foreign-vault');
    expect(overlappingInspect).not.toContain(sourceFile);
    expect(overlappingInspect).not.toContain(sourceRoot);
    expect(overlappingInspect).toContain('<redacted>');
    expect(overlapping.stack).toContain('at ');
    expect(overlapping.stack).not.toContain(sourceFile);
    expect(overlapping.stack).not.toContain(sourceRoot);
    expect(rawInspect).not.toContain(sourceFile);
    expect(rawInspect).not.toContain(sourceRoot);
    expect(JSON.stringify({ message: overlapping.message, stack: overlapping.stack })).not.toContain(sourceRoot);
    const absoluteCaller = sourceFile;
    const absoluteError = new ForeignWorkingDirectoryError(absoluteCaller, sourceRoot, absoluteCaller);
    expect(absoluteError.message).toContain(absoluteCaller);
    expect(absoluteError.stack).toContain(absoluteCaller);
    expect(inspect(absoluteError)).toContain(absoluteCaller);
    const absoluteFrames = (absoluteError.stack ?? '').split('\n').slice(1).join('\n');
    expect(absoluteFrames).not.toContain(sourceRoot);
    expect(absoluteFrames).not.toContain(sourceFile);
  });
  it('redacts percent-encoded file-URL stack frames for roots with spaces', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session project-'));
    const probe = join(dir, 'probe.mjs');
    const moduleHref = pathToFileURL(resolve(originalCwd, 'src/lib/worktree-paths.ts')).href;
    const rootHref = pathToFileURL(dir).href;
    writeFileSync(
      probe,
      `import { ForeignWorkingDirectoryError } from ${JSON.stringify(moduleHref)};
import { inspect } from 'node:util';
const root = ${JSON.stringify(dir)};
const err = new ForeignWorkingDirectoryError(root, root, '../alias');
const frames = (err.stack ?? '').split('\\n').slice(1).join('\\n');
process.stdout.write(JSON.stringify({
  frames,
  inspect: inspect(err),
  fileUrl: ${JSON.stringify(rootHref)},
}));
`,
    );
    const output = execSync(`npx tsx ${JSON.stringify(probe)}`, {
      encoding: 'utf8',
      cwd: originalCwd,
    });
    const parsed = JSON.parse(output) as { frames: string; inspect: string; fileUrl: string };
    expect(parsed.frames).not.toContain(dir);
    expect(parsed.frames).not.toContain(parsed.fileUrl);
    expect(parsed.inspect).toContain('../alias');
    expect(parsed.inspect).not.toContain(parsed.fileUrl);
  });


  it('foreign_repository resolution and thrown error keep canonical roots opaque under serialization', () => {
    const relativeAlias = join('..', 'foreign-vault');
    const resolution = resolveWorkingDirectoryOrLinkedWorktree(relativeAlias);
    expect(resolution.status).toBe('foreign_repository');
    if (resolution.status !== 'foreign_repository') return;

    assertOpaqueCanonicalSerialization(resolution, {
      providedRoot: canonicalForeign,
      trustedRoot: canonicalSession,
      callerLabel: relativeAlias,
    });

    try {
      validateWorkingDirectoryOrLinkedWorktree(relativeAlias);
      expect.unreachable('must throw');
    } catch (error) {
      const foreign = error as ForeignWorkingDirectoryError;
      expect(foreign.message).toContain(relativeAlias);
      expect(foreign.message).not.toContain(canonicalForeign);
      expect(foreign.message).not.toContain(canonicalSession);
      expect(foreign.message).toContain(basename(sessionRepo));
      assertOpaqueCanonicalSerialization(foreign, {
        providedRoot: canonicalForeign,
        trustedRoot: canonicalSession,
        callerLabel: relativeAlias,
      });
    }
  });

  it('relative foreign alias keeps the caller-supplied label and hides canonical host paths', () => {
    const relativeAlias = join('..', 'foreign-vault');
    const resolution = resolveWorkingDirectoryOrLinkedWorktree(relativeAlias);
    expect(resolution.status).toBe('foreign_repository');
    if (resolution.status !== 'foreign_repository') return;

    expect(getCanonicalWorkingDirectoryRoots(resolution).providedRoot).toBe(canonicalForeign);
    expect(getCanonicalWorkingDirectoryRoots(resolution).trustedRoot).toBe(canonicalSession);
    expect(resolution.callerLabel).toBe(relativeAlias);

    try {
      validateWorkingDirectoryOrLinkedWorktree(relativeAlias);
      expect.unreachable('must throw');
    } catch (error) {
      const foreign = error as ForeignWorkingDirectoryError;
      expect(foreign.message).toContain(relativeAlias);
      expect(foreign.message).not.toContain(canonicalForeign);
      expect(foreign.message).not.toContain(canonicalSession);
      expect(foreign.message).toContain(basename(sessionRepo));
    }
  });

  it('symlink foreign alias keeps the symlink label and hides the canonical target', () => {
    const symlinkAlias = join(tempDir, 'foreign-alias');
    symlinkSync(foreignRepo, symlinkAlias);

    const resolution = resolveWorkingDirectoryOrLinkedWorktree(symlinkAlias);
    expect(resolution.status).toBe('foreign_repository');
    if (resolution.status !== 'foreign_repository') return;

    expect(getCanonicalWorkingDirectoryRoots(resolution).providedRoot).toBe(canonicalForeign);
    expect(resolution.callerLabel).toBe(symlinkAlias);

    try {
      validateWorkingDirectoryOrLinkedWorktree(symlinkAlias);
      expect.unreachable('must throw');
    } catch (error) {
      const foreign = error as ForeignWorkingDirectoryError;
      expect(foreign.message).toContain(symlinkAlias);
      expect(foreign.message).not.toContain(canonicalForeign);
      expect(foreign.message).not.toContain(canonicalSession);
    }
  });

  it('accepts a linked worktree of the same repository (preserves #2880)', () => {
    expect(validateWorkingDirectoryOrLinkedWorktree(linkedWorktree)).toBe(canonical(linkedWorktree));
    expect(resolveWorkingDirectoryOrLinkedWorktree(linkedWorktree)).toEqual({
      status: 'ok',
      root: canonical(linkedWorktree),
    });
  });

  it('accepts the same root and a subdirectory of the trusted repo', () => {
    expect(validateWorkingDirectoryOrLinkedWorktree(sessionRepo)).toBe(canonicalSession);
    expect(validateWorkingDirectoryOrLinkedWorktree()).toBe(canonicalSession);

    const sub = join(sessionRepo, 'docs');
    mkdirSync(sub, { recursive: true });
    // Non-repo directory inside the trusted root normalizes to the trusted root.
    expect(validateWorkingDirectoryOrLinkedWorktree(sub)).toBe(canonicalSession);
  });

  it('still throws for a non-git path outside the trusted root without leaking the full trusted root', () => {
    expect(() => validateWorkingDirectoryOrLinkedWorktree(plainDir)).toThrow(
      'is outside the trusted worktree root'
    );
    try {
      validateWorkingDirectoryOrLinkedWorktree(plainDir);
      expect.unreachable('must throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain(plainDir);
      expect(message).toContain(basename(sessionRepo));
      expect(message).not.toContain(canonicalSession);
    }
  });

  it('rejects a superproject path from a submodule cwd without leaking canonical trusted/foreign roots', () => {
    const parentDir = join(tempDir, 'superproject');
    mkdirSync(parentDir, { recursive: true });
    git(parentDir, 'init');
    git(parentDir, 'config user.email "test@example.com"');
    git(parentDir, 'config user.name "Test User"');
    git(parentDir, 'commit --allow-empty -m parent-init');
    execSync(`git -c protocol.file.allow=always submodule add "${sessionRepo}" mysub`, {
      cwd: parentDir,
      stdio: 'pipe',
    });
    const submodulePath = join(parentDir, 'mysub');
    process.chdir(submodulePath);
    clearWorktreeCache();

    const canonicalSubmodule = canonical(submodulePath);
    const canonicalParent = canonical(parentDir);
    const relativeParent = relative(submodulePath, parentDir);

    expect(() => validateWorkingDirectoryOrLinkedWorktree(parentDir)).toThrow(ForeignWorkingDirectoryError);

    const resolution = resolveWorkingDirectoryOrLinkedWorktree(relativeParent);
    expect(resolution.status).toBe('foreign_repository');
    if (resolution.status !== 'foreign_repository') return;
    expect(resolution.callerLabel).toBe(relativeParent);
    expect(getCanonicalWorkingDirectoryRoots(resolution).providedRoot).toBe(canonicalParent);

    try {
      validateWorkingDirectoryOrLinkedWorktree(relativeParent);
      expect.unreachable('must throw');
    } catch (error) {
      const foreign = error as ForeignWorkingDirectoryError;
      expect(foreign.message).toContain(relativeParent);
      expect(foreign.message).toContain(basename(submodulePath));
      expect(foreign.message).not.toContain(canonicalSubmodule);
      expect(foreign.message).not.toContain(canonicalParent);
    }
  });

  it('nested git metadata with a failed probe rejects instead of falling back to the trusted root', () => {
    const nested = join(sessionRepo, 'vendor', 'nested-foreign');
    mkdirSync(nested, { recursive: true });
    git(nested, 'init');
    git(nested, 'config user.email "test@example.com"');
    git(nested, 'config user.name "Test User"');
    writeFileSync(join(nested, 'README.md'), 'nested\n');
    git(nested, 'add README.md');
    git(nested, 'commit -m nested');
    rmSync(join(nested, '.git'), { recursive: true, force: true });
    writeFileSync(join(nested, '.git'), 'gitdir: /nonexistent-omc-3858-gitdir\n');
    clearWorktreeCache();

    expect(() => validateWorkingDirectoryOrLinkedWorktree(nested)).toThrow(/git probe failed and was not used/);
    expect(() => resolveWorkingDirectoryOrLinkedWorktree(nested)).toThrow(/git probe failed and was not used/);
  });
  it('same-repo subdirectory fails closed when git is missing from PATH', () => {
    const sub = join(sessionRepo, 'docs');
    mkdirSync(sub, { recursive: true });
    const originalPath = process.env.PATH;
    process.env.PATH = '';
    clearWorktreeCache();
    try {
      expect(() => validateWorkingDirectoryOrLinkedWorktree(sub)).toThrow(/git probe failed and was not used/);
    } finally {
      process.env.PATH = originalPath;
      clearWorktreeCache();
    }
  });


  it('linked-worktree wiki flows keep working end to end (no regression from #2880)', async () => {
    const readResult = await wikiReadTool.handler({ page: 'missing', workingDirectory: linkedWorktree });
    expect(readResult.isError).toBe(true);
    expect(readResult.content[0].text).toContain('Wiki page not found: missing.md');
    expect(readResult.content[0].text).not.toContain('different repository');

    const queryResult = await wikiQueryTool.handler({ query: 'anything', workingDirectory: linkedWorktree });
    expect(queryResult.isError).toBeUndefined();
    expect(queryResult.content[0].text).toContain('No wiki pages match "anything"');
    expect(existsSync(join(sessionRepo, '.omc', 'wiki'))).toBe(false);
  });
});
