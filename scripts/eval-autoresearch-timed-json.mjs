import { execSync } from 'node:child_process';

function run(cmd) {
  const start = Date.now();
  const output = execSync(cmd, {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  const durationMs = Date.now() - start;
  return { output, durationMs };
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
  const runtime = run('npm run test:run -- src/autoresearch/__tests__/runtime.test.ts src/autoresearch/__tests__/runtime-parity-extra.test.ts');
  const cli = run('npm test -- --run src/cli/__tests__/autoresearch.test.ts src/cli/__tests__/autoresearch-guided.test.ts');
  const build = run('npm run build');

  const runtimeFiles = passedTestFiles(runtime.output);
  const runtimeTests = passedTests(runtime.output);
  const cliFiles = passedTestFiles(cli.output);
  const cliTests = passedTests(cli.output);

  const totalMs = runtime.durationMs + cli.durationMs + build.durationMs;
  const correctnessScore = runtimeTests + cliTests + (runtimeFiles * 5) + (cliFiles * 5) + 10;
  const speedBonus = Math.max(0, Math.round((120000 - totalMs) / 1000));
  const score = correctnessScore + speedBonus;

  process.stdout.write(JSON.stringify({
    pass: true,
    score,
    details: {
      runtime_test_files: runtimeFiles,
      runtime_tests: runtimeTests,
      runtime_ms: runtime.durationMs,
      cli_test_files: cliFiles,
      cli_tests: cliTests,
      cli_ms: cli.durationMs,
      build_ms: build.durationMs,
      total_ms: totalMs,
      correctness_score: correctnessScore,
      speed_bonus: speedBonus,
      build: 'pass'
    }
  }));
} catch (error) {
  const stdout = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout || '') : '';
  const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr || '') : '';
  process.stdout.write(JSON.stringify({
    pass: false,
    details: { stdout, stderr }
  }));
}
