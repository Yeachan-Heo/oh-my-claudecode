import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { forkJoinDescriptor } from '../../graph/__tests__/fixtures.js';
import { sealGraphDescriptor } from '../../graph/descriptor.js';
import { createInitialGraphState } from '../../graph/runtime-types.js';
import { initializeGraphProjection } from '../../graph/scheduler.js';
import { renderGraph } from '../elements/graph.js';
import {
  getActiveSkills,
  isAnyModeActive,
  readGraphStateForHud,
} from '../omc-state.js';

function graphState(sessionId: string) {
  const descriptor = sealGraphDescriptor(forkJoinDescriptor());
  const projection = initializeGraphProjection(descriptor, { approval: 'activation-private-entry' });
  return createInitialGraphState({
    session_id: sessionId,
    control_nonce: 'test-control-nonce',
    descriptor,
    projection,
    status: 'running',
    created_at: '2026-07-20T00:00:00.000Z',
    approval: {
      approved_at: '2026-07-20T00:00:00.000Z',
      evidence: { kind: 'human', ref: 'private-approval-evidence' },
    },
  });
}

describe('Graph HUD projection', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reads only the current session and exposes bounded public counters', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-graph-hud-'));
    directories.push(directory);
    const sessionId = 'session-current';
    const state = graphState(sessionId);
    const stateDirectory = join(directory, '.omc', 'state', 'sessions', sessionId);
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(join(stateDirectory, 'graph-state.json'), JSON.stringify(state), 'utf8');

    const projection = readGraphStateForHud(directory, sessionId);
    expect(projection).toEqual({
      status: 'running',
      completedActivations: 0,
      totalActivations: 1,
      readyActivations: 1,
      liveClaims: 0,
      unresolvedReconciliations: 0,
      revisionHashShort: state.active_revision_hash.slice(0, 12),
    });
    expect(readGraphStateForHud(directory, 'session-other')).toBeNull();
    expect(isAnyModeActive(directory, sessionId)).toBe(true);
    expect(getActiveSkills(directory, sessionId)).toContain('graph');
  });

  it('renders no goal, command, output, evidence, or full identity', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-graph-hud-'));
    directories.push(directory);
    const state = graphState('session-private');
    const stateDirectory = join(directory, '.omc', 'state');
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(join(stateDirectory, 'graph-state.json'), JSON.stringify(state), 'utf8');

    const rendered = renderGraph(readGraphStateForHud(directory));
    expect(rendered).toMatch(/G:.*running.*0\/1.*ready:1.*live:0.*reconcile:0/);
    expect(rendered).not.toMatch(/Build and verify|run-branch-b|private|human/);
    expect(rendered).not.toContain(state.active_revision_hash);
  });

  it.each(['paused', 'failed', 'cancelled', 'succeeded'] as const)(
    'hides terminal or inactive status %s',
    (status) => {
      const directory = mkdtempSync(join(tmpdir(), 'omc-graph-hud-'));
      directories.push(directory);
      const state = { ...graphState('session-terminal'), status };
      const stateDirectory = join(directory, '.omc', 'state');
      mkdirSync(stateDirectory, { recursive: true });
      writeFileSync(join(stateDirectory, 'graph-state.json'), JSON.stringify(state), 'utf8');

      expect(readGraphStateForHud(directory)).toBeNull();
    },
  );

  it('keeps the graph indicator visible on a transient partial write', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-graph-hud-'));
    directories.push(directory);
    const stateDirectory = join(directory, '.omc', 'state');
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(join(stateDirectory, 'graph-state.json'), '{"status":"running"}', 'utf8');

    // File exists and is non-empty but fails parse/validate (mid-commit write).
    // The graph must stay visible rather than disappearing during a live tick.
    const projection = readGraphStateForHud(directory);
    expect(projection).toEqual({
      status: 'unreadable',
      completedActivations: 0,
      totalActivations: 0,
      readyActivations: 0,
      liveClaims: 0,
      unresolvedReconciliations: 0,
      revisionHashShort: '?',
    });
    expect(isAnyModeActive(directory)).toBe(true);
    expect(getActiveSkills(directory)).toContain('graph');
    expect(renderGraph(projection)).toMatch(/G:.*unreadable/);
  });

  it('returns null for an empty graph-state file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-graph-hud-'));
    directories.push(directory);
    const stateDirectory = join(directory, '.omc', 'state');
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(join(stateDirectory, 'graph-state.json'), '', 'utf8');

    expect(readGraphStateForHud(directory)).toBeNull();
  });
});
