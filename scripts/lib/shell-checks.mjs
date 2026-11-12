// Shell command checks for the Bash and PowerShell tools (opt-in: OMC_SHELL_CHECKS=1).
//
// Without the variable no hook imports this file. With it, pre-tool-enforcer.mjs runs runShellChecks() before the
// rest of the hook, and post-tool-verifier.mjs / post-tool-use-failure.mjs run recordShellToolErrors() after the tool.
// Every entry point is fail-open: the hook catches anything thrown and carries on as without the checks.
//
// Checks (Bash; win32 means Git Bash on Windows):
//   length     win32: chars + 4 x apostrophes + 460 >= 7700 -> deny. The Bash tool wraps the command in about 460
//              characters and turns every ' into '"'"' inside eval '...'; Git Bash cuts the bash -c argument after
//              about 8190 UTF-16 units, so a longer command loses its tail (often "unexpected EOF", sometimes a
//              silently shortened here-document).
//   cr-parser  win32: in one top-level "..." a $(...) or ${...} with a CR-producing $'...' after another $(...) -> deny
//              (parser bug of bash 5.3.15 in Git for Windows 2.55.0: "unexpected EOF while looking for matching `)'")
//   syntax     all platforms: bash -n with the command on stdin; a syntax error -> deny. On win32 the text after Git Bash
//              halves backslashes is checked, and only commands longer than 200 characters (bash -n costs one MSYS2
//              process start, measured p50 about 110 ms and p95 about 500 ms there).
//   heredoc    all platforms: a here-document without its closing line (bash -n only warns and exits 0) -> deny
//   backslash  win32: a run of backslashes not directly before " -> additionalContext warning (Git Bash halves it)
// Checks (PowerShell, warnings only):
//   ps-ssh-dollar  ssh with \$ inside "..." (in PowerShell \$ is no escape, the expansion happens locally)
//   ps-dev-null    win32: 2>/dev/null outside quotes (write 2>$null)
//
// Logs (best effort, <state root>/state/shell-checks/, override OMC_SHELL_CHECKS_LOG_DIR): checks.jsonl has one row per
// checked command, errors.jsonl one row per tool result that shows a known shell error class. The command text is
// logged only for a denial, at most 300 characters, after masking secrets.
//
// The tokenizer documents its token shapes so other hooks can reuse it.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const SHELL_CHECKS_ENV = 'OMC_SHELL_CHECKS';
export const LENGTH_DENY_AT = 7700; // effective length from which a Bash command is denied on Windows
// The Bash tool runs `bash -c "source <snapshot> ... && eval '<command>' < /dev/null && pwd -P >| <cwd file>"`, every ' of the
// command becoming '"'"' (4 more characters). The wrapper measured 451-456 characters with Claude Code 2.1.318 and Git for
// Windows 2.55.0 (printf '%s' "$BASH_EXECUTION_STRING"); it grows with the snapshot and cwd file paths.
export const LENGTH_WRAPPER = 460;
export const APOSTROPHE_EXTRA = 4;
export const LENGTH_CUT_AT = 8190; // where Git Bash cuts the -c argument (measured: 8185 passes, 8195 is cut)
export const TRUNCATION_CAUSE_AT = 7500; // errors.jsonl: an unexpected EOF of a command this long (effective) counts as truncation
export const SYNTAX_TIMEOUT_MS = 1000;
// OMC_SHELL_SYNTAX_TIMEOUT_MS: limit of bash -n in the hook (100-3000 ms, default 1000). a blocked spawnSync cannot be interrupted, and
// pre-tool-enforcer may wait for Jev requests too, so the limit stays small.
export function syntaxTimeoutMs(env = process.env) {
  const value = Number(env.OMC_SHELL_SYNTAX_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 100 && value <= 3000 ? value : SYNTAX_TIMEOUT_MS;
}
// OMC_SHELL_CHECKS_LENGTH_LIMIT: effective length from which the length check denies (1000-100000, default 7700). The wrapper
// size and the cut point belong to the host, so a Claude Code or Git for Windows update may move them.
export function lengthDenyAt(env = process.env) {
  const value = Number(env.OMC_SHELL_CHECKS_LENGTH_LIMIT);
  return Number.isInteger(value) && value >= 1000 && value <= 100000 ? value : LENGTH_DENY_AT;
}
export const SYNTAX_MIN_CHARS = { win32: 200, default: 0 };
export const MAX_NESTING = 64; // deeper $( ${ " ` nesting stops the tokenizer (error too-deep) instead of overflowing the stack
const ARITH_SCAN_MAX = 2000; // longest (( ... )) or $(( ... )) the tokenizer looks for
const ARITH_SCAN_TOTAL = 200000; // all such scans of one text together: a run of thousands of '(' stays cheap
const EXCERPT_CHARS = 300;

export function shellChecksEnabled(env = process.env) {
  return env[SHELL_CHECKS_ENV] === '1';
}

// ---------------------------------------------------------------------------------------------------------------------------
// Bash tokenizer.
// tokenizeBash(src) -> { tokens, heredocs, errors }
//   token: { type: 'word', start, end, parts } | { type: 'op', value, start, end } (value: ';' '&&' '||' '|' '|&' '&' ';;' ';&'
//          ';;&' '(' ')' '\n') | { type: 'redir', value, fd, start, end, target? } (value: '<' '>' '>>' '>|' '<>' '<&' '>&' '&>'
//          '&>>' '<<' '<<-' '<<<'; target: the delimiter word of a here-document) | { type: 'comment', text, start, end }
//          An arithmetic command (( ... )) is a word with one 'arith' part.
//   part:  { kind: 'lit', text, start, end } (unquoted text, backslash escapes kept as written)
//          { kind: 'single', text, start, end, closed }            '...'
//          { kind: 'ansi', text, start, end, closed }              $'...'
//          { kind: 'double', parts, start, end, closed, locale }   "..." or $"..."
//          { kind: 'param', text, start, end, parts?, closed? }    $x, $1, ${...} (parts: nested parts of ${...})
//          { kind: 'cmdsub', tokens, start, end, closed }          $(...)
//          { kind: 'procsub', op, tokens, start, end, closed }     <(...) >(...)
//          { kind: 'arith', text, start, end, closed }             $((...)), $[...], ((...))
//          { kind: 'backtick', text, tokens, start, end, closed }  `...` (tokens of the text after \` \\ \$ unescaping; their
//                                                                  offsets are relative to that unescaped text, not to src)
//          { kind: 'group', text, start, end, closed }             extglob @(...) and array assignment a=(...)
//   heredoc: { delimiter, quoted, strip, start, end, body, terminated, nested, redirStart, parts? } (body = text between the
//          operator line and the closing line, start/end index it in src; parts: expansions of an unquoted body, offsets in src)
//   errors: [{ kind: 'unterminated' | 'too-deep', what?, start }]
// The tokenizer never throws on bad input: unterminated constructs end at the end of the text with closed: false.
// ---------------------------------------------------------------------------------------------------------------------------

const BASH_META = new Set([' ', '\t', '\n', ';', '&', '|', '<', '>', '(', ')']);
const BASH_OPS = ['&&', '||', ';;&', ';;', ';&', '|&', '|', '&', ';', '(', ')'];
const BASH_REDIRS = ['<<<', '<<-', '<<', '&>>', '&>', '>>', '>|', '>&', '<&', '<>', '<', '>'];
const RESERVED_BEFORE_COMMAND = new Set(['then', 'do', 'else', 'elif', '{', '!', 'time', 'if', 'while', 'until']);

class BashLexer {
  constructor(src, level = 0) {
    this.s = String(src ?? '');
    this.n = this.s.length;
    this.i = 0;
    this.errors = [];
    this.heredocs = [];
    this.pending = [];
    this.depth = 0; // inside $( ) or <( ): here-document bodies may end at "EOF)"
    this.level = level; // any nesting, limited by MAX_NESTING
    this.arithBudget = ARITH_SCAN_TOTAL; // characters the (( ... )) scans may still read in this text
  }

  enter() {
    if (this.level >= MAX_NESTING) {
      this.errors.push({ kind: 'too-deep', start: this.i });
      this.i = this.n;
      return false;
    }
    this.level++;
    return true;
  }

  leave() {
    this.level--;
  }

  nested() {
    if (!this.enter()) return { tokens: [], closed: false };
    this.depth++;
    try { return this.list(true); } finally { this.depth--; this.leave(); }
  }

  // A command list until the end of the text or, with untilParen, until the ')' that closes it (not consumed). Subshell
  // parentheses are counted, and inside case ... esac a ')' ends a pattern, so neither closes $( early.
  list(untilParen) {
    const tokens = [];
    let caseDepth = 0;
    let parenDepth = 0;
    const s = this.s;
    while (this.i < this.n) {
      const c = s[this.i];
      if (c === ' ' || c === '\t') { this.i++; continue; }
      if (c === '\\' && s[this.i + 1] === '\n') { this.i += 2; continue; }
      if (c === '\n') {
        tokens.push({ type: 'op', value: '\n', start: this.i, end: this.i + 1 });
        this.i++;
        this.readHeredocBodies();
        continue;
      }
      if (c === '#') {
        const end = s.indexOf('\n', this.i);
        const stop = end < 0 || end > this.n ? this.n : end;
        tokens.push({ type: 'comment', text: s.slice(this.i, stop), start: this.i, end: stop });
        this.i = stop;
        continue;
      }
      if (untilParen && c === ')' && caseDepth <= 0 && parenDepth === 0) return { tokens, closed: true };
      const prev = tokens.length ? tokens[tokens.length - 1] : null;
      const atCommand = !prev || prev.type === 'op' || (prev.type === 'word' && RESERVED_BEFORE_COMMAND.has(wordText(prev)));
      if (c === '(' && s[this.i + 1] === '(' && (atCommand || (prev?.type === 'word' && wordText(prev) === 'for'))) {
        const end = this.arithmeticEnd(this.i + 2);
        if (end > 0) {
          tokens.push({ type: 'word', start: this.i, end, parts: [{ kind: 'arith', text: s.slice(this.i + 2, end - 2), start: this.i, end, closed: true }] });
          this.i = end;
          continue;
        }
      }
      if ((c === '<' || c === '>') && s[this.i + 1] === '(') {
        tokens.push(this.word());
        continue;
      }
      const redir = BASH_REDIRS.find((r) => s.startsWith(r, this.i));
      if (redir) {
        tokens.push(this.redirection(redir, null));
        continue;
      }
      const op = BASH_OPS.find((o) => s.startsWith(o, this.i));
      if (op) {
        if (caseDepth <= 0 && op === '(') parenDepth++;
        else if (caseDepth <= 0 && op === ')' && parenDepth > 0) parenDepth--;
        tokens.push({ type: 'op', value: op, start: this.i, end: this.i + op.length });
        this.i += op.length;
        continue;
      }
      const word = this.word();
      // An all-digit word glued to < or > is the file descriptor of the redirection that follows (2>&1, 3<file).
      if (/^\d+$/.test(s.slice(word.start, word.end)) && (s[this.i] === '<' || s[this.i] === '>')) {
        const r = BASH_REDIRS.find((x) => s.startsWith(x, this.i));
        if (r) { tokens.push(this.redirection(r, s.slice(word.start, word.end), word.start)); continue; }
      }
      const text = wordText(word);
      if (atCommand && text === 'case') caseDepth++;
      else if (atCommand && text === 'esac') caseDepth--;
      tokens.push(word);
    }
    if (untilParen) this.errors.push({ kind: 'unterminated', what: '$(', start: this.i });
    return { tokens, closed: !untilParen };
  }

  redirection(op, fd, start = this.i) {
    this.i += op.length;
    const token = { type: 'redir', value: op, fd, start, end: this.i };
    if (op === '<<' || op === '<<-') {
      while (this.s[this.i] === ' ' || this.s[this.i] === '\t') this.i++;
      if (this.i < this.n && !BASH_META.has(this.s[this.i])) {
        const word = this.word();
        token.target = word;
        token.end = word.end;
        this.pending.push({ delimiter: wordValue(word, this.s), quoted: word.parts.some((p) => p.kind === 'single' || p.kind === 'ansi' || p.kind === 'double') || /\\/.test(this.s.slice(word.start, word.end)), strip: op === '<<-', redirStart: start });
      }
    }
    return token;
  }

  // Bodies of here-documents opened on the line that just ended, in order.
  readHeredocBodies() {
    const s = this.s;
    while (this.pending.length) {
      const h = this.pending.shift();
      const start = this.i;
      let terminated = false;
      let end = this.n;
      let next = this.n;
      let pos = this.i;
      while (pos < this.n) {
        const nl = s.indexOf('\n', pos);
        const lineEnd = nl < 0 || nl > this.n ? this.n : nl;
        const line = s.slice(pos, lineEnd);
        const check = h.strip ? line.replace(/^\t+/, '') : line;
        if (check === h.delimiter || check === `${h.delimiter}\r`) {
          terminated = true;
          end = pos;
          next = lineEnd < this.n ? lineEnd + 1 : this.n;
          break;
        }
        // Inside $(...) bash also ends the body at "EOF)" (with a warning, but the command works): the ')' closes the $(.
        if (this.depth > 0 && h.delimiter && check.startsWith(h.delimiter) && /^[ \t]*\)/.test(check.slice(h.delimiter.length))) {
          terminated = true;
          end = pos;
          next = s.indexOf(')', pos + (line.length - check.length) + h.delimiter.length);
          break;
        }
        pos = lineEnd < this.n ? lineEnd + 1 : this.n;
      }
      const doc = { ...h, start, end, body: s.slice(start, end), terminated, nested: this.depth > 0 };
      if (!h.quoted) doc.parts = this.bodyParts(start, end);
      this.heredocs.push(doc);
      this.i = next;
    }
  }

  // Expansions of an unquoted here-document body (start..end of src), like "..." without the closing quote.
  bodyParts(start, end) {
    const save = { n: this.n, i: this.i, pending: this.pending };
    this.n = end;
    this.i = start;
    this.pending = [];
    try {
      return this.expansions(null);
    } finally {
      this.n = save.n;
      this.i = save.i;
      this.pending = save.pending;
    }
  }

  // Parts of "..." (closing = '"') or of a here-document body (closing = null) from this.i: \ escapes $ ` " \ and newline,
  // $... and `...` expand. Stops after the closing quote (returns closed: true) or at the end of the text.
  expansions(closing) {
    const s = this.s;
    const parts = [];
    let lit = null;
    const flush = (end = this.i) => { if (lit) { lit.end = end; lit.text = s.slice(lit.start, end); parts.push(lit); lit = null; } };
    while (this.i < this.n) {
      const c = s[this.i];
      if (closing && c === closing) {
        flush();
        this.i++;
        parts.closed = true;
        return parts;
      }
      if (c === '\\') { if (!lit) lit = { kind: 'lit', start: this.i }; this.i = Math.min(this.n, this.i + 2); continue; }
      if (c === '`') { flush(); parts.push(this.backtick()); continue; }
      if (c === '$') {
        const at = this.i;
        const p = this.dollar();
        if (p) { flush(at); parts.push(p); continue; }
      }
      if (!lit) lit = { kind: 'lit', start: this.i };
      this.i++;
    }
    flush();
    parts.closed = false;
    return parts;
  }

  // One word (possibly empty when called on a metacharacter that starts a process substitution).
  word() {
    const s = this.s;
    const start = this.i;
    const parts = [];
    let lit = null;
    const flush = (end = this.i) => { if (lit) { lit.end = end; lit.text = s.slice(lit.start, end); parts.push(lit); lit = null; } };
    const addLit = (len) => { if (!lit) lit = { kind: 'lit', start: this.i }; this.i += len; };
    while (this.i < this.n) {
      const c = s[this.i];
      if ((c === '<' || c === '>') && s[this.i + 1] === '(' && this.i === start) {
        flush();
        const p = { kind: 'procsub', op: c + '(', start: this.i };
        this.i += 2;
        const inner = this.nested();
        p.tokens = inner.tokens;
        p.closed = inner.closed && s[this.i] === ')';
        if (p.closed) this.i++;
        p.end = this.i;
        parts.push(p);
        continue;
      }
      if (c === '(' && (lit || parts.length)) {
        const before = s[this.i - 1];
        if ('?*+@!'.includes(before) || before === '=') {
          flush();
          parts.push(this.balancedGroup());
          continue;
        }
      }
      if (BASH_META.has(c)) break;
      if (c === '\\') {
        if (s[this.i + 1] === '\n') { flush(); this.i += 2; continue; }
        addLit(Math.min(2, this.n - this.i));
        continue;
      }
      if (c === "'") { flush(); parts.push(this.single()); continue; }
      if (c === '"') { flush(); parts.push(this.double(false)); continue; }
      if (c === '`') { flush(); parts.push(this.backtick()); continue; }
      if (c === '$') {
        const d = s[this.i + 1];
        if (d === "'") { flush(); parts.push(this.ansi()); continue; }
        if (d === '"') { flush(); this.i++; parts.push(this.double(true)); continue; }
        const at = this.i;
        const p = this.dollar();
        if (p) { flush(at); parts.push(p); continue; }
      }
      addLit(1);
    }
    flush();
    return { type: 'word', start, end: this.i, parts };
  }

  single() {
    const start = this.i;
    const close = this.s.indexOf("'", this.i + 1);
    if (close < 0 || close >= this.n) {
      this.errors.push({ kind: 'unterminated', what: "'", start });
      this.i = this.n;
      return { kind: 'single', text: this.s.slice(start + 1, this.n), start, end: this.n, closed: false };
    }
    this.i = close + 1;
    return { kind: 'single', text: this.s.slice(start + 1, close), start, end: this.i, closed: true };
  }

  ansi() {
    const s = this.s;
    const start = this.i;
    let j = this.i + 2;
    while (j < this.n && s[j] !== "'") j += s[j] === '\\' ? 2 : 1;
    if (j >= this.n) {
      this.errors.push({ kind: 'unterminated', what: "$'", start });
      this.i = this.n;
      return { kind: 'ansi', text: s.slice(start + 2, this.n), start, end: this.n, closed: false };
    }
    this.i = j + 1;
    return { kind: 'ansi', text: s.slice(start + 2, j), start, end: this.i, closed: true };
  }

  backtick() {
    const s = this.s;
    const start = this.i;
    let j = this.i + 1;
    while (j < this.n && s[j] !== '`') j += s[j] === '\\' ? 2 : 1;
    const closed = j < this.n;
    if (!closed) this.errors.push({ kind: 'unterminated', what: '`', start });
    const text = s.slice(start + 1, Math.min(j, this.n));
    this.i = closed ? j + 1 : this.n;
    return { kind: 'backtick', text, tokens: this.subTokens(text.replace(/\\([`\\$])/g, '$1')), start, end: this.i, closed };
  }

  // Tokens of a separate text (the inside of `...`), with the same nesting limit.
  subTokens(text) {
    if (this.level >= MAX_NESTING) {
      this.errors.push({ kind: 'too-deep', start: this.i });
      return [];
    }
    const sub = new BashLexer(text, this.level + 1);
    const { tokens } = sub.list(false);
    for (const e of sub.errors) if (e.kind === 'too-deep') this.errors.push({ kind: 'too-deep', start: this.i });
    return tokens;
  }

  // "..." (this.i at the quote).
  double(locale) {
    const start = locale ? this.i - 1 : this.i;
    if (!this.enter()) return { kind: 'double', parts: [], start, end: this.n, closed: false, locale };
    try {
      this.i++;
      const parts = this.expansions('"');
      const closed = parts.closed;
      delete parts.closed;
      if (!closed) this.errors.push({ kind: 'unterminated', what: '"', start });
      return { kind: 'double', parts, start, end: this.i, closed, locale };
    } finally {
      this.leave();
    }
  }

  // $(...), $((...)), $[...], ${...}, $name, $1, $@ ... at this.i (a '$'); null for a lone '$'.
  dollar() {
    const s = this.s;
    const start = this.i;
    const d = s[this.i + 1];
    if (d === '(') {
      if (s[this.i + 2] === '(') {
        const end = this.arithmeticEnd(this.i + 3);
        if (end > 0) {
          this.i = end;
          return { kind: 'arith', text: s.slice(start + 3, end - 2), start, end, closed: true };
        }
      }
      this.i += 2;
      const inner = this.nested();
      const closed = inner.closed && s[this.i] === ')';
      if (closed) this.i++;
      return { kind: 'cmdsub', tokens: inner.tokens, start, end: this.i, closed };
    }
    if (d === '[') {
      let depth = 0;
      let j = this.i + 2;
      for (; j < this.n; j++) {
        if (s[j] === '[') depth++;
        else if (s[j] === ']') { if (depth === 0) break; depth--; }
      }
      const closed = j < this.n;
      if (!closed) this.errors.push({ kind: 'unterminated', what: '$[', start });
      this.i = closed ? j + 1 : this.n;
      return { kind: 'arith', text: s.slice(start + 2, Math.min(j, this.n)), start, end: this.i, closed };
    }
    if (d === '{') return this.brace();
    if (d !== undefined && /[A-Za-z_]/.test(d)) {
      let j = this.i + 2;
      while (j < this.n && /[A-Za-z0-9_]/.test(s[j])) j++;
      this.i = j;
      return { kind: 'param', text: s.slice(start, j), start, end: j };
    }
    if (d !== undefined && /[0-9@*#?$!-]/.test(d)) {
      this.i += 2;
      return { kind: 'param', text: s.slice(start, this.i), start, end: this.i };
    }
    return null;
  }

  // End index (after '))') of an arithmetic expression whose text starts at from, or -1 when the (( are two subshells. The scan
  // stops after ARITH_SCAN_MAX characters (no real expression is that long), so a run of thousands of '(' stays linear.
  arithmeticEnd(from) {
    let depth = 0;
    const stop = Math.min(this.n, from + ARITH_SCAN_MAX, from + this.arithBudget);
    this.arithBudget -= Math.max(0, stop - from);
    for (let j = from; j < stop; j++) {
      const c = this.s[j];
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) return this.s[j + 1] === ')' ? j + 2 : -1;
        depth--;
      }
    }
    return -1;
  }

  // ${...} with nested quotes and expansions; this.i at '$'.
  brace() {
    const s = this.s;
    const start = this.i;
    if (!this.enter()) return { kind: 'param', text: s.slice(start, this.n), start, end: this.n, parts: [], closed: false };
    try {
      this.i += 2;
      const parts = [];
      let lit = null;
      const flush = (end = this.i) => { if (lit) { lit.end = end; lit.text = s.slice(lit.start, end); parts.push(lit); lit = null; } };
      while (this.i < this.n) {
        const c = s[this.i];
        if (c === '}') {
          flush();
          this.i++;
          return { kind: 'param', text: s.slice(start, this.i), start, end: this.i, parts, closed: true };
        }
        if (c === '\\') { if (!lit) lit = { kind: 'lit', start: this.i }; this.i = Math.min(this.n, this.i + 2); continue; }
        if (c === "'") { flush(); parts.push(this.single()); continue; }
        if (c === '"') { flush(); parts.push(this.double(false)); continue; }
        if (c === '`') { flush(); parts.push(this.backtick()); continue; }
        if (c === '$') {
          if (s[this.i + 1] === "'") { flush(); parts.push(this.ansi()); continue; }
          const at = this.i;
          const p = this.dollar();
          if (p) { flush(at); parts.push(p); continue; }
        }
        if (!lit) lit = { kind: 'lit', start: this.i };
        this.i++;
      }
      flush();
      this.errors.push({ kind: 'unterminated', what: '${', start });
      return { kind: 'param', text: s.slice(start, this.n), start, end: this.n, parts, closed: false };
    } finally {
      this.leave();
    }
  }

  // (...) glued to a word: extglob pattern or array assignment; quotes inside are skipped as units.
  balancedGroup() {
    const s = this.s;
    const start = this.i;
    let depth = 0;
    let j = this.i;
    while (j < this.n) {
      const c = s[j];
      if (c === '\\') { j += 2; continue; }
      if (c === "'") { const k = s.indexOf("'", j + 1); j = k < 0 || k >= this.n ? this.n : k + 1; continue; }
      if (c === '"') { const save = this.i; this.i = j; this.double(false); j = this.i; this.i = save; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { j++; break; } }
      j++;
    }
    const closed = depth === 0;
    this.i = Math.min(j, this.n);
    if (!closed) this.errors.push({ kind: 'unterminated', what: '(', start });
    return { kind: 'group', text: s.slice(start, this.i), start, end: this.i, closed };
  }
}

// Unquoted literal text of a word, with \u0000 in place of every quoted or expanded part (for reserved words like case, for).
export function wordText(word) {
  return word.parts.map((p) => (p.kind === 'lit' ? p.text : '\u0000')).join('');
}

// Text of a word after quote removal. Expansions give '' unless src (the text the word was cut from) is passed, which keeps them
// as written: a here-document delimiter is taken literally ($EOF is the delimiter "$EOF"). Command names need no src.
export function wordValue(word, src) {
  const written = (q) => (src === undefined ? '' : src.slice(q.start, q.end));
  return word.parts.map((p) => {
    if (p.kind === 'lit') return p.text.replace(/\\(.)/gs, '$1');
    if (p.kind === 'single' || p.kind === 'ansi') return p.text;
    if (p.kind === 'double') return p.parts.map((q) => (q.kind === 'lit' ? q.text.replace(/\\([$`"\\\n])/g, '$1') : written(q))).join('');
    return written(p);
  }).join('');
}

export function tokenizeBash(src) {
  const lexer = new BashLexer(src);
  const { tokens } = lexer.list(false);
  if (lexer.pending.length) {
    // Here-documents opened on the last line with no newline after it: no body, never terminated.
    for (const h of lexer.pending) lexer.heredocs.push({ ...h, start: lexer.n, end: lexer.n, body: '', terminated: false, nested: false });
    lexer.pending = [];
  }
  return { tokens, heredocs: lexer.heredocs, errors: lexer.errors };
}

// Calls fn(part, ancestors) for every part of every word in the token list, depth first. ancestors: parts that contain it.
export function walkBashParts(tokens, fn, ancestors = []) {
  for (const t of tokens) {
    if (t.type === 'word') walkParts(t.parts, fn, ancestors);
    else if (t.type === 'redir' && t.target) walkParts(t.target.parts, fn, ancestors);
  }
}

export function walkParts(parts, fn, ancestors = []) {
  for (const p of parts) {
    fn(p, ancestors);
    const inner = [...ancestors, p];
    if (p.parts) walkParts(p.parts, fn, inner);
    if (p.tokens) walkBashParts(p.tokens, fn, inner);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Git Bash on Windows: the command text as bash really sees it, and the parser bug of bash 5.3.15.
// ---------------------------------------------------------------------------------------------------------------------------

// Runs of backslashes: [{ index, length, beforeQuote }], one linear pass.
function backslashRuns(text) {
  const runs = [];
  let i = text.indexOf('\\');
  while (i >= 0) {
    let j = i;
    while (j < text.length && text[j] === '\\') j++;
    runs.push({ index: i, length: j - i, beforeQuote: text[j] === '"' });
    i = text.indexOf('\\', j);
  }
  return runs;
}

// Git Bash started from a Windows process halves every run of backslashes that is not directly before '"' (1->1, 2->1, 3->2,
// 4->2, 5->3; runs before '"' stay). Measured with the sentinels of tests/integration/shell-checks.test.ts.
export function gitBashHalved(command) {
  const text = String(command);
  const out = [];
  let from = 0;
  for (const run of backslashRuns(text)) {
    if (run.beforeQuote) continue;
    out.push(text.slice(from, run.index), '\\'.repeat(Math.ceil(run.length / 2)));
    from = run.index + run.length;
  }
  out.push(text.slice(from));
  return out.join('');
}

// Runs of two or more backslashes that Git Bash halves: [{ index, length }].
export function halvedBackslashRuns(command) {
  return backslashRuns(String(command)).filter((r) => r.length >= 2 && !r.beforeQuote).map(({ index, length }) => ({ index, length }));
}

// Effective length for the Git Bash cut: the -c argument the Bash tool builds (see LENGTH_WRAPPER).
export function effectiveBashLength(command) {
  const text = String(command);
  const apostrophes = text.split("'").length - 1;
  return { chars: text.length, apostrophes, effective: text.length + APOSTROPHE_EXTRA * apostrophes + LENGTH_WRAPPER };
}

// Whether the text of $'...' has an escape that produces a carriage return (13): \r, \15, \015, \x0d, \u000d, \U0000000D, \cM.
export function ansiProducesCarriageReturn(text) {
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') continue;
    const c = s[i + 1];
    let value = null;
    let skip = 1;
    if (c === 'r') value = 13;
    else if (c !== undefined && /[0-7]/.test(c)) {
      const m = /^[0-7]{1,3}/.exec(s.slice(i + 1, i + 4));
      value = parseInt(m[0], 8);
      skip = m[0].length;
    } else if (c === 'x' || c === 'u' || c === 'U') {
      const max = c === 'x' ? 2 : c === 'u' ? 4 : 8;
      const m = new RegExp(`^[0-9a-fA-F]{1,${max}}`).exec(s.slice(i + 2, i + 2 + max));
      if (m) { value = parseInt(m[0], 16); skip = 1 + m[0].length; }
    } else if (c === 'c' && s[i + 2] !== undefined) {
      value = s.charCodeAt(i + 2) & 0x1f;
      skip = 2;
    }
    if (value === 13) return true;
    i += skip;
  }
  return false;
}

// bash 5.3.15 (Git for Windows 2.55.0.windows.3) fails with "unexpected EOF while looking for matching `)'" when one top-level
// double-quoted string has, after a $(...), a later $(...) or ${...} holding a CR-producing $'...' (measured with Git for Windows 2.55.0: "$(a)
// $(b $'\r')" and "$(a) ${l%$'\r'}" fail; "$(b $'\r') $(a)", "${l%$'\r'} $(a)" and "$l ${l%$'\r'}" pass; \t \n \e pass, \015 \x0d
// \cM \u000d fail; two separate "..." pass; backticks pass; the pattern nested inside a $(...) passes; a newline between the
// previous $(...) and the CR part passes). Returns the offending part ({ start, end }) or null. bash -n does not see it. Checked on 417 real commands
// containing $'\: all 22 that failed were found, none of the 395 that passed was flagged.
export function findCrParserBug(command, tokenized = tokenizeBash(command)) {
  const text = String(command ?? '');
  let found = null;
  const hasCr = (unit) => {
    let cr = false;
    const visit = (q) => { if (q.kind === 'ansi' && ansiProducesCarriageReturn(q.text)) cr = true; };
    if (unit.kind === 'cmdsub') walkBashParts(unit.tokens, visit);
    else walkParts(unit.parts || [], visit);
    return cr;
  };
  const visitDouble = (dq) => {
    const units = [];
    const collect = (parts) => {
      for (const p of parts) {
        if (p.kind === 'cmdsub') units.push(p);
        else if (p.kind === 'param' && p.parts) { units.push(p); collect(p.parts); }
      }
    };
    collect(dq.parts);
    for (const unit of units) {
      if (found) return;
      if (!hasCr(unit)) continue;
      let previous = null;
      for (const v of units) if (v.kind === 'cmdsub' && v.end <= unit.start && (!previous || v.end > previous.end)) previous = v;
      if (!previous || text.slice(previous.end, unit.start).includes('\n')) continue;
      found = { start: unit.start, end: unit.end };
    }
  };
  // Only double-quoted strings that are not inside a command substitution, backtick or process substitution.
  const scan = (list) => {
    for (const p of list) {
      if (found) return;
      if (p.kind === 'double') visitDouble(p);
      else if (p.kind === 'param' && p.parts) scan(p.parts);
    }
  };
  for (const t of tokenized.tokens) {
    if (found) break;
    if (t.type === 'word') scan(t.parts);
    else if (t.type === 'redir' && t.target) scan(t.target.parts);
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------------
// PowerShell tokenizer (enough to tell code from strings and comments).
// tokenizePowerShell(src) -> [{ kind: 'code' | 'single' | 'double' | 'here-single' | 'here-double' | 'comment', text, start, end,
//   closed }]. In "..." and @"..."@ a $(...) subexpression may hold its own quotes; it stays inside the double segment.
// ---------------------------------------------------------------------------------------------------------------------------

export function tokenizePowerShell(src) {
  const s = String(src ?? '');
  const n = s.length;
  const segs = [];
  let i = 0;
  let codeStart = 0;
  const flushCode = (end) => { if (end > codeStart) segs.push({ kind: 'code', text: s.slice(codeStart, end), start: codeStart, end, closed: true }); };
  const push = (kind, start, end, closed) => { segs.push({ kind, text: s.slice(start, end), start, end, closed }); i = end; codeStart = end; };
  // End index of a "..." whose opening quote is at j (handles `x escapes, "" and nested $(...)), -1 when unclosed.
  const doubleEnd = (j, level = 0) => {
    let k = j + 1;
    while (k < n) {
      const c = s[k];
      if (c === '`') { k += 2; continue; }
      if (c === '"') { if (s[k + 1] === '"') { k += 2; continue; } return k + 1; }
      if (c === '$' && s[k + 1] === '(') { k = subexprEnd(k + 2, level + 1); continue; }
      k++;
    }
    return -1;
  };
  // End index (after ')') of code starting at j inside $( ... ).
  const subexprEnd = (j, level) => {
    if (level > MAX_NESTING) return n;
    let depth = 0;
    let k = j;
    while (k < n) {
      const c = s[k];
      if (c === '`') { k += 2; continue; }
      if (c === "'") { const e = s.indexOf("'", k + 1); k = e < 0 ? n : e + 1; continue; }
      if (c === '"') { const e = doubleEnd(k, level); k = e < 0 ? n : e; continue; }
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) return k + 1; depth--; }
      k++;
    }
    return n;
  };
  while (i < n) {
    const c = s[i];
    if (c === '`') { i += 2; continue; }
    if (c === '@' && (s[i + 1] === "'" || s[i + 1] === '"') && /^[ \t]*\r?\n/.test(s.slice(i + 2, i + 64))) {
      flushCode(i);
      const quote = s[i + 1];
      const close = s.indexOf(`\n${quote}@`, i + 2);
      push(quote === "'" ? 'here-single' : 'here-double', i, close >= 0 ? close + 3 : n, close >= 0);
      continue;
    }
    if (c === "'") {
      flushCode(i);
      let k = i + 1;
      while (k < n) { if (s[k] === "'") { if (s[k + 1] === "'") { k += 2; continue; } break; } k++; }
      push('single', i, k < n ? k + 1 : n, k < n);
      continue;
    }
    if (c === '"') {
      flushCode(i);
      const e = doubleEnd(i);
      push('double', i, e < 0 ? n : e, e >= 0);
      continue;
    }
    if (c === '<' && s[i + 1] === '#') {
      flushCode(i);
      const e = s.indexOf('#>', i + 2);
      push('comment', i, e < 0 ? n : e + 2, e >= 0);
      continue;
    }
    if (c === '#' && (i === 0 || /[\s;|&(]/.test(s[i - 1]))) {
      flushCode(i);
      const e = s.indexOf('\n', i);
      push('comment', i, e < 0 ? n : e, true);
      continue;
    }
    i++;
  }
  flushCode(n);
  return segs;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Checks.
// ---------------------------------------------------------------------------------------------------------------------------

const groupDigits = (x) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const oneLine = (text, max = 80) => {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
};

let bashPathCache;
// Bash for the syntax check. Windows: Git for Windows usr\bin\bash.exe (the bin\bash.exe launcher is about twice as slow),
// never the bash.exe of WSL from PATH. Linux: /bin/bash or /usr/bin/bash. macOS: only a Homebrew bash (/bin/bash 3.2 rejects bash 4
// syntax such as ;& or |&). null when none is found (check skipped).
export function findBashForSyntax(platform = process.platform, env = process.env) {
  if (bashPathCache !== undefined && platform === process.platform && env === process.env) return bashPathCache;
  const candidates = [];
  if (platform === 'win32') {
    if (env.CLAUDE_CODE_GIT_BASH_PATH) candidates.push(join(dirname(dirname(env.CLAUDE_CODE_GIT_BASH_PATH)), 'usr', 'bin', 'bash.exe'), env.CLAUDE_CODE_GIT_BASH_PATH);
    for (const root of [env.ProgramFiles, env.ProgramW6432, 'C:\\Program Files', env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')]) {
      if (root) candidates.push(join(root, 'Git', 'usr', 'bin', 'bash.exe'), join(root, 'Git', 'bin', 'bash.exe'));
    }
  } else if (platform === 'darwin') {
    candidates.push('/opt/homebrew/bin/bash', '/usr/local/bin/bash');
  } else {
    candidates.push('/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash');
  }
  const found = candidates.find((p) => { try { return existsSync(p); } catch { return false; } }) ?? null;
  if (platform === process.platform && env === process.env) bashPathCache = found;
  return found;
}

// bash -n with the command on stdin (stdin is not cut). Returns { ran, code, stderr, timedOut, ms, syntaxError, heredocWarning }.
// syntaxError only for exit 2 with a parser message: a crashed bash (MSYS2 fatal error, 0xC0000142 under load) is not a verdict.
export function bashSyntaxCheck(text, { platform = process.platform, env = process.env, timeoutMs = SYNTAX_TIMEOUT_MS, bashPath } = {}) {
  const bash = bashPath ?? findBashForSyntax(platform, env);
  if (!bash) return { ran: false, reason: platform === 'darwin' ? 'old-bash' : 'no-bash' };
  const started = process.hrtime.bigint();
  const childEnv = { ...env, LC_ALL: 'C', LANG: 'C' };
  delete childEnv.BASH_ENV;
  delete childEnv.ENV;
  // extglob is on so that a script that turns it on itself (shopt -s extglob on an earlier line) is not rejected; the Bash tool
  // turns it off before eval, so extglob syntax on the first line is a false negative here, never a false denial.
  const r = spawnSync(bash, ['--norc', '--noprofile', '-O', 'extglob', '-n'], { input: text, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, env: childEnv, maxBuffer: 1024 * 1024 });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (r.error && r.error.code === 'ETIMEDOUT') return { ran: true, timedOut: true, ms };
  // EPIPE with an exit status: bash exited before reading all of the input. It still ran, so its
  // status decides below (a crashed bash is a bash-failure, not a missing check).
  if (r.error && !(r.error.code === 'EPIPE' && r.status !== null)) return { ran: false, reason: String(r.error.code || r.error.message), ms };
  if (r.status === null) return { ran: true, timedOut: true, ms };
  const stderr = String(r.stderr || '');
  const heredoc = /warning: here-document at line \d+ delimited by end-of-file \(wanted `([^']*)'\)/.exec(stderr);
  const syntaxError = r.status === 2 && /syntax error|unexpected EOF|unexpected end of file/.test(stderr);
  return { ran: true, code: r.status, stderr, ms, syntaxError, ...(r.status !== 0 && !syntaxError ? { reason: 'bash-failure' } : {}), heredocWarning: heredoc ? heredoc[0] : null, heredocWanted: heredoc ? heredoc[1] : null };
}

const cleanBashMessage = (stderr) => stderr.split('\n').map((l) => l.trim()).filter(Boolean)
  .map((l) => l.replace(/^(?:\/[^:]*\/)?bash(?:\.exe)?: /, '')).slice(0, 3).join(' | ');

function syntaxHint(command, message) {
  const hints = [];
  if (/matching `\`'/.test(message)) hints.push('a backtick inside "..." (for example in git commit -m) opens a command substitution: pass the message with git commit -F <file> or in single quotes, or escape the backtick with a backslash');
  if (/matching `"'/.test(message) && /[A-Za-z]:\\[^"\n]*\\"/.test(command)) hints.push('a Windows path ends with a backslash right before the closing " (\\" is a literal quote, not the end of the string): drop the trailing backslash or write the path with forward slashes');
  if (/matching `''/.test(message) && /\b(ssh|powershell(?:\.exe)?|pwsh|bash -c|sh -c)\b/.test(command)) hints.push("an apostrophe inside '...' ends the string: for ssh or powershell, upload the script as a file or pipe it on stdin (ssh host 'bash -s' < file) instead of nesting quotes");
  if (/matching `"'/.test(message) && /\bpython[0-9.]*(?:\.exe)?"?\s+(?:-X\s+\S+\s+)?-c\s+"/.test(command)) hints.push('python -c "..." with a " in the code: write the code to a file and run it, or pipe it on stdin');
  return hints.join('; ');
}

function commandExcerpt(command, start, end) {
  const from = Math.max(0, start - 10);
  return oneLine(String(command).slice(from, Math.min(String(command).length, end + 10)), 120);
}

// A here-document delimiter the tokenizer alone may trust: quoted, or a plain name (EOF, PY). Without bash -n an unquoted digit
// after << is far more often a shift (( n = 1 << 3 )) than a here-document.
const delimiterLooksReal = (h) => h.quoted || /^[A-Za-z_][A-Za-z0-9_]*$/.test(h.delimiter);

// All checks for one Bash command. Returns { decision: 'allow' | 'deny', reason, context, checks, length, syntax }.
// timeoutMs: limit of bash -n; the hook passes syntaxTimeoutMs(env) (OMC_SHELL_SYNTAX_TIMEOUT_MS, default 1 s).
export function checkBashCommand(command, { platform = process.platform, env = process.env, syntax = true, bashPath, timeoutMs = SYNTAX_TIMEOUT_MS } = {}) {
  const text = String(command ?? '');
  const win = platform === 'win32';
  const checks = [];
  const denials = [];
  const warnings = [];
  const length = effectiveBashLength(text);
  let syntaxResult = { ran: false, reason: 'not-needed' };

  const denyAt = lengthDenyAt(env);
  if (win && length.effective >= denyAt) {
    checks.push('length');
    denials.push(`The command has ${groupDigits(length.chars)} characters (${groupDigits(length.effective)} effective: the Bash tool turns each of the ${groupDigits(length.apostrophes)} apostrophes into '"'"' and adds about ${LENGTH_WRAPPER} characters of wrapper), and Git Bash on Windows cuts the command after about ${groupDigits(LENGTH_CUT_AT)} characters, so its tail would be lost (usually "unexpected EOF" or a silently shortened here-document, sometimes only part of the command runs). Write the script to a file (for example with the Write tool) and run it with one short command such as bash script.sh, or pass the script to bash on stdin. Without a file tool, split the command into several calls below 7 000 effective characters, for example appending the file in parts with cat >> file <<'EOF'. Denial threshold: ${groupDigits(denyAt)} effective characters.`);
  }

  const halved = win ? gitBashHalved(text) : text;
  const runs = win ? halvedBackslashRuns(text) : [];
  if (runs.length) {
    checks.push('backslash');
    const first = runs[0];
    warnings.push(`Git Bash on Windows halves runs of backslashes in the command text (\\\\ becomes \\; here ${runs.length} ${runs.length === 1 ? 'place' : 'places'}, first: "${commandExcerpt(text, first.index, first.index + first.length)}"), also inside '...' and inside a <<'EOF' here-document; only backslashes directly before " are kept. Write paths with forward slashes, and put code that needs backslashes (Python, regular expressions, printf) in a file. Check the output for a changed meaning.`);
  }

  if (!denials.length) {
    const tokenized = tokenizeBash(halved);
    if (win) {
      const bug = findCrParserBug(halved, tokenized);
      if (bug) {
        checks.push('cr-parser');
        denials.push(`Parser bug of bash 5.3 in Git Bash: in one "..." string, a $(...) or \${...} holding $'\\r' (a carriage return) after another $(...) fails with "unexpected EOF while looking for matching )" (at: "${commandExcerpt(halved, bug.start, Math.min(bug.end, bug.start + 60))}"); bash -n does not see it. Alternatives: grep -c -P '\\r$' file, tr -cd '\\r' < file | wc -c, or CR=$'\\r' in a separate statement and "$CR" inside the substitutions (or put each substitution in its own "...").`);
      }
    }
    const minChars = SYNTAX_MIN_CHARS[platform] ?? SYNTAX_MIN_CHARS.default;
    const needsSyntax = syntax && !denials.length && /["'`]|<</.test(halved) && halved.length > minChars;
    if (needsSyntax) syntaxResult = bashSyntaxCheck(halved, { platform, env, bashPath, timeoutMs });
    // Trusted: bash answered in time, either with 0 or with a real parser error (a crashed bash says nothing about the command).
    const trusted = syntaxResult.ran && !syntaxResult.timedOut && (syntaxResult.code === 0 || syntaxResult.syntaxError);
    const unterminated = tokenized.heredocs.find((h) => !h.terminated && (trusted || delimiterLooksReal(h)));
    if (trusted && syntaxResult.syntaxError) {
      checks.push('syntax');
      const message = cleanBashMessage(syntaxResult.stderr) || `exit code ${syntaxResult.code}`;
      const hint = syntaxHint(halved, message);
      const halvingNote = runs.length ? ' Note: the text checked is the command after Git Bash halves backslashes, because that is the text bash will see.' : '';
      denials.push(`bash -n rejects the command: ${message}.${hint ? ` Likely cause: ${hint}.` : ''} Check that every ', " and \` is closed; write longer or nested code to a file and run it with a short command.${halvingNote}`);
    } else if (!denials.length && unterminated && (!trusted || syntaxResult.heredocWarning)) {
      // bash -n exits 0 on a here-document without its closing line and only warns. The warning alone is not enough ("EOF)"
      // inside $(...) warns but works), so the tokenizer must agree; without a trusted bash -n (short command on Windows, no
      // bash, timeout, crash) the tokenizer decides alone, and only for a delimiter that looks like one.
      checks.push('heredoc');
      denials.push(heredocMessage(unterminated.delimiter));
    }
  }

  const decision = denials.length ? 'deny' : 'allow';
  const context = warnings.map((w) => `[SHELL CHECK] ${w}`).join('\n');
  const reason = denials.length ? [...denials, ...warnings].map((d) => `[SHELL CHECK] ${d}`).join('\n') : '';
  return { decision, reason, context: decision === 'deny' ? '' : context, checks, length, syntax: syntaxResult };
}

function heredocMessage(delimiter) {
  return `The here-document <<${delimiter} has no closing line "${delimiter}" (bash: here-document delimited by end-of-file), so the rest of the command would become its body. The closing line must hold only the delimiter, from the start of the line (with <<- only tabs may precede it) and without trailing spaces; write a long here-document to a file instead.`;
}

const SSH_NAME = /(?:^|[\\/])ssh(?:\.exe)?$/i;

// Checks for one PowerShell command (warnings only).
export function checkPowerShellCommand(command, { platform = process.platform } = {}) {
  const text = String(command ?? '');
  const segs = tokenizePowerShell(text);
  const code = segs.filter((s) => s.kind === 'code').map((s) => s.text).join(' ');
  const checks = [];
  const warnings = [];
  // ssh by name in code, or a quoted path to ssh(.exe) called with & ("& 'C:\...\ssh.exe' host ...").
  const sshInCode = /(?:^|[\s;|&({])(?:[^\s'"]*[\\/])?ssh(?:\.exe)?(?=\s|$)/i.test(code);
  const sshCalled = segs.some((s, k) => (s.kind === 'single' || s.kind === 'double') && SSH_NAME.test(s.text.slice(1, -1)) && k > 0 && segs[k - 1].kind === 'code' && /&\s*$/.test(segs[k - 1].text));
  if ((sshInCode || sshCalled) && segs.some((s) => (s.kind === 'double' || s.kind === 'here-double') && s.text.includes('\\$'))) {
    checks.push('ps-ssh-dollar');
    warnings.push("In PowerShell \\$ is not an escape: inside \"...\" PowerShell still expands $(...) and $variable locally before ssh sends the command. Write the remote command in single quotes '...' (double an apostrophe inside: '') or in a here-string @'...'@, and build any value from PowerShell beforehand ($cmd = 'echo ' + $x).");
  }
  if (platform === 'win32' && /(?:\d|\*)?>{1,2}\s*\/dev\/null(?![\w/])/.test(code)) {
    checks.push('ps-dev-null');
    warnings.push('In PowerShell on Windows 2>/dev/null writes to the file C:\\dev\\null and fails with an Out-File error ("Could not find a part of the path"); write 2>$null or pipe to Out-Null.');
  }
  return { decision: 'allow', reason: '', context: warnings.map((w) => `[SHELL CHECK] ${w}`).join('\n'), checks };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Logs: checks.jsonl (one row per checked command) and errors.jsonl (error classes of tool results), in
// OMC_SHELL_CHECKS_LOG_DIR, else the logDir the hook passes (<state root>/state/shell-checks), else ~/.omc/state/shell-checks.
// A file above 50 MB is renamed to <name>-<YYYYMMDD-HHmmss>.jsonl (UTC) before the next append; the newest two renamed
// files are kept, older ones are deleted. The command text goes to the
// log only with a denial: at most 300 characters, after masking secrets.
// ---------------------------------------------------------------------------------------------------------------------------

export const LOG_MAX_BYTES = 50 * 1024 * 1024;
const ROTATED_KEPT = 2;

export function shellLogDir(env = process.env, logDir) {
  return env.OMC_SHELL_CHECKS_LOG_DIR || logDir || join(homedir(), '.omc', 'state', 'shell-checks');
}

function rotateLog(path, now = new Date()) {
  try {
    if (statSync(path).size <= LOG_MAX_BYTES) return;
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
    const target = path.replace(/\.jsonl$/, '') + '-' + stamp + '.jsonl';
    if (!existsSync(target)) renameSync(path, target);
    const base = path.replace(/\.jsonl$/, '');
    const dir = dirname(path);
    const prefix = base.slice(dir.length + 1) + '-';
    const rotated = readdirSync(dir).filter((f) => f.startsWith(prefix) && /^-\d{8}-\d{6}\.jsonl$/.test(f.slice(prefix.length - 1))).sort();
    for (const old of rotated.slice(0, -ROTATED_KEPT)) unlinkSync(join(dir, old));
  } catch { /* missing file or a lost rename race: the append goes on */ }
}

export function appendShellLog(name, row, { env = process.env, logDir } = {}) {
  try {
    const dir = shellLogDir(env, logDir);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    rotateLog(path);
    appendFileSync(path, JSON.stringify(row) + '\n', 'utf8');
  } catch { /* logging never breaks the hook */ }
}

// Identifiers that tie a row to a session, a tool call, a subagent (agent_id and agent_type are set only for a call made
// inside one) and a prompt. The field and input names mirror jevLogContextOf in jev-resolve.mjs, which this module does
// not import so that it stays self-contained.
function logContextOf(data) {
  const context = {};
  for (const [key, names] of [['session_id', ['session_id', 'sessionId']], ['tool_use_id', ['tool_use_id', 'toolUseId']], ['cwd', ['cwd', 'directory']], ['agent_id', ['agent_id', 'agentId']], ['agent_type', ['agent_type', 'agentType']], ['prompt_id', ['prompt_id', 'promptId']]]) {
    const value = names.map((name) => data?.[name]).find((candidate) => typeof candidate === 'string' && candidate !== '');
    if (value !== undefined) context[key] = value.slice(0, 1000);
  }
  return context;
}

// The rules of scripts/lib/jev-mask.mjs (copied, so that this module stays self-contained), in time linear in the text
// length; the comments there say why the mysql, JWT and KEY= rules have their shape.
export function maskSecrets(text) {
  return String(text ?? '')
    .replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '$1***')
    .replace(/(\/\/[^/\s:@]+:)[^/\s@]+@/g, '$1***@')
    .replace(/((?:authorization|proxy-authorization)\s*:\s*(?:(?:bearer|basic|token)\s*)?)[^\s"']+/gi, '$1***')
    .replace(/((?:set-)?cookie\s*:\s*)[^\r\n"']+/gi, '$1***')
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(/((?:^|\s)(?:-u|--user)(?:\s+|=)["']?[^\s:"']+:)[^\s"']+/g, '$1***')
    .replace(/((?:^|\s)--(?:password|passwd|pass|token|secret|api-key|apikey|access-token|auth-token|client-secret)(?:\s+|=)["']?)[^\s"']+/gi, '$1***')
    .replace(/(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n|;&]*?)(?:(\s-p)[^\s"']+|(?=[\n|;&]|$))/g, (whole, head, flag) =>
      flag ? head + flag + '***' : whole)
    .replace(/(\bsshpass\s+-p\s*["']?)[^\s"']+/g, '$1***')
    .replace(/\b(sk-(?:ant-|proj-)?)[A-Za-z0-9_-]{12,}/g, '$1***')
    .replace(/\b(gh[pousr]_|github_pat_|glpat-|xox[abprs]-)[A-Za-z0-9_-]{10,}/g, '$1***')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***')
    .replace(/\beyJ(?:[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]*)/g, (m) => m.includes('.') ? 'eyJ***' : m)
    .replace(/(\b(?=[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?))[A-Za-z0-9_]+\b["'\]]*\s*[=:]\s*["']?)[^\s"'&;|)]+/gi, '$1***')
    .replace(/((?:api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|password|passwd|token|secret|has[łl]o|klucz|sekret|passwort|kennwort|contrase[ñn]a)(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)(?:(?<=\\")(?:[^\\\n]|\\(?!"))*(?=\\")|(?<=")(?:[^"\\\n]|\\.)*(?=")|(?<=')(?:[^'\\\n]|\\.|'')*(?=')|[^\s"'&;|,}]+)/gi, '$1***')
    .replace(/(?<![A-Za-z0-9+_-])(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{32,}={0,2}/g, '***');
}

const excerptForLog = (text) => maskSecrets(text).slice(0, EXCERPT_CHARS);

// The hook entry point: checks for a Bash or PowerShell call (data = hook input), one checks.jsonl row. Returns the verdict.
export function runShellChecks(toolName, data, { platform = process.platform, env = process.env, logDir } = {}) {
  const started = process.hrtime.bigint();
  const input = data?.tool_input || data?.toolInput || {};
  const command = typeof input.command === 'string' ? input.command : '';
  if (!command) return { decision: 'allow', reason: '', context: '', checks: [] };
  const verdict = toolName === 'Bash' ? checkBashCommand(command, { platform, env, timeoutMs: syntaxTimeoutMs(env) }) : checkPowerShellCommand(command, { platform });
  const durationMs = Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10;
  const row = {
    ts: new Date().toISOString(),
    point: 'shell-check',
    ...logContextOf(data || {}),
    tool_name: toolName,
    platform,
    decision: verdict.decision === 'deny' ? 'deny' : verdict.context ? 'warn' : 'allow',
    checks: verdict.checks,
    chars: command.length,
    durationMs,
  };
  if (verdict.length) row.effective_chars = verdict.length.effective;
  const sx = verdict.syntax;
  if (sx && (sx.ran || sx.reason !== 'not-needed')) {
    row.syntax = { ran: sx.ran, ...(sx.ms !== undefined ? { ms: Math.round(sx.ms) } : {}), ...(sx.code !== undefined ? { code: sx.code } : {}), ...(sx.timedOut ? { timedOut: true } : {}), ...(sx.reason ? { reason: sx.reason } : {}) };
  }
  if (verdict.decision === 'deny') {
    row.reason = excerptForLog(verdict.reason);
    row.command = excerptForLog(command);
  }
  appendShellLog('checks.jsonl', row, { env, logDir });
  return verdict;
}

// Error classes in a tool result (Bash, PowerShell). Patterns are anchored to the start of a line, so a grep of a log that
// merely lists these words does not count. Returns [{ class, match }].
const ERROR_CLASSES = [
  ['unexpected-eof', /^(?:[A-Za-z]:)?[^\s"'`:]*(?:bash|sh|eval)(?:\.exe)?: (?:[^\n]{0,200}?: )?line \d+: unexpected EOF while looking for matching [^\n]*/m],
  ['heredoc-eof', /^(?:[A-Za-z]:)?[^\s"'`:]*(?:bash|sh)(?:\.exe)?: (?:[^\n]{0,200}?: )?line \d+: warning: here-document at line \d+ delimited by end-of-file[^\n]*/m],
  ['enametoolong', /\b(?:spawn ENAMETOOLONG|ENAMETOOLONG: name too long)[^\n]*/m],
  ['python-invalid-escape', /^[^\n]{0,300}?:\d+: SyntaxWarning: [^\n]*invalid escape sequence[^\n]*/m],
  ['win-path-not-found', /^(?:[A-Za-z]:)?[^\s"'`:]*(?:bash|sh)(?:\.exe)?: (?:[^\n]{0,200}?: )?(?:line \d+: )?[A-Za-z]:[^\s/\\:][^\s:]*: (?:command not found|No such file or directory)[^\n]*/m],
  ['ps-missing-terminator', /^[^\n]{0,200}The string is missing the terminator[^\n]*/m],
  ['ps-dev-null', /Could not find a part of the path '[A-Za-z]:\\dev\\null'[^\n]*/m],
];

export function classifyToolErrors(texts) {
  const text = texts.filter((t) => typeof t === 'string' && t).join('\n');
  const found = [];
  for (const [name, re] of ERROR_CLASSES) {
    const m = re.exec(text);
    if (m) found.push({ class: name, match: oneLine(maskSecrets(m[0]), 200) });
  }
  return found;
}

function toolResultTexts(data) {
  const texts = [];
  const response = data?.tool_response ?? data?.toolOutput ?? data?.tool_output;
  if (typeof response === 'string') texts.push(response);
  else if (response && typeof response === 'object') {
    for (const key of ['stderr', 'stdout', 'output', 'error']) if (typeof response[key] === 'string') texts.push(response[key]);
  }
  if (typeof data?.error === 'string') texts.push(data.error);
  return texts;
}

// Whether a tool result shows a known error class (the post hooks resolve the log directory only then).
export function hasShellToolError(data) {
  const toolName = data?.tool_name || data?.toolName || '';
  return (toolName === 'Bash' || toolName === 'PowerShell') && classifyToolErrors(toolResultTexts(data)).length > 0;
}

// The PostToolUse and PostToolUseFailure entry point: one errors.jsonl row when a Bash or PowerShell result shows a known class.
export function recordShellToolErrors(hook, data, { platform = process.platform, env = process.env, logDir } = {}) {
  const toolName = data?.tool_name || data?.toolName || '';
  if (toolName !== 'Bash' && toolName !== 'PowerShell') return null;
  const found = classifyToolErrors(toolResultTexts(data));
  if (!found.length) return null;
  const input = data?.tool_input || data?.toolInput || {};
  const command = typeof input.command === 'string' ? input.command : '';
  const row = {
    ts: new Date().toISOString(),
    point: 'shell-error',
    ...logContextOf(data || {}),
    hook,
    tool_name: toolName,
    platform,
    classes: found.map((f) => f.class),
    matches: found.map((f) => f.match),
    is_error: hook === 'post-tool-use-failure',
    chars: command.length,
  };
  if (toolName === 'Bash') {
    const length = effectiveBashLength(command);
    row.effective_chars = length.effective;
    if (found.some((f) => f.class === 'unexpected-eof' || f.class === 'heredoc-eof')) {
      const win = platform === 'win32';
      row.cause = win && length.effective >= TRUNCATION_CAUSE_AT ? 'truncation' : win && findCrParserBug(gitBashHalved(command)) ? 'parser-bug' : 'manual';
    }
  }
  appendShellLog('errors.jsonl', row, { env, logDir });
  return row;
}
