import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { classifyCommand, isMutation } from '../../tools/diagnostics/check_classifier.mjs';

// One table for the shell syntax that the diagnostic tools read with a parser of their own. A row is a PREFIX that
// stands in front of a command (an assignment, a redirection, a launch wrapper, or a mix of them); each prefix is
// combined with the command words that the tools look for, and the table says, for each reading of the shell, whether it
// gets through the prefix to that command word. A new variant of the syntax is one more row here, not a new defect.
//
// The readings (columns):
//   check    check_classifier.classifyCommand: `npm test` and `pytest` are a check that narrows nothing
//   write    check_classifier.isMutation: `tee src/a.ts` and `cp a src/a.ts` write a code file
//   commit   user_prohibitions_after_compaction: `git commit` is a commit
//   consult  advisor_event_coverage: `ask-advisor` is a consultation (--consult-command)
//   metrics  executor_outcome_metrics: `pytest` is a passed test run and `ask-advisor` a consultation (--advisor-pattern)
//
// A launch wrapper is read by some tools and not by others; the cells below pin what each tool does today (the
// README lists it), so a change of that reading shows up here as one row to flip.

const TOOLS = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'tools', 'diagnostics');
const hasPython3 = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;

type Column = 'check' | 'write' | 'commit' | 'consult' | 'metrics';
type Reads = Record<Column, boolean>;
const ALL: Reads = { check: true, write: true, commit: true, consult: true, metrics: true };
const except = (...columns: Column[]): Reads => ({ ...ALL, ...Object.fromEntries(columns.map((column) => [column, false])) });
// advisor_event_coverage reads the first command of the text only, so a command after `;`, `&&` or a newline is no consultation.
const FIRST_COMMAND_ONLY = ['consult'] as const;

const PREFIXES: Array<[string, Reads]> = [
  ['', ALL],
  // leading assignments: simple, quoted, escaped space, empty, command substitution, appended, glued quotes
  ['A=1 ', ALL], ['A=1 B=2 ', ALL], ['A="b c" ', ALL], ["A='b c' ", ALL], ['A=b\\ c ', ALL], ['A= ', ALL], ['A=$(date) ', ALL],
  ['A=`date` ', ALL], ['A=$(a b) ', ALL], ['A="$(a b)" ', ALL], ['A+=1 ', ALL], ['A=x"y z" ', ALL], ['A=$(echo ")") ', ALL],
  ['MODE="deep analysis" ', ALL], ['A=$(a $(b c)) ', ALL], ['A=$() ', ALL],
  // leading redirections: operator and target are no command word, with a descriptor or without, with a blank or without
  ['> out.log ', ALL], ['>out.log ', ALL], ['>> out.log ', ALL], ['>>out.log ', ALL], ['2> err.log ', ALL], ['2>err.log ', ALL], ['2>&1 ', ALL], ['&> all.log ', ALL],
  ['&>all.log ', ALL], ['&>> all.log ', ALL], ['< in.txt ', ALL], ['<in.txt ', ALL], ['>| out.log ', ALL], ['>|out.log ', ALL], ['{fd}> out.log ', ALL], ['> "a b.log" ', ALL],
  ['>a\\ b.log ', ALL], ['<<< x ', ALL], ['2>/dev/null ', ALL], ['>&2 ', ALL], ['3< in.txt ', ALL], ['> out.log > out2.log ', ALL], ['2>&1 > out.log ', ALL],
  // assignments and redirections together, in both orders
  ['A=1 > out.log ', ALL], ['> out.log A=1 ', ALL], ['A="b c" 2>&1 ', ALL], ['> out.log 2>&1 A=$(d) ', ALL], ['A=1 B="c d" < in.txt 2> err.log ', ALL],
  // launch wrappers: every wrapper of the table is read by every reading
  ['env ', ALL], ['env A=1 ', ALL], ['time ', ALL], ['timeout 5 ', ALL],
  ['command ', ALL], ['exec ', ALL], ['nice -n 5 ', ALL],
  ['sudo ', ALL], ['nohup ', ALL], ['sudo -u root ', ALL],
  // wrappers with assignments and redirections, and wrappers with each other
  ['A=1 env ', ALL], ['A="b c" time ', ALL], ['env > out.log ', ALL], ['> out.log env ', ALL],
  ['time > out.log ', ALL], ['env A=1 time ', ALL], ['A=1 sudo ', ALL],
  ['sudo A=1 ', ALL], ['> out.log sudo ', ALL], ['sudo > out.log ', ALL],
  ['sudo env A=1 nohup ', ALL], ['time sudo ', ALL], ['env sudo ', ALL],
  ['command nohup ', ALL],
];

// The command words each reading looks for, as the text that follows the prefix.
const WORDS: Record<Column, string[]> = {
  check: ['npm test', 'pytest'],
  write: ['tee src/a.ts', 'cp a src/a.ts'],
  commit: ['git commit -m x'],
  consult: ['ask-advisor --ask'],
  metrics: ['pytest', 'ask-advisor --ask'],
};

// Negative rows: the command word is only an argument or the target of a redirection, so no reading may see it.
// A redirection operator and its target never open a command, and neither does the end of a command substitution.
// The target is README.md, a file that is no code, so a write reading sees no write through the redirection itself.
const ARGUMENT_OF: string[] = [
  'echo hi > README.md ', 'echo hi >> README.md ', 'echo hi 2> README.md ', 'echo hi &> README.md ', 'echo hi >| README.md ', 'echo hi >& README.md ',
  'echo hi >README.md ', 'echo hi 2>&1 ', 'cat < README.md ', 'cat <<< README.md ', 'A=1 echo hi > README.md ', 'A="b c" echo hi > README.md ',
  '> out.log echo hi > README.md ', 'echo $(date) ', 'echo `date` ', 'echo $(a b) ', 'echo "x" ', 'echo x $(date) ', 'A=$(date) echo hi > README.md ',
  'sudo echo hi > README.md ', 'env A=1 echo hi > README.md ', 'time echo hi > README.md ',
];
// The command word itself is the target of the redirection: `echo hi > git commit` runs echo and writes a file named git.
// For the write reading that file is a write of its own (no extension, so code), which is why these rows skip it.
const TARGET_IS_THE_WORD: string[] = [
  'echo hi > ', 'echo hi >> ', 'echo hi 2> ', 'echo hi &> ', 'echo hi >| ', 'echo hi >& ', 'echo hi >', 'cat < ', 'cat <<< ', 'A=1 echo hi > ',
  'A="b c" echo hi > ', '> out.log echo hi > ', 'A=$(date) echo hi > ', 'sudo echo hi > ', 'env A=1 echo hi > ', 'time echo hi > ',
];

// Boundary rows: the end of a command opens a new one. advisor_event_coverage reads the first command only.
const AFTER_BOUNDARY: Array<[string, Reads]> = [
  ['echo hi > f; ', except(...FIRST_COMMAND_ONLY)], ['echo hi > f && ', except(...FIRST_COMMAND_ONLY)], ['echo hi > f\n', except(...FIRST_COMMAND_ONLY)],
  ['echo $(date); ', except(...FIRST_COMMAND_ONLY)], ['echo $(date) && ', except(...FIRST_COMMAND_ONLY)], ['echo "$(date)" && ', except(...FIRST_COMMAND_ONLY)],
  ['A=$(date) true; ', except(...FIRST_COMMAND_ONLY)], ['echo hi 2>&1 && ', except(...FIRST_COMMAND_ONLY)],
];

// Here-document rows: the body of a here-document is input, not shell, so the command word inside it is read by no reading.
// The terminator line is part of the command, so these rows are templates, not prefixes. `bash <<EOF` really runs its body;
// the rows pin it as outside the scope of every tool (the README lists it).
const HEREDOC_BODY: Array<(word: string) => string> = [
  (word) => `cat <<EOF\n${word}\nEOF`, (word) => `cat <<'EOF' > README.md\n${word}\nEOF`, (word) => `cat <<-EOF\n\t${word}\n\tEOF`,
  (word) => `A=1 cat <<"EOF"\n${word}\nEOF`, (word) => `cat 2>&1 <<EOF\n${word}\nEOF`, (word) => `bash <<EOF\n${word}\nEOF`,
  (word) => `sudo bash <<'EOF'\n${word}\nEOF`, (word) => `echo "$(cat <<'EOF'\n${word}\nEOF\n)"`, (word) => `cat <<EOF\nline \\\n${word}\nEOF`,
  (word) => `cat <<'EOF'\nline \\\n${word}\nEOF`,
];

interface Case { command: string; word: string; want: boolean; row: string }

function casesFor(column: Column): Case[] {
  const cases: Case[] = [];
  for (const [prefix, reads] of PREFIXES) {
    for (const word of WORDS[column]) cases.push({ command: prefix + word, word, want: reads[column], row: prefix });
  }
  const negatives = column === 'write' ? ARGUMENT_OF : [...ARGUMENT_OF, ...TARGET_IS_THE_WORD];
  for (const prefix of negatives) {
    for (const word of WORDS[column]) cases.push({ command: prefix + word, word, want: false, row: prefix });
  }
  for (const [prefix, reads] of AFTER_BOUNDARY) {
    for (const word of WORDS[column]) cases.push({ command: prefix + word, word, want: reads[column], row: prefix });
  }
  for (const template of HEREDOC_BODY) {
    for (const word of WORDS[column]) cases.push({ command: template(word), word, want: false, row: template('<word>') });
  }
  return cases;
}

// One Python process per tool: it loads the script as a module and answers for every command of the table.
function pyEval(script: string, expression: string, argument: unknown) {
  const code = [
    'import importlib.util, json, re, sys',
    'sys.dont_write_bytecode = True',
    'spec = importlib.util.spec_from_file_location("tool", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'argument = json.loads(sys.argv[2])',
    `print(json.dumps(${expression}))`,
  ].join('\n');
  const proc = spawnSync('python3', ['-I', '-B', '-c', code, join(TOOLS, script), JSON.stringify(argument)], { encoding: 'utf8', timeout: 60000 });
  expect(proc.status, proc.stderr).toBe(0);
  return JSON.parse(proc.stdout) as boolean[];
}

function verify(column: Column, cases: Case[], got: boolean[]) {
  const wrong = cases.flatMap((entry, index) => (got[index] === entry.want ? [] : [`${column}: ${JSON.stringify(entry.command)} gave ${got[index]}, the table says ${entry.want}`]));
  expect(wrong, wrong.join('\n')).toEqual([]);
}

describe('shell syntax matrix: the prefix of a command, for every tool that reads it', () => {
  it('check: a runner is found behind assignments, redirections and the wrappers that are read, and nothing narrows it', () => {
    const cases = casesFor('check');
    verify('check', cases, cases.map(({ command }) => {
      const got = classifyCommand(command);
      return got.isCheck === true && got.narrowed === false;
    }));
  });

  it('write: a code file written by tee and cp is found behind assignments, redirections and every launch wrapper', () => {
    const cases = casesFor('write');
    verify('write', cases, cases.map(({ command }) => isMutation('Bash', { command })));
    // Control: with a documentation file as the target the same rows write nothing, so the result above comes from the
    // command word and not from the prefix.
    const controls: Case[] = PREFIXES.flatMap(([prefix]) => ['tee README.md', 'cp a README.md'].map((word) => ({ command: prefix + word, word, want: false, row: prefix })));
    verify('write', controls, controls.map(({ command }) => isMutation('Bash', { command })));
  });

  it.skipIf(!hasPython3)('commit: git commit is found behind assignments, redirections and every launch wrapper', () => {
    const cases = casesFor('commit');
    verify('commit', cases, pyEval('user_prohibitions_after_compaction.py', '[module.command_matches("commit", c) for c in argument]', cases.map((c) => c.command)));
  });

  it.skipIf(!hasPython3)('consult: a consultation is the first command, found behind assignments, redirections and the wrappers that are read', () => {
    const cases = casesFor('consult');
    const expression = '[module.consult_kind("Bash", {"command": c}, module.Config(["ask-advisor"], "ADVISOR:", "STATUS:")) == "bash-ask-advisor" for c in argument]';
    verify('consult', cases, pyEval('advisor_event_coverage.py', expression, cases.map((c) => c.command)));
  });

  it.skipIf(!hasPython3)('metrics: a test run and a consultation are found behind assignments, redirections and the wrappers that are read', () => {
    const cases = casesFor('metrics');
    const expression = '[module.classify_call("Bash", c, {"is_error": False}, None, re.compile("ask-advisor")) == kind for c, kind in argument]';
    const argument = cases.map((c) => [c.command, c.word === 'pytest' ? 'S' : 'k']);
    verify('metrics', cases, pyEval('executor_outcome_metrics.py', expression, argument));
  });

  it('the table has the rows the readings are checked with', () => {
    // A guard against an emptied table: every kind of prefix is present and every column has command words.
    expect(PREFIXES.length).toBeGreaterThan(60);
    for (const column of Object.keys(WORDS) as Column[]) expect(casesFor(column).length).toBeGreaterThan(80);
    expect(TARGET_IS_THE_WORD).toContain('echo hi > ');
    expect(PREFIXES.map(([prefix]) => prefix)).toEqual(expect.arrayContaining(['A="b c" ', '2>&1 ', 'sudo ', 'A=1 > out.log ']));
  });
});
