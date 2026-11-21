/**
 * The state of one graph run, derived the way the runtime derives it, for `omc graph status` and `omc graph gc`.
 *
 * The runtime keeps no status field, and it never trusts `projection.json`: a resume folds every record of the journal
 * over the entry projection (runner.ts, the replay fold) and the snapshot is only a status cache. This module does the
 * same from the text of a run's files, with the functions the runtime uses: the descriptor parse, the journal parse,
 * the replay fold (descriptor binding, epoch provenance, envelope and request fingerprints, scheduler transitions) and
 * the idle outcome rule. A run is one of:
 *
 *   succeeded    the scheduler success rule holds after the replay;
 *   failed       no activation can be started, resolved or approved, and the run did not succeed;
 *   in_progress  an activation is ready (an attempt that was running when the process stopped is ready again after
 *                a replay, because an attempt is committed only with its result);
 *   unreadable   the files do not make a run the runtime could resume: no descriptor, a descriptor of another run, a
 *                journal that is torn or corrupt, a record that fails the fold, or a descriptor with neither a
 *                committed record nor the initial snapshot.
 *
 * `missing` is not decided here: it means that the run directory does not exist, which the caller knows.
 *
 * The snapshot never decides a verdict. It is read only for a descriptor with an empty journal, where the replay has
 * nothing to fold: the initial snapshot (`saved_at_seq` -1, bound to the descriptor, run and revision) is the evidence
 * that the run was initialized and has not committed a record yet. A lost, restored or corrupt snapshot beside a
 * journal that replays does not change the verdict. One exception comes before the replay, from the readers of the
 * files: a projection.json that is a link, a FIFO or another file that is not a regular file is refused when the files
 * are read (status: unreadable, gc: unknown), because nothing is read through it.
 */

import { parseSealedGraphDescriptor } from "../descriptor.js";
import { listReadyApprovalActivations } from "../scheduler.js";
import type { GraphSchedulerProjection, SealedGraphDescriptor } from "../types.js";
import { parseJournalText } from "./journal.js";
import { foldJournalRecords, idleOutcome, initialRunProjection } from "./runner.js";
import { parseStoredEnvelope, sameSnapshotBinding } from "./store.js";
import { JournalCorruptionError } from "./types.js";
import type { JournalRecord } from "./types.js";

/** Text of the three files of a run; null for a file that does not exist. */
export interface RunFileTexts {
  readonly descriptor: string | null;
  readonly journal: string | null;
  readonly projection: string | null;
}

export type UnreadableReason =
  | "descriptor-missing"
  | "descriptor-malformed"
  | "descriptor-not-of-run"
  | "journal-corrupt"
  | "replay-rejected"
  | "no-history";

export type RunClassification =
  | { readonly state: "unreadable"; readonly reason: UnreadableReason; readonly detail: string }
  | {
      readonly state: "succeeded" | "failed" | "in_progress";
      readonly descriptor: SealedGraphDescriptor;
      /** The replayed projection, not the snapshot. */
      readonly projection: GraphSchedulerProjection;
      readonly records: readonly JournalRecord[];
      /** An approval activation is ready (only for an in_progress run). */
      readonly approvalPending: boolean;
    };

function unreadable(reason: UnreadableReason, detail: string): RunClassification {
  return { state: "unreadable", reason, detail };
}

// The initial snapshot of a run, as the runtime writes it before the first record: a valid envelope bound to the
// descriptor, run and revision, with no record behind it. Returns the reason it is not one, or null.
function initialSnapshotProblem(text: string | null, descriptor: SealedGraphDescriptor): string | null {
  if (text === null) return "projection.json is missing";
  let envelope;
  try {
    envelope = parseStoredEnvelope(JSON.parse(text));
  } catch (error) {
    return `projection.json: ${(error as Error).message}`;
  }
  const bound = { descriptor_hash: descriptor.descriptor_hash, run_id: descriptor.run_id, revision_id: descriptor.revision_id };
  if (!sameSnapshotBinding(envelope, bound)) return "projection.json is bound to another descriptor, run or revision";
  if (envelope.saved_at_seq !== -1) return `projection.json is at seq ${envelope.saved_at_seq} but the journal has no record`;
  return null;
}

/**
 * Classifies the run `runId` from the text of its files. `epochCeiling` is the highest writer epoch a record may
 * carry: pass the epoch the caller has acquired for the run (the runtime's own bound on resume); without it the
 * epochs must only be non-decreasing. Never throws for the content of a file.
 */
export function classifyRunFiles(runId: string, files: RunFileTexts, epochCeiling: number = Number.MAX_SAFE_INTEGER): RunClassification {
  if (files.descriptor === null) return unreadable("descriptor-missing", "descriptor.json is missing");
  let raw: unknown;
  try {
    raw = JSON.parse(files.descriptor);
  } catch (error) {
    return unreadable("descriptor-malformed", `descriptor.json: not valid JSON (${(error as Error).message})`);
  }
  let descriptor: SealedGraphDescriptor;
  try {
    descriptor = parseSealedGraphDescriptor(raw);
  } catch (error) {
    return unreadable("descriptor-malformed", `descriptor.json: ${(error as Error).message}`);
  }
  if (descriptor.run_id !== runId) return unreadable("descriptor-not-of-run", "descriptor.json is not the descriptor of this run");

  let records: readonly JournalRecord[];
  try {
    records = files.journal === null ? [] : parseJournalText(files.journal, "journal.jsonl");
  } catch (error) {
    if (error instanceof JournalCorruptionError) return unreadable("journal-corrupt", error.message);
    throw error;
  }
  if (records.length === 0) {
    // The runtime refuses a persisted descriptor without committed history; only a run that was just initialized, and
    // has the initial snapshot to show for it, is a run that has not committed anything yet.
    const problem = initialSnapshotProblem(files.projection, descriptor);
    if (problem !== null) return unreadable("no-history", `descriptor.json has no committed journal history and no initial snapshot (${problem})`);
  }

  let projection: GraphSchedulerProjection;
  try {
    projection = foldJournalRecords(descriptor, initialRunProjection(descriptor), records, epochCeiling);
  } catch (error) {
    return unreadable("replay-rejected", `journal.jsonl does not replay: ${(error as Error).message}`);
  }
  // Nothing is in flight in an offline read, so nothing is excluded (see idleOutcome).
  const outcome = idleOutcome(descriptor, projection, () => false);
  const state = outcome === "succeeded" ? "succeeded" : outcome === "failed" ? "failed" : "in_progress";
  return {
    state,
    descriptor,
    projection,
    records,
    approvalPending: state === "in_progress" && listReadyApprovalActivations(descriptor, projection).length > 0,
  };
}
