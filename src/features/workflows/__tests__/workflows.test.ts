import { describe, expect, it } from 'vitest';

import {
  MIN_WORKFLOW_VERSION,
  compareWorkflowVersions,
  detectWorkflowCapability,
  meetsMinimumVersion,
  resolveDefaultTriggerKeyword,
} from '../capability.js';
import {
  WORKFLOWS_DEFAULTS,
  buildWorkflowInvocation,
  countScopeSignals,
  hasNativeWorkflowTrigger,
  resolveWorkflowsConfig,
  shouldRouteToWorkflow,
} from '../routing.js';
import type { WorkflowCapability } from '../types.js';

const noEnv = () => undefined;

const availableCapability: WorkflowCapability = {
  available: true,
  version: '2.2.0',
  meetsMinVersion: true,
  disabledBy: null,
  reason: 'ok',
};

describe('compareWorkflowVersions', () => {
  it('orders versions numerically, not lexically', () => {
    expect(compareWorkflowVersions('2.1.154', '2.1.154')).toBe(0);
    expect(compareWorkflowVersions('2.1.160', '2.1.154')).toBe(1);
    expect(compareWorkflowVersions('2.1.99', '2.1.154')).toBe(-1); // lexical would be wrong
    expect(compareWorkflowVersions('v2.2.0', '2.1.154')).toBe(1); // tolerates leading v
  });
});

describe('meetsMinimumVersion', () => {
  it('requires at least the minimum and rejects unknown', () => {
    expect(meetsMinimumVersion(MIN_WORKFLOW_VERSION)).toBe(true);
    expect(meetsMinimumVersion('2.1.155')).toBe(true);
    expect(meetsMinimumVersion('2.1.100')).toBe(false);
    expect(meetsMinimumVersion(null)).toBe(false);
  });
});

describe('detectWorkflowCapability', () => {
  it('is available on a new-enough version with nothing disabling it', () => {
    const cap = detectWorkflowCapability({ version: '2.1.160', env: noEnv });
    expect(cap.available).toBe(true);
    expect(cap.disabledBy).toBeNull();
  });

  it('reports unavailable + reason for an old version', () => {
    const cap = detectWorkflowCapability({ version: '2.1.100', env: noEnv });
    expect(cap.available).toBe(false);
    expect(cap.disabledBy).toBe('version');
  });

  it('reports unavailable when the env kill-switch is set (truthy variants)', () => {
    for (const value of ['1', 'true', 'YES', 'on']) {
      const cap = detectWorkflowCapability({
        version: '2.2.0',
        env: (n) => (n === 'CLAUDE_CODE_DISABLE_WORKFLOWS' ? value : undefined),
      });
      expect(cap.available).toBe(false);
      expect(cap.disabledBy).toBe('env');
    }
  });

  it('reports unavailable when settings disable workflows', () => {
    const cap = detectWorkflowCapability({ version: '2.2.0', settingsDisabled: true, env: noEnv });
    expect(cap.available).toBe(false);
    expect(cap.disabledBy).toBe('settings');
  });

  it('prioritizes env over settings over version in the disabledBy reason', () => {
    const cap = detectWorkflowCapability({
      version: '2.1.100',
      settingsDisabled: true,
      env: (n) => (n === 'CLAUDE_CODE_DISABLE_WORKFLOWS' ? '1' : undefined),
    });
    expect(cap.disabledBy).toBe('env');
  });

  it('treats unknown version as not meeting the minimum', () => {
    const cap = detectWorkflowCapability({ version: null, env: noEnv });
    expect(cap.available).toBe(false);
    expect(cap.meetsMinVersion).toBe(false);
  });
});

describe('resolveDefaultTriggerKeyword', () => {
  it('uses ultracode at/after the keyword version and workflow before it', () => {
    expect(resolveDefaultTriggerKeyword('2.1.160')).toBe('ultracode');
    expect(resolveDefaultTriggerKeyword('2.2.0')).toBe('ultracode');
    expect(resolveDefaultTriggerKeyword('2.1.154')).toBe('workflow');
    expect(resolveDefaultTriggerKeyword(null)).toBe('workflow');
  });
});

describe('resolveWorkflowsConfig', () => {
  it('defaults to opt-in OFF with conservative gates', () => {
    expect(resolveWorkflowsConfig()).toEqual(WORKFLOWS_DEFAULTS);
    expect(resolveWorkflowsConfig().enabled).toBe(false);
  });

  it('overlays provided fields over defaults', () => {
    const resolved = resolveWorkflowsConfig({ enabled: true, minScopeSignals: 2 });
    expect(resolved.enabled).toBe(true);
    expect(resolved.minScopeSignals).toBe(2);
    expect(resolved.allowInHeadless).toBe(false);
  });
});

describe('countScopeSignals', () => {
  it('counts heavy-scope phrases and ignores fenced code', () => {
    expect(countScopeSignals('fix a typo in the readme')).toBe(0);
    expect(countScopeSignals('audit every endpoint across the whole codebase')).toBeGreaterThanOrEqual(2);
    // signal words that appear only inside code should not count
    expect(countScopeSignals('rename a var\n```\nmigrate() // audit\n```')).toBe(0);
  });
});

describe('hasNativeWorkflowTrigger', () => {
  it('detects ultracode / workflow keywords outside code', () => {
    expect(hasNativeWorkflowTrigger('ultracode: audit the repo')).toBe(true);
    expect(hasNativeWorkflowTrigger('please run a workflow for this')).toBe(true);
    expect(hasNativeWorkflowTrigger('ultrawork the auth module')).toBe(false); // OMC keyword, not native
    expect(hasNativeWorkflowTrigger('`workflow`')).toBe(false); // inside inline code
  });
});

describe('buildWorkflowInvocation', () => {
  it('produces a version-proof natural-language request by default', () => {
    const inv = buildWorkflowInvocation('audit every endpoint', resolveWorkflowsConfig({ enabled: true }));
    expect(inv).toContain('dynamic workflow');
    expect(inv).toContain('audit every endpoint');
    expect(inv.startsWith('ultracode:')).toBe(false);
  });

  it('prefixes a configured trigger keyword when set', () => {
    const inv = buildWorkflowInvocation(
      'audit every endpoint',
      resolveWorkflowsConfig({ enabled: true, triggerKeyword: 'ultracode' }),
    );
    expect(inv.startsWith('ultracode:')).toBe(true);
  });
});

describe('shouldRouteToWorkflow', () => {
  const heavyTask = 'migrate every controller across the whole codebase to the new API';

  it('does not route when the feature is opted out (default)', () => {
    const decision = shouldRouteToWorkflow({
      task: heavyTask,
      config: resolveWorkflowsConfig(),
      capability: availableCapability,
    });
    expect(decision.route).toBe(false);
    expect(decision.fallback).toBe('omc-orchestration');
  });

  it('does not route when capability is unavailable, even if enabled', () => {
    const decision = shouldRouteToWorkflow({
      task: heavyTask,
      config: resolveWorkflowsConfig({ enabled: true }),
      capability: { ...availableCapability, available: false, reason: 'too old', disabledBy: 'version' },
    });
    expect(decision.route).toBe(false);
    expect(decision.reason).toContain('unavailable');
  });

  it('does not route on a non-Claude provider lane', () => {
    const decision = shouldRouteToWorkflow({
      task: heavyTask,
      config: resolveWorkflowsConfig({ enabled: true }),
      capability: availableCapability,
      providerLane: 'codex',
    });
    expect(decision.route).toBe(false);
    expect(decision.reason).toContain('Claude-only');
  });

  it('refuses to nest inside an active fan-out mode unless allowNesting', () => {
    const base = {
      task: heavyTask,
      capability: availableCapability,
      activeModes: ['ultrawork'],
    };
    expect(
      shouldRouteToWorkflow({ ...base, config: resolveWorkflowsConfig({ enabled: true }) }).route,
    ).toBe(false);
    expect(
      shouldRouteToWorkflow({
        ...base,
        config: resolveWorkflowsConfig({ enabled: true, allowNesting: true }),
      }).route,
    ).toBe(true);
  });

  it('blocks headless runs unless allowInHeadless is set', () => {
    const base = {
      task: heavyTask,
      capability: availableCapability,
      headless: true,
    };
    expect(
      shouldRouteToWorkflow({ ...base, config: resolveWorkflowsConfig({ enabled: true }) }).route,
    ).toBe(false);
    expect(
      shouldRouteToWorkflow({
        ...base,
        config: resolveWorkflowsConfig({ enabled: true, allowInHeadless: true }),
      }).route,
    ).toBe(true);
  });

  it('keeps OMC orchestration for low-scope tasks', () => {
    const decision = shouldRouteToWorkflow({
      task: 'fix a typo in the README',
      config: resolveWorkflowsConfig({ enabled: true }),
      capability: availableCapability,
    });
    expect(decision.route).toBe(false);
    expect(decision.reason).toContain('below threshold');
  });

  it('routes a heavy Claude-lane task when enabled, available, and not nested', () => {
    const decision = shouldRouteToWorkflow({
      task: heavyTask,
      config: resolveWorkflowsConfig({ enabled: true }),
      capability: availableCapability,
    });
    expect(decision.route).toBe(true);
    expect(decision.invocation).toBeDefined();
    expect(decision.invocation).toContain('dynamic workflow');
  });

  it('respects a higher minScopeSignals threshold', () => {
    const decision = shouldRouteToWorkflow({
      task: 'audit the service', // a single signal
      config: resolveWorkflowsConfig({ enabled: true, minScopeSignals: 3 }),
      capability: availableCapability,
    });
    expect(decision.route).toBe(false);
  });
});
