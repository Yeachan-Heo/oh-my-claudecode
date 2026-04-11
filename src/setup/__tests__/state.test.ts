import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

// Import after setting up env so module reads correct values
import { clearState, completeSetup, resumeState, saveState } from '../state.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `omc-state-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(path: string): unknown {
  return JSON.parse(require('node:fs').readFileSync(path, 'utf8'));
}

describe('state.ts', () => {
  let cwd: string;
  let configDir: string;

  beforeEach(() => {
    cwd = makeTmpDir();
    configDir = makeTmpDir();
    // Clear session env vars
    delete process.env['CLAUDE_SESSION_ID'];
    delete process.env['CLAUDECODE_SESSION_ID'];
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ── I1: save → resume → complete roundtrip ────────────────────────────────
  it('I1: save → resume → complete roundtrip', () => {
    saveState(3, 'global', { cwd });

    const stateFile = join(cwd, '.omc/state/setup-state.json');
    expect(existsSync(stateFile)).toBe(true);

    const result = resumeState({ cwd });
    expect(result.status).toBe('resume');
    if (result.status === 'resume') {
      expect(result.lastStep).toBe(3);
      expect(result.configType).toBe('global');
      expect(result.timestamp).toBeTruthy();
    }

    completeSetup('4.11.5', { cwd, configDir });

    // State file deleted
    expect(existsSync(stateFile)).toBe(false);

    // .omc-config.json written
    const configFile = join(configDir, '.omc-config.json');
    expect(existsSync(configFile)).toBe(true);
    const config = JSON.parse(require('node:fs').readFileSync(configFile, 'utf8')) as Record<string, unknown>;
    expect(config['setupVersion']).toBe('4.11.5');
    expect(typeof config['setupCompleted']).toBe('string');
  });

  // ── I2: corrupted JSON → returns fresh ───────────────────────────────────
  it('I2: resume with corrupted JSON state file → returns fresh', () => {
    const stateDir = join(cwd, '.omc/state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'setup-state.json'), '{ not valid json }', 'utf8');

    const result = resumeState({ cwd });
    expect(result.status).toBe('fresh');
  });

  // ── I3: complete preserves unknown keys ───────────────────────────────────
  it('I3: complete preserves unknown keys in .omc-config.json', () => {
    mkdirSync(configDir, { recursive: true });
    const configFile = join(configDir, '.omc-config.json');
    writeFileSync(configFile, JSON.stringify({ userFavoriteColor: 'blue', existingKey: 42 }), 'utf8');

    completeSetup('4.11.5', { cwd, configDir });

    const config = JSON.parse(require('node:fs').readFileSync(configFile, 'utf8')) as Record<string, unknown>;
    expect(config['userFavoriteColor']).toBe('blue');
    expect(config['existingKey']).toBe(42);
    expect(config['setupVersion']).toBe('4.11.5');
    expect(typeof config['setupCompleted']).toBe('string');
  });

  // ── I4: valid session ID clears only that session's file ─────────────────
  it('I4: complete with valid session ID clears skill-active-state for that session only', () => {
    const sessionA = 'session-aaa';
    const sessionB = 'session-bbb';

    const fileA = join(cwd, '.omc/state/sessions', sessionA, 'skill-active-state.json');
    const fileB = join(cwd, '.omc/state/sessions', sessionB, 'skill-active-state.json');
    mkdirSync(join(cwd, '.omc/state/sessions', sessionA), { recursive: true });
    mkdirSync(join(cwd, '.omc/state/sessions', sessionB), { recursive: true });
    writeFileSync(fileA, '{}', 'utf8');
    writeFileSync(fileB, '{}', 'utf8');

    process.env['CLAUDE_SESSION_ID'] = sessionA;
    completeSetup('4.11.5', { cwd, configDir });

    expect(existsSync(fileA)).toBe(false);
    expect(existsSync(fileB)).toBe(true);
  });

  // ── I5: no session ID → fallback deletes only stale files ─────────────────
  it('I5: complete with no session ID → fallback deletes stale files, preserves fresh', () => {
    const staleDir = join(cwd, '.omc/state/sessions/old-session');
    const freshDir = join(cwd, '.omc/state/sessions/new-session');
    mkdirSync(staleDir, { recursive: true });
    mkdirSync(freshDir, { recursive: true });

    const staleFile = join(staleDir, 'skill-active-state.json');
    const freshFile = join(freshDir, 'skill-active-state.json');
    writeFileSync(staleFile, '{}', 'utf8');
    writeFileSync(freshFile, '{}', 'utf8');

    // Back-date stale file to 35 minutes ago
    const staleTime = new Date(Date.now() - 35 * 60 * 1000);
    utimesSync(staleFile, staleTime, staleTime);

    // Fresh file's mtime is now (< 30 min)

    completeSetup('4.11.5', { cwd, configDir });

    expect(existsSync(staleFile)).toBe(false);
    expect(existsSync(freshFile)).toBe(true);
  });

  // ── 24h TTL: stale timestamp → returns fresh and deletes file ────────────
  it('24h TTL: state with 25h-old timestamp → resume returns fresh and deletes file', () => {
    const stateDir = join(cwd, '.omc/state');
    mkdirSync(stateDir, { recursive: true });
    const stateFile = join(stateDir, 'setup-state.json');
    const oldTs = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeFileSync(stateFile, JSON.stringify({ lastCompletedStep: 2, timestamp: oldTs, configType: 'global' }), 'utf8');

    const result = resumeState({ cwd });
    expect(result.status).toBe('fresh');
    expect(existsSync(stateFile)).toBe(false);
  });

  // ── Non-stale resume ──────────────────────────────────────────────────────
  it('non-stale resume: 1h-old state → returns resume with lastStep', () => {
    const stateDir = join(cwd, '.omc/state');
    mkdirSync(stateDir, { recursive: true });
    const stateFile = join(stateDir, 'setup-state.json');
    const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    writeFileSync(stateFile, JSON.stringify({ lastCompletedStep: 5, timestamp: recentTs, configType: 'local' }), 'utf8');

    const result = resumeState({ cwd });
    expect(result.status).toBe('resume');
    if (result.status === 'resume') {
      expect(result.lastStep).toBe(5);
      expect(result.configType).toBe('local');
    }
  });

  // ── Missing timestamp → forces fresh ─────────────────────────────────────
  it('missing timestamp field → forces fresh', () => {
    const stateDir = join(cwd, '.omc/state');
    mkdirSync(stateDir, { recursive: true });
    const stateFile = join(stateDir, 'setup-state.json');
    writeFileSync(stateFile, JSON.stringify({ lastCompletedStep: 1, configType: 'global' }), 'utf8');

    const result = resumeState({ cwd });
    expect(result.status).toBe('fresh');
    expect(existsSync(stateFile)).toBe(false);
  });

  // ── clearState ────────────────────────────────────────────────────────────
  it('clearState removes state file if present', () => {
    saveState(2, 'local', { cwd });
    const stateFile = join(cwd, '.omc/state/setup-state.json');
    expect(existsSync(stateFile)).toBe(true);

    clearState({ cwd });
    expect(existsSync(stateFile)).toBe(false);
  });

  it('clearState is a silent no-op when file missing', () => {
    // Should not throw
    expect(() => clearState({ cwd })).not.toThrow();
  });

  // ── resumeState when no file ──────────────────────────────────────────────
  it('resumeState returns fresh when no state file', () => {
    const result = resumeState({ cwd });
    expect(result.status).toBe('fresh');
  });
});
