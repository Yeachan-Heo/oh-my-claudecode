import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createLazyCodexHostEventCompatibilityReport,
  getLazyCodexHostEventCompatibilityMatrix,
  resolveLazyCodexHostEventCompatibility,
} from '../lazycodex-host-events.js';

const LazyCodexPluginSchema = z.object({
  hooks: z.array(z.string()),
});

const OmcHooksRegistrySchema = z.object({
  hooks: z.record(z.array(z.unknown())),
});

const RuntimeForbiddenValues = ['LazyCodex', 'Codex', 'PostCompact'];
const LazyCodexReferencePluginFixture = {
  hooks: [
    './hooks/session-start.json',
    './hooks/user-prompt-submit.json',
    './hooks/pre-tool-use.json',
    './hooks/post-tool-use.json',
    './hooks/post-compact.json',
    './hooks/stop.json',
    './hooks/subagent-stop-verifying-lazycodex-executor-evidence.json',
  ],
};

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function collectStringValues(input: unknown): readonly string[] {
  if (typeof input === 'string') {
    return [input];
  }

  if (Array.isArray(input)) {
    return input.flatMap((value) => collectStringValues(value));
  }

  if (typeof input === 'object' && input !== null) {
    return Object.values(input).flatMap((value) => collectStringValues(value));
  }

  return [];
}

describe('LazyCodex Claude host event compatibility', () => {
  it('publishes runtime records with portable ids and Claude metadata only', () => {
    const matrix = getLazyCodexHostEventCompatibilityMatrix();

    const expectedPortableIds = [
      'session-started',
      'prompt-submitted',
      'tool-use-before',
      'tool-use-after',
      'compact-before',
      'session-stopping',
      'subagent-started',
      'subagent-stopped',
    ];

    expect(matrix.map((entry) => entry.portableEventId)).toEqual(expectedPortableIds);

    for (const entry of matrix) {
      const runtimeStrings = collectStringValues(entry);
      expect(Object.keys(entry)).not.toContain('sourceHostEvent');
      expect(Object.keys(entry)).not.toContain('sourceHookPathMarkers');
      expect(runtimeStrings.some((value) => RuntimeForbiddenValues.some((term) => value.includes(term)))).toBe(false);
      expect(entry.portableEventId).toMatch(/^[a-z-]+$/);
      expect(entry.payloadNormalizationNotes.length).toBeGreaterThan(0);
      expect(entry.decisionSemanticsNotes.length).toBeGreaterThan(0);

      switch (entry.support) {
        case 'supported':
          expect(entry.claudeEvent).toBeDefined();
          break;
        case 'claude-only':
          expect(entry.claudeEvent).toBeDefined();
          break;
        case 'fallback':
          expect(entry.claudeEvent).toBeDefined();
          expect(entry.fallback).toBeDefined();
          break;
        case 'unsupported':
          expect(entry.unsupportedReason).toBeDefined();
          break;
      }
    }
  });

  it('maps LazyCodex PostCompact to Claude PreCompact with explicit fallback notes', () => {
    const result = resolveLazyCodexHostEventCompatibility('compact-before');

    expect(result).toEqual({
      ok: true,
      entry: expect.objectContaining({
        portableEventId: 'compact-before',
        claudeEvent: 'PreCompact',
        support: 'fallback',
        fallback: expect.objectContaining({
          claudeEvent: 'PreCompact',
        }),
      }),
    });
  });

  it('compares LazyCodex plugin hooks and OMC hook registry against the matrix', () => {
    const lazycodexPlugin = LazyCodexPluginSchema.parse(LazyCodexReferencePluginFixture);
    const omcHooks = OmcHooksRegistrySchema.parse(
      readJsonFile(resolve(process.cwd(), 'hooks/hooks.json')),
    );

    const report = createLazyCodexHostEventCompatibilityReport({
      lazycodexHookPaths: lazycodexPlugin.hooks,
      claudeHookEvents: Object.keys(omcHooks.hooks),
    });

    expect(report.missingLazyCodexSources).toEqual([]);
    expect(report.missingClaudeEvents).toEqual([]);
    expect(report.claudeOnlyEvents).toEqual(['subagent-started']);
    expect(report.sourceAbsentEvents).toEqual(['subagent-started']);
    expect(report.entriesWithLazyCodexSourceEvidence).toEqual([
      'session-started',
      'prompt-submitted',
      'tool-use-before',
      'tool-use-after',
      'compact-before',
      'session-stopping',
      'subagent-stopped',
    ]);
    expect(report.sourceEvidence.find((entry) => entry.portableEventId === 'subagent-started')).toBeUndefined();
  });

  it('does not treat subagent-stop hook paths as Stop source evidence', () => {
    const report = createLazyCodexHostEventCompatibilityReport({
      lazycodexHookPaths: ['./hooks/subagent-stop-verifying-lazycodex-executor-evidence.json'],
      claudeHookEvents: ['Stop', 'SubagentStop'],
    });

    expect(report.entriesWithLazyCodexSourceEvidence).toEqual(['subagent-stopped']);
    expect(report.missingLazyCodexSources).toContain('session-stopping');
    expect(report.sourceEvidence.find((entry) => entry.portableEventId === 'session-stopping')).toEqual({
      portableEventId: 'session-stopping',
      matchedHookPaths: [],
    });
    expect(report.sourceEvidence.find((entry) => entry.portableEventId === 'subagent-stopped')).toEqual({
      portableEventId: 'subagent-stopped',
      matchedHookPaths: ['./hooks/subagent-stop-verifying-lazycodex-executor-evidence.json'],
    });
  });

  it('rejects unknown portable ids and malformed input as data', () => {
    expect(resolveLazyCodexHostEventCompatibility('unlisted-event')).toEqual({
      ok: false,
      error: {
        code: 'UNKNOWN_EVENT_ID',
        message: 'No LazyCodex Claude host event compatibility is defined for: unlisted-event',
      },
    });

    expect(resolveLazyCodexHostEventCompatibility(null)).toEqual({
      ok: false,
      error: {
        code: 'MALFORMED_EVENT_ID',
        message: 'LazyCodex portable host event id must be a non-empty string',
      },
    });
  });
});
