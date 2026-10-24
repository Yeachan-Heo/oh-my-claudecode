import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  appendLedgerEntry,
  isVerificationVerdict,
  LEDGER_HEADER,
  readLedger,
  renderLedgerCell,
} from '../ledger.js';

function tempLedger(): string {
  return join(mkdtempSync(join(tmpdir(), 'omc-ledger-')), 'verification-ledger.tsv');
}

describe('verification ledger', () => {
  it('accepts the canonical verdict words and rejects others', () => {
    expect(isVerificationVerdict('unit-test-verified')).toBe(true);
    expect(isVerificationVerdict('formally-verified')).toBe(true);
    expect(isVerificationVerdict('definitely-fine')).toBe(false);
  });

  it('creates the ledger with a header on first append and round-trips entries', async () => {
    const path = tempLedger();
    await appendLedgerEntry(path, {
      ts: '2026-10-24T00:00:00Z',
      kind: 'babysit',
      ref: '42',
      sha: 'abc123',
      verdict: 'unit-test-verified',
      evidence: 'gh pr checks 42 --watch',
    });
    await appendLedgerEntry(path, {
      ts: '2026-10-24T00:01:00Z',
      kind: 'create-formal-verification-skill',
      sha: 'abc123',
      verdict: 'formally-verified',
      evidence: 'cargo kani harness',
      verifier: 'session-9',
    });

    const raw = readFileSync(path, 'utf8');
    expect(raw.split('\n')[0]).toBe(LEDGER_HEADER);

    const entries = await readLedger(path);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      kind: 'create-formal-verification-skill',
      verdict: 'formally-verified',
      verifier: 'session-9',
    });
    rmSync(dirname(path), { recursive: true, force: true });
  });

  it('requires evidence', async () => {
    const path = tempLedger();
    await expect(
      appendLedgerEntry(path, {
        ts: 't',
        kind: 'verify',
        verdict: 'unit-test-verified',
        evidence: '   ',
      }),
    ).rejects.toThrow(/evidence/);
  });

  it('neutralizes formula-leading and multiline cells', () => {
    expect(renderLedgerCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(renderLedgerCell('+cmd')).toBe("'+cmd");
    expect(renderLedgerCell('line1\nline2')).toBe('line1 line2');
    expect(renderLedgerCell(undefined)).toBe('');
    expect(renderLedgerCell('plain')).toBe('plain');
  });

  it('reads an empty ledger as no entries', async () => {
    expect(await readLedger(join(tmpdir(), 'omc-ledger-missing.tsv'))).toEqual([]);
  });
});
