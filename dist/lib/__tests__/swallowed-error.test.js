import { describe, expect, it, vi, afterEach } from 'vitest';
import { createSwallowedErrorLogger, formatSwallowedError } from '../swallowed-error.js';
describe('swallowed-error helper', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });
    it('formats Error instances and non-Error values safely', () => {
        expect(formatSwallowedError(new Error('boom'))).toBe('boom');
        expect(formatSwallowedError('plain')).toBe('plain');
        expect(formatSwallowedError({ code: 42 })).toBe('{"code":42}');
    });
    it('logs swallowed failures without throwing', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const log = createSwallowedErrorLogger('test context');
        expect(() => log(new Error('boom'))).not.toThrow();
        expect(warnSpy).toHaveBeenCalledWith('[omc] test context: boom');
    });
});
//# sourceMappingURL=swallowed-error.test.js.map