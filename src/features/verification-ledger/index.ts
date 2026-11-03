/**
 * Verification ledger feature barrel: durable, append-only verdict records.
 *
 * Vocabulary credit: the verdict words and ledger shape derive from pstack's
 * orch verification ledger (see docs/CREDITS.md).
 */
export {
  appendLedgerEntry,
  isVerificationVerdict,
  LEDGER_HEADER,
  readLedger,
  renderLedgerCell,
  renderLedgerRow,
  VERIFICATION_VERDICTS,
  type LedgerEntry,
  type VerificationVerdict,
} from './ledger.js';
