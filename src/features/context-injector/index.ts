/**
 * Context Injector Module
 *
 * System for collecting and injecting context from multiple sources
 * into user prompts. Supports priority ordering and deduplication.
 *
 * Ported from oh-my-opencode's context-injector.
 */

// Collector
export { ContextCollector, contextCollector } from './collector.js';

// Injector functions
export {
  injectPendingContext,
  injectContextIntoText,
  createContextInjectorHook,
} from './injector.js';

// Types
export type {
  ContextSourceType,
  ContextPriority,
  ContextEntry,
  RegisterContextOptions,
  PendingContext,
  MessageContext,
  OutputPart,
  InjectionStrategy,
  InjectionResult,
} from './types.js';
