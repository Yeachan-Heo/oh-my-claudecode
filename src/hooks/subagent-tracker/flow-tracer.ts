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
export function recordHookFire(
  directory: string,
  sessionId: string,
  hookName: string,
  hookEvent: string
): void {
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
export function recordHookResult(
  directory: string,
  sessionId: string,
  hookName: string,
  hookEvent: string,
  durationMs: number,
  contextInjected: boolean,
  contextLength?: number
): void {
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
export function recordKeywordDetected(
  directory: string,
  sessionId: string,
  keyword: string
): void {
  appendReplayEvent(directory, sessionId, {
    agent: 'system',
    event: 'keyword_detected',
    keyword,
  });
}

/**
 * Record a skill activation event
 */
export function recordSkillActivated(
  directory: string,
  sessionId: string,
  skillName: string,
  source: string
): void {
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
export function recordSkillInvoked(
  directory: string,
  sessionId: string,
  skillName: string
): void {
  appendReplayEvent(directory, sessionId, {
    agent: 'system',
    event: 'skill_invoked',
    skill_name: skillName,
  });
}

/**
 * Record a mode change event
 */
export function recordModeChange(
  directory: string,
  sessionId: string,
  fromMode: string,
  toMode: string
): void {
  appendReplayEvent(directory, sessionId, {
    agent: 'system',
    event: 'mode_change',
    mode_from: fromMode,
    mode_to: toMode,
  });
}
