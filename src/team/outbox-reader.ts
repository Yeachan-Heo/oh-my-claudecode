// src/team/outbox-reader.ts

/**
 * Outbox Reader for MCP Team Bridge
 *
 * @legacy The JSONL-based functions (readNewOutboxMessages, readAllTeamOutboxMessages,
 * resetOutboxCursor) are for legacy non-protocol teams.
 * Protocol teams should use readProtocolOutboxMessages / readAllProtocolTeamOutboxMessages.
 *
 * Phase 5: Marked legacy functions; protocol alternatives added in Phase 3d.
 */

import {
  readFileSync, openSync, readSync, closeSync,
  statSync, existsSync, readdirSync
} from 'fs';
import { join } from 'path';
import { getClaudeConfigDir } from '../utils/paths.js';
import { validateResolvedPath, writeFileWithMode, atomicWriteJson, ensureDirWithMode } from './fs-utils.js';
import { sanitizeName } from './tmux-session.js';
import type { OutboxMessage } from './types.js';
import { listMessages as protoListMessages, markDelivered as protoMarkDelivered } from 'cli-agent-mail';
import { resolveStateRoot } from './protocol-adapter.js';

/** Outbox cursor stored alongside outbox files */
export interface OutboxCursor {
  bytesRead: number;
}

const MAX_OUTBOX_READ_SIZE = 10 * 1024 * 1024; // 10MB cap per read

function teamsDir(): string {
  return join(getClaudeConfigDir(), 'teams');
}

/**
 * Read new outbox messages for a worker using byte-offset cursor.
 * Mirror of readNewInboxMessages() but for the outbox direction.
 * @deprecated Use readProtocolOutboxMessages() for protocol teams.
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
 * @deprecated Use readAllProtocolTeamOutboxMessages() for protocol teams.
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
 * @deprecated Use protocol mailbox for new teams.
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

// --- Protocol-aware alternatives ---

/**
 * Read new outbox messages from the lead's protocol mailbox, filtered by sender.
 * Marks messages as delivered after reading.
 * Used when the team operates in protocol mode.
 */
export function readProtocolOutboxMessages(
  workingDirectory: string,
  teamName: string,
  workerName: string
): OutboxMessage[] {
  const stateRoot = resolveStateRoot(workingDirectory);
  // In protocol mode, worker->lead messages are in the "lead" mailbox
  const allMessages = protoListMessages(stateRoot, teamName, 'lead');

  // Filter to undelivered messages from this worker
  const workerMessages = allMessages.filter(
    m => m.from === workerName && !m.delivered_at
  );

  // Mark as delivered
  for (const m of workerMessages) {
    try {
      protoMarkDelivered(stateRoot, teamName, 'lead', m.message_id);
    } catch { /* best effort */ }
  }

  // Convert protocol messages to OutboxMessage format
  return workerMessages.map(m => {
    try {
      // The body is a JSON-serialized OutboxMessage
      return JSON.parse(m.body) as OutboxMessage;
    } catch {
      return {
        type: 'error' as const,
        message: m.body,
        timestamp: m.created_at,
      };
    }
  });
}

/**
 * Read protocol outbox messages from ALL workers in a team.
 */
export function readAllProtocolTeamOutboxMessages(
  workingDirectory: string,
  teamName: string
): { workerName: string; messages: OutboxMessage[] }[] {
  const stateRoot = resolveStateRoot(workingDirectory);
  const allMessages = protoListMessages(stateRoot, teamName, 'lead');
  const undelivered = allMessages.filter(m => !m.delivered_at);

  // Group by sender
  const grouped = new Map<string, OutboxMessage[]>();
  for (const m of undelivered) {
    const msgs = grouped.get(m.from) || [];
    try {
      msgs.push(JSON.parse(m.body) as OutboxMessage);
    } catch {
      msgs.push({ type: 'error', message: m.body, timestamp: m.created_at });
    }
    grouped.set(m.from, msgs);

    // Mark as delivered
    try {
      protoMarkDelivered(stateRoot, teamName, 'lead', m.message_id);
    } catch { /* best effort */ }
  }

  return Array.from(grouped.entries()).map(([workerName, messages]) => ({
    workerName,
    messages,
  }));
}
