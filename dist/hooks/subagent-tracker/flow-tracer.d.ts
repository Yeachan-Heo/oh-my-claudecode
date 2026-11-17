/**
 * Flow Tracer - Recording helpers for hook, keyword, skill, and mode events
 *
 * Extends the session replay infrastructure with orchestrator-level events
 * for the /trace feature. All functions are best-effort (never throw).
 */
/**
 * Record a hook fire event
 */
export declare function recordHookFire(directory: string, sessionId: string, hookName: string, hookEvent: string): void;
/**
 * Record a hook result event with timing and context info
 */
export declare function recordHookResult(directory: string, sessionId: string, hookName: string, hookEvent: string, durationMs: number, contextInjected: boolean, contextLength?: number): void;
/**
 * Record a keyword detection event
 */
export declare function recordKeywordDetected(directory: string, sessionId: string, keyword: string): void;
/**
 * Record a skill activation event
 */
export declare function recordSkillActivated(directory: string, sessionId: string, skillName: string, source: string): void;
/**
 * Record a skill invocation event (via Skill tool call)
 */
export declare function recordSkillInvoked(directory: string, sessionId: string, skillName: string): void;
/**
 * Record a mode change event
 */
export declare function recordModeChange(directory: string, sessionId: string, fromMode: string, toMode: string): void;
//# sourceMappingURL=flow-tracer.d.ts.map