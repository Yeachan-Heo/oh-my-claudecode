/**
 * Session Recovery Storage Operations
 *
 * Functions for reading and manipulating stored session data.
 */
import type { StoredMessageMeta, StoredPart } from './types.js';
/**
 * Generate a unique part ID
 */
export declare function generatePartId(): string;
/**
 * Get the directory containing messages for a session
 */
export declare function getMessageDir(sessionID: string): string;
/**
 * Read all messages for a session
 */
export declare function readMessages(sessionID: string): StoredMessageMeta[];
/**
 * Read all parts for a message
 */
export declare function readParts(messageID: string): StoredPart[];
/**
 * Check if a part has content (not thinking/meta)
 */
export declare function hasContent(part: StoredPart): boolean;
/**
 * Check if a message has content
 */
export declare function messageHasContent(messageID: string): boolean;
/**
 * Inject a text part into a message
 */
export declare function injectTextPart(sessionID: string, messageID: string, text: string): boolean;
/**
 * Find all messages with empty content
 */
export declare function findEmptyMessages(sessionID: string): string[];
/**
 * Find empty message by index (with fuzzy matching)
 */
export declare function findEmptyMessageByIndex(sessionID: string, targetIndex: number): string | null;
/**
 * Find messages that have thinking blocks
 */
export declare function findMessagesWithThinkingBlocks(sessionID: string): string[];
/**
 * Find messages that have thinking but no content
 */
export declare function findMessagesWithThinkingOnly(sessionID: string): string[];
/**
 * Find messages with orphan thinking (thinking not first)
 */
export declare function findMessagesWithOrphanThinking(sessionID: string): string[];
/**
 * Prepend a thinking part to a message
 */
export declare function prependThinkingPart(sessionID: string, messageID: string): boolean;
/**
 * Strip all thinking parts from a message
 */
export declare function stripThinkingParts(messageID: string): boolean;
/**
 * Replace empty text parts with placeholder text
 */
export declare function replaceEmptyTextParts(messageID: string, replacementText?: string): boolean;
/**
 * Find messages with empty text parts
 */
export declare function findMessagesWithEmptyTextParts(sessionID: string): string[];
/**
 * Find message by index that needs thinking block
 */
export declare function findMessageByIndexNeedingThinking(sessionID: string, targetIndex: number): string | null;
//# sourceMappingURL=storage.d.ts.map