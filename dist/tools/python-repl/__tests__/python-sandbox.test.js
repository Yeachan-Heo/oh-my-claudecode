import { describe, it, expect, afterEach } from 'vitest';
import { isPythonSandboxEnabled, clearSecurityConfigCache } from '../../../lib/security-config.js';
describe('python-repl sandbox env propagation', () => {
    const originalSecurity = process.env.OMC_SECURITY;
    afterEach(() => {
        if (originalSecurity === undefined) {
            delete process.env.OMC_SECURITY;
        }
        else {
            process.env.OMC_SECURITY = originalSecurity;
        }
        clearSecurityConfigCache();
    });
    it('sandbox disabled by default', () => {
        delete process.env.OMC_SECURITY;
        clearSecurityConfigCache();
        expect(isPythonSandboxEnabled()).toBe(false);
    });
    it('sandbox enabled with OMC_SECURITY=strict', () => {
        process.env.OMC_SECURITY = 'strict';
        clearSecurityConfigCache();
        expect(isPythonSandboxEnabled()).toBe(true);
    });
});
//# sourceMappingURL=python-sandbox.test.js.map