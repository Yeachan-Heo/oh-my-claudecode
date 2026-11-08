import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isDebugEnabled } from '../debug-flag.js';

const ORIGINAL = process.env.OMC_DEBUG;

describe('isDebugEnabled', () => {
  beforeEach(() => { delete process.env.OMC_DEBUG; });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.OMC_DEBUG;
    else process.env.OMC_DEBUG = ORIGINAL;
  });

  it('is off when unset', () => {
    expect(isDebugEnabled()).toBe(false);
    expect(isDebugEnabled('learner')).toBe(false);
  });

  it.each(['', '0', 'false', 'FALSE', '  ', ' 0 '])('treats %s as off', (value) => {
    process.env.OMC_DEBUG = value;
    expect(isDebugEnabled()).toBe(false);
    expect(isDebugEnabled('learner')).toBe(false);
  });

  it.each(['1', 'true', 'TRUE', 'True', ' 1 '])('treats %s as on for every scope', (value) => {
    process.env.OMC_DEBUG = value;
    expect(isDebugEnabled()).toBe(true);
    expect(isDebugEnabled('learner')).toBe(true);
    expect(isDebugEnabled('delegation-enforcer')).toBe(true);
  });

  it('enables only the named scope from a list', () => {
    process.env.OMC_DEBUG = 'learner';
    expect(isDebugEnabled('learner')).toBe(true);
    expect(isDebugEnabled('delegation-enforcer')).toBe(false);
    expect(isDebugEnabled()).toBe(false);
  });

  it('accepts a comma-separated scope list with surrounding spaces', () => {
    process.env.OMC_DEBUG = ' learner , delegation-enforcer ';
    expect(isDebugEnabled('learner')).toBe(true);
    expect(isDebugEnabled('delegation-enforcer')).toBe(true);
    expect(isDebugEnabled('todo-continuation')).toBe(false);
  });

  it('does not match a scope by prefix', () => {
    process.env.OMC_DEBUG = 'learner-extra';
    expect(isDebugEnabled('learner')).toBe(false);
  });
});
