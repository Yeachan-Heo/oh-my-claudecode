import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(isVerificationVerdict('enforcement-verified')).toBe(true);
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

  it('rejects empty ts or kind that the reader would silently drop', async () => {
    const path = tempLedger();
    for (const bad of [{ ts: '', kind: 'verify' }, { ts: 't', kind: '' }]) {
      await expect(
        appendLedgerEntry(path, { ...bad, verdict: 'unit-test-verified', evidence: 'cmd' } as never),
      ).rejects.toThrow(/non-empty (ts|kind)/);
    }
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

  it('skips rows with surplus TSV cells', async () => {
    const path = tempLedger();
    writeFileSync(
      path,
      `${LEDGER_HEADER}\n2026-10-25T00:00:00Z\tverify\tref\tsha\tunit-test-verified\tevidence\tverifier\textra\n`,
      'utf8',
    );
    expect(await readLedger(path)).toEqual([]);
    rmSync(dirname(path), { recursive: true, force: true });
  });

  it('neutralizes formula-leading and multiline cells', () => {
    expect(renderLedgerCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(renderLedgerCell('+cmd')).toBe("'+cmd");
    expect(renderLedgerCell('line1\nline2')).toBe('line1 line2');
    expect(renderLedgerCell(undefined)).toBe('');
    expect(renderLedgerCell('plain')).toBe('plain');
  });

  it('serializes twenty concurrent first writers into one header row', async () => {
    const path = tempLedger();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        appendLedgerEntry(path, {
          ts: `2026-10-25T00:00:${String(i).padStart(2, '0')}Z`,
          kind: 'verify',
          verdict: 'unit-test-verified',
          evidence: `concurrent append ${i}`,
        }),
      ),
    );
    const raw = readFileSync(path, 'utf8');
    expect(raw.split('\n').filter((l) => l === LEDGER_HEADER)).toHaveLength(1);
    const entries = await readLedger(path);
    expect(entries).toHaveLength(20);
    rmSync(dirname(path), { recursive: true, force: true });
  });

  it('initializes the header on a zero-byte ledger file', async () => {
    const path = tempLedger();
    writeFileSync(path, '', 'utf8');
    await appendLedgerEntry(path, {
      ts: '2026-10-25T00:00:00Z',
      kind: 'verify',
      verdict: 'unit-test-verified',
      evidence: 'append onto a zero-byte file',
    });
    const raw = readFileSync(path, 'utf8');
    expect(raw.split('\n')[0]).toBe(LEDGER_HEADER);
    expect(await readLedger(path)).toHaveLength(1);
    rmSync(dirname(path), { recursive: true, force: true });
  });

  it('reads an empty ledger as no entries', async () => {
    expect(await readLedger(join(tmpdir(), 'omc-ledger-missing.tsv'))).toEqual([]);
  });
});
