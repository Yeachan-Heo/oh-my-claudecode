import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  appendRunLedger,
  closeoutWrittenFor,
  observeModeStateClear,
  observeModeStateWrite,
} from '../runs-ledger.js';

const fixtures: string[] = [];

afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omc-runs-ledger-'));
  fixtures.push(dir);
  return dir;
}

function statePath(dir: string, mode = 'ralph', sessionId?: string): string {
  return sessionId
    ? join(dir, 'state', 'sessions', sessionId, `${mode}-state.json`)
    : join(dir, 'state', `${mode}-state.json`);
}

function ledgerLines(dir: string): Array<Record<string, unknown>> {
  const path = join(dir, 'state', 'runs', 'ledger.jsonl');
  if (!existsSyncSafe(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function existsSyncSafe(path: string): boolean {
  try {
    return readFileSync(path, 'utf8').length >= 0;
  } catch {
    return false;
  }
}

describe('runs ledger', () => {
  it('records a start edge when a watched mode state becomes active', () => {
    const dir = fixture();
    const path = statePath(dir, 'ralph');
    mkdirSync(join(path, '..'), { recursive: true });
    observeModeStateWrite(dir, path, { active: true, started_at: '2026-09-27T00:00:00Z' });
    const lines = ledgerLines(dir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ run: 'ralph', event: 'start', outcome: 'running' });
  });

  it('does not duplicate the start edge for repeated writes in the same process', () => {
    const dir = fixture();
    const path = statePath(dir, 'ralph');
    mkdirSync(join(path, '..'), { recursive: true });
    observeModeStateWrite(dir, path, { active: true });
    observeModeStateWrite(dir, path, { active: true, iteration: 2 });
    expect(ledgerLines(dir)).toHaveLength(1);
  });

  it('ignores non-watched modes and inactive states', () => {
    const dir = fixture();
    const other = statePath(dir, 'deep-interview');
    mkdirSync(join(other, '..'), { recursive: true });
    observeModeStateWrite(dir, other, { active: true });
    const inactive = statePath(dir, 'ralph');
    mkdirSync(join(inactive, '..'), { recursive: true });
    observeModeStateWrite(dir, inactive, { active: false });
    expect(ledgerLines(dir)).toEqual([]);
  });

  it('records an end edge with closeoutWritten when a previously-active state is cleared', () => {
    const dir = fixture();
    const mode = 'ralph';
    const notepad = join(dir, 'notepads', mode, 'problems.md');
    mkdirSync(join(notepad, '..'), { recursive: true });
    writeFileSync(notepad, '- 2026-09-27 closeout line\n');
    const started = new Date(Date.now() - 3600_000).toISOString();
    utimesSync(notepad, new Date(), new Date(Date.now() - 1800_000)); // after startedAt
    observeModeStateClear(dir, statePath(dir, mode), { active: true, started_at: started, current_phase: 'complete' });
    const lines = ledgerLines(dir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ run: mode, event: 'end', outcome: 'completed', closeoutWritten: true });
  });

  it('marks closeoutWritten false when the notepad has no post-start write', () => {
    const dir = fixture();
    observeModeStateClear(dir, statePath(dir, 'ralph'), { active: true, started_at: new Date().toISOString() });
    const lines = ledgerLines(dir);
    expect(lines).toHaveLength(1);
    expect(lines[0].closeoutWritten).toBe(false);
  });

  it('appendRunLedger is callable directly and rotation keeps the tail bounded', () => {
    const dir = fixture();
    for (let i = 0; i < 1005; i += 1) {
      appendRunLedger(dir, { ts: 't', run: 'ralph', event: 'start', outcome: 'running' });
    }
    const path = join(dir, 'state', 'runs', 'ledger.jsonl');
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines.length).toBe(5);
    expect(readFileSync(`${path}.1`, 'utf8').trim().split('\n').length).toBe(1000);
  });

  it('closeoutWrittenFor requires a parseable startedAt', () => {
    const dir = fixture();
    expect(closeoutWrittenFor(dir, 'ralph', undefined)).toBe(false);
    expect(closeoutWrittenFor(dir, 'ralph', 'not-a-date')).toBe(false);
  });

  it('avoids false positive closeoutWritten when mode is resumed (notepad write between stale started_at and resume start)', () => {
    // Simulates a mode being resumed: original run starts, notepad written, run ends,
    // mode is resumed (started_at preserved), new ledger start edge logged.
    // The closeout detection must use the latest start edge, not the stale started_at.
    const dir = fixture();
    const mode = 'ralph';
    const path = statePath(dir, mode);
    mkdirSync(join(path, '..'), { recursive: true });

    // Original run: start at T0
    const originalStartT0 = new Date(Date.now() - 7200_000).toISOString(); // 2 hours ago
    observeModeStateWrite(dir, path, { active: true, started_at: originalStartT0 });

    // Write to notepad at T1 (between original start and resume start)
    const notepadWriteT1 = new Date(Date.now() - 3600_000); // 1 hour ago
    const notepad = join(dir, 'notepads', mode, 'problems.md');
    mkdirSync(join(notepad, '..'), { recursive: true });
    writeFileSync(notepad, '- problem from first run\n');
    utimesSync(notepad, notepadWriteT1, notepadWriteT1);

    // Mode is resumed at T2: started_at is preserved from original run
    // but a new 'start' ledger edge is logged
    const resumeStartT2 = new Date(Date.now() - 1800_000).toISOString(); // 30 min ago
    observeModeStateWrite(dir, path, { active: true, started_at: originalStartT0 });
    // Manually set the latest start edge to T2 (simulating the resume)
    appendRunLedger(dir, {
      ts: resumeStartT2,
      run: mode,
      event: 'start',
      outcome: 'running',
    });

    // When the resumed run ends, closeoutWritten should be false because
    // the notepad write at T1 is BEFORE the resume start at T2
    observeModeStateClear(dir, path, { active: true, started_at: originalStartT0, current_phase: 'complete' });
    const lines = ledgerLines(dir);
    const endEdge = lines.find((l) => l.event === 'end');
    expect(endEdge?.closeoutWritten).toBe(false);
  });

  it('correctly marks closeoutWritten when notepad is written after mode resume', () => {
    const dir = fixture();
    const mode = 'ralph';
    const path = statePath(dir, mode);
    mkdirSync(join(path, '..'), { recursive: true });

    // Original run: start at T0
    const originalStartT0 = new Date(Date.now() - 5400_000).toISOString(); // 90 min ago
    observeModeStateWrite(dir, path, { active: true, started_at: originalStartT0 });

    // Mode is resumed at T1
    const resumeStartT1 = new Date(Date.now() - 1800_000).toISOString(); // 30 min ago
    observeModeStateWrite(dir, path, { active: true, started_at: originalStartT0 });
    appendRunLedger(dir, {
      ts: resumeStartT1,
      run: mode,
      event: 'start',
      outcome: 'running',
    });

    // Write to notepad at T2 (after resume start)
    const notepadWriteT2 = new Date(Date.now() - 900_000); // 15 min ago
    const notepad = join(dir, 'notepads', mode, 'problems.md');
    mkdirSync(join(notepad, '..'), { recursive: true });
    writeFileSync(notepad, '- problem from resumed run\n');
    utimesSync(notepad, notepadWriteT2, notepadWriteT2);

    // When the resumed run ends, closeoutWritten should be true because
    // the notepad write at T2 is AFTER the resume start at T1
    observeModeStateClear(dir, path, { active: true, started_at: originalStartT0, current_phase: 'complete' });
    const lines = ledgerLines(dir);
    const endEdge = lines.find((l) => l.event === 'end');
    expect(endEdge?.closeoutWritten).toBe(true);
  });

  it('skips a corrupt ledger line when locating the resume start edge', () => {
    const dir = fixture();
    const mode = 'ralph';
    const path = statePath(dir, mode);
    mkdirSync(join(path, '..'), { recursive: true });
    const originalStart = new Date(Date.now() - 7200_000).toISOString();
    const notepad = join(dir, 'notepads', mode, 'problems.md');
    mkdirSync(join(notepad, '..'), { recursive: true });
    writeFileSync(notepad, '- problem from first run\n');
    const beforeResume = new Date(Date.now() - 3600_000);
    utimesSync(notepad, beforeResume, beforeResume);
    appendRunLedger(dir, { ts: new Date(Date.now() - 1800_000).toISOString(), run: mode, event: 'start', outcome: 'running' });
    appendFileSync(join(dir, 'state', 'runs', 'ledger.jsonl'), '{"torn":\n');
    observeModeStateClear(dir, path, { active: true, started_at: originalStart, current_phase: 'complete' });
    const raw = readFileSync(join(dir, 'state', 'runs', 'ledger.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(raw[raw.length - 1])).toMatchObject({ event: 'end', closeoutWritten: false });
  });

  it('uses the start edge when the retained started_at is unparseable', () => {
    const dir = fixture();
    const mode = 'ralph';
    const path = statePath(dir, mode);
    mkdirSync(join(path, '..'), { recursive: true });
    appendRunLedger(dir, { ts: new Date(Date.now() - 1800_000).toISOString(), run: mode, event: 'start', outcome: 'running' });
    const notepad = join(dir, 'notepads', mode, 'problems.md');
    mkdirSync(join(notepad, '..'), { recursive: true });
    writeFileSync(notepad, '- closeout\n');
    observeModeStateClear(dir, path, { active: true, started_at: 'not-a-date', current_phase: 'complete' });
    const endEdge = ledgerLines(dir).find((l) => l.event === 'end');
    expect(endEdge?.closeoutWritten).toBe(true);
  });
});
