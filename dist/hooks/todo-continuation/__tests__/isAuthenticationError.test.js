import { describe, it, expect } from 'vitest';
import { AUTHENTICATION_ERROR_PATTERNS, isAuthenticationError } from '../index.js';
describe('isAuthenticationError (fix #1308 - OAuth expiry loop)', () => {
    it('keeps exactly 16 auth error patterns', () => {
        expect(AUTHENTICATION_ERROR_PATTERNS).toHaveLength(16);
    });
    it('returns false for undefined/empty context', () => {
        expect(isAuthenticationError()).toBe(false);
        expect(isAuthenticationError({})).toBe(false);
    });
    it.each(AUTHENTICATION_ERROR_PATTERNS)('returns true for stop_reason pattern "%s"', (pattern) => {
        expect(isAuthenticationError({ stop_reason: pattern })).toBe(true);
        expect(isAuthenticationError({ stop_reason: `error_${pattern}_detected` })).toBe(true);
    });
    it('checks end_turn_reason variants', () => {
        expect(isAuthenticationError({ end_turn_reason: 'oauth_expired' })).toBe(true);
        expect(isAuthenticationError({ endTurnReason: 'token_expired' })).toBe(true);
    });
    it('is case insensitive', () => {
        expect(isAuthenticationError({ stop_reason: 'UNAUTHORIZED' })).toBe(true);
        expect(isAuthenticationError({ stopReason: 'AUTHENTICATION_ERROR' })).toBe(true);
    });
    it('returns false for unrelated reasons', () => {
        expect(isAuthenticationError({ stop_reason: 'rate_limit' })).toBe(false);
        expect(isAuthenticationError({ stop_reason: 'context_limit' })).toBe(false);
        expect(isAuthenticationError({ stop_reason: 'end_turn' })).toBe(false);
    });
    it('handles null values safely', () => {
        const context = { stop_reason: null };
        expect(isAuthenticationError(context)).toBe(false);
    });
});
//# sourceMappingURL=isAuthenticationError.test.js.map