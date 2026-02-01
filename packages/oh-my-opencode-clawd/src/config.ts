import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ClawdConfig } from './types.js';

const DEFAULT_CONFIG: ClawdConfig = {
  maxSessions: 5,
  autoCleanupHours: 24,
  defaultProjectDir: join(homedir(), 'projects'),
};

export function loadConfig(): ClawdConfig {
  const configPath = join(homedir(), '.claude', '.omc-config.json');

  try {
    if (!existsSync(configPath)) {
      return { ...DEFAULT_CONFIG };
    }

    const raw = readFileSync(configPath, 'utf8');
    const full = JSON.parse(raw);
    const clawdConfig = full.clawd ?? {};

    // Override with environment variables
    if (process.env.CLAWD_TELEGRAM_TOKEN) {
      clawdConfig.telegram = {
        ...clawdConfig.telegram,
        token: process.env.CLAWD_TELEGRAM_TOKEN,
        enabled: true,
      };
    }

    return { ...DEFAULT_CONFIG, ...clawdConfig };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function getDbPath(config: ClawdConfig): string {
  if (config.dbPath) {
    return config.dbPath.replace(/^~/, homedir());
  }
  return join(homedir(), '.clawd', 'data', 'clawd.db');
}

export function getSocketPath(): string {
  return join(homedir(), '.clawd', 'state', 'clawd.sock');
}

export function getPidPath(): string {
  return join(homedir(), '.clawd', 'state', 'clawd.pid');
}

export function getLogPath(): string {
  return join(homedir(), '.clawd', 'logs', 'clawd.log');
}
