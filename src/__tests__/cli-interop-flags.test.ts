import { describe, expect, it } from 'vitest';
import { readInteropRuntimeFlags, validateInteropRuntimeFlags } from '../cli/interop.js';

describe('cli interop flag validation', () => {
  it('reads defaults', () => {
    const flags = readInteropRuntimeFlags({} as NodeJS.ProcessEnv);
    expect(flags.enabled).toBe(false);
    expect(flags.mode).toBe('off');
    expect(flags.omcInteropToolsEnabled).toBe(false);
    expect(flags.failClosed).toBe(true);
  });

  it('rejects non-off mode when interop is disabled', () => {
    const flags = readInteropRuntimeFlags({
      OMX_OMC_INTEROP_ENABLED: '0',
      OMX_OMC_INTEROP_MODE: 'observe',
      OMC_INTEROP_TOOLS_ENABLED: '0',
    } as NodeJS.ProcessEnv);

    const verdict = validateInteropRuntimeFlags(flags);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('must be "off"');
  });

  it('rejects active mode without interop tools enabled', () => {
    const flags = readInteropRuntimeFlags({
      OMX_OMC_INTEROP_ENABLED: '1',
      OMX_OMC_INTEROP_MODE: 'active',
      OMC_INTEROP_TOOLS_ENABLED: '0',
    } as NodeJS.ProcessEnv);

    const verdict = validateInteropRuntimeFlags(flags);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('OMC_INTEROP_TOOLS_ENABLED=1');
  });

  it('accepts active mode when required flags are enabled', () => {
    const flags = readInteropRuntimeFlags({
      OMX_OMC_INTEROP_ENABLED: '1',
      OMX_OMC_INTEROP_MODE: 'active',
      OMC_INTEROP_TOOLS_ENABLED: '1',
      OMX_OMC_INTEROP_FAIL_CLOSED: '1',
    } as NodeJS.ProcessEnv);

    const verdict = validateInteropRuntimeFlags(flags);
    expect(verdict.ok).toBe(true);
  });
});
