/**
 * E.4 — Concurrent project-memory writes (Wave E)
 *
 * Verifies that two concurrent writers each appending to project-memory.json
 * via withProjectMemoryLock do not lose each other's data (no lost updates).
 *
 * Multi-repo workspace anchor tests (Wave 4 migration): verifies that when a
 * .omc-workspace marker exists in a parent dir, project-memory.json is written
 * to the workspace anchor .omc/ so sibling sub-repos share one memory file.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { withProjectMemoryLock } from '../../src/hooks/project-memory/storage.js';
import { clearWorktreeCache, getOmcRoot } from '../../src/lib/worktree-paths.js';

describe('concurrent project-memory writes (E.4)', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Read the raw notes array from project-memory.json.
   * Returns [] if file is absent or malformed.
   */
  function readNotes(projectRoot: string): string[] {
    const memPath = join(projectRoot, '.omc', 'project-memory.json');
    try {
      if (!existsSync(memPath)) return [];
      const raw = JSON.parse(readFileSync(memPath, 'utf-8'));
      return Array.isArray(raw.notes) ? raw.notes : [];
    } catch {
      return [];
    }
  }

  /**
   * Append a note to project-memory.json under the advisory lock.
   * Mirrors a real read-modify-write cycle.
   */
  async function appendNote(projectRoot: string, note: string): Promise<void> {
    const memPath = join(projectRoot, '.omc', 'project-memory.json');
    await withProjectMemoryLock(projectRoot, () => {
      const current = (() => {
        try {
          if (!existsSync(memPath)) return { notes: [] as string[] };
          return JSON.parse(readFileSync(memPath, 'utf-8')) as { notes: string[] };
        } catch {
          return { notes: [] as string[] };
        }
      })();

      current.notes = [...(current.notes ?? []), note];
      const dir = join(memPath, '..');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(memPath, JSON.stringify(current, null, 2), 'utf-8');
    });
  }

  it('two concurrent writers preserve both notes (no lost updates)', async () => {
    tempDir = mkdtempSync(join(homedir(), 'omc-pmem-concurrent-'));
    mkdirSync(join(tempDir, '.omc'), { recursive: true });

    await Promise.all([
      appendNote(tempDir, 'note-from-writer-A'),
      appendNote(tempDir, 'note-from-writer-B'),
    ]);

    const notes = readNotes(tempDir);
    expect(notes).toContain('note-from-writer-A');
    expect(notes).toContain('note-from-writer-B');
    expect(notes.length).toBe(2);
  });

  it('three concurrent writers each preserve their note', async () => {
    tempDir = mkdtempSync(join(homedir(), 'omc-pmem-three-'));
    mkdirSync(join(tempDir, '.omc'), { recursive: true });

    await Promise.all([
      appendNote(tempDir, 'note-A'),
      appendNote(tempDir, 'note-B'),
      appendNote(tempDir, 'note-C'),
    ]);

    const notes = readNotes(tempDir);
    expect(notes).toContain('note-A');
    expect(notes).toContain('note-B');
    expect(notes).toContain('note-C');
    expect(notes.length).toBe(3);
  });
});

describe('concurrent project-memory writes — multi-repo workspace anchor (E.4 migration)', () => {
  let workspaceRoot: string;

  afterEach(() => {
    clearWorktreeCache();
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  });

  /**
   * Read notes from the workspace-anchor project-memory.json.
   * Uses getOmcRoot(subDir) so the path resolves through the workspace marker.
   */
  function readNotesFromAnchor(subDir: string): string[] {
    const memPath = join(getOmcRoot(subDir), 'project-memory.json');
    try {
      if (!existsSync(memPath)) return [];
      const raw = JSON.parse(readFileSync(memPath, 'utf-8'));
      return Array.isArray(raw.notes) ? raw.notes : [];
    } catch {
      return [];
    }
  }

  /**
   * Append a note using withProjectMemoryLock rooted at a sub-repo.
   * The lock and file path both resolve through getOmcRoot() → workspace anchor.
   */
  async function appendNoteFromSubRepo(subDir: string, note: string): Promise<void> {
    const memPath = join(getOmcRoot(subDir), 'project-memory.json');
    await withProjectMemoryLock(subDir, () => {
      const current = (() => {
        try {
          if (!existsSync(memPath)) return { notes: [] as string[] };
          return JSON.parse(readFileSync(memPath, 'utf-8')) as { notes: string[] };
        } catch {
          return { notes: [] as string[] };
        }
      })();
      current.notes = [...(current.notes ?? []), note];
      const dir = join(memPath, '..');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(memPath, JSON.stringify(current, null, 2), 'utf-8');
    });
  }

  it('concurrent writers from sibling sub-repos converge on workspace anchor project-memory.json', async () => {
    workspaceRoot = mkdtempSync(join(homedir(), 'omc-pmem-workspace-'));

    // Drop workspace marker so getOmcRoot() anchors here
    writeFileSync(join(workspaceRoot, '.omc-workspace'), '{}');

    const repoA = join(workspaceRoot, 'repo-a');
    const repoB = join(workspaceRoot, 'repo-b');
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });

    clearWorktreeCache();

    await Promise.all([
      appendNoteFromSubRepo(repoA, 'note-from-repo-A'),
      appendNoteFromSubRepo(repoB, 'note-from-repo-B'),
    ]);

    // Both notes must appear in the workspace anchor's project-memory.json
    const notes = readNotesFromAnchor(repoA);
    expect(notes).toContain('note-from-repo-A');
    expect(notes).toContain('note-from-repo-B');
    expect(notes.length).toBe(2);

    // Sub-repos must not have their own .omc/project-memory.json
    expect(existsSync(join(repoA, '.omc', 'project-memory.json'))).toBe(false);
    expect(existsSync(join(repoB, '.omc', 'project-memory.json'))).toBe(false);

    // Workspace anchor has exactly one project-memory.json
    expect(existsSync(join(workspaceRoot, '.omc', 'project-memory.json'))).toBe(true);
  });

  it('three concurrent writers from different sub-repos each preserve their note at the workspace anchor', async () => {
    workspaceRoot = mkdtempSync(join(homedir(), 'omc-pmem-workspace-three-'));
    writeFileSync(join(workspaceRoot, '.omc-workspace'), '{}');

    const repoA = join(workspaceRoot, 'repo-a');
    const repoB = join(workspaceRoot, 'repo-b');
    const repoC = join(workspaceRoot, 'repo-c');
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });
    mkdirSync(repoC, { recursive: true });

    clearWorktreeCache();

    await Promise.all([
      appendNoteFromSubRepo(repoA, 'note-A'),
      appendNoteFromSubRepo(repoB, 'note-B'),
      appendNoteFromSubRepo(repoC, 'note-C'),
    ]);

    const notes = readNotesFromAnchor(repoA);
    expect(notes).toContain('note-A');
    expect(notes).toContain('note-B');
    expect(notes).toContain('note-C');
    expect(notes.length).toBe(3);
  });
});
