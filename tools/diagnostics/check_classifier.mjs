// Pure classifier for fresh checks. Classifies shell commands into checks
// (test/lint/typecheck/build), a check's tool result into passed/failed/undetermined, and
// detects code mutations.
//
// The rules follow three ideas: a check counts only when its own exit status reaches the agent,
// runner summaries in the tool output decide when the exit status is hidden, and a command that
// narrows or weakens a check proves less than the full check.
//
// It is a library for offline diagnostics: it is not wired into any hook and does not change OMC
// behaviour. It differs from scripts/lib/shell-checks.mjs, which denies malformed shell commands
// at hook time: this module only classifies commands, tool results and writes.
//
// Pure ESM: no imports, no state, no I/O.

export const RULES_VERSION = '2026.11.15.2';

/** Standard temp directories: writes there hold no code. Named in this one place only. */
export const TEMP_DIRS = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp'];

/** Last characters of tool output read by the runner summary rules (the usual tail window). */
const SUMMARY_TAIL = 6000;

/** Drop ANSI escape sequences before matching summary rules. */
// eslint-disable-next-line no-control-regex
const stripEsc = (output) => output.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');

/**
 * Drop quoted strings and `#` comments, so a commit message cannot name a check
 * (`true # npm test` names nothing). A `#` after an escaped space stays part of a word.
 */
function executedText(command) {
  return command
    .replace(/"[^"]*"|'[^']*'/g, '')
    .replace(/(^|(?<!\\)\s)#[^\n]*/g, '$1');
}

/** Backslash-newline joins one logical command, so it joins before the shell is split. */
const joinContinuations = (command) => command.replace(/\\\r?\n/g, '');

/**
 * Split a shell command into pieces with the operator that follows each piece:
 * `|`, `||`, `&&`, `;`, newline, `&`. Redirection `2>&1` and `&>` are not splits
 * (`&` is skipped right after `>` or right before `>`).
 */
function shellPieces(command) {
  const list = [];
  const op = /\|\||&&|;|\n|(?<!>)&(?!>)|\|/g;
  let start = 0;
  let m;
  while ((m = op.exec(command)) !== null) {
    list.push({ text: command.slice(start, m.index).trim(), sep: m[0] });
    start = m.index + m[0].length;
  }
  list.push({ text: command.slice(start).trim(), sep: null });
  return list;
}

/** Whether a piece starts with a command that prints or inspects: it proves nothing. */
const PRINTS_OR_INSPECTS = /^\s*(?:echo|printf|cat|grep|rg|ls|which|type|command|man|head|tail|git)\b/;

/** `--version`/`--help` anywhere in the piece: the command ran, but it checked nothing. */
const ASKS_ONLY = /\s--(?:version|help)\b/;

/** `! npm test` exits 0 when the tests fail. */
const NEGATED = /^\s*!/;

/** Launch wrappers stripped before runner matching. */
const WRAPPERS = [
  /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, // env assignments (`CI=1 npm test`)
  /^env\s+(?:-\S+\s+)*/,
  /^timeout\s+(?:-\S+\s+)*\S+\s+/,
  /^time\s+(?:-p\s+)?/,
  /^npx\s+/,
  /^bunx\s+/,
  /^pnpm\s+(?:exec|dlx)\s+/,
  /^yarn\s+(exec|dlx)\s+/,
  /^uv\s+run\s+/,
  /^poetry\s+run\s+/,
  /^python[\d.]*\s+-m\s+/,
];

/** Strip launch wrappers iteratively; cap the loop so a degenerate input cannot spin. */
function stripWrappers(piece) {
  let current = piece;
  for (let i = 0; i < 8; i += 1) {
    const next = WRAPPERS.reduce((acc, re) => acc.replace(re, ''), current);
    if (next === current) return next;
    current = next;
  }
  return current;
}

// Each flag is a token that starts with a dash, optionally followed by one value token that is not a
// flag itself (a value that starts with a dash is just the next flag). Every token has one parse, so a
// long run of flags cannot make the match backtrack exponentially.
const PM_FLAGS = String.raw`\s+(?:-\S+\s+(?:(?!-\S)\S+\s+)?)*`;
const PM = String.raw`(?:npm|pnpm|yarn|bun)`;

/**
 * Runner recognition table. A runner matches at the start of its shell piece (after wrappers),
 * so `echo npm test` and a backticked substitution do not match. Gradle and maven are left out
 * on purpose: their lifecycle goals can also publish, so the exit code proves less there.
 */
const RUNNER_RULES = [
  { kind: 'test', runner: 'npm', re: new RegExp(`^${PM}${PM_FLAGS}(?:run\\s+)?test\\b\\S*`) },
  { kind: 'typecheck', runner: 'npm', re: new RegExp(`^${PM}${PM_FLAGS}(?:run\\s+)?typecheck\\b\\S*`) },
  { kind: 'lint', runner: 'npm', re: new RegExp(`^${PM}${PM_FLAGS}(?:run\\s+)?lint\\b\\S*`) },
  { kind: 'build', runner: 'npm', re: new RegExp(`^${PM}${PM_FLAGS}(?:run\\s+)?build\\b\\S*`) },
  { kind: 'test', runner: 'vitest', re: /^vitest\b/ },
  { kind: 'test', runner: 'jest', re: /^jest\b/ },
  { kind: 'test', runner: 'mocha', re: /^mocha\b/ },
  { kind: 'test', runner: 'ava', re: /^ava\b/ },
  { kind: 'test', runner: 'pytest', re: /^pytest\b/ },
  { kind: 'test', runner: 'node-test', re: /^node\s+--test\b/ },
  { kind: 'typecheck', runner: 'node-check', re: /^node\s+--check\b/ },
  { kind: 'test', runner: 'unittest', re: /^unittest\b/ },
  { kind: 'typecheck', runner: 'py-compile', re: /^py_compile\b/ },
  { kind: 'test', runner: 'cargo', re: /^cargo\s+(?:test|nextest)\b/ },
  { kind: 'build', runner: 'cargo', re: /^cargo\s+(?:build|check)\b/ },
  { kind: 'lint', runner: 'cargo', re: /^cargo\s+clippy\b/ },
  { kind: 'test', runner: 'go', re: /^go\s+test\b/ },
  { kind: 'build', runner: 'go', re: /^go\s+(?:build|vet)\b/ },
  { kind: 'test', runner: 'dotnet', re: /^dotnet\s+test\b/ },
  { kind: 'build', runner: 'dotnet', re: /^dotnet\s+build\b/ },
  { kind: 'test', runner: 'make', re: /^make\s+(?:test|check)\b/ },
  { kind: 'lint', runner: 'make', re: /^make\s+lint\b/ },
  { kind: 'build', runner: 'make', re: /^make\s+build\b/ },
  { kind: 'test', runner: 'rspec', re: /^rspec\b/ },
  { kind: 'test', runner: 'mix', re: /^mix\s+test\b/ },
  { kind: 'test', runner: 'phpunit', re: /^phpunit\b/ },
  { kind: 'test', runner: 'deno', re: /^deno\s+(?:test)\b/ },
  { kind: 'lint', runner: 'deno', re: /^deno\s+(?:check|lint)\b/ },
  { kind: 'typecheck', runner: 'tsc', re: /^tsc\b/ },
  { kind: 'typecheck', runner: 'mypy', re: /^mypy\b/ },
  { kind: 'typecheck', runner: 'pyright', re: /^pyright\b/ },
  { kind: 'lint', runner: 'eslint', re: /^eslint\b/ },
  { kind: 'lint', runner: 'biome', re: /^biome\s+check\b/ },
  { kind: 'lint', runner: 'ruff', re: /^ruff\s+(?:check|format\s+--check)\b/ },
  { kind: 'lint', runner: 'flake8', re: /^flake8\b/ },
  { kind: 'lint', runner: 'pylint', re: /^pylint\b/ },
  { kind: 'lint', runner: 'black', re: /^black\s+--check\b/ },
  { kind: 'lint', runner: 'prettier', re: /^prettier\s+--check\b/ },
  { kind: 'lint', runner: 'shellcheck', re: /^shellcheck\b/ },
  { kind: 'lint', runner: 'golangci-lint', re: /^golangci-lint\b/ },
  { kind: 'test', runner: 'tox', re: /^tox\b/ },
  { kind: 'test', runner: 'nox', re: /^nox\b/ },
  { kind: 'test', runner: 'ctest', re: /^ctest\b/ },
  { kind: 'test', runner: 'xcodebuild', re: /^xcodebuild\s+test\b/ },
  { kind: 'test', runner: 'swift', re: /^swift\s+test\b/ },
  { kind: 'build', runner: 'vite', re: /^vite\s+build\b/ },
  { kind: 'build', runner: 'next', re: /^next\s+build\b/ },
  { kind: 'build', runner: 'esbuild', re: /^esbuild\b/ },
  { kind: 'build', runner: 'webpack', re: /^webpack\b/ },
  { kind: 'test', runner: 'bun', re: /^bun\s+test\b/ },
];

/** Match a runner rule at the start of a (wrapper-stripped) piece. */
function runnerMatch(piece) {
  for (const rule of RUNNER_RULES) {
    if (rule.re.test(piece)) return { kind: rule.kind, runner: rule.runner };
  }
  return null;
}

/**
 * Flags that weaken a check (`vitest --passWithNoTests` passes a suite with no tests at all);
 * and flags that select a subset (`vitest -t x`, `-k`, go's `-run`). Weakeners apply to every
 * kind; selectors and file arguments only to tests, where a subset run proves less.
 */
const WEAKEN = /^(?:--passWithNoTests|--exclude|--testPathIgnorePatterns)(?:=|$)/;
const SELECT = /^(?:-t|--testNamePattern|-k|--skip|-run)(?:=|$)/;

/** A non-flag token naming an existing file shape (`src/a.test.ts`) narrows a test run. */
const FILE_TOKEN = /^\S+\.\w{1,8}$/;

/** Whether one stripped piece narrows or weakens its check. */
function pieceNarrows(piece, kind) {
  const tokens = piece.split(/\s+/).filter(Boolean);
  if (tokens.some((t) => WEAKEN.test(t))) return true;
  if (kind !== 'test') return false;
  if (tokens.some((t) => SELECT.test(t))) return true;
  // `./...` (go packages) and trailing-slash directories do not narrow; a file path does.
  return tokens.some((t) => !t.startsWith('-') && !t.endsWith('/') && t !== './...' && FILE_TOKEN.test(t));
}

/**
 * Whether the exit status of a runner piece reaches the agent, and if not, what hides it.
 * A backgrounding `&`, a pipe into anything but `tail` (or any pipe without pipefail: pipefail
 * only protects a pipe into `tail`, since `head` and `grep -q` end the runner early with SIGPIPE),
 * a `||`, or a `;`/newline with a non-empty successor hides the status. `&&` and redirects do not.
 */
function exitHiddenCause(pieces, index, pipefail) {
  const own = pieces[index];
  if (own.sep === '&') return 'backgrounded (&)';
  if (own.sep === '|') {
    const next = pieces[index + 1];
    const intoTail = pipefail && next !== undefined && /^tail(\s|$)/.test(next.text);
    if (!intoTail) return 'pipe without pipefail into tail';
  }
  for (let at = index; at < pieces.length; at += 1) {
    const sep = pieces[at].sep;
    if (sep === '||') return 'alternation (||)';
    if ((sep === ';' || sep === '\n') && pieces.slice(at + 1).some((p) => p.text)) return 'separator with successor';
  }
  return undefined;
}

/**
 * Classify a shell command: does it run a check (test/lint/typecheck/build), and can the check's
 * own exit status reach the tool result. Gradle/maven are deliberately unrecognized (goals can publish).
 */
export function classifyCommand(command) {
  if (typeof command !== 'string' || command === '') {
    return { isCheck: false, kind: null, runner: null, narrowed: false, exitHidden: false, pipefail: false, reason: 'empty or non-string command' };
  }
  const bare = executedText(joinContinuations(command));
  // Only a `set` statement changes the option; the last one wins.
  const pipefail = [...bare.matchAll(/(?:^|[;&\n])\s*set\s+([+-])\w*o\s+pipefail\b/g)].at(-1)?.[1] === '-';
  const pieces = shellPieces(bare);
  let check = null;
  let hidden;
  for (let i = 0; i < pieces.length; i += 1) {
    const stripped = stripWrappers(pieces[i].text);
    if (stripped === null) continue;
    if (PRINTS_OR_INSPECTS.test(stripped) || ASKS_ONLY.test(stripped) || NEGATED.test(stripped)) continue;
    const m = runnerMatch(stripped);
    if (!m) continue;
    check = { ...m, index: i };
    hidden = exitHiddenCause(pieces, i, pipefail);
    // later runner pieces overwrite: the command's status belongs to the last segment
  }
  if (!check) {
    return { isCheck: false, kind: null, runner: null, narrowed: false, exitHidden: false, pipefail, reason: 'no check runner in command' };
  }
  const strippedCheck = stripWrappers(pieces[check.index].text);
  const narrowed = pieceNarrows(strippedCheck, check.kind);
  const reason = hidden
    ? `check exit code hidden (${hidden})`
    : 'check command recognized';
  return { isCheck: true, kind: check.kind, runner: check.runner, narrowed, exitHidden: hidden !== undefined, pipefail, reason };
}

/**
 * Runner summary rules: anchored rules read from the tail of tool output. Deliberately narrow:
 * only node:test, pytest, ruff (with mypy and biome counts), eslint, tsc and vitest, the runners
 * chosen for their stable summary lines. Other runners stay undetermined when their exit status is hidden.
 */
const SUMMARY_RULES = [
  // node:test: a `ℹ fail N` line with N above 0 is a failure, N equal 0 a pass.
  {
    runner: 'node-test',
    rule: 'node-test-fail-count',
    apply: (tail) => {
      if (!/[ℹi] (?:tests|pass|fail) \d+/.test(tail)) return null;
      const m = /[ℹi] fail (\d+)/.exec(tail);
      if (!m) return null;
      return Number(m[1]) > 0 ? 'failed' : 'passed';
    },
  },
  // pytest: `===== 3 failed, 5 passed in 0.2s =====` / `===== 5 passed in 0.2s =====`.
  {
    runner: 'pytest',
    rule: 'pytest-summary-line',
    apply: (tail) => {
      const fail = /^=+ (\d+) (?:failed(?:, \d+ errors?)?|errors?)\b[\s\S]*? in [\d.]+s =*$/m.exec(tail);
      if (fail) return 'failed';
      const pass = /^=+ \d+ passed\b[\s\S]*? in [\d.]+s =*$/m.exec(tail);
      return pass ? 'passed' : null;
    },
  },
  // vitest: a test file that failed to load (`Test Files N failed`) fails the run even when the
  // `Tests` line reads as passed; then the counts on their own line, two spaces in, no colon.
  {
    runner: 'vitest',
    rule: 'vitest-tests-line',
    apply: (tail) => {
      if (/^\s*(?:\S+:\s*)?Test Files\s+[^\n]*?\b[1-9]\d* failed\b/m.test(tail)) return 'failed';
      const m = /^\s*Tests\s{2,}([^\n]*\(\d+\))\s*$/m.exec(tail);
      if (!m) return null;
      return /\d+ failed/.test(m[1]) ? 'failed' : 'passed';
    },
  },
  // eslint exits 0 on warnings alone, so the error count is the verdict, not the problem count.
  {
    runner: 'eslint',
    rule: 'eslint-problems-line',
    apply: (tail) => {
      const m = /^[✖x✗] \d+ problems? \((\d+) errors?, (\d+) warnings?\)/m.exec(tail);
      if (!m) return null;
      return Number(m[1]) > 0 ? 'failed' : 'passed';
    },
  },
  // ruff, mypy and biome all count the same way, so one rule reads all three.
  {
    runner: 'ruff',
    rule: 'ruff-found-errors',
    apply: (tail) => {
      if (/^Found [1-9]\d* errors?\b/m.test(tail)) return 'failed';
      return /^(?:All checks passed!|Success: no issues found)/m.test(tail) ? 'passed' : null;
    },
  },
  // tsc prints nothing on success; only the error code line decides, so silence is never a pass.
  {
    runner: 'tsc',
    rule: 'tsc-error-code',
    apply: (tail) => (/\berror TS\d{4,}:/.test(tail) ? 'failed' : null),
  },
];

/**
 * A runner's own report that nothing ran: a run of zero tests proves nothing about the change.
 * `cargo test` prints `running 0 tests` for its doc-tests after real results, and `go test -run X`
 * prints `[no tests to run]` for skipped packages, so zero counts only without real results.
 * Each report belongs to one runner's output (the `reader` name) and is read only for that runner.
 */
const ZERO_TEST_REPORTS = [
  { reader: 'jest', re: /Tests:\s+0 total\b|No tests found/i },
  { reader: 'vitest', re: /No tests found/i },
  { reader: 'pytest', re: /no tests ran/i },
  { reader: 'node-test', re: /ℹ tests 0\b/i },
  { reader: 'go', re: /\[no tests to run\]/i },
  { reader: 'cargo', re: /running 0 tests\b/i },
];

/**
 * Whose output a detected runner's result may be read as. A runner reads its own summary lines; the
 * ruff rule also reads mypy and biome, which count the same way. A package manager or make runs a
 * script of unknown content, so it reads the runners that fit the kind of the check (`npm run test`
 * may print vitest, jest, node:test or pytest output, `npm run lint` eslint or ruff output). A summary
 * line of any other runner, such as `Found 3 errors.` inside a passing vitest run or `All checks passed!`
 * piped through `tail` after pytest, is output, not a verdict. A runner not listed reads nothing.
 */
const OWN_READERS = {
  'node-test': ['node-test'], pytest: ['pytest'], vitest: ['vitest'], jest: ['jest'], eslint: ['eslint'], tsc: ['tsc'],
  ruff: ['ruff'], mypy: ['ruff'], biome: ['ruff'], go: ['go'], cargo: ['cargo'], tox: ['pytest'], nox: ['pytest'],
};
const SCRIPT_RUNNERS = new Set(['npm', 'make']);
const SCRIPT_READERS_BY_KIND = {
  test: ['vitest', 'jest', 'node-test', 'pytest'], lint: ['eslint', 'ruff'], typecheck: ['tsc', 'ruff'], build: ['tsc'],
};

/** The set of reader names that may interpret the output of a classified check command. */
function readersFor({ runner, kind }) {
  return new Set(SCRIPT_RUNNERS.has(runner) ? SCRIPT_READERS_BY_KIND[kind] ?? [] : OWN_READERS[runner] ?? []);
}

/**
 * True when the zero-test report sits in the tail and no real result appears anywhere in the output.
 * The report is matched in the tail only, so an early "No tests found" line in a long green log does not count.
 */
function ranNoTests(output, readers) {
  const tail = output.slice(-SUMMARY_TAIL);
  if (!ZERO_TEST_REPORTS.some(({ reader, re }) => readers.has(reader) && re.test(tail))) return false;
  return !output.split('\n').some((line) => /^\s*running [1-9]\d* tests?\b/.test(line) || (/^\s*ok\s/.test(line) && !line.includes('[no tests to run]')));
}

/** The variable an echo/printf prints for a runner's own exit code. */
const EXIT_VAR = /\$\?|\$\{PIPESTATUS\[0\]\}/;

/**
 * The last number an echo/printf in the command printed for the runner's exit code, read from
 * the output tail (`echo "EXIT=$?"` printing `EXIT=3`). Only a hidden exit status needs it.
 */
function printedExitCode(command, tail) {
  let last;
  const echoRe = /(?:^|[;&|\n]\s*)(?:echo|printf)\s+(['"]?)([^;'"|\n]*)\1(?=\s*[;&|\n]|$)/g;
  for (const m of command.matchAll(echoRe)) {
    const literal = m[2] ?? '';
    if (!EXIT_VAR.test(literal)) continue;
    const parts = literal.replace(/\\n/g, '').split(EXIT_VAR);
    if (parts.length < 2) continue;
    const escaped = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(\\d+)');
    const re = new RegExp(`^\\s*${escaped}\\s*$`, 'mg');
    for (const mm of tail.matchAll(re)) last = Number(mm[1]);
  }
  return last;
}

/**
 * Classify a check's tool result. The command decides whether this is a check at all; a visible
 * exit status decides directly (a nonzero exit and an errored result are not skipped); when the
 * status is hidden by a pipe, the anchored runner summary rules in the output tail decide, failure
 * before pass; narrowing or a zero-test run stays undetermined unless a failure rule fires.
 */
export function classifyCheckResult({ command, output, isError, exitCode }) {
  const out = typeof output === 'string' ? output : '';
  const tail = stripEsc(out.slice(-SUMMARY_TAIL));
  const cc = classifyCommand(command);
  if (!cc.isCheck) {
    return { verdict: 'undetermined', reason: 'not a check command', rule: null };
  }
  const readers = readersFor(cc);
  if (out !== '' && ranNoTests(out, readers)) {
    return { verdict: 'undetermined', reason: 'runner summary reports zero tests', rule: 'zero-tests' };
  }
  // A failure summary wins over everything, including a zero exit status.
  for (const entry of SUMMARY_RULES.filter((rule) => readers.has(rule.runner))) {
    const verdict = entry.apply(tail);
    if (verdict === 'failed') {
      return { verdict: 'failed', reason: `runner summary failure (${entry.rule})`, rule: entry.rule };
    }
  }
  // A visible failing exit status decides even for a narrowed check: a narrowed run that failed
  // is still a failed run, and only a passing one is weakened evidence.
  if (!cc.exitHidden && (isError === true || (typeof exitCode === 'number' && exitCode !== 0))) {
    return { verdict: 'failed', reason: `nonzero exit status${typeof exitCode === 'number' ? ` ${exitCode}` : ''}`, rule: 'exit-code' };
  }
  if (cc.narrowed) {
    return { verdict: 'undetermined', reason: 'check narrowed or weakened', rule: 'narrowed' };
  }
  if (cc.exitHidden) {
    // The tool result's exit status belongs to the pipe, not the runner: a printed exit code
    // (echo $?) or a passing runner summary decides, otherwise undetermined.
    const printed = printedExitCode(command, tail);
    if (printed !== undefined) {
      return printed !== 0
        ? { verdict: 'failed', reason: `printed exit code ${printed}`, rule: 'printed-exit-code' }
        : { verdict: 'passed', reason: 'printed exit code 0', rule: 'printed-exit-code' };
    }
    for (const entry of SUMMARY_RULES.filter((rule) => readers.has(rule.runner))) {
      const verdict = entry.apply(tail);
      if (verdict === 'passed') {
        return { verdict: 'passed', reason: `runner summary pass (${entry.rule})`, rule: entry.rule };
      }
    }
    return { verdict: 'undetermined', reason: 'check exit code hidden without pipefail and no runner summary', rule: null };
  }
  // Visible exit status, not failing (the failing case returned above): passed.
  return { verdict: 'passed', reason: 'zero or absent exit status with no error flag', rule: 'exit-code-zero' };
}

/** Files whose edits never need a passing check: docs, images, lockfiles, logs, installed packages. */
const IGNORE = /(^|\/)docs?\/|(^|\/)(node_modules|\.venv|__pycache__|coverage|\.cache|\.git)(\/|$)|\.(md|mdx|txt|rst|adoc|svg|png|jpe?g|gif|ico|webp|lock|log)$/i;

/** Package-manager lockfiles keep their JSON/YAML extension, so they are named apart. */
const LOCKFILE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml)$/;

/** Writes to temp directories, the null device, or $TMPDIR hold no code. */
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TEMP_TARGET = new RegExp(
  `^(?:${TEMP_DIRS.map(escapeRe).join('|')})(?:/|$)|^/dev/null$|^\\s*["']?\\$TMPDIR\\b`,
);

/**
 * Files a shell command writes by redirection, `tee`, a heredoc with a target, or an in-place
 * `sed`/`perl`. Quoted strings hold text, not redirections, except a file name quoted right
 * after `>` or `tee`.
 */
function shellWriteTargets(command) {
  const QUOTED = String.raw`"[^"]*"|'[^']*'`;
  const text = command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\b/g, (m, q, tag) => `<< ${tag}`); // heredoc body out
  const shell = text.replace(new RegExp(`(>\\s*|\\btee\\s+(?:-[ai]+\\s+)*)?(${QUOTED})`, 'g'), (m, keep) => (keep ? m : ''));
  const targets = [];
  const redirect = new RegExp(String.raw`(?:^|[\s;&|(])\d?>{1,2}\s*(?:${QUOTED}|[^\s;&|)<>]+)`, 'g');
  const quotedRedirect = new RegExp(String.raw`(?:^|[\s;&|(])\d?>{1,2}\s*(${QUOTED})`, 'g');
  for (const m of shell.matchAll(redirect)) targets.push(m[0].replace(/^[\s;&|(]*\d?>{1,2}\s*/, ''));
  for (const m of shell.matchAll(quotedRedirect)) targets.push(m[1].replace(/^["']|["']$/g, ''));
  for (const m of shell.matchAll(/\btee\s+([^;&|)<>]+)/g)) {
    for (const t of m[1].split(/\s+/)) if (t && !t.startsWith('-')) targets.push(t);
  }
  // `-i` alone or in a cluster (`-Ei`, `-pi.bak`); perl's `-M`/`-I` take a word, not flags.
  const SED_IN_PLACE = /^(?:-[a-zA-Z]*i|--in-place)/;
  const PERL_IN_PLACE = /^-(?![MI])[a-zA-Z0]*i/;
  for (const m of text.matchAll(/\b(?:sed|perl)\s+[^;&|\n]+/g)) {
    const flag = m[0].startsWith('perl') ? PERL_IN_PLACE : SED_IN_PLACE;
    for (const t of m[0].split(/\s+/)) {
      if (/^\d?[<>]/.test(t)) break;
      if (flag.test(t)) { targets.push(t); break; }
    }
  }
  return targets;
}

/**
 * Whether a tool call changes code. Write/Edit/MultiEdit/NotebookEdit change code unless the
 * file is ignored (docs, logs, lockfiles). Bash changes code when its command writes files by
 * redirection, `tee`, heredoc with a target, or in-place `sed`/`perl`, unless every target is
 * ignored or a temp target (TEMP_DIRS, /dev/null, $TMPDIR) holds no code either.
 * The project folder is not checked: the contract passes no working directory.
 */
export function isMutation(toolName, toolInput) {
  if (typeof toolName !== 'string' || !toolName) return false;
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    const path = typeof input.file_path === 'string' ? input.file_path : '';
    if (path === '') return false; // no path: nothing to mutate
    return !IGNORE.test(path) && !TEMP_TARGET.test(path) && !LOCKFILE.test(path);
  }
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    const targets = shellWriteTargets(command);
    return targets.some((t) => !IGNORE.test(t) && !TEMP_TARGET.test(t) && !LOCKFILE.test(t));
  }
  return false;
}

// --- end of module ---
