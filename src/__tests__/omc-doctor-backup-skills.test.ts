import { describe, test, expect } from 'vitest';
import { mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { commands, digitVersions, makeCache, PLUGIN_ID, runCommand, skillText, writeRegistry } from './helpers/omc-doctor-cache-fixture.js';

// The setup of the installer removes whole directories of the standalone skills of the profile (the ones that duplicate a
// skill of the plugin, and the stale ones it created itself), so a recovery copy kept under <config>/skills would go
// with the skill that contains it. Which directories that is depends on the plugin and on the files, so the whole
// skills directory is a tree the backup directory has to lie outside of, like the cache. Links are made with
// symlinkSync, which needs no privilege on POSIX alone, so this file runs on POSIX.
const posix = process.platform !== 'win32';
const REFUSED = /Nothing moved: the backup directory \S+ (?:\(really \S+\) )?(?:is, or lies inside,|contains) the standalone skills of the profile \(/;
const ALL = '5.7.0,5.8.0,5.9.0';

const link = (target: string, at: string) => {
  mkdirSync(path.dirname(at), { recursive: true });
  symlinkSync(target, at);
};
// 5.8.0 is pinned, 5.7.0 and 5.9.0 are free and old.
const profile = () => {
  const { dir, cache } = makeCache(['5.7.0', '5.8.0', '5.9.0']);
  writeRegistry(dir, { [PLUGIN_ID]: [{ scope: 'user', version: '5.8.0', installPath: path.join(cache, '5.8.0') }] });
  return { dir, cache };
};
// A standalone skill the installer would prune: its SKILL.md is the copy of the plugin, or the directory carries the managed marker.
const skillAt = (skills: string, name: string, how: 'same-text' | 'marker') => {
  mkdirSync(path.join(skills, name), { recursive: true });
  writeFileSync(path.join(skills, name, 'SKILL.md'), how == 'same-text' ? skillText : '---\nname: kept-by-marker\n---\nown text\n');
  if (how == 'marker') writeFileSync(path.join(skills, name, '.omc-managed'), 'omc-managed\n');
};

describe.runIf(posix)('omc-doctor: the backup directory is kept out of the standalone skills of the profile', { timeout: 180_000 }, () => {
  // The reported case is plugins/backups as a link to <config>/skills/omc-doctor/recovery; omc-learned and .omc-trash are left alone by the
  // installer, but one rule covers the whole directory (nothing there is a place for a copy).
  test.each([
    ['a skill whose SKILL.md is the copy of the plugin', 'omc-doctor', 'same-text'],
    ['a skill that carries the managed marker', 'omc-doctor', 'marker'],
    ['omc-learned', 'omc-learned', 'marker'],
    ['.omc-trash', '.omc-trash', 'marker'],
  ] as const)('both cache commands refuse, with exit code 1, a named tree and nothing moved, when plugins/backups leads into %s', (_name, skill, how) => {
    for (const command of commands) {
      const { dir, cache } = profile();
      try {
        const skills = path.join(dir, 'skills');
        skillAt(skills, skill, how);
        const recovery = path.join(skills, skill, 'recovery');
        mkdirSync(recovery);
        link(recovery, path.join(dir, 'plugins', 'backups'));
        const result = runCommand(command, dir, { timeout: 20_000 });
        expect({ command, status: result.status, refused: REFUSED.test(result.stdout), cache: digitVersions(cache), landed: readdirSync(recovery) })
          .toEqual({ command, status: 1, refused: true, cache: ALL, landed: [] });
        expect(result.stdout).not.toMatch(/Moved \d/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // The skills directory itself may be a link to another directory: the installer removes what lies in the target, so the target is the tree.
  test('both cache commands refuse the same when the skills directory is a link, and the backup directory lies in the directory it leads to', () => {
    for (const command of commands) {
      const { dir, cache } = profile();
      try {
        const shared = path.join(dir, 'shared-skills');
        skillAt(shared, 'omc-doctor', 'same-text');
        const recovery = path.join(shared, 'omc-doctor', 'recovery');
        mkdirSync(recovery);
        link(shared, path.join(dir, 'skills'));
        link(recovery, path.join(dir, 'plugins', 'backups'));
        const result = runCommand(command, dir, { timeout: 20_000 });
        expect({ command, status: result.status, refused: REFUSED.test(result.stdout), cache: digitVersions(cache), landed: readdirSync(recovery) })
          .toEqual({ command, status: 1, refused: true, cache: ALL, landed: [] });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // Control: skills that exist are no reason to refuse; a backup directory outside them (the default one, or a link to another directory) keeps working.
  test.each([['the default backup directory', ''], ['a link to a directory outside skills', 'elsewhere']])('both cache commands move the free versions as before, with %s and a skills directory that holds skills', (_name, where) => {
    for (const command of commands) {
      const { dir, cache } = profile();
      try {
        skillAt(path.join(dir, 'skills'), 'omc-doctor', 'same-text');
        skillAt(path.join(dir, 'skills'), 'my-own-skill', 'marker');
        if (where) {
          mkdirSync(path.join(dir, where, 'recovery'), { recursive: true });
          link(path.join(dir, where, 'recovery'), path.join(dir, 'plugins', 'backups'));
        }
        const result = runCommand(command, dir, { timeout: 20_000 });
        expect({ command, status: result.status, moved: /Moved 2/.test(result.stdout), cache: digitVersions(cache) }).toEqual({ command, status: 0, moved: true, cache: '5.8.0' });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
