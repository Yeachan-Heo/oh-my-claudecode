import { execSync } from 'node:child_process';

function run(cmd) {
  return execSync(cmd, {
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

function passedTestFiles(output) {
  const match = output.match(/Test Files\s+(\d+) passed/i);
  return match ? Number(match[1]) : 0;
}

function passedTests(output) {
  const match = output.match(/Tests\s+(\d+) passed/i);
  return match ? Number(match[1]) : 0;
}

try {
  const runtimeOutput = run('npm run test:run -- src/autoresearch/__tests__/runtime.test.ts src/autoresearch/__tests__/runtime-parity-extra.test.ts');
  const cliOutput = run('npm test -- --run src/cli/__tests__/autoresearch.test.ts src/cli/__tests__/autoresearch-guided.test.ts');
  run('npm run build');

  const runtimeFiles = passedTestFiles(runtimeOutput);
  const runtimeTests = passedTests(runtimeOutput);
  const cliFiles = passedTestFiles(cliOutput);
  const cliTests = passedTests(cliOutput);
  const score = runtimeTests + cliTests + (runtimeFiles * 5) + (cliFiles * 5) + 10;

  process.stdout.write(JSON.stringify({
    pass: true,
    score,
    details: {
      runtime_test_files: runtimeFiles,
      runtime_tests: runtimeTests,
      cli_test_files: cliFiles,
      cli_tests: cliTests,
      build: 'pass',
    },
  }));
} catch (error) {
  const stdout = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout || '') : '';
  const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr || '') : '';
  process.stdout.write(JSON.stringify({
    pass: false,
    details: { stdout, stderr },
  }));
}
