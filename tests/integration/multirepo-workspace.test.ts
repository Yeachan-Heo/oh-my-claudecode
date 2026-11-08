/**
 * Integration tests for multi-repo workspace anchor behaviour (Wave 4).
 *
 * Verifies getOmcRoot, getProjectIdentifier, resolveSessionStatePaths,
 * findWorkspaceRoot, and OMC_STATE_DIR precedence across sibling sub-repos
 * that share a .omc-workspace marker at a common parent directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import {
  getOmcRoot,
  getProjectIdentifier,
  resolveSessionStatePaths,
  findWorkspaceRoot,
  clearWorktreeCache,
} from '../../src/lib/worktree-paths.js';

describe('multi-repo workspace anchor', () => {
  let parent: string;
  let repoA: string;
  let repoB: string;
  const savedOMC_STATE_DIR = process.env.OMC_STATE_DIR;

  beforeEach(() => {
    clearWorktreeCache();
    // Fresh temp parent dir per test — no .git, no .omc-workspace yet
    parent = mkdtempSync(join(homedir(), 'omc-multirepo-'));
    repoA = join(parent, 'repoA');
    repoB = join(parent, 'repoB');
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });
  });

  afterEach(() => {
    clearWorktreeCache();
    // Restore OMC_STATE_DIR
    if (savedOMC_STATE_DIR === undefined) {
      delete process.env.OMC_STATE_DIR;
    } else {
      process.env.OMC_STATE_DIR = savedOMC_STATE_DIR;
    }
    if (parent) rmSync(parent, { recursive: true, force: true });
  });

  it('sibling sub-repos both resolve .omc root to the parent workspace anchor', () => {
    writeFileSync(join(parent, '.omc-workspace'), '{}');
    clearWorktreeCache();

    const rootA = getOmcRoot(repoA);
    const rootB = getOmcRoot(repoB);
    const expected = join(parent, '.omc');

    expect(rootA).toBe(expected);
    expect(rootB).toBe(expected);
  });

  it('sibling sub-repos share the same project identifier', () => {
    writeFileSync(join(parent, '.omc-workspace'), '{}');
    clearWorktreeCache();

    const idA = getProjectIdentifier(repoA);
    const idB = getProjectIdentifier(repoB);

    expect(idA).toBe(idB);
    // Identifier starts with the parent basename (sanitized)
    const parentBase = basename(parent).replace(/[^a-zA-Z0-9_-]/g, '_');
    expect(idA.startsWith(parentBase)).toBe(true);
  });

  it('marker with {"id":"myws"} derives project identifier from sanitized id', () => {
    writeFileSync(join(parent, '.omc-workspace'), JSON.stringify({ id: 'myws' }));
    clearWorktreeCache();

    const id = getProjectIdentifier(repoA);
    expect(id.startsWith('myws')).toBe(true);
    // Must not contain the plain basename when an explicit id overrides it
    const parentBase = basename(parent).replace(/[^a-zA-Z0-9_-]/g, '_');
    // The id should derive from 'myws', not parentBase
    expect(id).not.toMatch(new RegExp(`^${parentBase}`));
  });

  it('session state paths for two sessions under the same workspace are isolated', () => {
    writeFileSync(join(parent, '.omc-workspace'), '{}');
    clearWorktreeCache();

    const pathsA = resolveSessionStatePaths('ralph', 'sessA', repoA);
    const pathsB = resolveSessionStatePaths('ralph', 'sessB', repoA);

    // Write paths must differ
    expect(pathsA.effectiveWrite).not.toBe(pathsB.effectiveWrite);

    // Both write paths must live under the shared workspace .omc/state/sessions/
    const sessionsRoot = join(parent, '.omc', 'state', 'sessions');
    expect(pathsA.effectiveWrite.startsWith(sessionsRoot)).toBe(true);
    expect(pathsB.effectiveWrite.startsWith(sessionsRoot)).toBe(true);
  });

  it('OMC_STATE_DIR overrides workspace marker and ignores .omc-workspace', () => {
    writeFileSync(join(parent, '.omc-workspace'), '{}');
    clearWorktreeCache();

    const stateDir = mkdtempSync(join(homedir(), 'omc-statedir-'));
    try {
      process.env.OMC_STATE_DIR = stateDir;
      clearWorktreeCache();

      const root = getOmcRoot(repoA);

      // Must resolve under OMC_STATE_DIR, not under the workspace marker parent
      expect(root.startsWith(stateDir)).toBe(true);
      expect(root.startsWith(parent)).toBe(false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('findWorkspaceRoot walks up from a sub-repo and finds the parent marker', () => {
    writeFileSync(join(parent, '.omc-workspace'), '{}');
    clearWorktreeCache();

    const wsRoot = findWorkspaceRoot(repoA);
    expect(wsRoot).toBe(parent);
  });

  it('findWorkspaceRoot returns null when there is no marker', () => {
    // No marker written — parent is a plain directory
    clearWorktreeCache();

    const wsRoot = findWorkspaceRoot(repoA);
    expect(wsRoot).toBeNull();
  });
});
