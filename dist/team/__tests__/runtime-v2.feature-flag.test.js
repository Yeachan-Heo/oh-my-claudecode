import { describe, expect, it } from 'vitest';
import { isRuntimeV2Enabled } from '../runtime-v2.js';
describe('isRuntimeV2Enabled', () => {
    it('defaults to enabled when env var is unset', () => {
        expect(isRuntimeV2Enabled({})).toBe(true);
    });
    it('disables v2 for explicit false-like values', () => {
        expect(isRuntimeV2Enabled({ OMC_RUNTIME_V2: '0' })).toBe(false);
        expect(isRuntimeV2Enabled({ OMC_RUNTIME_V2: 'false' })).toBe(false);
        expect(isRuntimeV2Enabled({ OMC_RUNTIME_V2: 'no' })).toBe(false);
        expect(isRuntimeV2Enabled({ OMC_RUNTIME_V2: 'off' })).toBe(false);
    });
    it('keeps v2 enabled for true-like or unknown values', () => {
        expect(isRuntimeV2Enabled({ OMC_RUNTIME_V2: '1' })).toBe(true);
        expect(isRuntimeV2Enabled({ OMC_RUNTIME_V2: 'true' })).toBe(true);
        expect(isRuntimeV2Enabled({ OMC_RUNTIME_V2: 'yes' })).toBe(true);
        expect(isRuntimeV2Enabled({ OMC_RUNTIME_V2: 'random' })).toBe(true);
    });
});
//# sourceMappingURL=runtime-v2.feature-flag.test.js.map