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

export const RULES_VERSION = '2026.11.20.4';

/** Standard temp directories: writes there hold no code. Named in this one place only. */
export const TEMP_DIRS = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp'];

/** Last characters of tool output read by the runner summary rules (the usual tail window). */
const SUMMARY_TAIL = 6000;

/** Drop ANSI escape sequences before matching summary rules. */
// eslint-disable-next-line no-control-regex
const stripEsc = (output) => output.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');

/** Index of the `)` that closes a `$(` whose body starts at `at`, or the length of the text when none does. */
function matchingParenthesis(text, at) {
  let depth = 1;
  for (let i = at; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') i += 1;
    else if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      if (close === -1) return text.length;
      i = close;
    } else if (ch === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    } else if (ch === '`') i = closingBacktick(text, i + 1);
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

/** Index of the first unescaped backtick at or after `at`, or the length of the text when there is none. */
function closingBacktick(text, at) {
  for (let i = at; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '`') return i;
  }
  return text.length;
}

/**
 * Replace every command substitution outside quotes (`$(...)`, a backtick pair) by `placeholder`, so the
 * substitution is one part of the word it stands in (`A=$(git rev-parse HEAD) npm test` has the assignment
 * value `A=_`) and its end opens no command position (`echo $(date) git commit` runs only echo). The bodies are
 * returned apart, for the callers that read them as commands of their own. A substitution with an empty body
 * (`$()`, two backticks) expands to nothing, so it leaves no word. A substitution that has no end runs to the
 * end of the text. One pass: a body is skipped once, then read again only at the next nesting level.
 */
function splitSubstitutions(text, placeholder) {
  const bodies = [];
  let out = '';
  let from = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') i += 2;
    else if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      i = close === -1 ? text.length : close + 1;
    } else if (ch === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i += 1;
    } else if (ch === '`' || (ch === '$' && text[i + 1] === '(')) {
      const open = ch === '`' ? 1 : 2;
      const end = ch === '`' ? closingBacktick(text, i + 1) : matchingParenthesis(text, i + 2);
      const body = text.slice(i + open, end);
      out += text.slice(from, i) + (body.trim() === '' ? '' : placeholder); // an empty substitution expands to nothing
      bodies.push(body);
      i = end + 1;
      from = i;
    } else i += 1;
  }
  return { text: out + text.slice(from), bodies };
}

/**
 * Drop `#` comments and neutralize quoted strings and command substitutions, so a commit message cannot name
 * a check (`true # npm test` and `git commit -m "npm test"` name nothing) while a quoted operand is still an
 * argument (`pytest "tests/a.py"` narrows the run). A quoted string keeps its text, but whitespace and
 * shell operators inside it become `_`: it stays one word and cannot split the command, start a comment
 * or join the words around it into a runner name. A `#` after an escaped space stays part of a word. A
 * command substitution outside quotes (`$(...)`, backticks) becomes `_` as a whole, so `A=$(x y) npm test`
 * keeps `npm test` as its command and the check inside a substitution (`echo $(npm test)`) names none.
 */
function executedText(command) {
  const plain = command
    .replace(/"[^"]*"|'[^']*'/g, (quoted) => quoted.slice(1, -1).replace(/[\s;&|#!<>()]/g, '_'))
    .replace(/(^|(?<!\\)\s)#[^\n]*/g, '$1');
  return splitSubstitutions(plain, '_').text;
}

/** Backslash-newline joins one logical command, so it joins before the shell is split. */
const joinContinuations = (command) => command.replace(/\\\r?\n/g, '');

/**
 * Split a shell command into pieces with the operator that follows each piece:
 * `|`, `||`, `&&`, `;`, newline, `&`. The redirections `2>&1`, `<&3`, `&>` and `>|` are not splits
 * (`&` is skipped right after `>` or `<` and right before `>`, `|` right after `>`).
 */
function shellPieces(command) {
  const list = [];
  const op = /\|\||&&|;|\n|(?<![<>])&(?!>)|(?<!>)\|/g;
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

/**
 * One redirection: an optional descriptor (`2`, `{fd}`), the operator and its target word, which may hold an
 * escaped space. A redirection is no argument and no command word: its target names a file, never a program.
 */
const REDIRECTION = String.raw`(?:\d+|\{[A-Za-z_]\w*\})?(?:&>>?|>>|>\||>&|<&|<>|<<<|<<-?|>|<)(?!\()\s*(?:\\[\s\S]|[^\s\\])+`;
const ASSIGNMENT = String.raw`[A-Za-z_][A-Za-z0-9_]*\+?=(?:\\[\s\S]|[^\s\\])*`; // `A+=x` appends; the value may hold an escaped space
const LEADING_REDIRECTIONS = new RegExp(String.raw`^(?:(?:${ASSIGNMENT}|${REDIRECTION})\s+)+`);
const ALL_REDIRECTIONS = new RegExp(REDIRECTION, 'g');

/**
 * Launch wrappers that are taken off in front of the command word, and the options each one is known by. A wrapper does not
 * change what the command behind it does, so `sudo git commit` and `timeout 60 npm test` read like the bare command. The same
 * table is in the Python tools of this directory that look for a command word (each tool is a standalone script):
 *
 *   sudo     -E | --preserve-env[=LIST]    -u USER | --user USER | --user=USER
 *   nohup    (no options)
 *   command  -p
 *   exec     -a NAME
 *   nice     -n N | -nN | --adjustment N | --adjustment=N
 *   time     -p
 *   timeout  -s SIGNAL | --signal SIGNAL | --signal=SIGNAL    -k DURATION | --kill-after DURATION | --kill-after=DURATION
 *            then DURATION (a number with an optional s, m, h or d)
 *   env      -i | --ignore-environment    -u NAME | --unset NAME | --unset=NAME    (NAME=VALUE words follow, see below)
 *
 * The options are those of `--help` of sudo 1.9.16 and GNU coreutils 9.7 (nice, timeout, env) and of `help` of bash 5.2
 * (command, exec, time). Assignments and redirections may stand in front of a wrapper and between two of them
 * (LEADING_REDIRECTIONS), which is also where the `NAME=VALUE` words of `env` and `sudo` go. An option that is not in the
 * table (`sudo -n`, `timeout --foreground`, `nice -5`, `env -S`), the end-of-options word `--`, a wrapper with no command and a
 * `timeout` with no duration end the stripping: the command is left as it is, so it is no runner and nothing is guessed. At
 * most eight wrappers in a row are taken off (stripWrappers), so a degenerate chain reads nothing.
 */
const DURATION = /^(?:\d+\.?\d*|\.\d+)[smhd]?$/;
const launchWrapper = ({ flags = [], values = [], optionalValue = [], duration = false }) => ({ flags: new Set(flags), values: new Set(values), optionalValue: new Set(optionalValue), duration });
const LAUNCH_TABLE = new Map([
  ['sudo', launchWrapper({ flags: ['-E'], values: ['-u', '--user'], optionalValue: ['--preserve-env'] })],
  ['nohup', launchWrapper({})],
  ['command', launchWrapper({ flags: ['-p'] })],
  ['exec', launchWrapper({ values: ['-a'] })],
  ['nice', launchWrapper({ values: ['-n', '--adjustment'] })],
  ['time', launchWrapper({ flags: ['-p'] })],
  ['timeout', launchWrapper({ values: ['-s', '--signal', '-k', '--kill-after'], duration: true })],
  ['env', launchWrapper({ flags: ['-i', '--ignore-environment'], values: ['-u', '--unset'] })],
]);

/** The next word of `text` and the text behind it (with the blanks after the word), or null when no word is left. */
const nextWord = (text) => {
  const found = /^(\S+)\s*/.exec(text);
  return found === null ? null : { word: found[1], rest: text.slice(found[0].length) };
};

/** Whether `word` is an option of the wrapper with its value glued on: `-nN`, `-uUSER`, `--user=USER`, `--preserve-env=LIST`. */
function gluedOption(word, spec) {
  if (word.startsWith('--')) {
    const at = word.indexOf('=');
    if (at === -1) return false;
    const name = word.slice(0, at);
    return spec.values.has(name) || spec.optionalValue.has(name);
  }
  return word.length > 2 && word.startsWith('-') && spec.values.has(word.slice(0, 2));
}

/** Take one launch wrapper and its options off the front of `text`; the text is returned as it is when it starts with none. */
function stripLaunchWrapper(text) {
  const first = nextWord(text);
  if (first === null) return text;
  const spec = LAUNCH_TABLE.get(baseName(first.word));
  if (spec === undefined) return text;
  let rest = first.rest;
  let durations = spec.duration ? 1 : 0;
  for (;;) {
    const next = nextWord(rest);
    if (next === null) return text; // a wrapper with no command behind it
    const { word } = next;
    if (spec.flags.has(word) || spec.optionalValue.has(word) || gluedOption(word, spec)) {
      rest = next.rest;
    } else if (spec.values.has(word)) {
      const value = nextWord(next.rest);
      if (value === null) return text;
      rest = value.rest;
    } else if (word.startsWith('-')) {
      return text; // an option outside the table, or `--`
    } else if (durations > 0) {
      if (!DURATION.test(word)) return text;
      durations -= 1;
      rest = next.rest;
    } else {
      return rest;
    }
  }
}

/** Launch wrappers stripped before runner matching. */
const WRAPPERS = [
  LEADING_REDIRECTIONS, // env assignments and redirections before the command word (`CI=1 npm test`, `> out npm test`)
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
    const next = stripLaunchWrapper(WRAPPERS.reduce((acc, re) => acc.replace(re, ''), current));
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
 * Flags that weaken a check (`vitest --passWithNoTests` passes a suite with no tests at all) apply to every
 * kind. Options that select a subset of the tests, or none, apply to tests only, where a subset run proves
 * less. The subset options are listed per runner (SUBSET_OPTIONS); a token names one when it equals the
 * option or starts with `option=` or `option:` (`-run=X`, `-only-testing:Suite`).
 */
const WEAKEN = /^(?:--passWithNoTests|--exclude|--testPathIgnorePatterns)(?:=|$)/;

/** go flags take one or two dashes and an optional `test.` prefix: `-run`, `--run`, `-test.run`. */
const goOptions = (names) => names.flatMap((name) => [`-${name}`, `--${name}`, `-test.${name}`, `--test.${name}`]);

const JEST_SUBSET = [
  '-t', '--testNamePattern', '--test-name-pattern', '--testPathPattern', '--testPathPatterns', '--changed', '--onlyChanged', '-o',
  '--changedSince', '--changedFilesWithAncestor', '--lastCommit', '--related', '--findRelatedTests', '--onlyFailures', '-f',
  '--shard', '--project', '--projects', '--selectProjects', '--ignoreProjects', '--listTests', '--collectTests', '--dir',
];
const SUBSET_OPTIONS = {
  pytest: [
    '-m', '-k', '--lf', '--last-failed', '--sw', '--stepwise', '--sw-skip', '--stepwise-skip', '--deselect', '--ignore',
    '--ignore-glob', '--collect-only', '--co',
  ],
  unittest: ['-k'],
  vitest: JEST_SUBSET,
  jest: JEST_SUBSET,
  bun: JEST_SUBSET,
  mocha: ['-g', '--grep', '-f', '--fgrep', '-i', '--invert', '--dry-run', '--ignore'],
  ava: ['-m', '--match'],
  'node-test': ['--test-name-pattern', '--test-skip-pattern', '--test-only', '--test-shard'],
  go: goOptions(['run', 'skip', 'short', 'list']),
  // cargo: a test name filter is a positional word, read by cargoNarrows.
  cargo: [],
  dotnet: ['--filter', '--list-tests', '-t'],
  rspec: ['-e', '--example', '-E', '--example-matches', '--tag', '--only-failures', '--next-failure', '--pattern', '--exclude_pattern'],
  mix: ['--only', '--failed', '--stale', '--partitions', '--dry-run'],
  phpunit: [
    '--filter', '--group', '--exclude-group', '--testsuite', '--exclude-testsuite', '--covers', '--uses', '--list-tests',
    '--list-suites', '--list-groups',
  ],
  deno: ['--filter', '--ignore', '--no-run', '--shard'],
  ctest: [
    '-R', '--tests-regex', '-E', '--exclude-regex', '-L', '--label-regex', '-LE', '--label-exclude', '-I', '--tests-information',
    '-N', '--show-only', '--rerun-failed', '--tests-from-file', '--exclude-from-file',
  ],
  xcodebuild: ['-only-testing', '-skip-testing', '-only-test-configuration', '-skip-test-configuration'],
  swift: ['--filter', '--skip', '--list-tests', '-l'],
  tox: ['-e', '-f', '-m', '-l'],
  nox: ['-s', '-e', '--session', '-k', '--keywords', '-t', '--tags', '-l', '--list'],
};
/** Selectors every runner is read for: the short names that name a subset in most runners. */
const COMMON_SUBSET = ['-t', '--testNamePattern', '-k', '--skip', '-run'];
/**
 * A package manager or make runs a script of unknown content, so it is read for the long options of every
 * runner and for the short ones that no package manager uses itself.
 */
const SCRIPT_SUBSET = new Set([
  ...COMMON_SUBSET, '-m', '-g',
  ...Object.values(SUBSET_OPTIONS).flat().filter((name) => name.startsWith('--')),
]);
const SUBSET_SETS = new Map(Object.entries(SUBSET_OPTIONS).map(([runner, names]) => [runner, new Set([...COMMON_SUBSET, ...names])]));
/** pytest and unittest read `-kEXPR`, `-mMARK` and a cluster that ends in the option (`-xk EXPR`). */
const PYTEST_SHORT_VALUE = /^-(?:[km].+|[A-Za-z]+[km])$/;

/** cargo test options that narrow the run, and the options that take the next word as their value. */
const CARGO_SUBSET = new Set([
  '--lib', '--bins', '--bin', '--tests', '--test', '--examples', '--example', '--benches', '--bench', '--doc', '-p', '--package',
  '--skip', '--ignored', '--list', '--no-run',
]);
const CARGO_VALUE_OPTIONS = new Set([
  '-p', '--package', '--exclude', '-F', '--features', '--target', '--profile', '--target-dir', '--manifest-path', '--color',
  '--message-format', '-j', '--jobs', '--config', '-Z', '--bin', '--test', '--example', '--bench', '--test-threads', '--format',
  '--logfile', '--skip', '--shuffle-seed',
]);

/**
 * Whether a `cargo test` / `cargo nextest run` command runs a subset: a target or package option, a libtest option
 * that selects, skips or lists tests, or a positional test name filter (`cargo test foo`). The words that are the
 * value of an option (`-p foo`, `--test-threads 4`) are not filters.
 */
function cargoNarrows(tokens) {
  let at = tokens.findIndex((token) => token === 'test' || token === 'nextest') + 1;
  if (at === 0) return false;
  if (tokens[at] === 'run') at += 1;
  for (; at < tokens.length; at += 1) {
    const token = tokens[at];
    if (token === '--') continue;
    if (!token.startsWith('-')) return true;
    if (CARGO_SUBSET.has(token.split('=')[0])) return true;
    if (!token.includes('=') && CARGO_VALUE_OPTIONS.has(token)) at += 1;
  }
  return false;
}

/** Whether a token of a test command is an option that runs a subset of the tests (or none) for this runner. */
function selectsSubset(token, runner) {
  if (!token.startsWith('-')) return false;
  const names = SCRIPT_RUNNERS.has(runner) ? SCRIPT_SUBSET : SUBSET_SETS.get(runner) ?? new Set(COMMON_SUBSET);
  if (names.has(token.replace(/[=:][\s\S]*$/, ''))) return true;
  return (runner === 'pytest' || runner === 'unittest') && PYTEST_SHORT_VALUE.test(token);
}

/** A non-flag token naming a file shape (`src/a.test.ts`, `tests/a.py::test_x`) narrows a test run. */
const FILE_TOKEN = /^\S+\.\w{1,8}(?:::\S*)?$/;

/** Whether one stripped piece of a `runner` narrows or weakens its check. */
function pieceNarrows(piece, kind, runner) {
  const tokens = piece.replace(ALL_REDIRECTIONS, ' ').split(/\s+/).filter(Boolean);
  if (tokens.some((t) => WEAKEN.test(t))) return true;
  if (kind !== 'test') return false;
  if (tokens.some((t) => selectsSubset(t, runner))) return true;
  if (runner === 'cargo' && cargoNarrows(tokens)) return true;
  // `./...` (go packages) and trailing-slash directories do not narrow; a file path does.
  return tokens.some((t) => !t.startsWith('-') && !t.endsWith('/') && t !== './...' && FILE_TOKEN.test(t));
}

/**
 * Whether the exit status of a runner piece reaches the agent, and if not, what hides it.
 * A backgrounding `&`, a pipe into anything but `tail` (or any pipe without pipefail: pipefail
 * only protects a pipe into `tail`, since `head` and `grep -q` end the runner early with SIGPIPE),
 * a `||` before or after it (`build || npm test` exits 0 without running the check), or a `;`/newline
 * with a non-empty successor hides the status. `&&` and redirects do not (see sharesExitStatus).
 */
function exitHiddenCause(pieces, index, pipefail) {
  const own = pieces[index];
  if (own.sep === '&') return 'backgrounded (&)';
  if (own.sep === '|') {
    const next = pieces[index + 1];
    const intoTail = pipefail && next !== undefined && /^tail(\s|$)/.test(next.text);
    if (!intoTail) return 'pipe without pipefail into tail';
  }
  for (let at = index - 1; at >= 0 && ['&&', '||', '|'].includes(pieces[at].sep); at -= 1) {
    if (pieces[at].sep === '||') return 'alternation (||)';
  }
  for (let at = index; at < pieces.length; at += 1) {
    const sep = pieces[at].sep;
    if (sep === '||') return 'alternation (||)';
    if ((sep === ';' || sep === '\n') && pieces.slice(at + 1).some((p) => p.text)) return 'separator with successor';
  }
  return undefined;
}

/** Statements that cannot fail in practice: they never make a chain exit nonzero on their own. */
const NEVER_FAILS = /^(?:(?:set|export|unset|true|tail)(?:\s|$)|:(?:\s|$)|(?:echo|printf)(?:\s[^>]*)?$)/;

/**
 * Whether a visible nonzero exit status may come from another command than the check: one joined to it by
 * `&&` (`false && npm test` never runs the check, `npm test && false` fails after it), or one piped into it
 * under pipefail (`false | npm test`). Without pipefail an earlier command of a pipe sets no status.
 */
function sharesExitStatus(pieces, index, pipefail) {
  let from = index;
  while (from > 0 && (pieces[from - 1].sep === '&&' || pieces[from - 1].sep === '|')) from -= 1;
  let to = index;
  while (to < pieces.length - 1 && (pieces[to].sep === '&&' || pieces[to].sep === '|')) to += 1;
  for (let at = from; at <= to; at += 1) {
    const piece = pieces[at];
    if (at === index || piece.text === '' || NEVER_FAILS.test(piece.text)) continue;
    if (at < index && piece.sep === '|' && !pipefail) continue;
    return true;
  }
  return false;
}

/**
 * Classify a shell command: does it run a check (test/lint/typecheck/build), and can the check's
 * own exit status reach the tool result. Gradle/maven are deliberately unrecognized (goals can publish).
 * `chained` is set when another command of an `&&` chain (or one piped into the check under pipefail) may be
 * the one that failed; `piped` when the check feeds a pipe without pipefail, so `$?` after it is the last
 * command's. The exit status stays visible in both cases: a zero status still means every command passed.
 */
export function classifyCommand(command) {
  if (typeof command !== 'string' || command === '') {
    return { isCheck: false, kind: null, runner: null, narrowed: false, exitHidden: false, chained: false, piped: false, pipefail: false, reason: 'empty or non-string command' };
  }
  // A here-document body is input, not shell (it is cut out before the lines are joined, as isMutation reads it).
  const bare = executedText(joinContinuations(withoutHeredocBodies(command)));
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
    return { isCheck: false, kind: null, runner: null, narrowed: false, exitHidden: false, chained: false, piped: false, pipefail, reason: 'no check runner in command' };
  }
  const strippedCheck = stripWrappers(pieces[check.index].text);
  const narrowed = pieceNarrows(strippedCheck, check.kind, check.runner);
  const reason = hidden
    ? `check exit code hidden (${hidden})`
    : 'check command recognized';
  const chained = sharesExitStatus(pieces, check.index, pipefail);
  const piped = pieces[check.index].sep === '|' && !pipefail;
  return { isCheck: true, kind: check.kind, runner: check.runner, narrowed, exitHidden: hidden !== undefined, chained, piped, pipefail, reason };
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
 * A runner's own report that nothing ran: a run of zero tests proves nothing about the change. Each entry
 * belongs to one runner's output (the `reader` name) and is read only for that runner. `zero` is the report;
 * `ran` is a line of real results (a test counted as passed, failed or skipped) that voids it: a test may print
 * `No tests found` as data, and `cargo test` prints `running 0 tests` for its doc-tests after real results, and
 * `go test -run X` prints `[no tests to run]` for skipped packages, so zero counts only without real results.
 * Every `ran` pattern is anchored at a line start and has no nested repeats, so it matches in linear time.
 */
const ZERO_TEST_REPORTS = [
  { reader: 'jest', zero: /Tests:\s+0 total\b|No tests found/i, ran: /^[ \t]*Tests:[ \t]+(?:0 \w+,[ \t]*)*[1-9]\d* \w+/m },
  { reader: 'vitest', zero: /No tests found/i, ran: /^[ \t]*(?:\S+:[ \t]*)?Tests {2,}(?:0 \w+ \| )*[1-9]\d* \w+/m },
  {
    reader: 'pytest',
    zero: /no tests ran/i,
    ran: /^[= ]*(?=(?:\d+ \w+, )*[1-9]\d* (?:passed|failed|skipped|xfailed|xpassed|errors?)\b)(?:\d+ \w+, )*\d+ \w+ in \d[\d.]*s\b/m,
  },
  { reader: 'node-test', zero: /ℹ tests 0\b/i, ran: /ℹ tests [1-9]\d*\b/ },
  { reader: 'go', zero: /\[no tests to run\]/i, ran: /^[ \t]*ok[ \t](?![^\n]*\[no tests to run\])/m },
  { reader: 'cargo', zero: /running 0 tests\b/i, ran: /^[ \t]*running [1-9]\d* tests?\b/m },
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
 * Escape sequences are dropped first, so a colored summary line counts as a result.
 */
function ranNoTests(output, readers) {
  const text = stripEsc(output);
  const tail = text.slice(-SUMMARY_TAIL);
  const active = ZERO_TEST_REPORTS.filter(({ reader }) => readers.has(reader));
  if (!active.some(({ zero }) => zero.test(tail))) return false;
  return !active.some(({ ran }) => ran.test(text));
}

/** The variables an echo/printf prints for a runner's own exit code; behind a pipe without pipefail, `$?` is not one. */
const EXIT_VAR = /\$\?|\$\{PIPESTATUS\[0\]\}/;
const PIPE_EXIT_VAR = /\$\{PIPESTATUS\[0\]\}/;

/**
 * The last number an echo/printf in the command printed for the runner's exit code, read from
 * the output tail (`echo "EXIT=$?"` printing `EXIT=3`). Only a hidden exit status needs it.
 */
function printedExitCode(command, tail, piped) {
  let last;
  const exitVar = piped ? PIPE_EXIT_VAR : EXIT_VAR;
  const echoRe = /(?:^|[;&|\n]\s*)(?:echo|printf)\s+(['"]?)([^;'"|\n]*)\1(?=\s*[;&|\n]|$)/g;
  for (const m of command.matchAll(echoRe)) {
    const literal = m[2] ?? '';
    if (!exitVar.test(literal)) continue;
    const parts = literal.replace(/\\n/g, '').split(exitVar);
    if (parts.length < 2) continue;
    const escaped = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(\\d+)');
    const re = new RegExp(`^\\s*${escaped}\\s*$`, 'mg');
    for (const mm of tail.matchAll(re)) last = Number(mm[1]);
  }
  return last;
}

/**
 * Classify a check's tool result. The command decides whether this is a check at all; a visible
 * exit status decides directly (a nonzero exit and an errored result are not skipped), except that a
 * nonzero status of an `&&` chain stays undetermined: another command of the chain may have failed, and
 * only a failure line of the runner (above) names the check; when the status is hidden by a pipe, the
 * anchored runner summary rules in the output tail decide, failure before pass; narrowing or a zero-test
 * run stays undetermined unless a failure rule fires.
 */
export function classifyCheckResult({ command, output, isError, exitCode }) {
  const out = typeof output === 'string' ? output : '';
  const tail = stripEsc(out.slice(-SUMMARY_TAIL));
  const cc = classifyCommand(command);
  if (!cc.isCheck) {
    return { verdict: 'undetermined', reason: 'not a check command', rule: null };
  }
  const readers = readersFor(cc);
  // A failure summary wins over everything, including a zero exit status and a zero-test report: a run
  // with a failure line ran something (a test may print `No tests found` as data, or an npm script may
  // chain a child that ran no tests with one that failed).
  for (const entry of SUMMARY_RULES.filter((rule) => readers.has(rule.runner))) {
    const verdict = entry.apply(tail);
    if (verdict === 'failed') {
      return { verdict: 'failed', reason: `runner summary failure (${entry.rule})`, rule: entry.rule };
    }
  }
  // A zero-test report without real results decides before the exit status: the runners print it and
  // exit nonzero on their own (vitest and jest exit 1 when no test is found), so that status is no failure.
  if (out !== '' && ranNoTests(out, readers)) {
    return { verdict: 'undetermined', reason: 'runner summary reports zero tests', rule: 'zero-tests' };
  }
  // A visible failing exit status decides even for a narrowed check: a narrowed run that failed
  // is still a failed run, and only a passing one is weakened evidence.
  if (!cc.exitHidden && (isError === true || (typeof exitCode === 'number' && exitCode !== 0))) {
    if (cc.chained) {
      return { verdict: 'undetermined', reason: 'nonzero exit status of an && chain: another command may have failed', rule: 'chained-exit' };
    }
    return { verdict: 'failed', reason: `nonzero exit status${typeof exitCode === 'number' ? ` ${exitCode}` : ''}`, rule: 'exit-code' };
  }
  if (cc.narrowed) {
    return { verdict: 'undetermined', reason: 'check narrowed or weakened', rule: 'narrowed' };
  }
  if (cc.exitHidden) {
    // The tool result's exit status belongs to the pipe, not the runner: a printed exit code
    // (echo $?) or a passing runner summary decides, otherwise undetermined.
    const printed = printedExitCode(command, tail, cc.piped);
    if (printed !== undefined) {
      if (printed === 0) return { verdict: 'passed', reason: 'printed exit code 0', rule: 'printed-exit-code' };
      return cc.chained
        ? { verdict: 'undetermined', reason: `printed exit code ${printed} of an && chain: another command may have failed`, rule: 'chained-exit' }
        : { verdict: 'failed', reason: `printed exit code ${printed}`, rule: 'printed-exit-code' };
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
 * Length of the redirection operator that starts at `at`, or 0: `<`, `>`, `>>`, `>|`, `>&`, `<&`, `<>`, `<<`,
 * `<<-`, `<<<`, `&>` and `&>>`. `<(` and `>(` start a process substitution, which is a command of its own.
 */
function redirectionOperator(text, at) {
  const ch = text[at];
  const next = text[at + 1];
  if (ch === '&') return next === '>' ? (text[at + 2] === '>' ? 3 : 2) : 0;
  if (ch === '>') return next === '(' ? 0 : '>|&'.includes(next ?? ' ') ? 2 : 1;
  if (ch !== '<' || next === '(') return 0;
  if (next === '<') return text[at + 2] === '<' || text[at + 2] === '-' ? 3 : 2;
  return next === '&' || next === '>' ? 2 : 1;
}

/**
 * Split shell text into words, one pass. Quotes and backslashes are removed from a word (a quoted empty
 * string is an empty word); `null` marks where an unquoted `;`, `&`, `|`, `(`, `)`, backtick or newline ends
 * the words of a command. A redirection is no word and ends nothing: its operator, a file descriptor before it
 * (`2>`, `{fd}>`) and the word that is its target are dropped, and the other words stay one command
 * (`> out tee f` is `tee f`, `echo hi > out more` is `echo hi more`). A `#` that starts a word begins a
 * comment, which runs to the end of the line.
 */
function shellWords(text) {
  const out = [];
  let word = null;
  let target = false; // a redirection operator was read and its target word has not been
  const flush = () => {
    if (word !== null && !target) out.push(word);
    if (word !== null) target = false;
    word = null;
  };
  const boundary = () => {
    flush();
    target = false;
    if (out.at(-1) !== null) out.push(null);
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const operator = ch === '<' || ch === '>' || ch === '&' ? redirectionOperator(text, i) : 0;
    if (ch === '\\') {
      const next = text[i + 1] ?? '';
      if (next === '\n' || (next === '\r' && text[i + 2] === '\n')) i += next === '\n' ? 1 : 2; // a continuation joins lines
      else {
        word = (word ?? '') + next;
        i += 1;
      }
    } else if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      const end = close === -1 ? text.length : close;
      word = (word ?? '') + text.slice(i + 1, end);
      i = end;
    } else if (ch === '"') {
      let end = i + 1;
      let inner = '';
      while (end < text.length && text[end] !== '"') {
        if (text[end] === '\\' && end + 1 < text.length) end += 1;
        inner += text[end];
        end += 1;
      }
      word = (word ?? '') + inner;
      i = end;
    } else if (ch === '#' && word === null) {
      const lineEnd = text.indexOf('\n', i);
      i = lineEnd === -1 ? text.length : lineEnd - 1; // the newline itself is a boundary
    } else if (operator > 0) {
      if (word !== null && /^(?:\d+|\{[A-Za-z_]\w*\})$/.test(word)) word = null;
      else flush();
      target = true;
      i += operator - 1;
    } else if (ch === '\n' || ';&|()`<>'.includes(ch)) {
      boundary();
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      flush();
    } else {
      word = (word ?? '') + ch;
    }
  }
  flush();
  return out;
}

/** Stands for the files of an in-place edit that names none: they come from input, so they count as code. */
const UNKNOWN_TARGET = '(files from input)';

/**
 * Adds every item to the list one by one. `list.push(...items)` takes each item as an argument and overflows the call
 * stack on an array of about 150000 items, which a command with that many words gives.
 */
function pushAll(list, items) {
  for (const item of items) list.push(item);
}

/**
 * The files an in-place `sed` or `perl` edits, from the words after the program name: the operands that
 * remain once options and the script are skipped. The script is the first operand unless `-e`/`-E` (perl),
 * `-e`/`-f` or `--expression`/`--file` (sed) gave it. Options may come after operands; `--` ends them.
 * An in-place flag is `-i` anywhere in a short cluster (`-i`, `-ni`, `-pi.bak`, `-0777pi`), the rest of
 * the cluster being its suffix, or `--in-place[=SUFFIX]`. An empty word right after a bare sed `-i` is
 * its suffix (BSD form). An in-place edit with no file operand (`... | xargs sed -i 's/a/b/'`) gets
 * UNKNOWN_TARGET. Other commands give no targets.
 */
function inPlaceTargets(program, args) {
  const perl = program === 'perl';
  let inPlace = false;
  let hasScript = false;
  const operands = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') {
      pushAll(operands, args.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const name = arg.split('=')[0];
      if (!perl && name === '--in-place') inPlace = true;
      else if (!perl && (name === '--expression' || name === '--file')) hasScript = true;
      if (!perl && ['--expression', '--file', '--line-length'].includes(arg)) i += 1; // the value is the next word
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (let at = 1; at < arg.length; at += 1) {
        const flag = arg[at];
        const last = at === arg.length - 1;
        if (flag === 'i') {
          inPlace = true;
          if (!perl && last && args[i + 1] === '') i += 1;
          break;
        }
        if (perl ? flag === 'e' || flag === 'E' : flag === 'e' || flag === 'f') {
          hasScript = true;
          if (last) i += 1;
          break;
        }
        if (perl ? 'MmIFCdDx'.includes(flag) : flag === 'l') {
          if (last && !perl) i += 1;
          break;
        }
      }
    } else {
      operands.push(arg);
    }
  }
  if (!inPlace) return [];
  const files = (hasScript ? operands : operands.slice(1)).filter((operand) => operand !== '');
  return files.length > 0 ? files : [UNKNOWN_TARGET];
}

/**
 * Cut here-document bodies and their terminator lines out of shell text, so body text is never read as
 * shell. The rest of the line that holds the `<<TAG` operator stays (`cat <<EOF > src/a.ts`,
 * `cat <<EOF | tee f`): it still carries the redirections. Several operators on one line take their bodies
 * in order. An operator with no terminator line is left alone (`$((1 << 3))`), and `<<<` is a here-string.
 * Linear in the length of the text: one pass finds the operators, one pass lists the lines that start with a
 * word (a possible terminator) by that word, and every tag walks its own list forward only, because the
 * position that the next body starts at never moves back.
 */
function withoutHeredocBodies(text) {
  const operator = /(?<!<)<<(?!<)-?[ \t]*\\?(['"]?)(\w+)\1/g;
  const edits = []; // [start, end, replacement], sorted by start before they are applied
  let terminators = null; // tag -> { lines: [{ index, end }], next } for the lines `[ \t]*TAG` after a newline
  let lineEnd = -1; // the newline that ends the line of the operators being read
  let resume = -1; // the newline before the next body of that line
  for (let m = operator.exec(text); m !== null; m = operator.exec(text)) {
    if (m.index > lineEnd && m.index < resume) continue; // inside a body that is already cut
    if (m.index > lineEnd) {
      lineEnd = text.indexOf('\n', m.index + m[0].length);
      if (lineEnd === -1) break; // no line follows, so no body
      resume = lineEnd;
    }
    if (terminators === null) {
      terminators = new Map();
      for (const line of text.matchAll(/\n[ \t]*(\w+)/g)) {
        const entry = terminators.get(line[1]) ?? { lines: [], next: 0 };
        entry.lines.push({ index: line.index, end: line.index + line[0].length });
        terminators.set(line[1], entry);
      }
    }
    const tag = m[2];
    const entry = terminators.get(tag);
    if (entry === undefined) continue;
    while (entry.next < entry.lines.length && entry.lines[entry.next].index < resume) entry.next += 1;
    const found = entry.lines[entry.next];
    if (found === undefined) continue;
    edits.push([m.index, m.index + m[0].length, `<< ${tag} `], [resume, found.end, '']);
    resume = found.end;
  }
  let out = '';
  let from = 0;
  for (const [start, end, replacement] of edits.sort((a, b) => a[0] - b[0])) {
    out += text.slice(from, start) + replacement;
    from = end;
  }
  return out + text.slice(from);
}

/**
 * Words that run the command after them: launch wrappers and the reserved words that start a command
 * (`then`, `do`, `!`, `{` ...). Each has the options that take a value (`sudo -u root`) and the positional
 * words it takes before the command (`timeout 5`).
 */
const launcher = (values = [], positional = 0) => ({ values: new Set(values), positional });
const LAUNCH_WRAPPERS = new Map([
  ['sudo', launcher(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T', '-R'])],
  ['doas', launcher(['-u', '-C'])],
  ['env', launcher(['-u', '-C', '-S', '--unset', '--chdir'])],
  ['command', launcher()],
  ['nohup', launcher()],
  ['exec', launcher(['-a'])],
  ['time', launcher(['-f', '-o', '--format', '--output'])],
  ['nice', launcher(['-n', '--adjustment'])],
  ['timeout', launcher(['-s', '-k', '--signal', '--kill-after'], 1)],
  ['xargs', launcher(['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s', '--arg-file', '--delimiter', '--eof', '--max-args', '--max-lines', '--max-procs', '--max-chars'])],
  ...['!', '{', 'if', 'then', 'elif', 'else', 'do', 'while', 'until'].map((word) => [word, launcher()]),
]);

/** Words after which `find` runs a command of its own, and the words that end that command (a terminator, or the next one). */
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const FIND_EXEC_END = new Set([';', '+', ...FIND_EXEC]);

/** Shells whose `-c` argument is a command string, and the shell options that take a value. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const SHELL_VALUE_OPTIONS = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);

/** Command strings longer than this are not read again (nested shell text, limit of the extra work). */
const NESTED_MAX_LENGTH = 100000;
/** Levels of nested shell strings that are read: `sh -c "bash -c '...'"` is two. */
const NESTED_MAX_DEPTH = 2;

const baseName = (word) => word.slice(word.lastIndexOf('/') + 1);

/**
 * The index of the program word of a command that starts at `start`: assignments (`FOO=1`), launch wrappers
 * with their options (`sudo -u root`, `env -i`, `timeout 5`, `xargs -n 1`) and reserved words (`then`, `do`)
 * are skipped. A word that is not a string (a boundary or the end) ends the command.
 */
function programAt(words, start) {
  let at = start;
  for (;;) {
    const word = words[at];
    if (typeof word !== 'string') return at;
    if (/^[A-Za-z_]\w*\+?=/.test(word)) {
      at += 1;
      continue;
    }
    const wrapper = LAUNCH_WRAPPERS.get(baseName(word));
    if (wrapper === undefined) return at;
    at += 1;
    let positional = wrapper.positional;
    while (typeof words[at] === 'string') {
      const option = words[at];
      if (option === '--') {
        at += 1;
        break;
      }
      if (wrapper.values.has(option)) at += typeof words[at + 1] === 'string' ? 2 : 1;
      else if (option.startsWith('-') || /^\w+=/.test(option)) at += 1;
      else if (positional > 0) {
        positional -= 1;
        at += 1;
      } else break;
    }
  }
}

/**
 * The commands in `words` (from shellWords) as `{ at, end }`: the program word and the end of its arguments.
 * A command starts at the beginning of the text and after every boundary (`;`, `&`, `|`, `(`, a newline ...),
 * and `find -exec ...` starts one more. This is the one place where a word counts as a command: a command name
 * that only appears among the arguments of another command (`rg tee`, `echo sed -i`) is no command.
 */
function commandPrograms(words) {
  const found = [];
  const add = (start, stop) => {
    const at = programAt(words, start);
    if (typeof words[at] !== 'string') return;
    let end = at;
    while (typeof words[end] === 'string' && !(stop && stop.has(words[end]))) end += 1;
    found.push({ at, end });
    if (stop === undefined && baseName(words[at]) === 'find') {
      for (let k = at + 1; k < end; k += 1) if (FIND_EXEC.has(words[k])) add(k + 1, FIND_EXEC_END);
    }
  };
  for (let i = 0; i < words.length; i += 1) {
    if (words[i] !== null && (i === 0 || words[i - 1] === null)) add(i);
  }
  return found;
}

/**
 * The command strings that a shell or `su` runs in `programs` (from commandPrograms): `sh -c 'cmd'`, `bash -lc`,
 * `sudo sh -c`, `env FOO=1 bash -c`, `su user -c 'cmd'`, also by absolute path; `ssh host '...'` runs elsewhere
 * and is not read.
 */
function nestedCommandStrings(words, programs) {
  const found = [];
  for (const { at, end } of programs) {
    const program = baseName(words[at]);
    const isSu = program === 'su';
    if (!isSu && !SHELLS.has(program)) continue;
    let wantsString = false;
    for (let k = at + 1; k < end; k += 1) {
      const arg = words[k];
      if (isSu && arg.startsWith('--command=')) {
        found.push(arg.slice('--command='.length));
      } else if (isSu && arg === '--command') {
        wantsString = true;
      } else if (arg === '--') {
        if (!isSu) break;
      } else if (!isSu && SHELL_VALUE_OPTIONS.has(arg)) {
        k += 1;
      } else if (arg.length > 1 && (arg[0] === '-' || arg[0] === '+') && arg[1] !== '-') {
        if (/^-[A-Za-z]*c/.test(arg)) wantsString = true;
      } else if (arg.startsWith('--')) {
        continue;
      } else if (wantsString) {
        found.push(arg);
        wantsString = false;
        if (!isSu) break;
      } else if (!isSu) {
        break; // a script file: its text is not here
      }
    }
  }
  return found;
}

/** The files `tee` writes: its operands, once the options (and `--`) are skipped. */
function teeTargets(args) {
  const files = [];
  let options = true;
  for (const arg of args) {
    if (options && arg === '--') options = false;
    else if (arg !== '' && (!options || !arg.startsWith('-'))) files.push(arg);
  }
  return files;
}

/**
 * Options of the commands that write the file named by an argument. `short` lists the letters whose value is the
 * rest of the cluster or the next word (`-t src/`, `-tsrc/`, `-rt src/`), `long` the long options that take a
 * value (`--target-directory=src/` or `--target-directory src/`).
 */
const WRITE_COMMAND_OPTIONS = {
  cp: { short: 'tS', long: ['--target-directory', '--suffix'] },
  install: { short: 'tSmog', long: ['--target-directory', '--suffix', '--mode', '--owner', '--group'] },
  truncate: { short: 'sr', long: ['--size', '--reference'] },
};
const OPTION_NAMES = { t: '--target-directory', S: '--suffix', m: '--mode', o: '--owner', g: '--group', s: '--size', r: '--reference' };

/**
 * Split the arguments of a command into operands and options (name to value; a flag has the value ''). A short
 * option is named `-x`, except a value option, which gets the long name of OPTION_NAMES, and a long option may
 * be abbreviated to a unique prefix of a value option (`--target src/`). Options may follow operands; `--` ends
 * them. Every word is read once.
 */
function splitOptions(args, spec) {
  const operands = [];
  const options = new Map();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') {
      pushAll(operands, args.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const given = equals === -1 ? arg : arg.slice(0, equals);
      const name = spec.long.find((full) => full === given || (given.length > 2 && full.startsWith(given))) ?? given;
      if (equals !== -1) options.set(name, arg.slice(equals + 1));
      else if (spec.long.includes(name)) {
        options.set(name, args[i + 1] ?? '');
        i += 1;
      } else options.set(name, '');
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (let at = 1; at < arg.length; at += 1) {
        const letter = arg[at];
        if (!spec.short.includes(letter)) {
          options.set(`-${letter}`, '');
          continue;
        }
        const rest = arg.slice(at + 1);
        options.set(OPTION_NAMES[letter], rest !== '' ? rest : (args[i + 1] ?? ''));
        if (rest === '') i += 1;
        break;
      }
    } else {
      operands.push(arg);
    }
  }
  return { operands, options };
}

/**
 * The paths `cp`, `mv` and `install` write: the target directory of `-t` / `--target-directory`, else the last
 * operand when a source precedes it. A destination known to be a directory (`-t`, a trailing `/`, several
 * sources, unless `-T`) is joined with the name of each source, so `cp README.md src/` writes `src/README.md`
 * and `cp -t docs a.ts` writes `docs/a.ts`; with no source (`... | xargs cp -t src/`) the directory itself is the
 * target. `--help`, `--version` and `install -d` (it makes directories) write no file. `mv` also removes its
 * source, which counts as no write, like `rm`.
 */
function copyTargets(program, args) {
  const { operands, options } = splitOptions(args, WRITE_COMMAND_OPTIONS[program === 'install' ? 'install' : 'cp']);
  if (options.has('--help') || options.has('--version')) return [];
  if (program === 'install' && (options.has('-d') || options.has('--directory'))) return [];
  let destination;
  let sources;
  let directory;
  if (options.has('--target-directory')) {
    destination = options.get('--target-directory');
    sources = operands;
    directory = true;
  } else if (operands.length >= 2) {
    destination = operands.at(-1);
    sources = operands.slice(0, -1);
    directory = !options.has('-T') && !options.has('--no-target-directory') && (destination.endsWith('/') || sources.length > 1);
  } else {
    return [];
  }
  if (destination === '') return [];
  if (!directory) return [destination];
  const base = destination.replace(/\/+$/, '');
  const names = sources.map((source) => baseName(source.replace(/\/+$/, ''))).filter((name) => name !== '');
  return names.length > 0 ? names.map((name) => `${base}/${name}`) : [`${base}/`];
}

/**
 * The files `truncate` writes: its operands (the values of `-s` and `-r` are options). With no operand, a size or
 * reference still means files from input (`... | xargs truncate -s 0`); `--help` and a bare `truncate` write nothing.
 */
function truncateTargets(args) {
  const { operands, options } = splitOptions(args, WRITE_COMMAND_OPTIONS.truncate);
  if (options.has('--help') || options.has('--version')) return [];
  const files = operands.filter((operand) => operand !== '');
  if (files.length > 0) return files;
  return options.has('--size') || options.has('--reference') ? [UNKNOWN_TARGET] : [];
}

/** The files `dd` writes: the value of its `of=` operands. */
const ddTargets = (args) => args.filter((arg) => arg.startsWith('of=') && arg.length > 3).map((arg) => arg.slice(3));

/**
 * Files a shell command writes by redirection, `tee`, a heredoc with a target, an in-place `sed`/`perl` (its file
 * operands), or the destination of `cp`, `mv`, `install`, `truncate` and `dd of=`. A redirection is read by one
 * scan: a quoted string, an escaped character or a comment outside a target holds text, not a redirection
 * (`echo "a > b"`); a target is read as the shell reads it (quotes removed, `\ ` a space), so `> "README.md"`
 * names the file, not the quotes. The named commands count only as the command word of a command (see
 * commandPrograms), so `rg tee src/a.ts` and `echo cp a src/b.ts` write nothing. The string of a nested shell
 * (`sh -c '...'`, `sudo bash -lc`, `su -c`) is read again, two levels deep.
 */
function shellWriteTargets(command, depth = 0) {
  const QUOTED = String.raw`"(?:[^"\\]|\\[\s\S])*"|'[^']*'`; // a double-quoted string may hold \"
  const WORD = String.raw`(?:${QUOTED}|\\[^\n]|[^\s;&|)<>"'\\])+`;
  const { text, bodies } = splitSubstitutions(withoutHeredocBodies(command), '_');
  const targets = [];
  const unquote = (raw) => shellWords(raw).find((word) => word !== null && word !== '');
  const scan = new RegExp(
    String.raw`${QUOTED}|\\[^\n]|(?<=^|\s)#[^\n]*|(?<=^|[\s;&|("'])(?:\d+|\{[A-Za-z_]\w*\})?(>>|>\||>&|>)\s*(${WORD})`,
    'g',
  );
  for (const m of text.matchAll(scan)) {
    if (m[2] === undefined) continue;
    if (m[1] === '>&' && /^(?:\d+-?|-)$/.test(m[2])) continue; // `>&2` and `>&-` name a descriptor, not a file
    targets.push(unquote(m[2]));
  }
  const words = shellWords(text);
  const programs = commandPrograms(words);
  for (const { at, end } of programs) {
    const program = baseName(words[at]);
    if (program === 'tee') pushAll(targets, teeTargets(words.slice(at + 1, end)));
    else if (program === 'sed' || program === 'perl') pushAll(targets, inPlaceTargets(program, words.slice(at + 1, end)));
    else if (program === 'cp' || program === 'mv' || program === 'install') pushAll(targets, copyTargets(program, words.slice(at + 1, end)));
    else if (program === 'truncate') pushAll(targets, truncateTargets(words.slice(at + 1, end)));
    else if (program === 'dd') pushAll(targets, ddTargets(words.slice(at + 1, end)));
  }
  if (depth < NESTED_MAX_DEPTH) {
    for (const nested of [...nestedCommandStrings(words, programs), ...bodies]) {
      if (nested.length <= NESTED_MAX_LENGTH) targets.push(...shellWriteTargets(nested, depth + 1));
    }
  }
  return targets;
}

/**
 * Whether a tool call changes code. Write/Edit/MultiEdit/NotebookEdit change code unless the
 * file is ignored (docs, logs, lockfiles); NotebookEdit names its target in `notebook_path`, the others
 * in `file_path`. Bash changes code when its command writes files by
 * redirection, `tee`, heredoc with a target, in-place `sed`/`perl`, or `cp`/`mv`/`install`/`truncate`/`dd of=`
 * naming a destination, unless every target is ignored or a temp target (TEMP_DIRS, /dev/null, $TMPDIR)
 * holds no code either.
 * The project folder is not checked: the contract passes no working directory.
 * A command substitution inside double quotes (`echo "$(tee src/a.ts)"`) is quoted text and is not read;
 * an unquoted `$(...)` and backticks are.
 */
export function isMutation(toolName, toolInput) {
  if (typeof toolName !== 'string' || !toolName) return false;
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    const named = toolName === 'NotebookEdit' && typeof input.notebook_path === 'string' ? input.notebook_path : input.file_path;
    const path = typeof named === 'string' ? named : '';
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
