import { randomUUID } from 'crypto';
import { execSync, spawn } from 'child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

import { emergencyMutateStateFileIf, recoverEmergencyStateFile, writeModeState, readModeState, clearModeStateFile } from '../mode-state-io.js';
import { clearWorktreeCache, getProjectIdentifier } from '../worktree-paths.js';

let tempDir: string;

describe('mode-state-io', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mode-state-io-test-'));
    clearWorktreeCache();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    clearWorktreeCache();
    delete process.env.OMC_STATE_DIR;
    delete process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_PATH;
    delete process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64;
    delete process.env.OMC_TEST_FLOCK_AVAILABLE;
    delete process.env.OMC_TEST_EMERGENCY_CRASH_PHASE;
    delete process.env.OMC_TEST_EMERGENCY_REPLACEMENT_PATH;
    delete process.env.OMC_TEST_EMERGENCY_REPLACEMENT_BASE64;
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

    it('should resolve writes to the git worktree root when called from a subdirectory', () => {
      const nestedDir = join(tempDir, 'nested', 'cwd');
      mkdirSync(nestedDir, { recursive: true });
      execSync('git init', { cwd: tempDir, stdio: 'pipe' });

      const result = writeModeState('autopilot', { phase: 'exec' }, nestedDir);

      expect(result).toBe(true);
      expect(existsSync(join(tempDir, '.omc', 'state', 'autopilot-state.json'))).toBe(true);
      expect(existsSync(join(nestedDir, '.omc', 'state', 'autopilot-state.json'))).toBe(false);
    });

    it('should write file with 0o600 permissions', () => {
      writeModeState('ralph', { active: true }, tempDir);
      const filePath = join(tempDir, '.omc', 'state', 'ralph-state.json');
      const { mode } = require('fs').statSync(filePath);
      // 0o600 = owner read+write only (on Linux the file mode bits are in the lower 12 bits)
      expect(mode & 0o777).toBe(0o600);
    });

    it('should not leave shared .tmp file after successful write (uses atomic write with unique temp)', () => {
      writeModeState('ralph', { active: true }, tempDir);

      const filePath = join(tempDir, '.omc', 'state', 'ralph-state.json');
      expect(existsSync(filePath)).toBe(true);
      // atomicWriteJsonSync uses random UUID-based temp files, not shared .tmp suffix
      expect(existsSync(filePath + '.tmp')).toBe(false);
    });

    it('releases normal writes without external flock', () => {
      process.env.NODE_ENV = 'test';
      process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
      expect(writeModeState('autopilot', { active: true }, tempDir)).toBe(true);
      expect(writeModeState('autopilot', { active: false }, tempDir)).toBe(true);
      expect(existsSync(join(tempDir, '.omc', 'state', 'autopilot-state.json.mutation.lock'))).toBe(false);
    });

    it('bypasses abandoned generic lock artifacts without flock', () => {
      process.env.NODE_ENV = 'test';
      process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
      const statePath = join(tempDir, '.omc', 'state', 'autopilot-state.json');
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(`${statePath}.mutation.lock`, JSON.stringify({ version: 1, pid: 999999999, processStart: '1', createdAt: new Date().toISOString(), nonce: randomUUID() }));

      expect(writeModeState('autopilot', { active: true }, tempDir)).toBe(true);
      expect(existsSync(`${statePath}.mutation.lock`)).toBe(true);
    });

    it('preserves legacy unlocked writes without flock when a lock artifact exists', () => {
      process.env.NODE_ENV = 'test';
      process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
      const statePath = join(tempDir, '.omc', 'state', 'autopilot-state.json');
      mkdirSync(dirname(statePath), { recursive: true });
      const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
      const processStart = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
      const owner = { version: 1, pid: process.pid, processStart, createdAt: new Date().toISOString(), nonce: randomUUID() };
      writeFileSync(`${statePath}.mutation.lock`, JSON.stringify(owner));

      expect(writeModeState('autopilot', { active: true }, tempDir)).toBe(true);
      expect(existsSync(`${statePath}.mutation.lock`)).toBe(true);
      expect(existsSync(statePath)).toBe(true);
    });

    it('should include sessionId in _meta when sessionId is provided', () => {
      writeModeState('ralph', { active: true }, tempDir, 'pid-session-42');

      const filePath = join(tempDir, '.omc', 'state', 'sessions', 'pid-session-42', 'ralph-state.json');
      expect(existsSync(filePath)).toBe(true);

      const written = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(written._meta.sessionId).toBe('pid-session-42');
    });

    it('should not include sessionId in _meta when sessionId is not provided', () => {
      writeModeState('ralph', { active: true }, tempDir);

      const filePath = join(tempDir, '.omc', 'state', 'ralph-state.json');
      const written = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(written._meta.sessionId).toBeUndefined();
    });

    it('should use atomic write preventing race conditions from shared .tmp path', () => {
      // Two concurrent writes should not collide on temp file paths
      // (atomicWriteJsonSync uses crypto.randomUUID() for temp file names)
      const result1 = writeModeState('ralph', { active: true, iteration: 1 }, tempDir);
      const result2 = writeModeState('ralph', { active: true, iteration: 2 }, tempDir);

      expect(result1).toBe(true);
      expect(result2).toBe(true);

      // The last write should win
      const state = readModeState<Record<string, unknown>>('ralph', tempDir);
      expect(state).not.toBeNull();
      expect(state!.iteration).toBe(2);
    });

    it('keeps centralized submodule mode state under the submodule identity', () => {
      const parentDir = mkdtempSync(join(tmpdir(), 'mode-state-submod-parent-'));
      const subDir = mkdtempSync(join(tmpdir(), 'mode-state-submod-child-'));
      const stateDir = mkdtempSync(join(tmpdir(), 'mode-state-central-'));

      try {
        execSync('git init', { cwd: subDir, stdio: 'pipe' });
        execSync('git commit --allow-empty -m "sub init"', {
          cwd: subDir,
          stdio: 'pipe',
          env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' },
        });
        execSync('git init', { cwd: parentDir, stdio: 'pipe' });
        execSync('git commit --allow-empty -m "parent init"', {
          cwd: parentDir,
          stdio: 'pipe',
          env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' },
        });
        execSync(`git -c protocol.file.allow=always submodule add "${subDir}" mysub`, {
          cwd: parentDir,
          stdio: 'pipe',
        });
        process.env.OMC_STATE_DIR = stateDir;
        clearWorktreeCache();

        const submodulePath = join(parentDir, 'mysub');
        const submoduleId = getProjectIdentifier(submodulePath);
        const parentId = getProjectIdentifier(parentDir);

        const result = writeModeState('ralph', { active: true }, submodulePath, 'session-submodule');

        expect(result).toBe(true);
        expect(existsSync(join(stateDir, submoduleId, 'state', 'sessions', 'session-submodule', 'ralph-state.json'))).toBe(true);
        expect(existsSync(join(stateDir, parentId, 'state', 'sessions', 'session-submodule', 'ralph-state.json'))).toBe(false);
      } finally {
        delete process.env.OMC_STATE_DIR;
        clearWorktreeCache();
        rmSync(stateDir, { recursive: true, force: true });
        rmSync(parentDir, { recursive: true, force: true });
        rmSync(subDir, { recursive: true, force: true });
      }
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

    it('should read state from the git worktree root when given a subdirectory', () => {
      const nestedDir = join(tempDir, 'nested', 'cwd');
      mkdirSync(nestedDir, { recursive: true });
      execSync('git init', { cwd: tempDir, stdio: 'pipe' });
      const stateDir = join(tempDir, '.omc', 'state');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, 'ralph-state.json'),
        JSON.stringify({ active: true, _meta: { mode: 'ralph', written_at: '2026-01-01T00:00:00Z' } }),
      );

      const result = readModeState('ralph', nestedDir);

      expect(result).not.toBeNull();
      expect(result!.active).toBe(true);
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
    it('clears state without consulting stale lock artifacts when flock is unavailable', () => {
      process.env.NODE_ENV = 'test';
      process.env.OMC_TEST_FLOCK_AVAILABLE = '0';
      const sessionId = 'workflow-session';
      expect(writeModeState('autopilot', { active: true }, tempDir, sessionId)).toBe(true);
      const statePath = join(tempDir, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      const lockPath = `${statePath}.mutation.lock`;
      writeFileSync(lockPath, JSON.stringify({
        version: 1,
        pid: 999999999,
        processStart: '1',
        createdAt: new Date().toISOString(),
        nonce: randomUUID(),
      }));

      expect(clearModeStateFile('autopilot', tempDir, sessionId)).toBe(true);
      expect(existsSync(statePath)).toBe(false);
      expect(existsSync(lockPath)).toBe(true);
    });

    it('preserves a replacement activation during ghost-legacy cleanup', () => {
      const sessionId = 'ghost-owner';
      expect(writeModeState('autopilot', { active: true, session_id: sessionId, workflowRunId: 'old-run' }, tempDir)).toBe(true);
      const legacyPath = join(tempDir, '.omc', 'state', 'autopilot-state.json');
      const replacement = { active: true, session_id: 'new-session', workflowRunId: 'new-run' };
      process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_PATH = legacyPath;
      process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64 = Buffer.from(JSON.stringify(replacement)).toString('base64');

      expect(clearModeStateFile('autopilot', tempDir, sessionId)).toBe(true);
      expect(JSON.parse(readFileSync(legacyPath, 'utf8'))).toEqual(replacement);
    });

    it('preserves runtime artifacts and ghost legacy state when expected primary clear is locked', () => {
      const sessionId = 'locked-primary-cleanup';
      const stateDir = join(tempDir, '.omc', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      const state = { active: true, session_id: sessionId, workflowRunId: '11111111-1111-4111-8111-111111111111', workflow: { profileHash: 'a'.repeat(64) } };
      const statePath = join(sessionDir, 'autopilot-state.json');
      const legacyPath = join(stateDir, 'autopilot-state.json');
      const artifactPath = join(sessionDir, 'autopilot-stop-breaker.json');
      writeFileSync(statePath, JSON.stringify(state));
      writeFileSync(legacyPath, JSON.stringify(state));
      writeFileSync(artifactPath, JSON.stringify({ count: 2 }));
      const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
      const processStart = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
      writeFileSync(`${statePath}.mutation.lock`, JSON.stringify({ version: 1, pid: process.pid, processStart, createdAt: new Date().toISOString(), nonce: randomUUID() }));
      const snapshots = [statePath, legacyPath, artifactPath].map((path) => readFileSync(path));

      expect(clearModeStateFile('autopilot', tempDir, sessionId, state)).toBe(false);
      [statePath, legacyPath, artifactPath].forEach((path, index) => expect(readFileSync(path)).toEqual(snapshots[index]));
    });

    it('waits for an in-flight publisher before deciding the state is absent', async () => {
      const sessionId = 'in-flight-activation';
      const statePath = join(tempDir, '.omc', 'state', 'sessions', sessionId, 'autopilot-state.json');
      mkdirSync(dirname(statePath), { recursive: true });
      const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
      const processStart = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
      const lockPath = `${statePath}.mutation.lock`;
      writeFileSync(lockPath, JSON.stringify({ version: 1, pid: process.pid, processStart, createdAt: new Date().toISOString(), nonce: randomUUID() }));
      const childScript = String.raw`
        const fs = require('fs');
        const [statePath, lockPath] = process.argv.slice(1);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        fs.writeFileSync(statePath, JSON.stringify({ active: true, session_id: 'in-flight-activation' }));
        fs.unlinkSync(lockPath);
      `;
      const child = spawn(process.execPath, ['-e', childScript, statePath, lockPath], { stdio: 'ignore' });
      const completed = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve() : reject(new Error(`publisher exited ${code}`)));
      });

      expect(clearModeStateFile('autopilot', tempDir, sessionId)).toBe(true);
      await completed;
      expect(existsSync(statePath)).toBe(false);
    });
    it('should clear state from the git worktree root when given a subdirectory', () => {
      const nestedDir = join(tempDir, 'nested', 'cwd');
      mkdirSync(nestedDir, { recursive: true });
      execSync('git init', { cwd: tempDir, stdio: 'pipe' });
      const stateDir = join(tempDir, '.omc', 'state');
      mkdirSync(stateDir, { recursive: true });
      const filePath = join(stateDir, 'ralph-state.json');
      writeFileSync(filePath, JSON.stringify({ active: true }));

      const result = clearModeStateFile('ralph', nestedDir);

      expect(result).toBe(true);
      expect(existsSync(filePath)).toBe(false);
      expect(existsSync(join(nestedDir, '.omc', 'state', 'ralph-state.json'))).toBe(false);
    });

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

    it('should clean up legacy root-level mode files for the matching session', () => {
      const legacyRootPath = join(tempDir, '.omc', 'ralph-state.json');
      mkdirSync(join(tempDir, '.omc'), { recursive: true });
      writeFileSync(
        legacyRootPath,
        JSON.stringify({ active: true, session_id: 'pid-legacy-root-1' }),
      );

      const result = clearModeStateFile('ralph', tempDir, 'pid-legacy-root-1');
      expect(result).toBe(true);
      expect(existsSync(legacyRootPath)).toBe(false);
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

    it('should NOT delete legacy file owned by a different session via _meta.sessionId', () => {
      const stateDir = join(tempDir, '.omc', 'state');
      mkdirSync(stateDir, { recursive: true });
      const legacyPath = join(stateDir, 'autopilot-state.json');
      writeFileSync(
        legacyPath,
        JSON.stringify({ active: true, _meta: { sessionId: 'session-other-321' } }),
      );

      clearModeStateFile('autopilot', tempDir, 'session-mine-123');
      expect(existsSync(legacyPath)).toBe(true);
    });

    it('should delete legacy file owned by this session via _meta.sessionId', () => {
      const stateDir = join(tempDir, '.omc', 'state');
      mkdirSync(stateDir, { recursive: true });
      const legacyPath = join(stateDir, 'autopilot-state.json');
      writeFileSync(
        legacyPath,
        JSON.stringify({ active: true, _meta: { sessionId: 'session-mine-123' } }),
      );

      clearModeStateFile('autopilot', tempDir, 'session-mine-123');
      expect(existsSync(legacyPath)).toBe(false);
    });

    it('should remove all session-scoped files when no session_id is provided', () => {
      const sessionAPath = join(tempDir, '.omc', 'state', 'sessions', 'session-a', 'ralph-state.json');
      const sessionBPath = join(tempDir, '.omc', 'state', 'sessions', 'session-b', 'ralph-state.json');
      mkdirSync(join(tempDir, '.omc', 'state', 'sessions', 'session-a'), { recursive: true });
      mkdirSync(join(tempDir, '.omc', 'state', 'sessions', 'session-b'), { recursive: true });
      writeFileSync(sessionAPath, JSON.stringify({ active: true, session_id: 'session-a' }));
      writeFileSync(sessionBPath, JSON.stringify({ active: true, session_id: 'session-b' }));

      const result = clearModeStateFile('ralph', tempDir);

      expect(result).toBe(true);
      expect(existsSync(sessionAPath)).toBe(false);
      expect(existsSync(sessionBPath)).toBe(false);
    });

    it('should remove mode runtime artifacts during session-scoped clear', () => {
      const stateDir = join(tempDir, '.omc', 'state');
      const sessionDir = join(stateDir, 'sessions', 'session-runtime-cleanup');
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'ralph-state.json'), JSON.stringify({ active: true }));
      writeFileSync(join(sessionDir, 'ralph-stop-breaker.json'), JSON.stringify({ count: 2 }));
      writeFileSync(join(stateDir, 'ralph-stop-breaker.json'), JSON.stringify({ count: 2 }));
      writeFileSync(join(stateDir, 'ralph-last-steer-at'), new Date().toISOString());
      writeFileSync(join(stateDir, 'ralph-continue-steer.lock'), `${process.pid}`);

      const result = clearModeStateFile('ralph', tempDir, 'session-runtime-cleanup');

      expect(result).toBe(true);
      expect(existsSync(join(sessionDir, 'ralph-state.json'))).toBe(false);
      expect(existsSync(join(sessionDir, 'ralph-stop-breaker.json'))).toBe(false);
      expect(existsSync(join(stateDir, 'ralph-stop-breaker.json'))).toBe(false);
      expect(existsSync(join(stateDir, 'ralph-last-steer-at'))).toBe(false);
      expect(existsSync(join(stateDir, 'ralph-continue-steer.lock'))).toBe(false);
    });

    it('should return true when file does not exist (already absent)', () => {
      const result = clearModeStateFile('ralph', tempDir);
      expect(result).toBe(true);
    });
  });

  describe('durable emergency mutation journal', () => {
    it('recovers a paused publication interrupted after primary publication', () => {
      const path = join(tempDir, '.omc', 'state', 'autopilot-state.json');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ active: true, run: 'one' }));
      process.env.OMC_TEST_EMERGENCY_CRASH_PHASE = 'after-publication';
      expect(emergencyMutateStateFileIf(path, (state) => state.run === 'one', (state) => ({ ...state, active: false }))).toBe(false);
      delete process.env.OMC_TEST_EMERGENCY_CRASH_PHASE;
      expect(recoverEmergencyStateFile(path)).toBe(true);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ active: false, run: 'one' });
      expect(existsSync(`${path}.emergency-journal.json`)).toBe(false);
    });

    it.each([
      ['before-rename', 'pause'],
      ['after-rename', 'pause'],
      ['after-publication', 'pause'],
      ['before-cleanup', 'pause'],
      ['before-rename', 'clear'],
      ['after-rename', 'clear'],
      ['before-cleanup', 'clear'],
    ] as const)('recovers the %s crash boundary for exact %s', (phase, operation) => {
      const path = join(tempDir, '.omc', 'state', `autopilot-${phase}-${operation}.json`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ active: true, run: `${phase}-${operation}` }));
      process.env.OMC_TEST_EMERGENCY_CRASH_PHASE = phase;
      const transform = operation === 'pause' ? (state: Record<string, unknown>) => ({ ...state, active: false }) : null;
      expect(emergencyMutateStateFileIf(path, (state) => state.run === `${phase}-${operation}`, transform)).toBe(false);
      delete process.env.OMC_TEST_EMERGENCY_CRASH_PHASE;
      expect(recoverEmergencyStateFile(path)).toBe(true);
      if (operation === 'pause') expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ active: false });
      else expect(existsSync(path)).toBe(false);
    });

    it('preserves an unrelated replacement after an interrupted clear and lets a retry converge', () => {
      const path = join(tempDir, '.omc', 'state', 'autopilot-state.json');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ active: true, run: 'one' }));
      process.env.OMC_TEST_EMERGENCY_CRASH_PHASE = 'after-rename';
      expect(emergencyMutateStateFileIf(path, (state) => state.run === 'one', null)).toBe(false);
      delete process.env.OMC_TEST_EMERGENCY_CRASH_PHASE;
      const replacement = JSON.stringify({ active: true, run: 'replacement' });
      writeFileSync(path, replacement);
      expect(recoverEmergencyStateFile(path)).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe(replacement);
      expect(emergencyMutateStateFileIf(path, (state) => state.run === 'replacement', null)).toBe(true);
      expect(existsSync(path)).toBe(false);
    });

    it('preserves an unrelated replacement after an interrupted pause', () => {
      const path = join(tempDir, '.omc', 'state', 'autopilot-pause-replacement.json');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ active: true, run: 'one' }));
      process.env.OMC_TEST_EMERGENCY_CRASH_PHASE = 'after-rename';
      expect(emergencyMutateStateFileIf(path, (state) => state.run === 'one', (state) => ({ ...state, active: false }))).toBe(false);
      delete process.env.OMC_TEST_EMERGENCY_CRASH_PHASE;
      const replacement = JSON.stringify({ active: true, run: 'replacement' });
      writeFileSync(path, replacement);
      expect(recoverEmergencyStateFile(path)).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe(replacement);
    });

    it('does not remove a replacement made between authenticated predicate and capture', () => {
      const path = join(tempDir, '.omc', 'state', 'autopilot-replaced-before-capture.json');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ active: true, run: 'one' }));
      const replacement = { active: true, run: 'replacement', untouched: true };
      const replacementRaw = JSON.stringify(replacement, null, 2);
      process.env.OMC_TEST_EMERGENCY_REPLACEMENT_PATH = path;
      process.env.OMC_TEST_EMERGENCY_REPLACEMENT_BASE64 = Buffer.from(replacementRaw).toString('base64');

      expect(emergencyMutateStateFileIf(path, (state) => state.run === 'one', null)).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe(replacementRaw);
      expect(recoverEmergencyStateFile(path)).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe(replacementRaw);
      expect(emergencyMutateStateFileIf(path, (state) => state.run === 'replacement', null)).toBe(true);
      expect(existsSync(path)).toBe(false);
    });

    it('lets only the claimed pause transaction mutate a primary while a concurrent clear recovers it', () => {
      const path = join(tempDir, '.omc', 'state', 'autopilot-concurrent-emergency.json');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ active: true, run: 'one' }));
      process.env.OMC_TEST_EMERGENCY_CRASH_PHASE = 'before-rename';
      expect(emergencyMutateStateFileIf(path, (state) => state.run === 'one', (state) => ({ ...state, active: false }))).toBe(false);
      delete process.env.OMC_TEST_EMERGENCY_CRASH_PHASE;

      // The clear cannot replace the pause journal. It recovers the owner, then
      // observes the paused state and leaves it intact.
      expect(emergencyMutateStateFileIf(path, (state) => state.run === 'one' && state.active === true, null)).toBe(false);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ active: false, run: 'one' });
      expect(existsSync(`${path}.emergency-journal.json`)).toBe(false);
    });
  });
});
