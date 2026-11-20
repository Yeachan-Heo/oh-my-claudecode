import { describe, test, expect } from 'vitest';
import { existsSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addCache, backupDir, commands, digitVersions, makeCache, movedAside, PLUGIN_ID, runCommand, skillText, writeRegistry, writeRegistryFile } from './helpers/omc-doctor-cache-fixture.js';

// The two cache commands refuse to move anything when they cannot tell what is protected, and report a move that failed.
// A refusal or a failure ends with exit code 1 and says why; a finished move, an empty cache and a cache nothing pins
// (and the other cases that only say nothing was to do) end with 0, so the code and the text always agree.
const posix = process.platform !== 'win32';
const run = (command: string, dir: string) => {
  const result = runCommand(command, dir, { timeout: 20_000 });
  expect(result.error).toBeUndefined();
  return { status: result.status, out: result.stdout };
};

describe('omc-doctor cache commands: exit code of a refusal and of a failure', { timeout: 120_000 }, () => {
  test('a finished move, nothing to move, no pin and no cache end with 0', () => {
    for (const command of commands) {
      const moved = makeCache(['5.7.0', '5.8.1', '5.9.0']);
      const allPinned = makeCache(['5.8.1']);
      const noPin = makeCache(['5.7.0', '5.8.1']);
      const noCache = makeCache(['5.7.0']);
      try {
        writeRegistry(moved.dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }] });
        writeRegistry(allPinned.dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }] });
        rmSync(noCache.cache, { recursive: true, force: true });
        expect(run(command, moved.dir)).toMatchObject({ status: 0, out: expect.stringContaining('Moved 2 unprotected version(s)') });
        expect(run(command, allPinned.dir)).toMatchObject({ status: 0, out: expect.stringContaining('Nothing to move') });
        expect(run(command, noPin.dir)).toMatchObject({ status: 0, out: expect.stringContaining('Nothing moved: no pinned') });
        expect(run(command, noCache.dir)).toMatchObject({ status: 0, out: expect.stringMatching(/No plugin cache found|No cache to clean/) });
      } finally {
        for (const w of [moved, allPinned, noPin, noCache]) rmSync(w.dir, { recursive: true, force: true });
      }
    }
  });

  test('a registry that cannot be read completely: nothing moves, exit code 1, and the message says what it found', () => {
    const bad: Array<[string, () => unknown, RegExp]> = [
      ['not JSON', () => '{not json', /not a regular file or not JSON of the expected shape/],
      // JSON.parse rejects a byte order mark, as the installer's reader does, so the registry counts as unreadable.
      ['a byte order mark', () => `\uFEFF${JSON.stringify({ plugins: { [PLUGIN_ID]: [{ scope: 'user', version: '5.9.0' }] } })}`, /not a regular file or not JSON of the expected shape/],
      ['a version outside the grammar', () => ({ [PLUGIN_ID]: [{ scope: 'user', version: '999x.0.0' }] }), /an entry of oh-my-claudecode@omc has version "999x\.0\.0", which is not a semantic version/],
      ['a short version', () => ({ [PLUGIN_ID]: [{ scope: 'user', version: '1.2' }] }), /an entry of oh-my-claudecode@omc has version "1\.2", which is not a semantic version/],
      ['an entry with neither field', () => ({ [PLUGIN_ID]: [{ scope: 'user' }] }), /an entry of oh-my-claudecode@omc has no usable version or installPath/],
      ['a look-alike key', () => ({ 'oh-my-claudecode-fork@x': [{ version: '1.0.0' }] }), /oh-my-claudecode-fork@x looks like OMC but is not a plugin ID the installer accepts/],
      ['an empty list', () => ({ [PLUGIN_ID]: [] }), /oh-my-claudecode@omc has no list of entries/],
    ];
    for (const command of commands) {
      for (const [label, content, reason] of bad) {
        const { dir, cache } = makeCache(['5.7.0', '5.8.1', '5.9.0']);
        try {
          if (typeof content() === 'string') writeRegistryFile(dir, content());
          else writeRegistry(dir, content() as Record<string, unknown>);
          const { status, out } = run(command, dir);
          expect({ label, status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ label, status: 1, versions: '5.7.0,5.8.1,5.9.0', moved: 0 });
          expect({ label, out }).toEqual({ label, out: expect.stringContaining('then run this again (cause: ') });
          expect({ label, out }).toEqual({ label, out: expect.stringMatching(reason) });
          expect(out).toContain('fix that first, then run this again');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  test('a move that fails reports it and ends with exit code 1', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.7.0', '5.8.1']);
      try {
        writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }] });
        // plugins/backups is a file, so the directory for the backups cannot be made.
        writeFileSync(path.join(dir, 'plugins', 'backups'), 'not a directory');
        const { status, out } = run(command, dir);
        expect({ status, versions: digitVersions(cache) }).toEqual({ status: 1, versions: '5.7.0,5.8.1' });
        expect(out).toMatch(/Cache move failed \(0 moved before the error\): /);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('a cache directory that cannot be read is reported with its error code and ends with exit code 1', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.7.0']);
      try {
        rmSync(cache, { recursive: true, force: true });
        writeFileSync(cache, 'a file where the cache directory should be');
        const { status, out } = run(command, dir);
        expect(status).toBe(1);
        expect(out).toMatch(/Nothing moved: could not read .* \(ENOTDIR\)/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

// The installPath of an entry of OMC written as a Windows path cannot be read on another system: before, it protected
// nothing, so the install it names (reached on WSL through /mnt/c) was moved. It is an unreadable entry like any other.
describe.skipIf(!posix)('omc-doctor cache commands: an installPath written as a Windows path on another system', { timeout: 120_000 }, () => {
  const foreign = ['C:\\Users\\u\\.claude\\plugins\\cache\\omc\\oh-my-claudecode\\5.8.1', 'c:/Users/u/.claude/plugins/cache/omc/oh-my-claudecode/5.8.1', '\\\\server\\share\\.claude\\plugins\\cache\\omc\\oh-my-claudecode\\5.8.1', 'D:\\5.8.1'];

  test('the command moves nothing, says which entry and path made it so, and ends with exit code 1', () => {
    for (const command of commands) {
      for (const installPath of foreign) {
        const { dir, cache } = makeCache(['5.7.0', '5.8.1', '5.9.0']);
        try {
          writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.7.0' }, { scope: 'user', installPath }] });
          const { status, out } = run(command, dir);
          expect({ installPath, status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ installPath, status: 1, versions: '5.7.0,5.8.1,5.9.0', moved: 0 });
          expect(out).toContain(`an entry of ${PLUGIN_ID} has the Windows path ${JSON.stringify(installPath)} as installPath, which this system cannot read`);
          expect(out).toContain('Nothing moved');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  test('paths that only look similar, and the Windows path of another plugin, are no refusal', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.7.0', '5.8.1', '5.9.0']);
      try {
        const colon = path.join(dir, 'a:', 'x');
        mkdirSync(colon, { recursive: true });
        writeRegistry(dir, {
          [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }, { scope: 'project', installPath: colon }, { scope: 'project', installPath: path.join(dir, 'C', 'relative', 'looking') }],
          'other-plugin@market': [{ scope: 'user', installPath: 'C:\\Users\\u\\other' }],
        });
        const { status, out } = run(command, dir);
        expect({ status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ status: 0, versions: '5.8.1', moved: 2 });
        expect(out).toContain('Moved 2 unprotected version(s)');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

// An installPath that is not absolute names another directory for each directory the command runs in (the installer adds
// it as written, without resolving it): a pin written that way protected the cache of the profile only when the shell
// of the model happened to stand in the configuration directory. It is an unreadable entry, so the answer does not depend
// on where the command runs.
describe('omc-doctor cache commands: an installPath that is not absolute', { timeout: 120_000 }, () => {
  const relative = ['plugins/cache/omc/oh-my-claudecode/5.8.1', './plugins/cache/omc/oh-my-claudecode/5.8.1', '../elsewhere/5.8.1', 'current'];

  test('the command moves nothing, says which entry and path made it so, and answers alike from every working directory', () => {
    for (const command of commands) {
      for (const installPath of relative) {
        for (const owner of [PLUGIN_ID, 'other-plugin@market']) {
          const { dir, cache } = makeCache(['5.7.0', '5.8.1', '5.9.0']);
          const elsewhere = mkdtempSync(path.join(tmpdir(), 'omc-doctor-cwd-'));
          try {
            writeRegistry(
              dir,
              owner === PLUGIN_ID
                ? { [PLUGIN_ID]: [{ scope: 'user', version: '5.7.0' }, { scope: 'user', installPath }] }
                : { [PLUGIN_ID]: [{ scope: 'user', version: '5.7.0' }], [owner]: [{ scope: 'user', installPath }] },
            );
            const answers = [dir, elsewhere].map((cwd) => {
              const result = runCommand(command, dir, { timeout: 20_000, cwd });
              expect(result.error).toBeUndefined();
              return { status: result.status, out: result.stdout };
            });
            expect({ installPath, owner, ...answers[0] }).toEqual({ installPath, owner, ...answers[1] });
            expect({ installPath, owner, status: answers[0].status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ installPath, owner, status: 1, versions: '5.7.0,5.8.1,5.9.0', moved: 0 });
            expect(answers[0].out).toContain(`an entry of ${owner} has the relative path ${JSON.stringify(installPath)} as installPath, which names another directory for each directory the command runs in`);
            expect(answers[0].out).toContain('Nothing moved');
          } finally {
            rmSync(dir, { recursive: true, force: true });
            rmSync(elsewhere, { recursive: true, force: true });
          }
        }
      }
    }
  });

  test('the skill names the refusal among the unreadable sources of the cache guard', () => {
    expect(skillText).toContain('an `installPath` of any entry that is not absolute (it names another directory for each directory the command runs in)');
  });

  test('an absolute installPath and an entry with only a version are no refusal', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.7.0', '5.8.1', '5.9.0']);
      try {
        writeRegistry(dir, {
          [PLUGIN_ID]: [{ scope: 'user', version: '5.7.0' }, { scope: 'user', installPath: path.join(cache, '5.8.1') }],
          'other-plugin@market': [{ scope: 'user', version: '1.0.0' }],
        });
        const { status, out } = run(command, dir);
        expect({ status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ status: 0, versions: '5.7.0,5.8.1', moved: 1 });
        expect(out).toContain('Moved 1 unprotected version(s)');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

// A modification date far in the future (a wrong clock, files extracted from an archive) keeps a version in place like a
// recent change does, but it is not "modified in the last 10 minutes": it is named for what it is.
describe('omc-doctor cache commands: a modification date in the future', { timeout: 120_000 }, () => {
  const setDate = (file: string, minutesFromNow: number) => {
    const when = new Date(Date.now() + minutesFromNow * 60_000);
    lutimesSync(file, when, when);
  };

  test('more than 5 minutes ahead: the version stays, the message names the date, not a recent change; the others still move', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.6.0', '5.7.0', '5.8.1']);
      try {
        writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }] });
        setDate(path.join(cache, '5.7.0', 'package.json'), 60 * 24 * 365);
        const { status, out } = run(command, dir);
        expect({ status, versions: digitVersions(cache), moved: movedAside(dir) }).toEqual({ status: 0, versions: '5.7.0,5.8.1', moved: 1 });
        expect(readdirSync(backupDir(dir))[0]).toMatch(/^5\.6\.0-/);
        expect(out).toContain('Left 1 version(s) alone that have a modification date more than 5 minutes in the future');
        expect(out).not.toContain('modified in the last 10 minutes');
        expect(existsSync(path.join(cache, '5.7.0'))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('a few minutes ahead is clock skew of a recent change: it is reported as one', () => {
    for (const command of commands) {
      const { dir, cache } = makeCache(['5.7.0', '5.8.1']);
      try {
        writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }] });
        setDate(path.join(cache, '5.7.0', 'package.json'), 3);
        const { status, out } = run(command, dir);
        expect({ status, versions: digitVersions(cache) }).toEqual({ status: 0, versions: '5.7.0,5.8.1' });
        expect(out).toContain('modified in the last 10 minutes');
        expect(out).not.toContain('in the future');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

// The cache commands name the backup of a version `<version>-<time>` (`<marketplace>-<version>-<time>` for another
// marketplace). A rename would replace an empty directory of that name, so the command looks first and stops.
describe('omc-doctor: the cache commands never move a version onto an existing backup name', { timeout: 120_000 }, () => {
  test.each(commands)('%s: an existing destination stops the move, nothing is replaced, the exit code is 1', (command) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'omc-doctor-backup-'));
    try {
      const cache = addCache(dir, ['5.7.0', '5.8.1']);
      writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.1' }] });
      // Time stands still for the command, so the destination of 5.7.0 is known: backups/5.7.0-<now>.
      const now = Date.now();
      const preload = path.join(dir, 'frozen.cjs');
      writeFileSync(preload, `const t = ${now};\nDate.now = () => t;\n`);
      const taken = path.join(backupDir(dir), `5.7.0-${now}`);
      mkdirSync(taken, { recursive: true });
      const result = runCommand(command, dir, { preloads: [preload], timeout: 20_000 });
      expect({ status: result.status, versions: digitVersions(cache), taken: readdirSync(taken) }).toEqual({ status: 1, versions: '5.7.0,5.8.1', taken: [] });
      expect(result.stdout + result.stderr).toContain(`the backup destination ${taken} exists already`);
      // Without the occupied name the same command moves the version aside (the control).
      rmSync(taken, { recursive: true, force: true });
      const control = runCommand(command, dir, { preloads: [preload], timeout: 20_000 });
      expect({ status: control.status, versions: digitVersions(cache), moved: readdirSync(backupDir(dir)) }).toEqual({ status: 0, versions: '5.8.1', moved: [`5.7.0-${now}`] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
