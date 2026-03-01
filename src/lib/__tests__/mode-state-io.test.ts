import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { writeModeState, readModeState, clearModeStateFile } from '../mode-state-io.js';

let tempDir: string;

describe('mode-state-io', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mode-state-io-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // writeModeState
  // -----------------------------------------------------------------------
  describe('writeModeState', () => {
    it('should write state with _meta containing written_at and mode', () => {
      const result = writeModeState('ralph', { active: true, iteration: 3 }, tempDir);

      expect(result).toBe(true);

      const filePath = join(tempDir, '.omc', 'state', 'ralph-state.json');
      expect(existsSync(filePath)).toBe(true);

      const written = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(written.active).toBe(true);
      expect(written.iteration).toBe(3);
      expect(written._meta).toBeDefined();
      expect(written._meta.mode).toBe('ralph');
      expect(written._meta.written_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should write session-scoped state when sessionId is provided', () => {
      const result = writeModeState('ultrawork', { active: true }, tempDir, 'pid-123-1000');

      expect(result).toBe(true);

      const filePath = join(tempDir, '.omc', 'state', 'sessions', 'pid-123-1000', 'ultrawork-state.json');
      expect(existsSync(filePath)).toBe(true);

      const written = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(written._meta.mode).toBe('ultrawork');
      expect(written.active).toBe(true);
    });

    it('should create parent directories as needed', () => {
      const result = writeModeState('autopilot', { phase: 'exec' }, tempDir);

      expect(result).toBe(true);
      expect(existsSync(join(tempDir, '.omc', 'state'))).toBe(true);
    });

    it('should write file with 0o600 permissions', () => {
      writeModeState('ralph', { active: true }, tempDir);
      const filePath = join(tempDir, '.omc', 'state', 'ralph-state.json');
      const { mode } = require('fs').statSync(filePath);
      // 0o600 = owner read+write only (on Linux the file mode bits are in the lower 12 bits)
      expect(mode & 0o777).toBe(0o600);
    });

    it('should not leave temp file after successful write', () => {
      writeModeState('ralph', { active: true }, tempDir);

      const filePath = join(tempDir, '.omc', 'state', 'ralph-state.json');
      expect(existsSync(filePath)).toBe(true);
      expect(existsSync(filePath + '.tmp')).toBe(false);
    });

    it('should preserve original file when a leftover .tmp exists from a prior crash', () => {
      // Simulate: a previous write crashed, leaving a .tmp file
      writeModeState('ralph', { active: true, iteration: 1 }, tempDir);
      const filePath = join(tempDir, '.omc', 'state', 'ralph-state.json');
      writeFileSync(filePath + '.tmp', 'partial-garbage');

      // A new write should overwrite the stale .tmp and succeed
      writeModeState('ralph', { active: true, iteration: 2 }, tempDir);

      const state = readModeState<Record<string, unknown>>('ralph', tempDir);
      expect(state).not.toBeNull();
      expect(state!.iteration).toBe(2);
      expect(existsSync(filePath + '.tmp')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // readModeState
  // -----------------------------------------------------------------------
  describe('readModeState', () => {
    it('should read state from legacy path when no sessionId', () => {
      const stateDir = join(tempDir, '.omc', 'state');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, 'ralph-state.json'),
        JSON.stringify({ active: true, _meta: { mode: 'ralph', written_at: '2026-01-01T00:00:00Z' } }),
      );

      const result = readModeState('ralph', tempDir);
      expect(result).not.toBeNull();
      expect(result!.active).toBe(true);
    });

    it('should strip _meta from the returned state', () => {
      const stateDir = join(tempDir, '.omc', 'state');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, 'ralph-state.json'),
        JSON.stringify({ active: true, iteration: 5, _meta: { mode: 'ralph', written_at: '2026-01-01T00:00:00Z' } }),
      );

      const result = readModeState('ralph', tempDir) as Record<string, unknown>;
      expect(result).not.toBeNull();
      expect(result.active).toBe(true);
      expect(result.iteration).toBe(5);
      expect(result._meta).toBeUndefined();
    });

    it('should handle files without _meta (pre-migration)', () => {
      const stateDir = join(tempDir, '.omc', 'state');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, 'ultrawork-state.json'),
        JSON.stringify({ active: true, phase: 'running' }),
      );

      const result = readModeState('ultrawork', tempDir) as Record<string, unknown>;
      expect(result).not.toBeNull();
      expect(result.active).toBe(true);
      expect(result.phase).toBe('running');
    });

    it('should read from session path when sessionId is provided', () => {
      const sessionDir = join(tempDir, '.omc', 'state', 'sessions', 'pid-999-2000');
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, 'autopilot-state.json'),
        JSON.stringify({ active: true, phase: 'exec' }),
      );

      const result = readModeState('autopilot', tempDir, 'pid-999-2000') as Record<string, unknown>;
      expect(result).not.toBeNull();
      expect(result.active).toBe(true);
      expect(result.phase).toBe('exec');
    });

    it('should NOT read legacy path when sessionId is provided', () => {
      // Write at legacy path only
      const stateDir = join(tempDir, '.omc', 'state');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, 'ralph-state.json'),
        JSON.stringify({ active: true }),
      );

      // Read with sessionId — should NOT find it at legacy path
      const result = readModeState('ralph', tempDir, 'pid-555-3000');
      expect(result).toBeNull();
    });

    it('should return null when file does not exist', () => {
      const result = readModeState('ralph', tempDir);
      expect(result).toBeNull();
    });

    it('should return null on invalid JSON', () => {
      const stateDir = join(tempDir, '.omc', 'state');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'ralph-state.json'), 'not-json{{{');

      const result = readModeState('ralph', tempDir);
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // clearModeStateFile
  // -----------------------------------------------------------------------
  describe('clearModeStateFile', () => {
    it('should delete the legacy state file', () => {
      const stateDir = join(tempDir, '.omc', 'state');
      mkdirSync(stateDir, { recursive: true });
      const filePath = join(stateDir, 'ralph-state.json');
      writeFileSync(filePath, JSON.stringify({ active: true }));

      const result = clearModeStateFile('ralph', tempDir);
      expect(result).toBe(true);
      expect(existsSync(filePath)).toBe(false);
    });

    it('should delete session-scoped state file', () => {
      const sessionDir = join(tempDir, '.omc', 'state', 'sessions', 'pid-100-500');
      mkdirSync(sessionDir, { recursive: true });
      const filePath = join(sessionDir, 'ultrawork-state.json');
      writeFileSync(filePath, JSON.stringify({ active: true }));

      const result = clearModeStateFile('ultrawork', tempDir, 'pid-100-500');
      expect(result).toBe(true);
      expect(existsSync(filePath)).toBe(false);
    });

    it('should perform ghost-legacy cleanup for files with matching session_id', () => {
      // Create legacy file owned by this session (top-level session_id)
      const stateDir = join(tempDir, '.omc', 'state');
      mkdirSync(stateDir, { recursive: true });
      const legacyPath = join(stateDir, 'ralph-state.json');
      writeFileSync(
        legacyPath,
        JSON.stringify({ active: true, session_id: 'pid-200-600' }),
      );

      // Create session-scoped file too
      const sessionDir = join(tempDir, '.omc', 'state', 'sessions', 'pid-200-600');
      mkdirSync(sessionDir, { recursive: true });
      const sessionPath = join(sessionDir, 'ralph-state.json');
      writeFileSync(sessionPath, JSON.stringify({ active: true }));

      const result = clearModeStateFile('ralph', tempDir, 'pid-200-600');
      expect(result).toBe(true);
      // Both files should be deleted
      expect(existsSync(sessionPath)).toBe(false);
      expect(existsSync(legacyPath)).toBe(false);
    });

    it('should clean up legacy file with no session_id (unowned/orphaned)', () => {
      const stateDir = join(tempDir, '.omc', 'state');
      mkdirSync(stateDir, { recursive: true });
      const legacyPath = join(stateDir, 'ultrawork-state.json');
      writeFileSync(legacyPath, JSON.stringify({ active: true }));

      const result = clearModeStateFile('ultrawork', tempDir, 'pid-300-700');
      expect(result).toBe(true);
      expect(existsSync(legacyPath)).toBe(false);
    });

    it('should NOT delete legacy file owned by a different session', () => {
      const stateDir = join(tempDir, '.omc', 'state');
      mkdirSync(stateDir, { recursive: true });
      const legacyPath = join(stateDir, 'ralph-state.json');
      writeFileSync(
        legacyPath,
        JSON.stringify({ active: true, session_id: 'pid-other-999' }),
      );

      clearModeStateFile('ralph', tempDir, 'pid-mine-100');
      // Legacy file should survive — it belongs to another session
      expect(existsSync(legacyPath)).toBe(true);
    });

    it('should return true when file does not exist (already absent)', () => {
      const result = clearModeStateFile('ralph', tempDir);
      expect(result).toBe(true);
    });
  });
});
