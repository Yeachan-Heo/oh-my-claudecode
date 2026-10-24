/**
 * Verification ledger — durable, append-only record of verification verdicts.
 *
 * Vocabulary credit: the verdict words and the ledger shape derive from
 * pstack's orch verification ledger
 * (https://github.com/cursor/plugins/tree/main/pstack, ported at
 * https://github.com/michael-denyer/pstack-claude), adapted for OMC's
 * `.omc/state/` plane: one TSV per project, every workflow (verify, babysit,
 * arena, formal verification) appends, nothing rewrites history.
 */

import { appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';

export const VERIFICATION_VERDICTS = [
  'live-ui-verified',
  'unit-test-verified',
  'type-check-only',
  'enforcement-verified',
  'formally-verified',
  'verifier-blocked',
  'verifier-failed',
] as const;

export type VerificationVerdict = (typeof VERIFICATION_VERDICTS)[number];

export function isVerificationVerdict(value: string): value is VerificationVerdict {
  return (VERIFICATION_VERDICTS as readonly string[]).includes(value);
}

export interface LedgerEntry {
  /** ISO timestamp; callers may inject for determinism. */
  readonly ts: string;
  /** What was verified: skill or workflow name. */
  readonly kind: string;
  /** PR number, branch, or file the verdict refers to. */
  readonly ref?: string;
  /** Head SHA or revision the verdict was earned on. */
  readonly sha?: string;
  readonly verdict: VerificationVerdict;
  /** Command or observation that constitutes the evidence. */
  readonly evidence: string;
  /** Who or what verified; the recording session when omitted. */
  readonly verifier?: string;
}

export const LEDGER_HEADER =
  'ts\tkind\tref\tsha\tverdict\tevidence\tverifier';

/**
 * Render one cell: tabs and newlines become spaces, and a cell that starts
 * with a spreadsheet formula character is prefixed with `'` so TSV readers
 * cannot parse it as a formula (guard credit: pstack orch store).
 */
export function renderLedgerCell(value: string | undefined): string {
  const flat = String(value ?? '').replace(/[\t\r\n]+/g, ' ');
  if (/^[=+\-@]/.test(flat)) {
    return `'${flat}`;
  }
  return flat;
}

export function renderLedgerRow(entry: LedgerEntry): string {
  return [
    entry.ts,
    entry.kind,
    entry.ref ?? '',
    entry.sha ?? '',
    entry.verdict,
    entry.evidence,
    entry.verifier ?? '',
  ]
    .map(renderLedgerCell)
    .join('\t');
}

/** Append one entry, creating the ledger with its header on first write. */
export async function appendLedgerEntry(ledgerPath: string, entry: LedgerEntry): Promise<void> {
  if (!isVerificationVerdict(entry.verdict)) {
    throw new Error(`invalid verification verdict: ${String(entry.verdict)}`);
  }
  if (!entry.evidence.trim()) {
    throw new Error('ledger entries require non-empty evidence');
  }
  await mkdir(dirname(ledgerPath), { recursive: true });
  if (!existsSync(ledgerPath)) {
    await appendFile(ledgerPath, `${LEDGER_HEADER}\n`, 'utf8');
  }
  await appendFile(ledgerPath, `${renderLedgerRow(entry)}\n`, 'utf8');
}

/** Read every entry; malformed rows are skipped with their line number kept out. */
export async function readLedger(ledgerPath: string): Promise<LedgerEntry[]> {
  if (!existsSync(ledgerPath)) {
    return [];
  }
  const text = await readFile(ledgerPath, 'utf8');
  const entries: LedgerEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line || line === LEDGER_HEADER) continue;
    const [ts, kind, ref, sha, verdict, evidence, verifier] = line.split('\t');
    if (!ts || !kind || !verdict || !isVerificationVerdict(verdict)) continue;
    entries.push({
      ts,
      kind,
      ref: ref || undefined,
      sha: sha || undefined,
      verdict,
      evidence: evidence ?? '',
      verifier: verifier || undefined,
    });
  }
  return entries;
}
