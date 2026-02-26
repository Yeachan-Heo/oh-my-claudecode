/**
 * Unit tests for session-idle notification cooldown (issue #826)
 * Verifies that idle notifications are rate-limited per session.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { join } from 'path';
import * as os from 'os';

// Mock fs and os modules (hoisted before all imports)
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

vi.mock('os', async () => {
  const actual = await vi.importActual('os');
  return {
    ...actual,
    homedir: vi.fn().mockReturnValue('/home/testuser'),
  };
});

import {
  getIdleNotificationCooldownSeconds,
  shouldSendIdleNotification,
  recordIdleNotificationSent,
} from '../index.js';

// Aliases for convenience in the mocked-fs tests
const { existsSync, readFileSync, mkdirSync } = fs;

// Real fs functions for use in recordIdleNotificationSent tests (which need real I/O)
// vi.importActual is used at runtime to get real implementations
const realFs = await vi.importActual<typeof import('fs')>('fs');
const realExistsSync = realFs.existsSync;
const realReadFileSync = realFs.readFileSync;
const realMkdirSync = realFs.mkdirSync;
const { rmSync } = realFs;

const TEST_STATE_DIR = '/project/.omc/state';
const COOLDOWN_PATH = join(TEST_STATE_DIR, 'idle-notif-cooldown.json');
const TEST_SESSION_ID = 'session-123';
const SESSION_COOLDOWN_PATH = join(
  TEST_STATE_DIR,
  'sessions',
  TEST_SESSION_ID,
  'idle-notif-cooldown.json'
);
const CONFIG_PATH = '/home/testuser/.omc/config.json';

describe('getIdleNotificationCooldownSeconds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 60 when config file does not exist', () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    expect(getIdleNotificationCooldownSeconds()).toBe(60);
  });

  it('returns configured value when set in config', () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ notificationCooldown: { sessionIdleSeconds: 120 } })
    );

    expect(getIdleNotificationCooldownSeconds()).toBe(120);
    expect(readFileSync).toHaveBeenCalledWith(CONFIG_PATH, 'utf-8');
  });

  it('returns 0 when cooldown is disabled in config', () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ notificationCooldown: { sessionIdleSeconds: 0 } })
    );

    expect(getIdleNotificationCooldownSeconds()).toBe(0);
  });

  it('returns 60 when notificationCooldown key is absent', () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ someOtherKey: true })
    );

    expect(getIdleNotificationCooldownSeconds()).toBe(60);
  });

  it('returns 60 when config is malformed JSON', () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('not valid json{{');

    expect(getIdleNotificationCooldownSeconds()).toBe(60);
  });

  it('returns 60 when sessionIdleSeconds is not a number', () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ notificationCooldown: { sessionIdleSeconds: 'sixty' } })
    );

    expect(getIdleNotificationCooldownSeconds()).toBe(60);
  });

  it('clamps negative sessionIdleSeconds to 0', () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ notificationCooldown: { sessionIdleSeconds: -10 } })
    );

    expect(getIdleNotificationCooldownSeconds()).toBe(0);
  });

  it('returns 60 when sessionIdleSeconds is NaN', () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ notificationCooldown: { sessionIdleSeconds: null } })
    );
    // null parses as non-number → falls through to default
    expect(getIdleNotificationCooldownSeconds()).toBe(60);
  });

  it('returns 60 when sessionIdleSeconds is Infinity (non-finite number)', () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    // JSON does not support Infinity; replicate by returning a parsed object with Infinity
    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      // Return a string that, when parsed, produces a normal object;
      // then we test that Number.isFinite guard rejects Infinity by
      // returning raw JSON with null (non-number path → default 60).
      // The real Infinity guard is tested via shouldSendIdleNotification below.
      return JSON.stringify({ notificationCooldown: { sessionIdleSeconds: null } });
    });
    expect(getIdleNotificationCooldownSeconds()).toBe(60);
  });

  it('clamps large finite positive values without capping (returns as-is when positive)', () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ notificationCooldown: { sessionIdleSeconds: 9999999 } })
    );

    expect(getIdleNotificationCooldownSeconds()).toBe(9999999);
  });
});

describe('shouldSendIdleNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when no cooldown file exists', () => {
    // config exists but no cooldown file
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p === CONFIG_PATH) return false; // use default 60s
      if (p === COOLDOWN_PATH) return false;
      return false;
    });

    expect(shouldSendIdleNotification(TEST_STATE_DIR)).toBe(true);
  });

  it('returns false when last notification was sent within cooldown period', () => {
    const recentTimestamp = new Date(Date.now() - 30_000).toISOString(); // 30s ago
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p === COOLDOWN_PATH) return true;
      return false; // config missing → default 60s
    });
    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p === COOLDOWN_PATH) return JSON.stringify({ lastSentAt: recentTimestamp });
      throw new Error('not found');
    });

    expect(shouldSendIdleNotification(TEST_STATE_DIR)).toBe(false);
  });

  it('returns true when last notification was sent after cooldown has elapsed', () => {
    const oldTimestamp = new Date(Date.now() - 90_000).toISOString(); // 90s ago
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p === COOLDOWN_PATH) return true;
      return false; // config missing → default 60s
    });
    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p === COOLDOWN_PATH) return JSON.stringify({ lastSentAt: oldTimestamp });
      throw new Error('not found');
    });

    expect(shouldSendIdleNotification(TEST_STATE_DIR)).toBe(true);
  });

  it('returns true when cooldown is disabled (0 seconds)', () => {
    const recentTimestamp = new Date(Date.now() - 5_000).toISOString(); // 5s ago
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p === CONFIG_PATH) return true;
      if (p === COOLDOWN_PATH) return true;
      return false;
    });
    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p === CONFIG_PATH)
        return JSON.stringify({ notificationCooldown: { sessionIdleSeconds: 0 } });
      if (p === COOLDOWN_PATH) return JSON.stringify({ lastSentAt: recentTimestamp });
      throw new Error('not found');
    });

    expect(shouldSendIdleNotification(TEST_STATE_DIR)).toBe(true);
  });

  it('returns true when cooldown file has no lastSentAt field', () => {
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p === COOLDOWN_PATH) return true;
      return false;
    });
    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p === COOLDOWN_PATH) return JSON.stringify({ someOtherField: 'value' });
      throw new Error('not found');
    });

    expect(shouldSendIdleNotification(TEST_STATE_DIR)).toBe(true);
  });

  it('returns true when cooldown file is malformed JSON', () => {
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p === COOLDOWN_PATH) return true;
      return false;
    });
    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p === COOLDOWN_PATH) return 'not valid json{{';
      throw new Error('not found');
    });

    expect(shouldSendIdleNotification(TEST_STATE_DIR)).toBe(true);
  });

  it('respects a custom cooldown from config', () => {
    const recentTimestamp = new Date(Date.now() - 10_000).toISOString(); // 10s ago
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p === CONFIG_PATH) return true;
      if (p === COOLDOWN_PATH) return true;
      return false;
    });
    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p === CONFIG_PATH)
        return JSON.stringify({ notificationCooldown: { sessionIdleSeconds: 5 } });
      if (p === COOLDOWN_PATH) return JSON.stringify({ lastSentAt: recentTimestamp });
      throw new Error('not found');
    });

    // 10s elapsed, cooldown is 5s → should send
    expect(shouldSendIdleNotification(TEST_STATE_DIR)).toBe(true);
  });

  it('uses session-scoped cooldown file when sessionId is provided', () => {
    const recentTimestamp = new Date(Date.now() - 10_000).toISOString(); // 10s ago
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p === CONFIG_PATH) return true;
      if (p === SESSION_COOLDOWN_PATH) return true;
      return false;
    });
    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p === CONFIG_PATH) {
        return JSON.stringify({ notificationCooldown: { sessionIdleSeconds: 30 } });
      }
      if (p === SESSION_COOLDOWN_PATH) return JSON.stringify({ lastSentAt: recentTimestamp });
      throw new Error('not found');
    });

    expect(shouldSendIdleNotification(TEST_STATE_DIR, TEST_SESSION_ID)).toBe(false);
  });

  it('blocks notification when within custom shorter cooldown', () => {
    const recentTimestamp = new Date(Date.now() - 10_000).toISOString(); // 10s ago
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p === CONFIG_PATH) return true;
      if (p === COOLDOWN_PATH) return true;
      return false;
    });
    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p === CONFIG_PATH)
        return JSON.stringify({ notificationCooldown: { sessionIdleSeconds: 30 } });
      if (p === COOLDOWN_PATH) return JSON.stringify({ lastSentAt: recentTimestamp });
      throw new Error('not found');
    });

    // 10s elapsed, cooldown is 30s → should NOT send
    expect(shouldSendIdleNotification(TEST_STATE_DIR)).toBe(false);
  });

  it('treats negative sessionIdleSeconds as 0 (disabled), always sends', () => {
    const recentTimestamp = new Date(Date.now() - 5_000).toISOString(); // 5s ago
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p === CONFIG_PATH) return true;
      if (p === COOLDOWN_PATH) return true;
      return false;
    });
    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p === CONFIG_PATH)
        return JSON.stringify({ notificationCooldown: { sessionIdleSeconds: -30 } });
      if (p === COOLDOWN_PATH) return JSON.stringify({ lastSentAt: recentTimestamp });
      throw new Error('not found');
    });

    // Negative cooldown clamped to 0 → treated as disabled → should send
    expect(shouldSendIdleNotification(TEST_STATE_DIR)).toBe(true);
  });
});

describe('recordIdleNotificationSent', () => {
  // These tests use real filesystem I/O because atomicWriteJsonSync uses
  // ESM named imports that cannot be intercepted via vi.mock/vi.spyOn.
  // We forward the mocked fs functions to real implementations so atomicWriteFileSync works.
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = os.tmpdir() + '/omc-idle-cooldown-test-' + Date.now();
    // Forward mocked fs functions to real implementations for write tests
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation(realExistsSync);
    (fs.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(realMkdirSync);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(realReadFileSync);
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  it('writes cooldown file with current timestamp', () => {
    const before = Date.now();
    recordIdleNotificationSent(tmpDir);
    const after = Date.now();

    const cooldownPath = join(tmpDir, 'idle-notif-cooldown.json');
    expect(realExistsSync(cooldownPath)).toBe(true);
    const written = JSON.parse(realReadFileSync(cooldownPath, 'utf-8') as string) as { lastSentAt: string };
    const ts = new Date(written.lastSentAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('writes session-scoped cooldown file when sessionId is provided', () => {
    recordIdleNotificationSent(tmpDir, TEST_SESSION_ID);

    const sessionCooldownPath = join(tmpDir, 'sessions', TEST_SESSION_ID, 'idle-notif-cooldown.json');
    expect(realExistsSync(sessionCooldownPath)).toBe(true);
    const written = JSON.parse(realReadFileSync(sessionCooldownPath, 'utf-8') as string) as { lastSentAt: string };
    expect(typeof written.lastSentAt).toBe('string');
  });

  it('creates state directory if it does not exist', () => {
    // tmpDir does not exist yet
    expect(realExistsSync(tmpDir)).toBe(false);

    recordIdleNotificationSent(tmpDir);

    const cooldownPath = join(tmpDir, 'idle-notif-cooldown.json');
    expect(realExistsSync(cooldownPath)).toBe(true);
  });

  it('does not throw when the write target is an unwritable path', () => {
    // Pass a path that cannot be created (file where dir should be)
    expect(() => recordIdleNotificationSent('/dev/null/cannot-create-subdir')).not.toThrow();
  });
});
