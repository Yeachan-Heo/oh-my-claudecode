// src/team/inbox-outbox.ts

/**
 * Inbox/Outbox Messaging for MCP Team Bridge
 *
 * Dual-path: delegates to cli-agent-mail protocol when the team has a
 * protocol layout, otherwise falls back to legacy JSONL file I/O.
 *
 * Phase 3b-2: Added protocol path.
 * Phase 5: Restored legacy fallback for backward compatibility.
 */

import {
  readFileSync, existsSync,
  statSync, unlinkSync, renameSync, openSync,
  readSync, closeSync
} from 'fs';
import { join, dirname } from 'path';
import { getClaudeConfigDir } from '../utils/paths.js';
import type { InboxMessage, OutboxMessage, ShutdownSignal, DrainSignal, InboxCursor } from './types.js';
import { sanitizeName } from './tmux-session.js';
import { appendFileWithMode, writeFileWithMode, atomicWriteJson, ensureDirWithMode, validateResolvedPath } from './fs-utils.js';
import {
  sendMessage as protocolSendMessage,
  listMessages as protocolListMessages,
  markDelivered as protocolMarkDelivered,
  pruneDeliveredMessages as protocolPruneDelivered,
  requestShutdown as protocolRequestShutdown,
  readShutdownRequest as protocolReadShutdown,
  clearSignals as protocolClearSignals,
  requestDrain as protocolRequestDrain,
  readDrainSignal as protocolReadDrain,
} from 'cli-agent-mail';
import { toProtocolMessage, fromProtocolMessage, resolveStateRoot } from './protocol-adapter.js';

/** Maximum bytes to read from inbox in a single call (10 MB) */
const MAX_INBOX_READ_SIZE = 10 * 1024 * 1024;

// ─── State root + protocol detection ────────────────────────────────────────

function getStateRoot(): string {
  const cwd = process.env['OMC_WORKING_DIR'] || process.cwd();
  return resolveStateRoot(cwd);
}

function hasProtocolLayout(teamName: string): boolean {
  try {
    const stateRoot = getStateRoot();
    const manifestFile = join(stateRoot, 'team', teamName, 'manifest.json');
    return existsSync(manifestFile);
  } catch {
    return false;
  }
}

// ─── Legacy path helpers ────────────────────────────────────────────────────

function legacyTeamsDir(teamName: string): string {
  const result = join(getClaudeConfigDir(), 'teams', sanitizeName(teamName));
  validateResolvedPath(result, join(getClaudeConfigDir(), 'teams'));
  return result;
}

function inboxPath(teamName: string, workerName: string): string {
  return join(legacyTeamsDir(teamName), 'inbox', `${sanitizeName(workerName)}.jsonl`);
}

function inboxCursorPath(teamName: string, workerName: string): string {
  return join(legacyTeamsDir(teamName), 'inbox', `${sanitizeName(workerName)}.offset`);
}

function outboxPath(teamName: string, workerName: string): string {
  return join(legacyTeamsDir(teamName), 'outbox', `${sanitizeName(workerName)}.jsonl`);
}

function signalPath(teamName: string, workerName: string): string {
  return join(legacyTeamsDir(teamName), 'signals', `${sanitizeName(workerName)}.shutdown`);
}

function drainSignalPath(teamName: string, workerName: string): string {
  return join(legacyTeamsDir(teamName), 'signals', `${sanitizeName(workerName)}.drain`);
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  ensureDirWithMode(dir);
}

// ─── Outbox (worker -> lead) ────────────────────────────────────────────────

export function appendOutbox(teamName: string, workerName: string, message: OutboxMessage): void {
  if (hasProtocolLayout(teamName)) {
    const stateRoot = getStateRoot();
    const protocolMsg = toProtocolMessage(message, workerName);
    protocolSendMessage(stateRoot, teamName, {
      from: protocolMsg.from,
      to: protocolMsg.to,
      type: protocolMsg.type,
      body: protocolMsg.body,
    });
    return;
  }
  const filePath = outboxPath(teamName, workerName);
  ensureDir(filePath);
  appendFileWithMode(filePath, JSON.stringify(message) + '\n');
}

export function rotateOutboxIfNeeded(teamName: string, workerName: string, maxLines: number): void {
  if (hasProtocolLayout(teamName)) {
    const stateRoot = getStateRoot();
    protocolPruneDelivered(stateRoot, teamName, 'lead');
    return;
  }
  const filePath = outboxPath(teamName, workerName);
  if (!existsSync(filePath)) return;
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length <= maxLines) return;
    const keepCount = Math.floor(maxLines / 2);
    const kept = lines.slice(-keepCount);
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    writeFileWithMode(tmpPath, kept.join('\n') + '\n');
    renameSync(tmpPath, filePath);
  } catch { /* Rotation failure is non-fatal */ }
}

export function rotateInboxIfNeeded(teamName: string, workerName: string, maxSizeBytes: number): void {
  if (hasProtocolLayout(teamName)) {
    const stateRoot = getStateRoot();
    protocolPruneDelivered(stateRoot, teamName, workerName);
    return;
  }
  const filePath = inboxPath(teamName, workerName);
  if (!existsSync(filePath)) return;
  try {
    const stat = statSync(filePath);
    if (stat.size <= maxSizeBytes) return;
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const keepCount = Math.max(1, Math.floor(lines.length / 2));
    const kept = lines.slice(-keepCount);
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    writeFileWithMode(tmpPath, kept.join('\n') + '\n');
    renameSync(tmpPath, filePath);
    const cursorFile = inboxCursorPath(teamName, workerName);
    atomicWriteJson(cursorFile, { bytesRead: 0 });
  } catch { /* Rotation failure is non-fatal */ }
}

// ─── Inbox (lead -> worker) ─────────────────────────────────────────────────

export function readNewInboxMessages(teamName: string, workerName: string): InboxMessage[] {
  if (hasProtocolLayout(teamName)) {
    const stateRoot = getStateRoot();
    const allMessages = protocolListMessages(stateRoot, teamName, workerName);
    const undelivered = allMessages.filter(m => !m.delivered_at);
    if (undelivered.length === 0) return [];
    const inboxMessages: InboxMessage[] = [];
    for (const msg of undelivered) {
      protocolMarkDelivered(stateRoot, teamName, workerName, msg.message_id);
      inboxMessages.push(fromProtocolMessage(msg));
    }
    return inboxMessages;
  }

  // Legacy JSONL path
  const inbox = inboxPath(teamName, workerName);
  const cursorFile = inboxCursorPath(teamName, workerName);
  if (!existsSync(inbox)) return [];

  let offset = 0;
  if (existsSync(cursorFile)) {
    try {
      const cursor: InboxCursor = JSON.parse(readFileSync(cursorFile, 'utf-8'));
      offset = cursor.bytesRead;
    } catch { /* reset to 0 */ }
  }

  const stat = statSync(inbox);
  if (stat.size < offset) offset = 0;
  if (stat.size <= offset) return [];

  const readSize = stat.size - offset;
  const cappedSize = Math.min(readSize, MAX_INBOX_READ_SIZE);
  const fd = openSync(inbox, 'r');
  const buffer = Buffer.alloc(cappedSize);
  try {
    readSync(fd, buffer, 0, buffer.length, offset);
  } finally {
    closeSync(fd);
  }

  const newData = buffer.toString('utf-8');
  const lastNewlineIdx = newData.lastIndexOf('\n');
  if (lastNewlineIdx === -1) return [];

  const completeData = newData.substring(0, lastNewlineIdx + 1);
  const messages: InboxMessage[] = [];
  let bytesProcessed = 0;

  const lines = completeData.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    if (!line.trim()) {
      bytesProcessed += Buffer.byteLength(line, 'utf-8') + 1;
      continue;
    }
    const cleanLine = line.endsWith('\r') ? line.slice(0, -1) : line;
    const lineBytes = Buffer.byteLength(line, 'utf-8') + 1;
    try {
      messages.push(JSON.parse(cleanLine));
      bytesProcessed += lineBytes;
    } catch {
      break;
    }
  }

  const newOffset = offset + (bytesProcessed > 0 ? bytesProcessed : 0);
  ensureDir(cursorFile);
  const newCursor: InboxCursor = { bytesRead: newOffset > offset ? newOffset : offset };
  atomicWriteJson(cursorFile, newCursor);

  return messages;
}

export function readAllInboxMessages(teamName: string, workerName: string): InboxMessage[] {
  if (hasProtocolLayout(teamName)) {
    const stateRoot = getStateRoot();
    const allMessages = protocolListMessages(stateRoot, teamName, workerName);
    return allMessages.map(m => fromProtocolMessage(m));
  }
  const inbox = inboxPath(teamName, workerName);
  if (!existsSync(inbox)) return [];
  try {
    const content = readFileSync(inbox, 'utf-8');
    const messages: InboxMessage[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { messages.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return messages;
  } catch {
    return [];
  }
}

export function clearInbox(teamName: string, workerName: string): void {
  if (hasProtocolLayout(teamName)) {
    const stateRoot = getStateRoot();
    const allMessages = protocolListMessages(stateRoot, teamName, workerName);
    for (const msg of allMessages) {
      if (!msg.delivered_at) {
        protocolMarkDelivered(stateRoot, teamName, workerName, msg.message_id);
      }
    }
    protocolPruneDelivered(stateRoot, teamName, workerName);
    return;
  }
  const inbox = inboxPath(teamName, workerName);
  const cursorFile = inboxCursorPath(teamName, workerName);
  if (existsSync(inbox)) {
    try { writeFileWithMode(inbox, ''); } catch { /* ignore */ }
  }
  if (existsSync(cursorFile)) {
    try { writeFileWithMode(cursorFile, JSON.stringify({ bytesRead: 0 })); } catch { /* ignore */ }
  }
}

// ─── Shutdown signals ───────────────────────────────────────────────────────

export function writeShutdownSignal(teamName: string, workerName: string, requestId: string, reason: string): void {
  if (hasProtocolLayout(teamName)) {
    const stateRoot = getStateRoot();
    protocolRequestShutdown(stateRoot, teamName, workerName, `${requestId}:${reason}`);
    return;
  }
  const filePath = signalPath(teamName, workerName);
  ensureDir(filePath);
  const signal: ShutdownSignal = { requestId, reason, timestamp: new Date().toISOString() };
  writeFileWithMode(filePath, JSON.stringify(signal, null, 2));
}

export function checkShutdownSignal(teamName: string, workerName: string): ShutdownSignal | null {
  if (hasProtocolLayout(teamName)) {
    const stateRoot = getStateRoot();
    const request = protocolReadShutdown(stateRoot, teamName, workerName);
    if (!request) return null;
    const requestedBy = request.requested_by ?? '';
    const colonIdx = requestedBy.indexOf(':');
    return {
      requestId: colonIdx >= 0 ? requestedBy.substring(0, colonIdx) : requestedBy,
      reason: colonIdx >= 0 ? requestedBy.substring(colonIdx + 1) : '',
      timestamp: request.requested_at,
    };
  }
  const filePath = signalPath(teamName, workerName);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as ShutdownSignal;
  } catch {
    return null;
  }
}

export function deleteShutdownSignal(teamName: string, workerName: string): void {
  if (hasProtocolLayout(teamName)) {
    const stateRoot = getStateRoot();
    protocolClearSignals(stateRoot, teamName, workerName);
    return;
  }
  const filePath = signalPath(teamName, workerName);
  if (existsSync(filePath)) {
    try { unlinkSync(filePath); } catch { /* ignore */ }
  }
}

// ─── Drain signals ──────────────────────────────────────────────────────────

export function writeDrainSignal(teamName: string, workerName: string, requestId: string, reason: string): void {
  if (hasProtocolLayout(teamName)) {
    const stateRoot = getStateRoot();
    protocolRequestDrain(stateRoot, teamName, workerName, `${requestId}:${reason}`);
    return;
  }
  const filePath = drainSignalPath(teamName, workerName);
  ensureDir(filePath);
  const signal: DrainSignal = { requestId, reason, timestamp: new Date().toISOString() };
  writeFileWithMode(filePath, JSON.stringify(signal, null, 2));
}

export function checkDrainSignal(teamName: string, workerName: string): DrainSignal | null {
  if (hasProtocolLayout(teamName)) {
    const stateRoot = getStateRoot();
    const signal = protocolReadDrain(stateRoot, teamName, workerName);
    if (!signal) return null;
    const requestedBy = signal.requested_by ?? '';
    const colonIdx = requestedBy.indexOf(':');
    return {
      requestId: colonIdx >= 0 ? requestedBy.substring(0, colonIdx) : requestedBy,
      reason: colonIdx >= 0 ? requestedBy.substring(colonIdx + 1) : '',
      timestamp: signal.requested_at,
    };
  }
  const filePath = drainSignalPath(teamName, workerName);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as DrainSignal;
  } catch {
    return null;
  }
}

export function deleteDrainSignal(teamName: string, workerName: string): void {
  if (hasProtocolLayout(teamName)) {
    const stateRoot = getStateRoot();
    protocolClearSignals(stateRoot, teamName, workerName);
    return;
  }
  const filePath = drainSignalPath(teamName, workerName);
  if (existsSync(filePath)) {
    try { unlinkSync(filePath); } catch { /* ignore */ }
  }
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

export function cleanupWorkerFiles(teamName: string, workerName: string): void {
  if (hasProtocolLayout(teamName)) {
    const stateRoot = getStateRoot();
    // Clear mailbox
    const allMessages = protocolListMessages(stateRoot, teamName, workerName);
    for (const msg of allMessages) {
      if (!msg.delivered_at) {
        protocolMarkDelivered(stateRoot, teamName, workerName, msg.message_id);
      }
    }
    protocolPruneDelivered(stateRoot, teamName, workerName);
    // Clear signals
    protocolClearSignals(stateRoot, teamName, workerName);
    return;
  }
  const files = [
    inboxPath(teamName, workerName),
    inboxCursorPath(teamName, workerName),
    outboxPath(teamName, workerName),
    signalPath(teamName, workerName),
    drainSignalPath(teamName, workerName),
  ];
  for (const f of files) {
    if (existsSync(f)) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  }
}
