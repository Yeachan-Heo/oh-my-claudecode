import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let rootDir = '';

vi.mock('../../lib/worktree-paths.js', () => ({
  validateWorkingDirectory: (workingDirectory?: string) => workingDirectory ?? rootDir,
  getOmcRoot: (worktreeRoot?: string) => join(worktreeRoot ?? rootDir, '.omc'),
  ensureSessionStateDir: (sessionId: string, worktreeRoot?: string) => {
    const sessionDir = join(worktreeRoot ?? rootDir, '.omc', 'state', 'sessions', sessionId);
    mkdirSync(sessionDir, { recursive: true });
    return sessionDir;
  },
  resolveSessionStatePath: (stateName: string, sessionId: string, worktreeRoot?: string) => {
    const normalizedName = stateName.endsWith('-state') ? stateName : `${stateName}-state`;
    return join(worktreeRoot ?? rootDir, '.omc', 'state', 'sessions', sessionId, `${normalizedName}.json`);
  },
}));

import { readHudState, writeHudState } from '../../hud/state.js';

describe('HUD session-scoped state', () => {
  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'hud-session-state-'));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('writes HUD state into the current session directory and clears stale root fallback', () => {
    const staleRootDir = join(rootDir, '.omc');
    mkdirSync(staleRootDir, { recursive: true });
    writeFileSync(
      join(staleRootDir, 'hud-state.json'),
      JSON.stringify({ timestamp: '2024-01-01T00:00:00.000Z', sessionId: 'session-123', backgroundTasks: [] }),
    );

    const result = writeHudState(
      {
        timestamp: new Date().toISOString(),
        backgroundTasks: [],
      },
      rootDir,
      'session-123',
    );

    expect(result).toBe(true);

    const sessionFile = join(rootDir, '.omc', 'state', 'sessions', 'session-123', 'hud-state.json');
    expect(existsSync(sessionFile)).toBe(true);
    expect(existsSync(join(rootDir, '.omc', 'hud-state.json'))).toBe(false);

    const written = JSON.parse(readFileSync(sessionFile, 'utf-8')) as { sessionId?: string };
    expect(written.sessionId).toBe('session-123');
  });

  it('reads only the session-scoped HUD state when a sessionId is provided', () => {
    mkdirSync(join(rootDir, '.omc', 'state'), { recursive: true });
    writeFileSync(
      join(rootDir, '.omc', 'state', 'hud-state.json'),
      JSON.stringify({ timestamp: '2024-01-01T00:00:00.000Z', backgroundTasks: [{ id: 'stale-root' }] }),
    );
    writeFileSync(
      join(rootDir, '.omc', 'hud-state.json'),
      JSON.stringify({ timestamp: '2024-01-01T00:00:00.000Z', backgroundTasks: [{ id: 'legacy-root' }] }),
    );
    mkdirSync(join(rootDir, '.omc', 'state', 'sessions', 'session-999'), { recursive: true });
    writeFileSync(
      join(rootDir, '.omc', 'state', 'sessions', 'session-999', 'hud-state.json'),
      JSON.stringify({ timestamp: '2024-01-02T00:00:00.000Z', backgroundTasks: [{ id: 'session-state' }], sessionId: 'session-999' }),
    );

    const sessionState = readHudState(rootDir, 'session-999');
    expect(sessionState?.backgroundTasks).toEqual([{ id: 'session-state' }]);
    expect(sessionState?.sessionId).toBe('session-999');
  });

  it('does not revive root HUD state when the current session-scoped file is missing', () => {
    mkdirSync(join(rootDir, '.omc', 'state'), { recursive: true });
    writeFileSync(
      join(rootDir, '.omc', 'state', 'hud-state.json'),
      JSON.stringify({ timestamp: '2024-01-01T00:00:00.000Z', backgroundTasks: [{ id: 'stale-root' }] }),
    );
    writeFileSync(
      join(rootDir, '.omc', 'hud-state.json'),
      JSON.stringify({ timestamp: '2024-01-01T00:00:00.000Z', backgroundTasks: [{ id: 'legacy-root' }] }),
    );

    expect(readHudState(rootDir, 'session-missing')).toBeNull();
  });
});
