import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  HOOK_EVENTS,
  buildHookRegistry,
  validateRegistryAgainstHooksJson,
  selectApplicableEntries,
  parseEntrypointCommand,
  type HooksJson,
} from '../index.js';
import { failModeForRisk, HARD_RISK_CLASSES } from '../../../workflow/registry.js';

function loadInstalledHooksJson(): HooksJson {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), 'hooks', 'hooks.json'), 'utf-8'),
  ) as { hooks: HooksJson };
  return raw.hooks;
}

describe('hook registry — derivation from installed hooks.json (#3707)', () => {
  const hooksJson = loadInstalledHooksJson();
  const registry = buildHookRegistry(hooksJson);

  it('covers every installed command exactly once, in declared order', () => {
    let installedCount = 0;
    for (const [event, groups] of Object.entries(hooksJson)) {
      for (const group of groups) {
        group.hooks.forEach((_, order) => {
          installedCount += 1;
          const matches = registry.filter(
            (e) =>
              e.event === event && e.matcher === group.matcher && e.order === order,
          );
          expect(matches).toHaveLength(1);
        });
      }
    }
    expect(registry.length).toBe(installedCount);
    expect(installedCount).toBeGreaterThan(0);
  });

  it('declares contract fields for every entry (event/order/timeout/risk/fail-mode)', () => {
    for (const entry of registry) {
      expect(HOOK_EVENTS).toContain(entry.event);
      expect(entry.order).toBeGreaterThanOrEqual(0);
      expect(entry.timeoutMs).toBeGreaterThan(0);
      expect(entry.riskClass).toBeTruthy();
      expect(entry.failMode).toBe(failModeForRisk(entry.riskClass));
    }
  });

  it('fails closed only for the five hard risk classes (owner decision 6)', () => {
    for (const entry of registry) {
      if (HARD_RISK_CLASSES.includes(entry.riskClass)) {
        expect(entry.failMode).toBe('fail-closed');
      } else {
        expect(entry.riskClass).toBe('advisory');
        expect(entry.failMode).toBe('fail-open');
      }
    }
    // The installed registration genuinely exercises both fail modes.
    expect(registry.some((e) => e.failMode === 'fail-closed')).toBe(true);
    expect(registry.some((e) => e.failMode === 'fail-open')).toBe(true);
  });

  it('derives risk class by convention: only pre-tool-enforcer and permission-handler fail closed', () => {
    const failClosed = registry.filter((e) => e.failMode === 'fail-closed');
    const failClosedEntrypoints = new Set(failClosed.map((e) => e.entrypoint));
    expect(failClosedEntrypoints).toEqual(
      new Set(['pre-tool-enforcer.mjs', 'permission-handler.mjs']),
    );
  });

  it('mirrors installed timeouts (seconds → ms)', () => {
    for (const [event, groups] of Object.entries(hooksJson)) {
      for (const group of groups) {
        group.hooks.forEach((hook, order) => {
          const entry = registry.find(
            (e) =>
              e.event === event && e.matcher === group.matcher && e.order === order,
          );
          expect(entry?.timeoutMs).toBe((hook.timeout ?? 0) * 1000);
        });
      }
    }
  });

  it('mirrors the installed async flag', () => {
    const sessionEnd = registry.filter((e) => e.event === 'SessionEnd');
    expect(sessionEnd.length).toBeGreaterThan(0);
    for (const entry of sessionEnd) expect(entry.async).toBe(true);
    const stop = registry.filter((e) => e.event === 'Stop');
    for (const entry of stop) expect(entry.async).toBe(false);
  });
});

describe('hook registry — registration drift guard (#3707)', () => {
  it('reports zero drift against the installed hooks.json', () => {
    expect(validateRegistryAgainstHooksJson(loadInstalledHooksJson())).toEqual([]);
  });

  it('detects unparseable commands', () => {
    const hooksJson = loadInstalledHooksJson();
    const tampered: HooksJson = {
      ...hooksJson,
      Stop: [
        ...(hooksJson.Stop ?? []),
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: 'echo nothing useful',
              timeout: 5,
            },
          ],
        },
      ],
    };
    const issues = validateRegistryAgainstHooksJson(tampered);
    expect(issues.some((i) => i.code === 'unparseable-command')).toBe(true);
  });

  it('detects unknown lifecycle events', () => {
    const issues = validateRegistryAgainstHooksJson({
      MadeUpEvent: [{ matcher: '*', hooks: [] }],
    } as unknown as HooksJson);
    expect(issues.some((i) => i.code === 'unknown-event')).toBe(true);
  });

  it('detects missing timeouts', () => {
    const hooksJson = loadInstalledHooksJson();
    const firstEvent = Object.keys(hooksJson)[0];
    const firstGroup = hooksJson[firstEvent][0];
    const tampered: HooksJson = {
      ...hooksJson,
      [firstEvent]: [
        {
          ...firstGroup,
          hooks: [
            {
              ...firstGroup.hooks[0],
              timeout: 0,
            },
          ],
        },
      ],
    };
    const issues = validateRegistryAgainstHooksJson(tampered);
    expect(issues.some((i) => i.code === 'timeout-mismatch')).toBe(true);
  });
});

describe('hook registry — selection and ordering', () => {
  const registry = buildHookRegistry(loadInstalledHooksJson());

  it('parses installed commands into entrypoint + args', () => {
    expect(
      parseEntrypointCommand(
        'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/subagent-tracker.mjs start',
      ),
    ).toEqual({ entrypoint: 'subagent-tracker.mjs', args: ['start'] });
    expect(parseEntrypointCommand('echo nothing')).toBeNull();
  });

  it('selects applicable entries in execution order, honoring matchers', () => {
    const sessionStartAll = selectApplicableEntries(registry, 'SessionStart', undefined);
    expect(sessionStartAll.map((e) => e.entrypoint)).toEqual([
      'session-start.mjs',
      'project-memory-session.mjs',
      'wiki-session-start.mjs',
    ]);
    const sessionStartInit = selectApplicableEntries(registry, 'SessionStart', 'init');
    expect(sessionStartInit.some((e) => e.entrypoint === 'setup-init.mjs')).toBe(true);
    expect(sessionStartInit.some((e) => e.entrypoint === 'setup-maintenance.mjs')).toBe(false);
    const bashPermission = selectApplicableEntries(registry, 'PermissionRequest', 'Bash');
    expect(bashPermission.map((e) => e.entrypoint)).toEqual(['permission-handler.mjs']);
    expect(selectApplicableEntries(registry, 'PermissionRequest', 'Edit')).toEqual([]);
  });
});
