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

it('narrowed run: a visible failure is failed, a visible pass is undetermined', () => {
  assert.equal(checkResult('vitest run -t login', 'boom', 1).verdict, 'failed');
  assert.equal(checkResult('vitest run -t login', 'ok', 0).verdict, 'undetermined');
});

it('zero-test runs stay undetermined; an early zero-test line in a long log does not count', () => {
  assert.equal(checkResult('vitest run', 'No tests found', 0).verdict, 'undetermined');
  assert.equal(checkResult('vitest run', 'Tests: 0 total', 0).verdict, 'undetermined');
  assert.equal(checkResult('go test -run TestFoo ./...', 'ok  pkg 0.1s [no tests to run]', 0).verdict, 'undetermined');
  assert.equal(
    checkResult('vitest run', 'No tests found\n' + 'x\n'.repeat(4000) + 'Tests  3 passed (3)', 0).verdict,
    'passed',
  );
  // cargo prints `running 0 tests` for its doc-tests after real results: not a zero-test run.
  assert.equal(checkResult('cargo test', 'running 5 tests\nok\nrunning 0 tests', 0).verdict, 'passed');
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
function classifyInChild(commands: string[]): Array<{ isCheck: boolean; kind: string | null }> {
  const moduleUrl = new URL('../../tools/diagnostics/check_classifier.mjs', import.meta.url).href;
  const script = `
    import { classifyCommand } from ${JSON.stringify(moduleUrl)};
    const started = Date.now();
    const out = JSON.parse(process.argv[1]).map((command) => classifyCommand(command));
    process.stdout.write(JSON.stringify({ out, elapsed: Date.now() - started }));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(commands)], {
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
