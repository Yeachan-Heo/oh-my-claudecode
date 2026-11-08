import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  resolveLifecycleProfile,
  isLinkedRalphProfile,
} from '../governance.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveLifecycleProfile', () => {
  it('returns "default" when neither config nor manifest is provided', () => {
    expect(resolveLifecycleProfile()).toBe('default');
  });

  it('returns "default" when both are null', () => {
    expect(resolveLifecycleProfile(null, null)).toBe('default');
  });

  it('returns config profile when only config is provided', () => {
    expect(resolveLifecycleProfile({ lifecycle_profile: 'linked_ralph' })).toBe('linked_ralph');
  });

  it('returns manifest profile when only manifest is provided', () => {
    expect(resolveLifecycleProfile(undefined, { lifecycle_profile: 'linked_ralph' })).toBe('linked_ralph');
  });

  it('manifest takes precedence over config', () => {
    expect(resolveLifecycleProfile(
      { lifecycle_profile: 'default' },
      { lifecycle_profile: 'linked_ralph' },
    )).toBe('linked_ralph');
  });

  it('falls back to config when manifest has no lifecycle_profile', () => {
    expect(resolveLifecycleProfile(
      { lifecycle_profile: 'linked_ralph' },
      { lifecycle_profile: undefined },
    )).toBe('linked_ralph');
  });

  it('returns "default" when both have undefined lifecycle_profile', () => {
    expect(resolveLifecycleProfile(
      { lifecycle_profile: undefined },
      { lifecycle_profile: undefined },
    )).toBe('default');
  });
});

describe('isLinkedRalphProfile', () => {
  it('returns false when neither config nor manifest provided', () => {
    expect(isLinkedRalphProfile()).toBe(false);
  });

  it('returns true when config has linked_ralph', () => {
    expect(isLinkedRalphProfile({ lifecycle_profile: 'linked_ralph' })).toBe(true);
  });

  it('returns false when config has default', () => {
    expect(isLinkedRalphProfile({ lifecycle_profile: 'default' })).toBe(false);
  });

  it('returns true when manifest has linked_ralph (overrides config default)', () => {
    expect(isLinkedRalphProfile(
      { lifecycle_profile: 'default' },
      { lifecycle_profile: 'linked_ralph' },
    )).toBe(true);
  });

  it('returns false when manifest has default (overrides config linked_ralph)', () => {
    expect(isLinkedRalphProfile(
      { lifecycle_profile: 'linked_ralph' },
      { lifecycle_profile: 'default' },
    )).toBe(false);
  });
});
