import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

// The Python parts of the tool tests are skipped where python3 is missing. A CI run must not go green over skipped tests,
// so there the missing interpreter is a failure (GitHub-hosted Linux runners have python3 installed).
describe('python3 for the tool tests', () => {
  it.skipIf(!process.env.CI)('is available when the tests run in CI, so that no Python part of them is skipped', () => {
    const run = spawnSync('python3', ['--version'], { encoding: 'utf8' });
    expect(run.status, 'python3 --version').toBe(0);
  });
});
