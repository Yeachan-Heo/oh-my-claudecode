import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ClawdCoderConfig } from './types.js';

const DEFAULT_CONFIG: ClawdCoderConfig = {
  maxSessions: 5,
  autoCleanupHours: 24,
  defaultProjectDir: join(homedir(), 'projects'),
};

export function loadConfig(): ClawdCoderConfig {
  const configPath = join(homedir(), '.claude', '.omc-config.json');

  try {
    if (!existsSync(configPath)) {
      return { ...DEFAULT_CONFIG };
    }

    const raw = readFileSync(configPath, 'utf8');
    const full = JSON.parse(raw);
    const clawdcoderConfig = full.clawdcoder ?? {};

    // Override with environment variables
    if (process.env.CLAWDCODER_DISCORD_TOKEN) {
      clawdcoderConfig.discord = {
        ...clawdcoderConfig.discord,
        token: process.env.CLAWDCODER_DISCORD_TOKEN,
        enabled: true,
      };
    }

    if (process.env.CLAWDCODER_TELEGRAM_TOKEN) {
      clawdcoderConfig.telegram = {
        ...clawdcoderConfig.telegram,
        token: process.env.CLAWDCODER_TELEGRAM_TOKEN,
        enabled: true,
      };
    }

    return { ...DEFAULT_CONFIG, ...clawdcoderConfig };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function getDbPath(config: ClawdCoderConfig): string {
  if (config.dbPath) {
    return config.dbPath.replace(/^~/, homedir());
  }
  return join(homedir(), '.omc', 'data', 'clawdcoder.db');
}

export function getSocketPath(): string {
  return join(homedir(), '.omc', 'state', 'clawdcoder.sock');
}

export function getPidPath(): string {
  return join(homedir(), '.omc', 'state', 'clawdcoder.pid');
}

export function getLogPath(): string {
  return join(homedir(), '.omc', 'logs', 'clawdcoder.log');
}
