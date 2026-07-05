import { describe, expect, it } from 'vitest';
import {
  getLazyCodexClaudeRoleRoutes,
  resolveLazyCodexClaudeRoleRoute,
} from '../lazycodex-model-routing.js';

describe('LazyCodex Claude model-role routing', () => {
  it('routes LazyCodex roles by Claude capability class without provider model IDs', () => {
    const routes = getLazyCodexClaudeRoleRoutes();

    expect(routes.map((route) => [route.role, route.modelFamily])).toEqual([
      ['explorer', 'haiku'],
      ['worker', 'sonnet'],
      ['executor', 'sonnet'],
      ['verifier', 'sonnet'],
      ['planner', 'opus'],
      ['reviewer', 'opus'],
      ['high-risk', 'opus'],
      ['metis', 'opus'],
      ['momus', 'opus'],
    ]);

    expect(routes.every((route) => route.provider === 'anthropic')).toBe(true);
    expect(routes.every((route) => route.runtimeConfig.model === route.modelFamily)).toBe(true);
  });

  it('keeps route output machine-readable and free of Codex runtime fields', () => {
    for (const route of getLazyCodexClaudeRoleRoutes()) {
      expect(route.capabilityClass).toMatch(/^(low-fast|standard|high-policy)$/);
      expect(route.runtimeConfig).toEqual({ model: route.modelFamily });
      expect(Object.keys(route.runtimeConfig)).toEqual(['model']);
    }
  });

  it('parses aliases and rejects unknown roles as data instead of falling back', () => {
    expect(resolveLazyCodexClaudeRoleRoute(' explore ')).toEqual({
      ok: true,
      route: expect.objectContaining({
        role: 'explorer',
        modelFamily: 'haiku',
      }),
    });

    expect(resolveLazyCodexClaudeRoleRoute('unlisted-role')).toEqual({
      ok: false,
      error: {
        code: 'UNKNOWN_ROLE',
        message: 'No Claude route is defined for LazyCodex role: unlisted-role',
      },
    });
  });

  it('rejects malformed role input before role lookup', () => {
    expect(resolveLazyCodexClaudeRoleRoute(42)).toEqual({
      ok: false,
      error: {
        code: 'MALFORMED_ROLE',
        message: 'LazyCodex role must be a non-empty string',
      },
    });

    expect(resolveLazyCodexClaudeRoleRoute('   ')).toEqual({
      ok: false,
      error: {
        code: 'MALFORMED_ROLE',
        message: 'LazyCodex role must be a non-empty string',
      },
    });
  });
});
