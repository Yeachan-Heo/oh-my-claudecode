import { describe, test, expect } from 'vitest';
import { mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { commands, digitVersions, makeCache, PLUGIN_ID, read, runCommand, scriptText, skillText, writeRegistry } from './helpers/omc-doctor-cache-fixture.js';

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

// The launcher of the CLI replaces <config>/.omc-launch at every launch: the old one moves to a .prev sibling that is deleted at once, and an
// unfinished .next sibling is deleted too, so a recovery copy under any of the three would be gone with them. The script imports nothing from
// src/, so it writes the name itself; the launcher is the one source, read here as text.
const launcher = read('src/cli/launch.ts');
const LAUNCH = /const OMC_RUNTIME_DIRNAME = '([^']+)';/.exec(launcher)?.[1] ?? '';
const LAUNCH_DIRS = [LAUNCH, `${LAUNCH}.prev`, `${LAUNCH}.next`];
const REFUSED_LAUNCH = /Nothing moved: the backup directory \S+ (?:\(really \S+\) )?(?:is, or lies inside,|contains) the launch directory of the profile \(/;

describe.runIf(posix)('omc-doctor: the backup directory is kept out of the launch directory of the profile', { timeout: 180_000 }, () => {
  test.each(LAUNCH_DIRS.map((name) => [name]))('both cache commands refuse, with exit code 1, a named tree and nothing moved, when plugins/backups leads into %s', (name) => {
    for (const command of commands) {
      const { dir, cache } = profile();
      try {
        const recovery = path.join(dir, name, 'recovery');
        mkdirSync(recovery, { recursive: true });
        link(recovery, path.join(dir, 'plugins', 'backups'));
        const result = runCommand(command, dir, { timeout: 20_000 });
        expect({ command, status: result.status, refused: REFUSED_LAUNCH.test(result.stdout), cache: digitVersions(cache), landed: readdirSync(recovery) })
          .toEqual({ command, status: 1, refused: true, cache: ALL, landed: [] });
        expect(result.stdout).not.toMatch(/Moved \d/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // Control: launch directories that exist are no reason to refuse; a backup directory outside them keeps working.
  test.each([['the default backup directory', ''], ['a link to a directory outside them', 'elsewhere']])('both cache commands move the free versions as before, with %s and all three launch directories present', (_name, where) => {
    for (const command of commands) {
      const { dir, cache } = profile();
      try {
        for (const name of LAUNCH_DIRS) mkdirSync(path.join(dir, name, 'recovery'), { recursive: true });
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

  // The name and the two siblings are the launcher's: the script has to list the names the launcher uses.
  test('the script names the three directories the launcher writes, as the launcher spells them', () => {
    expect(LAUNCH).not.toBe('');
    expect(launcher).toContain('join(baseConfigDir, OMC_RUNTIME_DIRNAME)');
    expect(launcher).toContain('`${runtimeConfigDir}.prev`');
    expect(launcher).toContain('`${runtimeConfigDir}.next`');
    for (const name of LAUNCH_DIRS) expect(scriptText).toContain(`'${name}'`);
  });
});

// The delivery guard of the session start removes a whole session directory of <config>/.omc/state/sessions when its state file is older than 14 days (once a day),
// and adding a copy there does not renew that file, so a recovery copy under it would be gone with the session. The script imports nothing from scripts/lib, so it
// writes the path itself; the guard is the one source, read here as text.
const guard = read('scripts/lib/jev-delivery-guard.mjs');
const REFUSED_SESSIONS = /Nothing moved: the backup directory \S+ (?:\(really \S+\) )?(?:is, or lies inside,|contains) the session state of the profile \(/;
const SESSIONS = ['.omc', 'state', 'sessions'];

describe.runIf(posix)('omc-doctor: the backup directory is kept out of the session state of the profile', { timeout: 180_000 }, () => {
  test.each([['a session directory', ['abc123', 'recovery']], ['the sessions directory itself', []]])('both cache commands refuse, with exit code 1, a named tree and nothing moved, when plugins/backups leads into %s', (_name, below) => {
    for (const command of commands) {
      const { dir, cache } = profile();
      try {
        const recovery = path.join(dir, ...SESSIONS, ...below);
        mkdirSync(recovery, { recursive: true });
        link(recovery, path.join(dir, 'plugins', 'backups'));
        const result = runCommand(command, dir, { timeout: 20_000 });
        expect({ command, status: result.status, refused: REFUSED_SESSIONS.test(result.stdout), cache: digitVersions(cache), landed: readdirSync(recovery) })
          .toEqual({ command, status: 1, refused: true, cache: ALL, landed: [] });
        expect(result.stdout).not.toMatch(/Moved \d/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // Control: session directories that exist are no reason to refuse; a backup directory outside them keeps working.
  test.each([['the default backup directory', ''], ['a link to a directory beside them', path.join('.omc', 'state', 'other')]])('both cache commands move the free versions as before, with %s and a session directory present', (_name, where) => {
    for (const command of commands) {
      const { dir, cache } = profile();
      try {
        mkdirSync(path.join(dir, ...SESSIONS, 'abc123'), { recursive: true });
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

  // The path is the guard's: the script has to list the one the guard sweeps.
  test('the script names the directory the guard sweeps, as the guard spells it', () => {
    expect(guard).toContain("join(configDir, '.omc', 'state', 'sessions')");
    expect(guard).toContain('rmSync(sessionDir, { recursive: true, force: true })');
    expect(scriptText).toContain("path.join(configDir, '.omc', 'state', 'sessions')");
  });
});
