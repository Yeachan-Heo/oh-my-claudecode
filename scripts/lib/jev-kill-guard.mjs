/**
 * Kill guard for Bash commands (opt-in: OMC_JEV_KILL_GUARD=1, off by default).
 *
 * judgeKill() decides whether a shell command may send signals or stop services and containers. It refuses:
 * - signals to pid 1, to the ancestors of the hook process (up to pid 1) and to their process groups;
 * - pkill/killall patterns that match a protected name, a generic process name, or the command line or
 *   name of an ancestor of the hook process;
 * - systemctl, service and /etc/init.d stop-like actions on protected units, and actions that stop the whole system;
 * - docker and docker compose stop-like actions on protected containers and projects;
 * - commands whose targets cannot be determined statically (globs, unknown substitutions, xargs input).
 *
 * Configuration (comma separated lists, empty by default):
 * - OMC_JEV_KILL_GUARD_SERVICES and OMC_JEV_KILL_GUARD_CONTAINERS: protected names, merged into one list;
 * - OMC_JEV_KILL_GUARD_ALLOW: names removed from the name-based rules (the protected list and the generic
 *   process names). It never lifts the pid, ancestor, process group, system unit or whole-system rules;
 * - OMC_JEV_KILL_GUARD_TEST_DIRS: path prefixes of test projects that docker compose may stop (default: empty).
 *
 * A judge error never refuses: the hook logs it and lets the command pass. Signal 0 (kill -0) is never refused.
 */
import { readFileSync } from 'node:fs';

const REFUSAL_PREFIX = '[KILL-GUARD] refused: ';
const OWNER_NOTE = 'Stopping protected processes and production services requires an explicit operator instruction.';
const refusal = (what) => `${REFUSAL_PREFIX}${what}. ${OWNER_NOTE}`;

// Generic process names that pkill and killall never match (a pattern that matches one of them is refused).
const GENERIC_PROTECTED_NAMES = ['init', 'systemd', 'node', 'python', 'python3', 'claude', 'tmux'];
// System units whose stop ends every session (also matched by base name, without the .service suffix).
const SYSTEM_UNITS = ['systemd-logind', 'networking', 'systemd-networkd'];
const MAX_DEPTH = 8; // nesting of $(), backticks and shells that the parser follows; deeper input is refused as unreadable
const DEFAULT_TEST_DIRS = [];

const isEnabled = (env = process.env) => String(env?.OMC_JEV_KILL_GUARD ?? '').trim() === '1';

function listFromEnv(env, name) {
  const raw = env?.[name];
  if (typeof raw !== 'string') return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Protected names from OMC_JEV_KILL_GUARD_SERVICES and OMC_JEV_KILL_GUARD_CONTAINERS, one list without duplicates. */
export function protectedNames(env = process.env) {
  const names = [];
  for (const name of [...listFromEnv(env, 'OMC_JEV_KILL_GUARD_SERVICES'), ...listFromEnv(env, 'OMC_JEV_KILL_GUARD_CONTAINERS')]) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function testDirsOf(env) {
  const raw = env?.OMC_JEV_KILL_GUARD_TEST_DIRS;
  return typeof raw === 'string' ? listFromEnv(env, 'OMC_JEV_KILL_GUARD_TEST_DIRS') : DEFAULT_TEST_DIRS;
}

// /proc/<pid>/stat: comm (before the last ")"), ppid and pgrp (the comm may contain spaces).
function readProcStat(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const i = raw.lastIndexOf(')');
    if (i < 0) return null;
    const fields = raw.slice(i + 1).trim().split(/\s+/); // state, ppid, pgrp
    const ppid = Number(fields[1]);
    const pgrp = Number(fields[2]);
    const comm = raw.slice(0, i).replace(/^\d+\s*\(/, '').replace(/\)$/, '');
    return Number.isFinite(ppid) && Number.isFinite(pgrp) ? { ppid, pgrp, comm } : null;
  } catch {
    return null; // no /proc, or the process has gone
  }
}

// Command line of a process as a list of arguments; null without /proc or when the process has gone.
function readProcessCmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').map((s) => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Ancestors of the hook process up to pid 1: { pids, pgids, hasProc, comms, cmdline }. hasProc is false on a system
 * without /proc (then only pid 1 and the name lists are protected). The chain is partial when a process has gone.
 * The comm and the command line of pid 1 and of the ancestors take part in pkill and killall pattern matching.
 */
export function protectedAncestors() {
  const pids = new Set();
  const pgids = new Set();
  const comms = new Set();
  const cmdline = [];
  let hasProc = false;
  let pid = process.ppid;
  for (let steps = 0; pid > 0 && steps < 128; steps++) {
    const st = readProcStat(pid);
    if (!st) break;
    hasProc = true;
    if (pid === 1) {
      pids.add(1);
      if (st.comm) comms.add(st.comm);
      break;
    }
    pids.add(pid);
    pgids.add(st.pgrp);
    if (st.comm) comms.add(st.comm);
    const lines = readProcessCmdline(pid);
    if (lines) cmdline.push(lines.join(' '));
    pid = st.ppid;
  }
  return { pids, pgids, hasProc, comms: [...comms], cmdline };
}

// --- Bash command split into segments (contents of $() and backticks as separate segments, quotes removed) ---
// Separators: `;`, `&&`, `||`, `|`, `&`, newline, `(` and `)`. `{` and `}` are not separators (${VAR}).
// A `#` at the start of a word starts a comment up to the end of the line. The contents of $() and backticks are
// segments of their own (echo $(kill 1) runs kill 1); the outer segment keeps them as inline $(...) with \x01 in place
// of blanks, so the target classification sees the substitution. Heredoc bodies are skipped up to the terminator line.
function commandSegments(textIn, depth = 0) {
  const text = String(textIn).replace(/\x01/g, ' ');
  if (depth > MAX_DEPTH) return ['\x02unreadable'];
  const out = [];
  let i = 0;
  let segment = '';
  const flush = () => {
    const s = segment.trim();
    if (s) out.push(s);
    segment = '';
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      const next = text[i + 1];
      segment += next === '\n' ? ' ' : next;
      i += 2;
      continue;
    }
    if (c === '<' && text[i + 1] === '<') {
      const m = /^<<(-?)[ \t]*(?:"([^"]*)"|'([^']*)'|\\([^\s]+)|([^\s"']+[^\s]*))/.exec(text.slice(i));
      if (m) {
        const delimiter = m[2] ?? m[3] ?? m[4] ?? m[5];
        const newline = text.indexOf('\n', i);
        segment += text.slice(i, i + m[0].length);
        i += m[0].length;
        if (newline >= 0) {
          const terminator = new RegExp(`^[ \\t]*${delimiter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm');
          let from = newline + 1;
          while (from <= text.length) {
            const eol = text.indexOf('\n', from);
            const line = eol < 0 ? text.slice(from) : text.slice(from, eol);
            if (terminator.test(line)) {
              flush();
              i = eol < 0 ? text.length : eol + 1;
              break;
            }
            from = eol < 0 ? text.length + 1 : eol + 1;
          }
        }
        continue;
      }
    }
    if (c === "'") {
      const j = text.indexOf("'", i + 1);
      if (j < 0) {
        segment += text.slice(i + 1).replace(/[\t\n ]/g, '\x01');
        flush();
        return out;
      }
      segment += text.slice(i + 1, j).replace(/[\t\n ]/g, '\x01');
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === '`') {
          const k = text.indexOf('`', j + 1);
          if (k < 0) {
            flush();
            return out;
          }
          out.push(...commandSegments(text.slice(j + 1, k), depth + 1));
          segment += inlineSubstitution(text.slice(j + 1, k));
          j = k + 1;
          continue;
        }
        if (text[j] === '$' && text[j + 1] === '(') {
          const end = closingParen(text, j + 2);
          if (end < 0) {
            flush();
            return out;
          }
          out.push(...commandSegments(text.slice(j + 2, end), depth + 1));
          segment += inlineSubstitution(text.slice(j + 2, end));
          j = end + 1;
          continue;
        }
        j += 1;
      }
      if (j >= text.length) {
        segment += text.slice(i + 1).replace(/[\t\n ]/g, '\x01');
        flush();
        return out;
      }
      segment += text.slice(i + 1, j).replace(/[\t\n ]/g, '\x01');
      i = j + 1;
      continue;
    }
    if (c === '`') {
      const k = text.indexOf('`', i + 1);
      if (k < 0) {
        flush();
        return out;
      }
      out.push(...commandSegments(text.slice(i + 1, k), depth + 1));
      segment += inlineSubstitution(text.slice(i + 1, k));
      i = k + 1;
      continue;
    }
    if (c === '$' && text[i + 1] === '(') {
      const end = closingParen(text, i + 2);
      if (end < 0) {
        flush();
        return out;
      }
      out.push(...commandSegments(text.slice(i + 2, end), depth + 1));
      segment += inlineSubstitution(text.slice(i + 2, end));
      i = end + 1;
      continue;
    }
    if (c === '#' && (segment === '' || ' \t'.includes(text[i - 1]))) {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '|' && text[i + 1] === '|') {
      flush();
      i += 2;
      continue;
    }
    if (c === '&' && text[i + 1] === '&') {
      flush();
      i += 2;
      continue;
    }
    if ('|&;\n'.includes(c)) {
      flush();
      i += 1;
      continue;
    }
    if (c === '(' || c === ')') {
      flush();
      i += 1;
      continue;
    }
    segment += c;
    i += 1;
  }
  flush();
  return out;
}

// Inline form of a substitution inside a segment: $(text) with \x01 in place of blanks, text cut to 300 characters.
function inlineSubstitution(text) {
  return `$(${String(text).replace(/\s+/g, '\x01').slice(0, 300)})`;
}

// Index of the parenthesis that closes a $( opened before start; -1 when unclosed. Quotes and nested $() count.
function closingParen(text, start) {
  let level = 1;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'") {
      const j = text.indexOf("'", i + 1);
      if (j < 0) return -1;
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        j += 1;
      }
      if (j >= text.length) return -1;
      i = j + 1;
      continue;
    }
    if (c === '$' && text[i + 1] === '(') {
      level += 1;
      i += 2;
      continue;
    }
    if (c === '(') level += 1;
    if (c === ')') {
      level -= 1;
      if (level === 0) return i;
    }
    i += 1;
  }
  return -1;
}

// Words of a segment (quotes removed), without redirections.
const REDIRECT_START = /^[0-9]*[<>]/; // a token that starts with a redirection, file name glued or not
const REDIRECT_ONLY = /^[0-9]*[<>]{1,2}$/; // the operator alone: the file name is the next token
function segmentArgv(segment) {
  const raw = segment.split(/\s+/).filter(Boolean);
  const argv = [];
  for (let k = 0; k < raw.length; k++) {
    const t = raw[k];
    if (REDIRECT_START.test(t)) {
      if (REDIRECT_ONLY.test(t)) k += 1;
      continue;
    }
    argv.push(t);
  }
  return argv;
}

// --- wrappers: unwrapped so that the command under them is judged (flags with a value per wrapper) ---
const WRAPPER_FLAGS = new Map([
  ['sudo', ['-u', '-g', '-C', '-D', '-R', '-T', '-p', '-h', '-r', '-t', '-U', '--user', '--group', '--close-from', '--chdir', '--chroot', '--prompt', '--host', '--role', '--type', '--other-user', '--command-timeout']],
  ['env', ['-u', '-C', '-a', '--unset', '--chdir', '--argv0']],
  ['timeout', ['-s', '-k', '--signal', '--kill-after']],
  ['nice', ['-n', '--adjustment']],
  ['ionice', ['-n', '-c', '--class', '--classdata']],
  ['stdbuf', ['-i', '-o', '-e', '--input', '--output', '--error']],
  ['watch', ['-n', '--interval']],
  ['chroot', ['--userspec', '--groups']],
  ['nsenter', ['-t', '--target', '-S', '-G', '-r', '-w', '--setuid', '--setgid', '--root', '--wd']],
  ['su', ['-c', '--command']],
  ['exec', ['-a']],
  ['systemd-run', ['-u', '--unit', '-p', '--property', '--slice', '--uid', '--gid', '-E', '--setenv', '--description', '-M', '--machine', '-H', '--host', '--working-directory']],
]);
const WRAPPERS = new Set([...WRAPPER_FLAGS.keys(), 'nohup', 'command', 'exec', 'time', 'builtin', 'setsid', 'busybox', 'systemd-run']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const SHELL_C_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/; // -c, -lc, -ec, -xc
const XARGS_FLAGS_WITH_VALUE = new Set(['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s', '-e']);
const GLUED_NUMBER = /^-[a-zA-Z]+\d+$/; // xargs -n1, timeout -k1: the value glued to the flag

// xargs without a target: the targets come from the input, which the judge cannot read.
function xargsUnknownTarget(sub) {
  if (!sub.length) return true;
  const p0 = sub[0];
  if (['kill', 'pkill', 'killall', 'killall5'].includes(p0)) {
    const targets = sub.slice(1).filter((x) => !x.startsWith('-') && x !== '--');
    return targets.length === 0;
  }
  if (p0 === 'docker' || p0 === 'docker-compose') {
    const rest = sub.slice(1);
    const action = rest.find((x) => !x.startsWith('-')) || '';
    if (['stop', 'kill', 'restart', 'rm', 'pause'].includes(action)) {
      return rest.slice(rest.indexOf(action) + 1).filter((x) => !x.startsWith('-')).length === 0;
    }
    if (action === 'compose' || action === 'stack') {
      const sub2 = rest.slice(rest.indexOf(action) + 1).find((x) => !x.startsWith('-')) || '';
      return COMPOSE_ACTIONS.has(sub2);
    }
  }
  return false;
}

// Unwraps the wrappers in front of the command. Returns the argv that remains, the nested segments (shell -c text,
// su -c text, env -S text) and the flags unknownTarget (xargs) and unreadable (ambiguous quoting after -c).
// A path to a binary is reduced to its base name, except for an /etc/init.d/ script (a unit, not a command).
const headName = (word) => (!/^\/etc\/init\.d\//.test(word) && /^\//.test(word) ? word.split('/').pop() : word);

function unwrapWrappers(argv, depth) {
  let a = argv;
  const nested = [];
  let unknownTarget = false;
  for (;;) {
    if (!a.length) break;
    // The command at the head is named by its base name each time a wrapper has been removed, so `env /bin/kill 1`
    // and `sudo /usr/bin/env /bin/kill 1` are judged like `kill 1`.
    if (headName(a[0]) !== a[0]) a = [headName(a[0]), ...a.slice(1)];
    const s = a[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(s)) {
      a = a.slice(1);
      continue;
    }
    if (SHELLS.has(s)) {
      const icFlag = a.findIndex((x) => SHELL_C_FLAG.test(x));
      if (icFlag > 0) {
        if (a.length - (icFlag + 1) > 1) return { argv: [], nested, unreadable: true };
        const text = a[icFlag + 1];
        if (text) nested.push(...commandSegments(text, depth + 1));
        return { argv: [], nested, unknownTarget: false };
      }
      break; // a shell without -c runs nothing from its arguments
    }
    if (s === 'xargs') {
      const sub = [];
      let k = 1;
      while (k < a.length) {
        const t = a[k];
        if (t === '--') {
          k += 1;
          break;
        }
        if (t.startsWith('-')) {
          k += XARGS_FLAGS_WITH_VALUE.has(t) ? 2 : 1;
          continue;
        }
        break;
      }
      sub.push(...a.slice(k).filter((x) => !GLUED_NUMBER.test(x)));
      if (xargsUnknownTarget(sub)) return { argv: sub, nested, unknownTarget: true };
      a = sub;
      continue;
    }
    if (s === 'env' && a[1] === '-S') {
      const text = a[2];
      if (text) nested.push(...commandSegments(text, depth + 1));
      return { argv: a.slice(3), nested, unknownTarget };
    }
    if (s === 'su') {
      let k = 1;
      while (k < a.length) {
        const t = a[k];
        if (t === '-c' || t === '--command') {
          const text = a[k + 1];
          if (text) nested.push(...commandSegments(text, depth + 1));
          return { argv: [], nested, unknownTarget };
        }
        if (t === '--') {
          k += 1;
          break;
        }
        if (t.startsWith('-')) {
          k += 1;
          continue;
        }
        break;
      }
      if (k < a.length) k += 1; // the user name is skipped
      a = a.slice(k);
      continue;
    }
    if (WRAPPERS.has(s)) {
      let k = 1;
      while (k < a.length) {
        const t = a[k];
        if (t === '--') {
          k += 1;
          break;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) && (s === 'env' || s === 'sudo')) {
          k += 1;
          continue;
        }
        if (t.startsWith('-')) {
          k += (WRAPPER_FLAGS.get(s) || []).includes(t) ? 2 : 1;
          continue;
        }
        if ((s === 'timeout' || s === 'nice' || s === 'ionice') && /^[-+]?[0-9]/.test(t)) {
          k += 1; // duration or priority
          continue;
        }
        if (s === 'chroot' && /^[ \t]*\//.test(t)) {
          k += 1; // the chroot directory
          break;
        }
        if (s === 'su' && !t.startsWith('-') && t !== '--') {
          k += 1; // the user name
          break;
        }
        break;
      }
      a = a.slice(k);
      continue;
    }
    break;
  }
  return { argv: a, nested, unknownTarget };
}

// --- signal words and option parsing shared by kill, pkill and killall ---
// Signal names of Linux (without the SIG prefix); `-9`, `-KILL`, `-SIGKILL` and `-RTMIN+3` select a signal.
const SIGNAL_NAMES = new Set(['EXIT', 'HUP', 'INT', 'QUIT', 'ILL', 'TRAP', 'ABRT', 'IOT', 'BUS', 'FPE', 'KILL', 'USR1', 'SEGV', 'USR2', 'PIPE', 'ALRM', 'TERM', 'STKFLT', 'CHLD', 'CLD', 'CONT', 'STOP', 'TSTP', 'TTIN', 'TTOU', 'URG', 'XCPU', 'XFSZ', 'VTALRM', 'PROF', 'WINCH', 'IO', 'POLL', 'PWR', 'SYS', 'UNUSED']);
function isSignalWord(word) {
  const w = String(word).replace(/^SIG/i, '').toUpperCase();
  return /^[0-9]{1,3}$/.test(String(word)) || SIGNAL_NAMES.has(w) || /^RT(MIN|MAX)([+-][0-9]+)?$/.test(w);
}
// The number of a signal word (0 for `0` and for EXIT), a name otherwise.
const signalOf = (word) => {
  const w = String(word ?? '').replace(/^SIG/i, '').toUpperCase();
  return /^[0-9]+$/.test(w) ? Number(w) : w === 'EXIT' ? 0 : w;
};

// pkill (procps-ng) and killall (psmisc) read their options differently: `-r` is a value (the run states) for pkill and a flag
// (the names are regular expressions) for killall; `-n` and `-c` of pkill take nothing, `-n` of killall is a value; `-i` and `-I`
// mean "ignore case". Each table maps the short letters to the long names, and the long names that take a value are listed.
// Short options can be clustered (`-fi`, `-furoot`): a letter that takes a value takes the rest of the cluster, else the next word.
// A long option can be shortened to any unambiguous prefix (`--ignore`), as getopt_long does.
const PKILL_OPTIONS = {
  short: { H: 'require-handler', q: 'queue', e: 'echo', c: 'count', f: 'full', g: 'pgroup', G: 'group', i: 'ignore-case', n: 'newest', o: 'oldest', O: 'older', P: 'parent', s: 'session', t: 'terminal', u: 'euid', U: 'uid', x: 'exact', F: 'pidfile', L: 'logpidfile', r: 'runstates', A: 'ignore-ancestors', v: 'inverse', w: 'lightweight' },
  longWithValue: ['signal', 'queue', 'pgroup', 'group', 'older', 'parent', 'session', 'terminal', 'euid', 'uid', 'pidfile', 'runstates', 'cgroup', 'ns', 'nslist'],
  longFlags: ['require-handler', 'echo', 'count', 'full', 'ignore-case', 'newest', 'oldest', 'exact', 'logpidfile', 'ignore-ancestors', 'inverse', 'lightweight', 'help', 'version'],
};
const KILLALL_OPTIONS = {
  short: { e: 'exact', I: 'ignore-case', g: 'process-group', y: 'younger-than', o: 'older-than', i: 'interactive', l: 'list', q: 'quiet', r: 'regexp', s: 'signal', u: 'user', v: 'verbose', w: 'wait', n: 'ns', Z: 'context', V: 'version' },
  longWithValue: ['younger-than', 'older-than', 'signal', 'user', 'ns', 'context'],
  longFlags: ['exact', 'ignore-case', 'process-group', 'interactive', 'list', 'quiet', 'regexp', 'verbose', 'wait', 'version', 'help'],
};

function expandLongOption(name, table) {
  const all = [...table.longWithValue, ...table.longFlags];
  if (all.includes(name)) return name;
  const matches = all.filter((long) => long.startsWith(name));
  return matches.length === 1 ? matches[0] : name;
}

// The options and the positional arguments of a pkill or killall command (argv[0] is the command). Returns
// { positionals, flags: Set of long names, values: Map of long name to the list of its values }. Signal words (`-9`, `-KILL`)
// are skipped; the words after `--` are positionals.
function parseProcessOptions(argv, table) {
  const out = { positionals: [], flags: new Set(), values: new Map() };
  const take = (name, value) => {
    if (value === undefined) return;
    out.values.set(name, [...(out.values.get(name) || []), value]);
  };
  let afterDashes = false;
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (afterDashes || !t.startsWith('-') || t === '-') {
      out.positionals.push(t);
      continue;
    }
    if (t === '--') {
      afterDashes = true;
      continue;
    }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = expandLongOption(eq < 0 ? t.slice(2) : t.slice(2, eq), table);
      if (table.longWithValue.includes(name)) take(name, eq >= 0 ? t.slice(eq + 1) : argv[++i]);
      else out.flags.add(name);
      continue;
    }
    const body = t.slice(1);
    if (isSignalWord(body)) continue;
    for (let k = 0; k < body.length; k++) {
      const name = table.short[body[k]];
      if (name && table.longWithValue.includes(name)) {
        take(name, body.slice(k + 1) || argv[++i]);
        break;
      }
      out.flags.add(name || body[k]);
    }
  }
  return out;
}

// --- pkill and killall: a pattern matches a name as a whole word (word characters [A-Za-z0-9_-]), ---
// a name equal to the pattern or to "<name>.service", or a name that contains a pattern of at least 4 characters.
// With ignoreCase (pkill -i, killall -I) the comparisons ignore the letter case, regular expressions get the i flag.
const WORD_CHARS = /[A-Za-z0-9_-]/;
function patternMatchesName(pattern, name, full = true, ignoreCase = false) {
  const flags = ignoreCase ? 'i' : '';
  const test = (source) => {
    try {
      return new RegExp(source, flags).test(name);
    } catch {
      return false; // an invalid regular expression: no match
    }
  };
  const p = ignoreCase ? pattern.toLowerCase() : pattern;
  const n = ignoreCase ? name.toLowerCase() : name;
  if (p === n) return true;
  if (full === false) {
    // Narrow mode for the generic names and the comm of ancestors: only "the pattern matches the name".
    if (p.length >= 4 && n.includes(p)) return true;
    if (/[^A-Za-z0-9_@ .-]/.test(pattern)) {
      return test(`^(?:${pattern})$`) || test(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
    return false;
  }
  if (p === `${n}.service` || p.startsWith(`${n}.service`)) return true;
  let idx = p.indexOf(n);
  while (idx >= 0) {
    const before = idx > 0 ? p[idx - 1] : '';
    const after = idx + n.length < p.length ? p[idx + n.length] : '';
    if (!WORD_CHARS.test(before) && !WORD_CHARS.test(after)) return true;
    idx = p.indexOf(n, idx + 1);
  }
  if (p.length >= 4 && n.includes(p)) return true;
  if (/[^A-Za-z0-9_@ .-]/.test(pattern)) {
    // Metacharacters: pkill reads the pattern as an extended regex, and the escaped form is tested too.
    return test(pattern) || test(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  return false;
}

const MASS_SELECTORS = ['euid', 'uid', 'pgroup', 'group', 'terminal', 'session', 'cgroup', 'user', 'process-group']; // without a pattern they select every process of a user, group, terminal or session
function pkillKillall(argv, guarded) {
  const isPkill = argv[0] === 'pkill';
  const parsed = parseProcessOptions(argv, isPkill ? PKILL_OPTIONS : KILLALL_OPTIONS);
  const fullLine = isPkill && parsed.flags.has('full');
  const ignoreCase = parsed.flags.has('ignore-case');
  const regexp = !isPkill && parsed.flags.has('regexp'); // killall -r: every name is a regular expression
  // pkill takes one pattern; killall takes any number of names, and each of them is judged.
  const patterns = (isPkill ? parsed.positionals.slice(0, 1) : parsed.positionals).map((p) => p.replace(/\x01/g, ' ')).filter((p) => p !== '');
  if (!patterns.length) {
    if (MASS_SELECTORS.some((name) => parsed.values.has(name) || parsed.flags.has(name))) return refusal('pkill/killall: user or group selector without a pattern (mass kill of every process it selects)');
    for (const pidText of parsed.values.get('parent') || []) {
      const text = pidText.replace(/\x01/g, ' ').trim();
      if (text === '$$') continue; // children of the shell that runs the command, not the hook's ancestor
      if (/PPID/.test(text)) return refusal('pkill: selector -P on the parent pid ($PPID)');
      if (/^[-+]?[0-9]+$/.test(text)) {
        const n = Number(text);
        if (n === 1 || guarded.pids.has(n)) return refusal(`pkill -P ${n}: pid 1 or an ancestor of the agent shell`);
        continue;
      }
      if (/^\$\{?[A-Za-z_]/.test(text)) continue; // a variable of the agent shell, as in kill $PID
    }
    return null; // pkill -F file or pkill without anything: no pattern selects a target, so no signal goes out
  }
  const flagText = fullLine ? ' -f' : '';
  for (const pattern of patterns) {
    const matchesFull = (name) => (regexp ? regexMatches(pattern, name, ignoreCase) : patternMatchesName(pattern, name, true, ignoreCase));
    const matchesNarrow = (name) => (regexp ? regexMatches(pattern, name, ignoreCase) : patternMatchesName(pattern, name, false, ignoreCase));
    for (const name of guarded.names) {
      if (matchesFull(name)) {
        return refusal(isPkill
          ? `pkill${flagText}: pattern matches protected name (${name})`
          : `killall: pattern matches protected name (${name})`);
      }
    }
    for (const name of guarded.generic) {
      if (matchesNarrow(name)) {
        return refusal(isPkill
          ? `pkill${flagText}: pattern matches generic protected name (${name})`
          : `killall: pattern matches generic protected name (${name})`);
      }
    }
    for (const comm of guarded.comms || []) {
      if (matchesNarrow(comm)) return refusal(`pkill${flagText}: pattern matches comm of an agent shell ancestor (${comm})`);
    }
    for (const line of guarded.cmdline || []) {
      if (matchesFull(line)) return refusal(`pkill${flagText}: pattern matches cmdline of an agent shell ancestor`);
    }
  }
  return null;
}

// killall -r: the name is an extended regular expression searched in the process name; a pattern that is not one matches nothing.
function regexMatches(pattern, name, ignoreCase) {
  try {
    return new RegExp(pattern, ignoreCase ? 'i' : '').test(name);
  } catch {
    return false;
  }
}

// --- kill: targets are pids, groups, %jobs, shell variables of the agent, $$/$PPID, globs and substitutions ---
const SUBST_SKIPPED = new Set(['cat', 'head', 'tail', 'jobs']); // a pid file of a process of the agent, the job table
const SUBST_UNCERTAIN = new Set(['pgrep', 'pidof', 'lsof', 'fuser', 'ps']); // their result depends on the name they search for
// True when a substitution selects no protected process; false when it is uncertain.
function substitutionAllowed(text, guarded) {
  const argv = String(text).replace(/\x01/g, ' ').split(/\s+/).filter(Boolean);
  if (!argv.length) return true;
  const p0 = argv[0].split('/').pop();
  if (SUBST_SKIPPED.has(p0)) return true;
  if (SUBST_UNCERTAIN.has(p0)) {
    const names = [...guarded.names, ...guarded.generic];
    const base = (x) => String(x).replace(/\.(service|timer|socket|path|mount|slice)$/i, '');
    for (const arg of argv.slice(1)) {
      if (arg.startsWith('-')) continue;
      if (names.includes(arg) || names.includes(base(arg))) return false;
    }
    return true;
  }
  return false; // other commands in $() make the target uncertain (fail-safe)
}

// The reason why one kill target is uncertain, or null when it is not (a number, a %job, a variable of the agent).
function killTargetUncertain(target, guarded) {
  const raw = String(target).replace(/\x01/g, ' ');
  if (/^[-+]?[0-9]+$/.test(raw)) return null;
  if (/^%\d+$/.test(raw)) return null;
  const substitution = /^\$\((.*)\)$/.exec(raw) || /^`(.*)`$/.exec(raw); // before globs: ${VAR} contains braces
  if (substitution) return substitutionAllowed(substitution[1], guarded) ? null : 'target from a command substitution points to an uncertain process';
  if (raw === '$$' || raw === '${$}' || /PPID/.test(raw.replace(/^\$\{?/, '').replace(/\}?$/, ''))) {
    return 'target $$ or $PPID (the shell process and its parent)';
  }
  if (/^\$\{?[!]?\}?$/.test(raw) || /^\$!?[A-Za-z_][A-Za-z0-9_]*$/.test(raw) || /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(raw)) return null;
  if (raw.startsWith('$')) return 'uncertain target (substitution or shell variable)';
  if (/[*?[{]/.test(raw)) return 'glob in target';
  return null;
}

// kill reads its words in order: options (`-s SIG`, `-n NUM`, `--signal SIG`, `-SIG`, `-9`) until the signal is chosen, and every other
// word is a target, including a negative number after the signal (`kill -TERM -4242` signals the process group 4242). Before a signal is
// chosen a lone `-<digits>` is the signal itself.
function killFamily(argv, guarded) {
  let signal = null;
  let signalChosen = false;
  let afterDashes = false;
  const targets = [];
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (afterDashes || !t.startsWith('-') || t === '-') {
      targets.push(t);
      continue;
    }
    if (t === '--') {
      afterDashes = true;
      continue;
    }
    if (t === '-l' || t === '-L' || t === '--list' || t === '--table' || t.startsWith('--list=')) return null; // listing signals sends nothing
    if (t === '-s' || t === '-n' || t === '--signal') {
      signal = signalOf(argv[i + 1]);
      signalChosen = true;
      i += 1;
      continue;
    }
    if (t === '-q' || t === '--queue') {
      i += 1; // the integer sent with the signal
      continue;
    }
    if (t.startsWith('--signal=')) {
      signal = signalOf(t.slice('--signal='.length));
      signalChosen = true;
      continue;
    }
    if (t.startsWith('--')) continue;
    const word = t.slice(1);
    if (!signalChosen && isSignalWord(word)) {
      signal = signalOf(word);
      signalChosen = true;
      continue;
    }
    if (/^[0-9]+$/.test(word)) targets.push(t); // after the signal: a process group
  }
  if (signal === 0) return null; // signal 0 sends nothing (existence check)
  for (const target of targets) {
    if (/^[-+]?[0-9]+$/.test(target)) {
      if (target.startsWith('-')) {
        const n = Number(target.slice(1));
        if (n === 1) return refusal('kill: signal to all processes (group -1, broadcast)');
        if (guarded.pgids.has(n)) return refusal(`kill: signal to process group -${n} (ancestor of the agent shell)`);
        continue;
      }
      const n = Number(target);
      if (n === 1) return refusal('kill: target pid 1 (init)');
      if (guarded.pids.has(n)) return refusal(`kill: target pid ${n} (ancestor of the agent shell)`);
      continue;
    }
    const uncertain = killTargetUncertain(target, guarded);
    if (uncertain) return refusal(`kill: ${uncertain}`);
  }
  if (!targets.length && signal === 1) return refusal('kill: signal -1 (SIGHUP) without a target');
  return null;
}

// --- systemctl: stop-like actions and actions that stop everything; flags with a value are skipped ---
const SYSTEMCTL_ACTIONS = new Set(['stop', 'restart', 'kill', 'mask', 'try-restart', 'reload-or-restart', 'try-reload-or-restart', 'reboot', 'poweroff', 'halt', 'kexec', 'isolate']);
const SYSTEMCTL_FLAGS_WITH_VALUE = new Set(['-t', '-H', '-M', '-p', '-n', '-s']);
const STOPS_EVERYTHING = new Set(['reboot', 'poweroff', 'halt', 'kexec', 'isolate']); // refused without a unit check
const START_TARGETS = new Set(['reboot.target', 'poweroff.target', 'halt.target', 'kexec.target']); // starting them stops the system
const unitBase = (unit) => String(unit).replace(/\.(service|timer|socket|path|mount|slice)$/i, '');

// The refusal for one unit, or null when the unit is not protected.
function protectedUnit(unit, guarded) {
  if (/[$*?[{]/.test(unit)) return refusal('systemctl: unit uncertain (glob or substitution)');
  const base = unitBase(unit);
  if (SYSTEM_UNITS.includes(unit) || SYSTEM_UNITS.includes(base)) {
    return refusal(`systemctl: system unit from the protected list (${SYSTEM_UNITS.includes(base) ? base : unit})`);
  }
  if (guarded.names.includes(base)) return refusal(`systemctl: unit from the protected service list (${base})`);
  return null;
}

function systemctlFamily(argv, guarded) {
  let action = null;
  let now = false;
  let disable = false;
  const units = [];
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('-')) {
      if (t === '--now') now = true; // with disable: stop and disable
      if (SYSTEMCTL_FLAGS_WITH_VALUE.has(t)) i += 1;
      continue; // --user, --no-pager and similar
    }
    if (action === null) {
      action = t;
      if (t === 'disable') disable = true;
      continue;
    }
    units.push(t);
  }
  if (action === 'start') {
    for (const unit of units) {
      if (START_TARGETS.has(unit) || START_TARGETS.has(unitBase(unit) + '.target')) return refusal('systemctl start: system-stopping target from the list');
    }
    return null;
  }
  const refuses = disable ? now : SYSTEMCTL_ACTIONS.has(action);
  if (!refuses) return null; // status, cat, enable without --now, daemon-reload
  if (STOPS_EVERYTHING.has(action)) return refusal(`systemctl ${action}: stops the whole system (all protected services)`);
  for (const unit of units) {
    const r = protectedUnit(unit, guarded);
    if (r) return r;
  }
  return null;
}

// --- service and /etc/init.d/ scripts: the same unit rules as systemctl ---
const SERVICE_ACTIONS = new Set(['stop', 'restart', 'force-reload', 'try-restart']);
function serviceFamily(unit, action, guarded, source) {
  if (!SERVICE_ACTIONS.has(action)) return null; // status, start, reload pass
  const r = protectedUnit(unit, guarded);
  if (r) return refusal(`${source}: ${r.replace(REFUSAL_PREFIX, '').replace(/\.$/, '')}`);
  return null;
}

// --- docker: global options before the action are skipped; compose with global flags and the test-project exception ---
const DOCKER_ACTIONS = new Set(['stop', 'restart', 'kill', 'pause', 'rm']);
const COMPOSE_ACTIONS = new Set(['down', 'stop', 'kill', 'pause', 'restart', 'rm']);
const COMPOSE_GLOBAL_FLAGS = new Set(['-f', '--file', '-p', '--project-name', '--project-directory', '--profile', '--env-file', '--context', '-H', '--host']);
const GLUED_OPTION = /^--?[A-Za-z][A-Za-z0-9-]*=/; // --file=x, --time=10

// True when the path is inside one of the test directories (a path equal to a directory counts too).
function isTestPath(value, testDirs) {
  if (typeof value !== 'string') return false;
  return testDirs.some((dir) => {
    const clean = dir.replace(/\/+$/, '');
    return value === clean || value.startsWith(`${clean}/`);
  });
}

// True when the project is marked as a test project: a file or directory under a test directory, or a project name test-*.
function composeTestException(tokens, testDirs) {
  let testFile = false;
  let testName = false;
  let projectDirectory = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const glued = GLUED_OPTION.exec(t);
    if (glued) {
      const name = glued[0].replace(/[=]$/, '');
      const value = t.slice(glued[0].length);
      if (COMPOSE_GLOBAL_FLAGS.has(name)) {
        if (isTestPath(value, testDirs)) {
          testFile = true;
          projectDirectory = projectDirectory || name === '--project-directory';
        } else if (name === '-p' || name === '--project-name') {
          if (value.startsWith('test-')) testName = true;
        }
      }
      continue;
    }
    if (COMPOSE_GLOBAL_FLAGS.has(t)) {
      const value = tokens[i + 1];
      if (t === '-p' || t === '--project-name') {
        if (typeof value === 'string' && value.startsWith('test-')) testName = true;
      } else if (isTestPath(value, testDirs)) {
        testFile = true;
        projectDirectory = projectDirectory || t === '--project-directory';
      }
      i += 1;
      continue;
    }
  }
  return testFile || testName || projectDirectory;
}

function dockerFamily(argv, guarded, cwd) {
  const isCompose = argv[0] === 'docker-compose'; // docker-compose is read as docker compose
  let tokens = argv.slice(1);
  if (isCompose) tokens = ['compose', ...tokens];
  // Global options of docker (-H, --host, --context with a value) are skipped before the action.
  let i = 0;
  while (i < tokens.length && tokens[i].startsWith('-') && tokens[i] !== '--') {
    if (['-H', '--host', '--context'].includes(tokens[i])) i += 1;
    i += 1;
  }
  const positional = tokens.slice(i);
  let action = positional[0];
  if (action === 'compose' || action === 'stack') {
    const composeRest = positional.slice(1);
    let cmd = null;
    let j = 0;
    while (j < composeRest.length && !cmd) {
      const t = composeRest[j];
      if (GLUED_OPTION.test(t) && COMPOSE_GLOBAL_FLAGS.has(t.replace(/[=].*$/, ''))) {
        j += 1;
        continue;
      }
      if (COMPOSE_GLOBAL_FLAGS.has(t)) {
        j += 2;
        continue;
      }
      if (t.startsWith('-')) {
        j += 1;
        continue;
      }
      cmd = t;
      break; // the compose sub-command
    }
    if (!cmd || !COMPOSE_ACTIONS.has(cmd)) return null; // compose ps, config, build pass
    const hasComposePath = composeRest.some((t) => ['-f', '--file', '--project-directory'].includes(t)
      || (GLUED_OPTION.test(t) && ['-f', '--file', '--project-directory'].includes(t.replace(/[=].*$/, ''))));
    // Without a file or directory flag, the working directory of the hook decides.
    const exempt = composeTestException(composeRest, guarded.testDirs) || (!hasComposePath && isTestPath(String(cwd || ''), guarded.testDirs));
    if (exempt) return null;
    return refusal(`docker compose${isCompose ? ' (docker-compose)' : ''} ${cmd}: stops the whole container project`);
  }
  if (action === 'container' && positional.length > 1) {
    positional.shift();
    action = positional[0];
  }
  if (!DOCKER_ACTIONS.has(action)) return null; // ps, logs, exec, images pass
  const names = [];
  let forced = false;
  for (let i = 1; i < positional.length; i++) {
    const t = positional[i];
    if (GLUED_OPTION.test(t)) continue; // --time=10
    if (t === '-f' || t === '--force') {
      forced = true;
      continue;
    }
    if (/^-[a-z]*f[a-z]*$/.test(t)) {
      forced = true; // combined flags with f (-fv, -vf, -sf)
      continue;
    }
    if (['-t', '--time', '-s', '--signal'].includes(t)) {
      i += 1;
      continue;
    }
    if (t.startsWith('-')) continue;
    names.push(t);
  }
  for (const name of names) {
    if (/[$*?[{]/.test(name)) return refusal(`docker ${action}: uncertain target (glob or substitution)`);
    if (guarded.names.includes(name)) {
      if (action === 'rm' && !forced) continue; // rm without -f on a running container does nothing
      return refusal(`docker ${action} ${name.slice(0, 60)}: container from the protected list`);
    }
  }
  return null;
}

// --- commands that stop everything ---
const STOP_ALL_COMMANDS = new Set(['reboot', 'poweroff', 'shutdown', 'halt', 'killall5']);
const LOGINCTL_SUBCOMMANDS = new Set(['terminate-session', 'terminate-user', 'kill-session', 'kill-user']);
const MACHINECTL_SUBCOMMANDS = new Set(['poweroff', 'reboot', 'terminate']);
function stopAllFamily(argv) {
  if (!argv.length) return null; // a shell with -c yields an empty argv; its text is judged separately
  const p0 = argv[0].split('/').pop();
  if (STOP_ALL_COMMANDS.has(p0)) return refusal(`${p0}: stops the whole system or all protected services`);
  if (p0 === 'init' || p0 === 'telinit') {
    const level = String(argv[1] ?? '');
    if (level === '0' || level === '6') return refusal(`${p0} ${level}: runlevel that stops the whole system`);
    return null;
  }
  if (p0 === 'fuser') {
    const kills = argv.slice(1).some((t) => t === '-k' || t === '--kill' || /^-[a-z]*k[a-z]*$/.test(t));
    return kills ? refusal('fuser -k: signal to all processes using the file (protected services)') : null;
  }
  if (p0 === 'tmux') return argv[1] === 'kill-server' ? refusal('tmux kill-server: stops tmux sessions (agent sessions may run in them)') : null;
  if (p0 === 'loginctl') return LOGINCTL_SUBCOMMANDS.has(argv[1]) ? refusal('loginctl terminate/kill: stops user sessions') : null;
  if (p0 === 'machinectl') return MACHINECTL_SUBCOMMANDS.has(argv[1]) ? refusal('machinectl poweroff/reboot/terminate: stops machines and sessions') : null;
  return null;
}

// --- judge: one segment; null = pass, a refusal text = refuse ---
function judgeSegment(segment, guarded, cwd, depth) {
  if (segment.charCodeAt(0) === 2) return refusal('nested $() and backticks too deep, command unreadable for the judge');
  let argv = segmentArgv(segment);
  const SYNTAX_WORDS = new Set(['then', 'do', 'else', 'elif', 'while', 'until', 'if', '!', '{', '(']);
  while (argv.length && (SYNTAX_WORDS.has(argv[0]) || argv[0] === 'coproc' || argv[0] === 'time')) argv = argv.slice(1);
  while (argv.length && (argv[argv.length - 1] === ')' || argv[argv.length - 1] === '}' || argv[argv.length - 1] === 'fi' || argv[argv.length - 1] === 'done' || argv[argv.length - 1] === 'esac')) {
    argv = argv.slice(0, -1);
  }
  const unwrapped = unwrapWrappers(argv, depth);
  if (unwrapped.unreadable) return refusal('bash -c: quoting boundaries unreadable (several tokens after -c), the command may target protected processes');
  for (const nestedSegment of unwrapped.nested) {
    const r = judgeSegment(nestedSegment, guarded, cwd, depth + 1);
    if (r) return r;
  }
  if (!argv.length) {
    if (unwrapped.unknownTarget) return refusal('command with a target from input (xargs), input unknown');
    return null;
  }
  const a2 = unwrapped.argv;
  const command = a2.length ? a2[0] : argv[0];
  if (unwrapped.unknownTarget && ['kill', 'pkill', 'killall'].includes(command)) return refusal(`${command} through xargs: target from input unknown`);
  if (unwrapped.unknownTarget && (command === 'docker' || command === 'docker-compose')) return refusal(`${command} through xargs: target from input unknown`);
  if (command === 'kill') return killFamily(a2, guarded);
  if (command === 'pkill' || command === 'killall') return pkillKillall(a2, guarded);
  if (command === 'systemctl') return systemctlFamily(a2, guarded);
  if (command === 'service') return serviceFamily(a2[1], a2[2], guarded, 'service');
  if (/^\/etc\/init\.d\//.test(a2[0])) return serviceFamily(a2[0].split('/').pop(), a2[1], guarded, '/etc/init.d');
  if (command === 'docker' || command === 'docker-compose') return dockerFamily(a2, guarded, cwd);
  return stopAllFamily(a2);
}

/**
 * Judges one Bash command. Returns null when the command passes, or { refuse: true, reason } when it is refused.
 * Without OMC_JEV_KILL_GUARD=1 it always returns null. An exception propagates: the hook logs it and lets the command pass.
 * options.ancestors replaces the reading of /proc (tests use it to get a fixed ancestor description).
 */
export function judgeKill(command, env = process.env, cwd, options) {
  if (!isEnabled(env)) return null;
  if (!command || typeof command !== 'string') return null;
  const text = command.length > 100000 ? command.slice(0, 100000) : command; // longer commands: the first 100 000 characters are judged
  const allow = new Set(listFromEnv(env, 'OMC_JEV_KILL_GUARD_ALLOW'));
  const guarded = {
    names: protectedNames(env).filter((name) => !allow.has(name)),
    generic: GENERIC_PROTECTED_NAMES.filter((name) => !allow.has(name)),
    testDirs: testDirsOf(env),
    ...(options?.ancestors || protectedAncestors()),
  };
  for (const segment of commandSegments(text)) {
    const r = judgeSegment(segment, guarded, cwd, 0);
    if (r) return { refuse: true, reason: r };
  }
  return null;
}
