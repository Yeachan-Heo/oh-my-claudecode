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
// wrappers sudo, doas, env, command, builtin, exec, nice, ionice, nohup, timeout, stdbuf, setsid, time, coproc and xargs.
// Also refused with a path under /dev: mkfs*, mke2fs, wipefs (erasing forms), fdisk, sfdisk, gdisk and parted (not their listing forms),
// tar and bsdtar extracting with -C or --directory, unzip -d, awk and gawk with -i inplace, ed, ex and red.
// One exception: the atomic repair recipe for /dev/null passes when it is the whole command and /dev/null is not the character device 1:3.
// Not resolved (known limits): variables and command substitutions inside the path, relative paths after cd /dev, scripts read from a
// file, interpreters (python -c ...), unknown wrappers, symbolic links to /dev, a script piped into a shell, wildcards, braces, ANSI-C
// escapes and tildes in the path, a here-document for sudo -i, sudo -s and su, coproc NAME { ...; }, flock FILE COMMAND, runuser -u USER --
// COMMAND, a filter between a feeder and xargs, commands that are not listed (mkswap, blkdiscard, losetup, cryptsetup, mdadm, ...).

import { lstatSync } from 'node:fs';
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

// The normalized path when value is an absolute path at or under /dev, else null.
function devPathOf(value) {
  const raw = String(value ?? '');
  if (!raw.startsWith('/')) return null;
  const glued = /^\/dev(?=[\u0000*?[])/.test(raw) ? `/dev/${raw.slice(4)}` : raw; // /dev* and /dev$X may name /dev or anything under it
  const path = posix.normalize(glued).replace(/\/+$/, '');
  return path === '/dev' || path.startsWith('/dev/') ? path : null;
}
const devChanged = (value) => { const p = devPathOf(value); return p && !DEV_SCRATCH.test(p) ? p : null; }; // a path the commands of the guard must not change
const devChangedIn = (value) => { const p = devPathOf(value); return p && !DEV_SCRATCH.test(p) && p !== '/dev/shm' ? p : null; }; // like devChanged, but the scratch directory itself is a fine place to put files into
const devWritten = (value) => { const p = devPathOf(value); return p && !DEV_SINK.test(p) && !DEV_SCRATCH.test(p) ? p : null; }; // a path a redirect, tee or dd may not write

// Text of a word after quote removal; every expansion becomes a NUL, so "$HOME/dev/x" is not read as /dev/x and "/dev/$x" stays under /dev.
function devPartText(part) {
  if (part.kind === 'lit') return part.text.replace(/\\(?:\n|(.))/gs, '$1'); // a backslash and a newline are removed
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
const DEV_EVERY_OPERAND = {
  rm: [], unlink: [], rmdir: [], chattr: [], chmod: ['--reference'], chown: ['--reference', '--from'], chgrp: ['--reference'],
  setfacl: ['-m', '-x', '-M', '-X'], setfattr: ['-n', '-v', '-x'], shred: ['-n', '-s', '--iterations', '--size'],
  truncate: ['-s', '-r', '--size', '--reference'], touch: ['-d', '-t', '-r', '--date', '--time', '--reference'], mknod: ['-m', '--mode'], mkfifo: ['-m', '--mode'],
};

// Wrappers: options with a value (a long option with its value in the next argument too), and how many operands to skip before the wrapped
// command (timeout: the duration). env -S TEXT and env --split-string=TEXT are handled in devUnwrap.
const DEV_WRAPPERS = {
  sudo: { val: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t', '--user', '--group', '--host', '--prompt', '--close-from', '--chdir', '--chroot', '--role', '--type', '--other-user', '--command-timeout'], assign: true },
  doas: { val: ['-u', '-C'] }, env: { val: ['-u', '-C', '-S', '-a', '--unset', '--chdir', '--argv0', '--block-signal', '--default-signal', '--ignore-signal'], assign: true }, command: { val: [] }, builtin: { val: [] },
  exec: { val: ['-a'] }, nice: { val: ['-n', '--adjustment'] }, ionice: { val: ['-c', '-n', '-p', '-P', '-u', '--class', '--classdata', '--pid', '--pgid', '--uid'] }, nohup: { val: [] },
  timeout: { val: ['-s', '--signal', '-k', '--kill-after'], skip: 1 }, stdbuf: { val: ['-i', '-o', '-e', '--input', '--output', '--error'] }, setsid: { val: [] }, time: { val: ['-f', '-o', '--format', '--output'] }, coproc: { val: [] },
  xargs: { val: ['-n', '-I', '-L', '-P', '-d', '-E', '-s', '-a', '-l', '--max-args', '--max-procs', '--max-lines', '--delimiter', '--eof', '--max-chars', '--arg-file', '--process-slot-var'] },
};
const DEV_LEADING = new Set(['then', 'do', 'else', 'elif', '{', '!', 'if', 'while', 'until']);
const baseName = (value) => String(value).replace(/\/+$/, '').split('/').pop();
const isAssignment = (value) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);

// The text of env -S as the shell parser should read it: env turns an unquoted backslash and underscore into a separator of arguments.
function envSplitText(text) {
  let quote = '';
  let out = '';
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (c === '\\' && quote !== "'" && k + 1 < text.length) { out += quote === '' && text[k + 1] === '_' ? ' ' : c + text[k + 1]; k++; continue; }
    if (quote === c) quote = '';
    else if (quote === '' && (c === "'" || c === '"')) quote = c;
    out += c;
  }
  return out;
}

// [name, ...args] without leading keywords, assignments and wrappers: { name, args, xargs, replace }, or null when nothing is left.
// xargs: the command is fed by a pipe; replace: the replace string of xargs -I, -i or --replace. env -S TEXT is a command line of its own: it
// comes back as eval with TEXT followed by the remaining arguments.
function devUnwrap(values) {
  let at = 0;
  let xargs = false;
  let replace;
  for (;;) {
    while (at < values.length && (isAssignment(values[at]) || DEV_LEADING.has(values[at]) || values[at] === 'function')) at += values[at] === 'function' ? 2 : 1; // function NAME { ...
    if (at >= values.length) return null;
    const name = baseName(values[at]);
    const spec = Object.hasOwn(DEV_WRAPPERS, name) ? DEV_WRAPPERS[name] : null;
    if (!spec) return { name, args: values.slice(at + 1), xargs, replace };
    let i = at + 1;
    let split;
    for (; i < values.length; i++) {
      const a = values[i];
      if (a === '--') { i++; break; }
      if (spec.assign && isAssignment(a)) continue;
      if (!a.startsWith('-') || a === '-') break;
      if (name === 'env' && (a.startsWith('-S') || longIs(a.split('=')[0], '--split-string', 3))) { // the text to split follows, attached or as the next argument
        const eq = a.indexOf('=');
        split = a.startsWith('--') ? (eq > 0 ? a.slice(eq + 1) : values[++i]) : (a.length > 2 ? a.slice(2) : values[++i]);
        continue;
      }
      if (name === 'xargs') {
        if (a === '-I') replace = values[i + 1];
        const m = /^(?:-I(.+)|-i(.*)|--replace(?:=(.*))?)$/.exec(a);
        if (m) replace = m[1] ?? (m[2] || m[3] || '{}');
      }
      if (spec.val.includes(a)) i++;
      else if (!a.startsWith('--')) { // a cluster of short options: the first letter with a value takes the rest of the word, or the next word when it ends the cluster
        let k = 1;
        while (k < a.length && !spec.val.includes(`-${a[k]}`)) k++;
        if (k === a.length - 1) i++;
      }
    }
    if (split !== undefined) return { name: 'eval', args: [envSplitText(split), ...values.slice(i)], xargs, replace };
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
      if (name.length >= 4 && '--in-place'.startsWith(name)) inPlace = true;
      else if (name === '--expression' || name === '--file') { scripted = true; if (!a.includes('=')) i++; }
      else if (name === '--line-length' && !a.includes('=')) i++;
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
// (shortValue: letters; longValue: names or a predicate; shortAttached: letters with an optional argument, which is only ever attached, so
// the rest of the cluster after them is their value and not further options). Under- or over-consuming a value only matters when it hides or
// shows a /dev path.
function parseGetopt(args, shortValue = '', longValue = [], shortAttached = '') {
  const shorts = [];
  const longs = [];
  const operands = [];
  const values = [];
  const takesLong = typeof longValue === 'function' ? longValue : (name) => longValue.includes(name);
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (literal || a === '-' || !a.startsWith('-')) { operands.push(a); continue; }
    if (a === '--') { literal = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      longs.push(name);
      if (eq > 0) values.push([name, a.slice(eq + 1)]);
      else if (takesLong(name) && i + 1 < args.length) values.push([name, args[++i]]);
      continue;
    }
    for (let k = 1; k < a.length; k++) {
      shorts.push(a[k]);
      if (shortAttached.includes(a[k])) { if (k + 1 < a.length) values.push([a[k], a.slice(k + 1)]); break; }
      if (!shortValue.includes(a[k])) continue;
      if (k + 1 < a.length) values.push([a[k], a.slice(k + 1)]);
      else if (i + 1 < args.length) values.push([a[k], args[++i]]);
      break;
    }
  }
  return { shorts, longs, operands, values };
}
// A long option written in full or abbreviated (GNU getopt takes any unambiguous prefix; min is the shortest unambiguous one).
const longIs = (name, full, min) => name.length >= min && full.startsWith(name);
// -t DIR and --target-directory=DIR (also abbreviated: --target DIR) of mv, cp, install and ln; -t may end a cluster of short options (-sft DIR).
const isTargetDirOption = (key) => key === 't' || longIs(key, '--target-directory', 3);

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

// tar and bsdtar: the directories of -C / --directory (each relative one resolves against the previous), when the command extracts.
function tarExtractDir(args) {
  const valueLetters = 'bCfFgHIKLNTVX';
  let extract = false;
  const dirs = [];
  let rest = args;
  if (args[0] && !args[0].startsWith('-')) { // old style: tar xCf dir archive
    let next = 1;
    for (const c of args[0]) {
      if (c === 'x') extract = true;
      if (c === 'C' && args[next] !== undefined) dirs.push(args[next]);
      if (valueLetters.includes(c)) next++;
    }
    rest = args.slice(next);
  }
  const parsed = parseGetopt(rest, valueLetters, (name) => longIs(name, '--directory', 5) || name === '--cd'); // bsdtar: --cd is --directory
  if (parsed.shorts.includes('x') || parsed.longs.some((l) => longIs(l, '--extract', 5) || longIs(l, '--get', 4))) extract = true;
  if (!extract) return null;
  for (const [key, value] of parsed.values) if (key === 'C' || key === '--cd' || longIs(key, '--directory', 5)) dirs.push(value);
  let current = null;
  let found = null;
  for (const d of dirs) {
    current = d.startsWith('/') ? posix.normalize(d) : current === null ? d : posix.join(current, d);
    found ??= devChangedIn(current);
  }
  return found;
}

// Commands the guard judges by one argument pattern each (disk tools, archives, in-place awk, line editors): undefined when `name` is none of them, else a finding or null.
function devExtraCommand(name, args) {
  const hit = (path) => (path ? { what: name, path } : null);
  const firstChanged = (list) => { for (const p of list) { const d = devChanged(p); if (d) return d; } return null; };
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
  if (name === 'tar' || name === 'gtar' || name === 'bsdtar') return hit(tarExtractDir(args));
  if (name === 'unzip') {
    const { shorts, values } = parseGetopt(args, 'dPOI');
    if (shorts.some((c) => 'lvtpczZ'.includes(c))) return null; // listing, testing, writing to stdout: no files are created
    for (const [key, value] of values) if (key === 'd') { const d = devChangedIn(value); if (d) return { what: name, path: d }; }
    return null;
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
  const firstChanged = (list) => { for (const p of list) { const d = devChanged(p); if (d) return d; } return null; };
  if (Object.hasOwn(DEV_EVERY_OPERAND, name)) return hit(firstChanged(splitArgs(args, DEV_EVERY_OPERAND[name]).operands));
  const extra = devExtraCommand(name, args);
  if (extra !== undefined) return extra;
  if (name === 'mv') {
    const { operands, values } = parseGetopt(args, 'tS', (n) => isTargetDirOption(n) || longIs(n, '--suffix', 4));
    const dirs = values.filter(([key]) => isTargetDirOption(key)).map(([, value]) => value);
    const sources = dirs.length ? operands : operands.slice(0, -1);
    const targets = dirs.length ? dirs : operands.slice(-1);
    return hit(firstChanged(sources) ?? targets.map(devChangedIn).find(Boolean));
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
    for (const p of targets) { const d = devChangedIn(p); if (d && !(plainCopy && DEV_SINK.test(d))) return { what: name, path: d }; }
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
  if (name === 'sed') return hit(firstChanged(sedInPlaceFiles(args)));
  if (name === 'perl') return hit(firstChanged(perlInPlaceFiles(args)));
  if (name === 'find') {
    const starts = [];
    let i = 0;
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === '-D' || a === '-O') { i++; continue; }
      if (a === '!' || a === '(' || (a.startsWith('-') && !/^-[HLP]$|^-O\d$/.test(a))) break;
      if (!a.startsWith('-')) starts.push(a);
    }
    const start = starts.map(devChangedIn).find(Boolean) ?? null;
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
  if (name === 'eval') return args.length ? shellOf(args.join(' '), depth) : null;
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
  if (ticks !== undefined) return shellOf(ticks, depth - 1); // read again as a text of its own, so that its here-documents are found at the right offsets
  let words = [];
  let fed = [];
  let pipeDev = null; // a /dev path among the words of the command before the last pipe
  let wordDev = null; // a /dev path among the words of the current command
  let isFind = false; // the current command has find among its words
  const flush = (op) => {
    const unwrapped = words.length ? devUnwrap(words) : null;
    let found = null;
    if (unwrapped) {
      found = devCommand(unwrapped.name, unwrapped.args, fed, depth);
      // the path from the pipe lands at the end of the arguments, or in the place of the replace string of xargs -I
      const piped = unwrapped.replace ? unwrapped.args.map((a) => a.split(unwrapped.replace).join('/dev/\u0000')) : [...unwrapped.args, '/dev/\u0000'];
      if (!found && unwrapped.xargs && pipeDev && devCommand(unwrapped.name, piped, [], depth)) found = { what: `xargs ${unwrapped.name}`, path: pipeDev };
    }
    pipeDev = (op === '|' || op === '|&') && unwrapped && DEV_FEEDERS.has(unwrapped.name) ? wordDev : null;
    words = [];
    fed = [];
    wordDev = null;
    isFind = false;
    return found;
  };
  const subs = (word) => { for (const list of devSubLists(word.parts)) { const found = devScanTokens(list, heredocs, depth + 1); if (found) return found; } return null; };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'op') { const found = flush(t.value); if (found) return found; continue; }
    if (t.type === 'word') {
      const found = subs(t);
      if (found) return found;
      const text = devWordText(t);
      words.push(text);
      if (baseName(text) === 'find') isFind = true;
      if (!(isFind && FIND_REFERENCE.test(words[words.length - 2] ?? ''))) wordDev ??= devChangedIn(text); // the file after find -newer is only compared with
      continue;
    }
    if (t.type !== 'redir') continue;
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

// The Write, Edit, MultiEdit and NotebookEdit tools: the same effect as sed -i on the path.
export function checkDevFileTool(toolName, data) {
  try {
    const input = data?.tool_input || data?.toolInput || {};
    const path = [input.file_path, input.notebook_path].filter((v) => typeof v === 'string').map(devChanged).find(Boolean);
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
export function checkBashDevPath(text, tokenized, { platform = process.platform, devNullProbe } = {}) {
  const checks = [];
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
