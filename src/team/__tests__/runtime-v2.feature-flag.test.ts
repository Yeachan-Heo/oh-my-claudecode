import { describe, expect, it } from 'vitest';
import { isRuntimeV2Enabled } from '../runtime-v2.js';

describe('isRuntimeV2Enabled', () => {
  it('defaults to enabled when env var is unset', () => {
    expect(isRuntimeV2Enabled({} as NodeJS.ProcessEnv)).toBe(true);
  });

  it('disables v2 for explicit false-like values', () => {
    expect(isRuntimeV2Enabled({ OMC_RUNTIME_V2: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isRuntimeV2Enabled({ OMC_RUNTIME_V2: 'false' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isRuntimeV2Enabled({ OMC_RUNTIME_V2: 'no' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isRuntimeV2Enabled({ OMC_RUNTIME_V2: 'off' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('keeps v2 enabled for true-like or unknown values', () => {
    expect(isRuntimeV2Enabled({ OMC_RUNTIME_V2: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isRuntimeV2Enabled({ OMC_RUNTIME_V2: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isRuntimeV2Enabled({ OMC_RUNTIME_V2: 'yes' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isRuntimeV2Enabled({ OMC_RUNTIME_V2: 'random' } as NodeJS.ProcessEnv)).toBe(true);
  });
});
