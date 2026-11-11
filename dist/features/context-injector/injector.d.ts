/**
 * Context Injector
 *
 * Handles injection of collected context into prompts/messages.
 *
 * Ported from oh-my-opencode's context-injector.
 */
import type { ContextCollector } from './collector.js';
import type { InjectionResult, InjectionStrategy, OutputPart } from './types.js';
/**
 * Inject pending context into an array of output parts.
 * Finds the first text part and prepends the context to it.
 */
export declare function injectPendingContext(collector: ContextCollector, sessionId: string, parts: OutputPart[], strategy?: InjectionStrategy): InjectionResult;
/**
 * Inject pending context into a raw text string.
 */
export declare function injectContextIntoText(collector: ContextCollector, sessionId: string, text: string, strategy?: InjectionStrategy): {
    result: string;
    injectionResult: InjectionResult;
};
/**
 * Create a hook handler for context injection.
 * This is a factory function for creating Claude Code compatible hooks.
 */
export declare function createContextInjectorHook(collector: ContextCollector): {
    /**
     * Process a user message and inject any pending context.
     */
    processUserMessage: (sessionId: string, message: string) => {
        message: string;
        injected: boolean;
    };
    /**
     * Register context for injection into the next message.
     */
    registerContext: (sessionId: string, options: import("./types.js").RegisterContextOptions) => void;
    /**
     * Check if there's pending context.
     */
    hasPending: (sessionId: string) => boolean;
    /**
     * Clear pending context without injecting.
     */
    clear: (sessionId: string) => void;
};
//# sourceMappingURL=injector.d.ts.map