/**
 * Flow Tracer - Recording helpers for hook, keyword, skill, and mode events
 *
 * Extends the session replay infrastructure with orchestrator-level events
 * for the /trace feature. All functions are best-effort (never throw).
 */
import { appendReplayEvent } from './session-replay.js';
/**
 * Record a hook fire event
 */
export function recordHookFire(directory, sessionId, hookName, hookEvent) {
    appendReplayEvent(directory, sessionId, {
        agent: 'system',
        event: 'hook_fire',
        hook: hookName,
        hook_event: hookEvent,
    });
}
/**
 * Record a hook result event with timing and context info
 */
export function recordHookResult(directory, sessionId, hookName, hookEvent, durationMs, contextInjected, contextLength) {
    appendReplayEvent(directory, sessionId, {
        agent: 'system',
        event: 'hook_result',
        hook: hookName,
        hook_event: hookEvent,
        duration_ms: durationMs,
        context_injected: contextInjected,
        context_length: contextLength,
    });
}
/**
 * Record a keyword detection event
 */
export function recordKeywordDetected(directory, sessionId, keyword) {
    appendReplayEvent(directory, sessionId, {
        agent: 'system',
        event: 'keyword_detected',
        keyword,
    });
}
/**
 * Record a skill activation event
 */
export function recordSkillActivated(directory, sessionId, skillName, source) {
    appendReplayEvent(directory, sessionId, {
        agent: 'system',
        event: 'skill_activated',
        skill_name: skillName,
        skill_source: source,
    });
}
/**
 * Record a skill invocation event (via Skill tool call)
 */
export function recordSkillInvoked(directory, sessionId, skillName) {
    appendReplayEvent(directory, sessionId, {
        agent: 'system',
        event: 'skill_invoked',
        skill_name: skillName,
    });
}
/**
 * Record a mode change event
 */
export function recordModeChange(directory, sessionId, fromMode, toMode) {
    appendReplayEvent(directory, sessionId, {
        agent: 'system',
        event: 'mode_change',
        mode_from: fromMode,
        mode_to: toMode,
    });
}
//# sourceMappingURL=flow-tracer.js.map