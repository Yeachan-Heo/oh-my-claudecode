/**
 * ClawdCoder Config Loading Tests
 *
 * Tests config loading with missing files, malformed JSON,
 * environment variable overrides, and default values.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, getDbPath, getSocketPath, getPidPath, getLogPath } from '../../clawdcoder/config.js';
import { existsSync, unlinkSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

describe('ClawdCoder Config Loading', () => {
  const configDir = join(homedir(), '.claude');
  const configPath = join(configDir, '.omc-config.json');
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };

    // Clear environment variables
    delete process.env.CLAWDCODER_DISCORD_TOKEN;
    delete process.env.CLAWDCODER_TELEGRAM_TOKEN;

    // Ensure config directory exists
    mkdirSync(configDir, { recursive: true });

    // Remove existing config if present
    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;

    // Clean up config file
    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
  });

  it('handles missing config file gracefully', () => {
    const config = loadConfig();

    expect(config).toBeDefined();
    expect(config.maxSessions).toBe(5);
    expect(config.autoCleanupHours).toBe(24);
    expect(config.defaultProjectDir).toContain('projects');
  });

  it('returns default values when config file is missing', () => {
    const config = loadConfig();

    expect(config.maxSessions).toBe(5);
    expect(config.autoCleanupHours).toBe(24);
    expect(config.defaultProjectDir).toBe(join(homedir(), 'projects'));
  });

  it('handles malformed JSON gracefully', () => {
    writeFileSync(configPath, '{this is not valid json}');

    const config = loadConfig();

    expect(config).toBeDefined();
    expect(config.maxSessions).toBe(5);
    expect(config.autoCleanupHours).toBe(24);
  });

  it('handles empty JSON object', () => {
    writeFileSync(configPath, '{}');

    const config = loadConfig();

    expect(config).toBeDefined();
    expect(config.maxSessions).toBe(5);
    expect(config.autoCleanupHours).toBe(24);
  });

  it('handles JSON with only other sections', () => {
    const testConfig = {
      someOtherSection: {
        value: 'test',
      },
      anotherSection: {
        enabled: true,
      },
    };

    writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

    const config = loadConfig();

    expect(config).toBeDefined();
    expect(config.maxSessions).toBe(5); // defaults
    expect(config.autoCleanupHours).toBe(24);
  });

  it('returns clawdcoder section when present', () => {
    const testConfig = {
      clawdcoder: {
        maxSessions: 10,
        autoCleanupHours: 48,
        defaultProjectDir: '/custom/path',
      },
    };

    writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

    const config = loadConfig();

    expect(config.maxSessions).toBe(10);
    expect(config.autoCleanupHours).toBe(48);
    expect(config.defaultProjectDir).toBe('/custom/path');
  });

  it('merges clawdcoder config with defaults', () => {
    const testConfig = {
      clawdcoder: {
        maxSessions: 15,
        // autoCleanupHours not specified - should use default
      },
    };

    writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

    const config = loadConfig();

    expect(config.maxSessions).toBe(15);
    expect(config.autoCleanupHours).toBe(24); // default
  });

  it('loads Discord config from clawdcoder section', () => {
    const testConfig = {
      clawdcoder: {
        discord: {
          token: 'test-discord-token',
          enabled: true,
        },
      },
    };

    writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

    const config = loadConfig();

    expect(config.discord).toBeDefined();
    expect(config.discord?.token).toBe('test-discord-token');
    expect(config.discord?.enabled).toBe(true);
  });

  it('loads Telegram config from clawdcoder section', () => {
    const testConfig = {
      clawdcoder: {
        telegram: {
          token: 'test-telegram-token',
          enabled: true,
        },
      },
    };

    writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

    const config = loadConfig();

    expect(config.telegram).toBeDefined();
    expect(config.telegram?.token).toBe('test-telegram-token');
    expect(config.telegram?.enabled).toBe(true);
  });

  it('environment variables override Discord config', () => {
    const testConfig = {
      clawdcoder: {
        discord: {
          token: 'old-token',
          enabled: false,
        },
      },
    };

    writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

    process.env.CLAWDCODER_DISCORD_TOKEN = 'env-discord-token';

    const config = loadConfig();

    expect(config.discord?.token).toBe('env-discord-token');
    expect(config.discord?.enabled).toBe(true);
  });

  it('environment variables override Telegram config', () => {
    const testConfig = {
      clawdcoder: {
        telegram: {
          token: 'old-token',
          enabled: false,
        },
      },
    };

    writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

    process.env.CLAWDCODER_TELEGRAM_TOKEN = 'env-telegram-token';

    const config = loadConfig();

    expect(config.telegram?.token).toBe('env-telegram-token');
    expect(config.telegram?.enabled).toBe(true);
  });

  it('environment variables create config when missing', () => {
    writeFileSync(configPath, '{}');

    process.env.CLAWDCODER_DISCORD_TOKEN = 'env-only-token';

    const config = loadConfig();

    expect(config.discord?.token).toBe('env-only-token');
    expect(config.discord?.enabled).toBe(true);
  });

  it('handles both environment variables simultaneously', () => {
    writeFileSync(configPath, '{}');

    process.env.CLAWDCODER_DISCORD_TOKEN = 'discord-env-token';
    process.env.CLAWDCODER_TELEGRAM_TOKEN = 'telegram-env-token';

    const config = loadConfig();

    expect(config.discord?.token).toBe('discord-env-token');
    expect(config.discord?.enabled).toBe(true);
    expect(config.telegram?.token).toBe('telegram-env-token');
    expect(config.telegram?.enabled).toBe(true);
  });

  it('handles custom dbPath in config', () => {
    const testConfig = {
      clawdcoder: {
        dbPath: '/custom/db/path.db',
      },
    };

    writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

    const config = loadConfig();
    const dbPath = getDbPath(config);

    expect(dbPath).toBe('/custom/db/path.db');
  });

  it('handles tilde expansion in dbPath', () => {
    const testConfig = {
      clawdcoder: {
        dbPath: '~/.custom/clawdcoder.db',
      },
    };

    writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

    const config = loadConfig();
    const dbPath = getDbPath(config);

    expect(dbPath).toBe(join(homedir(), '.custom/clawdcoder.db'));
    expect(dbPath).not.toContain('~');
  });

  it('uses default dbPath when not specified', () => {
    const config = loadConfig();
    const dbPath = getDbPath(config);

    expect(dbPath).toBe(join(homedir(), '.omc', 'data', 'clawdcoder.db'));
  });
});

describe('ClawdCoder Path Helpers', () => {
  it('getSocketPath returns correct path', () => {
    const socketPath = getSocketPath();
    expect(socketPath).toBe(join(homedir(), '.omc', 'state', 'clawdcoder.sock'));
  });

  it('getPidPath returns correct path', () => {
    const pidPath = getPidPath();
    expect(pidPath).toBe(join(homedir(), '.omc', 'state', 'clawdcoder.pid'));
  });

  it('getLogPath returns correct path', () => {
    const logPath = getLogPath();
    expect(logPath).toBe(join(homedir(), '.omc', 'logs', 'clawdcoder.log'));
  });
});

describe('ClawdCoder Config Edge Cases', () => {
  const configDir = join(homedir(), '.claude');
  const configPath = join(configDir, '.omc-config.json');

  beforeEach(() => {
    mkdirSync(configDir, { recursive: true });
    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
  });

  afterEach(() => {
    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
  });

  it('handles null values in config', () => {
    const testConfig = {
      clawdcoder: {
        maxSessions: null,
        discord: null,
      },
    };

    writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

    const config = loadConfig();

    // Spread operator preserves null values from config
    expect(config.maxSessions).toBe(null);
  });

  it('handles array in clawdcoder section', () => {
    const testConfig = {
      clawdcoder: [],
    };

    writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

    const config = loadConfig();

    // Should still return defaults
    expect(config.maxSessions).toBe(5);
  });

  it('handles very large maxSessions value', () => {
    const testConfig = {
      clawdcoder: {
        maxSessions: 999999,
      },
    };

    writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

    const config = loadConfig();

    expect(config.maxSessions).toBe(999999);
  });

  it('handles negative maxSessions value', () => {
    const testConfig = {
      clawdcoder: {
        maxSessions: -5,
      },
    };

    writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

    const config = loadConfig();

    expect(config.maxSessions).toBe(-5); // No validation in loadConfig
  });

  it('handles unicode in config values', () => {
    const testConfig = {
      clawdcoder: {
        defaultProjectDir: '/home/用户/projects',
      },
    };

    writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

    const config = loadConfig();

    expect(config.defaultProjectDir).toBe('/home/用户/projects');
  });

  it('handles extremely long config file', () => {
    const testConfig = {
      clawdcoder: {
        maxSessions: 7,
      },
      otherSection: {
        data: 'x'.repeat(100000), // 100KB of data
      },
    };

    writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

    const config = loadConfig();

    expect(config.maxSessions).toBe(7);
  });

  it('handles config with BOM (Byte Order Mark)', () => {
    const testConfig = {
      clawdcoder: {
        maxSessions: 12,
      },
    };

    const jsonWithBOM = '\uFEFF' + JSON.stringify(testConfig, null, 2);
    writeFileSync(configPath, jsonWithBOM);

    const config = loadConfig();

    // BOM causes JSON.parse to fail, falls back to defaults
    expect(config.maxSessions).toBe(5); // default
  });
});
