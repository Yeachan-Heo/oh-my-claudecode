import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isDebugEnabled as isDebugEnabledDirect } from '../debug-flag.js';

const ORIGINAL_ENV = process.env;

/**
 * Both call sites used to compare OMC_DEBUG against a single literal -- 'true' in the
 * delegation enforcer and '1' in the learner -- so neither documented value enabled
 * both. They now share isDebugEnabled, so both spellings reach both sites.
 */
describe('OMC_DEBUG reaches every call site for both spellings', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.OMC_DEBUG;
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.resetModules();
  });

  it.each(['1', 'true'])('learner DEBUG_ENABLED is true for OMC_DEBUG=%s', async (value) => {
    process.env.OMC_DEBUG = value;
    const { DEBUG_ENABLED } = await import('../../hooks/learner/constants.js');
    expect(DEBUG_ENABLED).toBe(true);
  });

  it('learner DEBUG_ENABLED honours its own scope', async () => {
    process.env.OMC_DEBUG = 'learner';
    const { DEBUG_ENABLED } = await import('../../hooks/learner/constants.js');
    expect(DEBUG_ENABLED).toBe(true);
  });

  it.each(['0', 'false', ''])('learner DEBUG_ENABLED is false for OMC_DEBUG=%s', async (value) => {
    process.env.OMC_DEBUG = value;
    const { DEBUG_ENABLED } = await import('../../hooks/learner/constants.js');
    expect(DEBUG_ENABLED).toBe(false);
  });

  it('todo-continuation reads the flag through the shared helper', async () => {
    // It previously compared the whole env string against 'todo-continuation', so a
    // comma-separated list such as 'learner,todo-continuation' left it disabled --
    // contradicting the convention this helper introduces.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/hooks/todo-continuation/index.ts', 'utf-8');
    expect(source).toContain("isDebugEnabled('todo-continuation')");
    expect(source).not.toMatch(/debug === 'todo-continuation'/);
  });

  it('a comma-separated list enables several named scopes together', () => {
    process.env.OMC_DEBUG = 'learner,todo-continuation';
    expect(isDebugEnabledDirect('learner')).toBe(true);
    expect(isDebugEnabledDirect('todo-continuation')).toBe(true);
    expect(isDebugEnabledDirect('delegation-enforcer')).toBe(false);
  });

  it('the delegation enforcer reads the flag through the shared helper', async () => {
    // enforceModel needs discoverable agent definitions, so assert the wiring: the
    // module must not compare OMC_DEBUG against a literal of its own any more.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/features/delegation-enforcer.ts', 'utf-8');
    expect(source).toContain("isDebugEnabled('delegation-enforcer')");
    expect(source).not.toMatch(/process\.env\.OMC_DEBUG\s*===/);
  });
});
