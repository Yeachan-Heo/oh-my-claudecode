import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { MonkeyConfig } from './types.js';

const DEFAULT_CONFIG: MonkeyConfig = {
  maxSessions: 5,
  autoCleanupHours: 24,
  defaultProjectDir: join(homedir(), 'projects'),
};

export function loadConfig(): MonkeyConfig {
  const configPath = join(homedir(), '.claude', '.omc-config.json');

  try {
    if (!existsSync(configPath)) {
      return { ...DEFAULT_CONFIG };
    }

    const raw = readFileSync(configPath, 'utf8');
    const full = JSON.parse(raw);
    const monkeyConfig = full.monkey ?? {};

    // Override with environment variables
    if (process.env.OMC_MONKEY_TELEGRAM_TOKEN) {
      monkeyConfig.telegram = {
        ...monkeyConfig.telegram,
        token: process.env.OMC_MONKEY_TELEGRAM_TOKEN,
        enabled: true,
      };
    }

    return { ...DEFAULT_CONFIG, ...monkeyConfig };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function getDbPath(config: MonkeyConfig): string {
  if (config.dbPath) {
    return config.dbPath.replace(/^~/, homedir());
  }
  return join(homedir(), '.omc-monkey', 'data', 'monkey.db');
}

export function getPidPath(): string {
  return join(homedir(), '.omc-monkey', 'state', 'monkey.pid');
}

export function getLogPath(): string {
  return join(homedir(), '.omc-monkey', 'logs', 'monkey.log');
}
