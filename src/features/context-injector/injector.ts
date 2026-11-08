/**
 * Context Injector
 *
 * Handles injection of collected context into prompts/messages.
 *
 * Ported from oh-my-opencode's context-injector.
 */

import type { ContextCollector } from './collector.js';
import type { InjectionResult, InjectionStrategy, OutputPart } from './types.js';

/** Default separator between injected context and original content */
const DEFAULT_SEPARATOR = '\n\n---\n\n';

/**
 * Inject pending context into an array of output parts.
 * Finds the first text part and prepends the context to it.
 */
export function injectPendingContext(
  collector: ContextCollector,
  sessionId: string,
  parts: OutputPart[],
  strategy: InjectionStrategy = 'prepend'
): InjectionResult {
  if (!collector.hasPending(sessionId)) {
    return { injected: false, contextLength: 0, entryCount: 0 };
  }

  const textPartIndex = parts.findIndex(
    (p) => p.type === 'text' && p.text !== undefined
  );

  if (textPartIndex === -1) {
    return { injected: false, contextLength: 0, entryCount: 0 };
  }

  const pending = collector.consume(sessionId);
  const originalText = parts[textPartIndex].text ?? '';

  switch (strategy) {
    case 'prepend':
      parts[textPartIndex].text = `${pending.merged}${DEFAULT_SEPARATOR}${originalText}`;
      break;
    case 'append':
      parts[textPartIndex].text = `${originalText}${DEFAULT_SEPARATOR}${pending.merged}`;
      break;
    case 'wrap':
      parts[textPartIndex].text = `<injected-context>\n${pending.merged}\n</injected-context>${DEFAULT_SEPARATOR}${originalText}`;
      break;
  }

  return {
    injected: true,
    contextLength: pending.merged.length,
    entryCount: pending.entries.length,
  };
}

/**
 * Inject pending context into a raw text string.
 */
export function injectContextIntoText(
  collector: ContextCollector,
  sessionId: string,
  text: string,
  strategy: InjectionStrategy = 'prepend'
): { result: string; injectionResult: InjectionResult } {
  if (!collector.hasPending(sessionId)) {
    return {
      result: text,
      injectionResult: { injected: false, contextLength: 0, entryCount: 0 },
    };
  }

  const pending = collector.consume(sessionId);
  let result: string;

  switch (strategy) {
    case 'prepend':
      result = `${pending.merged}${DEFAULT_SEPARATOR}${text}`;
      break;
    case 'append':
      result = `${text}${DEFAULT_SEPARATOR}${pending.merged}`;
      break;
    case 'wrap':
      result = `<injected-context>\n${pending.merged}\n</injected-context>${DEFAULT_SEPARATOR}${text}`;
      break;
  }

  return {
    result,
    injectionResult: {
      injected: true,
      contextLength: pending.merged.length,
      entryCount: pending.entries.length,
    },
  };
}

/**
 * Create a hook handler for context injection.
 * This is a factory function for creating Claude Code compatible hooks.
 */
export function createContextInjectorHook(collector: ContextCollector) {
  return {
    /**
     * Process a user message and inject any pending context.
     */
    processUserMessage: (
      sessionId: string,
      message: string
    ): { message: string; injected: boolean } => {
      if (!collector.hasPending(sessionId)) {
        return { message, injected: false };
      }

      const { result } = injectContextIntoText(collector, sessionId, message, 'prepend');
      return { message: result, injected: true };
    },

    /**
     * Register context for injection into the next message.
     */
    registerContext: collector.register.bind(collector),

    /**
     * Check if there's pending context.
     */
    hasPending: collector.hasPending.bind(collector),

    /**
     * Clear pending context without injecting.
     */
    clear: collector.clear.bind(collector),
  };
}
