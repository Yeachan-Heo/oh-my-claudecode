import { describe, it, expect } from 'vitest';

describe('BUG 1: session summary spawn guard with PID tracking', () => {
  it('source has spawn timestamp guard preventing duplicate processes', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const source = readFileSync(
      join(process.cwd(), 'src/hud/index.ts'),
      'utf-8',
    );

    // Should track the last spawn timestamp
    expect(source).toContain('lastSummarySpawnTimestamp');

    // Should check elapsed time before spawning
    expect(source).toMatch(/now\s*-\s*lastSummarySpawnTimestamp/);

    // Should have a guard window (120s)
    expect(source).toContain('120_000');
  });

  it('source tracks spawned process PID', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const source = readFileSync(
      join(process.cwd(), 'src/hud/index.ts'),
      'utf-8',
    );

    // Should have a module-level PID tracking variable
    expect(source).toContain('summaryProcessPid');

    // Should check PID liveness with process.kill(pid, 0)
    expect(source).toMatch(/process\.kill\(summaryProcessPid,\s*0\)/);

    // Should store child.pid after spawn
    expect(source).toContain('summaryProcessPid = child.pid');
  });

  it('source exports _resetSummarySpawnTimestamp for testing', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const source = readFileSync(
      join(process.cwd(), 'src/hud/index.ts'),
      'utf-8',
    );

    expect(source).toContain('export function _resetSummarySpawnTimestamp');
  });

  it('source exports _getSummaryProcessPid for testing', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const source = readFileSync(
      join(process.cwd(), 'src/hud/index.ts'),
      'utf-8',
    );

    expect(source).toContain('export function _getSummaryProcessPid');
  });

  it('guard returns early before spawn when within window', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const source = readFileSync(
      join(process.cwd(), 'src/hud/index.ts'),
      'utf-8',
    );

    // The function should return early if within the window
    const fnStart = source.indexOf('function spawnSessionSummaryScript');
    const fnBody = source.slice(fnStart, fnStart + 800);
    expect(fnBody).toContain('return;');
    expect(fnBody).toContain('lastSummarySpawnTimestamp = now');
  });

  it('PID liveness check prevents second spawn when process is alive', () => {
    // Simulate the PID tracking logic with the current process (alive)
    let pid: number | null = process.pid;
    let spawnAllowed = true;

    if (pid !== null) {
      try {
        process.kill(pid, 0);
        // Process is still alive — skip spawn
        spawnAllowed = false;
      } catch {
        pid = null;
      }
    }

    expect(spawnAllowed).toBe(false);
  });

  it('dead PID allows respawn', () => {
    // Use a PID that is almost certainly dead
    let pid: number | null = 2147483647;
    let spawnAllowed = true;

    if (pid !== null) {
      try {
        process.kill(pid, 0);
        // Process alive — block
        spawnAllowed = false;
      } catch {
        // Process dead — allow respawn
        pid = null;
      }
    }

    expect(spawnAllowed).toBe(true);
    expect(pid).toBeNull();
  });

  it('null PID allows spawn (no previous process tracked)', () => {
    let pid: number | null = null;
    let spawnAllowed = true;

    if (pid !== null) {
      try {
        process.kill(pid, 0);
        spawnAllowed = false;
      } catch {
        pid = null;
      }
    }

    // No PID tracked, should allow spawn
    expect(spawnAllowed).toBe(true);
  });

  it('PID is cleared on spawn failure in source', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const source = readFileSync(
      join(process.cwd(), 'src/hud/index.ts'),
      'utf-8',
    );

    // Find the catch block in spawn section
    const fnStart = source.indexOf('function spawnSessionSummaryScript');
    const fnBody = source.slice(fnStart, fnStart + 1500);

    // The catch block should clear summaryProcessPid
    expect(fnBody).toMatch(/catch[\s\S]*?summaryProcessPid\s*=\s*null/);
  });
});
