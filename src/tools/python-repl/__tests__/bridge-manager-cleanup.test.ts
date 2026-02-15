import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { cleanupStaleBridges } from '../bridge-manager.js';
import { getBridgeMetaPath, getBridgeSocketPath, getSessionDir, getSessionLockPath, getRuntimeDir } from '../paths.js';
import type { BridgeMeta } from '../types.js';

describe('bridge-manager cleanup', () => {
  let tmpRuntimeRoot: string;
  let originalXdgRuntimeDir: string | undefined;

  beforeEach(() => {
    originalXdgRuntimeDir = process.env.XDG_RUNTIME_DIR;
    tmpRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-bridge-cleanup-'));
    fs.chmodSync(tmpRuntimeRoot, 0o700);
    process.env.XDG_RUNTIME_DIR = tmpRuntimeRoot;
    fs.mkdirSync(getRuntimeDir(), { recursive: true });
  });

  afterEach(() => {
    if (originalXdgRuntimeDir === undefined) {
      delete process.env.XDG_RUNTIME_DIR;
    } else {
      process.env.XDG_RUNTIME_DIR = originalXdgRuntimeDir;
    }
    fs.rmSync(tmpRuntimeRoot, { recursive: true, force: true });
  });

  it('removes stale bridge metadata/socket/lock for dead processes', async () => {
    const sessionId = 'stale-session';
    const sessionDir = getSessionDir(sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const meta: BridgeMeta = {
      pid: 999_999, // intentionally dead
      socketPath: getBridgeSocketPath(sessionId),
      startedAt: new Date().toISOString(),
      sessionId,
      pythonEnv: { pythonPath: 'python3', type: 'venv' },
    };

    fs.writeFileSync(getBridgeMetaPath(sessionId), JSON.stringify(meta), 'utf-8');
    fs.writeFileSync(getBridgeSocketPath(sessionId), 'not-a-real-socket', 'utf-8');
    fs.writeFileSync(getSessionLockPath(sessionId), 'lock', 'utf-8');

    const result = await cleanupStaleBridges();

    expect(result.scannedSessions).toBe(1);
    expect(result.staleSessions).toBe(1);
    expect(result.activeSessions).toBe(0);
    expect(result.metaRemoved).toBe(1);
    expect(result.socketRemoved).toBe(1);
    expect(result.lockRemoved).toBe(1);
    expect(result.filesRemoved).toBe(3);
    expect(result.errors).toEqual([]);

    expect(fs.existsSync(getBridgeMetaPath(sessionId))).toBe(false);
    expect(fs.existsSync(getBridgeSocketPath(sessionId))).toBe(false);
    expect(fs.existsSync(getSessionLockPath(sessionId))).toBe(false);
  });

  it('keeps bridge artifacts for active processes', async () => {
    const sessionId = 'active-session';
    fs.mkdirSync(getSessionDir(sessionId), { recursive: true });

    const meta: BridgeMeta = {
      pid: process.pid,
      socketPath: getBridgeSocketPath(sessionId),
      startedAt: new Date().toISOString(),
      sessionId,
      pythonEnv: { pythonPath: 'python3', type: 'venv' },
    };

    fs.writeFileSync(getBridgeMetaPath(sessionId), JSON.stringify(meta), 'utf-8');
    fs.writeFileSync(getBridgeSocketPath(sessionId), 'placeholder', 'utf-8');
    fs.writeFileSync(getSessionLockPath(sessionId), 'lock', 'utf-8');

    const result = await cleanupStaleBridges();

    expect(result.scannedSessions).toBe(1);
    expect(result.staleSessions).toBe(0);
    expect(result.activeSessions).toBe(1);
    expect(result.filesRemoved).toBe(0);

    expect(fs.existsSync(getBridgeMetaPath(sessionId))).toBe(true);
    expect(fs.existsSync(getBridgeSocketPath(sessionId))).toBe(true);
    expect(fs.existsSync(getSessionLockPath(sessionId))).toBe(true);
  });
});
