// /dev guard for the shell checks (opt-in: OMC_SHELL_CHECKS=1, no switch of its own; it runs wherever the shell checks run).
//
// Denies a Bash command, or a Write, Edit, MultiEdit or NotebookEdit call, that deletes, moves, overwrites, truncates, re-owns or
// recreates a path under /dev: a deleted or replaced /dev/null breaks the whole machine. Redirects to /dev/null, /dev/zero, /dev/full,
// /dev/random, /dev/urandom, /dev/stdout, /dev/stderr, /dev/tty, /dev/fd/N, /dev/tcp/... and /dev/udp/..., reads from /dev and /dev as
// the source of cp, install and ln stay allowed (/dev/stdin, other terminals and serial ports are refused: a write can reach something real).
// It reads the tokens of tokenizeBash. Every function is fail-open at the call site: the hook catches anything thrown.
//
// Recognized: every simple command of a list (; && || | |& & newline), ( ) { } $( ) ` ` <( ), bash -c and sh -c (any shell, -lc too),
// eval with literal arguments, a script given to a shell as here-document or here-string, ssh with a remote command, and the
// wrappers sudo, doas, env, command, builtin, exec, nice, ionice, nohup, timeout, stdbuf, setsid, time, coproc, xargs and busybox.
// Also refused with a path under /dev: mkfs*, mke2fs, wipefs (erasing forms), fdisk, sfdisk, gdisk and parted (not their listing forms),
// tar and bsdtar extracting with -C or --directory (not to the standard output; with -P or --absolute-names a member with a leading slash is judged by
// its own name and no named member is refused; the texts that tar runs, as the compress program of -I and --use-compress-program, --to-command (only when extracting to files), exec= of --checkpoint-action and the volume scripts of -F, --info-script and --new-volume-script, are scanned like eval), unzip -d (also the members named after the archive, joined
// with the directory in force at them, after --strip-components for tar, without the members that a literal --exclude of tar names and
// without the words from unzip -x up to the next option; after the archive every word of unzip is a member but -x and -d), awk and gawk with -i inplace, ed, ex and red.
// One exception: the atomic repair recipe for /dev/null passes when it is the whole command and /dev/null is not the character device 1:3.
// Relative paths are read from the cwd of the hook input and from cd, pushd and popd along the command (a cd that cannot be followed makes a replacing
// operation on a literal relative path refused), and the target of an operation goes through the links of the file system (rm, unlink, mv, install, ln, sed -i and
// perl -i replace a link as a link and are not followed; truncate, chmod, redirects, plain cp and a trailing slash are).
// Not resolved (known limits): variables and command substitutions inside the path, CDPATH, scripts read from a
// file, interpreters (python -c ...), unknown wrappers, a script piped into a shell, wildcards, braces, ANSI-C
// escapes and tildes in the path, a here-document for sudo -i, sudo -s and su, coproc NAME { ...; }, flock FILE COMMAND, runuser -u USER --
// COMMAND, a filter between a feeder and xargs, xargs -rI {}, abbreviated long options of the wrappers with a value in
// the next word, tar --transform, --xform, bsdtar -s, --one-top-level, tar --exclude with a wildcard or naming
// a directory and any bsdtar --exclude, the commands of tar --rsh-command and --rmt-command (remote archives), an archive extracted without naming its members into / or a
// directory above /dev, wildcard or listed (-T) members, commands that are not listed (mkswap, blkdiscard,
// losetup, cryptsetup, mdadm, ...).

import { lstatSync, realpathSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { tokenizeBash } from './shell-checks.mjs'; // import cycle: tokenizeBash is only called at run time, never while the modules load

export const DEV_GUARD_CLASS = 'dev-path';
export const DEV_FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const DEV_SINK = /^\/dev\/(?:null|zero|full|random|urandom|stdout|stderr|tty|fd\/\d+|tcp\/.+|udp\/.+)$/; // pseudo devices that redirects, tee and dd of= may write
const DEV_SCRATCH = /^\/dev\/shm\/./; // tmpfs scratch space: ordinary files of the session
const DEV_MAX_DEPTH = 6; // nested bash -c, eval, ssh, here-documents and find -exec
const DEV_SHELLS = new Set(['bash', 'sh', 'dash', 'zsh', 'ksh', 'ash']);
const DEV_FEEDERS = new Set(['echo', 'printf', 'ls', 'find', 'readlink', 'realpath']); // commands whose arguments become the input of the next command in a pipe (xargs)
const FIND_REFERENCE = /^-(?:newer|anewer|cnewer|samefile|newer[acmBt][acmBt])$/; // find tests whose argument is a file to compare with, not a file found

// The only command that may recreate /dev/null from a session: atomic (the node never disappears), and allowed only as the whole command
// (only spaces, tabs and newlines around it are ignored: bash keeps a CR or a Unicode space as part of a word, trim() would drop them).
export const DEV_NULL_REPAIR = 'mknod -m 666 /dev/null.new c 1 3 && mv -f /dev/null.new /dev/null';
const DEV_NULL_STATES = new Set(['healthy', 'broken', 'error']);

// State of /dev/null: 'healthy' (the character device 1:3), 'broken' (any other node, or none) or 'error' (the probe cannot tell).
// Reads the node with lstat only (no open, no change); lstat is a parameter so that tests never touch the real /dev.
export function probeDevNull(lstat = lstatSync) {
  try {
    const st = lstat('/dev/null');
    if (!st || typeof st.isCharacterDevice !== 'function') return 'error';
    if (!st.isCharacterDevice()) return 'broken';
    const rdev = BigInt(st.rdev); // Linux encoding: major in bits 8-19 and 32-43, minor in bits 0-7 and 12-31
    const major = ((rdev >> 8n) & 0xfffn) | ((rdev >> 32n) & 0xfffff000n);
    const minor = (rdev & 0xffn) | ((rdev >> 12n) & 0xffffff00n);
    return major === 1n && minor === 3n ? 'healthy' : 'broken';
  } catch (error) {
    return error?.code === 'ENOENT' ? 'broken' : 'error';
  }
}

// The probe result for the repair recipe. Only on Linux (macOS numbers its devices differently and Git Bash has a /dev of its own).
// devNullProbe replaces the real probe (a parameter of the checks, so that tests never touch the real /dev).
function devNullState({ platform, devNullProbe }) {
  if (platform !== 'linux') return 'error';
  try {
    const state = devNullProbe ? devNullProbe() : probeDevNull();
    return DEV_NULL_STATES.has(state) ? state : 'error';
  } catch {
    return 'error';
  }
}

// The directory in force for the relative paths of the command being scanned (set by checkBashDevPath and checkDevFileTool, followed through cd, pushd and
// popd): undefined when the hook gave none (relative paths are then not read), a path, or null after a cd that the guard cannot follow.
let devCwd;
const NO_DIR = Symbol('no directory yet');
let devRealLeft = 0; // how many paths the file system may still resolve for the command being scanned; beyond that only the text counts

// The path after the file system has resolved the links and the .. of the directories; the last component only when follow is true, or when follow is 'dir' and
// it is a directory (a link to a directory is entered by mv, cp, install and ln, a link to a file is replaced by them). Null when nothing could be resolved.
function devReal(path, follow) {
  if (devRealLeft-- <= 0) return null;
  const last = posix.basename(path);
  try {
    if (follow === true || path.endsWith('/') || last === '.' || last === '..') return realpathSync.native(path);
    if (follow === 'dir') { const full = realpathSync.native(path); if (statSync(full).isDirectory()) return full; }
  } catch { /* the path does not exist: its directory decides */ }
  try { return posix.join(realpathSync.native(posix.dirname(path)), last); } catch { return null; }
}

// The normalized path when value, read from the directory in force and through symbolic links, is at or under /dev, else null. resolve: false reads the text only.
function devPathOf(value, follow = true, resolve = true) {
  const raw = String(value ?? '');
  let path = raw;
  if (!raw.startsWith('/')) {
    if (!resolve || !raw || typeof devCwd !== 'string' || raw.includes('\u0000') || raw.startsWith('~')) return null;
    path = `${devCwd}/${raw}`;
  }
  const glued = /^\/dev(?=[\u0000*?[])/.test(path) ? `/dev/${path.slice(4)}` : path; // /dev* and /dev$X may name /dev or anything under it
  const lexical = posix.normalize(glued).replace(/\/+$/, '');
  if (lexical === '/dev' || lexical.startsWith('/dev/')) return lexical;
  if (!resolve || glued.includes('\u0000')) return null;
  const real = devReal(glued, follow);
  const resolved = real === null ? '' : posix.normalize(real).replace(/\/+$/, '');
  return resolved === '/dev' || resolved.startsWith('/dev/') ? resolved : null;
}
// A literal relative path after a cd that the guard cannot follow: it names an unknown file, so strict operations (the ones that replace a file) refuse it.
const devUnknownDir = (value, strict) => (strict && devCwd === null && typeof value === 'string' && value !== '' && !value.startsWith('/') && !value.startsWith('~') && !value.includes('\u0000') ? `${value} (a relative path after a cd that the guard cannot follow)` : null);
const devChanged = (value, follow = true, strict = false) => { const p = devPathOf(value, follow); return p ? (DEV_SCRATCH.test(p) ? null : p) : devUnknownDir(value, strict); }; // a path the commands of the guard must not change
const devChangedIn = (value, follow = true, strict = false) => { const p = devPathOf(value, follow); return p ? (DEV_SCRATCH.test(p) || p === '/dev/shm' ? null : p) : devUnknownDir(value, strict); }; // like devChanged, but the scratch directory itself is a fine place to put files into
const devLexicalIn = (value) => { const p = devPathOf(value, true, false); return p && !DEV_SCRATCH.test(p) && p !== '/dev/shm' ? p : null; }; // the text of an absolute path only: for the words of a command that are no operation target
const devWritten = (value) => { const p = devPathOf(value); return p && !DEV_SINK.test(p) && !DEV_SCRATCH.test(p) ? p : null; }; // a path a redirect, tee or dd may not write

// The directory that env -C TARGET starts its command in: TARGET (relative to base, or to the directory in force), null when it cannot be told.
function devWrapperDir(target, base) {
  if (target === undefined || target.includes('\u0000') || target.startsWith('~')) return null;
  if (target.startsWith('/')) return posix.normalize(target).replace(/\/+$/, '') || '/';
  const from = base === undefined ? devCwd : base;
  return typeof from === 'string' ? posix.normalize(`${from}/${target}`).replace(/\/+$/, '') || '/' : from;
}

// cd, pushd and popd: the directory in force for the relative paths that follow, until the end of the command (a group or a subshell is read as if it did not end).
function devChangeDir(name, args) {
  if (name === 'popd') { devCwd = null; return; }
  let i = 0;
  while (i < args.length && args[i].startsWith('-') && args[i] !== '-') if (args[i++] === '--') break;
  const target = args[i];
  if (target === undefined || target === '-' || target.includes('\u0000') || /^[~+-]/.test(target)) devCwd = null; // HOME, OLDPWD, a variable, a substitution, the stack of pushd
  else if (target === '') return;
  else if (target.startsWith('/')) devCwd = posix.normalize(target).replace(/\/+$/, '') || '/';
  else if (typeof devCwd === 'string') devCwd = posix.normalize(`${devCwd}/${target}`).replace(/\/+$/, '') || '/';
}

// Text of a word after quote removal; every expansion becomes a NUL, so "$HOME/dev/x" is not read as /dev/x and "/dev/$x" stays under /dev.
function devPartText(part) {
  if (part.kind === 'lit') return part.text.replace(/\\(.)/gs, '$1');
  if (part.kind === 'single' || part.kind === 'ansi') return part.text;
  if (part.kind === 'double') return part.parts.map((q) => (q.kind === 'lit' ? q.text.replace(/\\(?:\n|([$`"\\]))/g, '$1') : '\u0000')).join('');
  return '\u0000';
}
const devWordText = (word) => word.parts.map((p) => devPartText(p)).join('');
const DEV_MENTION = /\/dev(?:[/*?[\u0000]|$)/;
// Whether any word of the command list, however deeply nested, shows a /dev path (used where the guard stops following nesting).
// The file a redirect reads is no mention, and the file it writes only when devWritten refuses it, so 2>/dev/null stays fine.
const devMentions = (tokens) => tokens.some((t, i) => {
  if (t.type !== 'word') return false;
  const redirect = tokens[i - 1]?.type === 'redir' ? tokens[i - 1].value : null;
  const text = devWordText(t);
  const hit = redirect === null ? DEV_MENTION.test(text) : !['<', '<<', '<<-'].includes(redirect) && !!devWritten(text);
  return hit || devSubLists(t.parts).some(devMentions);
});

// Splits arguments into options and operands. valueOpts take a value (separate, attached to a short option, or after = in a long one).
function splitArgs(args, valueOpts = []) {
  const opts = [];
  const operands = [];
  const values = {};
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (literal || a === '-' || !a.startsWith('-')) { operands.push(a); continue; }
    if (a === '--') { literal = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      opts.push(name);
      if (eq > 0) values[name] = a.slice(eq + 1);
      else if (valueOpts.includes(name) && i + 1 < args.length) values[name] = args[++i];
      continue;
    }
    const short = valueOpts.find((o) => o.length === 2 && a.startsWith(o));
    if (short && a.length > 2) { opts.push(short); values[short] = a.slice(2); continue; }
    opts.push(a);
    if (valueOpts.includes(a) && i + 1 < args.length) values[a] = args[++i];
  }
  return { opts, operands, values };
}

// Every operand of these commands is a path they change (chmod, chown and chgrp also have a mode or owner operand, which is never /dev).
const DEV_ACTS_ON_LINK = new Set(['rm', 'unlink', 'rmdir']); // they remove a symbolic link and leave what it points to
const DEV_EVERY_OPERAND = {
  rm: [], unlink: [], rmdir: [], chattr: [], chmod: ['--reference'], chown: ['--reference', '--from'], chgrp: ['--reference'],
  setfacl: ['-m', '-x', '-M', '-X'], setfattr: ['-n', '-v', '-x'], shred: ['-n', '-s', '--iterations', '--size'],
  truncate: ['-s', '-r', '--size', '--reference'], touch: ['-d', '-t', '-r', '--date', '--time', '--reference'], mknod: ['-m', '--mode'], mkfifo: ['-m', '--mode'],
};

// touch, chown and chgrp change a symbolic link itself, not what it points to, with -h or --no-dereference; --dereference (chown and chgrp) turns that off
// again, and the last of them counts (measured with coreutils 9.4: --no-d and --d are the shortest prefixes, -h may sit in a cluster before a letter with a value).
const DEV_NO_DEREF = new Set(['touch', 'chown', 'chgrp', 'chmod']); // chmod -h leaves both the link and its target alone
function changesLinkItself(opts, name) {
  let itself = false;
  for (const o of opts) {
    if (o.startsWith('--')) {
      if (longIs(o, '--no-dereference', 6)) itself = true;
      else if (name !== 'touch' && longIs(o, '--dereference', 3)) itself = false;
      continue;
    }
    for (const c of o.slice(1)) {
      if (name === 'touch' && 'dtr'.includes(c)) break; // the rest of the word is the value of that option
      if (c === 'h') itself = true;
    }
  }
  return itself;
}

// Wrappers: options with a value (a long option with its value in the next argument too), and how many operands to skip before the wrapped
// command (timeout: the duration). env -S TEXT and env --split-string=TEXT are handled in devUnwrap.
const DEV_WRAPPERS = {
  sudo: { val: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t', '--user', '--group', '--host', '--prompt', '--close-from', '--chdir', '--chroot', '--role', '--type', '--other-user', '--command-timeout'], assign: true },
  doas: { val: ['-u', '-C'] }, env: { val: ['-u', '-C', '-S', '-a', '--unset', '--chdir', '--argv0', '--block-signal', '--default-signal', '--ignore-signal'], assign: true }, command: { val: [] }, builtin: { val: [] }, busybox: { val: [] },
  exec: { val: ['-a'] }, nice: { val: ['-n', '--adjustment'] }, ionice: { val: ['-c', '-n', '-p', '-P', '-u', '--class', '--classdata', '--pid', '--pgid', '--uid'] }, nohup: { val: [] },
  timeout: { val: ['-s', '--signal', '-k', '--kill-after'], skip: 1 }, stdbuf: { val: ['-i', '-o', '-e', '--input', '--output', '--error'] }, setsid: { val: [] }, time: { val: ['-f', '-o', '--format', '--output'] }, coproc: { val: [] },
  xargs: { val: ['-n', '-I', '-L', '-P', '-d', '-E', '-s', '-a', '--max-args', '--max-procs', '--delimiter', '--max-chars', '--arg-file', '--process-slot-var'], opt: 'lei' }, // opt: -l, -e and -i (and their long forms) take an attached value only, so the rest of a cluster after them is that value
};
const DEV_GROUP_OPEN = new Set(['{', 'if', 'while', 'until', 'for', 'case']);
const DEV_GROUP_CLOSE = new Set(['}', 'fi', 'done', 'esac']);
const DEV_OPENERS = new Set(['{', 'if', 'while', 'until']); // the words that may follow a pipe and open a command list
const DEV_LEADING = new Set(['then', 'do', 'else', 'elif', '{', '!', 'if', 'while', 'until']);
const baseName = (value) => String(value).replace(/\/+$/, '').split('/').pop();
const isAssignment = (value) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);

// The text of env -S as the shell parser should read it: env turns a backslash and underscore into a separator of arguments (inside quotes
// the blank stays in its argument, which the parser keeps in one word as well, so the quotes need no tracking).
const envSplitText = (text) => text.replace(/\\(.)/gs, (pair, c) => (c === '_' ? ' ' : pair));

// A long option of a wrapper written as a prefix takes its value in the next word too (measured: env --unse, nice --a, timeout --s, stdbuf --o and xargs --process
// do); a prefix that two options share makes the tool stop with an error, so it does not matter how it is read.
const wrapperTakesValue = (val, a) => val.includes(a) || (a.startsWith('--') && a.length > 2 && !a.includes('=') && val.some((v) => v.startsWith(a)));

// [name, ...args] without leading keywords, assignments and wrappers: { name, args, xargs, replace }, or null when nothing is left.
// xargs: the command is fed by a pipe; replace: the replace string of xargs -I, -i or --replace. env -S TEXT is a command line of its own: it
// comes back as eval with TEXT followed by the remaining arguments, but when TEXT starts with an option or with time (a program to env) its words go through env's options again.
function devUnwrap(values, keywords = new Set()) { // keywords: indexes of the words that are a plain unquoted time at the start of a pipeline
  let at = 0;
  let keyword = true; // still at the start of the command, where time is the keyword of the shell (only -p and -- follow it)
  let xargs = false;
  let replace;
  let dir; // the directory env -C or --chdir puts the wrapped command in (a path, null when unknown); undefined: the directory in force
  for (;;) {
    while (at < values.length && (isAssignment(values[at]) || DEV_LEADING.has(values[at]) || values[at] === 'function')) { if (isAssignment(values[at])) keyword = false; at += values[at] === 'function' ? 2 : 1; } // function NAME { ...
    if (at >= values.length) return null;
    const name = baseName(values[at]);
    const spec = Object.hasOwn(DEV_WRAPPERS, name) ? DEV_WRAPPERS[name] : null;
    if (!spec) return { name, args: values.slice(at + 1), xargs, replace, dir };
    const timeKeyword = keyword && name === 'time' && keywords.has(at);
    if (!timeKeyword) keyword = false;
    let i = at + 1;
    let split;
    let chdir; // the last -C or --chdir of this env: it counts alone and relative to the directory env started in
    for (; i < values.length; i++) {
      const a = values[i];
      if (a === '--') { i++; break; }
      if (timeKeyword && a !== '-p') break;
      if (spec.assign && isAssignment(a)) continue;
      if (!a.startsWith('-') || (a === '-' && name !== 'env')) break; // for env a lone dash is -i
      const envS = name === 'env' && !a.startsWith('--') ? /^-[^uCaS-]*S/.exec(a) : null; // -S inside a cluster, before any letter that takes a value
      if (envS || (name === 'env' && longIs(a.split('=')[0], '--split-string', 3))) { // the text to split follows, attached or as the next argument
        const eq = a.indexOf('=');
        split = envS ? (a.length > envS[0].length ? a.slice(envS[0].length) : values[++i]) : (eq > 0 ? a.slice(eq + 1) : values[++i]);
        continue;
      }
      if (name === 'env') { // -C DIR, -CDIR, --chdir=DIR and every prefix of --chdir (the value of a prefix in the next word is skipped here)
        const longC = a.startsWith('--') && longIs(a.split('=')[0], '--chdir', 3);
        const shortC = !a.startsWith('--') ? /^-[^uCaS]*C/.exec(a) : null;
        if (longC) chdir = a.includes('=') ? a.slice(a.indexOf('=') + 1) : values[i + 1];
        else if (shortC) chdir = a.length > shortC[0].length ? a.slice(shortC[0].length) : values[i + 1];
      }
      if (name === 'xargs') {
        if (a === '-I') replace = values[i + 1];
        const m = /^(?:-I(.+)|-i(.*)|--replace(?:=(.*))?)$/.exec(a);
        if (m) replace = m[1] ?? (m[2] || m[3] || '{}');
      }
      if (wrapperTakesValue(spec.val, a)) i++;
      else if (!a.startsWith('--')) { // a cluster of short options: the first letter with a value takes the rest of the word, or the next word when it ends the cluster
        let k = 1;
        while (k < a.length && !spec.val.includes(`-${a[k]}`) && !spec.opt?.includes(a[k])) k++;
        if (k === a.length - 1 && !spec.opt?.includes(a[k])) i++;
      }
    }
    if (chdir !== undefined) dir = devWrapperDir(chdir, dir);
    if (split !== undefined) {
      const text = envSplitText(split);
      const words = tokenizeBash(text).tokens.filter((t) => t.type === 'word').map(devWordText);
      if (words[0]?.startsWith('-') || words[0] === 'time') { values = ['env', ...words, ...values.slice(i)]; at = 0; continue; } // env reads the words again as its own options, then assignments, then the command; time is a program to it, not the keyword of the shell
      return { name: 'eval', args: [text, ...values.slice(i)], xargs, replace, dir };
    }
    if (name === 'command' && values.slice(at + 1, i).some((o) => /^-[a-z]*[vV]/.test(o))) return null; // command -v only looks the name up
    if (name === 'xargs') xargs = true;
    at = i + (spec.skip ?? 0);
  }
}

function sedInPlaceFiles(args) {
  let inPlace = false;
  let scripted = false;
  let literal = false;
  const operands = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (literal || a === '-' || !a.startsWith('-')) { operands.push(a); continue; }
    if (a === '--') { literal = true; continue; }
    if (a.startsWith('--')) {
      const name = a.split('=')[0];
      if (longIs(name, '--in-place', 3)) inPlace = true; // sed takes any unambiguous prefix: --i, --e, --li and --fi are the shortest (measured with sed 4.9)
      else if (longIs(name, '--expression', 3) || longIs(name, '--file', 4)) { scripted = true; if (!a.includes('=')) i++; }
      else if (longIs(name, '--line-length', 3) && !a.includes('=')) i++;
      continue;
    }
    for (let k = 1; k < a.length; k++) { // a cluster of short options: -n, -ni, -i.bak, -ie ...
      const c = a[k];
      if (c === 'i') { inPlace = true; break; } // the rest of the cluster is the backup suffix
      if (c === 'e' || c === 'f') { scripted = true; if (k === a.length - 1) i++; break; }
      if (c === 'l') { if (k === a.length - 1) i++; break; }
    }
  }
  return inPlace ? (scripted ? operands : operands.slice(1)) : [];
}

function perlInPlaceFiles(args) {
  let inPlace = false;
  let scripted = false;
  let literal = false;
  const operands = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (literal || a === '-' || !a.startsWith('-')) { operands.push(a); continue; }
    if (a === '--') { literal = true; continue; }
    if (a.startsWith('--')) continue;
    for (let k = 1; k < a.length; k++) { // -pi, -i.bak, -0777pi, -pe ... (-pie: the suffix is "e", the script is the first operand)
      const c = a[k];
      if (c === 'i') { inPlace = true; break; }
      if (c === 'e' || c === 'E') { scripted = true; if (k === a.length - 1) i++; break; }
      if (c === 'I' || c === 'M' || c === 'm') { if (k === a.length - 1 && c === 'I') i++; break; }
    }
  }
  return inPlace ? (scripted ? operands : operands.slice(1)) : [];
}

// Getopt-style arguments: short options (also clustered), long options, operands, and [option, value] pairs of the options that take a value
// (each pair is [option, value, index of the word that holds the option]; shortValue: letters; longValue: names or a predicate; shortAttached: letters with an optional argument, which is only ever attached, so
// the rest of the cluster after them is their value and not further options). Under- or over-consuming a value only matters when it hides or
// shows a /dev path.
function parseGetopt(args, shortValue = '', longValue = [], shortAttached = '') {
  const shorts = [];
  const longs = [];
  const operands = [];
  const operandAt = []; // the index of each operand among the arguments
  const values = [];
  const takesLong = typeof longValue === 'function' ? longValue : (name) => longValue.includes(name);
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (literal || a === '-' || !a.startsWith('-')) { operands.push(a); operandAt.push(i); continue; }
    if (a === '--') { literal = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      longs.push(name);
      if (eq > 0) values.push([name, a.slice(eq + 1), i]);
      else if (takesLong(name) && i + 1 < args.length) values.push([name, args[i + 1], i++]);
      continue;
    }
    for (let k = 1; k < a.length; k++) {
      shorts.push(a[k]);
      if (shortAttached.includes(a[k])) { if (k + 1 < a.length) values.push([a[k], a.slice(k + 1), i]); break; }
      if (!shortValue.includes(a[k])) continue;
      if (k + 1 < a.length) values.push([a[k], a.slice(k + 1), i]);
      else if (i + 1 < args.length) values.push([a[k], args[i + 1], i++]);
      break;
    }
  }
  return { shorts, longs, operands, operandAt, values };
}
// A long option written in full or abbreviated (GNU getopt takes any unambiguous prefix; min is the shortest unambiguous one).
const longIs = (name, full, min) => name.length >= min && full.startsWith(name);
// -t DIR and --target-directory=DIR (also abbreviated: --target DIR) of mv, cp, install and ln; -t may end a cluster of short options (-sft DIR).
const isTargetDirOption = (key) => key === 't' || longIs(key, '--target-directory', 3);
// -T and --no-target-directory of mv, cp, install and ln: the target is a plain name even when it is a link to a directory (any prefix from --no on; one that two options share makes the tool stop with an error).
const noTargetDir = (shorts, longs) => shorts.includes('T') || longs.some((o) => longIs(o, '--no-target-directory', 4));

// Partitioners: the options with which the command only lists, dumps or verifies; without one it edits (fdisk and gdisk are interactive).
const DEV_DISK_LISTING = {
  fdisk: { shorts: 'lxVh', longs: ['--list', '--list-details', '--version', '--help'], value: 'bCHStwWo', attached: 'Lcu' },
  sfdisk: { shorts: 'ldsFgTVvh', longs: ['--list', '--dump', '--show-size', '--list-free', '--show-geometry', '--verify', '--version', '--help', '--list-types'], value: 'NOIwWXuo', attached: 'L' },
  gdisk: { shorts: 'l?', longs: [], value: '', attached: '' },
};

// parted runs the commands given as operands after the device; only these read: print [free|devices|list|all|N], unit U, align-check T N, help, select D, version, quit.
function partedReadsOnly(commands) {
  if (!commands.length) return false; // no command: interactive
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i];
    if (c === 'print' || c === 'p') { while (/^(?:free|devices|list|all|\d+)$/.test(commands[i + 1] ?? '')) i++; }
    else if (c === 'unit' || c === 'select') i += 1;
    else if (c === 'align-check') i += 2;
    else if (c === 'help') { if (/^[a-z_-]+$/.test(commands[i + 1] ?? '')) i++; }
    else if (c !== 'version' && c !== 'quit' && c !== 'q') return false;
  }
  return true;
}

// The first path under /dev (devChangedIn) that one of the named archive members reaches from one of the absolute extraction directories.
// Only two kinds of directory can lead a member into /dev: those that ".." climbs out of to the root, and those under /dev/shm (one step
// up from /dev/shm itself is /dev); so the check keeps the smallest depth and the depths below /dev/shm instead of trying every pair.
function archiveMemberInDev(dirs, members) {
  let shallowest = Infinity;
  const shmDepths = new Set();
  for (const d of dirs) {
    const depth = d.split('/').filter(Boolean).length;
    shallowest = Math.min(shallowest, depth);
    if (d === '/dev/shm' || d.startsWith('/dev/shm/')) shmDepths.add(depth);
  }
  for (const member of members) {
    const name = posix.normalize(member);
    const ups = /^(?:\.\.\/)*/.exec(name + '/')[0].length / 3;
    const rest = name.slice(ups * 3);
    const found = (ups >= shallowest ? devChangedIn(posix.join('/', rest)) : null) ?? (shmDepths.has(ups + 1) ? devChangedIn(posix.join('/dev', rest)) : null);
    if (found) return found;
  }
  return null;
}

// The long options of tar and of bsdtar with a mandatory value, which may be the next word and is not a member (an archive, a list, a pattern, a date, a
// text...), by their full names (tarLongTakesValue reads the prefixes), and one set per tool, because a name that a tool does not know ends the command
// with an error and would swallow a real member if it were listed for the other. Options with an optional value (--backup, --checkpoint, --occurrence,
// --one-top-level, --totals) take it only after an equals sign.
const TAR_LONG_VALUE = {
  gnu: new Set([
  '--add-file', '--after-date', '--blocking-factor', '--checkpoint-action', '--directory', '--exclude', '--exclude-from', '--exclude-ignore',
  '--exclude-ignore-recursive', '--exclude-tag', '--exclude-tag-all', '--exclude-tag-under', '--file', '--files-from', '--format', '--group',
  '--group-map', '--hole-detection', '--index-file', '--info-script', '--label', '--level', '--listed-incremental', '--mode', '--mtime',
  '--newer', '--newer-mtime', '--new-volume-script', '--no-quote-chars', '--owner', '--owner-map', '--pax-option', '--quote-chars',
  '--quoting-style', '--record-size', '--rmt-command', '--rsh-command', '--sort', '--sparse-version', '--starting-file', '--strip-components',
  '--suffix', '--tape-length', '--to-command', '--transform', '--use-compress-program', '--volno-file', '--warning', '--xattrs-exclude',
  '--xattrs-include', '--xform',
  ]),
  bsd: new Set([
  '--blocking-factor', '--cd', '--directory', '--exclude', '--exclude-from', '--file', '--files-from', '--format', '--gid', '--gname',
  '--group', '--include', '--newer', '--newer-ctime', '--newer-ctime-than', '--newer-mtime', '--newer-mtime-than', '--newer-than', '--older',
  '--older-ctime', '--older-ctime-than', '--older-mtime', '--older-mtime-than', '--options', '--owner', '--passphrase', '--strip-components',
  '--uid', '--uname', '--use-compress-program',
  ]),
};

// Whether the long option `opt`, written in full or as a prefix, takes the next word as its value. Both tools take any prefix of an option name that is not
// ambiguous, and stop with an error on one that two options share, so such a prefix is read as a value option when it starts the name of one; only the exact
// name of an option without a mandatory value that starts a longer name (--sparse and --sparse-version) stays one without (measured with GNU tar 1.35).
const TAR_FLAG_PREFIX = new Set(['--checkpoint', '--list', '--sparse', '--xattrs']);
const tarLongTakesValue = (opt, tool) => TAR_LONG_VALUE[tool].has(opt) || (opt.length > 2 && !TAR_FLAG_PREFIX.has(opt) && [...TAR_LONG_VALUE[tool]].some((n) => n.startsWith(opt)));

// tar and bsdtar: the options of a command, with an old style first word read as options too. writes: the command extracts to files (not to the standard output).
function tarMode(args, name) {
  const valueLetters = 'bCfFgHIKLNTVX';
  let extract = false;
  let toStdout = false;
  let absolute = false; // -P and --absolute-names: a leading slash stays
  const dirs = [];
  const old = []; // [letter, value] of the letters of the old style first word that take a value
  let rest = args;
  if (args[0] && !args[0].startsWith('-')) { // old style: tar xCf dir archive
    let next = 1;
    for (const c of args[0]) {
      if (c === 'x') extract = true;
      if (c === 'O') toStdout = true;
      if (c === 'P') absolute = true;
      if (c === 'C' && args[next] !== undefined) dirs.push(args[next]);
      if (valueLetters.includes(c)) { if (args[next] !== undefined) old.push([c, args[next]]); next++; }
    }
    rest = args.slice(next);
  }
  const takesValue = (opt) => tarLongTakesValue(opt, name === 'bsdtar' ? 'bsd' : 'gnu'); // bsdtar: --cd is --directory
  let parsed = parseGetopt(rest, valueLetters, takesValue);
  if (name === 'bsdtar' && parsed.operands.length) { // bsdtar reads every word after its first member as a member, an option too (measured with bsdtar 3.7.4)
    const first = parsed.operandAt[0];
    parsed = parseGetopt(rest.slice(0, first), valueLetters, takesValue);
    for (let k = first; k < rest.length; k++) { parsed.operands.push(rest[k]); parsed.operandAt.push(k); }
  }
  if (parsed.shorts.includes('x') || parsed.longs.some((l) => longIs(l, '--extract', 5) || longIs(l, '--get', 4))) extract = true;
  if (parsed.shorts.includes('P') || parsed.longs.some((l) => longIs(l, '--absolute-names', 4) || longIs(l, '--absolute-paths', 4))) absolute = true; // the second name is the one of bsdtar
  if (parsed.shorts.includes('O') || parsed.longs.some((l) => longIs(l, '--to-stdout', 6))) toStdout = true; // -O and --to-stdout write the members to the standard output, not to files
  return { parsed, dirs, old, absolute, writes: extract && !toStdout };
}

// The command texts that tar and bsdtar run: GNU tar takes -I (the compress program) and -F (the volume script) as short options too, while the -I of bsdtar
// names a file. The compress program, the exec action of a checkpoint and the volume scripts run in every mode (measured); --to-command only when the members
// are extracted to files.
function tarCommandTexts(args, name) {
  const gnu = name !== 'bsdtar';
  const { parsed, old, writes } = tarMode(args, name);
  const texts = old.filter(([c]) => gnu && (c === 'I' || c === 'F')).map(([, value]) => value);
  for (const [key, value] of parsed.values) {
    if (longIs(key, '--use-compress-program', 4)) texts.push(value);
    else if (!gnu) continue;
    else if (longIs(key, '--checkpoint-action', 13)) { if (value.startsWith('exec=')) texts.push(value.slice(5)); } // the other actions run no command
    else if (key === 'I' || key === 'F' || longIs(key, '--info-script', 6) || longIs(key, '--new-volume-script', 7)) texts.push(value);
    else if (longIs(key, '--to-command', 6) && writes) texts.push(value);
  }
  return texts;
}

// tar and bsdtar: the directories of -C / --directory (each relative one resolves against the previous), when the command extracts.
function tarExtractDir(args, name) {
  const { parsed, dirs, absolute, writes } = tarMode(args, name);
  if (!writes) return null;
  // each -C applies from its place on: a member is joined with the directory that the last -C before it names (each relative one resolves against the
  // previous), one before every -C stays in the current directory, which is no path under /dev; the directories of the old style first word come first
  const steps = dirs.map((d) => [-1, d]);
  for (const [key, value, at] of parsed.values) if (key === 'C' || key === '--cd' || longIs(key, '--directory', 5)) steps.push([at, value]);
  // a named member that a literal --exclude pattern matches is not extracted: the whole name or a tail that starts after a slash (only the whole name
  // with --anchored); a wildcard pattern is not applied, and bsdtar reads an option after the members as one more member, so it excludes none there
  const anchored = parsed.longs.some((l) => longIs(l, '--anchored', 4));
  const excluded = new Set(name === 'bsdtar' ? [] : parsed.values.filter(([key, p]) => key === '--exclude' && p !== '' && !/[*?[\\]/.test(p)).map(([, p]) => p));
  const isExcluded = (m) => {
    if (excluded.has(m)) return true;
    if (!anchored) for (let k = m.indexOf('/'); k >= 0; k = m.indexOf('/', k + 1)) if (excluded.has(m.slice(k + 1))) return true;
    return false;
  };
  const strip = Math.max(0, ...parsed.values.filter(([key]) => longIs(key, '--strip-components', 5)).slice(-1).map(([, n]) => Number(n) || 0)); // the last one counts; a bad number strips nothing
  // the strip counts the components of the name without its leading slash; bsdtar counts that slash as the first one for a name with a leading slash
  const stripped = (m) => (strip === 0 ? m : m.split('/').filter(Boolean).slice(m.startsWith('/') && name === 'bsdtar' ? strip - 1 : strip).join('/'));
  // with the leading slash kept (and no strip option, which makes the name relative again) a member lands under its own name whatever -C says, and without a
  // named member every member of the archive does, which the guard cannot see
  const own = absolute && strip === 0;
  if (own && parsed.operands.length === 0) return '/dev';
  let ownHit = null;
  parsed.operands.forEach((m, k) => {
    if (isExcluded(m)) return;
    if (own && m.startsWith('/')) ownHit ??= devChanged(m);
    else steps.push([parsed.operandAt[k], null, stripped(m)]);
  });
  steps.sort((x, y) => x[0] - y[0]);
  let current = typeof devCwd === 'string' ? devCwd : null; // without -C the members go to the directory of the session
  let found = current !== null && !steps.some(([, dir]) => dir !== null) ? devChangedIn(current) : null;
  let inArchive = null;
  for (const [, dir, member] of steps) {
    if (dir !== null) {
      current = dir.startsWith('/') ? posix.normalize(dir) : current === null ? dir : posix.join(current, dir);
      found ??= devChangedIn(current);
    } else if (member && current?.startsWith('/')) inArchive ??= archiveMemberInDev([current], [member]); // a member with no component left is skipped
  }
  return found ?? ownHit ?? inArchive;
}

// Commands the guard judges by one argument pattern each (disk tools, archives, in-place awk, line editors): undefined when `name` is none of them, else a finding or null.
function devExtraCommand(name, args) {
  const hit = (path) => (path ? { what: name, path } : null);
  const firstChanged = (list, follow = true) => { for (const p of list) { const d = devChanged(p, follow, true); if (d) return d; } return null; };
  if (/^mkfs(?:\..+)?$/.test(name) || name === 'mke2fs') return hit(firstChanged(parseGetopt(args).operands));
  if (name === 'wipefs') { // only the erasing forms: -a, --all, -o, --offset
    const { shorts, longs, operands } = parseGetopt(args, 'otO', ['--offset', '--types', '--output']);
    const erases = shorts.some((c) => c === 'a' || c === 'o') || longs.some((l) => longIs(l, '--all', 3) || longIs(l, '--offset', 4));
    return erases ? hit(firstChanged(operands)) : null;
  }
  if (Object.hasOwn(DEV_DISK_LISTING, name)) {
    const { shorts, longs, operands } = parseGetopt(args, DEV_DISK_LISTING[name].value, [], DEV_DISK_LISTING[name].attached);
    const path = firstChanged(operands);
    if (!path || shorts.some((c) => DEV_DISK_LISTING[name].shorts.includes(c)) || longs.some((l) => DEV_DISK_LISTING[name].longs.includes(l))) return null;
    return { what: name, path };
  }
  if (name === 'parted') {
    const { shorts, longs, operands } = parseGetopt(args, 'a', ['--align']);
    const path = firstChanged(operands);
    if (!path || shorts.some((c) => 'lhvV'.includes(c)) || longs.some((l) => l === '--list' || l === '--help' || l === '--version')) return null;
    return partedReadsOnly(operands.slice(operands[0]?.startsWith('/') ? 1 : 0)) ? null : { what: name, path };
  }
  if (name === 'tar' || name === 'gtar' || name === 'bsdtar') return hit(tarExtractDir(args, name));
  if (name === 'unzip') {
    // the options come before the archive (the first word that is no option); after it every word is a pattern for a member, even one that looks like an option,
    // except -x with the patterns to leave out up to the next word with a dash, and -d with its directory
    const at = parseGetopt(args, 'dPOI').operandAt[0];
    if (at === undefined) return null;
    const { shorts, values } = parseGetopt(args.slice(0, at), 'dPOI');
    if (shorts.some((c) => 'lvtpczZ'.includes(c))) return null; // listing, testing, writing to stdout: no files are created
    const dirs = values.filter(([key]) => key === 'd').map(([, value]) => value);
    const members = [];
    let skipping = false;
    for (let j = at + 1; j < args.length; j++) {
      const a = args[j];
      if (a === '-x') skipping = true;
      else if (a === '-d' && j + 1 < args.length) { dirs.push(args[++j]); skipping = false; }
      else if (a.startsWith('-d') && a.length > 2) { dirs.push(a.slice(2)); skipping = false; }
      else if (skipping && !a.startsWith('-')) continue;
      else { skipping = false; members.push(a); }
    }
    if (!dirs.length && typeof devCwd === 'string') dirs.push(devCwd); // without -d the members go to the directory of the session
    for (const value of dirs) { const d = devChangedIn(value); if (d) return { what: name, path: d }; }
    return hit(archiveMemberInDev(dirs.map((d) => (d.startsWith('/') || typeof devCwd !== 'string' ? d : posix.join(devCwd, d))).filter((d) => d.startsWith('/')).map((d) => posix.normalize(d)), shorts.includes('j') ? [] : members)); // -j drops the directories of the members
  }
  if (name === 'awk' || name === 'gawk') { // -i inplace, --include=inplace: the gawk extension that rewrites the files
    const { operands, values } = parseGetopt(args, 'fvFeEilW', (n) => ['--file', '--assign', '--field-separator', '--source', '--exec', '--load'].includes(n) || longIs(n, '--include', 5));
    if (!values.some(([key, value]) => (key === 'i' || longIs(key, '--include', 5)) && /(?:^|\/)inplace(?:\.awk)?$/.test(value))) return null;
    const programGiven = values.some(([key]) => key === 'f' || key === 'e' || key === 'E' || key === '--file' || key === '--source' || key === '--exec');
    return hit(firstChanged((programGiven ? operands : operands.slice(1)).filter((o) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(o))));
  }
  if (name === 'ed' || name === 'red' || name === 'ex') return hit(firstChanged(parseGetopt(args, 'pcSt').operands));
  return undefined;
}

const shellOf = (text, depth) => { const t = tokenizeBash(text); return devScanTokens(t.tokens, t.heredocs, depth + 1) ?? devScanHeredocs(t.heredocs, depth + 1); };

// A finding { what, path } when the command `name args` changes a path under /dev; fed: scripts fed to it on stdin.
function devCommand(name, args, fed, depth) {
  const hit = (path) => (path ? { what: name, path } : null);
  const firstChanged = (list, follow = true) => { for (const p of list) { const d = devChanged(p, follow, true); if (d) return d; } return null; };
  if (Object.hasOwn(DEV_EVERY_OPERAND, name)) {
    const { opts, operands } = splitArgs(args, DEV_EVERY_OPERAND[name]);
    return hit(firstChanged(operands, !DEV_ACTS_ON_LINK.has(name) && !(DEV_NO_DEREF.has(name) && changesLinkItself(opts, name))));
  }
  if (name === 'tar' || name === 'gtar' || name === 'bsdtar') for (const text of tarCommandTexts(args, name)) { const inner = shellOf(text, depth); if (inner) return inner; }
  const extra = devExtraCommand(name, args);
  if (extra !== undefined) return extra;
  if (name === 'mv') {
    const { shorts, longs, operands, values } = parseGetopt(args, 'tS', (n) => isTargetDirOption(n) || longIs(n, '--suffix', 4));
    const dirs = values.filter(([key]) => isTargetDirOption(key)).map(([, value]) => value);
    const sources = dirs.length ? operands : operands.slice(0, -1);
    const targets = dirs.length ? dirs : operands.slice(-1);
    const entered = noTargetDir(shorts, longs) ? false : 'dir'; // with -T the target is replaced even when it is a link to a directory
    return hit(firstChanged(sources, false) ?? targets.map((t) => devChangedIn(t, entered, true)).find(Boolean)); // a source link is moved itself, a target link to a directory is entered
  }
  if (name === 'cp' || name === 'install' || name === 'ln' || name === 'link' || name === 'rsync') {
    // rsync has no target directory option (-t is --times there), so no option of it takes a value here.
    const valueLetters = name === 'rsync' ? '' : `tS${name === 'install' ? 'mog' : ''}`;
    const { shorts, longs, operands, values } = parseGetopt(args, valueLetters, (n) => name !== 'rsync' && (isTargetDirOption(n) || longIs(n, '--suffix', 4)));
    const dirs = values.filter(([key]) => isTargetDirOption(key)).map(([, value]) => value);
    const directories = name === 'install' && (shorts.includes('d') || longs.some((l) => longIs(l, '--directory', 5)));
    const targets = dirs.length ? dirs : directories ? operands : operands.length >= 2 ? [operands[operands.length - 1]] : [];
    // A plain cp onto /dev/null and the other pseudo devices only writes data into them, like a redirect. Options that attach attributes or replace the target (-a, -p, --preserve, -l, -s, -b, --remove-destination) stay refused.
    const plainCopy = name === 'cp' && !shorts.some((c) => 'aplsb'.includes(c)) && !longs.some((o) => /^--(?:archive|preserve|attributes-only|remove-destination|link|symbolic-link|backup)/.test(o));
    const replaces = noTargetDir(shorts, longs) || (name === 'ln' && (shorts.includes('n') || longs.some((o) => longIs(o, '--no-dereference', 6)))); // -T and ln -n: a link to a directory is replaced, not entered
    const follow = name === 'cp' && !longs.some((o) => longIs(o, '--remove-destination', 8)) ? true : replaces && name !== 'rsync' ? false : 'dir'; // cp writes through a link to a file, the others replace it
    for (const p of targets) { const d = devChangedIn(p, follow, !plainCopy); if (d && !(plainCopy && DEV_SINK.test(d))) return { what: name, path: d }; }
    return null;
  }
  if (name === 'dd') {
    for (const a of args) if (a.startsWith('of=')) { const d = devWritten(a.slice(3)); if (d) return { what: name, path: d }; }
    return null;
  }
  if (name === 'tee' || name === 'sponge') {
    for (const p of splitArgs(args).operands) { const d = devWritten(p); if (d) return { what: name, path: d }; }
    return null;
  }
  if (name === 'sed') return hit(firstChanged(sedInPlaceFiles(args), args.some((a) => longIs(a, '--follow-symlinks', 4)))); // without that option (or an abbreviation of it: --fo is the shortest) sed replaces a link by a file
  if (name === 'perl') return hit(firstChanged(perlInPlaceFiles(args), false));
  if (name === 'find') {
    const starts = [];
    let i = 0;
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === '-D' || a === '-O') { i++; continue; }
      if (a === '!' || a === '(' || (a.startsWith('-') && !/^-[HLP]$|^-O\d$/.test(a))) break;
      if (!a.startsWith('-')) starts.push(a);
    }
    const start = starts.map((d) => devChangedIn(d, args.some((a) => a === '-L' || a === '-H'))).find(Boolean) ?? null;
    for (let k = i; k < args.length; k++) {
      const a = args[k];
      if (a === '-delete' && start) return { what: 'find -delete', path: start };
      if (/^-f(?:print0?|printf|ls)$/.test(a) && args[k + 1] !== undefined) { const d = devWritten(args[k + 1]); if (d) return { what: `find ${a}`, path: d }; }
      if (/^-(?:exec|execdir|ok|okdir)$/.test(a)) {
        let end = k + 1;
        while (end < args.length && args[end] !== ';' && args[end] !== '+') end++;
        const inner = devUnwrap(args.slice(k + 1, end).map((x) => (start ? x.split('{}').join(start) : x)));
        const found = inner && devCommand(inner.name, inner.args, [], depth);
        if (found) return { what: `find -exec ${inner.name}`, path: found.path };
        k = end;
      }
    }
    return null;
  }
  const nests = name === 'eval' || name === 'ssh' || name === 'su' || name === 'runuser' || name === 'flock' || DEV_SHELLS.has(name);
  if (!nests) return null;
  if (depth >= DEV_MAX_DEPTH) return devMentions(tokenizeBash(args.join(' ')).tokens) ? { what: `${name} (nested too deep to inspect)`, path: '/dev' } : null; // beyond the depth limit a visible /dev path is refused, anything else passes
  if (name === 'eval') { const text = (args[0] === '--' ? args.slice(1) : args).join(' '); return text ? shellOf(text, depth) : null; } // -- ends the options of the builtin
  if (name === 'su' || name === 'runuser' || name === 'flock') {
    const { values } = splitArgs(args, ['-c', '--command']);
    return values['-c'] !== undefined || values['--command'] !== undefined ? shellOf(values['-c'] ?? values['--command'], depth) : null;
  }
  if (name === 'ssh') { // the remote command runs on another machine, which has its own /dev and no guard of ours
    const withValue = ['-p', '-i', '-l', '-o', '-F', '-J', '-L', '-R', '-D', '-b', '-c', '-e', '-m', '-O', '-Q', '-S', '-W', '-w', '-B', '-E', '-I'];
    let i = 0;
    const skipOptions = () => { while (i < args.length && args[i].startsWith('-')) i += withValue.includes(args[i]) ? 2 : 1; };
    skipOptions();
    i++; // the host
    skipOptions();
    if (i < args.length) return shellOf(args.slice(i).join(' '), depth);
  }
  for (const text of fed) { const found = shellOf(text, depth); if (found && DEV_SHELLS.has(name)) return found; if (found && name === 'ssh') return found; }
  if (DEV_SHELLS.has(name)) {
    const { opts, operands } = splitArgs(args, ['-o', '-O', '--rcfile', '--init-file']);
    if (opts.some((o) => /^-[A-Za-z]*c[A-Za-z]*$/.test(o))) return operands.length ? shellOf(operands[0], depth) : null;
  }
  return null;
}

// The here-document of the redirection that starts at `start`: an index per list of here-documents, built once (a search per redirection is quadratic).
const heredocIndexes = new WeakMap();
function heredocAt(heredocs, start) {
  let index = heredocIndexes.get(heredocs);
  if (!index) {
    index = new Map();
    for (const h of heredocs) if (!index.has(h.redirStart)) index.set(h.redirStart, h);
    heredocIndexes.set(heredocs, index);
  }
  return index.get(start);
}

// Findings in a command list. The heredocs of the whole text are looked up by the offset of their redirection.
function devScanTokens(tokens, heredocs, depth) {
  if (depth > DEV_MAX_DEPTH) return devMentions(tokens) ? { what: 'a nested command', path: '/dev' } : null;
  const ticks = backtickTexts.get(tokens);
  if (ticks !== undefined) { // read again as a text of its own, so that its here-documents are found at the right offsets; a cd in it runs in a subshell
    const outer = devCwd;
    const found = shellOf(ticks, depth - 1);
    devCwd = outer;
    return found;
  }
  let words = [];
  let fed = [];
  let pipeDev = null; // a /dev path among the words of the command before the last pipe
  let wordDev = null; // a /dev path among the words of the current command
  let isFind = false; // the current command has find among its words
  let timeWords = new Set(); // indexes of the words that are a plain unquoted time
  let afterPipe = false; // the current command follows a pipe, where time is no keyword
  let redirected = false; // the current command has a redirection before the word: time is no keyword after it
  let afterOr = false; // the current command follows ||: it runs only when the one before failed
  let afterAnd = false; // the current command follows &&: it runs only when the one before succeeded
  let afterCase = false; // the current command follows the pattern of a branch of a case
  let chainBase = NO_DIR; // the directory before the first cd of a chain of && (NO_DIR: none yet)
  let afterPipeOp = false; // the current command follows a pipe operator (unlike afterPipe, a group or a condition does not clear it)
  const dirStack = []; // the directory in force at each open parenthesis: a subshell leaves it behind
  const groupDirs = []; // the same at each open group or compound command ({, if, while, until, for, case): one that is piped or put in the background runs in a subshell
  const flush = (op) => {
    for (const w of words) { if (DEV_GROUP_OPEN.has(w)) groupDirs.push(devCwd); else if (!DEV_LEADING.has(w)) break; }
    if (DEV_GROUP_CLOSE.has(words[0]) && groupDirs.length) { const outer = groupDirs.pop(); if (op === '|' || op === '|&' || op === '&') devCwd = outer; }
    const unwrapped = words.length ? devUnwrap(words, timeWords) : null;
    let found = null;
    if (unwrapped) {
      const inForce = devCwd;
      if (unwrapped.dir !== undefined) devCwd = unwrapped.dir; // env -C: the directory of the wrapped command only
      found = devCommand(unwrapped.name, unwrapped.args, fed, depth);
      // the path from the pipe lands at the end of the arguments, or in the place of the replace string of xargs -I
      const piped = unwrapped.replace ? unwrapped.args.map((a) => a.split(unwrapped.replace).join('/dev/\u0000')) : [...unwrapped.args, '/dev/\u0000'];
      if (!found && unwrapped.xargs && pipeDev && devCommand(unwrapped.name, piped, [], depth)) found = { what: `xargs ${unwrapped.name}`, path: pipeDev };
      devCwd = inForce;
    }
    // A cd in a pipeline or in the background runs in a subshell, so the directory stays (the last command of a pipeline too: lastpipe is off in a script).
    // One that may not run (after ||, after && when the chain ends, in the body of then, else, elif or do, in a branch of a case) leaves the directory unknown.
    if (unwrapped && (unwrapped.name === 'cd' || unwrapped.name === 'pushd' || unwrapped.name === 'popd') && !afterPipeOp && op !== '|' && op !== '|&' && op !== '&') {
      const before = devCwd;
      if (afterAnd && chainBase === NO_DIR) chainBase = devCwd;
      devChangeDir(unwrapped.name, unwrapped.args);
      if ((afterOr || afterCase || ['then', 'else', 'elif', 'do'].includes(words[0])) && devCwd !== before) devCwd = null; // it may not run: unknown unless it keeps the directory
    }
    if (op !== '&&' && chainBase !== NO_DIR) { if (devCwd !== chainBase) devCwd = null; chainBase = NO_DIR; } // the chain of && ended: the directory is the one before it, or unknown
    pipeDev = (op === '|' || op === '|&') && unwrapped && DEV_FEEDERS.has(unwrapped.name) ? wordDev : null;
    words = [];
    fed = [];
    wordDev = null;
    isFind = false;
    timeWords = new Set();
    redirected = false;
    afterPipe = op === '|' || op === '|&';
    afterOr = op === '||';
    afterAnd = op === '&&';
    afterCase = false;
    afterPipeOp = op === '|' || op === '|&';
    return found;
  };
  const subs = (word) => { // a cd inside $( ) and <( ) runs in a subshell and leaves the directory of the command as it was
    const outer = devCwd;
    for (const list of devSubLists(word.parts)) { const found = devScanTokens(list, heredocs, depth + 1); devCwd = outer; if (found) return found; }
    return null;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'op') {
      const found = flush(t.value);
      if (found) return found;
      if (t.value === '(') dirStack.push(devCwd);
      else if (t.value === ')') { if (dirStack.length) devCwd = dirStack.pop(); else afterCase = true; } // an unmatched parenthesis ends the pattern of a branch of a case
      continue;
    }
    if (t.type === 'word') {
      const found = subs(t);
      if (found) return found;
      const text = devWordText(t);
      if (!afterPipe && !redirected && text === 'time' && t.parts.length === 1 && t.parts[0].kind === 'lit' && t.parts[0].text === 'time') timeWords.add(words.length);
      words.push(text);
      if (t.parts.length === 1 && t.parts[0].kind === 'lit' && DEV_OPENERS.has(text)) afterPipe = false; // a group or a condition after a pipe starts a list of its own, where time is the keyword again
      if (baseName(text) === 'find') isFind = true;
      if (!(isFind && FIND_REFERENCE.test(words[words.length - 2] ?? ''))) wordDev ??= words.length > 1 && DEV_FEEDERS.has(baseName(words[0])) ? devChangedIn(text) : devLexicalIn(text); // the file after find -newer is only compared with; the arguments of a feeder are read from the directory in force
      continue;
    }
    if (t.type !== 'redir') continue;
    redirected = true;
    if (t.value === '<<' || t.value === '<<-') {
      const doc = heredocAt(heredocs, t.start);
      if (doc) fed.push(doc.body);
      continue;
    }
    const target = tokens[i + 1]?.type === 'word' ? tokens[++i] : null;
    if (!target) continue;
    const found = subs(target);
    if (found) return found;
    const text = devWordText(target);
    if (t.value === '<<<') { fed.push(text); continue; }
    const writes = ['>', '>>', '>|', '&>', '&>>', '<>'].includes(t.value) || (t.value === '>&' && !/^(?:\d+|-)$/.test(text));
    const path = writes ? devWritten(text) : null;
    if (path) return { what: `redirect \`${t.value}\``, path };
  }
  return flush(null);
}

// Command lists nested in the parts of a word: $( ), ` `, <( ) and >( ), also inside "..." and ${...}.
const backtickTexts = new WeakMap(); // token list of a `...` part -> its text after unescaping: the offsets of those tokens are relative to that text, not to the whole command
function devSubLists(parts, out = []) {
  for (const p of parts) {
    if (p.kind === 'backtick') backtickTexts.set(p.tokens, p.text.replace(/\\([`\\$])/g, '$1'));
    if (p.tokens) out.push(p.tokens);
    else if (p.parts) devSubLists(p.parts, out);
  }
  return out;
}

// $( ) in the body of an unquoted here-document runs, whatever command the document is fed to.
function devScanHeredocs(heredocs, depth) {
  for (const h of heredocs) {
    if (!h.parts) continue;
    for (const list of devSubLists(h.parts)) { const found = devScanTokens(list, heredocs, depth + 1); if (found) return found; }
  }
  return null;
}

// A finding { what, path } for the command text, or null.
export function findDevPathChange(tokenized) {
  return devScanTokens(tokenized.tokens, tokenized.heredocs, 0) ?? devScanHeredocs(tokenized.heredocs, 0);
}

// repair: the probe state when the command is the repair recipe (then the refusal says why the exception does not apply).
function devReason(what, path, repair = '') {
  const why = repair === 'healthy' ? 'The repair recipe for /dev/null is refused because /dev/null is a healthy character device 1:3 now. ' : repair === 'error' ? 'The repair recipe for /dev/null is refused because /dev/null could not be checked. ' : '';
  return `Blocked: ${what.startsWith('redirect') ? what : `\`${what}\``} would change ${path}. ${why}Paths under /dev are device nodes (a deleted or replaced /dev/null breaks the whole machine), so commands that delete, move, overwrite, truncate, re-own, format, partition, extract into or recreate them are refused. Redirects to /dev/null, /dev/stdout, /dev/stderr, /dev/tty and /dev/fd/N and reads from /dev stay allowed. If /dev is damaged, do not repair it from this session: tell the owner, who fixes it outside this session. The one exception: only while /dev/null is not the character device 1:3, the exact command \`${DEV_NULL_REPAIR}\` as the whole command is allowed.`;
}

// The state of one scan: the working directory of the session (an absolute path, else none) and the budget of the paths that the file system resolves.
function startDevScan(cwd) {
  devCwd = typeof cwd === 'string' && cwd.startsWith('/') && !cwd.includes('\u0000') ? posix.normalize(cwd).replace(/\/+$/, '') || '/' : undefined;
  devRealLeft = 256;
}

// The Write, Edit, MultiEdit and NotebookEdit tools: the same effect as sed -i on the path.
export function checkDevFileTool(toolName, data) {
  try {
    startDevScan(data?.cwd);
    const input = data?.tool_input || data?.toolInput || {};
    const path = [input.file_path, input.notebook_path].filter((v) => typeof v === 'string').map((v) => devChanged(v)).find(Boolean);
    return path ? { decision: 'deny', reason: `[SHELL CHECK] ${devReason(`${toolName} tool`, path)}`, context: '', checks: [DEV_GUARD_CLASS] } : { decision: 'allow', reason: '', context: '', checks: [] };
  } catch {
    return { decision: 'allow', reason: '', context: '', checks: ['dev-path-error'] }; // visible in checks.jsonl: the guard itself failed
  }
}

// text without the spaces, tabs and newlines at both ends (a loop: a regular expression over a long run of blanks is quadratic).
function trimBlanks(text) {
  const blank = (c) => c === ' ' || c === '\t' || c === '\n';
  let start = 0;
  let end = text.length;
  while (start < end && blank(text[start])) start++;
  while (end > start && blank(text[end - 1])) end--;
  return text.slice(start, end);
}

// The guard for one Bash command (text; tokenized = tokenizeBash of the text the shell will see): { checks, denial }, denial being the message or ''.
// The repair recipe for /dev/null passes only as the whole command and only while /dev/null is not the character device 1:3.
export function checkBashDevPath(text, tokenized, { platform = process.platform, devNullProbe, cwd } = {}) {
  const checks = [];
  startDevScan(cwd);
  let devHit = null;
  const repair = trimBlanks(text) === DEV_NULL_REPAIR ? devNullState({ platform, devNullProbe }) : '';
  if (repair === 'broken') checks.push('dev-path-repair'); // visible in checks.jsonl: the exception was used
  else {
    try { devHit = findDevPathChange(tokenized); } catch { checks.push('dev-path-error'); } // a failure of the guard is visible in checks.jsonl and lets the other checks run
  }
  if (!devHit) return { checks, denial: '' };
  checks.push(DEV_GUARD_CLASS);
  return { checks, denial: devReason(devHit.what, devHit.path, repair) };
}
