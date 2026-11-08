import { describe, it, expect } from 'vitest';
import { isRateLimitStop, isScheduledWakeupStop } from '../index.js';
describe('isRateLimitStop (fix #777 - ralph infinite retry loop)', () => {
    it('should return false for undefined context', () => {
        expect(isRateLimitStop()).toBe(false);
    });
    it('should return false for empty context', () => {
        expect(isRateLimitStop({})).toBe(false);
    });
    it('should return false for empty stop_reason', () => {
        expect(isRateLimitStop({ stop_reason: '' })).toBe(false);
    });
    // Core rate-limit patterns
    it('should return true for "rate_limit" stop reason', () => {
        expect(isRateLimitStop({ stop_reason: 'rate_limit' })).toBe(true);
    });
    it('should return true for "rate_limited" stop reason', () => {
        expect(isRateLimitStop({ stop_reason: 'rate_limited' })).toBe(true);
    });
    it('should return true for "ratelimit" stop reason', () => {
        expect(isRateLimitStop({ stop_reason: 'ratelimit' })).toBe(true);
    });
    it('should return true for "too_many_requests" stop reason', () => {
        expect(isRateLimitStop({ stop_reason: 'too_many_requests' })).toBe(true);
    });
    it('should return true for "429" stop reason', () => {
        expect(isRateLimitStop({ stop_reason: '429' })).toBe(true);
    });
    it('should return true for "quota_exceeded" stop reason', () => {
        expect(isRateLimitStop({ stop_reason: 'quota_exceeded' })).toBe(true);
    });
    it('should return true for "quota_limit" stop reason', () => {
        expect(isRateLimitStop({ stop_reason: 'quota_limit' })).toBe(true);
    });
    it('should return true for "quota_exhausted" stop reason', () => {
        expect(isRateLimitStop({ stop_reason: 'quota_exhausted' })).toBe(true);
    });
    it('should return true for "overloaded" stop reason (Anthropic 529 overloaded_error)', () => {
        expect(isRateLimitStop({ stop_reason: 'overloaded' })).toBe(true);
        expect(isRateLimitStop({ stop_reason: 'overloaded_error' })).toBe(true);
    });
    it('should return true for "capacity" stop reason (provider capacity-exceeded)', () => {
        expect(isRateLimitStop({ stop_reason: 'capacity' })).toBe(true);
        expect(isRateLimitStop({ stop_reason: 'capacity_exceeded' })).toBe(true);
    });
    // Compound patterns with prefixes/suffixes
    it('should return true for "api_rate_limit_exceeded"', () => {
        expect(isRateLimitStop({ stop_reason: 'api_rate_limit_exceeded' })).toBe(true);
    });
    it('should return true for "error_too_many_requests"', () => {
        expect(isRateLimitStop({ stop_reason: 'error_too_many_requests' })).toBe(true);
    });
    // Case insensitivity
    it('should be case insensitive', () => {
        expect(isRateLimitStop({ stop_reason: 'RATE_LIMIT' })).toBe(true);
        expect(isRateLimitStop({ stop_reason: 'Rate_Limited' })).toBe(true);
        expect(isRateLimitStop({ stop_reason: 'TOO_MANY_REQUESTS' })).toBe(true);
    });
    // camelCase field support
    it('should support stopReason camelCase field', () => {
        expect(isRateLimitStop({ stopReason: 'rate_limit' })).toBe(true);
        expect(isRateLimitStop({ stopReason: 'quota_exceeded' })).toBe(true);
    });
    // end_turn_reason field
    it('should check end_turn_reason field', () => {
        expect(isRateLimitStop({ end_turn_reason: 'rate_limit' })).toBe(true);
        expect(isRateLimitStop({ endTurnReason: 'quota_exceeded' })).toBe(true);
    });
    // Should NOT match unrelated stop reasons
    it('should return false for "context_limit"', () => {
        expect(isRateLimitStop({ stop_reason: 'context_limit' })).toBe(false);
    });
    it('should return false for "user_cancel"', () => {
        expect(isRateLimitStop({ stop_reason: 'user_cancel' })).toBe(false);
    });
    it('should return false for "end_turn"', () => {
        expect(isRateLimitStop({ stop_reason: 'end_turn' })).toBe(false);
    });
    it('should return false for "max_tokens"', () => {
        expect(isRateLimitStop({ stop_reason: 'max_tokens' })).toBe(false);
    });
    // Null safety
    it('should handle null stop_reason gracefully', () => {
        const context = { stop_reason: null };
        expect(isRateLimitStop(context)).toBe(false);
    });
});
describe('isScheduledWakeupStop (fix #2693 - scheduled resume should bypass persistent continuation)', () => {
    it('should return false for undefined context', () => {
        expect(isScheduledWakeupStop()).toBe(false);
    });
    it('should detect ScheduleWakeup stop_reason variants', () => {
        expect(isScheduledWakeupStop({ stop_reason: 'ScheduleWakeup' })).toBe(true);
        expect(isScheduledWakeupStop({ stop_reason: 'scheduled_task' })).toBe(true);
        expect(isScheduledWakeupStop({ endTurnReason: 'loop_resume' })).toBe(true);
    });
    it('should detect scheduled wakeup from tool name', () => {
        expect(isScheduledWakeupStop({ tool_name: 'ScheduleWakeup' })).toBe(true);
        expect(isScheduledWakeupStop({ toolName: 'native.schedule_wakeup' })).toBe(true);
    });
    it('should return false for ordinary stop reasons', () => {
        expect(isScheduledWakeupStop({ stop_reason: 'end_turn' })).toBe(false);
        expect(isScheduledWakeupStop({ stop_reason: 'rate_limit' })).toBe(false);
        expect(isScheduledWakeupStop({ tool_name: 'Task' })).toBe(false);
    });
});
//# sourceMappingURL=isRateLimitStop.test.js.map