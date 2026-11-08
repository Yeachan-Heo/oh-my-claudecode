/**
 * Context Injector Types
 *
 * Type definitions for the context injection system.
 * Allows multiple sources to register context that gets merged
 * and injected into prompts.
 *
 * Ported from oh-my-opencode's context-injector.
 */

/**
 * Source identifier for context injection.
 * Each source registers context that will be merged and injected together.
 */
export type ContextSourceType =
  | 'keyword-detector'
  | 'rules-injector'
  | 'directory-agents'
  | 'directory-readme'
  | 'boulder-state'
  | 'session-context'
  | 'learner'
  | 'beads'
  | 'project-memory'
  | 'custom';

/**
 * Priority levels for context ordering.
 * Higher priority contexts appear first in the merged output.
 */
export type ContextPriority = 'critical' | 'high' | 'normal' | 'low';

/**
 * A single context entry registered by a source.
 */
export interface ContextEntry {
  /** Unique identifier for this entry within the source */
  id: string;
  /** The source that registered this context */
  source: ContextSourceType;
  /** The actual context content to inject */
  content: string;
  /** Priority for ordering (default: normal) */
  priority: ContextPriority;
  /** Timestamp when registered */
  timestamp: number;
  /** Optional metadata for debugging/logging */
  metadata?: Record<string, unknown>;
}

/**
 * Options for registering context.
 */
export interface RegisterContextOptions {
  /** Unique ID for this context entry (used for deduplication) */
  id: string;
  /** Source identifier */
  source: ContextSourceType;
  /** The content to inject */
  content: string;
  /** Priority for ordering (default: normal) */
  priority?: ContextPriority;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Result of getting pending context for a session.
 */
export interface PendingContext {
  /** Merged context string, ready for injection */
  merged: string;
  /** Individual entries that were merged */
  entries: ContextEntry[];
  /** Whether there's any content to inject */
  hasContent: boolean;
}

/**
 * Message context from the original user message.
 * Used when injecting to match the message format.
 */
export interface MessageContext {
  sessionId?: string;
  agent?: string;
  model?: {
    providerId?: string;
    modelId?: string;
  };
  path?: {
    cwd?: string;
    root?: string;
  };
  tools?: Record<string, boolean>;
}

/**
 * Output parts from hook processing.
 */
export interface OutputPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/**
 * Injection strategy for context.
 */
export type InjectionStrategy = 'prepend' | 'append' | 'wrap';

/**
 * Result of an injection operation.
 */
export interface InjectionResult {
  /** Whether injection occurred */
  injected: boolean;
  /** Length of injected context */
  contextLength: number;
  /** Number of entries injected */
  entryCount: number;
}
