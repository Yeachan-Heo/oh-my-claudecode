// src/team/outbox-reader.ts

/**
 * Outbox Reader for MCP Team Bridge
 *
 * Reads outbox messages (worker -> lead) using byte-offset cursor,
 * mirroring the inbox cursor pattern from inbox-outbox.ts.
 */

import {
  readFileSync, openSync, readSync, closeSync,
  statSync, existsSync, readdirSync
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { validateResolvedPath, writeFileWithMode, atomicWriteJson, ensureDirWithMode } from './fs-utils.js';
import { sanitizeName } from './tmux-session.js';
import type { OutboxMessage } from './types.js';

/** Outbox cursor stored alongside outbox files */
export interface OutboxCursor {
  bytesRead: number;
}

const MAX_OUTBOX_READ_SIZE = 10 * 1024 * 1024; // 10MB cap per read

function teamsDir(): string {
  return join(homedir(), '.claude', 'teams');
}

/**
 * Read new outbox messages for a worker using byte-offset cursor.
 * Mirror of readNewInboxMessages() but for the outbox direction.
 */
export function readNewOutboxMessages(
  teamName: string,
  workerName: string
): OutboxMessage[] {
  const safeName = sanitizeName(teamName);
  const safeWorker = sanitizeName(workerName);
  const outboxPath = join(teamsDir(), safeName, 'outbox', `${safeWorker}.jsonl`);
  const cursorPath = join(teamsDir(), safeName, 'outbox', `${safeWorker}.outbox-offset`);

  validateResolvedPath(outboxPath, teamsDir());
  validateResolvedPath(cursorPath, teamsDir());

  if (!existsSync(outboxPath)) return [];

  // Read cursor
  let cursor: OutboxCursor = { bytesRead: 0 };
  if (existsSync(cursorPath)) {
    try {
      const raw = readFileSync(cursorPath, 'utf-8');
      cursor = JSON.parse(raw);
    } catch { cursor = { bytesRead: 0 }; }
  }

  const stat = statSync(outboxPath);
  // Handle file truncation (cursor > file size)
  if (cursor.bytesRead > stat.size) {
    cursor = { bytesRead: 0 };
  }

  const bytesToRead = Math.min(stat.size - cursor.bytesRead, MAX_OUTBOX_READ_SIZE);
  if (bytesToRead <= 0) return [];

  const buf = Buffer.alloc(bytesToRead);
  const fd = openSync(outboxPath, 'r');
  try {
    readSync(fd, buf, 0, bytesToRead, cursor.bytesRead);
  } finally {
    closeSync(fd);
  }

  const lines = buf.toString('utf-8').split('\n').filter(l => l.trim());
  const messages: OutboxMessage[] = [];
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line));
    } catch { /* skip malformed lines */ }
  }

  // Update cursor atomically to prevent corruption on crash
  const newCursor: OutboxCursor = { bytesRead: cursor.bytesRead + bytesToRead };
  const cursorDir = join(teamsDir(), safeName, 'outbox');
  ensureDirWithMode(cursorDir);
  atomicWriteJson(cursorPath, newCursor);

  return messages;
}

/**
 * Read new outbox messages from ALL workers in a team.
 */
export function readAllTeamOutboxMessages(
  teamName: string
): { workerName: string; messages: OutboxMessage[] }[] {
  const safeName = sanitizeName(teamName);
  const outboxDir = join(teamsDir(), safeName, 'outbox');

  if (!existsSync(outboxDir)) return [];

  const files = readdirSync(outboxDir).filter(f => f.endsWith('.jsonl'));
  const results: { workerName: string; messages: OutboxMessage[] }[] = [];

  for (const file of files) {
    const workerName = file.replace('.jsonl', '');
    const messages = readNewOutboxMessages(teamName, workerName);
    if (messages.length > 0) {
      results.push({ workerName, messages });
    }
  }

  return results;
}

/**
 * Reset outbox cursor for a worker.
 */
export function resetOutboxCursor(
  teamName: string,
  workerName: string
): void {
  const safeName = sanitizeName(teamName);
  const safeWorker = sanitizeName(workerName);
  const cursorPath = join(teamsDir(), safeName, 'outbox', `${safeWorker}.outbox-offset`);
  validateResolvedPath(cursorPath, teamsDir());
  const cursorDir = join(teamsDir(), safeName, 'outbox');
  ensureDirWithMode(cursorDir);
  writeFileWithMode(cursorPath, JSON.stringify({ bytesRead: 0 }));
}
