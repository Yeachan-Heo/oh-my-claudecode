/**
 * Directive Detector
 * Detects and extracts user directives from messages and tool outputs
 */
import { UserDirective } from './types.js';
/**
 * Detect directives from user message
 */
export declare function detectDirectivesFromMessage(message: string): UserDirective[];
/**
 * Infer directives from repeated patterns
 */
export declare function inferDirectiveFromPattern(commandHistory: string[], threshold?: number): UserDirective | null;
/**
 * Add directive if not duplicate
 */
export declare function addDirective(directives: UserDirective[], newDirective: UserDirective): UserDirective[];
/**
 * Format directives for context injection
 */
export declare function formatDirectivesForContext(directives: UserDirective[]): string;
//# sourceMappingURL=directive-detector.d.ts.map