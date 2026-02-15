/**
 * Session Registry Module
 *
 * Maps platform message IDs to tmux pane IDs for reply correlation.
 * Uses JSONL append format for atomic writes, following the pattern from
 * session-replay.ts with secure file permissions from daemon.ts.
 *
 * Registry location: ~/.omc/state/reply-session-registry.jsonl (global, not worktree-local)
 * File permissions: 0600 (owner read/write only)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, writeSync, constants } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

// ============================================================================
// Constants
// ============================================================================

/** Global registry path (not worktree-scoped) */
const REGISTRY_PATH = join(homedir(), '.omc', 'state', 'reply-session-registry.jsonl');

/** Secure file permissions (owner read/write only) */
const SECURE_FILE_MODE = 0o600;

/** Maximum age for entries (24 hours) */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ============================================================================
// Types
// ============================================================================

export interface SessionMapping {
  platform: "discord-bot" | "telegram";
  messageId: string;
  sessionId: string;
  tmuxPaneId: string;
  tmuxSessionName: string;
  event: string;
  createdAt: string; // ISO timestamp
  projectPath?: string;
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Ensure registry directory exists with secure permissions
 */
function ensureRegistryDir(): void {
  const registryDir = dirname(REGISTRY_PATH);
  if (!existsSync(registryDir)) {
    mkdirSync(registryDir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Register a message mapping (atomic JSONL append).
 *
 * Uses O_WRONLY | O_APPEND | O_CREAT for atomic appends (up to PIPE_BUF bytes on Linux).
 * Each mapping serializes to well under 4096 bytes, making this operation atomic.
 */
export function registerMessage(mapping: SessionMapping): void {
  ensureRegistryDir();

  const line = JSON.stringify(mapping) + '\n';
  const fd = openSync(REGISTRY_PATH, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, SECURE_FILE_MODE);

  try {
    const buf = Buffer.from(line, 'utf-8');
    writeSync(fd, buf);
  } finally {
    closeSync(fd);
  }
}

/**
 * Load all mappings from the JSONL file
 */
export function loadAllMappings(): SessionMapping[] {
  if (!existsSync(REGISTRY_PATH)) {
    return [];
  }

  try {
    const content = readFileSync(REGISTRY_PATH, 'utf-8');
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try {
          return JSON.parse(line) as SessionMapping;
        } catch {
          return null;
        }
      })
      .filter((m): m is SessionMapping => m !== null);
  } catch {
    return [];
  }
}

/**
 * Look up a mapping by platform and message ID.
 * Returns the first match (most recent entry wins if duplicates exist).
 */
export function lookupByMessageId(platform: string, messageId: string): SessionMapping | null {
  const mappings = loadAllMappings();

  // Find first match (JSONL is append-only, so first occurrence is the original)
  return mappings.find(m => m.platform === platform && m.messageId === messageId) || null;
}

/**
 * Remove all entries for a given session ID.
 * This is a rewrite operation (infrequent - only on session-end).
 */
export function removeSession(sessionId: string): void {
  const mappings = loadAllMappings();
  const filtered = mappings.filter(m => m.sessionId !== sessionId);

  if (filtered.length === mappings.length) {
    // No changes needed
    return;
  }

  rewriteRegistry(filtered);
}

/**
 * Remove all entries for a given pane ID.
 * Called by reply listener when pane verification fails (stale pane cleanup).
 */
export function removeMessagesByPane(paneId: string): void {
  const mappings = loadAllMappings();
  const filtered = mappings.filter(m => m.tmuxPaneId !== paneId);

  if (filtered.length === mappings.length) {
    // No changes needed
    return;
  }

  rewriteRegistry(filtered);
}

/**
 * Remove entries older than MAX_AGE_MS (24 hours).
 * This is a rewrite operation (infrequent - called periodically by daemon).
 */
export function pruneStale(): void {
  const now = Date.now();
  const mappings = loadAllMappings();
  const filtered = mappings.filter(m => {
    try {
      const age = now - new Date(m.createdAt).getTime();
      return age < MAX_AGE_MS;
    } catch {
      // Invalid timestamp, remove it
      return false;
    }
  });

  if (filtered.length === mappings.length) {
    // No changes needed
    return;
  }

  rewriteRegistry(filtered);
}

/**
 * Rewrite the entire registry file with new mappings.
 * Used by removeSession, removeMessagesByPane, and pruneStale.
 */
function rewriteRegistry(mappings: SessionMapping[]): void {
  ensureRegistryDir();

  if (mappings.length === 0) {
    // Empty registry - write empty file
    writeFileSync(REGISTRY_PATH, '', { mode: SECURE_FILE_MODE });
    return;
  }

  const content = mappings.map(m => JSON.stringify(m)).join('\n') + '\n';
  writeFileSync(REGISTRY_PATH, content, { mode: SECURE_FILE_MODE });
}
