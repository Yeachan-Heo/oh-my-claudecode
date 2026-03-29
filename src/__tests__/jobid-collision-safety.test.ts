/**
 * Regression tests for race condition bug fixes.
 *
 * BUG 1: shared-state updateSharedTask has no file locking
 * BUG 2: git-worktree removeWorkerWorktree has unlocked metadata update
 * BUG 3: team-ops teamCreateTask has race on task ID generation
 * BUG 4: generateJobId not collision-safe
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
describe('generateJobId collision safety', () => {
  it('generateJobId includes randomness for uniqueness', () => {
    const sourcePath = join(__dirname, '..', 'cli', 'team.ts');
    const source = readFileSync(sourcePath, 'utf-8');

    // Extract the generateJobId function
    const fnMatch = source.match(/function generateJobId[\s\S]*?\n}/);
    expect(fnMatch).toBeTruthy();
    const fnBody = fnMatch![0];

    // Must include randomness (randomUUID or similar)
    expect(fnBody).toContain('randomUUID');
  });

  it('100 rapid calls produce 100 unique IDs', async () => {
    const { generateJobId } = await import('../cli/team.js');

    const ids = new Set<string>();
    const fixedTime = Date.now();
    for (let i = 0; i < 100; i++) {
      ids.add(generateJobId(fixedTime));
    }

    expect(ids.size).toBe(100);
  });

  it('generated IDs match the updated JOB_ID_PATTERN', async () => {
    const { generateJobId } = await import('../cli/team.js');
    const JOB_ID_PATTERN = /^omc-[a-z0-9]{1,16}$/;

    for (let i = 0; i < 50; i++) {
      const id = generateJobId();
      expect(JOB_ID_PATTERN.test(id)).toBe(true);
    }
  });

  it('generateJobId uses 8+ hex chars of randomness', async () => {
    const { generateJobId } = await import('../cli/team.js');

    const fixedTime = Date.now();
    const id = generateJobId(fixedTime);
    const prefix = `omc-${fixedTime.toString(36)}`;
    const randomPart = id.slice(prefix.length);

    // Must have at least 8 chars of randomness
    expect(randomPart.length).toBeGreaterThanOrEqual(8);
  });
});
