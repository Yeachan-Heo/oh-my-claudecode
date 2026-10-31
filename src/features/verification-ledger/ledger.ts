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

import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, appendFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { withFileLock, lockPathFor } from '../../lib/file-lock.js';

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

/**
 * Append one entry, creating the ledger with its header on first write.
 *
 * Initialization and the append are serialized under the async `withFileLock`
 * helper: concurrent first writers would otherwise race the exists-check and
 * emit duplicate header rows (reproduced with twenty concurrent appends).
 * The async acquisition never blocks the event loop, and the locked section
 * is fully synchronous, so the ledger file is written atomically with
 * respect to other holders.
 */
export async function appendLedgerEntry(ledgerPath: string, entry: LedgerEntry): Promise<void> {
  if (isVerificationVerdict(entry.verdict) === false) {
    throw new Error(`invalid verification verdict: ${String(entry.verdict)}`);
  }
  for (const required of ['ts', 'kind', 'verdict', 'evidence'] as const) {
    if (!String(entry[required] ?? '').trim()) {
      throw new Error(`ledger entries require non-empty ${required}`);
    }
  }
  mkdirSync(dirname(ledgerPath), { recursive: true });
  await withFileLock(
    lockPathFor(ledgerPath),
    () => {
      // A zero-byte file (created by a crashed or interrupted writer) exists
      // but has no header — size, not existence, decides initialization.
      const needsHeader =
        !existsSync(ledgerPath) || statSync(ledgerPath).size === 0;
      if (needsHeader) {
        appendFileSync(ledgerPath, `${LEDGER_HEADER}\n`, 'utf8');
      }
      appendFileSync(ledgerPath, `${renderLedgerRow(entry)}\n`, 'utf8');
    },
    { timeoutMs: 10_000, retryDelayMs: 25 },
  );
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
    const cells = line.split('\t');
    if (cells.length !== 7) continue;
    const [ts, kind, ref, sha, verdict, evidence, verifier] = cells;
    if (!ts || !kind || !verdict || !isVerificationVerdict(verdict)) continue;
    if (!evidence || !evidence.trim()) continue;
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
