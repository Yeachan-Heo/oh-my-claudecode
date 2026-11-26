/* global process */
// Bash and file-tool guard of provider sessions (scripts/provider/provider-bash-guard.cjs):
// the blocked and allowed command names, credential patterns and paths come from a fixture guard configuration.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { makeTmp, writeProfile } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const GUARD = join(process.cwd(), 'scripts', 'provider', 'provider-bash-guard.cjs');
const STATE_DIR = '/home/user/.omc/state/provider/acme';
const guard = require('../../../scripts/provider/provider-bash-guard.cjs');
const settings = require('../../../scripts/provider/lib/settings.cjs');
const { loadProfile } = require('../../../scripts/provider/lib/profile.cjs');

const js = JSON.stringify;
// Fixture guard configuration, built by the settings writer from a real profile: one extra wrapper name, the advisor command as the allowed
// command, an extra protected pattern for a key directory; the key file, the profiles file and the settings copies are built from the profile.
let ENV;

// In-process answer of the guard for a Bash command.
const respond = (command, tool = 'Bash', env = ENV) => guard.guardResponse({ tool_name: tool, tool_input: { command } }, env);
const denied = (r) => r?.hookSpecificOutput?.permissionDecision === 'deny';
const reasonOf = (r) => r.hookSpecificOutput.permissionDecisionReason;
// Answer of the script process (used where the process env matters).
const run = (input, env = ENV) => spawnSync(process.execPath, [GUARD], { input: typeof input === 'string' ? input : js(input), encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
const deniedRun = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === 'deny'; } catch { return false; } };

describe.skipIf(process.platform === 'win32')('provider bash guard', () => {
  let tmp;
  beforeAll(() => {
    tmp = makeTmp('provider-guard-');
    const keyFile = join(tmp.dir, 'keys', 'acme.key');
    mkdirSync(join(tmp.dir, 'keys'), { recursive: true });
    writeFileSync(keyFile, 'FAKE-KEY-0123456789\n');
    const { env } = writeProfile(join(tmp.dir, 'profile'), {
      apiKey: { file: keyFile },
      guard: {
        blockedCommands: ['claude', 'claude-code', 'provider-launch', 'provider-worker', 'provider-team', 'provider-task', 'claude-wrap'],
        allowedCommands: ['provider-advisor'],
        extraProtectedPatterns: ['(^|[^A-Za-z0-9_])\\.acme-keys'],
      },
    });
    const { profile } = loadProfile(env);
    ENV = { OMC_PROVIDER: 'acme', OMC_PROVIDER_GUARD: settings.guardEnv(profile), OMC_PROVIDER_STATE_DIR: STATE_DIR };
  });
  afterAll(() => { tmp.cleanup(); });

  it('(10) blocks commands that start claude and its wrappers, also by absolute path, with a version number, in loops and with sudo/env options', () => {
    const yes = ['claude -p x', '/home/user/.local/bin/claude -p x', 'cd /tmp && /opt/tools/bin/claude --version', 'FOO=1 claude -p x', 'env -i /opt/tools/bin/claude', 'timeout 30 claude -p x', 'bash -c "claude -p x"', "sh -lc '/home/user/.local/bin/claude -p x'",
      'claude-wrap --bg x', 'provider-launch --role lane', 'omc ask claude hi', 'omc team 1:claude:executor x', 'omc team status x', 'echo a; claude -p b', 'ls | xargs claude', 'npx @anthropic-ai/claude-code -p x', 'nohup claude -p x &', '`claude -p x`', 'x=$(claude -p x)',
      '/home/user/.local/share/claude/versions/2.1.325 -p x', 'for i in 1; do /home/user/.local/bin/claude -p x; done', 'if /home/user/.local/bin/claude -p x; then :; fi', '! /home/user/.local/bin/claude -p x', 'timeout -s KILL 30 /home/user/.local/bin/claude -p x', 'eval /home/user/.local/bin/claude -p x',
      'sudo -E -u root /home/user/.local/bin/claude -p x', 'sudo -E -u root claude -p x', 'env -u FOO claude -p x', 'env -u OMC_PROVIDER_SETTINGS_FILE claude -p x', '\\claude -p x', 'cla""ude -p x', 'provider-team 1:claude:executor x', '/opt/tools/bin/provider-team 1:claude:executor x', 'while true; do claude -p x; done'];
    expect(yes.filter((c) => !denied(respond(c)))).toEqual([]);
  });

  it('(10b) blocks printing the environment and reading credential files (host login, copies of the session settings, key and profile files)', () => {
    const yes = ['env', 'cd x && env', 'printenv', 'printenv ANTHROPIC_AUTH_TOKEN', 'export -p', 'cat /proc/self/environ', 'cat /home/user/.claude/.credentials.json', `cat ${STATE_DIR}/worker-settings/a.json`, 'cat ~/.omc/state/provider/acme/worker-settings/a.json', 'cd keys && cat acme.key', 'cat ~/.config/claude-omc/providers.jsonc', 'cat ~/.config/claude-omc/keys/acme.key'];
    expect(guard.guardResponse({ tool_name: 'Read', tool_input: { file_path: join(tmp.dir, 'keys', 'acme.key') } }, ENV)).not.toBe(null);
    expect(guard.guardResponse({ tool_name: 'Read', tool_input: { file_path: join(tmp.dir, 'profile', 'providers.jsonc') } }, ENV)).not.toBe(null);
    expect(yes.filter((c) => !denied(respond(c)))).toEqual([]);
  });

  it('(11) lets harmless commands and the worker channel `omc team api` through (claim-task, send-message, ACK)', () => {
    const no = ['ls ~/.claude', 'cat /home/user/.claude/CLAUDE.md', 'grep -r claude src', 'git commit -m "claude-wrap: description"', 'echo claude', 'node tests/claude-wrap.mjs', 'python3 -I cost.py', 'git log --oneline', 'cat claude.md', 'ls /home/user/.local/share/claude/versions',
      'omc team api claim-task --input \'{"team_name":"a","worker":"worker-1"}\' --json', 'omc team api send-message --input {} --json', 'omc team api transition-task-status --input {} --json', 'env FOO=1 ls', 'date', 'which claude', 'ls /home/user/work', 'echo $PATH'];
    expect(no.filter((c) => respond(c) !== null)).toEqual([]);
  });

  it('(11b) the allowed list holds the advisor command, an entry of it unblocks a command, and claude and the wrapper stay blocked', () => {
    const config = guard.guardConfig(ENV);
    expect([...config.allowed]).toEqual(['provider-advisor']);
    expect(guard.blockedCommand('claude -p x', config) && guard.blockedCommand('claude-wrap -p x', config)).toBe(true);
    config.allowed.add('claude');
    const unblocked = !guard.blockedCommand('claude -p x', config);
    config.allowed.delete('claude');
    expect(unblocked && guard.blockedCommand('claude -p x', config)).toBe(true);
  });

  it('(11c) the advisor exception: the bare command (also quoted, in a loop, in bash -c, with stdin) passes; with `; claude`, a pipe to a wrapper, `&& claude`, a substitution or claude after the exception it is still refused', () => {
    const no = ['provider-advisor "why does the test fail? context"', 'provider-advisor \'question with claude in the text\'', 'echo x | provider-advisor', 'cd /tmp && provider-advisor "x"', 'for i in 1 2; do provider-advisor "x"; done', 'bash -c "provider-advisor x"', 'X=$(provider-advisor "x")'];
    const yes = ['provider-advisor x; claude', 'provider-advisor x; claude -p y', 'provider-advisor | claude-wrap', 'provider-advisor x && claude -p y', 'provider-advisor x $(claude -p y)', 'provider-advisor x `claude -p y`', 'provider-advisor x\nclaude -p y', 'provider-advisor x & claude -p y', 'claude -p x', 'claude-wrap -p x', 'bash -c "provider-advisor x; claude -p y"', 'provider-advisor x || /home/user/.local/bin/claude'];
    expect({ blocked: no.filter((c) => denied(respond(c))), passed: yes.filter((c) => !denied(respond(c))) }).toEqual({ blocked: [], passed: [] });
  });

  it('(11d) the exception is only for the bare advisor name: /tmp/provider-advisor, ./provider-advisor and an absolute path are refused, the bare name (also after cd and in bash -c) passes', () => {
    const yes = ['/tmp/provider-advisor -p hi', './provider-advisor x', '/opt/tools/bin/provider-advisor x', 'cd /tmp && ./provider-advisor x', 'bash -c "/tmp/provider-advisor x"', 'sudo /tmp/provider-advisor x'];
    const no = ['provider-advisor x', 'cd /tmp && provider-advisor "x"', 'bash -c "provider-advisor x"'];
    expect({ passed: yes.filter((c) => !denied(respond(c))), blocked: no.filter((c) => denied(respond(c))) }).toEqual({ passed: [], blocked: [] });
  });

  it('(11e) refuses the test variables of the tools (OMC_PROVIDER_ADVISOR_*, OMC_PROVIDER_CLAUDE_BIN, OMC_PROVIDER_BASE_URL, OMC_PROVIDER_API_KEY_FILE, OMC_PROVIDER_QUOTA_URL) in a command, also inline with the advisor', () => {
    const yes = ['OMC_PROVIDER_ADVISOR_CLAUDE_BIN=/opt/tools/bin/claude provider-advisor x', 'OMC_PROVIDER_ADVISOR_TIMEOUT_MS=1 provider-advisor x', 'env OMC_PROVIDER_CLAUDE_BIN=/x provider-advisor x', 'export OMC_PROVIDER_BASE_URL=http://127.0.0.1:1', 'OMC_PROVIDER_ADVISOR_LOG_FILE=/tmp/x provider-advisor x', 'bash -c "OMC_PROVIDER_ADVISOR_CLAUDE_BIN=/x provider-advisor y"', 'echo $OMC_PROVIDER_BASE_URL'];
    expect(yes.filter((c) => !denied(respond(c)))).toEqual([]);
    expect(reasonOf(respond(yes[0]))).toMatch(/test variables/);
  });

  it('(11f) refuses references to $ANTHROPIC_AUTH_TOKEN (also ${...}, in quotes, in a substitution) and git push and git stash (also with options before the subcommand), with a reason; git status, commit, log and `git stash`-like words in a message pass', () => {
    const yes = ['echo $ANTHROPIC_AUTH_TOKEN', 'echo "${ANTHROPIC_AUTH_TOKEN}"', 'curl -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" x', 'x=$(echo $ANTHROPIC_AUTH_TOKEN)', 'git push', 'git push origin HEAD', 'git -C /tmp/x push', 'git -c a=b push --force', 'git stash', 'git stash pop', 'cd x && git stash push -u', 'bash -c "git push"'];
    const no = ['git status', 'git commit -m "git push and git stash"', 'git log --oneline', 'git add a.go', 'git diff', 'echo ANTHROPIC_AUTH_TOKEN', 'git -C /tmp/x commit -m x', 'git branch push'];
    const reasons = ['git push', 'git stash', 'echo $ANTHROPIC_AUTH_TOKEN'].map((c) => reasonOf(respond(c)));
    expect({ passed: yes.filter((c) => !denied(respond(c))), blocked: no.filter((c) => denied(respond(c))) }).toEqual({ passed: [], blocked: [] });
    expect(reasons[0]).toMatch(/git push/);
    expect(reasons[1]).toMatch(/git stash/);
    expect(reasons[2]).toMatch(/ANTHROPIC_AUTH_TOKEN/);
  });

  it('(11g) the launcher files of this package are refused by name with the extension, by path and through node or a shell; the advisor file only by its bare command name; a command that merely contains the word passes', () => {
    const yes = ['node /opt/omc/scripts/provider/provider-launch.cjs -p hi', './provider-launch.cjs -p hi', 'bash -c \'node provider-launch.cjs\'', '/opt/omc/scripts/provider/provider-launch.cjs -p hi', 'provider-launch.cjs -p hi',
      'node /opt/omc/scripts/provider/provider-worker.cjs -p hi', 'node /opt/omc/scripts/provider/provider-team.cjs 2:executor x', 'node /opt/omc/scripts/provider/provider-task.cjs start x', 'provider-task start x',
      'node --no-warnings scripts/provider/provider-launch.cjs', 'sh provider-worker.cjs', 'cd /tmp && node provider-team.cjs 1:executor x', 'sudo -E node /opt/omc/scripts/provider/provider-launch.cjs',
      '/opt/omc/scripts/provider/provider-advisor.cjs x', './provider-advisor.cjs x', 'provider-advisor.cjs x', 'node /opt/omc/scripts/provider/provider-advisor.cjs x', 'bash -c \'node provider-advisor.cjs x\''];
    const no = ['grep -n provider-launch.cjs docs/PROVIDER-WORKERS.md', 'git add scripts/provider/provider-launch.cjs', 'cat scripts/provider/provider-launch.cjs', 'echo provider-launch.cjs', 'git commit -m "provider-launch.cjs: fix"',
      'node tests/claude-wrap.mjs', 'node scripts/build.cjs', 'ls provider-task-log.cjs', 'provider-advisor "provider-launch.cjs question"',
      // Ordinary work on the user's own files: the extension is compared only for `.cjs` files named after the commands this package ships, so a file that merely
      // carries a blocked name (any extension, with or without a path) is not a launcher. `claude-wrap` is a blocked name of this configuration but not a shipped file.
      'node --test ./tests/claude.mjs', 'node ./scripts/claude.mjs', 'python3 ./claude.py', 'cat ./notes/claude.md', 'npx vitest run ./src/claude.mjs', 'git add ./src/claude.mjs', 'node ./bin/claude-code.cjs --help',
      'cp ./claude.cjs /tmp/x.cjs', 'rm ./dist/claude.cjs', 'node ./src/provider-team.mjs', 'node ./out/claude.cjs', 'node --test ./tests/claude-wrap.cjs', 'node ./tests/claude-wrap.mjs', 'node claude-wrap.cjs'];
    expect({ passed: yes.filter((c) => !denied(respond(c))), blocked: no.filter((c) => denied(respond(c))) }).toEqual({ passed: [], blocked: [] });
    expect(reasonOf(respond(yes[0]))).toMatch(/starting claude and its wrappers/);
    expect(reasonOf(respond('provider-advisor.cjs x'))).toMatch(/bare name/);
    // Without a guard configuration the default blocked names apply to the files as well.
    const env = { OMC_PROVIDER: 'acme' };
    expect(['node provider-launch.cjs', 'node provider-task.cjs start x', './provider-team.cjs x'].filter((c) => !denied(respond(c, 'Bash', env)))).toEqual([]);
  });

  it('(12) outside a provider process (no OMC_PROVIDER) and for tools other than Bash and the file tools: does nothing', () => {
    const none = { OMC_PROVIDER_GUARD: ENV.OMC_PROVIDER_GUARD };
    expect(run({ tool_name: 'Bash', tool_input: { command: 'claude -p x' } }, none).stdout).toBe('');
    expect(run({ tool_name: 'Bash', tool_input: { command: 'claude -p x' } }, { ...none, OMC_PROVIDER: '' }).stdout).toBe('');
    expect(run({ tool_name: 'Read', tool_input: { command: 'claude -p x' } }).stdout).toBe('');
  });

  it('(13) not JSON on the input gives a fail-closed denial with exit code 0; an empty command passes', () => {
    const r = run('this is not json');
    expect(deniedRun(r) && r.status === 0 && /fail-closed/.test(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason)).toBe(true);
    expect(run({ tool_name: 'Bash', tool_input: { command: '' } }).stdout).toBe('');
  });

  it('(13b) the hook command from the settings copy, run through /bin/sh, blocks a claude command; with the guard script removed it denies (JSON deny) instead of letting the command through', () => {
    const a = spawnSync('/bin/sh', ['-c', settings.guardCommand(GUARD)], { input: js({ tool_name: 'Bash', tool_input: { command: '/home/user/.local/bin/claude -p x' } }), encoding: 'utf8', env: { PATH: process.env.PATH, ...ENV } });
    const b = spawnSync('/bin/sh', ['-c', settings.guardCommand(join(tmp.dir, 'no-guard-here'))], { input: js({ tool_name: 'Bash', tool_input: { command: 'ls' } }), encoding: 'utf8', env: { PATH: process.env.PATH } });
    expect(deniedRun(a) && deniedRun(b)).toBe(true);
  });

  it('(19) an exception while parsing (tool_input with a throwing getter) gives a fail-closed denial, not exit code 1 without a decision; an empty command still passes', () => {
    const bad = { tool_name: 'Bash', tool_input: { get command() { throw new Error('simulated parsing exception'); } } };
    const a = guard.guardResponse(bad, ENV);
    expect(a && a.hookSpecificOutput.permissionDecision === 'deny' && /fail-closed/.test(a.hookSpecificOutput.permissionDecisionReason)).toBe(true);
  });

  it('(20) Edit and Write on each of the 4 protected paths give a denial with NEED: (8 of 8); MultiEdit and NotebookEdit too; a write in the task worktree passes (2 of 2)', () => {
    const home = join(tmp.dir, 'home-supervision');
    mkdirSync(join(home, '.claude'), { recursive: true });
    const protectedPaths = [join(home, '.claude', 'settings.json'), join(home, '.claude', 'hooks', 'h.py'), join(home, '.claude', 'plugins', 'cache', 'omc', 'x', '1.0.0', 'scripts', 'x.js'), join(home, '.omc', 'state', 'jev', 's.jsonl')];
    const result = (tool, input) => {
      const r = run({ tool_name: tool, tool_input: input, cwd: tmp.dir }, { ...ENV, HOME: home });
      const h = (() => { try { return JSON.parse(r.stdout).hookSpecificOutput; } catch { return null; } })();
      return { deny: h?.permissionDecision === 'deny', reason: h?.permissionDecisionReason || '', clean: r.status === 0 && r.stdout === '' };
    };
    const bad = [];
    let denies = 0;
    for (const path of protectedPaths) for (const tool of ['Edit', 'Write']) {
      const x = result(tool, { file_path: path });
      if (x.deny && /^NEED:/.test(x.reason)) denies++; else bad.push(`${tool}:${path}:${js(x)}`);
    }
    expect({ denies, bad }).toEqual({ denies: 8, bad: [] });
    const nb = result('NotebookEdit', { notebook_path: join(home, '.claude', 'hooks', 'h.ipynb') });
    const me = result('MultiEdit', { file_path: join(home, '.claude', 'settings.json') });
    expect(nb.deny && /^NEED:/.test(nb.reason) && me.deny && /^NEED:/.test(me.reason)).toBe(true);
    expect(result('Write', { file_path: join(tmp.dir, 'task', 'out.txt') }).clean && result('Edit', { file_path: join(tmp.dir, 'task', 'src', 'code.js') }).clean).toBe(true);
  });

  it('(21) Bash commands that write to the supervision (a write command, sed -i or a redirect) are refused with NEED:, reading and listing pass', () => {
    const home = join(tmp.dir, 'home-supervision-2');
    const yes = ['echo x > ~/.claude/settings.json', 'echo x >> ~/.claude/settings.local.json', 'echo x > $HOME/.claude/settings.json', 'rm -rf ~/.claude/hooks', 'rm ~/.omc/state/jev/a.json', 'cp /tmp/a ~/.claude/hooks/b', 'mkdir -p ~/.claude/hooks/x', 'touch ~/.claude/settings.json', 'sed -i "s/a/b/" ~/.claude/settings.json', 'tee ~/.omc/state/jev/log', 'chmod 600 ~/.claude/settings.json', 'mv ~/.claude/settings.json /tmp/m', 'truncate -s 0 ~/.omc/state/jev/b', 'bash -c "echo x > ~/.claude/settings.json"'];
    for (const c of yes) {
      const r = run({ tool_name: 'Bash', tool_input: { command: c } }, { ...ENV, HOME: home });
      const h = (() => { try { return JSON.parse(r.stdout).hookSpecificOutput; } catch { return null; } })();
      expect(h?.permissionDecision === 'deny' && /^NEED:/.test(h.permissionDecisionReason || ''), `${c}: ${js(h)}`).toBe(true);
    }
    const no = ['cat ~/.claude/settings.json', 'ls ~/.claude/hooks', 'grep -r x ~/.claude/plugins', 'stat ~/.omc/state/jev', 'echo text without a redirect', 'sed s/a/b/ ~/.claude/settings.json > /tmp/result'];
    for (const c of no) {
      const r = run({ tool_name: 'Bash', tool_input: { command: c } }, { ...ENV, HOME: home });
      expect(r.status === 0 && r.stdout === '', `${c}: ${js(r)}`).toBe(true);
    }
  });

  it('(22c) refuses claude by name in wrappers and after `;`, and lets the advisor, `which claude` and `cat claude.txt` through', () => {
    const yes = ['env claude -p x', 'bash -c "claude -p x"', 'timeout 5 claude -p x', 'nohup claude -p x &', 'x=$(claude -p y)', 'claude -p y; ls', '/opt/tools/bin/claude -p x'];
    const no = ['provider-advisor "x"', 'which claude', 'which claude-wrap', 'ls claude', 'cat claude.txt', 'echo claude', 'grep claude file'];
    expect({ blocked: yes.filter((c) => !denied(respond(c))), passed: no.filter((c) => denied(respond(c))) }).toEqual({ blocked: [], passed: [] });
    expect(!denied(respond('provider-advisor "worker question"')) && denied(respond('claude -p x'))).toBe(true);
  });

  it('(22d) refuses writes to the git configuration: config with a value (also --global, -c, --add/--unset/--edit) and remote add/set-url/remove/rename/prune; reading passes', () => {
    const yes = ['git config user.email x', 'git config --global user.name x', 'git -c a=b config user.email x', 'git config --add a.b c', 'git config --unset a.b', 'git config -e', 'git config --edit', 'git remote add origin http://x', 'git remote set-url origin http://y', 'git remote remove origin', 'git remote rename a b', 'git remote prune origin', 'bash -c "git config user.email x"'];
    const no = ['git config user.email', 'git config --list', 'git config -l', 'git config --get user.email', 'git remote', 'git remote -v', 'git remote show origin', 'git remote get-url origin', 'git -c a=b config user.email', 'git config -f other.json key'];
    expect({ blocked: yes.filter((c) => !denied(respond(c))), passed: no.filter((c) => denied(respond(c))) }).toEqual({ blocked: [], passed: [] });
    expect(reasonOf(respond('git config user.email x'))).toMatch(/git configuration/);
  });

  it('(22e) file tool guard: Write outside the task directory is refused (OMC_TEAM_WORKTREE_PATH, OMC_PROVIDER_FILE_ROOT), Read of a credential file refused, Read in the worktree and Grep without path pass, .git in the worktree refused, an outgoing link refused after realpath, without a base only credentials and components', () => {
    const wt = join(tmp.dir, 'wt');
    mkdirSync(join(wt, '.git'), { recursive: true });
    writeFileSync(join(wt, 'file.txt'), 'x');
    writeFileSync(join(wt, '.git', 'config'), '[core]');
    symlinkSync('/etc/passwd', join(wt, 'link-out'));
    const sp = (tool, input, env = {}, extra = {}) => run({ tool_name: tool, tool_input: input, ...extra }, { ...ENV, ...env });
    const root = { OMC_TEAM_WORKTREE_PATH: wt };
    expect(deniedRun(sp('Write', { file_path: '/etc/xyz' }, root)), 'Write outside the worktree').toBe(true);
    expect(deniedRun(sp('Read', { file_path: '/home/user/.claude/.credentials.json' }, root)), 'Read credentials').toBe(true);
    expect(sp('Read', { file_path: join(wt, 'file.txt') }, root).stdout, 'Read in the worktree').toBe('');
    expect(deniedRun(sp('Read', { file_path: join(wt, '.git', 'config') }, root)), 'Read .git in the worktree').toBe(true);
    expect(deniedRun(sp('Read', { file_path: join(wt, 'link-out') }, root)), 'outgoing link (realpath)').toBe(true);
    expect(sp('Grep', { pattern: 'x' }, root).stdout, 'Grep without path').toBe('');
    expect(deniedRun(sp('Grep', { pattern: 'x', path: '/etc' }, root)), 'Grep path outside').toBe(true);
    expect(deniedRun(sp('Edit', { file_path: '/home/user/work/.claude/settings.json' }, root)), 'Edit .claude outside').toBe(true);
    expect(deniedRun(sp('Write', { file_path: '/tmp/not-here' }, { OMC_PROVIDER_FILE_ROOT: wt })), 'OMC_PROVIDER_FILE_ROOT: outside the task directory').toBe(true);
    expect(sp('Write', { file_path: join(wt, 'new.txt') }, { OMC_PROVIDER_FILE_ROOT: wt }).stdout, 'a new file in OMC_PROVIDER_FILE_ROOT').toBe('');
    expect(sp('Read', { file_path: '/etc/x' }, {}, { cwd: wt }).stdout, 'cwd from the hook input is not a base: a session without executor variables has no path restriction').toBe('');
    expect(sp('Read', { file_path: '/etc/passwd' }).stdout, 'without a base: unknown paths pass').toBe('');
    expect(deniedRun(sp('Read', { file_path: '/home/user/.claude/.credentials.json' })), 'without a base: credentials refused').toBe(true);
    expect(sp('Read', { file_path: '/home/user/work/.omc/x' }).stdout, 'without a base: .omc in the path passes').toBe('');
    expect(deniedRun(sp('Read', { file_path: '/home/user/work/.omc/x' }, { OMC_PROVIDER_FILE_ROOT: wt })), 'with a base: .omc outside the task directory refused').toBe(true);
    expect(sp('Read', { file_path: '/tmp/briefs/lane.md' }).stdout, 'a provider session without executor variables reads a brief').toBe('');
  });

  it('(22f) guard: a protected key directory without a slash and credential globs refused; a write to a .git component through Bash refused (command and redirect), reading .gitignore passes; kill/pkill/killall aimed at the proxy and `provider-proxy stop` refused, kill 12345 passes; git commit -m with a blocked name in the body passes, cat of a binary path passes', () => {
    // relative key directory and globs
    expect(denied(respond('cd /home/user && cat .acme-keys/api.key')), 'relative key directory after cd').toBe(true);
    expect(denied(respond('cd ~ && cat .acme-keys/*')), 'glob .acme-keys/* after cd ~').toBe(true);
    expect(denied(respond('cat /home/user/.claude/.cred*')), 'glob .cred* refused').toBe(true);
    expect(denied(respond('cat /home/user/.acme-keys/x')) && respond('ls *.js') === null && respond('grep "x?" file') === null, 'absolute key path refused, ordinary globs pass').toBe(true);
    expect(respond('cat some.acme-keys'), 'file some.acme-keys (not the key directory) passes').toBe(null);
    // .git through Bash (write commands and redirects) and file tools
    expect(denied(respond('echo x >> /home/user/work/.git/hooks/pre-commit')), 'echo >> .git/hooks/pre-commit').toBe(true);
    expect(denied(respond('cp /tmp/h /home/user/work/.git/hooks/pre-commit')), 'cp into .git/hooks').toBe(true);
    expect(denied(respond('echo x >> .git/config')), 'echo >> .git/config (relative)').toBe(true);
    expect(denied(respond('echo > /home/user/work/.git/info/exclude')), 'echo > .git/info/exclude').toBe(true);
    expect(deniedRun(run({ tool_name: 'Write', tool_input: { file_path: '/home/user/work/.git/hooks/pre-commit' } })), 'Write into .git/hooks (without a base)').toBe(true);
    expect(respond('echo x >> .gitignore') === null && respond('echo x >> .gitattributes') === null && respond('echo x >> /home/user/work/.git2/h') === null, '.gitignore, .gitattributes and .git2 pass').toBe(true);
    // the proxy
    expect(denied(respond('pkill provider-proxy')), 'pkill provider-proxy').toBe(true);
    expect(denied(respond('killall provider-proxy')), 'killall provider-proxy').toBe(true);
    expect(denied(respond('pkill -f _serve')), 'pkill -f _serve').toBe(true);
    expect(denied(respond(`kill $(cat ${STATE_DIR.replace('/home/user', '~')}/proxy/proxy.pid)`)), 'kill $(cat proxy.pid)').toBe(true);
    expect(denied(respond('node /opt/tools/provider-proxy.mjs stop')), 'node provider-proxy stop').toBe(true);
    expect(respond('kill 12345') === null && respond('provider-proxy status') === null, 'kill 12345 and provider-proxy status pass').toBe(true);
    // false alarms
    expect(respond('git commit -m "a\nclaude run b"'), 'a multi-line git commit -m with claude in the body passes').toBe(null);
    expect(respond('git commit -m "claude-wrap: description"') === null && denied(respond('git commit -m msg; claude -p x')), 'git commit -m passes; commit then claude refused').toBe(true);
    expect(respond('cat /home/user/work/tools/claude-wrap') === null && respond('node tests/claude-wrap.mjs') === null, 'cat of a binary path and node tests/claude-wrap.mjs pass').toBe(true);
    // fail-closed when the guard script fails: a script that exits with a non-zero code (guardCommand with "|| printf deny") and an uncaught exception (test mode)
    const badScript = join(tmp.dir, 'guard-crash');
    writeFileSync(badScript, '#!/bin/bash\nexit 5\n', { mode: 0o755 });
    expect(deniedRun(spawnSync('/bin/sh', ['-c', settings.guardCommand(badScript)], { input: '{}', encoding: 'utf8' })), 'guard failure (exit code 5): denial through guardCommand').toBe(true);
    expect(deniedRun(run('{}', { OMC_PROVIDER: 'test-fail-closed' })), 'uncaught exception: denial (test-fail-closed mode)').toBe(true);
  });

  it('(13 proxy) refuses `provider-proxy stop|restart` and kill/pkill/killall aimed at the proxy (also by full path and through node); start and status pass', () => {
    const blocked = ['provider-proxy stop', 'provider-proxy restart', `${GUARD.replace('provider-bash-guard.cjs', 'provider-proxy.mjs')} stop`, 'sudo /opt/tools/provider-proxy stop', `kill $(cat ${STATE_DIR.replace('/home/user', '~')}/proxy/proxy.pid)`, 'pkill -f provider-proxy', 'bash -c "provider-proxy stop"', 'killall provider-proxy', 'pkill -f _serve', 'node /opt/tools/provider-proxy.mjs stop'];
    const passed = ['provider-proxy start', 'provider-proxy status', '/opt/tools/provider-proxy status', 'ls provider-proxy.txt', `cat ${STATE_DIR.replace('/home/user', '~')}/proxy/counters.json`];
    expect({ missed: blocked.filter((c) => !denied(respond(c))), wrong: passed.filter((c) => denied(respond(c))) }).toEqual({ missed: [], wrong: [] });
  });

  it('(25d) the advisor by its bare name passes (also in bash -c, with stdin, in a loop, through a substitution), with a path it is refused; test variables inline with the advisor are refused; `advisor x; claude` is still refused', () => {
    const no = ['provider-advisor "question with context"', 'echo x | provider-advisor', 'cd /tmp && provider-advisor "x"', 'bash -c "provider-advisor x"', 'X=$(provider-advisor "x")', 'for i in 1; do provider-advisor "x"; done'];
    const yes = ['/tmp/provider-advisor x', './provider-advisor x', '/opt/tools/bin/provider-advisor x', 'provider-advisor x; claude', 'provider-advisor | claude-wrap', 'provider-advisor x && claude -p y', 'OMC_PROVIDER_ADVISOR_LOG_FILE=/tmp/x provider-advisor x'];
    expect({ blocked: no.filter((c) => denied(respond(c))), passed: yes.filter((c) => !denied(respond(c))) }).toEqual({ blocked: [], passed: [] });
  });

  it('refuses direct calls of the advisor counter and passes readers and git on its module file', () => {
    const yes = ['advisor-limit reserve', 'node advisor-limit.cjs reserve', 'bash advisor-limit x', 'sudo node /opt/tools/lib/advisor-limit.cjs reserve'];
    const no = ['cat lib/advisor-limit.cjs', 'git add lib/advisor-limit.cjs', 'rg reserve lib/advisor-limit.cjs'];
    expect({ missed: yes.filter((c) => !denied(respond(c))), wrong: no.filter((c) => denied(respond(c))) }).toEqual({ missed: [], wrong: [] });
  });

  it('without OMC_PROVIDER_GUARD the general values apply: claude and the provider tools are blocked, nothing is allowed, credential files are protected', () => {
    const env = { OMC_PROVIDER: 'acme' };
    expect(denied(respond('claude -p x', 'Bash', env)) && denied(respond('provider-team x', 'Bash', env)) && denied(respond('provider-launch x', 'Bash', env))).toBe(true);
    expect(denied(respond('cat /home/user/.claude/.credentials.json', 'Bash', env))).toBe(true);
    expect(respond('provider-advisor x', 'Bash', env)).toBe(null);
    expect(respond('git status', 'Bash', env)).toBe(null);
    expect([...guard.guardConfig(env).allowed]).toEqual([]);
  });

  it('the extra protected paths of the configuration are protected from writes (Bash and file tools), reading passes', () => {
    const dir = join(tmp.dir, 'extra-protected');
    const env = { ...ENV, OMC_PROVIDER_GUARD: js({ extraProtectedPaths: [dir] }), HOME: tmp.home };
    const write = run({ tool_name: 'Write', tool_input: { file_path: join(dir, 'a.txt') } }, env);
    const bash = run({ tool_name: 'Bash', tool_input: { command: `echo x > ${join(dir, 'b.txt')}` } }, env);
    const read = run({ tool_name: 'Bash', tool_input: { command: `cat ${join(dir, 'b.txt')}` } }, env);
    expect(deniedRun(write) && deniedRun(bash) && read.stdout === '').toBe(true);
  });
  it('the git baselines of the workers are protected like the settings copies: Bash commands that name the directory are refused (sed, node, python, cat), the same commands without it pass', () => {
    const dir = `${STATE_DIR}/git-baseline/team-a/worker-1.json`;
    for (const command of [`sed -i 's/false/true/' ${dir}`, `node -e "require('fs').writeFileSync('${dir}','{}')"`, `python3 -c "open('${dir}','w').write('{}')"`, `cat ${dir}`]) {
      expect(denied(respond(command)), command).toBe(true);
    }
    expect(denied(respond(`sed -i 's/false/true/' ${STATE_DIR}/notes/x.json`))).toBe(false);
  });
});
