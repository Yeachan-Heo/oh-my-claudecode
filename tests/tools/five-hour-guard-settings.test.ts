// Behaviour tests of the settings tool of the five-hour limit guard (tools/five-hour-guard/five-hour-guard-settings.py):
// check, add, remove on copies of settings.json in a temporary directory (see five-hour-guard-support.ts), and the hook
// command that `add` writes, run through `sh -c` the way Claude Code runs it.
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, rmSync, readFileSync, linkSync, lstatSync, mkdirSync, readdirSync, readlinkSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENV, CONFIG_DIR, ENTRY_MODULE, GUARD as GUARD_SCRIPT, HAS_PYTHON3, HOOK, PYBIN, SETTINGS_TOOL, TMP, cleanup, fixture, readJson, readText, runCommand, runPyCode, runSync, sleep,
  writePause, type Fixture,
} from './five-hour-guard-support.js';

afterAll(cleanup);

// Another program writes settings.json between the read of the tool and its replace: the wrapper acts when the tool creates its
// temporary file (mode backup: when it creates the backup). Modes: content (changed, modification time put back), mtime (only the
// modification time moves), chmod (only the mode is tightened to 0600), always, backup (as content, but at the creation of the backup).
const RACE_DRIVER = [
  'import json, os, runpy, sys',
  'mode, settings = sys.argv[1], sys.argv[2]',
  'sys.argv = sys.argv[3:]',
  'count = [0]',
  'real_open = os.open',
  'def other_writer(path, *args, **kwargs):',
  "    if (str(path).endswith('.tmp')) if mode != 'backup' else ('before-five-hour-guard' in str(path)):",
  '        count[0] += 1',
  "        if mode == 'always' or count[0] == 1:",
  '            st = os.stat(settings)',
  "            if mode == 'mtime':",
  '                os.utime(settings, ns=(st.st_atime_ns, st.st_mtime_ns + 5000000000))',
  "            elif mode == 'chmod':",
  '                os.chmod(settings, 0o600)',
  '            else:',
  '                data = json.load(open(settings))',
  "                data['other_writer_%d' % count[0]] = True",
  "                with open(settings, 'w') as f:",
  '                    json.dump(data, f, indent=2)',
  "                    f.write('\\n')",
  "                if mode in ('content', 'backup'):",
  '                    os.utime(settings, ns=(st.st_atime_ns, st.st_mtime_ns))',
  '    return real_open(path, *args, **kwargs)',
  'os.open = other_writer',
  "runpy.run_path(sys.argv[0], run_name='__main__')",
].join('\n');
// Records how the tool creates its files (path, O_EXCL, mode asked for) under the umask given as the first argument.
const OPEN_SPY_DRIVER = [
  'import json, os, runpy, sys',
  'log, umask = sys.argv[1], int(sys.argv[2], 8)',
  'sys.argv = sys.argv[3:]',
  'os.umask(umask)',
  'seen = []',
  'real_open = os.open',
  'def spy(path, flags, mode=0o777, *args, **kwargs):',
  "    if '.tmp' in str(path) or 'before-five-hour-guard' in str(path):",
  "        seen.append({'path': os.path.basename(str(path)), 'excl': bool(flags & os.O_EXCL), 'mode': mode})",
  '    return real_open(path, flags, mode, *args, **kwargs)',
  'os.open = spy',
  'try:',
  "    runpy.run_path(sys.argv[0], run_name='__main__')",
  'finally:',
  "    json.dump(seen, open(log, 'w'))",
].join('\n');

/** shlex.quote of Python: what `add` writes around a path. */
const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'"'"'`)}'`);

describe.skipIf(!HAS_PYTHON3)('five-hour guard settings tool', { timeout: 90000 }, () => {
  const base = () => ({
    env: { OMC_X: '1' },
    hooks: {
      PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: '/x/other-hook.py', timeout: 10 }] }],
      Stop: [{ hooks: [{ type: 'command', command: '/x/stop-hook.py' }] }],
    },
    model: 'opus',
    note: 'café über 日本語', // non-ASCII text must come back as it was, not as \uXXXX escapes
  });
  const tool = (f: Fixture, action: string, extra: string[] = []) =>
    runSync(SETTINGS_TOOL, [action, '--settings', f.settings, '--pause-file', f.pause, '--hook-log', f.hookLog, '--hook', HOOK, '--python', PYBIN, ...extra]);
  const backups = (f: Fixture) => readdirSync(f.dir).filter((n) => n.startsWith('settings.json.before-five-hour-guard-'));
  const entryCommand = (f: Fixture, python = PYBIN) =>
    `[ -f ${quote(f.pause)} ] && [ -f ${quote(HOOK)} ] && [ -r ${quote(HOOK)} ] && [ -x ${quote(python)} ] || exit 0; exec ${quote(python)} -I ${quote(HOOK)} --pause-file ${quote(f.pause)} --log ${quote(f.hookLog)}`;
  const write = (f: Fixture, doc: unknown) => writeFileSync(f.settings, JSON.stringify(doc, null, 2) + '\n', 'utf8');

  it('check, add, add again, remove: backup, atomic replace, rest of the file unchanged', () => {
    const f = fixture('settings-basic');
    const original = JSON.stringify(base(), null, 2) + '\n';
    writeFileSync(f.settings, original, 'utf8');
    chmodSync(f.settings, 0o600);
    const hardLink = join(f.dir, 'settings.hardlink');
    linkSync(f.settings, hardLink); // a second name of the old file: a replace-by-rename leaves it with the old content

    expect(tool(f, 'check').status, 'check: no entry yet').toBe(1);
    const add = tool(f, 'add');
    expect(add.status, add.stderr).toBe(0);
    expect(backups(f)).toHaveLength(1);
    expect(readText(join(f.dir, backups(f)[0])), 'the backup is the original file').toBe(original);
    expect(readText(hardLink), 'atomic write: the old inode keeps the old content').toBe(original);
    expect(statSync(f.settings).mode & 0o777, 'file mode kept').toBe(0o600);
    expect(readdirSync(f.dir).some((n) => n.endsWith('.tmp')), 'no temporary file left').toBe(false);
    const expected = base();
    expected.hooks.PreToolUse.push({ matcher: '*', hooks: [{ type: 'command', command: entryCommand(f), timeout: 21600 }] } as never);
    expect(readJson(f.settings), 'only the hook entry is added, the rest is unchanged').toEqual(expected);
    expect(tool(f, 'check').status).toBe(0);

    const bytes = readText(f.settings);
    const again = tool(f, 'add');
    expect(again.status).toBe(0);
    expect(again.stdout).toMatch(/already registered, nothing to do/);
    expect(readText(f.settings), 'add twice changes nothing').toBe(bytes);
    expect(backups(f), 'add twice makes no new backup').toHaveLength(1);

    const rm = tool(f, 'remove');
    expect(rm.status, rm.stderr).toBe(0);
    expect(readText(f.settings), 'remove restores the original bytes').toBe(original);
    expect(backups(f)).toHaveLength(2);
    expect(tool(f, 'remove').stdout).toMatch(/nothing to do/);
    expect(backups(f), 'remove with no entry makes no backup').toHaveLength(2);
  });

  it('an entry with another hook path is replaced in place, in one write, between the entries around it', () => {
    const f = fixture('settings-moved');
    const doc = base();
    const old = { matcher: '*', hooks: [{ type: 'command', command: '[ -f /p ] || exit 0; exec python3 -I /old/dir/five-hour-guard-hook.py --pause-file /p', timeout: 21600 }] };
    doc.hooks.PreToolUse.splice(1, 0, old as never); // between two other entries: the position matters
    doc.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: '/x/last.py' }] } as never);
    write(f, doc);

    expect(tool(f, 'check').status, 'the old entry is ours: it is found by the hook file name').toBe(0);
    const r = tool(f, 'add');
    expect(r.status, r.stderr).toBe(0);
    const pre = readJson(f.settings).hooks.PreToolUse;
    expect(pre, 'replaced, not appended').toHaveLength(3);
    expect(pre[1].hooks[0].command, 'the new entry sits where the old one was').toBe(entryCommand(f));
    expect(pre[0].hooks[0].command).toBe('/x/other-hook.py');
    expect(pre[2].hooks[0].command).toBe('/x/last.py');
    expect({ ...readJson(f.settings), hooks: null }).toEqual({ ...base(), hooks: null });
  });

  it('the written command lets the call through when the hook script cannot be read: Python would exit 2, the status that blocks the tool call', () => {
    const f = fixture('settings-hook-unreadable');
    write(f, base());
    const hook = join(f.dir, 'five-hour-guard-hook.py');
    copyFileSync(HOOK, hook);
    const root = process.getuid?.() === 0;
    const python = root && existsSync('/usr/bin/python3') ? '/usr/bin/python3' : PYBIN;   // root reads any file: the command is run as another user, who has to reach the interpreter
    const add = runSync(SETTINGS_TOOL, ['add', '--settings', f.settings, '--pause-file', f.pause, '--hook', hook, '--python', python]);
    expect(add.status, add.stderr).toBe(0);
    const cmd: string = readJson(f.settings).hooks.PreToolUse.at(-1).hooks[0].command;
    writePause(f);   // any regular file is enough for the shell check: this one is a valid pause
    chmodSync(TMP, 0o755);
    chmodSync(hook, 0o000);
    const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', env: ENV, timeout: 20000, ...(root ? { uid: 65534, gid: 65534 } : {}) });
    expect(r.status, `${r.error}${r.stdout}${r.stderr}`).toBe(0);
    expect(`${r.stdout}${r.stderr}`, 'silent').toBe('');
  });

  it('the written command runs: a missing hook file, interpreter or pause file is fail-open (exit 0, silent), a valid pause holds the session and logs it', async () => {
    const f = fixture('settings-command');
    write(f, base());
    expect(tool(f, 'add').status).toBe(0);
    const cmd: string = readJson(f.settings).hooks.PreToolUse.at(-1).hooks[0].command;
    const silentExit0 = async (command: string, what: string) => {
      const p = runCommand(command, 'other0001');
      await Promise.race([p.done, sleep(20000)]);
      expect(p.exited && p.code === 0 && p.out === '' && p.err === '', what).toBe(true);
      await p.stop();
    };
    await silentExit0(cmd, 'no pause file');
    writePause(f);
    await silentExit0(cmd.split(HOOK).join(join(TMP, 'absent-hook.py')), 'pause in force, hook script missing: not exit 2');
    await silentExit0(cmd.split(PYBIN).join(join(TMP, 'absent-python')), 'pause in force, interpreter missing: not exit 127');
    const c = runCommand(cmd, 'other0001'); // pause in force, everything present
    await sleep(700);
    expect(c.exited, 'held').toBe(false);
    expect(readText(f.hookLog)).toMatch(/hold-start other000 Bash/);
    unlinkSync(f.pause);
    await Promise.race([c.done, sleep(20000)]);
    expect(c.exited && c.code === 0).toBe(true);
    expect(readText(f.hookLog)).toMatch(/hold-end other000 Bash waited=\d+s/);
  });

  it('the interpreter defaults to the path the tool was started with, not to a fixed one', () => {
    const f = fixture('settings-python');
    write(f, base());
    const link = join(f.dir, 'python-link'); // another name for the same interpreter: only "the one that runs the tool" gives this path
    symlinkSync(PYBIN, link);
    const r = spawnSync(link, ['-I', SETTINGS_TOOL, 'add', '--settings', f.settings, '--pause-file', f.pause, '--hook', HOOK], { encoding: 'utf8', env: ENV, timeout: 60000 });
    expect(r.status, r.stderr).toBe(0);
    expect(readJson(f.settings).hooks.PreToolUse.at(-1).hooks[0].command).toBe(entryCommand(f, link).replace(` --log ${quote(f.hookLog)}`, ''));
  });

  it('a foreign hook that shares a group with ours survives add and remove', () => {
    const f = fixture('settings-mixed');
    write(f, { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/x/foreign-audit.py' }, { type: 'command', command: 'exec /usr/bin/python3 -I /old/five-hour-guard-hook.py --pause-file /old/pause.json' }] }] } });
    expect(tool(f, 'add').status).toBe(0);
    const pre = readJson(f.settings).hooks.PreToolUse;
    expect(pre).toHaveLength(2);
    expect(pre[0].hooks[0].command, 'our entry first, where the group was').toBe(entryCommand(f));
    expect(pre[1], 'the foreign hook stays with its matcher').toEqual({ matcher: 'Bash', hooks: [{ type: 'command', command: '/x/foreign-audit.py' }] });
    expect(tool(f, 'remove').status).toBe(0);
    expect(readJson(f.settings).hooks.PreToolUse, 'remove takes only our hook').toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: '/x/foreign-audit.py' }] }]);

    const shared = fixture('settings-mixed-remove'); // `remove` on a group that still holds both hooks, as another tool may have written it
    write(shared, { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/x/foreign-audit.py' }, { type: 'command', command: entryCommand(shared) }] }] } });
    expect(tool(shared, 'remove').status).toBe(0);
    expect(readJson(shared.settings).hooks.PreToolUse, 'the foreign hook of the shared group stays').toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: '/x/foreign-audit.py' }] }]);
  });

  it('a settings.json that is a symbolic link is written through: the file it points to gets the entry, the link stays a link', () => {
    const f = fixture('settings-symlink');
    const real = join(f.dir, 'dotfiles');
    mkdirSync(real);
    const target = join(real, 'settings-real.json');
    const original = JSON.stringify(base(), null, 2) + '\n';
    writeFileSync(target, original, 'utf8');
    chmodSync(target, 0o640);
    symlinkSync(target, f.settings);
    const add = tool(f, 'add');
    expect(add.status, add.stderr).toBe(0);
    expect(lstatSync(f.settings).isSymbolicLink(), 'still a link').toBe(true);
    expect(readlinkSync(f.settings)).toBe(target);
    expect(readJson(target).hooks.PreToolUse.at(-1).hooks[0].command, 'the file behind the link has the entry').toBe(entryCommand(f));
    expect(statSync(target).mode & 0o777, 'the mode of the file behind the link is kept').toBe(0o640);
    expect(readdirSync(real), 'no temporary file, no backup in the directory behind the link').toEqual(['settings-real.json']);
    expect(backups(f), 'the backup sits next to the link').toHaveLength(1);
    expect(readText(join(f.dir, backups(f)[0]))).toBe(original);
    expect(tool(f, 'remove').status).toBe(0);
    expect(readText(target), 'remove goes through the link too').toBe(original);
    expect(lstatSync(f.settings).isSymbolicLink()).toBe(true);
  });

  it('a settings.json written by another program while the tool works is not overwritten blindly: it is read again once, then the tool gives up', () => {
    const run = (name: string, mode: string) => {
      const f = fixture(name);
      write(f, base());
      const r = runPyCode(RACE_DRIVER, [mode, f.settings, SETTINGS_TOOL, 'add', '--settings', f.settings, '--pause-file', f.pause, '--hook-log', f.hookLog, '--hook', HOOK, '--python', PYBIN]);
      return { f, r };
    };
    const c = run('settings-race-content', 'content'); // the content changes, the modification time is put back: only the content comparison sees it
    expect(c.r.status, c.r.stderr).toBe(0);
    expect(c.r.stderr).toMatch(/changed while it was being updated, reading it again/);
    const doc = readJson(c.f.settings);
    expect(doc.other_writer_1, 'the change of the other program is kept').toBe(true);
    expect(doc.hooks.PreToolUse.at(-1).hooks[0].command, 'and our entry is added').toBe(entryCommand(c.f));
    expect(backups(c.f), 'one backup, of the file as it was when it was written over').toHaveLength(1);
    expect(readJson(join(c.f.dir, backups(c.f)[0])).other_writer_1).toBe(true);

    const m = run('settings-race-mtime', 'mtime'); // only the modification time moves
    expect(m.r.status, m.r.stderr).toBe(0);
    expect(m.r.stderr).toMatch(/reading it again/);
    expect(readJson(m.f.settings).hooks.PreToolUse.at(-1).hooks[0].command).toBe(entryCommand(m.f));

    const a = run('settings-race-always', 'always'); // the file changes every time: give up
    expect(a.r.status).toBe(2);
    expect(a.r.stderr).toMatch(/changed again while it was being updated: nothing was written/);
    expect(readJson(a.f.settings).other_writer_2, 'the file is what the other program wrote').toBe(true);
    expect(readText(a.f.settings)).not.toContain('five-hour-guard-hook');
    expect(readdirSync(a.f.dir).some((n) => n.endsWith('.tmp')), 'no temporary file left').toBe(false);
    expect(backups(a.f), 'no backup of a file that was not replaced').toHaveLength(0);
  });

  it('a mode that another program changes while the tool works is kept: the snapshot holds the mode, so the file is read again instead of replaced with the old mode', () => {
    const f = fixture('settings-race-chmod');
    write(f, base());
    chmodSync(f.settings, 0o644);
    // the other program tightens the mode when the tool has made its temporary file: the bytes and the modification time stay as they were
    const r = runPyCode(RACE_DRIVER, ['chmod', f.settings, SETTINGS_TOOL, 'add', '--settings', f.settings, '--pause-file', f.pause, '--hook-log', f.hookLog, '--hook', HOOK, '--python', PYBIN]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr, 'the change is seen').toMatch(/changed while it was being updated, reading it again/);
    expect(statSync(f.settings).mode & 0o777, 'the tightened mode is kept').toBe(0o600);
    expect(readJson(f.settings).hooks.PreToolUse.at(-1).hooks[0].command, 'and our entry is added').toBe(entryCommand(f));
    expect(backups(f)).toHaveLength(1);
    expect(statSync(join(f.dir, backups(f)[0])).mode & 0o777, 'the backup has the mode of the file it copies').toBe(0o600);
  });

  it('a write that lands while the backup is being made is not lost: the comparison runs after the backup, right before the replace', () => {
    const f = fixture('settings-race-backup');
    write(f, base());
    const r = runPyCode(RACE_DRIVER, ['backup', f.settings, SETTINGS_TOOL, 'add', '--settings', f.settings, '--pause-file', f.pause, '--hook-log', f.hookLog, '--hook', HOOK, '--python', PYBIN]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/reading it again/);
    const doc = readJson(f.settings);
    expect(doc.other_writer_1, 'the change made during the backup is kept').toBe(true);
    expect(doc.hooks.PreToolUse.at(-1).hooks[0].command, 'and our entry is added').toBe(entryCommand(f));
    expect(backups(f), 'the backup of the abandoned attempt is gone, one backup is left').toHaveLength(1);
    expect(readJson(join(f.dir, backups(f)[0])).other_writer_1, 'and it holds the file as it was when it was written over').toBe(true);
    expect(readdirSync(f.dir).some((n) => n.endsWith('.tmp')), 'no temporary file left').toBe(false);
  });

  it('the temporary file and the backup are created readable by the owner only and get the mode of the original before any content is written', () => {
    for (const umask of ['0', '77']) {
      const f = fixture(`settings-modes-${umask}`);
      write(f, base());
      chmodSync(f.settings, 0o644);
      const spyLog = join(f.dir, 'open-calls.json');
      const r = runPyCode(OPEN_SPY_DRIVER, [spyLog, umask, SETTINGS_TOOL, 'add', '--settings', f.settings, '--pause-file', f.pause, '--hook', HOOK, '--python', PYBIN]);
      expect(r.status, r.stderr).toBe(0);
      const seen: Array<{ path: string; excl: boolean; mode: number }> = readJson(spyLog);
      expect(seen.map((c) => (c.path.endsWith('.tmp') ? 'tmp' : 'backup')).sort(), `umask ${umask}: both files are created by os.open`).toEqual(['backup', 'tmp']);
      for (const c of seen) {
        expect(c.excl, `${c.path}: created exclusively`).toBe(true);
        expect(c.mode & 0o077, `${c.path}: created with no access for group and others, whatever the umask`).toBe(0);
      }
      expect(statSync(f.settings).mode & 0o777, `umask ${umask}: the mode of the original is restored`).toBe(0o644);
      expect(statSync(join(f.dir, backups(f)[0])).mode & 0o777, `umask ${umask}: the backup has the mode of the original`).toBe(0o644);
    }
  });

  it('a missing settings.json: add creates it with mode 0600, remove has nothing to do, check says it is not installed', () => {
    const f = fixture('settings-missing');
    const check = tool(f, 'check');
    expect(check.status).toBe(1);
    expect(check.stdout).toMatch(/does not exist, the guard hook is not installed/);
    const rm = tool(f, 'remove');
    expect(rm.status, rm.stderr).toBe(0);
    expect(rm.stdout).toMatch(/no settings file, nothing to do/);
    expect(existsSync(f.settings), 'remove creates nothing').toBe(false);
    const add = tool(f, 'add');
    expect(add.status, add.stderr).toBe(0);
    expect(add.stdout).toMatch(/the file did not exist, it was created/);
    expect(readJson(f.settings)).toEqual({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: entryCommand(f), timeout: 21600 }] }] } });
    expect(statSync(f.settings).mode & 0o777).toBe(0o600);
    expect(backups(f), 'nothing to back up').toHaveLength(0);
    const nodir = tool({ ...f, settings: join(f.dir, 'no-such-dir', 'settings.json') }, 'add');
    expect(nodir.status, 'the directory has to exist').toBe(2);
    expect(nodir.stderr).toMatch(/the directory of .* does not exist/);
  });

  it('the default settings path takes CLAUDE_CONFIG_DIR like the guard and OMC do: surrounding blanks removed, a leading ~ expanded', () => {
    const f = fixture('settings-tilde');
    const home = join(f.dir, 'home');
    mkdirSync(join(home, 'cfg'), { recursive: true });
    mkdirSync(join(home, '.claude'), { recursive: true });
    for (const dir of ['cfg', '.claude']) writeFileSync(join(home, dir, 'settings.json'), JSON.stringify(base(), null, 2) + '\n', 'utf8');
    const env = { ...ENV, HOME: home, USERPROFILE: home };
    const viaTilde = runSync(SETTINGS_TOOL, ['check'], { env: { ...env, CLAUDE_CONFIG_DIR: '  ~/cfg  ' } });
    expect(viaTilde.status, viaTilde.stderr).toBe(1);
    expect(viaTilde.stdout).toContain(join(home, 'cfg', 'settings.json'));
    const viaBackslash = runSync(SETTINGS_TOOL, ['check'], { env: { ...env, CLAUDE_CONFIG_DIR: '~\\cfg' } });
    expect(viaBackslash.stdout, 'the ~\\ form is expanded like OMC does').toContain(join(home, 'cfg', 'settings.json'));
    const blank = runSync(SETTINGS_TOOL, ['check'], { env: { ...env, CLAUDE_CONFIG_DIR: '   ' } });
    expect(blank.stdout, 'a blank value counts as unset').toContain(join(home, '.claude', 'settings.json'));
  });

  it('the registration block of the README installs and checks, it does not remove (copying it whole must leave the hook registered)', () => {
    const readme = readFileSync(join(dirname(SETTINGS_TOOL), 'README.md'), 'utf8');
    const step = readme.slice(readme.indexOf('3. Register the hook'));
    const block = step.split('```')[1];
    const actions = [...block.matchAll(/five-hour-guard-settings\.py (\w+)/g)].map((m) => m[1]);
    expect(actions).toEqual(['add', 'check']);
  });

  it('add refuses a hook file whose name is not the one the entry is recognised by, so every accepted entry can be checked and removed', () => {
    const f = fixture('settings-renamed-hook');
    const original = JSON.stringify(base(), null, 2) + '\n';
    writeFileSync(f.settings, original, 'utf8');
    const renamed = join(f.dir, 'hold.py');
    copyFileSync(HOOK, renamed);
    const r = tool(f, 'add', ['--hook', renamed]);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/file name .* five-hour-guard-hook\.py/);
    expect(readText(f.settings), 'nothing written').toBe(original);
    expect(backups(f), 'no backup either').toHaveLength(0);
    const copy = join(f.dir, 'opt', 'five-hour-guard-hook.py');
    mkdirSync(join(f.dir, 'opt'));
    copyFileSync(HOOK, copy);
    expect(tool(f, 'add', ['--hook', copy]).status, 'the same file name in another directory is accepted').toBe(0);
    expect(tool(f, 'check').status, 'and found by check').toBe(0);
    expect(tool(f, 'remove').stdout, 'and removed').toMatch(/remove: done/);
    expect(readJson(f.settings).hooks.PreToolUse, 'nothing of ours is left').toEqual(base().hooks.PreToolUse);
  });

  it('a path key of the configuration that is not a string is refused with exit 2 and a message, not a traceback', () => {
    const f = fixture('settings-cfg-types');
    for (const key of ['pause_file', 'settings_file', 'hook_log_file']) {
      writeFileSync(f.cfg, JSON.stringify({ pause_file: f.pause, settings_file: f.settings, hook_log_file: f.hookLog, [key]: 42 }), 'utf8');
      for (const action of ['add', 'check']) {
        const r = runSync(SETTINGS_TOOL, [action, '--config', f.cfg, '--hook', HOOK, '--python', PYBIN]);
        expect(r.status, `${key}, ${action}: ${r.stderr}`).toBe(2);
        expect(r.stderr).toContain(`"${key}" must be a string`);
        expect(r.stderr).not.toContain('Traceback');
      }
    }
  });

  it('the README says that sessions already running and the headless AFK sessions need attention', () => {
    const readme = readFileSync(join(dirname(SETTINGS_TOOL), 'README.md'), 'utf8').replace(/\s+/g, ' ');
    expect(readme, 'AFK and factory sessions skip user-level hooks').toContain('OMC_AFK_INCLUDE_USER_SETTINGS=1');
    expect(readme, 'a hook snapshot is kept by running sessions').toMatch(/restart each session/i);
    expect(readme, 'no claim that edits are picked up while a session runs').not.toMatch(/normally picks up edits/);
  });

  it('add refuses an interpreter that cannot run the hook: not executable, or one that fails on the hook (so a successful add can hold calls)', () => {
    const f = fixture('settings-interpreter');
    const original = JSON.stringify(base(), null, 2) + '\n';
    writeFileSync(f.settings, original, 'utf8');
    const noExec = join(f.dir, 'python-no-exec');
    writeFileSync(noExec, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    chmodSync(noExec, 0o644);
    const broken = join(f.dir, 'python-broken');
    writeFileSync(broken, '#!/bin/sh\necho "boom: this is not python" >&2\nexit 1\n', { mode: 0o755 });
    chmodSync(broken, 0o755);
    const ignores = join(f.dir, 'python-ignores-args');
    writeFileSync(ignores, '#!/bin/sh\nexit 0\n', { mode: 0o755 });  // executable and successful, but it never runs Python
    chmodSync(ignores, 0o755);
    const r0 = tool(f, 'add', ['--python', ignores]);
    expect(r0.status, `${r0.stdout}${r0.stderr}`).toBe(2);
    expect(r0.stderr).toMatch(/interpreter .* cannot run the hook/);
    const r1 = tool(f, 'add', ['--python', noExec]);
    expect(r1.status, `${r1.stdout}${r1.stderr}`).toBe(2);
    expect(r1.stderr).toMatch(/interpreter .* is not executable/);
    const r2 = tool(f, 'add', ['--python', broken]);
    expect(r2.status, `${r2.stdout}${r2.stderr}`).toBe(2);
    expect(r2.stderr).toMatch(/interpreter .* cannot run the hook/);
    expect(readText(f.settings), 'nothing written').toBe(original);
    expect(backups(f), 'no backup either').toHaveLength(0);
  });

  it('add refuses a pause file, hook log, hook or interpreter that is the same file as another of them or as settings.json', () => {
    const f = fixture('settings-aliases');
    const original = JSON.stringify(base(), null, 2) + '\n';
    writeFileSync(f.settings, original, 'utf8');
    const link = join(f.dir, 'pause-link.json');
    symlinkSync(f.settings, link);
    for (const extra of [['--pause-file', f.settings], ['--pause-file', link], ['--hook-log', f.settings], ['--hook-log', f.pause], ['--pause-file', HOOK]]) {
      const r = tool(f, 'add', extra);
      expect(r.status, `${extra.join(' ')}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(/are the same file/);
      expect(readText(f.settings), 'settings.json is untouched').toBe(original);
    }
    expect(tool(f, 'add').status, 'distinct files are fine').toBe(0);
  });

  it('the configuration file is not overwritten by the tool: settings_file or pause_file naming it is refused and the file is kept', () => {
    const f = fixture('settings-alias-config');
    for (const key of ['settings_file', 'pause_file', 'hook_log_file']) {
      const text = JSON.stringify({ pause_file: f.pause, settings_file: f.settings, hook_log_file: f.hookLog, [key]: f.cfg });
      writeFileSync(f.cfg, text, 'utf8');
      for (const action of key === 'settings_file' ? ['add', 'remove', 'check'] : ['add']) { // the other two keys are used by add only
        const r = runSync(SETTINGS_TOOL, [action, '--config', f.cfg, '--hook', HOOK, '--python', PYBIN]);
        expect(r.status, `${key}, ${action}: ${r.stdout}${r.stderr}`).toBe(2);
        expect(r.stderr).toMatch(/same file/);
        expect(readText(f.cfg), `${key}, ${action}: the configuration file is untouched`).toBe(text);
      }
    }
  });

  it('add refuses a log, state file or usage cache of the configuration that is the default settings.json (no settings_file in the configuration)', () => {
    const f = fixture('settings-alias-default');
    const configDir = join(f.dir, 'claude-config');
    mkdirSync(configDir, { recursive: true });
    const settings = join(configDir, 'settings.json');
    const text = JSON.stringify(base(), null, 2) + '\n';
    for (const key of ['log_file', 'state_file', 'usage_cache']) {
      writeFileSync(settings, text, 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ pause_file: f.pause, [key]: settings }), 'utf8');
      const r = runSync(SETTINGS_TOOL, ['add', '--config', f.cfg, '--hook', HOOK, '--python', PYBIN], { env: { ...ENV, CLAUDE_CONFIG_DIR: configDir } });
      expect(r.status, `${key}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(/same file/);
      expect(readText(settings), `${key}: settings.json is untouched`).toBe(text);
    }
  });

  it('a path with a NUL character in the configuration is refused with exit 2; a settings file that is not UTF-8, empty or a directory is an error, not a crash', () => {
    const f = fixture('settings-forms');
    for (const key of ['pause_file', 'settings_file', 'hook_log_file']) {
      writeFileSync(f.cfg, JSON.stringify({ pause_file: f.pause, settings_file: f.settings, hook_log_file: f.hookLog, [key]: `${f.dir}/a\u0000b` }), 'utf8');
      const r = runSync(SETTINGS_TOOL, ['add', '--config', f.cfg, '--hook', HOOK, '--python', PYBIN]);
      expect(r.status, `${key}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(/NUL/);
      expect(r.stderr).not.toMatch(/Traceback/);
    }
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x7b]);
    for (const [label, make] of [['not UTF-8', () => writeFileSync(f.settings, bytes)], ['empty', () => writeFileSync(f.settings, '')],
      ['a directory', () => { rmSync(f.settings, { force: true }); mkdirSync(f.settings, { recursive: true }); }]] as Array<[string, () => void]>) {
      rmSync(f.settings, { recursive: true, force: true });
      make();
      for (const action of ['check', 'add', 'remove']) {
        const r = tool(f, action);
        expect(r.status, `${label}, ${action}: ${r.stdout}${r.stderr}`).toBe(2);
        expect(r.stderr, `${label}, ${action}`).not.toMatch(/Traceback/);
      }
    }
  });

  it('add refuses a state file, log or usage cache of the configuration that is a script of the guard or of this tool', () => {
    const f = fixture('settings-alias-scripts');
    const dir = join(f.dir, 'installed');
    mkdirSync(dir, { recursive: true });
    const tool2 = join(dir, 'five-hour-guard-settings.py');
    const guard = join(dir, 'five-hour-guard.py');
    copyFileSync(SETTINGS_TOOL, tool2);
    copyFileSync(GUARD_SCRIPT, guard);
    copyFileSync(ENTRY_MODULE, join(dir, 'five_hour_guard_entry.py'));
    const hookCopy = join(dir, 'five-hour-guard-hook.py');
    copyFileSync(HOOK, hookCopy);
    const guardText = readText(guard);
    for (const [key, target] of [['state_file', guard], ['log_file', guard], ['usage_cache', tool2]] as const) {
      writeFileSync(f.cfg, JSON.stringify({ pause_file: f.pause, settings_file: f.settings, [key]: target }), 'utf8');
      const r = runSync(tool2, ['add', '--config', f.cfg, '--hook', hookCopy, '--python', PYBIN]);
      expect(r.status, `${key}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(/same file/);
      expect(readText(guard), 'the script is intact').toBe(guardText);
    }
  });

  it('add refuses a pause file that is the lock file of the usage cache of the configuration', () => {
    const f = fixture('settings-cache-lock');
    const original = JSON.stringify(base(), null, 2) + '\n';
    writeFileSync(f.settings, original, 'utf8');
    const cache = join(f.dir, 'usage-cache.json');
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: cache, pause_file: `${cache}.lock`, settings_file: f.settings }), 'utf8');
    const r = runSync(SETTINGS_TOOL, ['add', '--config', f.cfg, '--hook', HOOK, '--python', PYBIN]);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/same file/);
    expect(readText(f.settings)).toBe(original);
  });

  it('a handler that is not a command is not our hook: check does not report it, add registers a real entry next to it', () => {
    const f = fixture('settings-handler-type');
    write(f, { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'prompt', command: 'x /old/five-hour-guard-hook.py' }] }] } });
    expect(tool(f, 'check').status).toBe(1);
    expect(tool(f, 'add').status).toBe(0);
    const pre = readJson(f.settings).hooks.PreToolUse;
    expect(pre).toHaveLength(2);
    expect(pre[0].hooks[0].type, 'the other handler stays as it was').toBe('prompt');
    expect(tool(f, 'check').status).toBe(0);
  });

  it('a Python is recognised by its whole file name: python, python3, python3.12, pythonw.exe, pypy3 and py run our hook when they are given it, python-audit and the like do not', () => {
    for (const [name, ours] of [['python', true], ['python3', true], ['python3.12', true], ['pythonw', true], ['pythonw.exe', true], ['python.exe', true], ['pypy', true], ['pypy3', true], ['py', true],
      ['/usr/bin/python3', true], ['python-audit', false], ['python3-audit', false], ['pythonista', false], ['pypy-audit', false], ['pyaudit', false], ['/opt/python-audit', false]] as const) {
      const f = fixture(`settings-python-name-${name.replace(/\W/g, '_')}`);
      write(f, { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `${name} /opt/five-hour-guard-hook.py` }] }] } });
      expect(tool(f, 'check').status, `${name} /opt/five-hour-guard-hook.py: ${ours ? 'our hook' : 'a command that has the hook file as data'}`).toBe(ours ? 0 : 1);
    }
  });

  it('a command that only names the hook file as data is not our hook: check does not report it, add and remove leave it alone', () => {
    const f = fixture('settings-foreign-operand');
    const foreign = [
      '/x/foreign-audit.py /opt/five-hour-guard-hook.py',
      '/opt/python-audit /tmp/five-hour-guard-hook.py',
      'pypy-audit /tmp/five-hour-guard-hook.py',
      'grep -c five-hour-guard-hook.py /var/log/audit.log',
      'python3 /x/audit.py --target /opt/five-hour-guard-hook.py',
      'exec /bin/true --pause-file /opt/five-hour-guard-hook.py.pause',
      '[ -f /opt/five-hour-guard-hook.py ] || exit 0; /x/other.sh',
    ].map((command) => ({ type: 'command', command }));
    write(f, { hooks: { PreToolUse: [{ matcher: '*', hooks: foreign }] } });
    expect(tool(f, 'check').status, 'none of them is our hook').toBe(1);
    expect(tool(f, 'add').status).toBe(0);
    const pre = readJson(f.settings).hooks.PreToolUse;
    expect(pre, 'the foreign group stays whole, ours is next to it').toHaveLength(2);
    expect(pre.flatMap((g: { hooks: unknown[] }) => g.hooks).filter((h: { command: string }) => foreign.some((x) => x.command === h.command))).toHaveLength(foreign.length);
    expect(tool(f, 'remove').status).toBe(0);
    expect(readJson(f.settings).hooks.PreToolUse, 'remove takes only our hook').toEqual([{ matcher: '*', hooks: foreign }]);
  });

  it('text after an unquoted shell comment is no part of the command: a command that has the hook only in a comment is not our hook, check does not report it, add and remove leave it alone', () => {
    const f = fixture('settings-comment');
    const foreign = [
      'echo audit; # /opt/five-hour-guard-hook.py --pause-file /tmp/pause',
      'echo audit;#/opt/five-hour-guard-hook.py',
      'echo audit;\n# /opt/five-hour-guard-hook.py --pause-file /tmp/pause',
    ].map((command) => ({ type: 'command', command }));
    write(f, { hooks: { PreToolUse: [{ matcher: '*', hooks: foreign }] } });
    expect(tool(f, 'check').status, 'none of them is our hook').toBe(1);
    expect(tool(f, 'add').status).toBe(0);
    const pre = readJson(f.settings).hooks.PreToolUse;
    expect(pre, 'the foreign group stays whole, ours is next to it').toHaveLength(2);
    expect(pre.flatMap((g: { hooks: unknown[] }) => g.hooks).filter((h: { command: string }) => foreign.some((x) => x.command === h.command))).toHaveLength(foreign.length);
    expect(tool(f, 'remove').status).toBe(0);
    expect(readJson(f.settings).hooks.PreToolUse, 'remove takes only our hook').toEqual([{ matcher: '*', hooks: foreign }]);
  });

  it('a backslash and newline are removed before a comment is read: a `#` after one starts a comment, so a command that has the hook only after it is not our hook, and one that continues its line runs the hook', () => {
    const f = fixture('settings-continuation-comment');
    const hook = '/opt/five-hour-guard-hook.py';
    const foreign = [`echo \\\n#${hook} --pause-file /tmp/pause`, `echo audit \\\n  #${hook} --pause-file /tmp/pause`, `echo audit; \\\n# ${hook} --pause-file /tmp/pause`,
      `echo audit \\\n\\\n#${hook} --pause-file /tmp/pause`].map((command) => ({ type: 'command', command }));
    write(f, { hooks: { PreToolUse: [{ matcher: '*', hooks: foreign }] } });
    expect(tool(f, 'check').status, 'none of them is our hook').toBe(1);
    expect(tool(f, 'add').status).toBe(0);
    const pre = readJson(f.settings).hooks.PreToolUse;
    expect(pre, 'the foreign group stays whole, ours is next to it').toHaveLength(2);
    expect(pre.flatMap((g: { hooks: unknown[] }) => g.hooks).filter((h: { command: string }) => foreign.some((x) => x.command === h.command))).toHaveLength(foreign.length);
    expect(tool(f, 'remove').status).toBe(0);
    expect(readJson(f.settings).hooks.PreToolUse, 'remove takes only our hook').toEqual([{ matcher: '*', hooks: foreign }]);
    const g = fixture('settings-continuation-run');
    write(g, { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `${quote(PYBIN)} \\\n${hook} --pause-file /tmp/p`, timeout: 21600 }] }] } });
    expect(tool(g, 'check').status, 'a continued line is one command: it runs the hook').toBe(0);
  });

  it('env, nohup and time with --help or --version print and run nothing: a handler that has the hook file after them is not our hook, the same wrappers with other options run it', () => {
    const f = fixture('settings-info-modes');
    const hook = '/opt/five-hour-guard-hook.py';
    const foreign = [`env --help ${hook} --pause-file /tmp/p`, `env --version ${hook} --pause-file /tmp/p`, `env -i --help ${hook} --pause-file /tmp/p`, `/usr/bin/env --help ${hook} --pause-file /tmp/p`,
      `FOO=1 env --version ${hook} --pause-file /tmp/p`, `nohup --help ${hook} --pause-file /tmp/p`, `nohup --version ${hook} --pause-file /tmp/p`, `time --help ${hook} --pause-file /tmp/p`,
      `/usr/bin/time --version ${hook} --pause-file /tmp/p`, `exec env --help python3 ${hook} --pause-file /tmp/p`].map((command) => ({ type: 'command', command }));
    write(f, { hooks: { PreToolUse: [{ matcher: '*', hooks: foreign }] } });
    expect(tool(f, 'check').status, 'none of them runs the hook').toBe(1);
    expect(tool(f, 'add').status).toBe(0);
    const pre = readJson(f.settings).hooks.PreToolUse;
    expect(pre, 'the foreign group stays whole, ours is next to it').toHaveLength(2);
    expect(pre.flatMap((g: { hooks: unknown[] }) => g.hooks).filter((h: { command: string }) => foreign.some((x) => x.command === h.command))).toHaveLength(foreign.length);
    expect(tool(f, 'remove').status).toBe(0);
    expect(readJson(f.settings).hooks.PreToolUse, 'remove takes only our hook').toEqual([{ matcher: '*', hooks: foreign }]);
    for (const [k, command] of [`env -i ${hook} --pause-file /tmp/p`, `env --ignore-environment python3 ${hook} --pause-file /tmp/p`, `nohup ${hook} --pause-file /tmp/p`, `time -p ${hook} --pause-file /tmp/p`,
      `env --debug ${hook} --pause-file /tmp/p`].entries()) {
      const g = fixture(`settings-info-run-${k}`);
      write(g, { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 21600 }] }] } });
      expect(tool(g, 'check').status, `${command}: it runs the hook`).toBe(0);
    }
  });

  it('the string of env -S is the command that env runs: the words after it are its arguments, so a handler that has the hook file after env -S printf is not our hook, and env -S python3 hook is', () => {
    const f = fixture('settings-env-split');
    const hook = '/opt/five-hour-guard-hook.py';
    const foreign = [`env -S 'printf %s' ${hook} --pause-file /tmp/p`, `env --split-string 'printf %s' ${hook} --pause-file /tmp/p`, `env --split-string='printf %s' ${hook} --pause-file /tmp/p`,
      `env -S'printf %s' ${hook} --pause-file /tmp/p`, `env -i -S 'printf %s' ${hook} --pause-file /tmp/p`, `env -S 'env -i printf %s' ${hook} --pause-file /tmp/p`].map((command) => ({ type: 'command', command }));
    write(f, { hooks: { PreToolUse: [{ matcher: '*', hooks: foreign }] } });
    expect(tool(f, 'check').status, 'none of them runs the hook').toBe(1);
    expect(tool(f, 'add').status).toBe(0);
    const pre = readJson(f.settings).hooks.PreToolUse;
    expect(pre, 'the foreign group stays whole, ours is next to it').toHaveLength(2);
    expect(pre.flatMap((g: { hooks: unknown[] }) => g.hooks).filter((h: { command: string }) => foreign.some((x) => x.command === h.command))).toHaveLength(foreign.length);
    expect(tool(f, 'remove').status).toBe(0);
    expect(readJson(f.settings).hooks.PreToolUse, 'remove takes only our hook').toEqual([{ matcher: '*', hooks: foreign }]);
    for (const [k, command] of [`env -S 'python3 -I' ${hook} --pause-file /tmp/p`, `env -S'python3 -I' ${hook} --pause-file /tmp/p`, `env -S 'python3 -I ${hook}' --pause-file /tmp/p`, `env -S '-i' ${hook} --pause-file /tmp/p`,
      `env -S '' ${hook} --pause-file /tmp/p`].entries()) {
      const g = fixture(`settings-env-split-run-${k}`);
      write(g, { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 21600 }] }] } });
      expect(tool(g, 'check').status, `${command}: it runs the hook`).toBe(0);
    }
  });

  it('python3 with -h, -?, --help, -V or --version prints and exits before it runs a script: a handler that has the hook file after it is not our hook, the same options after the hook are its arguments', () => {
    const f = fixture('settings-python-info');
    const hook = '/opt/five-hour-guard-hook.py';
    const foreign = ['--help', '-h', '-V', '-VV', '--version', '-I --help', '-W ignore -h'].map((o) => ({ type: 'command', command: `${quote(PYBIN)} ${o} ${hook} --pause-file /tmp/p` }));
    foreign.push({ type: 'command', command: `exec env ${quote(PYBIN)} --help ${hook} --pause-file /tmp/p` });
    write(f, { hooks: { PreToolUse: [{ matcher: '*', hooks: foreign }] } });
    expect(tool(f, 'check').status, 'none of them runs the hook').toBe(1);
    expect(tool(f, 'add').status).toBe(0);
    const pre = readJson(f.settings).hooks.PreToolUse;
    expect(pre, 'the foreign group stays whole, ours is next to it').toHaveLength(2);
    expect(pre.flatMap((g: { hooks: unknown[] }) => g.hooks).filter((h: { command: string }) => foreign.some((x) => x.command === h.command))).toHaveLength(foreign.length);
    expect(tool(f, 'remove').status).toBe(0);
    expect(readJson(f.settings).hooks.PreToolUse, 'remove takes only our hook').toEqual([{ matcher: '*', hooks: foreign }]);
    for (const [k, command] of [`${quote(PYBIN)} ${hook} --pause-file /tmp/p --help`, `${quote(PYBIN)} -I ${hook} -h --pause-file /tmp/p`, `${quote(PYBIN)} -W --help ${hook} --pause-file /tmp/p`].entries()) {
      const g = fixture(`settings-python-info-run-${k}`);
      write(g, { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 21600 }] }] } });
      expect(tool(g, 'check').status, `${command}: it runs the hook`).toBe(0);
    }
  });

  it('a Python that is given option values before the hook (-W ignore, -X dev, -Q, --check-hash-based-pycs) runs the hook behind them: check reports it and remove takes it away; a script in front of the hook file still makes it data', () => {
    const forms = (hook: string, pause: string) => [`${quote(PYBIN)} -W ignore ${hook} --pause-file ${pause}`, `${quote(PYBIN)} -X dev ${hook} --pause-file ${pause}`,
      `${quote(PYBIN)} -W ignore -X dev -I ${hook} --pause-file ${pause}`, `${quote(PYBIN)} -Q new ${hook} --pause-file ${pause}`,
      `${quote(PYBIN)} --check-hash-based-pycs always ${hook} --pause-file ${pause}`, `exec ${quote(PYBIN)} -I -W error ${hook} --pause-file ${pause}`,
      `[ -f ${pause} ] || exit 0; env FOO=1 ${quote(PYBIN)} -X importtime ${hook} --pause-file ${pause}`];
    for (const k of forms('', '').keys()) {
      const f = fixture(`settings-python-values-${k}`);
      const doc = base();
      const before = JSON.stringify(doc.hooks.PreToolUse);
      const command = forms(quote(HOOK), quote(f.pause))[k];
      doc.hooks.PreToolUse.push({ matcher: '*', hooks: [{ type: 'command', command, timeout: 21600 }] } as never);
      write(f, doc);
      expect(tool(f, 'check').status, `${command}: the hook behind the option values is found`).toBe(0);
      const rm = tool(f, 'remove');
      expect(rm.status, rm.stderr).toBe(0);
      expect(JSON.stringify(readJson(f.settings).hooks.PreToolUse), `${k}: remove took the handler`).toBe(before);
    }
    const g = fixture('settings-python-values-data');
    const foreign = [`${quote(PYBIN)} -W ignore /x/audit.py ${HOOK} --pause-file /tmp/p`, `${quote(PYBIN)} /x/audit.py -W ignore ${HOOK} --pause-file /tmp/p`].map((command) => ({ type: 'command', command }));
    write(g, { hooks: { PreToolUse: [{ matcher: '*', hooks: foreign }] } });
    expect(tool(g, 'check').status, 'a script in front of the hook file: the hook file is data').toBe(1);
    expect(tool(g, 'remove').status).toBe(0);
    expect(readJson(g.settings).hooks.PreToolUse, 'remove takes nothing of it').toEqual([{ matcher: '*', hooks: foreign }]);
  });

  it('command -v and command -V only describe the word after them: a handler that does so with the hook file is not our hook, command -p and command alone run it', () => {
    const f = fixture('settings-command-v');
    const hook = '/opt/five-hour-guard-hook.py';
    const foreign = [`command -v ${hook}`, `command -V ${hook}`, `command -pv ${hook}`, `command -p -v ${hook}`, `command -vp ${hook}`, `command -v -- ${hook}`,
      `command -v python3 ${hook} --pause-file /tmp/p`, `FOO=1 command -V ${hook} --pause-file /tmp/p`, `command -v ${hook}; command -v ${hook}`].map((command) => ({ type: 'command', command }));
    write(f, { hooks: { PreToolUse: [{ matcher: '*', hooks: foreign }] } });
    expect(tool(f, 'check').status, 'none of them runs the hook').toBe(1);
    expect(tool(f, 'add').status).toBe(0);
    const pre = readJson(f.settings).hooks.PreToolUse;
    expect(pre, 'the foreign group stays whole, ours is next to it').toHaveLength(2);
    expect(pre.flatMap((g: { hooks: unknown[] }) => g.hooks).filter((h: { command: string }) => foreign.some((x) => x.command === h.command))).toHaveLength(foreign.length);
    expect(tool(f, 'remove').status).toBe(0);
    expect(readJson(f.settings).hooks.PreToolUse, 'remove takes only our hook').toEqual([{ matcher: '*', hooks: foreign }]);
    for (const [k, command] of [`command ${hook} --pause-file /tmp/p`, `command -p ${hook} --pause-file /tmp/p`, `command -p python3 ${hook} --pause-file /tmp/p`, `exec command -- ${hook} --pause-file /tmp/p`].entries()) {
      const g = fixture(`settings-command-run-${k}`);
      write(g, { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 21600 }] }] } });
      expect(tool(g, 'check').status, `${command}: it runs the hook`).toBe(0);
    }
  });

  it('a command that runs the hook after a newline, a glued && or || with a newline, or a lone & is our hook: check reports it and remove takes it away', () => {
    const forms = (command: string) => [`true\n${command}`, `true;\n${command}`, `true &&\n${command}`, `false ||\n${command}`, `true &\n${command}`, `true & ${command}`, `echo a | cat\n\n${command}`];
    for (const k of forms('').keys()) {
      const f = fixture(`settings-newline-${k}`);
      const doc = base();
      const before = JSON.stringify(doc.hooks.PreToolUse);
      const command = forms(`${quote(PYBIN)} -I ${quote(HOOK)} --pause-file ${quote(f.pause)}`)[k];   // no ; of its own: the form is what separates it from `true`
      doc.hooks.PreToolUse.push({ matcher: '*', hooks: [{ type: 'command', command, timeout: 21600 }] } as never);
      write(f, doc);
      expect(tool(f, 'check').status, `${JSON.stringify(command.slice(0, 40))}: the hook the shell runs is found`).toBe(0);
      const rm = tool(f, 'remove');
      expect(rm.status, rm.stderr).toBe(0);
      expect(JSON.stringify(readJson(f.settings).hooks.PreToolUse), `${k}: remove took the handler`).toBe(before);
    }
  });

  it('add refuses a pause file that is the default usage cache or its lock when the configuration names no usage_cache', () => {
    const f = fixture('settings-default-cache');
    const original = JSON.stringify(base(), null, 2) + '\n';
    writeFileSync(f.settings, original, 'utf8');
    const cache = join(CONFIG_DIR, 'plugins', 'oh-my-claudecode', '.usage-cache-anthropic.json');
    for (const pause of [cache, `${cache}.lock`]) {
      writeFileSync(f.cfg, JSON.stringify({ pause_file: pause, settings_file: f.settings }), 'utf8');
      const r = runSync(SETTINGS_TOOL, ['add', '--config', f.cfg, '--hook', HOOK, '--python', PYBIN]);
      expect(r.status, `${pause}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(/same file/);
      expect(readText(f.settings)).toBe(original);
    }
  });

  it('add runs the selected hook against a pause: an empty file, a file that exits at once and a hook that never releases are refused, the real hook is accepted', () => {
    const f = fixture('settings-probe-hook');
    const original = JSON.stringify(base(), null, 2) + '\n';
    for (const [name, body, want] of [['empty', '', /does not hold a valid pause/], ['exits', 'import sys\nsys.exit(0)\n', /does not hold a valid pause/],
      ['no-release', 'import sys, time\nopen(sys.argv[sys.argv.index("--log") + 1], "a").write("hold-start\\n")\ntime.sleep(600)\n', /does not release/]] as const) {
      const hook = join(f.dir, name, 'five-hour-guard-hook.py');
      mkdirSync(dirname(hook), { recursive: true });
      writeFileSync(hook, body, 'utf8');
      writeFileSync(f.settings, original, 'utf8');
      const r = tool(f, 'add', ['--hook', hook]);
      expect(r.status, `${name}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, name).toMatch(want);
      expect(readText(f.settings), `${name}: nothing written`).toBe(original);
    }
    expect(tool(f, 'add').status, 'the real hook').toBe(0);
  });

  it('paths that differ only by case are one file where the platform ignores case, also when neither exists (checked with the case rules of Windows)', () => {
    const f = fixture('settings-case-alias');
    const original = JSON.stringify(base(), null, 2) + '\n';
    writeFileSync(f.settings, original, 'utf8');
    const driver = ['import os, runpy, sys', 'os.path.normcase = lambda p: p.lower()', 'sys.argv = sys.argv[1:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const args = [SETTINGS_TOOL, 'add', '--settings', f.settings, '--pause-file', join(f.dir, 'Pause-Case.json'), '--hook-log', join(f.dir, 'pause-case.json'), '--hook', HOOK, '--python', PYBIN];
    const r = runPyCode(driver, args);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/are the same file/);
    expect(readText(f.settings)).toBe(original);
  });

  it('add refuses a value of the wrong type for every guard key that its checks use, as the guard does at start', () => {
    const f = fixture('settings-wrong-types');
    const original = JSON.stringify(base(), null, 2) + '\n';
    writeFileSync(f.settings, original, 'utf8');
    for (const key of ['usage_cache', 'state_file', 'log_file']) {
      writeFileSync(f.cfg, JSON.stringify({ pause_file: f.pause, settings_file: f.settings, [key]: [] }), 'utf8');
      const r = runSync(SETTINGS_TOOL, ['add', '--config', f.cfg, '--hook', HOOK, '--python', PYBIN]);
      expect(r.status, `${key}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, key).toMatch(new RegExp(`"${key}" must be a string`));
      expect(readText(f.settings)).toBe(original);
    }
  });

  it('a custom hook does not hide the bundled one from the collision checks: a pause file that is the bundled hook is refused, as the guard refuses it at start', () => {
    const f = fixture('settings-bundled-hook');
    const original = JSON.stringify(base(), null, 2) + '\n';
    writeFileSync(f.settings, original, 'utf8');
    const custom = join(f.dir, 'custom', 'five-hour-guard-hook.py');
    mkdirSync(dirname(custom), { recursive: true });
    copyFileSync(HOOK, custom);
    writeFileSync(f.cfg, JSON.stringify({ pause_file: HOOK, settings_file: f.settings }), 'utf8');
    const r = runSync(SETTINGS_TOOL, ['add', '--config', f.cfg, '--hook', custom, '--python', PYBIN]);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/same file/);
    expect(readText(f.settings)).toBe(original);
  });

  it('when no hook log is set the no-log command that add installs is probed too: a hook that holds only when it is given --log is refused', () => {
    const f = fixture('settings-probe-no-log');
    const hook = join(f.dir, 'needs-log', 'five-hour-guard-hook.py');
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, 'import os, sys, time\nif "--log" not in sys.argv:\n    sys.exit(0)\nopen(sys.argv[sys.argv.index("--log") + 1], "a").write("hold-start\\n")\nwhile os.path.exists(sys.argv[sys.argv.index("--pause-file") + 1]):\n    time.sleep(0.1)\n', 'utf8');
    const original = JSON.stringify(base(), null, 2) + '\n';
    writeFileSync(f.settings, original, 'utf8');
    const r = runSync(SETTINGS_TOOL, ['add', '--settings', f.settings, '--pause-file', f.pause, '--hook', hook, '--python', PYBIN]);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/without --log|no hook log/);
    expect(readText(f.settings), 'nothing written').toBe(original);
    const ok = runSync(SETTINGS_TOOL, ['add', '--settings', f.settings, '--pause-file', f.pause, '--hook', HOOK, '--python', PYBIN]);
    expect(ok.status, `the real hook without a log: ${ok.stdout}${ok.stderr}`).toBe(0);
  });

  it('the probe runs the installed command without any argument of its own: a hook that lets every call through unless it is given --poll is refused, with and without a hook log', () => {
    const f = fixture('settings-probe-needs-poll');
    const hook = join(f.dir, 'needs-poll', 'five-hour-guard-hook.py');
    mkdirSync(dirname(hook), { recursive: true });
    // the real hook, behind a line that makes it return at once when no --poll is on its command line
    writeFileSync(hook, 'import sys\nif "--poll" not in sys.argv:\n    sys.exit(0)\n' + readFileSync(HOOK, 'utf8').replace(/^#!.*\n/, ''), 'utf8');
    const original = JSON.stringify(base(), null, 2) + '\n';
    writeFileSync(f.settings, original, 'utf8');
    const withLog = tool(f, 'add', ['--hook', hook]);
    expect(withLog.status, `with a hook log: ${withLog.stdout}${withLog.stderr}`).toBe(2);
    expect(withLog.stderr).toMatch(/does not hold a valid pause/);
    const noLog = runSync(SETTINGS_TOOL, ['add', '--settings', f.settings, '--pause-file', f.pause, '--hook', hook, '--python', PYBIN]);
    expect(noLog.status, `without a hook log: ${noLog.stdout}${noLog.stderr}`).toBe(2);
    expect(noLog.stderr).toMatch(/does not hold a valid pause/);
    expect(readText(f.settings), 'nothing written').toBe(original);
  });

  it('the probe runs without the variables that mark a session as another provider: a model id of Bedrock or Vertex, or a provider flag, in the environment of the tool does not make the hook let the probe through', () => {
    const f = fixture('settings-probe-provider-env');
    const original = JSON.stringify(base(), null, 2) + '\n';
    for (const [key, value] of [['CLAUDE_MODEL', 'us.anthropic.claude-sonnet-4-6-v1:0'], ['ANTHROPIC_MODEL', 'vertex_ai/claude-sonnet-4-6'],
      ['CLAUDE_CODE_BEDROCK_OPUS_MODEL', 'global.anthropic.claude-opus-4-8-v1:0'], ['CLAUDE_CODE_USE_VERTEX', 'true']]) {
      writeFileSync(f.settings, original, 'utf8');
      const r = runSync(SETTINGS_TOOL, ['add', '--settings', f.settings, '--pause-file', f.pause, '--hook-log', f.hookLog, '--hook', HOOK, '--python', PYBIN], { env: { ...ENV, [key]: value } });
      expect(r.status, `${key}=${value}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  });

  it('add keeps the probe pause in place: a hook that holds for a moment and then lets go by itself is refused', () => {
    const f = fixture('settings-probe-early-exit');
    const hook = join(f.dir, 'early', 'five-hour-guard-hook.py');
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, 'import sys, time\nopen(sys.argv[sys.argv.index("--log") + 1], "a").write("hold-start\\n")\ntime.sleep(0.8)\n', 'utf8');
    const original = JSON.stringify(base(), null, 2) + '\n';
    writeFileSync(f.settings, original, 'utf8');
    const r = tool(f, 'add', ['--hook', hook]);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/while the pause was still in force/);
    expect(readText(f.settings)).toBe(original);
  });

  it('the registration probe runs the very entry that add writes, through the shell: the command handed to sh is the generated one, with the pause and log of the probe', () => {
    const f = fixture('settings-probe-shell');
    writeFileSync(f.settings, JSON.stringify(base(), null, 2) + '\n', 'utf8');
    const bin = join(f.dir, 'bin');
    const seen = join(f.dir, 'sh-commands.txt');
    mkdirSync(bin);
    writeFileSync(join(bin, 'sh'), `#!/bin/sh\nprintf '%s\\n' "$2" >> ${quote(seen)}\nexec /bin/sh "$@"\n`, 'utf8');
    chmodSync(join(bin, 'sh'), 0o755);
    const r = runSync(SETTINGS_TOOL, ['add', '--settings', f.settings, '--pause-file', f.pause, '--hook-log', f.hookLog, '--hook', HOOK, '--python', PYBIN], { env: { ...ENV, PATH: `${bin}:${process.env.PATH}` } });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    const lines = readText(seen).trim().split('\n');
    expect(lines, 'the probe went through the shell once').toHaveLength(1);
    const probed = lines[0].replace(/\S*five-hour-guard-probe-[^/\s]+\/pause\.json/g, '@PAUSE').replace(/\S*five-hour-guard-probe-[^/\s]+\/hook\.log/g, '@LOG');
    const written = entryCommand(f).split(f.pause).join('@PAUSE').split(f.hookLog).join('@LOG');
    expect(probed, 'the same command as the one written, but for the paths of the probe').toBe(written);
    expect(readJson(f.settings).hooks.PreToolUse.some((g: { hooks: Array<{ command: string }> }) => g.hooks.some((h) => h.command === entryCommand(f)))).toBe(true);
  });

  it('what add writes is what the guard accepts: no wiring warning, also for a hook path that needs quoting', () => {
    const f = fixture('settings-roundtrip-guard', { cache: { pct: 50, resetMs: Date.now() + 3600e3 } });
    const dir = join(f.dir, "it's here");
    mkdirSync(dir);
    const hook = join(dir, 'five-hour-guard-hook.py');
    copyFileSync(HOOK, hook);
    writeFileSync(f.settings, JSON.stringify(base(), null, 2) + '\n', 'utf8');
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, hook_log_file: f.hookLog }), 'utf8');
    const added = runSync(SETTINGS_TOOL, ['add', '--config', f.cfg, '--hook', hook, '--python', PYBIN]);
    expect(added.status, `${added.stdout}${added.stderr}`).toBe(0);
    const g = runSync(GUARD_SCRIPT, ['--config', f.cfg, '--once']);
    expect(g.status, `${g.stdout}${g.stderr}`).toBe(0);
    expect(g.stdout, 'the entry that add wrote').not.toMatch(/WARNING/);
  });

  it('add refuses a timeout that does not cover a pause (21600 s): Claude Code cancels the hook when it runs longer and the tool call goes on', () => {
    const f = fixture('settings-timeout');
    const original = JSON.stringify(base(), null, 2) + '\n';
    writeFileSync(f.settings, original, 'utf8');
    for (const bad of ['0', '-5', '1', '60', '21599']) {
      const r = tool(f, 'add', ['--timeout', bad]);
      expect(r.status, `${bad}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, bad).toMatch(/--timeout must be at least 21600/);
      expect(readText(f.settings), `${bad}: nothing written`).toBe(original);
    }
    for (const good of ['21600', '30000']) {
      expect(tool(f, 'add', ['--timeout', good]).status, good).toBe(0);
      expect(readJson(f.settings).hooks.PreToolUse.find((g: { matcher: string }) => g.matcher === '*').hooks[0].timeout).toBe(Number(good));
    }
  });

  it('add refuses a timeout that is not a finite number: an integer beyond the range of a float (400 digits) is read as Infinity by JavaScript and would crash a Python that tests it', () => {
    const f = fixture('settings-timeout-huge');
    const original = JSON.stringify(base(), null, 2) + '\n';
    writeFileSync(f.settings, original, 'utf8');
    const r = tool(f, 'add', ['--timeout', '9'.repeat(400)]);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/--timeout must be at least 21600 seconds and a finite number, not 9{40}\.\.\./);
    expect(r.stderr, 'an error message, not a traceback').not.toMatch(/Traceback/);
    expect(readText(f.settings), 'nothing written').toBe(original);
    expect(backups(f), 'no backup either').toHaveLength(0);
  });

  it('the root README links the guard, next to the other documentation', () => {
    const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'README.md'), 'utf8');
    expect(readme).toMatch(/\]\(tools\/five-hour-guard\/README\.md\)/);
  });

  it('add refuses relative or missing paths; a settings file of the wrong shape is an error, not a crash', () => {
    const f = fixture('settings-refuse');
    const original = JSON.stringify(base(), null, 2) + '\n';
    writeFileSync(f.settings, original, 'utf8');
    const refused = (extra: string[], pattern: RegExp) => {
      const r = tool(f, 'add', extra);
      expect(r.status, `${extra.join(' ')}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(pattern);
      expect(readText(f.settings), 'nothing written').toBe(original);
      expect(backups(f), 'no backup either').toHaveLength(0);
    };
    refused(['--hook', 'tools/five-hour-guard-hook.py'], /not absolute/);
    refused(['--hook', join(f.dir, 'absent-hook.py')], /hook .* does not exist/);
    refused(['--python', join(f.dir, 'absent-python')], /interpreter .* does not exist/);
    const rel = runSync(SETTINGS_TOOL, ['add', '--settings', f.settings, '--pause-file', 'pause.json', '--hook', HOOK, '--python', PYBIN]);
    expect(rel.status).toBe(2);
    expect(rel.stderr).toMatch(/pause file path 'pause\.json' is not absolute/);
    for (const [label, doc] of [['hooks null', '{"hooks": null}'], ['PreToolUse not a list', '{"hooks": {"PreToolUse": {}}}'], ['group not an object', '{"hooks": {"PreToolUse": [1]}}'], ['hook not an object', '{"hooks": {"PreToolUse": [{"hooks": [1]}]}}'], ['hook text not an object', '{"hooks": {"PreToolUse": [{"hooks": ["x"]}]}}'], ['command not a string', '{"hooks": {"PreToolUse": [{"hooks": [{"command": 5}]}]}}'], ['command 0', '{"hooks": {"PreToolUse": [{"hooks": [{"command": 0}]}]}}'], ['command false', '{"hooks": {"PreToolUse": [{"hooks": [{"command": false}]}]}}'], ['command null', '{"hooks": {"PreToolUse": [{"hooks": [{"command": null}]}]}}'], ['top level not an object', '[]']]) {
      writeFileSync(f.settings, doc, 'utf8');
      for (const action of ['check', 'add', 'remove']) {
        const r = tool(f, action);
        expect(r.status, `${label}, ${action}: ${r.stdout}${r.stderr}`).toBe(2);
        expect(r.stderr, `${label}, ${action}: an error message, not a traceback`).not.toMatch(/Traceback/);
      }
      expect(readText(f.settings), `${label}: file untouched`).toBe(doc);
    }
  });

  it('settings path: --settings, then settings_file of the configuration, then CLAUDE_CONFIG_DIR, then the home directory; an unreadable file is an error, not a write', () => {
    const f = fixture('settings-path', { config: {} });
    const target = join(f.dir, 'from-config.json');
    writeFileSync(f.cfg, JSON.stringify({ pause_file: f.pause, settings_file: target }), 'utf8');
    writeFileSync(target, JSON.stringify(base(), null, 2) + '\n', 'utf8');
    const viaConfig = runSync(SETTINGS_TOOL, ['check', '--config', f.cfg]);
    expect(viaConfig.status).toBe(1);
    expect(viaConfig.stdout).toMatch(/from-config\.json: 0 entry/);

    writeFileSync(join(CONFIG_DIR, 'settings.json'), JSON.stringify(base(), null, 2) + '\n', 'utf8');
    const viaEnv = runSync(SETTINGS_TOOL, ['check']);
    expect(viaEnv.stdout).toContain(join(CONFIG_DIR, 'settings.json'));
    const home = join(f.dir, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(base(), null, 2) + '\n', 'utf8');
    const noConfigDir: NodeJS.ProcessEnv = { ...ENV, HOME: home, USERPROFILE: home };
    delete noConfigDir.CLAUDE_CONFIG_DIR;
    const viaHome = runSync(SETTINGS_TOOL, ['check'], { env: noConfigDir });
    expect(viaHome.stdout).toContain(join(home, '.claude', 'settings.json'));

    const broken = join(f.dir, 'broken.json');
    writeFileSync(broken, '{ nope', 'utf8');
    const r = runSync(SETTINGS_TOOL, ['add', '--settings', broken, '--pause-file', f.pause, '--hook', HOOK]);
    expect(r.status).toBe(2);
    expect(readText(broken), 'unreadable settings are left alone').toBe('{ nope');
    const noPause = runSync(SETTINGS_TOOL, ['add', '--settings', target]);
    expect(noPause.status).toBe(2);
    expect(noPause.stderr).toMatch(/"pause_file" is not set/);
  });
});
