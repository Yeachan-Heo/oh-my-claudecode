// Tests for tools/diagnostics/check_classifier.mjs (classifier of fresh checks).
// Covers: 22 recognized commands with their kind; 14 negative and edge commands (each labelled
// rejected or relabelled, with the reason) and the empty string; exit-status hiding with and
// without pipefail; narrowing; the summary rules, each with a passed, a failed and an
// undetermined case; printed exit codes; zero-test runs; mutations.
// Tool-result fixtures follow the host transcripts: a nonzero exit always carries is_error: true.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import {
  classifyCommand,
  classifyCheckResult,
  isMutation,
  RULES_VERSION,
  TEMP_DIRS,
} from '../../tools/diagnostics/check_classifier.mjs';

/** Tool-result constructor: isError follows a nonzero exit unless the test overrides it. */
function checkResult(command, output, exitCode = null, extra = {}) {
  const isError = extra.isError !== undefined ? extra.isError : exitCode !== null && exitCode !== 0;
  return classifyCheckResult({ command, output, isError, exitCode });
}

it('module contract: exports, version, temp directories', () => {
  assert.equal(typeof classifyCommand, 'function');
  assert.equal(typeof classifyCheckResult, 'function');
  assert.equal(typeof isMutation, 'function');
  assert.match(RULES_VERSION, /^\d{4}\.\d{2}\.\d{2}\./);
  assert.ok(Array.isArray(TEMP_DIRS) && TEMP_DIRS.length > 0);
});

it('22 recognized commands with their kind and a visible exit status', () => {
  const cases = [
    ['npm test', 'test'], ['pnpm test', 'test'], ['yarn test', 'test'], ['npm run test:unit', 'test'],
    ['npm run build', 'build'], ['pnpm -r build', 'build'], ['pnpm --filter @x/y test', 'test'],
    ['npx vitest run __tests__/a.test.ts', 'test'], ['npx tsc --noEmit', 'typecheck'], ['cargo test --workspace', 'test'],
    ['cargo build --release', 'build'], ['cargo clippy -- -D warnings', 'lint'], ['go test ./...', 'test'],
    ['python -m pytest -q', 'test'], ['pytest tests/', 'test'], ['dotnet test', 'test'], ['make test', 'test'],
    ['cd v3 && npm test', 'test'], ['CI=1 npx vitest run', 'test'], ['npm test 2>&1', 'test'],
    ['npm run build && npm test', 'test'], ['export NODE_ENV=test && npm test', 'test'],
  ];
  assert.equal(cases.length, 22);
  for (const [cmd, kind] of cases) {
    const got = classifyCommand(cmd);
    assert.ok(got.isCheck, `${cmd}: recognized as a check`);
    assert.equal(got.kind, kind, `${cmd}: kind`);
    assert.equal(got.exitHidden, false, `${cmd}: exit status visible`);
  }
});

// The list has 15 entries: these 14 plus the empty string.
// Each entry says what this classifier does and why (relabelled entries are checks here).
const NEGATIVE_CASES = [
  ['npm test || true', true, true, 'relabelled: alternation hides the status'],
  ['npm test | tail -5', true, true, 'relabelled: depends on pipefail (no pipefail here, so it hides the status)'],
  ['npm test; echo done', true, true, 'relabelled: separator with a successor hides the status'],
  ['npm test & sleep 1', true, true, 'relabelled: backgrounded, the status is not the check'],
  ['echo $(npm test)', false, false, 'rejected: the command prints'],
  ['npm test\nexit 0', true, true, 'relabelled: newline with a successor hides the status'],
  ['npm install', false, false, 'rejected: not a check'],
  ['npm run deploy', false, false, 'rejected: not a check'],
  ['git commit -m test', false, false, 'rejected: git and quoted text name no check'],
  ['echo npm test', false, false, 'rejected: the command prints'],
  ['rm -rf x && npm test', true, false, 'relabelled: visible, but a nonzero status of the && chain stays undetermined (chained)'],
  ['npm test && rm -rf dist', true, false, 'relabelled: visible, but a nonzero status of the && chain stays undetermined (chained)'],
  ['`npm test`', false, false, 'rejected: substitution, not a command'],
  ['ls', false, false, 'rejected: not a check'],
];

it('14 negative and edge commands: checks or rejections, as labelled', () => {
  assert.equal(NEGATIVE_CASES.length, 14);
  for (const [cmd, isCheck, exitHidden, label] of NEGATIVE_CASES) {
    const got = classifyCommand(cmd);
    assert.equal(got.isCheck, isCheck, `${cmd} (${label}): isCheck`);
    assert.equal(got.exitHidden, exitHidden, `${cmd} (${label}): exitHidden`);
  }
});

it('the empty string and non-string inputs never throw and are not checks', () => {
  assert.equal(classifyCommand('').isCheck, false, 'empty string');
  for (const bad of [undefined, null, 5, {}, 'x'.repeat(3000)]) {
    assert.equal(classifyCommand(bad).isCheck, false, `input ${String(bad).slice(0, 10)}`);
  }
  assert.equal(classifyCommand('echo tsc').isCheck, false, 'echo tsc is not a check');
  assert.equal(classifyCommand('npm test --version').isCheck, false, '--version anywhere kills a check');
  assert.equal(classifyCommand('! npm test').isCheck, false, 'negated command is not a check');
});

it('quotes and comments name nothing', () => {
  assert.equal(classifyCommand('git commit -m "npm test"').isCheck, false, 'runner inside quotes');
  assert.equal(classifyCommand('true # npm test').isCheck, false, 'runner inside a comment');
  // An operator inside quotes does not split the command, so the word after it is not a command word.
  assert.equal(classifyCommand('"a;npm" test').isCheck, false, 'a ; inside quotes');
  assert.equal(classifyCommand("'a&&npm' test").isCheck, false, 'a && inside quotes');
  assert.equal(classifyCommand('"a|npm" test').isCheck, false, 'a | inside quotes');
  assert.equal(classifyCommand('"a\nnpm" test').isCheck, false, 'a newline inside quotes');
  assert.equal(classifyCommand('echo "a;b"; npm test').isCheck, true, 'the real operator after the quoted one still splits');
});

it('pipefail: only a pipe into tail is made visible', () => {
  assert.equal(classifyCommand('npm test | tail -5').exitHidden, true, 'pipe without pipefail hides');
  assert.equal(classifyCommand('npm test | head -20').exitHidden, true, 'head hides without pipefail');
  const tail = classifyCommand('set -o pipefail && npm test | tail -5');
  assert.equal(tail.pipefail, true, 'pipefail detected');
  assert.equal(tail.exitHidden, false, 'pipefail makes a pipe into tail visible');
  assert.equal(classifyCommand('set -o pipefail && npm test | head -5').exitHidden, true, 'pipefail does not save head');
  assert.equal(classifyCommand('set -o pipefail && npm test || true').exitHidden, true, 'pipefail does not save ||');
  assert.equal(classifyCommand('set -o pipefail && npm test; echo done').exitHidden, true, 'pipefail does not save ;');
  // The last set statement wins.
  assert.equal(classifyCommand('set -o pipefail && npm test | tail -5; set +o pipefail').exitHidden, true, 'set +o pipefail');
  // A word in echo is not an option.
  assert.equal(classifyCommand('echo set -o pipefail').pipefail, false, 'echo does not set pipefail');
});

it('a nonzero exit status of an && chain stays undetermined unless the runner shows the failure', () => {
  const undetermined = (command: string, output = 'x', exitCode: number | null = 1) => {
    const got = checkResult(command, output, exitCode);
    assert.equal(got.verdict, 'undetermined', `${command}: ${got.reason}`);
    assert.equal(got.rule, 'chained-exit', `${command}: rule`);
  };
  // Another command of the chain may be the one that failed: `false && npm test` never runs the check.
  for (const command of [
    'npm test && false', 'false && npm test', 'cd v3 && npm test', 'npm run build && npm test', 'rm -rf x && npm test',
    'npm test && rm -rf dist', 'npm test && npm run build', 'cd a && cd b && vitest run', 'source env.sh && pytest tests/',
    'echo x > out.txt && npm test', 'set -o pipefail && cd v3 && npm test 2>&1 | tail -20',
  ]) {
    undetermined(command);
    assert.equal(classifyCommand(command).chained, true, `${command}: chained`);
    assert.equal(classifyCommand(command).exitHidden, false, `${command}: the status stays visible`);
  }
  // An errored result without an exit code is the same case.
  assert.equal(checkResult('npm test && false', 'x', null, { isError: true }).rule, 'chained-exit');
  // A zero status means every command passed.
  for (const command of ['npm test && false', 'cd v3 && npm test', 'npm run build && npm test']) {
    assert.equal(checkResult(command, 'ok', 0).verdict, 'passed', `${command}: zero status`);
  }
  // The runner's own failure line names the check, whatever the chain.
  assert.equal(checkResult('pytest tests/ && false', '===== 3 failed, 5 passed in 0.2s =====', 1).verdict, 'failed');
  assert.equal(checkResult('cd v3 && vitest run', 'Tests  2 failed | 1 passed (3)', 1).verdict, 'failed');
  assert.equal(checkResult('eslint src && echo ok', 'x', 1).rule, 'exit-code', 'a printing command cannot fail');
  // Commands that cannot fail in practice do not share the status.
  for (const command of [
    'export NODE_ENV=test && npm test', 'set -o pipefail && npm test | tail -5', 'echo start && npm test', 'npm test && echo done',
    'true && npm test', ': && npm test', 'npm test && printf done', 'unset FOO && npm test', 'npm test | tail -5', 'cd v3; npm test',
    'cd v3\nnpm test', 'npm test', 'cat x | npm test', 'sleep 1 & npm test',
  ]) {
    assert.equal(classifyCommand(command).chained, false, `${command}: not chained`);
  }
  assert.equal(checkResult('export NODE_ENV=test && npm test', 'x', 1).verdict, 'failed');
  assert.equal(checkResult('npm test && echo done', 'x', 1).verdict, 'failed');
  assert.equal(checkResult('echo x > out.txt && npm test', 'x', 1).rule, 'chained-exit', 'an echo with a redirect can fail');
  // Under pipefail a command piped into the check can fail it; without pipefail it sets no status.
  assert.equal(classifyCommand('set -o pipefail; cat x | npm test').chained, true);
  undetermined('set -o pipefail; cat x | npm test');
  assert.equal(checkResult('cat x | npm test', 'x', 1).verdict, 'failed');
  // An alternation before the check can skip it: `true || npm test` exits 0 without running anything.
  for (const command of ['true || npm test', 'npm run build || npm test', 'false || npm test']) {
    assert.equal(classifyCommand(command).exitHidden, true, `${command}: hidden`);
    assert.equal(checkResult(command, '', 0).verdict, 'undetermined', `${command}: zero status`);
  }
  assert.equal(checkResult('true || vitest run', 'Tests  3 passed (3)', 0).verdict, 'passed', 'a passing summary names the check');
  assert.equal(classifyCommand('false || echo x; npm test').exitHidden, false, 'a semicolon ends the alternation');
  // A printed exit code of a chain is no proof of the check; behind a pipe without pipefail only PIPESTATUS is.
  undetermined('cd v3 && npm test; echo "EXIT=$?"', 'EXIT=1', null);
  assert.equal(checkResult('cd v3 && npm test; echo "EXIT=$?"', 'EXIT=0', null).verdict, 'passed');
  assert.equal(checkResult('npm test; echo "EXIT=$?"', 'EXIT=1', null).verdict, 'failed');
  assert.equal(classifyCommand('npm test | tail; echo $?').piped, true);
  assert.equal(classifyCommand('set -o pipefail; npm test | tail; echo $?').piped, false);
  assert.equal(checkResult('npm test | tail; echo $?', '0', null).verdict, 'undetermined', '$? is the last command of the pipe');
  assert.equal(checkResult('npm test | tail; echo ${PIPESTATUS[0]}', '1', null).verdict, 'failed');
  assert.equal(checkResult('npm test | tail; echo ${PIPESTATUS[0]}', '0', null).verdict, 'passed');
});

it('narrowing and weakening produce narrowed=true', () => {
  const cases = [
    ['vitest run -t login', true], ['vitest -k auth', true], ['pytest --skip a,b', true],
    ['go test -run TestFoo ./...', true], ['vitest run --passWithNoTests', true],
    ['vitest run --exclude **/slow/**', true], ['npx vitest run __tests__/a.test.ts', true],
    ['npm test', false], ['go test ./...', false], ['pytest tests/', false],
    ['cargo test --workspace', false], ['npx tsc --noEmit', false], ['eslint src', false],
  ];
  for (const [cmd, want] of cases) {
    assert.equal(classifyCommand(cmd).narrowed, want, `${cmd}: narrowed=${want}`);
  }
});

it('options that run a subset of the tests, or none, narrow a test run of every known runner', () => {
  const narrowing = [
    // pytest (options of `pytest --help`): mark and keyword expressions, last failed, stepwise, deselect, ignore, collect only.
    'pytest -m smoke', 'pytest -msmoke', 'pytest -k "a or b"', 'pytest -kauth', 'pytest -xk auth', 'pytest --lf', 'pytest --last-failed',
    'pytest --sw', 'pytest --stepwise', 'pytest --sw-skip', 'pytest --deselect tests/a', 'pytest --ignore=tests/slow', 'pytest --ignore-glob "*_slow"',
    'pytest --collect-only', 'pytest --co', 'python -m pytest -m "not slow"', 'tox -e py311', 'nox -s tests', 'nox -k unit',
    // vitest, jest, bun
    'vitest run -t login', 'vitest run --testNamePattern=login', 'vitest --changed', 'vitest run --changed HEAD~1', 'vitest run --shard 1/3',
    'vitest run --project unit', 'vitest run --dir src', 'jest --onlyChanged', 'jest -o', 'jest --changedSince main', 'jest --lastCommit',
    'jest --findRelatedTests src/a', 'jest --testPathPattern foo', 'jest --testPathPatterns foo', 'jest --onlyFailures', 'jest --shard=2/4',
    'jest --selectProjects a', 'jest --listTests', 'bun test --test-name-pattern x', 'bun test -t x',
    // mocha, ava, node:test, unittest
    'mocha --grep auth', 'mocha -g auth', 'mocha --fgrep auth', 'mocha --grep auth --invert', 'mocha --dry-run', 'mocha --ignore "test/slow/**"',
    'ava --match "a*"', 'ava -m x', 'node --test --test-name-pattern=a', 'node --test --test-only', 'node --test --test-shard=1/2',
    'node --test --test-skip-pattern=a', 'python -m unittest -k auth',
    // go: one or two dashes, with or without the test. prefix
    'go test -run TestA ./...', 'go test --run TestA ./...', 'go test -skip TestA ./...', 'go test -short ./...', 'go test -list . ./...', 'go test -test.run=TestA',
    // cargo: target and package options, libtest options after `--`, a positional filter
    'cargo test foo', 'cargo test --lib', 'cargo test --bins', 'cargo test --doc', 'cargo test --test api', 'cargo test -p core', 'cargo test --package core',
    'cargo test -- --skip slow', 'cargo test -- --ignored', 'cargo test -- --list', 'cargo test --no-run', 'cargo test -- foo', 'cargo test -p core foo',
    'cargo test --release foo', 'cargo nextest run foo', 'cargo test -j 4 foo', 'cargo test --workspace --exclude web',
    // other runners
    'dotnet test --filter Category=Unit', 'dotnet test --list-tests', 'rspec -e login', 'rspec --tag fast', 'rspec --only-failures', 'mix test --only wip',
    'mix test --failed', 'mix test --stale', 'phpunit --filter testA', 'phpunit --group fast', 'phpunit --testsuite unit', 'deno test --filter a', 'deno test --no-run',
    'ctest -R unit', 'ctest --tests-regex unit', 'ctest -E slow', 'ctest -L fast', 'ctest --rerun-failed', 'ctest -N', 'ctest -I 1,3',
    'xcodebuild test -only-testing:App/Suite', 'xcodebuild test -skip-testing:App/Slow', 'swift test --filter A', 'swift test --skip A',
    // package managers and make run a script: the long options of every runner, the short names no package manager uses
    'npm test -- -m smoke', 'npm test -- --lf', 'npm run test -- --grep a', 'pnpm test --shard 1/2', 'pnpm --filter @x/y test', 'yarn test --onlyChanged',
    'make test -k a',
  ];
  for (const cmd of narrowing) {
    const got = classifyCommand(cmd);
    assert.equal(got.isCheck, true, `${cmd}: a check`);
    assert.equal(got.narrowed, true, `${cmd}: narrowed`);
    assert.equal(checkResult(cmd, 'ok', 0).verdict, 'undetermined', `${cmd}: a zero exit status is no full check`);
    assert.equal(checkResult(cmd, 'boom', 1).verdict, 'failed', `${cmd}: a visible failure still fails`);
  }
  // Options that only reorder, stop early, print or tune a run select nothing; a value is not a filter.
  const full = [
    'pytest --ff', 'pytest --failed-first', 'pytest --nf', 'pytest -x', 'pytest --maxfail=2', 'pytest -vv -ra', 'pytest -p no:cacheprovider', 'pytest --durations=5',
    'vitest run', 'vitest run --reporter verbose', 'vitest run --coverage', 'jest --ci --coverage', 'jest --bail', 'mocha --bail', 'mocha --reporter dot',
    'node --test', 'node --test --test-timeout=100', 'python -m unittest -v', 'go test ./...', 'go test -timeout 30s ./...', 'go test -mod=vendor -count=1 ./...',
    'go test -v -race ./...', 'cargo test', 'cargo test --workspace', 'cargo test --all-features', 'cargo test --release', 'cargo test -- --nocapture',
    'cargo test -- --test-threads 4', 'cargo test --test-threads=4', 'cargo test -j 4 --features x', 'cargo test --target x86_64-unknown-linux-gnu',
    'cargo test --target-dir out', 'cargo test --color always', 'dotnet test', 'dotnet test --no-build', 'rspec', 'mix test', 'phpunit', 'deno test',
    'ctest', 'ctest -j 4', 'make test', 'make check', 'npm test', 'npm test --silent', 'npm run test -- --reporter dot', 'pnpm -r test', 'yarn test --ci',
    'npm install --ignore-scripts && npm test',
  ];
  for (const cmd of full) {
    const got = classifyCommand(cmd);
    assert.equal(got.isCheck, true, `${cmd}: a check`);
    assert.equal(got.narrowed, false, `${cmd}: not narrowed`);
  }
  // Subset options are read for tests only: a build or a lint is not a subset of anything.
  for (const cmd of ['cargo build --lib', 'cargo build -p core', 'cargo clippy -p core', 'go build -run x ./...', 'ruff check -k a', 'eslint -t x src']) {
    assert.equal(classifyCommand(cmd).narrowed, false, `${cmd}: not a test`);
  }
});

it('quoted file operands narrow a test run, and quoted text still names no check', () => {
  const cases: Array<[string, boolean]> = [
    ['pytest "tests/test_auth.py"', true], ["pytest 'tests/test_auth.py'", true],
    ['pytest "tests/my dir/test_auth.py"', true], ['pytest -- "tests/test_auth.py"', true],
    ['pytest --maxfail 1 "tests/test_auth.py"', true], ['pytest -p "no:cacheprovider" -x "tests/a.py"', true],
    ['vitest run "src/a.test.ts"', true], ['npm test "src/a.test.ts"', true], ['pytest -k "auth and not slow"', true],
    ['vitest "--passWithNoTests"', true], ['pytest "tests/test_auth.py::test_login"', true],
    ['pytest tests/test_auth.py::TestLogin::test_ok', true], ['pytest "tests/a.py::test_x[1 2]"', true],
    // A quoted operand that names no file does not narrow, quoted or not.
    ['pytest "tests/"', false], ['pytest -q "$DIR"', false], ['pytest ""', false], ['pytest -q', false],
  ];
  for (const [cmd, narrowed] of cases) {
    const got = classifyCommand(cmd);
    assert.equal(got.isCheck, true, `${cmd}: still a check`);
    assert.equal(got.narrowed, narrowed, `${cmd}: narrowed=${narrowed}`);
  }
  // A quoted string stays one word: it cannot join the words around it into a runner name, split the command or start a comment.
  for (const cmd of [
    '"npm test"', "'vitest run'", 'git commit -m "x; npm test"', 'git commit -m "x\nnpm test"', 'git commit -m "x && npm test"',
    'git commit -m "x | tail" && git push', 'bash -c "npm test"', 'echo "# npm test"',
  ]) {
    assert.equal(classifyCommand(cmd).isCheck, false, `${cmd}: names no check`);
  }
  assert.equal(classifyCommand('echo "set -o pipefail" && npm test | tail').pipefail, false, 'quoted text sets no option');
  assert.equal(classifyCommand('pytest "#x" tests/a.py').narrowed, true, 'a quoted # starts no comment');
  // A quoted word is still a word: a quoted value of a wrapper, a quoted assignment, a quoted command name.
  for (const cmd of ['timeout "5" npm test', 'FOO="a b" npm test', 'env "A=b c" npm test', '"pytest" -q']) {
    assert.equal(classifyCommand(cmd).isCheck, true, `${cmd}: a check`);
  }
  // The verdict follows: a one-file run with a zero exit is not full evidence; a failing one still fails.
  assert.equal(checkResult('pytest "tests/test_auth.py"', '1 passed in 0.1s', 0).verdict, 'undetermined');
  assert.equal(checkResult('pytest "tests/test_auth.py"', '1 failed in 0.1s', 1).verdict, 'failed');
  assert.equal(checkResult('pytest tests/', '5 passed in 0.1s', 0).verdict, 'passed');
});

it('node:test summary: passed, failed, undetermined (hidden exit)', () => {
  assert.equal(checkResult('node --test | tail -20', 'ℹ tests 5\nℹ pass 5\nℹ fail 0').verdict, 'passed');
  assert.equal(checkResult('node --test | tail -20', 'ℹ tests 5\nℹ pass 3\nℹ fail 2', 1).verdict, 'failed');
  assert.equal(checkResult('node --test | tail -20', 'ℹ tests 5 only').verdict, 'undetermined');
});

it('pytest summary: passed, failed, undetermined (hidden exit)', () => {
  assert.equal(checkResult('pytest tests/ | tail', '===== 5 passed in 0.2s =====').verdict, 'passed');
  assert.equal(checkResult('pytest tests/ | tail', '===== 3 failed, 5 passed in 0.2s =====', 1).verdict, 'failed');
  assert.equal(checkResult('pytest tests/ | tail', 'collecting tests').verdict, 'undetermined');
});

it('vitest summary: passed, failed, undetermined (hidden exit)', () => {
  assert.equal(checkResult('vitest run | tail -5', 'Test Files  1 passed (1)\n     Tests  5 passed (5)').verdict, 'passed');
  assert.equal(checkResult('vitest run | tail -5', 'Tests  2 failed | 3 passed (5)', 1).verdict, 'failed');
  assert.equal(checkResult('vitest run | tail -5', 'starting vitest').verdict, 'undetermined');
  // A test file that failed to load fails the run even though the Tests line reads as passed.
  assert.equal(
    checkResult('vitest run | tail -5', 'Test Files  1 failed | 2 passed (3)\n      Tests  5 passed (5)').verdict,
    'failed',
    'file-load failure beats the Tests line',
  );
});

it('eslint summary: passed, failed, undetermined (hidden exit)', () => {
  assert.equal(checkResult('eslint src | tail', '✖ 2 problems (0 errors, 2 warnings)').verdict, 'passed', 'warnings alone pass');
  assert.equal(checkResult('eslint src | tail', '✖ 3 problems (3 errors, 0 warnings)', 1).verdict, 'failed');
  assert.equal(checkResult('eslint src | tail', 'linting src').verdict, 'undetermined');
});

it('ruff summary: passed, failed, undetermined (hidden exit)', () => {
  assert.equal(checkResult('ruff check . | tail', 'All checks passed!').verdict, 'passed');
  assert.equal(checkResult('ruff check . | tail', 'Found 3 errors.', 1).verdict, 'failed');
  assert.equal(checkResult('ruff check . | tail', 'Found 0 errors.').verdict, 'undetermined');
});

it('tsc: passed on a visible zero exit, failed on an error code, undetermined in silence behind a pipe', () => {
  assert.equal(checkResult('tsc --noEmit', '', 0).verdict, 'passed', 'visible zero exit');
  assert.equal(checkResult('tsc --noEmit | tail -3', 'src/a.ts:1:5 - error TS2322: nope', 1).verdict, 'failed');
  assert.equal(checkResult('tsc --noEmit | tail -3', '').verdict, 'undetermined', 'silence is not a pass');
});

it('printed exit code behind a hidden status: failed, passed, undetermined', () => {
  assert.equal(checkResult('npm test; echo "EXIT=$?"', 'EXIT=3').verdict, 'failed');
  assert.equal(checkResult('npm test; echo $?', '0').verdict, 'passed');
  assert.equal(checkResult('npm test; echo done', 'done').verdict, 'undetermined', 'an echo without the status');
});

it('visible exit status decides: a green run with an exit-code line in the log stays passed', () => {
  assert.equal(
    checkResult('vitest run', 'process exited with code 1\nTests  3 passed (3)', 0).verdict,
    'passed',
  );
  assert.equal(checkResult('npm test', 'boom', 1).verdict, 'failed', 'visible nonzero, no summary');
});

it('a failure summary beats a zero exit status', () => {
  assert.equal(checkResult('vitest run', 'Tests  2 failed | 4 passed (6)', 0).verdict, 'failed');
});

it('summary lines count only for the detected runner or a package manager child that fits the kind', () => {
  // A summary-shaped line of another tool is output, not a verdict.
  assert.equal(checkResult('vitest run', 'Found 3 errors.\nTests  3 passed (3)', 0).verdict, 'passed', 'ruff line in a vitest run');
  assert.equal(checkResult('vitest run | tail', 'Found 3 errors.\nTests  3 passed (3)').verdict, 'passed');
  assert.equal(checkResult('eslint src', 'Found 3 errors.', 0).verdict, 'passed', 'ruff line in an eslint run');
  assert.equal(checkResult('pytest | tail', 'All checks passed!').verdict, 'undetermined', 'ruff pass line behind pytest');
  assert.equal(checkResult('pytest | tail', 'Tests  3 passed (3)').verdict, 'undetermined', 'vitest pass line behind pytest');
  assert.equal(checkResult('tsc --noEmit | tail', '✖ 3 problems (3 errors, 0 warnings)').verdict, 'undetermined');
  assert.equal(checkResult('vitest run', 'src/a.ts:1:5 - error TS2322: nope', 0).verdict, 'passed', 'tsc line in a vitest run');
  assert.equal(checkResult('go test ./... | tail', 'ℹ fail 2').verdict, 'undetermined', 'node:test line behind go test');
  // The runner's own lines still decide; ruff's rule also reads mypy and biome.
  assert.equal(checkResult('vitest run', 'Tests  2 failed | 1 passed (3)', 0).verdict, 'failed');
  assert.equal(checkResult('mypy src', 'Found 3 errors in 1 file (checked 4 source files)', 0).verdict, 'failed');
  assert.equal(checkResult('mypy src | tail', 'Success: no issues found in 4 source files').verdict, 'passed');
  assert.equal(checkResult('biome check . | tail', 'Found 2 errors.', 1).verdict, 'failed');
  assert.equal(checkResult('python -m pytest | tail', '===== 5 passed in 0.2s =====').verdict, 'passed', 'wrapper stripped first');
  // A package manager runs an unknown script, so it reads the runners that fit the kind of the check.
  assert.equal(checkResult('npm run test', 'Found 3 errors.\nTests  3 passed (3)', 0).verdict, 'passed');
  assert.equal(checkResult('npm test | tail', 'Tests  3 passed (3)').verdict, 'passed', 'vitest child');
  assert.equal(checkResult('npm test | tail', 'Tests  1 failed | 2 passed (3)', 1).verdict, 'failed', 'vitest child failure');
  assert.equal(checkResult('pnpm test | tail', '===== 5 passed in 0.2s =====').verdict, 'passed', 'pytest child');
  assert.equal(checkResult('npm test | tail', 'All checks passed!').verdict, 'undetermined', 'a lint line does not pass a test run');
  assert.equal(checkResult('npm test | tail', '✖ 3 problems (3 errors, 0 warnings)').verdict, 'undetermined');
  assert.equal(checkResult('npm run lint | tail', 'All checks passed!').verdict, 'passed', 'ruff child of a lint script');
  assert.equal(checkResult('npm run lint | tail', '✖ 3 problems (3 errors, 0 warnings)', 1).verdict, 'failed', 'eslint child');
  assert.equal(checkResult('npm run lint | tail', 'Tests  3 passed (3)').verdict, 'undetermined', 'a test line does not pass a lint run');
  assert.equal(checkResult('npm run typecheck | tail', 'src/a.ts:1:5 - error TS2322: nope', 1).verdict, 'failed');
  assert.equal(checkResult('npm run build | tail', 'src/a.ts:1:5 - error TS2322: nope', 1).verdict, 'failed');
  assert.equal(checkResult('npm run build | tail', 'All checks passed!').verdict, 'undetermined');
  // A runner without summary rules reads none, so a foreign summary cannot pass or fail it.
  assert.equal(checkResult('mocha | tail', 'All checks passed!').verdict, 'undetermined');
  assert.equal(checkResult('mocha', 'Found 3 errors.', 0).verdict, 'passed');
});

it('zero-test reports count only for the detected runner or a fitting package manager child', () => {
  assert.equal(checkResult('pytest', 'no tests ran in 0.01s', 0).verdict, 'undetermined');
  assert.equal(checkResult('node --test', 'ℹ tests 0\nℹ pass 0\nℹ fail 0', 0).verdict, 'undetermined');
  assert.equal(checkResult('cargo test', 'running 0 tests', 0).verdict, 'undetermined');
  assert.equal(checkResult('npm test', 'no tests ran in 0.01s', 0).verdict, 'undetermined', 'pytest child of a test script');
  assert.equal(checkResult('npm test', 'Tests: 0 total', 0).verdict, 'undetermined', 'jest child of a test script');
  // A zero-test line of another runner is output, not a report.
  assert.equal(checkResult('vitest run', 'no tests ran in 0.01s', 0).verdict, 'passed');
  assert.equal(checkResult('vitest run', 'ℹ tests 0', 0).verdict, 'passed');
  assert.equal(checkResult('pytest', 'No tests found', 0).verdict, 'passed');
  assert.equal(checkResult('eslint src', 'No tests found', 0).verdict, 'passed');
  assert.equal(checkResult('npm run lint', 'No tests found', 0).verdict, 'passed', 'a lint script reads no test report');
  assert.equal(checkResult('go test ./...', 'running 0 tests', 0).verdict, 'passed');
});

it('narrowed run: a visible failure is failed, a visible pass is undetermined', () => {
  assert.equal(checkResult('vitest run -t login', 'boom', 1).verdict, 'failed');
  assert.equal(checkResult('vitest run -t login', 'ok', 0).verdict, 'undetermined');
});

it('zero-test runs stay undetermined; an early zero-test line in a long log does not count', () => {
  assert.equal(checkResult('vitest run', 'No tests found', 0).verdict, 'undetermined');
  assert.equal(checkResult('jest', 'Tests: 0 total', 0).verdict, 'undetermined');
  assert.equal(checkResult('go test -run TestFoo ./...', 'ok  pkg 0.1s [no tests to run]', 0).verdict, 'undetermined');
  assert.equal(
    checkResult('vitest run', 'No tests found\n' + 'x\n'.repeat(4000) + 'Tests  3 passed (3)', 0).verdict,
    'passed',
  );
  // cargo prints `running 0 tests` for its doc-tests after real results: not a zero-test run.
  assert.equal(checkResult('cargo test', 'running 5 tests\nok\nrunning 0 tests', 0).verdict, 'passed');
});

it('failure evidence beats a zero-test report; real results void it', () => {
  // A test that prints `No tests found` as data, or a script that chains a zero-test child with a failing one.
  assert.equal(checkResult('vitest run', 'No tests found\nTests  2 failed | 1 passed (3)', 1).verdict, 'failed');
  assert.equal(checkResult('vitest run', 'No tests found\nTests  2 failed | 1 passed (3)', 0).verdict, 'failed', 'a failure line beats a zero exit');
  assert.equal(checkResult('vitest run | tail', 'No tests found\nTests  2 failed | 1 passed (3)').verdict, 'failed');
  assert.equal(checkResult('npm test', 'No tests found\n===== 2 failed in 0.1s =====', 1).verdict, 'failed');
  assert.equal(checkResult('npm test', 'No tests found\nTest Files  1 failed | 1 passed (2)', 1).verdict, 'failed');
  assert.equal(checkResult('node --test', 'ℹ tests 0\nℹ tests 3\nℹ pass 1\nℹ fail 2', 1).verdict, 'failed');
  // Real results void the zero-test report even when nothing failed, so the visible exit status decides.
  assert.equal(checkResult('vitest run', 'No tests found\nTests  3 passed (3)', 0).verdict, 'passed');
  assert.equal(checkResult('vitest run', 'No tests found\n Tests  1 failed | 2 skipped (3)', 1).verdict, 'failed');
  assert.equal(checkResult('vitest run', 'No tests found\n\u001b[2m      Tests \u001b[22m \u001b[32m3 passed\u001b[39m (3)', 0).verdict, 'passed', 'colored summary');
  assert.equal(checkResult('jest', 'No tests found\nTests:       1 failed, 2 passed, 3 total', 1).verdict, 'failed', 'jest has no summary rule: the exit decides');
  assert.equal(checkResult('jest', 'No tests found\nTests:       3 passed, 3 total', 0).verdict, 'passed');
  assert.equal(checkResult('npm test', 'No tests found\nTests:       1 failed, 2 passed, 3 total', 1).verdict, 'failed', 'jest child of a script');
  assert.equal(checkResult('pytest', 'no tests ran\n===== 3 passed in 0.1s =====', 0).verdict, 'passed');
  assert.equal(checkResult('pytest', 'no tests ran\n3 passed, 1 warning in 0.1s', 0).verdict, 'passed', 'quiet mode summary');
  assert.equal(checkResult('pytest', 'no tests ran\n1 failed, 2 passed in 0.1s', 1).verdict, 'failed', 'quiet mode summary without rule marks');
  assert.equal(checkResult('node --test', 'ℹ tests 0\nℹ tests 3\nℹ pass 3\nℹ fail 0', 0).verdict, 'passed');
  assert.equal(checkResult('go test ./...', '[no tests to run]\nok  pkg 0.1s', 0).verdict, 'passed');
  // The zero-test report alone still leaves the check undetermined, with a zero or a nonzero exit.
  for (const cmd of ['vitest run', 'jest', 'npm test']) {
    assert.equal(checkResult(cmd, 'No tests found', 0).verdict, 'undetermined', `${cmd}: exit 0`);
    assert.equal(checkResult(cmd, 'No tests found', 1).verdict, 'undetermined', `${cmd}: exit 1`);
  }
  assert.equal(checkResult('jest', 'No tests found, exiting with code 1', 1).verdict, 'undetermined');
  assert.equal(checkResult('jest', 'Tests:       0 total', 1).verdict, 'undetermined');
  assert.equal(checkResult('pytest', 'no tests ran in 0.01s', 5).verdict, 'undetermined');
  assert.equal(checkResult('pytest', 'no tests ran, 1 warning in 0.01s', 5).verdict, 'undetermined', 'a warning is no result');
  assert.equal(checkResult('node --test', 'ℹ tests 0\nℹ pass 0\nℹ fail 0', 1).verdict, 'undetermined');
  assert.equal(checkResult('cargo test', 'running 0 tests', 1).verdict, 'undetermined');
});

it('mutations: editing tools', () => {
  assert.equal(isMutation('Write', { file_path: 'src/a.ts' }), true);
  assert.equal(isMutation('Edit', { file_path: 'src/a.ts' }), true);
  assert.equal(isMutation('MultiEdit', { file_path: 'src/a.ts' }), true);
  assert.equal(isMutation('NotebookEdit', { file_path: 'n.ipynb' }), true);
  // Docs, logs, lockfiles and images never need a passing check.
  assert.equal(isMutation('Write', { file_path: 'README.md' }), false);
  assert.equal(isMutation('Edit', { file_path: 'docs/guide.md' }), false);
  assert.equal(isMutation('Write', { file_path: 'logs/app.log' }), false);
  assert.equal(isMutation('Write', { file_path: 'package-lock.json' }), false);
  assert.equal(isMutation('Write', { file_path: 'img/logo.png' }), false);
  // Temp directories hold no code; a similar name outside them does.
  for (const dir of TEMP_DIRS) {
    assert.equal(isMutation('Write', { file_path: `${dir}/x.ts` }), false, `temp ${dir}`);
  }
  assert.equal(isMutation('Write', { file_path: `${TEMP_DIRS[0]}foo/x.ts` }), true, 'a prefix is not a temp directory');
  // Missing file_path: no mutation.
  assert.equal(isMutation('Write', {}), false);
  assert.equal(isMutation('Write', null), false);
});

it('a notebook edit is read from notebook_path; the other edit tools from file_path', () => {
  assert.equal(isMutation('NotebookEdit', { notebook_path: 'analysis/model.ipynb' }), true);
  assert.equal(isMutation('NotebookEdit', { notebook_path: '/repo/src/n.ipynb', cell_id: 'c1', new_source: 'x = 1' }), true);
  assert.equal(isMutation('NotebookEdit', { notebook_path: 'docs/n.ipynb' }), false, 'a notebook under docs');
  assert.equal(isMutation('NotebookEdit', { notebook_path: 'node_modules/p/n.ipynb' }), false, 'an installed package');
  assert.equal(isMutation('NotebookEdit', { notebook_path: `${TEMP_DIRS[0]}/n.ipynb` }), false, 'a notebook in a temp directory');
  assert.equal(isMutation('NotebookEdit', { notebook_path: '' }), false, 'an empty path');
  assert.equal(isMutation('NotebookEdit', {}), false, 'no path');
  assert.equal(isMutation('NotebookEdit', { file_path: 'n.ipynb' }), true, 'file_path still names the target when there is no notebook_path');
  assert.equal(isMutation('NotebookEdit', { notebook_path: 5, file_path: 'n.ipynb' }), true, 'a non-string notebook_path is not a path');
  assert.equal(isMutation('NotebookEdit', { notebook_path: 'docs/n.ipynb', file_path: 'src/a.ts' }), false, 'notebook_path decides for a notebook edit');
  for (const tool of ['Edit', 'Write', 'MultiEdit']) {
    assert.equal(isMutation(tool, { notebook_path: 'n.ipynb' }), false, `${tool} reads file_path only`);
  }
});

it('mutations: bash shell writes', () => {
  assert.equal(isMutation('Bash', { command: 'echo x > src/a.ts' }), true);
  assert.equal(isMutation('Bash', { command: 'cat x >> f.log' }), false, 'log target is ignored');
  assert.equal(isMutation('Bash', { command: 'echo hi > /dev/null' }), false);
  assert.equal(isMutation('Bash', { command: `echo hi > ${TEMP_DIRS[1]}/x.txt` }), false, 'temp target');
  assert.equal(isMutation('Bash', { command: 'echo a > "$TMPDIR/x"' }), false, 'TMPDIR target');
  assert.equal(isMutation('Bash', { command: 'echo hi | tee src/a.ts' }), true);
  assert.equal(isMutation('Bash', { command: "cat > a.ts <<'EOF'\nline\nEOF" }), true);
  assert.equal(isMutation('Bash', { command: "sed -i 's/a/b/' src/a.ts" }), true);
  assert.equal(isMutation('Bash', { command: 'perl -pi.bak -e "s/a/b/" src/a.ts' }), true);
  // A runner without a redirect is a check, not a mutation.
  assert.equal(isMutation('Bash', { command: 'npm test' }), false);
  // rm and git commit are outside the write table on purpose.
  assert.equal(isMutation('Bash', { command: 'rm src/a.ts' }), false);
  assert.equal(isMutation('Bash', { command: 'git commit -m "a > b"' }), false);
  assert.equal(isMutation('Bash', {}), false);
  assert.equal(isMutation('Bash', null), false);
});

it('in-place sed and perl: the file operands decide, not the flag', () => {
  const edits = (command: string) => isMutation('Bash', { command });
  // Documentation, lockfiles and temp paths are not code; a source file is.
  for (const file of ['README.md', 'package-lock.json', '/tmp/x.ts', 'docs/guide.ts']) {
    assert.equal(edits(`sed -i 's/a/b/' ${file}`), false, `sed -i ${file}`);
    assert.equal(edits(`perl -pi -e 's/a/b/' ${file}`), false, `perl -pi ${file}`);
  }
  assert.equal(edits("sed -i 's/a/b/' src/a.ts"), true);
  assert.equal(edits("perl -pi -e 's/a/b/' src/a.ts"), true);
  // Suffix forms and clusters: `-i.bak`, `-i ''` (BSD), `-ni`, `-Ei`, `--in-place[=SUFFIX]`, `-0777pi`, `-lpi`.
  assert.equal(edits("sed -i.bak 's/a/b/' README.md"), false);
  assert.equal(edits("sed -i.bak 's/a/b/' src/a.ts"), true);
  assert.equal(edits("sed -i '' 's/a/b/' README.md"), false);
  assert.equal(edits("sed -i '' 's/a/b/' src/a.ts"), true);
  assert.equal(edits("sed -ni 's/a/b/p' README.md"), false);
  assert.equal(edits("sed -Ei 's/a/b/' src/a.ts"), true);
  assert.equal(edits("sed --in-place 's/a/b/' README.md"), false);
  assert.equal(edits("sed --in-place=.bak 's/a/b/' README.md"), false);
  assert.equal(edits("sed --in-place=.bak 's/a/b/' src/a.ts"), true);
  assert.equal(edits("perl -pi.bak -e 's/a/b/' package-lock.json"), false);
  assert.equal(edits("perl -i.bak -pe 's/a/b/' src/a.ts"), true);
  assert.equal(edits("perl -0777pi -e 's/a/b/' README.md"), false);
  assert.equal(edits("perl -0777pi -e 's/a/b/' src/a.ts"), true);
  assert.equal(edits("perl -lpi -e 's/a/b/' docs/a.ts"), false);
  assert.equal(edits("perl -MFoo -pi -e 's/a/b/' README.md"), false);
  // The script is skipped: given by -e or -f, or the first operand; options may follow operands.
  assert.equal(edits("sed -i -e 's/a/b/' -e 's/c/d/' README.md"), false);
  assert.equal(edits("sed -i -e 's/a/b/' src/a.ts"), true);
  assert.equal(edits('sed -i -f edit.sed README.md'), false, 'the script file is not a target');
  assert.equal(edits('sed -i -f edit.sed src/a.ts'), true);
  assert.equal(edits("sed --expression 's/a/b/' --in-place README.md"), false);
  assert.equal(edits("sed --expression='s/a/b/' -i src/a.ts"), true);
  assert.equal(edits("sed 's/a/b/' -i README.md"), false);
  assert.equal(edits("sed -i -- 's/a/b/' README.md"), false);
  assert.equal(edits("sed -i 's/a/b/' -- src/a.ts"), true);
  assert.equal(edits('perl -pi edit.pl README.md'), false, 'the program file is not a target');
  assert.equal(edits('perl -pi edit.pl src/a.ts'), true);
  // Several files: one code file among ignored ones is a change.
  assert.equal(edits("sed -i 's/a/b/' README.md docs/x.ts"), false);
  assert.equal(edits("sed -i 's/a/b/' README.md src/a.ts"), true);
  // A `;` inside the script, a redirect, a later command: the arguments end where the command ends.
  assert.equal(edits("sed -i 's/a;b/c/' README.md"), false);
  assert.equal(edits("sed -i 's/a/b/' README.md && npm test"), false);
  assert.equal(edits("sed -i 's/a/b/' README.md 2>&1 | tail"), false);
  assert.equal(edits("sed -i 's/a/b/' README.md; echo x > src/a.ts"), true, 'a later redirect still counts');
  // No in-place flag: no edit; files from input or a variable are unknown, so they count as code.
  assert.equal(edits("sed -n 's/a/b/p' src/a.ts"), false);
  assert.equal(edits("sed 's/a/b/' src/a.ts > /tmp/out.ts"), false);
  assert.equal(edits("perl -pe 's/a/b/' src/a.ts"), false);
  assert.equal(edits("git ls-files | xargs sed -i 's/a/b/'"), true);
  assert.equal(edits("find . -name '*.ts' -exec sed -i 's/a/b/' {} +"), true);
  assert.equal(edits('sed -i "s/a/b/" "$FILE"'), true);
  assert.equal(edits('/usr/bin/sed -i s/a/b/ src/a.ts'), true);
  assert.equal(edits('echo "sed -i x src/a.ts"'), false, 'quoted text is not a command');
});

it('in-place edit parsing is linear in the length of the command', () => {
  const long = (piece: string) => piece.repeat(Math.ceil(40000 / piece.length));
  const got = classifyInChild<boolean>([
    long('sed '),
    long('sed -i '),
    long('perl -pi -e '),
    `sed -i x ${long('a ')}`,
    `sed -i ${long("'a' ")}`,
    long("'"),
    long('"'),
    long('\\'),
    `${long(' ; ')}sed -i x README.md`,
    `sed -i 's/a/b/' ${long('docs/a.md ')}`,
  ], 'isMutation', "isMutation('Bash', { command })");
  assert.equal(got.length, 10);
  assert.equal(got[9], false, 'a long list of ignored files stays ignored');
});

it('here-documents: the redirections on the operator line count, the body text does not', () => {
  const edits = (command: string) => isMutation('Bash', { command });
  // A redirect after the delimiter, in every delimiter form.
  for (const operator of ['<<EOF', '<<-EOF', "<<'EOF'", '<<"EOF"', '<< EOF', '<<\\EOF', '<<EOF>src/a.ts']) {
    const redirected = operator.endsWith('>src/a.ts') ? operator : `${operator} > src/a.ts`;
    assert.equal(edits(`cat ${redirected}\nbody\nEOF`), true, `${operator} > src/a.ts`);
    assert.equal(edits(`cat ${operator.replace('>src/a.ts', '')} > README.md\nbody > src/a.ts\nEOF`), false, `${operator} > README.md`);
  }
  assert.equal(edits('cat <<EOF > src/a.ts\nx\nEOF'), true);
  assert.equal(edits('cat <<EOF >> src/a.ts\nx\nEOF'), true);
  assert.equal(edits('cat <<EOF 2> /tmp/err > src/a.ts\nx\nEOF'), true);
  assert.equal(edits('cat <<EOF > "src/a.ts"\nx\nEOF'), true);
  assert.equal(edits('cat <<-EOF > src/a.ts\n\tx\n\tEOF'), true, 'tab-indented terminator');
  assert.equal(edits('cat <<EOF | tee src/a.ts\nx\nEOF'), true);
  assert.equal(edits('cat <<EOF | tee -a src/a.ts\nx\nEOF'), true);
  assert.equal(edits('cat <<EOF | tee README.md\nx\nEOF'), false);
  // The command after the terminator is its own line: a `tee` with no file does not read it as a file name.
  assert.equal(edits('cat <<EOF | tee README.md\nx\nEOF\nnpm test'), false);
  assert.equal(edits('cat <<EOF | tee src/a.ts\nx\nEOF\nnpm test'), true);
  assert.equal(edits('echo hi | tee\nnpm test'), false);
  // Redirect before the delimiter, and a redirect on a later line.
  assert.equal(edits('cat > src/a.ts <<EOF\nx\nEOF'), true);
  assert.equal(edits('cat > README.md <<EOF\nx > src/a.ts\nEOF'), false, 'the body is text');
  assert.equal(edits('cat <<EOF > README.md\nx\nEOF\necho a > src/a.ts'), true);
  assert.equal(edits('cat <<EOF > README.md\nx > src/a.ts\nEOF'), false, 'the body is text');
  assert.equal(edits('cat <<EOF > README.md\n\n\nEOF'), false, 'blank lines in the body');
  assert.equal(edits('cat <<EOF > README.md\nEOF\necho a > src/a.ts'), true, 'an empty body');
  // Several here-documents: one per line, or several on one line taking their bodies in order.
  assert.equal(edits('cat <<A > README.md\nx\nA\ncat <<B > src/b.ts\ny\nB'), true);
  assert.equal(edits('cat <<A > README.md\nx > src/a.ts\nA\ncat <<B > docs/b.ts\ny > src/b.ts\nB'), false);
  assert.equal(edits('cat <<A > README.md; cat <<B > src/b.ts\nx\nA\ny\nB'), true);
  assert.equal(edits('cat <<A > src/a.ts; cat <<B > README.md\nx\nA\ny\nB'), true);
  assert.equal(edits('cat <<A > README.md; cat <<B > docs/b.ts\nx > src/z.ts\nA\ny > src/z.ts\nB'), false, 'both bodies are text');
  assert.equal(edits('cat <<A > README.md; cat <<B > docs/b.ts\nx\nA\ny\nB\necho z > src/z.ts'), true, 'a line after both');
  // Not a here-document: a here-string, an arithmetic shift, an operator with no terminator line.
  assert.equal(edits('cat <<< "x" > src/a.ts'), true);
  assert.equal(edits('cat <<<EOF > src/a.ts'), true, 'a here-string with no space and a redirect');
  assert.equal(edits('cat <<<EOF\necho y > src/a.ts\nEOF'), true, 'a here-string takes no body: the next line is a command');
  assert.equal(edits('cat <<<EOF > README.md\necho y > src/a.ts\nEOF'), true);
  assert.equal(edits('cat <<<EOF\necho y > README.md\nEOF'), false, 'the lines are commands, and they write an ignored file');
  assert.equal(edits('cat <<< "x" > README.md\necho a > src/a.ts'), true);
  assert.equal(edits('x=$((1<<3))\necho hi > src/a.ts'), true);
  assert.equal(edits('cat <<EOF > README.md\nx > src/a.ts'), true, 'no terminator: nothing is cut');
  assert.equal(edits('cat <<EOF > README.md'), false);
});

it('write targets are read as the shell reads them: quotes and escaped spaces do not hide an ignored file', () => {
  const edits = (command: string) => isMutation('Bash', { command });
  // An ignored target stays ignored in quotes (docs, lockfiles, temp directories).
  assert.equal(edits('echo x > "README.md"'), false);
  assert.equal(edits("echo x > 'README.md'"), false);
  assert.equal(edits('cat <<EOF > "docs/a.md"\nx\nEOF'), false);
  assert.equal(edits('echo x | tee "package-lock.json"'), false);
  assert.equal(edits('echo x | tee -a \'README.md\''), false);
  assert.equal(edits("sed -i 's/a/b/' \"README.md\""), false);
  assert.equal(edits('printf x >> "/tmp/x.ts"'), false);
  assert.equal(edits('echo x 2> "err.log"'), false);
  assert.equal(edits('echo x > "/dev/null"'), false);
  assert.equal(edits('echo x>"README.md"'), false, 'no space before the target');
  assert.equal(edits('echo "x">README.md'), false, 'a quoted word right before the operator');
  // A code file stays code in quotes, and an unquoted target works as before.
  assert.equal(edits('echo x > "src/a.ts"'), true);
  assert.equal(edits("echo x > 'src/a.ts'"), true);
  assert.equal(edits('echo x | tee "src/a.ts"'), true);
  assert.equal(edits('echo x | tee "README.md" "src/a.ts"'), true, 'one of several targets is code');
  assert.equal(edits('echo x | tee "src/a.ts" "README.md"'), true);
  assert.equal(edits('echo x > src/a.ts'), true);
  assert.equal(edits('echo x > README.md'), false);
  // A path with a space is one target, quoted or with an escaped space.
  assert.equal(edits('echo x > "my docs/a.md"'), false);
  assert.equal(edits('echo x > "src/my dir/a.ts"'), true);
  assert.equal(edits('echo x | tee "my docs/a.md"'), false);
  assert.equal(edits('echo x > my\\ docs/a.md'), false);
  assert.equal(edits('echo x > docs/my\\ dir/a.ts'), false);
  assert.equal(edits('echo x > src/my\\ dir/a.ts'), true);
  assert.equal(edits('echo x > "docs/my dir/a.ts"'), false);
  // The quoted text around a target is still text, not a redirection.
  assert.equal(edits('echo "a > src/a.ts"'), false);
  assert.equal(edits("echo 'tee src/a.ts'"), false);
  assert.equal(edits('echo a\\> src/a.ts'), false, 'an escaped > is a character');
  assert.equal(edits('echo "a > b" > src/a.ts'), true);
});

it('quoted write targets are read in linear time', () => {
  const long = (piece: string) => piece.repeat(Math.ceil(40000 / piece.length));
  const got = classifyInChild<boolean>([
    long('> "'),
    long('> "a" '),
    long('tee "a" '),
    long('\\ '),
    long('>'),
    long('tee '),
    `echo x > ${long('"a b"')}`,
    `echo x | tee ${long("'a b' ")}README.md`,
    long('"> a" '),
    long('"\\" '),
    `echo ${long('"a\\" ')} > README.md`,
  ], 'isMutation', "isMutation('Bash', { command })");
  assert.equal(got.length, 11);
  assert.equal(got[8], false, 'quoted text holds no redirection');
});

it('nested shells: the string of `sh -c` is read for writes, ssh stays out', () => {
  const edits = (command: string) => isMutation('Bash', { command });
  // A write or in-place edit inside the string counts as a code change.
  assert.equal(edits("sh -c 'sed -i s/a/b/ src/a.ts'"), true);
  assert.equal(edits('bash -c "echo x > src/a.ts"'), true);
  assert.equal(edits("bash -lc 'echo x > src/a.ts'"), true);
  assert.equal(edits('/bin/bash -ec "echo x | tee src/a.ts"'), true);
  assert.equal(edits("zsh -c 'echo x > src/a.ts'"), true);
  assert.equal(edits("dash -c 'perl -pi -e s/a/b/ src/a.ts'"), true);
  assert.equal(edits("ksh -c 'echo x > src/a.ts'"), true);
  assert.equal(edits("bash -o pipefail -c 'echo x > src/a.ts'"), true);
  assert.equal(edits("bash --noprofile -c 'echo x > src/a.ts'"), true);
  assert.equal(edits('bash -c "cat <<EOF > src/a.ts\nx\nEOF"'), true, 'a here-document inside the string');
  assert.equal(edits("zsh -c 'echo x > README.md; echo y > src/a.ts'"), true, 'one code write among ignored ones');
  assert.equal(edits("npm test && bash -c 'echo x > src/a.ts'"), true, 'a later piece');
  // After launch wrappers, and with su.
  assert.equal(edits("sudo sh -c 'echo x > src/a.ts'"), true);
  assert.equal(edits("sudo -u root bash -c 'echo x > src/a.ts'"), true);
  assert.equal(edits("env FOO=1 bash -c 'echo x > src/a.ts'"), true);
  assert.equal(edits("env -u FOO bash -c 'echo x > src/a.ts'"), true);
  assert.equal(edits("command bash -c 'echo x > src/a.ts'"), true);
  assert.equal(edits("nohup sh -c 'echo x > src/a.ts' &"), true);
  assert.equal(edits("su -c 'echo x > src/a.ts'"), true);
  assert.equal(edits("su root -c 'perl -pi -e s/a/b/ src/a.ts'"), true);
  assert.equal(edits("su -l root -c 'echo x > src/a.ts'"), true);
  assert.equal(edits("su --command='echo x > src/a.ts'"), true);
  // Two levels are read, a third is not.
  assert.equal(edits('sh -c "bash -c \'echo x > src/a.ts\'"'), true);
  assert.equal(edits('sh -c "sh -c \\"sh -c \'echo x > src/a.ts\'\\""'), false);
  // A \" inside the double-quoted string is a quote of the inner command, not the end of the string.
  assert.equal(edits('bash -c "echo \\"x > src/a.ts\\""'), false, 'the text is a quoted argument of echo');
  assert.equal(edits('sh -c "echo \\"x > src/a.ts\\"" > README.md'), false);
  assert.equal(edits('bash -c "echo \\"x\\" > src/a.ts"'), true, 'the redirect is outside the inner quotes');
  assert.equal(edits('sh -c "echo \\"x > README.md\\"; echo y > src/a.ts"'), true);
  assert.equal(edits('echo "a \\" > src/a.ts"'), false, 'an escaped quote does not end the string at the top level either');
  assert.equal(edits('echo "a \\"" > src/a.ts'), true);
  // Ignored targets and commands without a write stay no change.
  assert.equal(edits("sh -c 'echo x > README.md'"), false);
  assert.equal(edits("sudo bash -c 'echo x > docs/a.md'"), false);
  assert.equal(edits("bash -c 'ls src'"), false);
  assert.equal(edits("bash -c 'npm test'"), false);
  assert.equal(edits("bash -c 'echo x > /tmp/x.ts'"), false);
  assert.equal(edits("bash -c 'sed -i s/a/b/ README.md'"), false);
  // Not a command string: a script file, a quoted word of another command, a remote shell.
  assert.equal(edits("bash script.sh -c 'echo x > src/a.ts'"), false);
  assert.equal(edits("echo bash -c 'echo x > src/a.ts'"), false);
  assert.equal(edits("ssh host 'sed -i s/a/b/ src/a.ts'"), false, 'ssh runs elsewhere: a documented limit');
  assert.equal(edits('ssh host "echo x > src/a.ts"'), false, 'ssh runs elsewhere: a documented limit');
});

it('a write command counts only as the command word of a command, not among the arguments of another', () => {
  const edits = (command: string) => isMutation('Bash', { command });
  // The name of a writing command in the arguments of a reading or printing command writes nothing.
  for (const command of [
    'rg tee src/a.ts', 'echo tee src/a.ts', 'grep tee src/a.ts', 'cat tee src/a.ts', 'man tee src/a.ts', 'ls tee src/a.ts',
    'rg sed -i src/a.ts', 'echo sed -i x src/a.ts', "rg 'sed -i' src/a.ts", 'echo "perl -pi x" src/a.ts', 'grep mv src/a.ts',
    'echo perl -pi -e s/a/b/ src/a.ts', 'git log --grep tee src/a.ts', 'npm test tee src/a.ts', 'which sed src/a.ts',
    'echo "x" | rg tee src/a.ts', 'ls; rg sed -i src/a.ts', 'echo a | grep -i sed src/a.ts',
  ]) {
    assert.equal(edits(command), false, command);
  }
  // The command word of any command counts: first, after an operator, a newline, a group or a substitution.
  for (const command of [
    'tee src/a.ts', 'echo hi | tee src/a.ts', 'echo hi |tee src/a.ts', 'ls && tee src/a.ts', 'ls || tee src/a.ts', 'ls; tee src/a.ts',
    'ls\ntee src/a.ts', 'ls & tee src/a.ts', '(cd x; tee src/a.ts)', 'echo $(tee src/a.ts)', 'echo `tee src/a.ts`', 'sed -i s/a/b/ src/a.ts',
    'ls | sed -i s/a/b/ src/a.ts', 'cd x && perl -pi -e s/a/b/ src/a.ts', 'echo hi | tee -a src/a.ts', 'echo hi | tee -- src/a.ts',
  ]) {
    assert.equal(edits(command), true, command);
  }
  // After launch wrappers and reserved words, with their options, assignments and positional words.
  for (const command of [
    'sudo tee src/a.ts', 'sudo -u root tee src/a.ts', 'doas tee src/a.ts', 'env tee src/a.ts', 'env -u FOO FOO2=1 sed -i s/a/b/ src/a.ts',
    'command tee src/a.ts', 'nohup tee src/a.ts', 'exec sed -i s/a/b/ src/a.ts', 'time tee src/a.ts', 'time -p sed -i s/a/b/ src/a.ts',
    'nice -n 5 tee src/a.ts', 'timeout 5 tee src/a.ts', 'timeout -s KILL 5 sed -i s/a/b/ src/a.ts', 'FOO=1 tee src/a.ts', 'FOO=1 BAR=2 sed -i s/a/b/ src/a.ts',
    'echo x | xargs tee src/a.ts', 'echo x | xargs -n 1 -I {} tee src/a.ts', 'echo x | xargs -0 sed -i s/a/b/', 'sudo env FOO=1 nohup tee src/a.ts',
    'if true; then tee src/a.ts; fi', 'for f in a; do sed -i s/a/b/ $f; done', 'while true; do tee src/a.ts; done', '! tee src/a.ts',
    '{ tee src/a.ts; }', "find . -name '*.ts' -exec sed -i s/a/b/ {} +", "find . -execdir sed -i s/a/b/ {} \\;",
    "find . -ok perl -pi -e s/a/b/ {} \\;", 'sh -c "echo x | tee src/a.ts"',
  ]) {
    assert.equal(edits(command), true, command);
  }
  // Ignored targets stay ignored behind the same wrappers; a wrapper word alone is not a write command.
  for (const command of [
    'sudo tee README.md', 'echo x | xargs -n 1 tee docs/a.ts', 'timeout 5 sed -i s/a/b/ package-lock.json', 'sudo', 'timeout 5', 'xargs', 'env FOO=1',
    "find . -exec ls {} \\;", "find . -name tee -exec echo sed -i {} \\;", 'time', 'sudo -u',
  ]) {
    assert.equal(edits(command), false, command);
  }
  // The echoed name after the wrapper is an argument: `sudo echo tee` and `xargs echo sed -i` run echo.
  assert.equal(edits('sudo echo tee src/a.ts'), false);
  assert.equal(edits('xargs echo sed -i x src/a.ts'), false);
  assert.equal(edits('env FOO=tee echo src/a.ts'), false);
  // A comment is text: it holds no command word and no redirection; a # inside a word is not a comment.
  assert.equal(edits('ls # tee src/a.ts'), false);
  assert.equal(edits('ls # x; tee src/a.ts'), false);
  assert.equal(edits('echo x # > src/a.ts'), false);
  assert.equal(edits('echo x # > src/a.ts\necho y > src/b.ts'), true, 'the next line is code again');
  assert.equal(edits('echo a#b > src/a.ts'), true);
  assert.equal(edits('echo $# > src/a.ts'), true);
  assert.equal(edits('echo ${#x} > src/a.ts'), true);
  assert.equal(edits('echo x > src/a.ts # tee README.md'), true);
  assert.equal(edits('echo "# x" > src/a.ts'), true, 'a # in quotes is no comment');
  assert.equal(edits("sed -i 's/#x/y/' src/a.ts"), true, 'a # in a script is no comment');
  // The tee operands: options are skipped, an empty name is no file.
  assert.equal(edits('echo x | tee -a README.md src/a.ts'), true);
  assert.equal(edits('echo x | tee -p --output-error=warn README.md'), false);
  assert.equal(edits('echo x | tee ""'), false);
  assert.equal(edits('echo x | tee "src/my dir/a.ts"'), true);
  assert.equal(edits('echo x | tee "my docs/a.md"'), false);
});

it('cp, mv, install, truncate and dd of= write their destination, only as the command word', () => {
  const edits = (command: string) => isMutation('Bash', { command });
  // The destination decides: code is a change; documentation, lockfiles, temp directories and /dev/null are not.
  for (const program of ['cp', 'mv', 'cp -r', 'cp -p', 'mv -f', 'install', 'install -m 644', 'install -D', 'install -o root -g root']) {
    assert.equal(edits(`${program} a.ts src/b.ts`), true, `${program} to code`);
    assert.equal(edits(`${program} a.ts docs/b.ts`), false, `${program} to docs`);
    assert.equal(edits(`${program} a.ts README.md`), false, `${program} to a Markdown file`);
    assert.equal(edits(`${program} a.ts package-lock.json`), false, `${program} to a lockfile`);
    assert.equal(edits(`${program} a.ts ${TEMP_DIRS[0]}/b.ts`), false, `${program} to a temp directory`);
    assert.equal(edits(`${program} a.ts "$TMPDIR/b.ts"`), false, `${program} to $TMPDIR`);
    assert.equal(edits(`${program} a.ts /dev/null`), false, `${program} to the null device`);
  }
  assert.equal(edits('truncate -s 0 src/a.ts'), true);
  assert.equal(edits('truncate -s0 src/a.ts'), true);
  assert.equal(edits('truncate --size=0 src/a.ts'), true);
  assert.equal(edits('truncate -c -s 0 README.md src/a.ts'), true, 'one code file among ignored ones');
  assert.equal(edits('truncate -s 0 docs/a.ts'), false);
  assert.equal(edits('truncate -s 0 README.md package-lock.json'), false);
  assert.equal(edits(`truncate -s 0 ${TEMP_DIRS[0]}/a.ts`), false);
  assert.equal(edits('truncate -r src/ref.ts README.md'), false, 'the reference file is read, not written');
  assert.equal(edits('truncate --reference=src/ref.ts README.md'), false);
  assert.equal(edits('truncate -r README.md src/a.ts'), true);
  assert.equal(edits('dd if=a of=src/b.ts'), true);
  assert.equal(edits('dd of=src/b.ts bs=1M count=1'), true);
  assert.equal(edits('dd if=src/a.ts of=README.md'), false, 'the input file is only read');
  assert.equal(edits('dd if=src/a.ts of=/dev/null'), false);
  assert.equal(edits(`dd if=a of=${TEMP_DIRS[0]}/b.ts`), false);
  assert.equal(edits('dd if=a of="src/my dir/b.ts"'), true);
  assert.equal(edits('dd if=a of='), false, 'an empty target is no file');
  // The target directory option, in every spelling, and a destination that is a directory.
  assert.equal(edits('cp -t src/ a.ts'), true);
  assert.equal(edits('cp -t src a.ts b.ts'), true);
  assert.equal(edits('cp -tsrc/ a.ts'), true);
  assert.equal(edits('cp -rt src/ lib'), true, 'an option cluster that ends in -t');
  assert.equal(edits('cp --target-directory=src/ a.ts'), true);
  assert.equal(edits('cp --target-directory src/ a.ts'), true);
  assert.equal(edits('cp --target src/ a.ts'), true, 'an abbreviated long option');
  assert.equal(edits('cp a.ts -t src/'), true, 'options may follow operands');
  assert.equal(edits('mv -t src/ a.ts'), true);
  assert.equal(edits('install -t src/ a.ts'), true);
  assert.equal(edits('cp -t docs/ a.ts'), false);
  assert.equal(edits('cp -t docs a.ts'), false, 'a directory with no trailing slash');
  assert.equal(edits(`cp -t ${TEMP_DIRS[0]} a.ts`), false);
  assert.equal(edits('cp -t "$TMPDIR" a.ts'), false);
  assert.equal(edits('cp -t src/ README.md'), false, 'the file written is src/README.md');
  assert.equal(edits('cp README.md src/'), false);
  assert.equal(edits('cp a.ts b.ts c.ts docs'), false, 'several sources make the destination a directory');
  assert.equal(edits('cp a.ts b.ts c.ts src'), true);
  assert.equal(edits('cp a.ts docs/'), false);
  assert.equal(edits('cp a.ts src/'), true);
  assert.equal(edits('cp -T a.ts docs'), true, '-T makes the destination a file named docs');
  assert.equal(edits('cp -S .bak a.ts docs/b.md'), false, 'the value of -S is not a path');
  assert.equal(edits('cp --suffix .bak a.ts src/b.ts'), true);
  assert.equal(edits('install -m 644 -t src a.ts'), true, 'the value of -m is not a path');
  assert.equal(edits('install -m 644 a.ts docs/b.ts'), false);
  assert.equal(edits('install --strip a.ts src/b.ts'), true, '--strip is a flag, not an abbreviation of an option with a value');
  assert.equal(edits('install -s a.ts src/b.ts'), true);
  assert.equal(edits('install --strip-program=strip a.ts docs/b.ts'), false);
  assert.equal(edits('install --strip-program strip a.ts src/b.ts'), true);
  assert.equal(edits('cp -- a.ts src/b.ts'), true);
  assert.equal(edits('mv a.ts "src/my dir/b.ts"'), true);
  assert.equal(edits("cp a.ts 'docs/my dir/b.ts'"), false);
  // Options that write nothing, and commands with no destination.
  for (const command of [
    'cp --help', 'cp --version', 'mv --help', 'install --help', 'truncate --help', 'truncate', 'truncate -c', 'cp', 'mv', 'mv -n', 'cp -n a.ts', 'mv -n a.ts',
    'cp -r', 'install -d src/lib', 'install -d -m 755 src/a/b', 'install --directory src/lib', 'install', 'dd', 'dd if=src/a.ts', 'cp -t',
  ]) {
    assert.equal(edits(command), false, command);
  }
  assert.equal(edits('cp -t src/ -r'), true, 'a directory with no source still names the target');
  // Files from input: a directory or a size with no file operand names the target through xargs.
  assert.equal(edits('ls | xargs cp -t src/'), true);
  assert.equal(edits('ls | xargs cp -t docs/'), false);
  assert.equal(edits('ls | xargs truncate -s 0'), true);
  assert.equal(edits('truncate -s 0'), true, 'files from input, like an in-place sed with no file operand: counted as code on purpose');
  assert.equal(edits('echo x | xargs -I{} cp {} src/'), true);
  assert.equal(edits("find . -name '*.ts' -exec cp {} src/ \\;"), true);
  assert.equal(edits("find . -name '*.ts' -exec cp -t docs/ {} +"), false);
  // mv also removes its source, which is no write here (like rm).
  assert.equal(edits(`mv src/a.ts ${TEMP_DIRS[0]}/`), false);
  assert.equal(edits('mv src/a.ts docs/'), false);
  // Wrappers, reserved words, a nested shell, an absolute path, an escaped name.
  for (const command of [
    'sudo cp a.ts src/b.ts', 'sudo -u root mv a.ts src/b.ts', 'doas install a.ts src/b.ts', 'env FOO=1 cp a.ts src/b.ts', 'env -u FOO truncate -s 0 src/a.ts',
    'nohup cp a.ts src/b.ts', 'command mv a.ts src/b.ts', 'time cp a.ts src/b.ts', 'timeout 5 dd if=a of=src/b.ts', 'FOO=1 cp a.ts src/b.ts',
    'sudo env FOO=1 nohup cp a.ts src/b.ts', 'ls && cp a.ts src/b.ts', 'ls; mv a.ts src/b.ts', 'ls | install a.ts src/b.ts', '(cd x; truncate -s 0 src/a.ts)',
    'echo $(cp a.ts src/b.ts)', 'if true; then cp a.ts src/b.ts; fi', 'for f in a; do cp $f src/b.ts; done', '! cp a.ts src/b.ts', '{ dd of=src/a.ts; }',
    "sh -c 'cp a.ts src/b.ts'", 'bash -lc "mv a.ts src/b.ts"', "sudo sh -c 'truncate -s 0 src/a.ts'", "su -c 'dd if=a of=src/b.ts'",
    'sudo bash -c "sh -c \'cp a.ts src/b.ts\'"', '/bin/cp a.ts src/b.ts', '/usr/bin/dd if=a of=src/b.ts', '\\cp a.ts src/b.ts', 'cp a.ts src/b.ts && npm test',
  ]) {
    assert.equal(edits(command), true, command);
  }
  for (const command of [
    "sh -c 'cp a.ts README.md'", 'sudo cp a.ts docs/b.ts', 'sudo -u root install a.ts /tmp/b.ts', 'timeout 5 dd if=a of=README.md', 'env FOO=1 truncate -s 0 README.md',
    "su -c 'mv a.ts docs/b.ts'", 'cp a.ts README.md && echo done',
  ]) {
    assert.equal(edits(command), false, command);
  }
  // The name of a writing command among the arguments of another command writes nothing.
  for (const command of [
    'rg cp src/a.ts', 'echo mv a b', 'echo mv src/a.ts src/b.ts', 'grep install src/a.ts', 'rg truncate src/a.ts', 'echo dd of=src/a.ts', 'echo truncate -s0 src/a.ts',
    'echo install x src/a.ts', 'cat cp src/a.ts', 'ls mv src/a.ts', 'git log --grep cp src/a.ts', 'npm test cp a.ts src/b.ts', 'which cp src/a.ts',
    'man mv src/a.ts', 'echo "cp a.ts src/b.ts"', "echo 'dd of=src/a.ts'", 'sudo echo cp a.ts src/b.ts', 'xargs echo mv a.ts src/b.ts', 'echo x | rg install src/a.ts',
    'ls # cp a.ts src/b.ts', 'ls # x; dd of=src/a.ts', 'ls; rg dd of=src/a.ts', 'echo cp; echo a.ts src/b.ts', "bash script.sh -c 'cp a.ts src/b.ts'", "ssh host 'cp a.ts src/b.ts'",
  ]) {
    assert.equal(edits(command), false, command);
  }
  // Other commands that copy or move are outside the write table, like rm.
  for (const command of ['ln -s a.ts src/b.ts', 'rsync a.ts src/b.ts', 'git checkout -- src/a.ts', 'git mv a.ts src/b.ts', 'rm src/a.ts']) {
    assert.equal(edits(command), false, command);
  }
  // A redirect or another write on the same line still counts as before.
  assert.equal(edits('cp a.ts README.md; echo x > src/a.ts'), true);
  assert.equal(edits('cp a.ts src/b.ts > /tmp/out'), true);
});

it('copy, truncate and dd arguments are read in linear time', () => {
  const long = (piece: string) => piece.repeat(Math.ceil(40000 / piece.length));
  const got = classifyInChild<boolean>([
    long('cp -t '),
    long('cp -t a '),
    long('cp --target '),
    long('cp -rt '),
    long('install -m '),
    long('install -m 644 -o x -g y '),
    long('truncate -s '),
    long('truncate -r '),
    long('dd of='),
    long('dd of=a '),
    `cp ${long('a ')}docs/`,
    `cp ${long('-t ')}docs/ a.ts`,
    `install ${long('-m 644 ')}docs/a.ts`,
    `truncate -s 0 ${long('docs/a.md ')}`,
    `dd ${long('if=a ')}of=README.md`,
    `echo x ${long('# cp a ')}\necho y > README.md`,
  ], 'isMutation', "isMutation('Bash', { command })");
  assert.equal(got.length, 16);
  assert.equal(got[10], false, 'a long list of sources copied into documentation');
  assert.equal(got[12], false, 'a long run of install options ending at an ignored target');
  assert.equal(got[13], false, 'a long list of ignored files');
  assert.equal(got[14], false, 'a long run of dd inputs ending at an ignored target');
  assert.equal(got[15], false, 'a long comment holds no command');
});

it('nested shell strings are read up to the size limit and skipped above it', () => {
  const nested = (length: number) => `sh -c '${'echo x > src/a.ts;'.padEnd(length, ' ')}'`;
  const got = [nested(100000), nested(100001), `${nested(100001)} && echo y > src/b.ts`, `${nested(100001)} > README.md`].map((command) => isMutation('Bash', { command }));
  assert.deepEqual(got, [true, false, true, false], 'the limit is 100000 characters of the string; the outer command is still read');
  assert.equal(isMutation('Bash', { command: nested(99999) }), true);
});

it('nested shell strings are read in linear time', () => {
  const long = (piece: string) => piece.repeat(Math.ceil(40000 / piece.length));
  const got = classifyInChild<boolean>([
    `sh -c '${'a '.repeat(20000)}'`,
    long("sh -c 'x' "),
    long('sh -c '),
    long('sudo '),
    long("bash -c 'bash -c ' "),
    `sh -c "${long('sh -c \\" ')}"`,
    `sh -c '${long('a > "b.md" ')}echo x > README.md'`,
    `bash -c '${'a '.repeat(80000)}'; echo x > src/a.ts`,
  ], 'isMutation', "isMutation('Bash', { command })");
  assert.equal(got.length, 8);
  assert.equal(got[6], false, 'ignored targets stay ignored in a long string');
  assert.equal(got[7], true, 'a string over the size limit is skipped, the outer write still counts');
});

it('command words, wrappers and comments are read in linear time', () => {
  const long = (piece: string) => piece.repeat(Math.ceil(40000 / piece.length));
  const got = classifyInChild<boolean>([
    long('sudo '),
    long('xargs -n '),
    long('timeout 5 '),
    long('time -p '),
    long('FOO=1 '),
    long('env -u '),
    long('if '),
    long('find -exec '),
    long('# '),
    long('`'),
    long('a;'),
    `${long('sudo ')}tee README.md`,
    `${long('xargs -n 1 ')}sed -i s/a/b/ src/a.ts`,
    `${long('find x -exec ')}tee README.md ;`,
    `echo x ${long('# a ')}\necho y > README.md`,
    `echo x | tee ${long('-a ')}README.md`,
  ], 'isMutation', "isMutation('Bash', { command })");
  assert.equal(got.length, 16);
  assert.equal(got[11], false, 'a long run of wrappers still reaches tee with an ignored target');
  assert.equal(got[12], true, 'a long run of xargs options still reaches sed');
  assert.equal(got[14], false, 'a long comment holds no command');
  assert.equal(got[15], false, 'a long run of tee options');
});

it('a redirection is no command word and no argument: the command after leading redirections is still the command', () => {
  const edits = (command: string) => isMutation('Bash', { command });
  // Every form of redirection in front of the command word, bare or after assignments and launch wrappers.
  const operators = ['>f.log', '> f.log', '>>f.log', '>> f.log', '2>f.log', '2> f.log', '2>&1', '2>&-', '&>f.log', '&> f.log', '&>>f.log', '<f.log', '< f.log', '>|f.log', '>| f.log', '>&2', '<&3', '3<f.log', '{fd}>f.log', '<<<x', '<<< x', '<> f.log', '> "f x.log"', '>f\\ x.log'];
  for (const redirect of operators) {
    for (const prefix of ['', 'FOO=1 ', 'sudo ', 'env A=b ', 'time ', 'nohup ', 'command ', 'timeout 5 ', 'FOO=1 sudo ', 'sudo -u root ']) {
      assert.equal(edits(`${prefix}${redirect} tee src/a.ts`), true, `${prefix}${redirect} tee src/a.ts: tee is the command`);
      assert.equal(edits(`${prefix}${redirect} cp a src/a.ts`), true, `${prefix}${redirect} cp: cp is the command`);
      assert.equal(edits(`${prefix}${redirect} tee README.md`), false, `${prefix}${redirect} tee README.md: an ignored target`);
    }
  }
  // Several redirections, assignments between them, and redirections after the command word.
  assert.equal(edits('> README.md > /dev/null 2>&1 tee src/a.ts'), true);
  assert.equal(edits('> README.md A=1 > /dev/null tee src/a.ts'), true);
  assert.equal(edits('tee > README.md src/a.ts'), true, 'a redirection between the words of the command');
  assert.equal(edits('tee src/a.ts > README.md'), true);
  // A redirection target and the words after it are the arguments of the command, not a command of their own.
  assert.equal(edits('echo hi > README.md tee src/a.ts'), false, 'tee is an argument of echo');
  assert.equal(edits('echo hi > README.md; tee src/a.ts'), true, 'a boundary starts a new command');
  assert.equal(edits('echo > README.md cp a src/a.ts'), false);
  assert.equal(edits('echo x > /dev/null tee src/a.ts'), false);
  assert.equal(edits('cat < in.txt tee src/a.ts'), false, 'the redirection target is not a command either');
  // The other write forms of the redirection: clobber, both streams, and a descriptor.
  assert.equal(edits('echo x >| src/a.ts'), true);
  assert.equal(edits('echo x >&src/a.ts'), true);
  assert.equal(edits('echo x >& src/a.ts'), true);
  assert.equal(edits('echo x &>> src/a.ts'), true);
  assert.equal(edits('{ echo x; } 3> src/a.ts'), true);
  assert.equal(edits('echo x >&2'), false);
  assert.equal(edits('echo x >&-'), false);
  assert.equal(edits('echo x 2>&1'), false);
  assert.equal(edits('echo x >| README.md'), false);
  // Process substitution is no redirection: its command still runs.
  assert.equal(edits('echo x > >(tee src/a.ts)'), true);
  assert.equal(edits('diff <(tee src/a.ts) b'), true);
  // The same reading for the check commands: leading redirections hide no runner, and a target is no file operand.
  for (const redirect of operators) {
    for (const prefix of ['', 'CI=1 ', 'env A=b ', 'time ', 'timeout 5 ', 'npx ']) {
      const got = classifyCommand(`${prefix}${redirect} npm test`);
      assert.equal(got.isCheck, true, `${prefix}${redirect} npm test: a check`);
      assert.equal(got.runner, 'npm', `${prefix}${redirect} npm test: the runner`);
      assert.equal(got.narrowed, false, `${prefix}${redirect} npm test: not narrowed`);
      assert.equal(got.exitHidden, false, `${prefix}${redirect} npm test: the exit status stays visible`);
    }
  }
  for (const cmd of [
    'pytest > out.txt', 'pytest >out.txt', 'pytest 2> err.log', 'pytest &>all.log', 'pytest < in.txt', 'pytest >> /tmp/x.log', 'pytest >| out.txt',
    'pytest "tests/" > out.txt', 'pytest > out.txt 2>&1', 'pytest>out.txt', 'npm test > "out file.txt"', 'npm test <&3', 'npm test >| out',
  ]) {
    const got = classifyCommand(cmd);
    assert.equal(got.isCheck, true, `${cmd}: a check`);
    assert.equal(got.narrowed, false, `${cmd}: the target of a redirection is no file operand`);
    assert.equal(got.exitHidden, false, `${cmd}: no pipe in ${cmd}`);
  }
  assert.equal(classifyCommand('pytest > out.txt tests/a.py').narrowed, true, 'a file operand after a redirection still narrows');
  assert.equal(classifyCommand('> a.txt pytest tests/a.py').narrowed, true);
  assert.equal(classifyCommand('pytest -m smoke > out.txt').narrowed, true);
  assert.equal(classifyCommand('npm test >| out | tail').exitHidden, true, 'a real pipe after a clobber redirection still hides the status');
  assert.equal(classifyCommand('echo hi > npm test').isCheck, false, 'npm test is no command after a redirection target');
  assert.equal(classifyCommand('echo hi > out.txt npm test').isCheck, false, 'echo prints the words');
  assert.equal(checkResult('> out.txt npm test', 'boom', 1).verdict, 'failed');
  assert.equal(checkResult('2>&1 npm test', 'ok', 0).verdict, 'passed');
});

it('leading redirections, assignments and wrappers are read in linear time', () => {
  const long = (piece: string) => piece.repeat(Math.ceil(40000 / piece.length));
  const got = classifyInChild<boolean>([
    `${long('> a.log ')}tee src/a.ts`,
    `${long('2>&1 ')}tee README.md`,
    `${long('FOO=1 > a.log ')}tee README.md`,
    `${long('>| a.log ')}cp a src/a.ts`,
    `${long('<<< ')}tee src/a.ts`,
    long('{fd}>'),
    long('>&'),
    `echo x ${long('> a.log ')}tee src/a.ts`,
  ], 'isMutation', "isMutation('Bash', { command })");
  assert.equal(got.length, 8);
  assert.equal(got[0], true, 'a long run of redirections still reaches tee');
  assert.equal(got[1], false, 'an ignored target after a long run of redirections');
  assert.equal(got[2], false);
  assert.equal(got[3], true);
  assert.equal(got[7], false, 'tee is an argument of echo, whatever the number of redirections before it');
  const classes = classifyInChild<{ isCheck: boolean; narrowed: boolean }>([
    `${long('> out.txt ')}npm test`,
    `${long('2>&1 ')}pytest`,
    `pytest ${long('> out.txt ')}`,
    `${long('FOO=1 > a.log ')}npm test`,
  ]);
  assert.equal(classes[0].isCheck, true);
  assert.equal(classes[1].isCheck, true);
  assert.equal(classes[2].narrowed, false, 'redirection targets narrow nothing');
  assert.equal(classes[3].isCheck, true);
});

it('many different here-document tags with no terminator line are read in linear time', () => {
  const lines = (count: number, line: (index: number) => string) => Array.from({ length: count }, (_, index) => line(index)).join('');
  // About 600000 characters: each tag is looked up once and never found. A search of the rest of the text
  // for every tag needs seconds here, the bound of classifyInChild is two.
  const open = classifyInChild<boolean>([lines(50000, (index) => `cat <<t${index}\n`)], 'isMutation', "isMutation('Bash', { command })");
  assert.deepEqual(open, [false]);
  const got = classifyInChild<boolean>([
    `${lines(4000, (index) => `cat <<t${index}\n`)}echo x > src/a.ts`, // no terminator: nothing is cut, the write counts
    lines(4000, (index) => `cat <<t${index} > README.md\nt${index}\n`), // every tag has its own terminator line
    `${lines(4000, (index) => `cat <<t${index} > README.md\nt${index}\n`)}echo x > src/a.ts`,
    lines(4000, () => 'cat <<EOF\n'), // one tag again and again, never closed
    `${lines(2000, (index) => `cat <<t${index}\n`)}${lines(2000, (index) => `t${index}\n`)}echo x > src/a.ts`, // terminators in a block at the end
  ], 'isMutation', "isMutation('Bash', { command })");
  assert.deepEqual(got, [true, false, true, false, true]);
});

it('here-document and zero-test parsing is linear in the length of the input', () => {
  const long = (piece: string) => piece.repeat(Math.ceil(40000 / piece.length));
  const tags = Array.from({ length: 4000 }, (_, index) => `<<t${index}\n`).join('');
  const got = classifyInChild<boolean>([
    long('cat <<EOF '),
    long('<<A\n'),
    long('<<a\nx\na\n'),
    tags,
    long('<<< x '),
    `cat <<EOF > README.md\n${'\n'.repeat(40000)}EOF`,
    `cat <<-${' '.repeat(40000)}EOF\nx\nEOF`,
    `tee${' '.repeat(40000)}`,
    `cat <<A > README.md;${long(' cat <<B ')}\nx\nA\ny\nB`,
  ], 'isMutation', "isMutation('Bash', { command })");
  assert.equal(got.length, 9);
  assert.equal(got[5], false, 'a long body of blank lines is cut');
  assert.equal(got[8], false, 'many operators on one line');
  // The adversarial text comes first so that the zero-test report still sits in the 6000-character tail.
  const outputs = [
    `Tests: ${'1'.repeat(40000)}\nNo tests found`,
    `Tests: ${'0 a, '.repeat(8000)}\nNo tests found`,
    `  Tests  ${'0 a | '.repeat(6000)}\nNo tests found`,
    `=== ${'1 a, '.repeat(8000)}x\nno tests ran`,
    `=== ${'0 a, '.repeat(8000)}0 passed\nno tests ran`,
    `${'\n'.repeat(40000)}no tests ran`,
    `${' '.repeat(40000)}Tests: 1 passed\nno tests ran`,
    `=${'1'.repeat(40000)}\nno tests ran`,
  ];
  const verdicts = classifyInChild<{ verdict: string }>(
    outputs, 'classifyCheckResult', "classifyCheckResult({ command: 'npm test', output: command, isError: false, exitCode: 0 })",
  );
  assert.equal(verdicts.length, 8);
  assert.deepEqual(verdicts.map((item) => item.verdict), [
    'undetermined', 'undetermined', 'undetermined', 'undetermined', 'undetermined', 'undetermined', 'passed', 'undetermined',
  ]);
});

it('a runner that writes to the null device is a check, not a mutation; echo of a runner into code is a mutation', () => {
  assert.equal(isMutation('Bash', { command: 'npm test > /dev/null' }), false);
  assert.equal(isMutation('Bash', { command: 'echo npm test > src/a.ts' }), true);
});

it('temp directories cover the macOS variants and match whole path segments only', () => {
  assert.deepEqual([...TEMP_DIRS].sort(), ['/private/tmp', '/private/var/tmp', '/tmp', '/var/tmp']);
  for (const dir of ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp']) {
    assert.equal(isMutation('Write', { file_path: `${dir}/x.ts` }), false, `Write under ${dir}`);
    assert.equal(isMutation('Bash', { command: `echo hi > ${dir}/x.ts` }), false, `redirect under ${dir}`);
    assert.equal(isMutation('Write', { file_path: `${dir}foo/x.ts` }), true, `${dir}foo is not a temp directory`);
  }
  assert.equal(isMutation('Write', { file_path: '/private/x.ts' }), true);
});

// A synchronous regular expression cannot be interrupted from the test process, so the long inputs run in a
// child process with a hard timeout: a catastrophic pattern fails the test instead of hanging the run.
// `call` is the expression evaluated for each command, with the exported function named in `name`.
function classifyInChild<T = { isCheck: boolean; kind: string | null }>(
  commands: string[], name = 'classifyCommand', call = 'classifyCommand(command)',
): T[] {
  const moduleUrl = new URL('../../tools/diagnostics/check_classifier.mjs', import.meta.url).href;
  const script = `
    import { readFileSync } from 'node:fs';
    import { ${name} } from ${JSON.stringify(moduleUrl)};
    const started = Date.now();
    const out = JSON.parse(readFileSync(0, 'utf8')).map((command) => ${call});
    process.stdout.write(JSON.stringify({ out, elapsed: Date.now() - started }));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    input: JSON.stringify(commands), // on standard input: a long command does not fit in an argument
    encoding: 'utf8',
    timeout: 20000,
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
  });
  assert.equal(run.error, undefined, `the child finished in time: ${String(run.error)}`);
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  // The old pattern needed minutes for these inputs; a generous bound keeps the test stable on a loaded host.
  assert.ok(parsed.elapsed < 2000, `classification took ${parsed.elapsed} ms`);
  return parsed.out;
}

it('a long run of package manager flags classifies in linear time and keeps its result', () => {
  const flags = (token: string) => `${token} `.repeat(40);
  const got = classifyInChild([
    `npm ${flags('--a')}x`,
    `npm ${flags('-a')}x`,
    `pnpm ${flags('--a v')}x`,
    `npm ${flags('--a')}test`,
    `pnpm ${flags('--filter @x/y')}run lint`,
    `timeout ${flags('--a')}`,
    `timeout ${flags('-s')}5 npm test`,
  ]);
  assert.equal(got[0].isCheck, false);
  assert.equal(got[1].isCheck, false);
  assert.equal(got[2].isCheck, false);
  assert.deepEqual([got[3].isCheck, got[3].kind], [true, 'test']);
  assert.deepEqual([got[4].isCheck, got[4].kind], [true, 'lint']);
  assert.equal(got[5].isCheck, false);
  assert.deepEqual([got[6].isCheck, got[6].kind], [true, 'test']);
});
