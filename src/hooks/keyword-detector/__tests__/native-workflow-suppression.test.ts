import { describe, expect, it } from 'vitest';

import { getAllKeywords } from '../index.js';

describe('native workflow trigger suppresses OMC fan-out keywords', () => {
  it('keeps ultrawork when there is no native workflow trigger', () => {
    expect(getAllKeywords('ultrawork fix all the errors')).toContain('ultrawork');
  });

  it('suppresses auto-detected ultrawork when a native "workflow" trigger is present', () => {
    const keywords = getAllKeywords('ultrawork fix all the errors, use a workflow');
    expect(keywords).not.toContain('ultrawork');
  });

  it('suppresses auto-detected ultrawork when the "ultracode" trigger is present', () => {
    const keywords = getAllKeywords('ultrawork the refactor with ultracode');
    expect(keywords).not.toContain('ultrawork');
  });

  it('preserves an explicit /ultrawork slash invocation even with a native trigger', () => {
    const keywords = getAllKeywords('/oh-my-claudecode:ultrawork do it, maybe a workflow too');
    expect(keywords).toContain('ultrawork');
  });
});
