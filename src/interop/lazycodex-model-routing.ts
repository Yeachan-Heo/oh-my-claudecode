import { z } from 'zod';

export type LazyCodexClaudeModelFamily = 'haiku' | 'sonnet' | 'opus';
export type LazyCodexClaudeCapabilityClass = 'low-fast' | 'standard' | 'high-policy';
export type LazyCodexClaudeRole =
  | 'explorer'
  | 'worker'
  | 'executor'
  | 'verifier'
  | 'planner'
  | 'reviewer'
  | 'high-risk'
  | 'metis'
  | 'momus';

export type LazyCodexClaudeRuntimeConfig = {
  readonly model: LazyCodexClaudeModelFamily;
};

export type LazyCodexClaudeRoleRoute = {
  readonly role: LazyCodexClaudeRole;
  readonly capabilityClass: LazyCodexClaudeCapabilityClass;
  readonly provider: 'anthropic';
  readonly modelFamily: LazyCodexClaudeModelFamily;
  readonly runtimeConfig: LazyCodexClaudeRuntimeConfig;
};

export type LazyCodexClaudeRoleRoutingError = {
  readonly code: 'MALFORMED_ROLE' | 'UNKNOWN_ROLE';
  readonly message: string;
};

export type LazyCodexClaudeRoleRoutingResult =
  | {
      readonly ok: true;
      readonly route: LazyCodexClaudeRoleRoute;
    }
  | {
      readonly ok: false;
      readonly error: LazyCodexClaudeRoleRoutingError;
    };

const RoleInputSchema = z.string().trim().min(1);

const LAZYCODEX_CLAUDE_ROLE_ROUTES = [
  {
    role: 'explorer',
    capabilityClass: 'low-fast',
    provider: 'anthropic',
    modelFamily: 'haiku',
    runtimeConfig: { model: 'haiku' },
  },
  {
    role: 'worker',
    capabilityClass: 'standard',
    provider: 'anthropic',
    modelFamily: 'sonnet',
    runtimeConfig: { model: 'sonnet' },
  },
  {
    role: 'executor',
    capabilityClass: 'standard',
    provider: 'anthropic',
    modelFamily: 'sonnet',
    runtimeConfig: { model: 'sonnet' },
  },
  {
    role: 'verifier',
    capabilityClass: 'standard',
    provider: 'anthropic',
    modelFamily: 'sonnet',
    runtimeConfig: { model: 'sonnet' },
  },
  {
    role: 'planner',
    capabilityClass: 'high-policy',
    provider: 'anthropic',
    modelFamily: 'opus',
    runtimeConfig: { model: 'opus' },
  },
  {
    role: 'reviewer',
    capabilityClass: 'high-policy',
    provider: 'anthropic',
    modelFamily: 'opus',
    runtimeConfig: { model: 'opus' },
  },
  {
    role: 'high-risk',
    capabilityClass: 'high-policy',
    provider: 'anthropic',
    modelFamily: 'opus',
    runtimeConfig: { model: 'opus' },
  },
  {
    role: 'metis',
    capabilityClass: 'high-policy',
    provider: 'anthropic',
    modelFamily: 'opus',
    runtimeConfig: { model: 'opus' },
  },
  {
    role: 'momus',
    capabilityClass: 'high-policy',
    provider: 'anthropic',
    modelFamily: 'opus',
    runtimeConfig: { model: 'opus' },
  },
] as const satisfies readonly LazyCodexClaudeRoleRoute[];

const LAZYCODEX_ROLE_ALIASES: Readonly<Record<string, LazyCodexClaudeRole>> = {
  explore: 'explorer',
  review: 'reviewer',
  critic: 'reviewer',
};

function normalizeRole(input: string): string {
  return input.trim().toLowerCase();
}

function resolveRoleAlias(role: string): string {
  return LAZYCODEX_ROLE_ALIASES[role] ?? role;
}

function findRoute(role: string): LazyCodexClaudeRoleRoute | undefined {
  return LAZYCODEX_CLAUDE_ROLE_ROUTES.find((route) => route.role === role);
}

export function getLazyCodexClaudeRoleRoutes(): readonly LazyCodexClaudeRoleRoute[] {
  return LAZYCODEX_CLAUDE_ROLE_ROUTES;
}

export function resolveLazyCodexClaudeRoleRoute(input: unknown): LazyCodexClaudeRoleRoutingResult {
  const parsed = RoleInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'MALFORMED_ROLE',
        message: 'LazyCodex role must be a non-empty string',
      },
    };
  }

  const role = resolveRoleAlias(normalizeRole(parsed.data));
  const route = findRoute(role);
  if (!route) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN_ROLE',
        message: `No Claude route is defined for LazyCodex role: ${role}`,
      },
    };
  }

  return {
    ok: true,
    route,
  };
}
