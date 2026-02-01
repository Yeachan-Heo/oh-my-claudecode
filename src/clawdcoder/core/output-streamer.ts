import { capturePane } from './tmux.js';
import { logger } from '../utils/logger.js';

export interface StreamSubscriber {
  id: string;
  sessionId: string;
  callback: (content: string) => Promise<void>;
  lastContent: string;
  lastUpdate: number;
}

const subscribers = new Map<string, StreamSubscriber>();
let pollInterval: ReturnType<typeof setInterval> | null = null;

const ACTIVE_POLL_MS = 500;
const IDLE_POLL_MS = 5000;
const IDLE_THRESHOLD_MS = 10000;

export function subscribe(
  subscriberId: string,
  sessionId: string,
  callback: (content: string) => Promise<void>
): void {
  subscribers.set(subscriberId, {
    id: subscriberId,
    sessionId,
    callback,
    lastContent: '',
    lastUpdate: Date.now(),
  });

  startPolling();
  logger.debug('Added stream subscriber', { subscriberId, sessionId });
}

export function unsubscribe(subscriberId: string): void {
  subscribers.delete(subscriberId);

  if (subscribers.size === 0) {
    stopPolling();
  }

  logger.debug('Removed stream subscriber', { subscriberId });
}

export function unsubscribeSession(sessionId: string): void {
  for (const [id, sub] of subscribers) {
    if (sub.sessionId === sessionId) {
      subscribers.delete(id);
    }
  }

  if (subscribers.size === 0) {
    stopPolling();
  }
}

function startPolling(): void {
  if (pollInterval) return;

  pollInterval = setInterval(pollAllSessions, ACTIVE_POLL_MS);
  logger.debug('Started output polling');
}

function stopPolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    logger.debug('Stopped output polling');
  }
}

async function pollAllSessions(): Promise<void> {
  const sessionIds = new Set<string>();
  for (const sub of subscribers.values()) {
    sessionIds.add(sub.sessionId);
  }

  for (const sessionId of sessionIds) {
    try {
      const content = capturePane(sessionId, 100);
      const sessionSubscribers = Array.from(subscribers.values()).filter(s => s.sessionId === sessionId);

      for (const sub of sessionSubscribers) {
        if (content !== sub.lastContent) {
          // Find the new content (diff)
          const newContent = findNewContent(sub.lastContent, content);

          if (newContent) {
            try {
              await sub.callback(newContent);
              sub.lastUpdate = Date.now();
            } catch (error) {
              logger.error('Stream callback failed', { subscriberId: sub.id, error: String(error) });
            }
          }

          sub.lastContent = content;
        }
      }
    } catch (error) {
      logger.error('Failed to poll session', { sessionId, error: String(error) });
    }
  }
}

function findNewContent(oldContent: string, newContent: string): string | null {
  if (oldContent === newContent) return null;

  // Simple approach: find where old content ends in new content
  const oldLines = oldContent.trim().split('\n');
  const newLines = newContent.trim().split('\n');

  if (oldLines.length === 0) {
    return newContent;
  }

  // Find the last line of old content in new content
  const lastOldLine = oldLines[oldLines.length - 1];
  let matchIndex = -1;

  for (let i = newLines.length - 1; i >= 0; i--) {
    if (newLines[i] === lastOldLine) {
      matchIndex = i;
      break;
    }
  }

  if (matchIndex === -1) {
    // Content completely changed
    return newContent;
  }

  // Return only the new lines
  const newOnlyLines = newLines.slice(matchIndex + 1);

  if (newOnlyLines.length === 0) {
    return null;
  }

  return newOnlyLines.join('\n');
}

export function getSubscriberCount(): number {
  return subscribers.size;
}

export function isStreaming(sessionId: string): boolean {
  for (const sub of subscribers.values()) {
    if (sub.sessionId === sessionId) {
      return true;
    }
  }
  return false;
}
