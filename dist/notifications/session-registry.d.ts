/**
 * Session Registry Module
 *
 * Maps platform message IDs to tmux pane IDs for reply correlation.
 * Uses JSONL append format for atomic writes, following the pattern from
 * session-replay.ts with secure file permissions from daemon.ts.
 *
 * Registry location: XDG-aware global OMC state (legacy ~/.omc/state fallback for reads)
 * File permissions: 0600 (owner read/write only)
 */
export interface SessionMapping {
    platform: "discord-bot" | "telegram" | "slack-bot";
    messageId: string;
    sessionId: string;
    tmuxPaneId: string;
    tmuxSessionName: string;
    event: string;
    createdAt: string;
    projectPath?: string;
    /** AskUserQuestion metadata used to target the Other/free-text field for mobile replies. */
    askUserQuestionOptionCount?: number;
    askUserQuestionAllowOther?: boolean;
}
/**
 * Reserve an empty registry while the exact listener generation is stopped.
 * Holding this lock prevents a concurrent notification registration from being
 * lost between its empty check and process termination.
 */
export declare function lockRegistryIfEmpty(): (() => void) | 'active' | null;
/**
 * Register a message mapping (atomic JSONL append).
 *
 * Uses O_WRONLY | O_APPEND | O_CREAT for atomic appends (up to PIPE_BUF bytes on Linux).
 * Each mapping serializes to well under 4096 bytes, making this operation atomic.
 */
export declare function registerMessage(mapping: SessionMapping): boolean;
/**
 * Load all mappings from the JSONL file
 */
export declare function loadAllMappings(): SessionMapping[];
/**
 * Look up a mapping by platform and message ID.
 * Returns the most recent entry when duplicates exist (last match in append-ordered JSONL).
 */
export declare function lookupByMessageId(platform: string, messageId: string): SessionMapping | null;
/**
 * Remove all entries for a given session ID.
 * This is a rewrite operation (infrequent - only on session-end).
 */
export declare function removeSession(sessionId: string): boolean;
/**
 * Remove all entries for a given pane ID.
 * Called by reply listener when pane verification fails (stale pane cleanup).
 */
export declare function removeMessagesByPane(paneId: string): boolean;
/**
 * Remove entries older than MAX_AGE_MS (24 hours).
 * This is a rewrite operation (infrequent - called periodically by daemon).
 */
export declare function pruneStale(): boolean;
//# sourceMappingURL=session-registry.d.ts.map