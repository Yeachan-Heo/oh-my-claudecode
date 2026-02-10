/**
 * Context Injector Module
 *
 * System for collecting and injecting context from multiple sources
 * into user prompts. Supports priority ordering and deduplication.
 *
 * Ported from oh-my-opencode's context-injector.
 */
export { ContextCollector, contextCollector } from './collector.js';
export { injectPendingContext, injectContextIntoText, createContextInjectorHook, } from './injector.js';
export type { ContextSourceType, ContextPriority, ContextEntry, RegisterContextOptions, PendingContext, MessageContext, OutputPart, InjectionStrategy, InjectionResult, } from './types.js';
//# sourceMappingURL=index.d.ts.map