import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

describe('skill cleanup and doctor repair safety', () => {
  it('runs actual ownership and caller branches with isolated command adapters', () => {
    const result = spawnSync('bash', [join(process.cwd(), 'skills/project-session-manager/tests/test-cleanup-safety.sh')], {
      env: process.env,
      encoding: 'utf-8',
      timeout: 90_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('advanced-HEAD non-force positive control');
    expect(result.stdout).toContain('automatic cleanup counts only successful checked Git removals');
  }, 100_000);

});
