import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { getLogPath } from '../config.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  msg: string;
  time: string;
  [key: string]: unknown;
}

let logStream: ReturnType<typeof createWriteStream> | null = null;
let minLevel: LogLevel = 'info';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

function initStream(): void {
  if (logStream) return;

  const logPath = getLogPath();
  const logDir = dirname(logPath);

  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  logStream = createWriteStream(logPath, { flags: 'a' });
}

function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;

  initStream();

  const entry: LogEntry = {
    level,
    msg,
    time: new Date().toISOString(),
    ...data,
  };

  const line = JSON.stringify(entry) + '\n';

  logStream?.write(line);

  // Also log to console in development
  if (process.env.NODE_ENV !== 'production') {
    const prefix = `[${level.toUpperCase()}]`;
    console.error(prefix, msg, data ? JSON.stringify(data) : '');
  }
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => log('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => log('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log('error', msg, data),
  setLevel: (level: LogLevel) => { minLevel = level; },
  close: () => { logStream?.end(); logStream = null; },
};
