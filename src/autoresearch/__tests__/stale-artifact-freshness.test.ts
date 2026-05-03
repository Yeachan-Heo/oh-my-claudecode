import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { isCandidateArtifactFresh } from '../runtime.js';

describe('isCandidateArtifactFresh (B2 stale-artifact detection)', () => {
  let dir: string;
  let candidatePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omc-fresh-'));
    candidatePath = join(dir, 'candidate.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns true when no worker anchor is set (back-compat for callers without B2 wiring)', () => {
    writeFileSync(candidatePath, '{}');
    expect(isCandidateArtifactFresh(candidatePath, undefined)).toBe(true);
    expect(isCandidateArtifactFresh(candidatePath, null)).toBe(true);
  });

  it('returns true when candidate.json mtime is at or after the worker start anchor', () => {
    writeFileSync(candidatePath, '{}');
    const anchor = '2026-04-30T22:00:00Z';
    const future = new Date('2026-04-30T22:05:00Z').getTime() / 1000;
    utimesSync(candidatePath, future, future);
    expect(isCandidateArtifactFresh(candidatePath, anchor)).toBe(true);
  });

  it('returns false when candidate.json mtime predates the worker start anchor (stale-artifact case)', () => {
    writeFileSync(candidatePath, '{}');
    const past = new Date('2026-04-30T21:00:00Z').getTime() / 1000;
    utimesSync(candidatePath, past, past);
    const anchor = '2026-04-30T22:00:00Z';
    expect(isCandidateArtifactFresh(candidatePath, anchor)).toBe(false);
  });

  it('returns false when the artifact path does not exist', () => {
    expect(isCandidateArtifactFresh(join(dir, 'missing.json'), '2026-04-30T22:00:00Z')).toBe(false);
  });

  it('returns true when the anchor is unparseable (degrade permissively, do not falsely strand the run)', () => {
    writeFileSync(candidatePath, '{}');
    expect(isCandidateArtifactFresh(candidatePath, 'not-an-iso-string')).toBe(true);
  });
});
