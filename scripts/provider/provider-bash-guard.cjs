#!/usr/bin/env node
'use strict';
// PreToolUse guard (Bash and file tools) of processes that run on an alternative provider. It is the second layer; the first is the provider key in the
// session env and the `claude` shim in PATH (see lib/settings.cjs).
// Blocks: (1) commands that start `claude` or its wrappers (the blocked command names from the guard configuration, `omc ask`, `omc team` other than
// `omc team api`, npx claude-code), also by absolute path and by the path of a versioned binary, and the launcher files of this package (`.cjs`) by name,
// by path and through `node` or a shell (`node provider-launch.cjs`); (2) printing the environment (`env`, `printenv`,
// `export -p`, /proc/*/environ); (3) reading credential files (.credentials.json, copies of the --settings file, the profile and key files named in the configuration).
// It works only when the process env has OMC_PROVIDER set (the marker from the --settings copy); in other processes it does nothing. The parsing is a
// heuristic: it does not see commands hidden in scripts, interpreters (python -c, node -e), `echo ... | bash` and variables, so it is not a security boundary.
// Reason: a `claude` process with the provider address in its env but without the provider credentials sends the user's login token to that address;
// the env from --settings is inherited by child processes.
// Allowed commands (the guard configuration): the advisor command of the worker. The exception applies only to the bare name (no slash; a shim in
// PATH): `/tmp/<advisor>` and `./<advisor>` are refused, and `<advisor> x; claude` is still refused because the parser counts each segment on its own.
// Subagents of the worker do not call the advisor (the hook input has no agent id; the rule enforces it with a shared per-task counter).
// It also refuses: the test variables of the advisor and of the tools (OMC_PROVIDER_ADVISOR_*, OMC_PROVIDER_CLAUDE_BIN, OMC_PROVIDER_BASE_URL,
// OMC_PROVIDER_API_KEY_FILE, OMC_PROVIDER_QUOTA_URL: a worker cannot set them inline), references to $ANTHROPIC_AUTH_TOKEN, and `git push` and `git stash`
// (the stash is shared by the repository; pushing is the lead's job).
// It refuses stopping the provider proxy (`provider-proxy stop|restart`, also by full path and in wrappers) and kill/pkill aimed at it, writes to the
// git configuration (`git config` with a value, `git remote add|set-url|remove|rename|prune`) and the rules of the file tools (the task directory
// only, no .git/.claude/.omc and no credentials). It also refuses writes to the supervision configuration (<config dir>/settings*.json, hooks/, plugins,
// the OMC jev state) and to .git components. The hook input is handled in a try/catch (an exception = deny, fail-closed).
const { basename, dirname, isAbsolute, join, normalize, resolve } = require('node:path');
const { homedir } = require('node:os');
const { realpathSync } = require('node:fs');
const { GUARD_BLOCKED } = require('./lib/profile.cjs');
const { COMMAND_NAMES } = require('./lib/settings.cjs');

// ---- configuration: OMC_PROVIDER_GUARD (JSON) from the --settings env block; without it general values ----
const ESCAPE_RE = (s) => String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const GENERAL_CREDENTIAL_PATTERN = '\\.credentials\\.json|\\/proc\\/[^\\s;|&]*\\/environ|\\.claude\\.json';
const GENERAL_FILE_CREDENTIAL_PATTERN = '\\.credentials\\.json|\\/proc\\/[^\\s/]*\\/environ|\\.claude\\.json';
const compilePattern = (source) => { try { return new RegExp(source); } catch { return new RegExp(ESCAPE_RE(source)); } };
function guardConfig(env = process.env) {
  let raw = {};
  try { const parsed = JSON.parse(env.OMC_PROVIDER_GUARD || '{}'); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed; } catch { /* bad JSON: general values */ }
  const list = (v, fallback) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : fallback);
  const blocked = new Set(list(raw.blockedCommands, [...GUARD_BLOCKED]));
  const allowed = new Set(list(raw.allowedCommands, []));
  // Paths taken from the running session: the settings copies directory under the state directory and the copy of this session.
  const derived = [];
  if (env.OMC_PROVIDER_STATE_DIR) derived.push(ESCAPE_RE(join(env.OMC_PROVIDER_STATE_DIR, 'worker-settings')));
  if (env.OMC_PROVIDER_SETTINGS_FILE) derived.push(ESCAPE_RE(env.OMC_PROVIDER_SETTINGS_FILE));
  const extra = [...derived.map(compilePattern), ...list(raw.extraProtectedPatterns, []).map(compilePattern)];
  const extraPaths = list(raw.extraProtectedPaths, []);
  const names = [...blocked].map(ESCAPE_RE).join('|');
  const launchers = [...blocked].filter((n) => COMMAND_NAMES.includes(n)).map(ESCAPE_RE).join('|'); // only the launcher files this package ships have a .cjs form
  return {
    blocked,
    allowed,
    credentials: [new RegExp(GENERAL_CREDENTIAL_PATTERN), ...extra],
    fileCredentials: [new RegExp(GENERAL_FILE_CREDENTIAL_PATTERN), ...extra],
    extraPaths,
    binary: names ? new RegExp(`(^|\\/)(${names})$` + (launchers ? `|(^|\\/)(${launchers})\\.cjs$` : '')) : /(?!)/,
  };
}

const WRAPPERS = new Set(['env', 'exec', 'sudo', 'nohup', 'command', 'time', 'nice', 'stdbuf', 'setsid', 'xargs', 'timeout', 'builtin', 'ionice', 'chrt', 'taskset', 'script', 'eval', 'doas', 'su', 'unshare', 'watch', 'flock', 'strace', 'ltrace']);
const SHELL_WORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'coproc', 'time']);
const OPTIONS_WITH_ARGUMENT = new Set(['-u', '-g', '-C', '-D', '-s', '-k', '-n', '-p', '-t', '-h', '-U', '-r', '-R', '-T', '-S', '-c']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'pnpm', 'npm', 'yarn', 'uvx']);
const TEST_VARIABLES = /OMC_PROVIDER_(?:ADVISOR_[A-Z_]+|CLAUDE_BIN|BASE_URL|API_KEY_FILE|QUOTA_URL)/;
const TOKEN_REFERENCE = /\$\{?ANTHROPIC_AUTH_TOKEN/;
const STOP_PROXY = /\b(?:pkill|killall|kill)\b[^;&|]*\b(?:provider-proxy|_serve|proxy\.pid)/;
const GIT_OPTIONS_WITH_ARGUMENT = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
const READERS = new Set(['cat', 'head', 'tail', 'grep', 'ls', 'sed', 'wc', 'file', 'stat', 'diff']); // a binary path as an argument of a file reader does not run it (a known false alarm)
const base = (t) => t.split('/').pop();
// The launcher files of this package are `.cjs` files named after the commands this package ships (provider-launch.cjs), so a name is compared without the
// extension only for those commands, and only for `.cjs`: a user's own file such as ./tests/claude.mjs or ./claude.cjs is ordinary work and is not a launcher.
const LAUNCHER_EXTENSION = /\.cjs$/;
const stem = (name) => { const bare = name.replace(LAUNCHER_EXTENSION, ''); return bare !== name && COMMAND_NAMES.includes(bare) ? bare : name; };
const INTERPRETERS = new Set(['node', 'nodejs', ...SHELLS]);
// The launcher file an interpreter runs (`node provider-launch.cjs`, `bash -c 'node scripts/provider/provider-launch.cjs'` through the recursion below): the
// first argument that is not an option, as a name without the .cjs extension, when it is one of the shipped commands. Any other file (a test file named after a wrapper) is not a launcher.
const launcherName = (name, args) => { if (!INTERPRETERS.has(name)) return ''; const script = args.find((x) => !x.startsWith('-')); return script && stem(base(script)) !== base(script) ? stem(base(script)) : ''; };
const gitSubcommand = (t) => { for (let i = 0; i < t.length; i++) { if (GIT_OPTIONS_WITH_ARGUMENT.has(t[i])) { i++; continue; } if (t[i].startsWith('-')) continue; return t[i]; } return ''; };
const isClaudeBinary = (t, config) => /^(~|\.\/|\.\.\/|\/)/.test(t) && (config.binary.test(t) || /\/claude\/versions\//.test(t) || /\/versions\/\d+\.\d+\.\d+/.test(t));

// Returns the reason of a denial (text) or null.
function reason(command, config = guardConfig(), depth = 0) {
  if (depth > 4) return null;
  const raw = String(command);
  // The body of -m/-F/-C of git commit/tag is a message, not a command; the parser splits on \n and ;, so a message line that starts with a blocked name
  // would block the whole `git commit -m`. The body is cut on the RAW command (quotes still there, so a multi-line body disappears whole), only when the
  // command has git ... commit|tag (curl -F and the like are not cut).
  const gitCommitTag = /\bgit\b[^;&|\n]*\b(?:commit|tag)\b/.test(raw.replace(/["'\\]/g, ''));
  const text = (gitCommitTag ? raw.replace(/(-m|--message|-F|--file|-C|--reuse-message|--reedit-message)(\s+(?:"[^"]*"|'[^']*'|[^\s;&|()`"\\]+))?/g, '$1') : raw).replace(/["'\\]/g, ''); // cla""ude, \claude, 'claude'; an unquoted body without parser separators (; & | ( ) `), so they are not eaten with the body
  if (config.credentials.some((re) => re.test(text))) return 'reading credential files (the login of the host, copies of the session settings, provider key and profile files)';
  // Globs (* ? [) in a word with .cred: `cat /home/u/.claude/.cred*` reads credentials although the patterns above need the full name; denial fail-closed.
  if (/[*?[]/.test(text) && /(^|[^A-Za-z0-9_])\.cred/.test(text)) return 'glob on credential files (the patterns * ? [ cover key and login files)';
  if (TEST_VARIABLES.test(text)) return 'test variables of the provider tools (OMC_PROVIDER_ADVISOR_*, OMC_PROVIDER_CLAUDE_BIN, OMC_PROVIDER_BASE_URL, OMC_PROVIDER_API_KEY_FILE, OMC_PROVIDER_QUOTA_URL) are set only by the lead, not by the worker';
  if (TOKEN_REFERENCE.test(text)) return 'a reference to $ANTHROPIC_AUTH_TOKEN (the session token does not go into commands or the transcript)';
  if (STOP_PROXY.test(text)) return 'stopping the provider proxy with kill/pkill; the lead or the user stops the proxy';
  const segments = text.split(/&&|\|\||\$\(|<<<|[;|&\n(){}`]/);
  for (const segment of segments) {
    let t = segment.trim().split(/\s+/).filter(Boolean);
    for (let n = 0; n < 16 && t.length; n++) {
      const p = t[0];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(p) || SHELL_WORDS.has(p)) { t.shift(); continue; }
      if (base(p) === 'env' && t.length === 1) return 'printing environment variables (the session env holds the provider key)';
      if (WRAPPERS.has(base(p))) {
        t.shift();
        while (t.length && (/^-/.test(t[0]) || /^\d+[smhd]?$/.test(t[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]))) { const o = t.shift(); if (OPTIONS_WITH_ARGUMENT.has(o) && t.length) t.shift(); }
        continue;
      }
      break;
    }
    if (!t.length) continue;
    const name = base(t[0]);
    const bareName = stem(name);
    const launcher = launcherName(name, t.slice(1));
    if (config.allowed.has(t[0])) continue;
    if (config.allowed.has(name) || config.allowed.has(bareName)) return `${bareName} may be called only by its bare name (no path)`;
    if (launcher && config.allowed.has(launcher)) return `${launcher} may be called only by its bare name (no path)`;
    // Only direct calls of the advisor counter and the top-model slot queue are refused: the bare name or a path as the first token (after wrappers) and an
    // interpreter (node, bash) that gets it as the first script argument. Readers and git (cat, rg, git add/diff on the module file) pass: that is work in the repo.
    const firstArgument = t[1] ? base(String(t[1])) : '';
    if (name === 'advisor-limit' || name === 'advisor-limit.cjs' || ((name === 'node' || name === 'bash') && (firstArgument === 'advisor-limit' || firstArgument === 'advisor-limit.cjs'))) return 'the consultation counter and the top-model slot queue (advisor-limit) are changed only by the advisor command while the limit is enabled (OMC_PROVIDER_ADVISOR_LIMIT=1); the lead raises limits with the OMC_PROVIDER_ADVISOR_LIMIT_* parameters, the remaining number is shown by the ADVISOR-LIMIT line in the advisor answer'; // a hard limit in code, not in the hands of the worker
    if (name === 'git') { const sub = gitSubcommand(t.slice(1)); if (sub === 'push') return 'git push (pushing is done by the lead or by a sync job, not by the worker)'; if (sub === 'stash') return 'git stash (the stash is shared by the repository and its worktrees; use a work-in-progress commit)'; if (sub === 'config' || sub === 'remote') { const w = gitWriteReason(t.slice(1)); if (w) return w; } }
    if (((name === 'provider-proxy' || name === 'provider-proxy.mjs') && (t[1] === 'stop' || t[1] === 'restart')) || (name === 'node' && /provider-proxy/.test(t[1] ?? '') && (t[2] === 'stop' || t[2] === 'restart'))) return 'stopping the provider proxy (request limit of the provider); the lead or the user stops and restarts it';
    if (config.blocked.has(name) || config.blocked.has(bareName) || (launcher && config.blocked.has(launcher)) || isClaudeBinary(t[0], config)) return 'starting claude and its wrappers';
    if (name === 'omc') {
      const rest = t.slice(1).map(base);
      if (rest[0] === 'team' && rest[1] !== 'api') return 'starting claude and its wrappers (omc team; exception: omc team api)';
      if (rest.includes('ask')) return 'starting claude and its wrappers (omc ask)';
    }
    const args = t.slice(1);
    if (PACKAGE_RUNNERS.has(name) && args.some((x) => /claude-code|anthropic-ai\/claude/.test(x))) return 'starting claude and its wrappers (claude-code through a package manager)';
    if (name === 'printenv' || (name === 'env' && t.length === 1) || (name === 'export' && t[1] === '-p') || (name === 'declare' && /^-[a-z]*x/.test(t[1] || '')) || (name === 'set' && t.length === 1)) return 'printing environment variables (the session env holds the provider key)';
    if (SHELLS.has(name)) { const k = t.findIndex((x) => /^-[a-z]*c[a-z]*$/.test(x)); if (k >= 0 && t[k + 1]) { const w = reason(t.slice(k + 1).join(' '), config, depth + 1); if (w) return w; } }
    for (const x of args) if (!READERS.has(name) && isClaudeBinary(x, config)) return 'starting claude and its wrappers (a binary path in the command)'; // arguments of a file reader are not checked for a binary
  }
  return null;
}
const blockedCommand = (command, config) => reason(command, config) !== null;

// Protected supervision configuration of the worker: host settings (<config dir>/settings*.json), hooks (<config dir>/hooks/), plugins
// (<config dir>/plugins, includes the OMC plugin directory) and the OMC jev state. A process stopped by the guard could switch the supervision off
// with a write; reading these files is not blocked (except the credential files above). Expands ~, $HOME and ${HOME}; `home` can be given (tests).
const WRITE_COMMANDS = new Set(['tee', 'cp', 'mv', 'rm', 'rmdir', 'mkdir', 'touch', 'truncate', 'install', 'dd', 'rsync', 'ln', 'chmod', 'chown', 'chattr', 'patch', 'shred', 'unlink']);
function writesSupervision(path, home = homedir()) {
  let p;
  try { p = resolve(String(path).replace(/^~(?=\/|$)/, home).replace(/\$\{?HOME\}?/g, home)); } catch { return true; } // an unparsable path: denial (fail-closed)
  const configDirs = [join(home, '.claude')];
  if (process.env.CLAUDE_CONFIG_DIR) configDirs.push(resolve(process.env.CLAUDE_CONFIG_DIR));
  const name = basename(p);
  if (configDirs.some((dir) => dirname(p) === dir) && name.startsWith('settings') && name.endsWith('.json')) return true;
  const protectedDirs = [...configDirs.flatMap((dir) => [join(dir, 'hooks'), join(dir, 'plugins')]), join(homedir(), '.omc', 'state', 'jev')];
  return protectedDirs.some((dir) => p === dir || p.startsWith(`${dir}/`));
}
// A write to a .git component through Bash (echo >> .git/hooks/pre-commit, cp into .git/config, echo > .git/info/exclude): the blocks of .git/.claude/.omc
// in the file-tool rule cover only file tools, and a hook written by the worker would run at the lead's next commit. A `.git` component in the path (after
// expanding ~ and $HOME) is a denial; the file names .gitignore and .gitattributes (allowed in work) pass.
function writesGit(path, home = homedir()) {
  let p;
  try { p = resolve(String(path).replace(/^~(?=\/|$)/, home).replace(/\$\{?HOME\}?/g, home)); } catch { return true; } // an unparsable path: denial (fail-closed)
  return p.split('/').includes('.git');
}
// Directories added by the guard configuration (extraProtectedPaths) are protected like the supervision configuration.
function inExtraPaths(path, config, home = homedir()) {
  if (!config.extraPaths.length) return false;
  let p;
  try { p = resolve(String(path).replace(/^~(?=\/|$)/, home).replace(/\$\{?HOME\}?/g, home)); } catch { return true; } // an unparsable path: denial (fail-closed)
  return config.extraPaths.some((dir) => { const d = resolve(String(dir).replace(/^~(?=\/|$)/, home)); return p === d || p.startsWith(`${d}/`); });
}
// A Bash command that writes to the supervision or to a .git component: a write command (or sed -i) with a protected path among the arguments, or a redirect (>, >>) with a protected target.
// A heuristic like the parser above: interpreters (python -c, node -e), scripts and variables are not seen.
function bashWritesSupervision(command, config = guardConfig()) {
  const text = String(command).replace(/["'\\]/g, '');
  const segments = text.split(/&&|\|\||\$\(|<<<|[;|&\n(){}`]/);
  const isProtected = (x) => writesSupervision(x) || inExtraPaths(x, config);
  for (const segment of segments) {
    const t = segment.trim().split(/\s+/).filter(Boolean);
    if (!t.length) continue;
    const name = base(t[0]);
    const writes = WRITE_COMMANDS.has(name) || (name === 'sed' && t.some((x) => /^-{1,2}i/.test(x)));
    if (writes && t.slice(1).some((x) => isProtected(x))) return `write to the supervision configuration (command ${name})`;
    if (writes && t.slice(1).some((x) => writesGit(x))) return `write to a .git component of the repository (command ${name}); a hook written by the worker would run at the lead's next commit`;
    for (let i = 0; i < t.length; i++) {
      const m = t[i].match(/^(\d*)(>>|>)(.*)$/);
      if (m) {
        const target = m[3] || t[i + 1] || '';
        if (target && isProtected(target)) return `write to the supervision configuration (redirect to ${target})`;
        if (target && writesGit(target)) return `write to a .git component of the repository (redirect to ${target}); a hook written by the worker would run at the lead's next commit`;
      }
    }
  }
  return null;
}

// Hard block of writes to the git configuration: `git config` with a value or a write option, and `git remote` with a changing subcommand; in a linked worktree
// without extensions.worktreeConfig they write the shared .git/config (a change of the commit author and of the remotes of the repository in all trees).
// Reading (`git config --list`, `git config key`, `git remote -v`, `git remote show`) passes.
const GIT_CONFIG_WRITE_OPTIONS = new Set(['--add', '--unset', '--unset-all', '--replace-all', '--edit', '-e', '--remove-section', '--rename-section']);
const GIT_CONFIG_OPTIONS_WITH_ARGUMENT = new Set(['-f', '--file', '--blob', '--default']);
const GIT_REMOTE_WRITE = new Set(['add', 'set-url', 'remove', 'rename', 'prune', 'set-head']);
const GIT_WRITE_REASON = 'write to the git configuration (in a linked worktree `git config` with a value and `git remote add|set-url|remove|rename|prune` write the shared .git/config: a change of the commit author and of the remotes of the repository in all trees); the lead changes the configuration';
const gitPositional = (args, withArgument = GIT_OPTIONS_WITH_ARGUMENT) => { const out = []; for (let k = 0; k < args.length; k++) { const x = args[k]; if (withArgument.has(x)) { k++; continue; } if (x === '--') { out.push(...args.slice(k + 1)); break; } if (x.startsWith('-')) continue; out.push(x); } return out; };
function gitWriteReason(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) { if (GIT_OPTIONS_WITH_ARGUMENT.has(args[i]) && args[i + 1]) i++; i++; }
  const sub = args[i];
  if (sub === 'config') {
    const rest = args.slice(i + 1);
    if (rest.some((x) => GIT_CONFIG_WRITE_OPTIONS.has(x))) return GIT_WRITE_REASON;
    if (gitPositional(rest, GIT_CONFIG_OPTIONS_WITH_ARGUMENT).length >= 2) return GIT_WRITE_REASON;
  }
  if (sub === 'remote') {
    const positional = gitPositional(args.slice(i + 1));
    if (positional.length && GIT_REMOTE_WRITE.has(positional[0])) return GIT_WRITE_REASON;
  }
  return null;
}

// Guard of the file tools (Read, Edit, Write, Grep, Glob, MultiEdit, NotebookEdit; the matcher in lib/settings.cjs is wider than Bash).
// Denial: credential paths (always), paths outside the task directory (after realpath, so also outgoing links; the base is OMC_PROVIDER_FILE_ROOT, then
// OMC_TEAM_WORKTREE_PATH for omc team) and the components .git, .claude, .omc in the part of the path under the task directory (an OMC worktree lies under
// a .claude directory, so a rule on the whole path would block the whole task). Grep/Glob without `path` work in the cwd of the session and pass.
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'Grep', 'Glob', 'MultiEdit', 'NotebookEdit']);
const FORBIDDEN_COMPONENTS = new Set(['.git', '.claude', '.omc']);
const underDirectory = (path, dir) => { const s = String(path).replace(/\/+$/, ''); const d = String(dir).replace(/\/+$/, ''); return s === d || s.startsWith(`${d}/`); };
// The path restriction applies only to executors: the base comes from OMC_PROVIDER_FILE_ROOT (explicit) or OMC_TEAM_WORKTREE_PATH (omc team);
// in a session without these variables there is NO path restriction (the cwd from the hook input is not a base): credentials are still refused and,
// for write tools, writes to the supervision and to a .git component.
const taskDirectory = (env = process.env) => (env.OMC_PROVIDER_FILE_ROOT && typeof env.OMC_PROVIDER_FILE_ROOT === 'string' ? env.OMC_PROVIDER_FILE_ROOT : env.OMC_TEAM_WORKTREE_PATH || null);
function fileReason(input, config = guardConfig(), env = process.env) {
  const t = input?.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const raw = typeof t.file_path === 'string' && t.file_path ? t.file_path : typeof t.notebook_path === 'string' && t.notebook_path ? t.notebook_path : typeof t.path === 'string' && t.path ? t.path : '';
  if (!raw) return null;
  const root = taskDirectory(env);
  const absolute = isAbsolute(raw) ? raw : root ? join(root, raw) : null;
  if (!absolute) return null;
  let path; try { path = realpathSync(absolute); } catch { path = normalize(absolute); }
  if (config.fileCredentials.some((re) => re.test(path))) return 'reading credential files (the login of the host, copies of the session settings, provider key and profile files, process environments)';
  if (!root) return null; // a session without executor variables: no path restriction (credentials checked above); writes to the supervision and .git are blocked by the write rule in guardResponse
  if (!underDirectory(path, root)) return `path outside the task directory (${root})`;
  const relative = path.slice(String(root).replace(/\/+$/, '').length).replace(/^\/+/, '');
  if (relative.split('/').some((x) => FORBIDDEN_COMPONENTS.has(x))) return 'path in a .git, .claude or .omc directory (shared repository state and session configuration; the task directory only)';
  return null;
}

// The whole handling of the hook input is in a try/catch; on an exception the answer is deny (fail-closed): no answer is treated by the host as letting the command through.
// `data`: text from stdin or a parsed object (tests); returns the hook answer object or null (let through).
function guardResponse(data, env = process.env) {
  try {
    const input = typeof data === 'string' ? JSON.parse(data) : data;
    const tool = input?.tool_name;
    const config = guardConfig(env);
    let w = null;
    let fileRule = false;
    if (tool === 'Bash') {
      const command = String(input?.tool_input?.command ?? '');
      w = reason(command, config) || bashWritesSupervision(command, config);
    } else if (FILE_TOOLS.has(tool)) {
      const path = String(input?.tool_input?.file_path ?? input?.tool_input?.notebook_path ?? '');
      const writeTool = tool !== 'Read' && tool !== 'Grep' && tool !== 'Glob'; // Edit, Write, MultiEdit, NotebookEdit: the supervision rule
      if (writeTool && path && (writesSupervision(path) || inExtraPaths(path, config))) w = `write to the supervision configuration (${path})`;
      if (!w && writeTool && path && writesGit(path)) w = `write to a .git component of the repository (${path}); a hook written by the worker would run at the lead's next commit`; // also by file tools in sessions without a base
      if (!w) w = fileReason(input, config, env);
      fileRule = w !== null;
    }
    if (!w) return null;
    const supervision = w.startsWith('write to the supervision configuration');
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: supervision
        ? `NEED: write to the supervision configuration of the provider session (${w}). Protected: the host settings files, hooks and plugins directories and the OMC jev state; the lead changes these files in a session of the host, not the provider worker.`
        : fileRule
          ? `Provider session: path blocked (${w}). File tools work only in the task directory; outside it are credential files, shared repository state (.git) and the session configuration (.claude, .omc). Do it in the lead session or describe it in the report.`
          : `Provider session: command blocked (${w}). A claude process with the provider address could send the user's login token to that address, and the session env holds keys. Do it in the lead session or describe it in the report. Exception: omc team api (the worker channel).` } };
  } catch {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: 'Provider session: the guard could not safely parse the input (damaged input or a parsing error); blocked fail-closed. Discuss this command in the report to the lead.' } };
  }
}

// Fail-closed also when the script itself fails: an uncaught exception (or a stdin error) would end node with code 1, which the host treats as a
// non-blocking error (the command passes). The handler prints the deny JSON and ends with code 0.
function installFailClosed() {
  const crashResponse = () => { process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Provider session: the Bash guard did not finish correctly (script failure); command blocked fail-closed. Discuss this command in the report to the lead.' } })}\n`); process.exit(0); };
  process.on('uncaughtException', () => crashResponse());
  process.on('unhandledRejection', () => crashResponse());
  process.stdin.on('error', () => crashResponse());
}

module.exports = { blockedCommand, reason, guardConfig, guardResponse, writesSupervision, writesGit, bashWritesSupervision, gitWriteReason, fileReason, FILE_TOOLS, installFailClosed };

if (require.main === module) {
  if (process.env.OMC_PROVIDER === 'test-fail-closed') { installFailClosed(); process.nextTick(() => { throw new Error('simulated guard failure'); }); } // failure test mode (deny from the handler)
  else if (!process.env.OMC_PROVIDER) process.exit(0);
  else {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => {
      installFailClosed();
      const response = guardResponse(data);
      if (!response) process.exit(0);
      process.stdout.write(`${JSON.stringify(response)}\n`);
      process.exit(0);
    });
  }
}
