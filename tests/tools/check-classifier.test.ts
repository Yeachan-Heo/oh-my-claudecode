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
  ['rm -rf x && npm test', true, false, 'relabelled: visible, the && chain reports the runner status on failure'],
  ['npm test && rm -rf dist', true, false, 'relabelled: visible, a failing npm test fails the chain'],
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
  assert.equal(edits('cat <<< "x" > README.md\necho a > src/a.ts'), true);
  assert.equal(edits('x=$((1<<3))\necho hi > src/a.ts'), true);
  assert.equal(edits('cat <<EOF > README.md\nx > src/a.ts'), true, 'no terminator: nothing is cut');
  assert.equal(edits('cat <<EOF > README.md'), false);
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
