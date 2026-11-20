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

export const RULES_VERSION = '2026.11.20.8';

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

/** What bash passes on for a process substitution: the path of a descriptor. It names no file of a project (see TEMP_TARGET). */
const PROCESS_FILE = '/dev/fd/63';

/**
 * Replace every command substitution outside quotes (`$(...)`, a backtick pair) by `placeholder`, so the
 * substitution is one part of the word it stands in (`A=$(git rev-parse HEAD) npm test` has the assignment
 * value `A=_`) and its end opens no command position (`echo $(date) git commit` runs only echo). The bodies are
 * returned apart, for the callers that read them as commands of their own. A substitution with an empty body
 * (`$()`, two backticks) expands to nothing, so it leaves no word. A substitution that has no end runs to the
 * end of the text. One pass: a body is skipped once, then read again only at the next nesting level.
 *
 * With `processes` set, a process substitution (`<(...)`, `>(...)`, outside quotes) is read the same way: the word it stands in is
 * what bash passes on (a path of a descriptor), so `echo >(cat)` has one argument, `cmd > >(tee x)` redirects to no file of its own
 * and `tee >(cat) src/a.ts` keeps `src/a.ts` as an argument of `tee`; the body is a command of its own. A `#` comment holds no
 * substitution then (`echo x # >(tee f)`).
 */
function splitSubstitutions(text, placeholder, processes = false) {
  const bodies = [];
  let out = '';
  let from = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') i += 2;
    else if (processes && ch === '#' && (i === 0 || /[\s;&|(]/.test(text[i - 1]))) {
      const newline = text.indexOf('\n', i);
      i = newline === -1 ? text.length : newline;
    } else if (processes && (ch === '<' || ch === '>') && text[i + 1] === '(') {
      const end = matchingParenthesis(text, i + 2);
      out += text.slice(from, i) + PROCESS_FILE;
      bodies.push(text.slice(i + 2, end));
      i = end + 1;
      from = i;
    } else if (ch === "'") {
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
      if (!(ch === '$' && body.startsWith('(') && body.endsWith(')'))) bodies.push(body); // `$((1>2))` is arithmetic, not a command
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
 * or join the words around it into a runner name, and a quote inside it (the apostrophe of `"don't"`) cannot open a string of
 * its own. A `#` after an escaped space stays part of a word. A
 * command substitution outside quotes (`$(...)`, backticks) becomes `_` as a whole, so `A=$(x y) npm test`
 * keeps `npm test` as its command and the check inside a substitution (`echo $(npm test)`) names none.
 */
function executedText(command) {
  const plain = command
    .replace(/"[^"]*"|'[^']*'/g, (quoted) => quoted.slice(1, -1).replace(/[\s;&|#!<>()'"]/g, '_'))
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

/**
 * What each runner is asked to print, list or simulate instead of checking, one line per kind of word of a runner (the same text
 * form as the tables of the wrappers and of the in-place options). `info` is a word that makes the run print and check nothing
 * (`pytest -h`, `tsc --showConfig`, `eslint --env-info`); it counts alone or with `=value` (`--print-config=a.js`). `twice` is a
 * word that does so only when given twice (`pytest -VV`: a single `-V` runs the tests of pytest 9.0.3). `word` is a subcommand of
 * its own that prints or does nothing, read only as the first word behind the runner (`vitest list`, `webpack help`). `value` is an
 * option that takes the next word as its value, which is no option (`pytest -k -h`, `-o cache_dir=x -h`); `cluster` says that short
 * options may be glued (`-xh` is `-x -h`, and the first one that takes a value ends the word: `-kh` is `-k h`); `after` that the words
 * behind `--` are read too, because they go to a program behind the runner. The same short word means different things in different
 * programs (`-v` is the version of eslint, tsc, vitest, prettier and webpack, and the verbosity of pytest, cargo and `go test`;
 * `-V` is the version of mypy and mocha, and a single `-V` of pytest runs the tests), so a word counts only for the runners that
 * list it. A runner that is not listed is read for `-h` and for the long `--help` and `--version` of ASKS_ONLY. The words are those
 * of `--help` of pytest 9.0.3, ruff 0.15.12, mypy 2.4.1, black 26.10.1, flake8 7.5.0, pylint 4.1.4, tox 4.67.15, nox 2026.10.20,
 * vitest 4.1.11, eslint 9.39.2, tsc 5.9.3, prettier 3.8.1, jest 30.5.2, mocha 12.0.3, webpack 5.113.0 (webpack-cli 7.3.1), esbuild 0.27.2, vite 8.2.2 and node 20.19.2, and each was run
 * once to see that the program checks nothing with it (and, for each option of `value`, that the program takes `-h` as its value).
 * Not run, taken from the documentation of the program: cargo (`cargo test --help`; the words of the test harness behind `--`) and
 * go (`go help testflag`: `-c`, `-n`; the flag package gives a value to every option that is no boolean). Forms that list or collect
 * the tests without running them (`--collect-only`, `--list`, `--no-run`, `--dry-run`) are options that run no test, so they narrow the
 * run (SUBSET_OPTIONS): a failing exit status of one still decides, a zero one proves nothing.
 */
const INFO_TABLE_TEXT = `pytest info -h --markers --fixtures --funcargs --fixtures-per-test --cache-show --setup-plan --setup-only
pytest twice -V
pytest cluster
pytest value -k -m -c -p -o -W -r --rootdir --maxfail --tb --junitxml --deselect --ignore --ignore-glob --durations --basetemp --override-ini --config-file --import-mode --capture --color --log-level
ruff info -h --show-settings --show-files --add-noqa --diff
ruff value --select --ignore --extend-select --extend-ignore --config --target-version --line-length --output-format --exclude --per-file-ignores
ruff-format info -h
mypy info -h -V
mypy cluster
mypy value -p -m --python-version --config-file --python-executable --cache-dir --exclude
black info -h
black cluster
black value -l -t --line-length --target-version --config --include --exclude --extend-exclude --force-exclude --workers
flake8 info -h --bug-report
flake8 cluster
flake8 value --max-line-length --select --ignore --extend-ignore --exclude --config -j --jobs --format --output-file --max-complexity
pylint info -h --long-help --list-msgs --list-msgs-enabled --list-groups --list-conf-levels --list-extensions --generate-rcfile --generate-toml-config --full-documentation --help-msg
pylint cluster
pylint value --rcfile -j --jobs --disable --enable --ignore --output-format -f --py-version --reports
tox info -h --help-ini -l --listenvs -a --listenvs-all --notest --showconfig --sdistonly
tox cluster
tox value -e -c --workdir -x --discover --colored --result-json
nox info -h -l --list --list-sessions --install-only
nox cluster
nox value -s -k -t -f --noxfile --keywords --tags --report --default-venv-backend -db --download-python
vitest info -h -v --clearCache
vitest word list complete
vitest value -t --dir --project --shard --testNamePattern --exclude
eslint info -h -v --env-info --print-config --fix-dry-run
eslint value -c -f -o --config --format --output-file --rule --parser --ext --plugin --max-warnings --stdin-filename
prettier info -h -v --file-info --support-info --find-config-path
tsc info -h -v -V --all -all --showConfig --listFilesOnly --init --dry --clean
jest info -h -v --showConfig --clearCache
jest value -t --testNamePattern --testPathPattern
mocha info -h -V --list-reporters --list-interfaces
mocha value -g -f -R -r -t -s --grep --fgrep --reporter --require --timeout --slow --config --spec
webpack info -h -v
webpack word help version info configtest
webpack value -c --config --mode --env --stats --entry -o --output-path
esbuild info -h
node-test info -h -v --v8-options --completion-bash
node-check info -h -v --v8-options --completion-bash
cargo info -h
cargo after
go info -h -help -c -n
go value -run -bench -count -timeout -tags -parallel -cpu -skip -coverprofile -covermode -ldflags -gcflags -vet -p -o`;
const INFO_TABLE = new Map();
for (const line of INFO_TABLE_TEXT.split('\n')) {
  const [name, kind, ...words] = line.split(' ');
  const spec = INFO_TABLE.get(name) ?? { info: new Set(), twice: new Set(), word: new Set(), value: new Set(), cluster: false, after: false };
  if (kind === 'cluster' || kind === 'after') spec[kind] = true;
  else for (const word of words) spec[kind].add(word);
  INFO_TABLE.set(name, spec);
}
/** What a runner that is not in INFO_TABLE is read for: the short help words, which no runner of the rules below uses otherwise. */
const GENERIC_INFO = { info: new Set(['-h', '-?']), twice: new Set(), word: new Set(), value: new Set(), cluster: false, after: false };
/** A package manager or make runs a script of unknown content: the words behind its `--` go to the program of the script. */
const SCRIPT_INFO = { ...GENERIC_INFO, after: true };

/**
 * Whether the words behind a runner ask for information instead of a check (INFO_TABLE): the piece is a run that prints, lists or
 * simulates, so a zero exit status proves nothing about the code. `table` names the lines of the table the runner reads (`ruff format
 * --check` reads `ruff-format`: `--diff` prints the diff of `ruff check` and is a check of the format), `length` is the length of the
 * runner in the piece. The words are those after it; the words behind `--` are positional (`pytest -- -h` runs the tests of a file named `-h`), except for the runners
 * that pass them on (`after`).
 */
function asksInformation(piece, { runner, table, length }) {
  const spec = INFO_TABLE.get(table) ?? (SCRIPT_RUNNERS.has(runner) ? SCRIPT_INFO : GENERIC_INFO);
  const words = piece.slice(length).split(/\s+/).filter(Boolean);
  let twice = 0;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === '--') {
      if (!spec.after) break;
    } else if (i === 0 && spec.word.has(word)) {
      return true;
    } else if (word.startsWith('-') && word !== '-') {
      const name = word.replace(/=[\s\S]*$/, '');
      if (spec.info.has(name)) return true;
      if (spec.twice.has(name)) {
        twice += 1;
        if (twice > 1) return true;
      } else if (spec.value.has(word)) {
        i += 1;
      } else if (spec.cluster && /^-[A-Za-z]{2,}$/.test(word)) {
        for (let at = 1; at < word.length; at += 1) {
          const option = `-${word[at]}`;
          if (spec.info.has(option)) return true;
          if (spec.twice.has(option)) {
            twice += 1;
            if (twice > 1) return true;
          } else if (spec.value.has(option)) {
            if (at === word.length - 1) i += 1; // the value is the next word
            break;
          }
        }
      }
    }
  }
  return false;
}

/** `! npm test` exits 0 when the tests fail. */
const NEGATED = /^\s*!/;

/**
 * One redirection: an optional descriptor (`2`, `{fd}`), the operator and its target word, which may hold an
 * escaped space. A redirection is no argument and no command word: its target names a file, never a program. A digit descriptor
 * counts only at the start of a word (`echo a1>f` writes to `f` with the word `a1`), so a long run of digits is tried once, not at
 * every position.
 */
const REDIRECTION = String.raw`(?:(?<!\S)\d+|\{[A-Za-z_]\w*\})?(?:&>>?|>>|>\||>&|<&|<>|<<<|<<-?|>|<)(?!\()\s*(?:\\[\s\S]|[^\s\\])+`;
const ASSIGNMENT = String.raw`[A-Za-z_][A-Za-z0-9_]*\+?=(?:\\[\s\S]|[^\s\\])*`; // `A+=x` appends; the value may hold an escaped space
const LEADING_REDIRECTIONS = new RegExp(String.raw`^(?:(?:${ASSIGNMENT}|${REDIRECTION})\s+)+`);
const ALL_REDIRECTIONS = new RegExp(REDIRECTION, 'g');

/**
 * Launch wrappers that are taken off in front of the command word. A wrapper does not change what the command behind it does,
 * so `sudo git commit` and `timeout 60 npm test` read like the bare command. The table below is the same text in
 * check_classifier.mjs and in the Python tools of this directory that look for a command word (each tool is a standalone
 * script, and a test compares the copies). One line per kind of option of a wrapper: `flag` takes no value, `value` takes the
 * next word or the rest of the word (`-uroot`, `--user=root`), `optional` takes a value only as `--name=value`, `number` is an
 * option that is a number (`nice -5`), `stop` means that the wrapper then runs no command (`sudo -l`, `command -v`, `--help`),
 * `assign` that `NAME=VALUE` words may follow the options (`env`, `sudo`, `time`: behind the others the shell would run
 * `NAME=VALUE`), `duration` that a duration comes before the command (a number as strtod reads it, with an optional s, m, h or
 * d). The options are those of `--help` of sudo 1.9.16, GNU coreutils 9.7 (timeout, nice, env, nohup), bash 5.2 (`help
 * command`, `help exec`) and GNU time (the man page of time(1)). Short options may be glued (`-nu root`), a long option may be
 * abbreviated to a name that is unique in the wrapper (`--adj=3`), and `--` ends the options. A wrapper with no command behind
 * it, a `stop` option, a bad duration and an assignment behind a wrapper that takes none end the reading: no command runs, so
 * none is read. At most eight wrappers in a row are taken off. An option that is not in the table ends the reading too: the
 * wrapper stays the program word and nothing is guessed. The finder of commands that write files (programAt) skips such an
 * option as a flag without a value instead, so that a write behind an option the table does not know is still found.
 */
const LAUNCH_TABLE_TEXT = `sudo assign
sudo flag -A -b -B -E -H -i -k -N -n -P -S -s --askpass --background --bell --login --no-update --non-interactive --preserve-groups --reset-timestamp --set-home --shell --stdin
sudo value -C -D -g -h -p -R -r -T -t -U -u --chdir --chroot --close-from --command-timeout --group --host --other-user --prompt --role --type --user
sudo optional --preserve-env
sudo stop -e -K -l -V -v --edit --help --list --remove-timestamp --validate --version
nohup stop --help --version
command flag -p
command stop -V -v
exec flag -c -l
exec value -a
nice number
nice value -n --adjustment
nice stop --help --version
time assign
time flag -a -p -q -v --append --portability --quiet --verbose
time value -f -o --format --output
time stop -V -h --help --version
timeout duration
timeout flag -f -p -v --foreground --preserve-status --verbose
timeout value -k -s --kill-after --signal
timeout stop --help --version
env assign
env flag - -i -S -v --debug --ignore-environment --list-signal-handling --split-string
env value -a -C -u --argv0 --chdir --unset
env optional --block-signal --default-signal --ignore-signal
env stop -0 --help --null --version`;
const LAUNCH_TABLE = new Map();
for (const line of LAUNCH_TABLE_TEXT.split('\n')) {
  const [name, kind, ...options] = line.split(' ');
  const spec = LAUNCH_TABLE.get(name) ?? { flag: new Set(), value: new Set(), optional: new Set(), stop: new Set(), long: [], assign: false, duration: false, number: false };
  if (kind === 'assign' || kind === 'duration' || kind === 'number') spec[kind] = true;
  else for (const option of options) {
    spec[kind].add(option);
    if (option.startsWith('--')) spec.long.push(option);
  }
  LAUNCH_TABLE.set(name, spec);
}
/** A duration as strtod reads it (a decimal or hex number, `inf`) with an optional unit; no nested repeats, so it matches in linear time. */
const DURATION = /^\+?(?:(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|0[xX](?:[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+)(?:[pP][+-]?[0-9]+)?|[iI][nN][fF](?:[iI][nN][iI][tT][yY])?)[smhd]?$/;
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const MAX_WRAPPERS = 8;

/**
 * How many words the option `word` of the wrapper takes: 1, or 2 when its value is the next word; 0 when the wrapper then runs no
 * command; -1 when the option is not in the table.
 */
function optionWidth(word, spec) {
  if (spec.number && /^--?[0-9]+$/.test(word)) return 1;
  if (word.startsWith('--')) {
    const at = word.indexOf('=');
    const given = at === -1 ? word : word.slice(0, at);
    const named = spec.long.includes(given) ? [given] : spec.long.filter((full) => full.startsWith(given));
    if (named.length !== 1) return -1;
    if (spec.stop.has(named[0])) return 0;
    return at === -1 && spec.value.has(named[0]) ? 2 : 1;
  }
  for (let at = 1; at < word.length; at += 1) {
    const option = `-${word[at]}`;
    if (spec.stop.has(option)) return 0;
    if (spec.value.has(option)) return at + 1 < word.length ? 1 : 2;
    if (!spec.flag.has(option)) return -1;
  }
  return 1;
}

/**
 * The index of the command word behind the launch wrapper of LAUNCH_TABLE at word `at`, or -1 when no command runs behind it.
 * `wordAt(i)` is the word at index i, or anything but a string when the command ends there. An option that is not in the table
 * ends the reading, or is skipped as a flag without a value when `skipUnknown` is set.
 */
function launchCommandIndex(wordAt, at, skipUnknown) {
  const spec = LAUNCH_TABLE.get(baseName(wordAt(at)));
  let durations = spec.duration ? 1 : 0;
  let options = true;
  for (let index = at + 1; ;) {
    const word = wordAt(index);
    if (typeof word !== 'string') return -1;
    if (options && word === '--') {
      options = false;
      index += 1;
    } else if (options && word.startsWith('-') && (word.length > 1 || spec.flag.has(word))) {
      let width = optionWidth(word, spec);
      if (width < 0 && skipUnknown) width = 1;
      if (width <= 0 || (width === 2 && typeof wordAt(index + 1) !== 'string')) return -1;
      index += width;
    } else if (durations > 0) {
      if (!DURATION.test(word)) return -1;
      durations -= 1;
      options = false;
      index += 1;
    } else if (ASSIGNMENT_WORD.test(word) && !spec.assign) {
      return -1;
    } else {
      return index; // an assignment behind a wrapper that takes one is read by the caller, which skips assignments
    }
  }
}

const SKIP_UNKNOWN_OPTION = new Set(['env', 'timeout']);

/** Take one launch wrapper and its options off the front of `text`; the text is returned as it is when it starts with none, or none runs a command. */
function stripLaunchWrapper(text) {
  const found = [];
  const blank = /\S+/g;
  const wordAt = (index) => {
    while (found.length <= index) {
      const match = blank.exec(text);
      if (match === null) return undefined;
      found.push(match);
    }
    return found[index][0];
  };
  const first = wordAt(0);
  if (first === undefined || !LAUNCH_TABLE.has(baseName(first))) return text;
  // As before the table, `env` and `timeout` take any option that starts with a dash as a flag; the others end the reading at one that is not in the table.
  const command = launchCommandIndex(wordAt, 0, SKIP_UNKNOWN_OPTION.has(baseName(first)));
  return command === -1 ? text : text.slice(found[command].index);
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
  for (let i = 0; i < MAX_WRAPPERS; i += 1) {
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
  { kind: 'lint', runner: 'ruff', re: /^ruff\s+check\b/ },
  { kind: 'lint', runner: 'ruff', table: 'ruff-format', re: /^ruff\s+format\s+--check\b/ },
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
    const found = rule.re.exec(piece);
    if (found !== null) return { kind: rule.kind, runner: rule.runner, table: rule.table ?? rule.runner, length: found[0].length };
  }
  return null;
}

/**
 * Flags that weaken a check (`vitest --passWithNoTests` passes a suite with no tests at all) apply to every
 * kind. Options that select a subset of the tests, or none, apply to tests only, where a subset run proves
 * less. The subset options are listed per runner (SUBSET_OPTIONS); a token names one when it equals the
 * option or starts with `option=` or `option:` (`-run=X`, `-only-testing:Suite`).
 */
const WEAKEN = /^(?:--passWithNoTests|--pass-on-no-patterns|--exclude|--testPathIgnorePatterns|--exit-zero|--noCheck)(?:=|$)/;

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
  rspec: ['-t', '-e', '--example', '-E', '--example-matches', '--tag', '--only-failures', '--next-failure', '--pattern', '--exclude_pattern'],
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
const COMMON_SUBSET = ['--testNamePattern', '-k', '--skip', '-run'];
/**
 * A package manager or make runs a script of unknown content, so the options behind its script word are read for the long options
 * of every runner and for the short ones that no package manager uses itself, except `--run`: for vitest it only ends the watch
 * mode (`npm test -- --run`), and go reads it only at `go test`. `-t` names a test in jest and vitest, the common runners behind a
 * script.
 */
const SCRIPT_SUBSET = new Set([
  ...COMMON_SUBSET, '-t', '-m', '-g',
  ...Object.values(SUBSET_OPTIONS).flat().filter((name) => name.startsWith('--') && name !== '--run'),
]);
const SUBSET_SETS = new Map(Object.entries(SUBSET_OPTIONS).map(([runner, names]) => [runner, new Set([...COMMON_SUBSET, ...names])]));
/** pytest and unittest read `-kEXPR`, `-mMARK` and a cluster that ends in the option (`-xk EXPR`). */
const PYTEST_SHORT_VALUE = /^-(?:[km].+|[A-Za-z]+[km])$/;

/** cargo test options that narrow the run, and the options that take the next word as their value. */
const CARGO_SUBSET = new Set([
  '--lib', '--bins', '--bin', '--tests', '--test', '--examples', '--example', '--benches', '--bench', '--doc', '-p', '--package',
  '--skip', '--ignored', '--list', '--no-run', '--partition', '-E', '--filter-expr', '--run-ignored',
]);
const CARGO_VALUE_OPTIONS = new Set([
  '-p', '--package', '--exclude', '-F', '--features', '--target', '--profile', '--target-dir', '--manifest-path', '--color',
  '--message-format', '-j', '--jobs', '--config', '-Z', '--bin', '--test', '--example', '--bench', '--test-threads', '--format',
  '--logfile', '--skip', '--shuffle-seed',
  // cargo nextest run: options that take a value and select no tests (`--retries 2`), and the ones that select (`-E`, `--partition`)
  '--retries', '--flaky-result', '--max-fail', '--failure-output', '--success-output', '--status-level', '--final-status-level',
  '--cargo-profile', '--build-jobs', '--config-file', '--tool-config-file', '-P', '--archive-file', '--extract-to',
  '--cargo-message-format', '--message-format-version', '--user-config-file', '--stress-count', '--stress-duration',
  '--show-progress', '--partition', '-E', '--filter-expr', '--run-ignored',
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

/**
 * The tokens that are read for subset options. `--dir` before the script word is the directory option of the package manager
 * (`pnpm --dir pkg test`), which selects no test; behind the script word it is the option of the runner (`vitest --dir x`).
 */
function optionTokens(tokens, runner) {
  if (!SCRIPT_RUNNERS.has(runner)) return tokens;
  const at = tokens.findIndex((token, index) => index > 0 && !token.startsWith('-') && /^(?:test|check)\b/.test(token));
  return at === -1 ? tokens : tokens.filter((token, index) => index > at || !/^--dir(?:=|$)/.test(token));
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
  if (optionTokens(tokens, runner).some((t) => selectsSubset(t, runner))) return true;
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

/** Whether a command that stands before the pipeline of the check in its `&&` chain can fail (`cd v3 && npm test | tail`). */
function sharesExitStatusBefore(pieces, index) {
  let first = index;
  while (first > 0 && pieces[first - 1].sep === '|') first -= 1;
  for (let at = first - 1; at >= 0 && pieces[at].sep === '&&'; at -= 1) {
    if (pieces[at].text !== '' && !NEVER_FAILS.test(pieces[at].text)) return true;
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
  return readCommand(command).result;
}

/** The classification of a command with what classifyCheckResult reads next to it: the shell pieces, the index of the check in them and every runner piece. */
function readCommand(command) {
  if (typeof command !== 'string' || command === '') {
    return { pieces: [], checkIndex: -1, result: { isCheck: false, kind: null, runner: null, narrowed: false, exitHidden: false, chained: false, piped: false, pipefail: false, reason: 'empty or non-string command' } };
  }
  // A here-document body is input, not shell (it is cut out before the lines are joined, as isMutation reads it).
  const bare = executedText(joinContinuations(withoutHeredocBodies(command)));
  // Only a `set` statement changes the option; the last one wins.
  const pipefail = [...bare.matchAll(/(?:^|[;&\n])\s*set\s+([+-])\w*o\s+pipefail\b/g)].at(-1)?.[1] === '-';
  const pieces = shellPieces(bare);
  let check = null;
  let hidden;
  const checks = [];
  for (let i = 0; i < pieces.length; i += 1) {
    const stripped = stripWrappers(pieces[i].text);
    if (stripped === null) continue;
    if (PRINTS_OR_INSPECTS.test(stripped) || ASKS_ONLY.test(stripped) || NEGATED.test(stripped)) continue;
    const m = runnerMatch(stripped);
    if (!m || asksInformation(stripped, m)) continue;
    check = { ...m, index: i };
    checks.push({ runner: m.runner, kind: m.kind, index: i });
    hidden = exitHiddenCause(pieces, i, pipefail);
    // later runner pieces overwrite: the command's status belongs to the last segment
  }
  if (!check) {
    return { pieces, checks, checkIndex: -1, result: { isCheck: false, kind: null, runner: null, narrowed: false, exitHidden: false, chained: false, piped: false, pipefail, reason: 'no check runner in command' } };
  }
  const strippedCheck = stripWrappers(pieces[check.index].text);
  const narrowed = pieceNarrows(strippedCheck, check.kind, check.runner);
  // A `trap` can end the shell with a status of its own (`trap 'exit 0' EXIT; npm test`): no exit status is the check's then.
  if (hidden === undefined && pieces.some((piece) => /^trap(?:\s|$)/.test(piece.text))) hidden = 'trap';
  const reason = hidden
    ? `check exit code hidden (${hidden})`
    : 'check command recognized';
  const chained = sharesExitStatus(pieces, check.index, pipefail);
  const piped = pieces[check.index].sep === '|' && !pipefail;
  return { pieces, checks, checkIndex: check.index, result: { isCheck: true, kind: check.kind, runner: check.runner, narrowed, exitHidden: hidden !== undefined, chained, piped, pipefail, reason } };
}

/**
 * Runner summary rules: anchored rules read from the tail of tool output. Deliberately narrow:
 * only node:test, pytest, ruff (with mypy and biome counts), eslint, tsc, vitest and the failures of jest, the runners
 * chosen for their stable summary lines. Other runners stay undetermined when their exit status is hidden.
 * The output can hold several summaries (a script that runs two commands, a package manager that runs several packages, a loop),
 * and each rule reads all of them in the tail: a failure in any one decides `failed` however many passed summaries stand before
 * it, and a pass needs a summary with no failure among them. The rules of different runners are all read before a pass is taken.
 */
const SUMMARY_RULES = [
  // node:test: a `ℹ fail N` line (the spec reporter, which a terminal gets) or a `# fail N` line (the TAP reporter, the default
  // when the output is piped) with N above 0 is a failure, N equal 0 a pass, unless a test was cancelled (a timeout, a promise
  // that never settles): the run exits 1 and the cancelled count, which stands behind the fail count, is the only sign of it. A
  // script that runs node:test twice prints two summaries, so every fail and cancelled count is read, not the first.
  {
    runner: 'node-test',
    rule: 'node-test-fail-count',
    apply: (tail) => {
      const fails = [...tail.matchAll(/(?:[ℹi] |^[ \t]*# )fail (\d+)/gm)];
      if (fails.length === 0) return null;
      return fails.some((m) => Number(m[1]) > 0) || /(?:[ℹi] |^[ \t]*# )cancelled [1-9]\d*\b/m.test(tail) ? 'failed' : 'passed';
    },
  },
  // pytest: `===== 3 failed, 5 passed in 0.2s =====` / `===== 5 passed in 0.2s =====`. The counts stand in the order of pytest's
  // own categories, so an error count may come behind the passed count (`1 passed, 1 error`: a teardown failed and the exit status
  // is 1). The whole line is read for a failed or error count first; a pass needs a passed count and counts of nothing but words.
  {
    runner: 'pytest',
    rule: 'pytest-summary-line',
    apply: (tail) => {
      let passed = false;
      let unclear = false;
      for (const line of tail.matchAll(/^=+ ([^=\n]*?) in [\d.]+s(?: \(\d+:\d{2}:\d{2}\))? =*$/gm)) {
        const counts = line[1];
        if (/(?:^|, )[1-9]\d* (?:[\w-]+ )*(?:failed|errors?)(?=,|$)/.test(counts)) return 'failed';
        if (/^\d+ [a-z-]+(?: [a-z-]+)*(?:, \d+ [a-z-]+(?: [a-z-]+)*)*$/.test(counts) && /(?:^|, )[1-9]\d* passed(?=,|$)/.test(counts)) passed = true;
        else unclear = true; // a summary that is no pass (nothing passed, a count of a word it does not know) holds the pass back
      }
      return passed && !unclear ? 'passed' : null;
    },
  },
  // vitest: a test file that failed to load (`Test Files N failed`) fails the run even when the `Tests` line reads as passed, and
  // so do the lines behind it that count unhandled errors (`Errors  1 error`), type errors and leaks; then the counts on their
  // own line, two spaces in, no colon.
  {
    runner: 'vitest',
    rule: 'vitest-tests-line',
    apply: (tail) => {
      if (/^\s*(?:\S+:\s*)?Test Files\s+[^\n]*?\b[1-9]\d* failed\b/m.test(tail)) return 'failed';
      if (/^\s*(?:\S+:\s*)?(?:(?:Type )?Errors|Leaks)\s+[1-9]\d* (?:errors?|leaks?|failed)\b/m.test(tail)) return 'failed';
      const lines = [...tail.matchAll(/^\s*Tests\s{2,}([^\n]*\(\d+\))\s*$/gm)];
      if (lines.length === 0) return null;
      return lines.some((m) => /\d+ failed/.test(m[1])) ? 'failed' : 'passed';
    },
  },
  // jest has no pass rule (its pass stays with the exit status), but a failure in its summary is read, so that a script which runs it
  // behind a passed node:test or vitest summary is not taken for a pass: `Tests:       1 failed, 1 passed, 2 total`.
  {
    runner: 'jest',
    rule: 'jest-summary-failure',
    apply: (tail) => (/^[ \t]*Test(?:s| Suites):[^\n]*?\b[1-9]\d* failed\b/m.test(tail) ? 'failed' : null),
  },
  // eslint exits 0 on warnings alone, so the error count is the verdict, not the problem count; with `--max-warnings` the warnings
  // fail the run, which the line behind the summary says.
  {
    runner: 'eslint',
    rule: 'eslint-problems-line',
    apply: (tail) => {
      if (/^ESLint found too many warnings\b/m.test(tail)) return 'failed';
      const lines = [...tail.matchAll(/^[✖x✗] \d+ problems? \((\d+) errors?, (\d+) warnings?\)/gm)];
      if (lines.length === 0) return null;
      return lines.some((m) => Number(m[1]) > 0) ? 'failed' : 'passed';
    },
  },
  // ruff, mypy and biome all count the same way, so one rule reads all three; a failure is looked for before a pass is accepted.
  // A fixing run counts the errors it fixed together with the ones that remain (`Found 3 errors (2 fixed, 1 remaining).`): only the
  // remaining count is the verdict, so a line that says nothing remains (`Found 1 error (1 fixed, 0 remaining).`) is no failure and
  // no pass either: the exit status decides, and a hidden one leaves the run undetermined. `Would fix N errors.` (`--diff`) is a run
  // that left errors in the files, as `Would reformat:` of the format check is.
  {
    runner: 'ruff',
    rule: 'ruff-found-errors',
    apply: (tail) => {
      if ([...tail.matchAll(/^Found [1-9]\d* errors? \(\d+ fixed, (\d+) remaining\)/gm)].some((m) => Number(m[1]) > 0)) return 'failed';
      // `ruff format --check` prints the files it would change; its line can stand behind `All checks passed!` of `ruff check`.
      if (/^(?:Found [1-9]\d* errors?(?! \(\d+ fixed, \d+ remaining\))\b|Would fix [1-9]\d* errors?\b|Would reformat: |[1-9]\d* files? would be reformatted)/m.test(tail)) return 'failed';
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
  { reader: 'node-test', zero: /(?:ℹ|^#) tests 0\b/im, ran: /(?:ℹ|^#) tests [1-9]\d*\b/m },
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

/** Whether a runner piece has a summary rule to be read by: its own readers include a runner of SUMMARY_RULES. */
function hasSummaryRule(check) {
  const readers = readersFor(check);
  return SUMMARY_RULES.some((entry) => readers.has(entry.runner));
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

/**
 * The variables that hold a status: `$?` (also `${?}`) and the element of `PIPESTATUS` (`${PIPESTATUS[1]}`; `$PIPESTATUS` and
 * `${PIPESTATUS}` are element 0).
 */
const STATUS_VAR = /\$\?|\$\{\?\}|\$\{PIPESTATUS\[(\d+)\]\}|\$\{PIPESTATUS\}|\$PIPESTATUS(?![A-Za-z0-9_])/g;

/**
 * What an `echo` or `printf` piece prints, with the status variables left in the text; undefined when the piece prints no
 * such text or cannot be told. The words are those of the neutralized command (executedText), where a quoted space is `_`.
 * `printf` is read with the conversions `%s`, `%d`, `%i` and `%%`, each `%s`, `%d` and `%i` taking one argument.
 */
function printedText(text) {
  const words = text.split(/\s+/);
  const program = baseName(words[0]);
  let literal;
  if (program === 'echo') {
    let at = 1;
    while (/^-[neE]+$/.test(words[at] ?? '')) at += 1;
    literal = words.slice(at).join(' ');
  } else if (program === 'printf') {
    const [, format = '', ...args] = words;
    let used = 0;
    let known = true;
    literal = format.replace(/%(.)/g, (whole, spec) => {
      if (spec === '%') return '%';
      if (spec !== 's' && spec !== 'd' && spec !== 'i') known = false;
      else if (args[used] === undefined) known = false;
      else return args[used++];
      return whole;
    });
    if (!known || used !== args.length) return undefined;
  } else return undefined;
  return literal.replace(/\\n/g, '');
}

/**
 * The status a command prints for the check, read from the output tail (`echo "EXIT=$?"` printing `EXIT=3`), or undefined. Only a
 * hidden exit status needs it, and only a print that belongs to the check is read: the check, or the pipeline it stands in, must
 * be followed directly by the print (after `;`, a newline or `&&`), so that nothing runs in between that sets `$?` (`true`,
 * `cd`, `echo`, a block, another command), the check must run whatever comes before it (`true || npm test` never runs it), and
 * the print writes to the output (a redirection sends it away). `$?` is the status of the last command of a pipeline, so it
 * belongs to the check when the check is that command or `pipefail` is set; `${PIPESTATUS[n]}` belongs to it when n is the
 * position of the check in its pipeline. A second print of a status later in the command could repeat the text, so it makes the
 * output ambiguous. `viaPipestatus` is set when the number is the element of `PIPESTATUS`, which is the check's own status.
 */
function printedExitCode(pieces, index, pipefail, tail) {
  let first = index;
  while (first > 0 && pieces[first - 1].sep === '|') first -= 1;
  let last = index;
  while (last < pieces.length - 1 && pieces[last].sep === '|') last += 1;
  if (!['&&', ';', '\n'].includes(pieces[last].sep)) return undefined; // `&` backgrounds the check, `||` runs the print for a failure only
  for (let at = first - 1; at >= 0 && ['&&', '||'].includes(pieces[at].sep); at -= 1) {
    if (pieces[at].sep === '||') return undefined;
  }
  let next = last + 1;
  while (pieces[next]?.text === '' && pieces[next].sep === '\n') next += 1; // a blank line runs nothing
  const printed = pieces[next];
  if (printed === undefined || /[<>]/.test(printed.text)) return undefined;
  const literal = printedText(printed.text);
  if (literal === undefined || literal.length > 1000) return undefined; // a longer text is no print of a status, and its pattern would be huge
  const hasStatus = (text) => /^(?:\S*\/)?(?:echo|printf)\s/.test(text) && new RegExp(STATUS_VAR.source).test(text);
  if (pieces.slice(next + 1).some((piece) => hasStatus(piece.text))) return undefined;
  let source = '';
  let from = 0;
  const own = []; // for each group of the pattern: how the variable belongs to the check, or null
  const part = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '[\\s;&|#!<>()\'"_]'); // `_` stands for any neutralized character
  for (const match of literal.matchAll(STATUS_VAR)) {
    source += `${part(literal.slice(from, match.index))}(\\d+)`;
    from = match.index + match[0].length;
    if (match[0].includes('PIPESTATUS')) own.push(Number(match[1] ?? 0) === index - first ? 'pipestatus' : null);
    else own.push(last === index || pipefail ? 'last' : null);
  }
  if (own.every((kind) => kind === null)) return undefined;
  source += part(literal.slice(from));
  const preferred = own.includes('pipestatus') ? 'pipestatus' : 'last';
  const group = own.indexOf(preferred) + 1;
  let code;
  for (const found of tail.matchAll(new RegExp(`^\\s*${source}\\s*$`, 'mg'))) code = Number(found[group]);
  return code === undefined ? undefined : { code, viaPipestatus: preferred === 'pipestatus' };
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
  const read = readCommand(command);
  const cc = read.result;
  if (!cc.isCheck) {
    return { verdict: 'undetermined', reason: 'not a check command', rule: null };
  }
  // Every runner piece of the command is read (`eslint . ; vitest run`), not the last one only.
  const readers = new Set(read.checks.flatMap((check) => [...readersFor(check)]));
  // A script of unknown content (`npm test`) may print the failure of a runner that its kind does not read (`eslint . && vitest run`).
  // Such a line is no failure of the check, since a passing run can print it as data, but it holds a pass back: the verdict is then
  // undetermined. The generic line of ruff (`Found 3 errors.`) is not looked for: it is too often data.
  const heldBack = read.checks.some((check) => SCRIPT_RUNNERS.has(check.runner))
    && SUMMARY_RULES.some((entry) => entry.runner !== 'ruff' && !readers.has(entry.runner) && entry.apply(tail) === 'failed');
  const pass = (reason, rule) => (heldBack
    ? { verdict: 'undetermined', reason: 'runner summary of another runner reports a failure', rule: 'foreign-summary-failure' }
    : { verdict: 'passed', reason, rule });
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
    const printed = printedExitCode(read.pieces, read.checkIndex, cc.pipefail, tail);
    if (printed !== undefined) {
      // The element of PIPESTATUS is the status of the check itself: only the commands before its pipeline can have failed in its place.
      const chained = printed.viaPipestatus ? sharesExitStatusBefore(read.pieces, read.checkIndex) : cc.chained;
      if (printed.code === 0) return pass('printed exit code 0', 'printed-exit-code');
      return chained
        ? { verdict: 'undetermined', reason: `printed exit code ${printed.code} of an && chain: another command may have failed`, rule: 'chained-exit' }
        : { verdict: 'failed', reason: `printed exit code ${printed.code}`, rule: 'printed-exit-code' };
    }
    // A pass is read from the summary of the last runner of the command only: the output that ends the stream is its output, and the
    // summary of an earlier runner (`ruff check . && python3 -m unittest | tail`) says nothing about it. An earlier runner that no rule
    // reads has its status behind `&&` only: when a `;`, a `||` or a pipe stands between it and the last runner, it may have failed unseen.
    const last = read.checks.at(-1);
    let cut = last.index - 1;
    while (cut >= 0 && read.pieces[cut].sep === '&&') cut -= 1;
    const unseen = read.checks.some((check) => check !== last && check.index <= cut && !hasSummaryRule(check));
    if (!unseen) {
      const lastReaders = readersFor(last);
      for (const entry of SUMMARY_RULES.filter((rule) => lastReaders.has(rule.runner))) {
        const verdict = entry.apply(tail);
        if (verdict === 'passed') {
          return pass(`runner summary pass (${entry.rule})`, entry.rule);
        }
      }
    }
    return { verdict: 'undetermined', reason: 'check exit code hidden without pipefail and no runner summary', rule: null };
  }
  // Visible exit status, not failing (the failing case returned above): passed.
  return pass('zero or absent exit status with no error flag', 'exit-code-zero');
}

/** Files whose edits never need a passing check: docs, images, lockfiles, logs, installed packages. */
const IGNORE = /(^|\/)docs?\/|(^|\/)(node_modules|\.venv|__pycache__|coverage|\.cache|\.git)(\/|$)|\.(md|mdx|txt|rst|adoc|svg|png|jpe?g|gif|ico|webp|lock|log)$/i;

/** Package-manager lockfiles keep their JSON/YAML extension, so they are named apart. */
const LOCKFILE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml)$/;

/**
 * Writes to temp directories, the device files (`/dev/null`, `/dev/stderr`, `/dev/fd/3`, `/dev/tcp/host/port`; bash opens a
 * descriptor or a socket there and makes no file), or $TMPDIR hold no code.
 */
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TEMP_TARGET = new RegExp(
  `^(?:${TEMP_DIRS.map(escapeRe).join('|')})(?:/|$)|^/dev/(?:null|zero|full|tty|stdin|stdout|stderr|fd/\\d+|(?:tcp|udp)/.*)$|^\\s*["']?\\$TMPDIR\\b`,
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
 * The options of `sed` and `perl` that matter for an in-place edit, as one text that stands in this script and in the user
 * prohibitions tool (a test compares the two copies). One line per kind of option of a program. `flag` takes no value; `value`
 * takes the rest of the word or, when the word ends there, the next word (`-e SCRIPT`, `-eSCRIPT`; a long one is `--name=value`
 * or `--name value`); `optional` takes the rest of the word and never the next one (`-i.bak`, `--in-place=.bak`, `-F:`); `octal`
 * takes the octal digits that follow (`-l012`, `-0777`); `stop` means that the program prints text and exits without running
 * (`--help`, `-v`). Three more lines mark what an option means: `script` gives the script, `inplace` edits the
 * files in place, `quiet` is `-n`. The options are those of `sed --help` (GNU sed 4.9) and of perlrun (perl 5.40). Short options
 * may be glued in one word (`-nEi`; the first one that takes the rest ends the word, so `-ie` is `-i` with the suffix `e`), a
 * long option of sed may be abbreviated to a name that is unique (`--in-pl`), perl has no long options, and `--` ends the options.
 * sed takes options between the operands as well, perl stops at its first operand when no `-e` gave the script. An option that is
 * not in the table is skipped as a flag.
 */
const EDIT_TABLE_TEXT = `sed flag -E -b -n -r -s -u -z --binary --debug --follow-symlinks --null-data --posix --quiet --regexp-extended --sandbox --separate --silent --unbuffered --zero-terminated
sed value -e -f -l --expression --file --line-length
sed optional -i --in-place
sed script -e -f --expression --file
sed inplace -i --in-place
sed quiet -n --quiet --silent
sed stop --help --version
perl flag -a -c -f -g -n -p -s -S -t -T -u -U -w -W -X
perl value -e -E -I -m -M
perl optional -C -d -D -F -i -x
perl octal -0 -l
perl script -e -E
perl inplace -i
perl stop -V -h -v`;
const EDIT_TABLE = new Map();
for (const line of EDIT_TABLE_TEXT.split('\n')) {
  const [name, kind, ...options] = line.split(' ');
  const spec = EDIT_TABLE.get(name) ?? { long: [] };
  spec[kind] = new Set(options);
  for (const option of options) if (option.startsWith('--') && !spec.long.includes(option)) spec.long.push(option);
  EDIT_TABLE.set(name, spec);
}

/**
 * Reads the words after `sed` or `perl` (EDIT_TABLE_TEXT): whether they edit files in place, whether an option gave the script,
 * and the words that are no option (the script, when no option gave it, and the files). A program that prints text and exits
 * edits nothing, so its operands are not returned. An empty word right after a bare sed `-i` is its suffix (BSD form).
 */
function editOptions(program, args) {
  const spec = EDIT_TABLE.get(program);
  const has = (kind, option) => spec[kind]?.has(option) === true;
  const operands = [];
  let inPlace = false;
  let scripted = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') {
      pushAll(operands, args.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      if (program !== 'sed') continue; // perl has no long options
      const at = arg.indexOf('=');
      const given = at === -1 ? arg : arg.slice(0, at);
      const named = spec.long.includes(given) ? [given] : spec.long.filter((full) => full.startsWith(given));
      if (named.length !== 1) continue;
      if (has('stop', named[0])) return { inPlace: false, scripted: false, operands: [] };
      if (has('inplace', named[0])) inPlace = true;
      if (has('script', named[0])) scripted = true;
      if (at === -1 && has('value', named[0])) i += 1; // the value is the next word
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (let at = 1; at < arg.length; at += 1) {
        const option = `-${arg[at]}`;
        const rest = arg.slice(at + 1);
        if (has('stop', option)) return { inPlace: false, scripted: false, operands: [] };
        if (has('inplace', option)) inPlace = true;
        if (has('script', option)) scripted = true;
        if (has('value', option)) {
          if (rest === '') i += 1; // the value is the next word
          break;
        }
        if (has('optional', option)) {
          if (rest === '' && program === 'sed' && has('inplace', option) && args[i + 1] === '') i += 1;
          break;
        }
        if (has('octal', option)) at += /^[0-7]*/.exec(rest)[0].length;
      }
    } else if (program === 'perl' && !scripted) {
      pushAll(operands, args.slice(i)); // the first operand is the script file, and perl reads no option behind it
      break;
    } else {
      operands.push(arg);
    }
  }
  return { inPlace, scripted, operands };
}

/**
 * The files an in-place `sed` or `perl` edits, from the words after the program name: the operands that remain once the options
 * and the script are skipped (editOptions). An in-place edit with no file operand edits what it gets from `xargs` (`... | xargs
 * sed -i 's/a/b/'`), which gets UNKNOWN_TARGET; with no `xargs` in front it edits nothing (sed stops with an error). Other
 * commands give no targets.
 */
function inPlaceTargets(program, args, fed) {
  const { inPlace, scripted, operands } = editOptions(program, args);
  if (!inPlace) return [];
  const files = (scripted ? operands : operands.slice(1)).filter((operand) => operand !== '');
  if (files.length > 0) return files;
  return fed ? [UNKNOWN_TARGET] : [];
}

/**
 * Reads shell text forward and tells whether a position holds text, not shell: inside single quotes, inside double quotes
 * (a `$(` there opens a command again, so `"$(cat <<EOF ...)"` keeps its here-document) or in a `#` comment. Positions come in
 * increasing order, and the bodies that are cut out are skipped, so a quote in a body opens no string.
 */
class QuoteScan {
  constructor(text) {
    this.text = text;
    this.at = 0;
    this.frames = []; // "'", '"' or '(' for each open construct
    this.commentEnd = 0;
    this.jumps = []; // [from, to] ranges that are not read
  }

  skip(from, to) {
    this.jumps.push([from, to]);
  }

  inert(to) {
    const { text, frames } = this;
    if (to < this.commentEnd) return true;
    while (this.at < to) {
      if (this.jumps.length > 0 && this.at >= this.jumps[0][0]) {
        this.at = Math.max(this.at, this.jumps.shift()[1]);
        continue;
      }
      const ch = text[this.at];
      const top = frames[frames.length - 1];
      if (top === "'") {
        if (ch === "'") frames.pop();
      } else if (top === '"') {
        if (ch === '\\') this.at += 1;
        else if (ch === '"') frames.pop();
        else if (ch === '$' && text[this.at + 1] === '(') {
          frames.push('(');
          this.at += 1;
        }
      } else if (ch === '\\') this.at += 1;
      else if (ch === "'" || ch === '"') frames.push(ch);
      else if (ch === '(') frames.push('(');
      else if (ch === ')') frames.pop();
      else if (ch === '#' && (this.at === 0 || /[\s;&|(]/.test(text[this.at - 1]))) {
        const newline = text.indexOf('\n', this.at);
        this.commentEnd = newline === -1 ? text.length : newline;
        this.at = this.commentEnd;
        if (to < this.commentEnd) return true;
        continue;
      }
      this.at += 1;
    }
    const top = frames[frames.length - 1];
    return top === "'" || top === '"';
  }
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
  const quotes = new QuoteScan(text);
  const edits = []; // [start, end, replacement], sorted by start before they are applied
  let terminators = null; // tag -> { lines: [{ index, end }], next } for the lines `[ \t]*TAG` after a newline
  let lineEnd = -1; // the newline that ends the line of the operators being read
  let resume = -1; // the newline before the next body of that line
  for (let m = operator.exec(text); m !== null; m = operator.exec(text)) {
    if (m.index > lineEnd && m.index < resume) continue; // inside a body that is already cut
    if (quotes.inert(m.index)) continue; // `echo "<<EOF"` and `# <<EOF` hold text, not an operator
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
    quotes.skip(resume, found.end);
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
 * Words that run the command after them and are not in the table of launch wrappers (LAUNCH_TABLE): `doas`, `xargs` and the
 * reserved words that start a command (`then`, `do`, `!`, `{` ...). Each has the options that take a value (`xargs -n 1`) and
 * the positional words it takes before the command. The wrappers of the table are read by launchCommandIndex, in programAt.
 */
const launcher = (values = [], positional = 0) => ({ values: new Set(values), positional });
const LAUNCH_WRAPPERS = new Map([
  ['doas', launcher(['-u', '-C'])],
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
/** Command substitutions inside command substitutions are read this deep, apart from the nested shell strings above. */
const SUBSTITUTION_MAX_DEPTH = 8;

const baseName = (word) => word.slice(word.lastIndexOf('/') + 1);

/**
 * The index of the program word of a command that starts at `start`: assignments (`FOO=1`), launch wrappers
 * with their options (`sudo -u root`, `env -i`, `timeout 5`, `xargs -n 1`) and reserved words (`then`, `do`)
 * are skipped. A word that is not a string (a boundary or the end) ends the command.
 */
function programAt(words, start) {
  let at = start;
  let wrappers = 0;
  for (;;) {
    const word = words[at];
    if (typeof word !== 'string') return at;
    if (/^[A-Za-z_]\w*\+?=/.test(word)) {
      at += 1;
      continue;
    }
    if (LAUNCH_TABLE.has(baseName(word))) {
      wrappers += 1;
      const behind = wrappers > MAX_WRAPPERS ? -1 : launchCommandIndex((index) => words[index], at, true);
      if (behind === -1) return at; // no command runs behind the wrapper, or the chain is too long: the wrapper stays the program
      at = behind;
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
    // `xargs` in front of the program hands it the files to work on (`xargs sed -i 's/a/b/'`)
    found.push({ at, end, fed: words.slice(start, at).some((word) => typeof word === 'string' && baseName(word) === 'xargs') });
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
 * (`sh -c '...'`, `sudo bash -lc`, `su -c`) is read again, two levels deep; the body of a command substitution is read again
 * as a command of its own, eight levels deep, counted apart from the nested shell strings.
 */
function shellWriteTargets(command, depth = 0, substitutions = 0) {
  const QUOTED = String.raw`"(?:[^"\\]|\\[\s\S])*"|'[^']*'`; // a double-quoted string may hold \"
  const WORD = String.raw`(?:${QUOTED}|\\[^\n]|[^\s;&|)<>"'\\])+`;
  const { text, bodies } = splitSubstitutions(withoutHeredocBodies(command), '_', true);
  const targets = [];
  const unquote = (raw) => shellWords(raw).find((word) => word !== null && word !== '');
  // A redirection operator outside quotes needs nothing before it: `printf x>src/a.ts` writes the file, and the digits before it name a
  // descriptor only as a word of their own, which makes no difference to the target. Text that holds `>` without a redirection is
  // read first and skipped: a parameter expansion (`${x//>/-}`), an arithmetic command and a conditional (`(( a>b ))`, `[[ a>b ]]`). The
  // expansion and the conditional are looked for within 300 characters, so that a text with many unclosed ones is read in linear time.
  const scan = new RegExp(
    String.raw`${QUOTED}|\\[^\n]|\$\{[^}]{0,300}\}|\(\((?:[^()]|\([^()]*\))*\)\)|\[\[[^\n]{0,300}?\]\]|(?<=^|[\s;&|(])#[^\n]*|(>>|>\||>&|>)\s*(${WORD})`,
    'g',
  );
  for (const m of text.matchAll(scan)) {
    if (m[2] === undefined) continue;
    if (m[1] === '>&' && /^(?:\d+-?|-)$/.test(m[2])) continue; // `>&2` and `>&-` name a descriptor, not a file
    targets.push(unquote(m[2]));
  }
  const words = shellWords(text);
  const programs = commandPrograms(words);
  for (const { at, end, fed } of programs) {
    const program = baseName(words[at]);
    if (program === 'tee') pushAll(targets, teeTargets(words.slice(at + 1, end)));
    else if (program === 'sed' || program === 'perl') pushAll(targets, inPlaceTargets(program, words.slice(at + 1, end), fed));
    else if (program === 'cp' || program === 'mv' || program === 'install') pushAll(targets, copyTargets(program, words.slice(at + 1, end)));
    else if (program === 'truncate') pushAll(targets, truncateTargets(words.slice(at + 1, end)));
    else if (program === 'dd') pushAll(targets, ddTargets(words.slice(at + 1, end)));
  }
  if (depth < NESTED_MAX_DEPTH) {
    for (const nested of nestedCommandStrings(words, programs)) {
      if (nested.length <= NESTED_MAX_LENGTH) targets.push(...shellWriteTargets(nested, depth + 1, substitutions));
    }
  }
  if (substitutions < SUBSTITUTION_MAX_DEPTH) {
    for (const body of bodies) {
      if (body.length <= NESTED_MAX_LENGTH) targets.push(...shellWriteTargets(body, depth, substitutions + 1));
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
