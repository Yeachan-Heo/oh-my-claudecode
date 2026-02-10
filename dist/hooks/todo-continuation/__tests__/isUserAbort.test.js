import { describe, it, expect } from 'vitest';
import { isUserAbort } from '../index.js';
describe('isUserAbort', () => {
    it('should return false for undefined context', () => {
        expect(isUserAbort()).toBe(false);
    });
    it('should return true for user_requested flag', () => {
        expect(isUserAbort({ user_requested: true })).toBe(true);
    });
    it('should return true for userRequested flag', () => {
        expect(isUserAbort({ userRequested: true })).toBe(true);
    });
    // Exact match patterns (should match when these strings appear anywhere)
    it('should return true for exact "cancel" stop reason', () => {
        expect(isUserAbort({ stop_reason: 'cancel' })).toBe(true);
    });
    it('should return true for exact "abort" stop reason', () => {
        expect(isUserAbort({ stop_reason: 'abort' })).toBe(true);
    });
    it('should return true for exact "aborted" stop reason', () => {
        expect(isUserAbort({ stop_reason: 'aborted' })).toBe(true);
    });
    it('should return true for exact "interrupt" stop reason', () => {
        expect(isUserAbort({ stop_reason: 'interrupt' })).toBe(true);
    });
    // Compound substring patterns (user_cancel, ctrl_c, manual_stop should still match)
    it('should return true for "user_cancel" stop reason', () => {
        expect(isUserAbort({ stop_reason: 'user_cancel' })).toBe(true);
    });
    it('should return true for "ctrl_c" stop reason', () => {
        expect(isUserAbort({ stop_reason: 'ctrl_c' })).toBe(true);
    });
    it('should return true for "manual_stop" stop reason', () => {
        expect(isUserAbort({ stop_reason: 'manual_stop' })).toBe(true);
    });
    it('should return true for "user_interrupt" stop reason', () => {
        expect(isUserAbort({ stop_reason: 'user_interrupt' })).toBe(true);
    });
    // FALSE POSITIVES THAT SHOULD NOW BE FIXED
    // These contain "cancel" or "interrupt" but are NOT user aborts
    it('should return false for "cancelled_operation" (no longer substring-matches)', () => {
        expect(isUserAbort({ stop_reason: 'cancelled_operation' })).toBe(false);
    });
    it('should return false for "interrupted_by_system" (no longer substring-matches)', () => {
        expect(isUserAbort({ stop_reason: 'interrupted_by_system' })).toBe(false);
    });
    it('should return false for "context_limit"', () => {
        expect(isUserAbort({ stop_reason: 'context_limit' })).toBe(false);
    });
    it('should return false for "operation_cancelled_by_timeout"', () => {
        expect(isUserAbort({ stop_reason: 'operation_cancelled_by_timeout' })).toBe(false);
    });
    it('should return false for "auto_interrupt"', () => {
        expect(isUserAbort({ stop_reason: 'auto_interrupt' })).toBe(false);
    });
    it('should return false for empty stop reason', () => {
        expect(isUserAbort({ stop_reason: '' })).toBe(false);
    });
    it('should return false for empty context object', () => {
        expect(isUserAbort({})).toBe(false);
    });
    // Test camelCase variant
    it('should support stopReason camelCase field', () => {
        expect(isUserAbort({ stopReason: 'cancel' })).toBe(true);
        expect(isUserAbort({ stopReason: 'user_cancel' })).toBe(true);
        expect(isUserAbort({ stopReason: 'context_limit' })).toBe(false);
    });
    // Test case insensitivity
    it('should be case insensitive for stop_reason', () => {
        expect(isUserAbort({ stop_reason: 'CANCEL' })).toBe(true);
        expect(isUserAbort({ stop_reason: 'Cancel' })).toBe(true);
        expect(isUserAbort({ stop_reason: 'USER_CANCEL' })).toBe(true);
    });
    // Edge cases
    it('should handle null stop_reason', () => {
        const context = { stop_reason: null };
        expect(isUserAbort(context)).toBe(false);
    });
    it('should prioritize explicit flags over stop_reason', () => {
        expect(isUserAbort({
            user_requested: true,
            stop_reason: 'context_limit'
        })).toBe(true);
    });
    // Test that exact patterns only match exactly (issue #210 fix)
    it('should match "abort" only as exact match', () => {
        expect(isUserAbort({ stop_reason: 'abort' })).toBe(true);
        // These should NOT match anymore - exact match only for short words
        expect(isUserAbort({ stop_reason: 'user_abort' })).toBe(false);
        expect(isUserAbort({ stop_reason: 'abort_by_user' })).toBe(false);
    });
    it('should match "cancel" only as exact match', () => {
        expect(isUserAbort({ stop_reason: 'cancel' })).toBe(true);
        // user_cancel matches via substring patterns (compound word)
        expect(isUserAbort({ stop_reason: 'user_cancel' })).toBe(true);
        // cancel_requested should NOT match - not in compound patterns
        expect(isUserAbort({ stop_reason: 'cancel_requested' })).toBe(false);
    });
    it('should NOT match partial words (issue #210 fix)', () => {
        // Fixed: short generic words now use exact match to prevent false positives
        expect(isUserAbort({ stop_reason: 'cancellation' })).toBe(false);
        expect(isUserAbort({ stop_reason: 'interruption' })).toBe(false);
    });
    // Combined field test - snake_case is checked first, then camelCase
    it('should check snake_case first, fallback to camelCase', () => {
        // snake_case has value, so camelCase is not checked
        expect(isUserAbort({
            stop_reason: 'unrelated',
            stopReason: 'cancel'
        })).toBe(false);
    });
    it('should prefer snake_case when both present and valid', () => {
        expect(isUserAbort({
            stop_reason: 'cancel',
            stopReason: 'unrelated'
        })).toBe(true);
    });
});
//# sourceMappingURL=isUserAbort.test.js.map