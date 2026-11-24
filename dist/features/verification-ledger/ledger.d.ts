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
export declare const VERIFICATION_VERDICTS: readonly ["live-ui-verified", "unit-test-verified", "type-check-only", "enforcement-verified", "formally-verified", "verifier-blocked", "verifier-failed"];
export type VerificationVerdict = (typeof VERIFICATION_VERDICTS)[number];
export declare function isVerificationVerdict(value: string): value is VerificationVerdict;
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
export declare const LEDGER_HEADER = "ts\tkind\tref\tsha\tverdict\tevidence\tverifier";
/** Ledger location under the OMC state root. */
export declare const LEDGER_STATE_RELATIVE_PATH = "state/verification-ledger.tsv";
/**
 * The canonical ledger path under OMC's state root, so callers never
 * hard-code `.omc/state/`: with `OMC_STATE_DIR` (or a workspace marker)
 * mapping project state elsewhere, a hard-coded working-tree path would
 * split the ledger from the rest of OMC state. Under a shared workspace
 * root the ledger is scoped per project, so independent sibling repos do
 * not append into one another's history.
 */
export declare function defaultLedgerPath(): string;
/**
 * Render one cell: tabs and newlines become spaces, and a cell that starts
 * with a spreadsheet formula character is prefixed with `'` so TSV readers
 * cannot parse it as a formula (guard credit: pstack orch store).
 */
export declare function renderLedgerCell(value: string | undefined): string;
export declare function renderLedgerRow(entry: LedgerEntry): string;
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
export declare function appendLedgerEntry(ledgerPath: string, entry: LedgerEntry): Promise<void>;
/** Read every entry; malformed rows are skipped with their line number kept out. */
export declare function readLedger(ledgerPath: string): Promise<LedgerEntry[]>;
//# sourceMappingURL=ledger.d.ts.map