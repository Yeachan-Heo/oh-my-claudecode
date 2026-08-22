// src/team/mailbox-outstanding.ts

/**
 * Outstanding directed-work accounting for team mailboxes.
 *
 * A worker still owes work when its mailbox holds directed messages that
 * have not been delivered (`delivered_at` unset):
 *   - inbound:  messages addressed TO the worker (queued/unanswered work)
 *   - outbound: messages FROM the worker (reports/acks awaiting delivery)
 *
 * OMC idle surfaces (worker-idle notifications, all-workers-idle claims,
 * worker_idle events, leader-nudge idle accounting) must not report such a
 * worker as plainly idle/available: they either carry this observable
 * metadata or classify the worker as not idle. See issue #3662.
 */

import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

export interface OutstandingMailboxCount {
  /** Messages directed TO the worker that are not yet delivered (queued/unanswered work). */
  undeliveredInbound: number;
  /** Messages FROM the worker that are not yet delivered (owed reports/acks). */
  undeliveredOutbound: number;
}

export const ZERO_OUTSTANDING: OutstandingMailboxCount = Object.freeze({
  undeliveredInbound: 0,
  undeliveredOutbound: 0,
});

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isUndelivered(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as Record<string, unknown>;
  const deliveredAt = safeString(
    candidate.delivered_at ?? candidate.deliveredAt ?? candidate.delivered,
  ).trim();
  return deliveredAt === '';
}

function messageFromWorker(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const candidate = message as Record<string, unknown>;
  return safeString(candidate.from_worker ?? candidate.from).trim();
}

function messageToWorker(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const candidate = message as Record<string, unknown>;
  return safeString(candidate.to_worker ?? candidate.to).trim();
}

/** Parse the canonical mailbox JSON shape ({ worker, messages: [] } or a bare array). */
async function readMailboxFileMessages(filePath: string): Promise<unknown[]> {
  try {
    if (!existsSync(filePath)) return [];
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).messages)) {
      return (parsed as Record<string, unknown>).messages as unknown[];
    }
    return [];
  } catch {
    // A malformed mailbox (e.g. mid-write) must never break idle accounting.
    return [];
  }
}

/** Parse the legacy JSONL mailbox shape (one message per line). */
async function readMailboxFileMessagesJsonl(filePath: string): Promise<unknown[]> {
  try {
    if (!existsSync(filePath)) return [];
    const raw = await readFile(filePath, 'utf-8');
    const messages: unknown[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        messages.push(JSON.parse(trimmed) as unknown);
      } catch {
        // skip malformed legacy row
      }
    }
    return messages;
  } catch {
    return [];
  }
}

/**
 * Scan the team mailbox directory and compute undelivered directed-work
 * counts for every worker, reading each `{recipient}.json` / `{recipient}.jsonl`
 * mailbox at most once.
 *
 * Missing directories and malformed files are tolerated (counted as zero)
 * so a transient mailbox write never crashes an idle notification.
 */
export async function scanMailboxOutstanding(
  mailboxDir: string,
): Promise<Record<string, OutstandingMailboxCount>> {
  const result: Record<string, OutstandingMailboxCount> = {};
  let entries: string[] = [];
  try {
    entries = await readdir(mailboxDir);
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    let recipient = '';
    let messages: unknown[] = [];
    if (entry.endsWith('.json')) {
      recipient = entry.slice(0, -'.json'.length);
      messages = await readMailboxFileMessages(join(mailboxDir, entry));
    } else if (entry.endsWith('.jsonl')) {
      recipient = entry.slice(0, -'.jsonl'.length);
      messages = await readMailboxFileMessagesJsonl(join(mailboxDir, entry));
    } else {
      continue;
    }
    if (!recipient) continue;

    let inbound = 0;
    const outboundBySender = new Map<string, number>();
    for (const message of messages) {
      if (!isUndelivered(message)) continue;
      if (messageToWorker(message) === recipient) inbound += 1;
      const from = messageFromWorker(message);
      if (from) outboundBySender.set(from, (outboundBySender.get(from) ?? 0) + 1);
    }

    const recipientEntry = result[recipient] ?? { undeliveredInbound: 0, undeliveredOutbound: 0 };
    result[recipient] = {
      undeliveredInbound: recipientEntry.undeliveredInbound + inbound,
      undeliveredOutbound: recipientEntry.undeliveredOutbound,
    };
    for (const [sender, count] of outboundBySender) {
      const senderEntry = result[sender] ?? { undeliveredInbound: 0, undeliveredOutbound: 0 };
      result[sender] = {
        undeliveredInbound: senderEntry.undeliveredInbound,
        undeliveredOutbound: senderEntry.undeliveredOutbound + count,
      };
    }
  }

  return result;
}

/** Outstanding directed-work counts for a single worker (0/0 when absent or unreadable). */
export async function countOutstandingForWorker(
  mailboxDir: string,
  workerName: string,
): Promise<OutstandingMailboxCount> {
  if (!workerName) return ZERO_OUTSTANDING;
  const scanned = await scanMailboxOutstanding(mailboxDir);
  return scanned[workerName] ?? ZERO_OUTSTANDING;
}
