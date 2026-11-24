import { describe, it, expect, afterEach } from 'vitest';
import { resolveSessionId } from '../session-id.js';
const ORIGINAL_ENV = process.env.OMC_SESSION_ID;
afterEach(() => {
    if (ORIGINAL_ENV === undefined)
        delete process.env.OMC_SESSION_ID;
    else
        process.env.OMC_SESSION_ID = ORIGINAL_ENV;
});
describe('resolveSessionId', () => {
    describe('context = cli', () => {
        it('returns env when only env is set', () => {
            process.env.OMC_SESSION_ID = 'env-sid';
            expect(resolveSessionId({ context: 'cli' })).toBe('env-sid');
        });
        it('returns payload when only payload is set', () => {
            delete process.env.OMC_SESSION_ID;
            expect(resolveSessionId({ context: 'cli', hookPayload: { session_id: 'payload-sid' } })).toBe('payload-sid');
        });
        it('env WINS over payload in CLI context (intentional asymmetry)', () => {
            process.env.OMC_SESSION_ID = 'env-sid';
            expect(resolveSessionId({ context: 'cli', hookPayload: { session_id: 'payload-sid' } })).toBe('env-sid');
        });
        it('returns undefined when neither source provides a value', () => {
            delete process.env.OMC_SESSION_ID;
            expect(resolveSessionId({ context: 'cli' })).toBeUndefined();
        });
    });
    describe('context = hook', () => {
        it('returns payload when only payload is set', () => {
            delete process.env.OMC_SESSION_ID;
            expect(resolveSessionId({ context: 'hook', hookPayload: { session_id: 'payload-sid' } })).toBe('payload-sid');
        });
        it('returns env when only env is set', () => {
            process.env.OMC_SESSION_ID = 'env-sid';
            expect(resolveSessionId({ context: 'hook' })).toBe('env-sid');
        });
        it('payload WINS over env in hook context (intentional asymmetry)', () => {
            process.env.OMC_SESSION_ID = 'env-sid';
            expect(resolveSessionId({ context: 'hook', hookPayload: { session_id: 'payload-sid' } })).toBe('payload-sid');
        });
        it('returns undefined when neither source provides a value', () => {
            delete process.env.OMC_SESSION_ID;
            expect(resolveSessionId({ context: 'hook' })).toBeUndefined();
        });
    });
    describe('input normalization', () => {
        it('ignores empty-string env', () => {
            process.env.OMC_SESSION_ID = '   ';
            expect(resolveSessionId({ context: 'cli', hookPayload: { session_id: 'payload-sid' } })).toBe('payload-sid');
        });
        it('ignores empty-string payload', () => {
            delete process.env.OMC_SESSION_ID;
            expect(resolveSessionId({ context: 'hook', hookPayload: { session_id: '' } })).toBeUndefined();
        });
        it('ignores null payload', () => {
            delete process.env.OMC_SESSION_ID;
            expect(resolveSessionId({ context: 'hook', hookPayload: null })).toBeUndefined();
        });
        it('trims whitespace from values', () => {
            process.env.OMC_SESSION_ID = '  env-sid  ';
            expect(resolveSessionId({ context: 'cli' })).toBe('env-sid');
        });
    });
});
//# sourceMappingURL=session-id.test.js.map