/**
 * Append-only OCC journal over `<runsRoot>/<run_id>/journal.jsonl`.
 *
 * The journal persists committed records with an envelope fingerprint that
 * includes seq/epoch/descriptor_hash/transition. It validates envelope shape
 * and the fingerprint format on read (fail-closed). Deep transition
 * validation happens at the scheduler replay fold; epoch ownership fencing is
 * a runner-level concern (OwnershipFence).
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  writeSync,
} from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { canonicalJson } from "../descriptor.js";
import { resolveRunDirHandle } from "./run-dir.js";
import type { RunDirHandle } from "./run-dir.js";
import {
  assertPrivateRegularFile,
  readContainedFileNoFollow,
  withContainedOperations,
} from "./safe-fs.js";
import { JournalCorruptionError } from "./types.js";
import type {
  Journal,
  JournalAppendRecord,
  JournalRecord,
} from "./types.js";

const DESCRIPTOR_HASH_PATTERN = /^[a-f0-9]{64}$/;
const JOURNAL_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Authenticates the runtime envelope binding, including the writer epoch.
 * Scheduler request fingerprints intentionally remain Graph Core concerns;
 * this digest binds the runtime-only epoch to the exact committed record.
 */
export function computeJournalFingerprint(record: JournalAppendRecord): string {
  const unsignedRecord = { ...record } as Record<string, unknown>;
  delete unsignedRecord.journal_fingerprint;
  return createHash("sha256")
    .update(canonicalJson(unsignedRecord))
    .digest("hex");
}

/** Envelope validation for one parsed record; returns an error message or null. */
function envelopeError(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "record is not an object";
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.seq !== "number" ||
    !Number.isInteger(record.seq) ||
    record.seq < 0
  ) {
    return "seq must be an integer >= 0";
  }
  if (
    typeof record.epoch !== "number" ||
    !Number.isInteger(record.epoch) ||
    record.epoch < 1
  ) {
    return "epoch must be an integer >= 1";
  }
  if (
    typeof record.descriptor_hash !== "string" ||
    !DESCRIPTOR_HASH_PATTERN.test(record.descriptor_hash)
  ) {
    return "descriptor_hash must match /^[a-f0-9]{64}$/";
  }
  if (
    record.transition === null ||
    typeof record.transition !== "object" ||
    Array.isArray(record.transition)
  ) {
    return "transition must be present as an object";
  }
  if (
    typeof record.journal_fingerprint !== "string" ||
    !JOURNAL_FINGERPRINT_PATTERN.test(record.journal_fingerprint)
  ) {
    return "journal_fingerprint must be a lowercase sha256 hex digest";
  }
  return null;
}

export class FileJournal implements Journal {
  private readonly runsRoot: string;
  private readonly runId?: string;
  private readonly handle?: RunDirHandle;
  private readonly assertOwnership?: () => void;

  /**
   * The frozen `Journal` interface is run-scoped but carries no run id, so an
   * instance must be bound to one run. `runId` is optional only to keep the
   * brief's `new FileJournal(runsRoot)` signature constructible; unbound
   * instances fail closed on use.  An optional ownership callback binds each
   * append to the writer's lease epoch.
   */
  constructor(
    runsRoot: string,
    runId?: string,
    runDirHandle?: RunDirHandle,
    assertOwnership?: () => void,
  ) {
    this.runsRoot = runsRoot;
    this.runId = runId;
    this.handle = runDirHandle;
    this.assertOwnership = assertOwnership;
  }

  async append(record: JournalAppendRecord): Promise<void> {
    return this.appendInternal(record, this.assertOwnership);
  }

  private async appendInternal(
    record: JournalAppendRecord,
    assertOwnership?: () => void,
  ): Promise<void> {
    assertOwnership?.();
    const runDir = this.runDir();
    const unsignedRecord = { ...record } as Record<string, unknown>;
    delete unsignedRecord.journal_fingerprint;
    const committed: JournalRecord = {
      ...(unsignedRecord as JournalAppendRecord),
      journal_fingerprint: computeJournalFingerprint(
        unsignedRecord as JournalAppendRecord,
      ),
    };
    const line = `${canonicalJson(committed)}\n`;
    // O_APPEND single writeSync + fsync: one complete line per append by contract.
    withContainedOperations(runDir, (operations) => {
      const filePath = "journal.jsonl";
      let fd: number;
      try {
        fd = operations.open(
          filePath,
          fsConstants.O_APPEND |
            fsConstants.O_CREAT |
            fsConstants.O_WRONLY |
            (fsConstants.O_NONBLOCK ?? 0),
        );
        assertPrivateRegularFile(fd, filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ELOOP") {
          throw new JournalCorruptionError(
            `journal ${filePath} is a symbolic link`,
            1,
          );
        }
        throw error;
      }
      try {
        const initialSize = fstatSync(fd).size;
        assertOwnership?.();
        let writeCompleted = false;
        try {
          writeSync(fd, line);
          writeCompleted = true;
          fsyncSync(fd);
          // This is the publication boundary.  If ownership was lost while
          // the write/fsync was in flight, remove only our suffix through the
          // original fd before allowing the stale transition to escape.
          assertOwnership?.();
        } catch (error) {
          if (writeCompleted) {
            try {
              const size = fstatSync(fd).size;
              const expectedSize = initialSize + Buffer.byteLength(line);
              if (size === expectedSize) {
                ftruncateSync(fd, initialSize);
                fsyncSync(fd);
              }
            } catch {
              // If another writer appended to this inode, or the descriptor
              // became unusable, leave the durable suffix for fail-closed
              // replay rather than truncating unrelated data.
            }
          }
          throw error;
        }
      } finally {
        closeSync(fd);
      }
    });
  }

  private runDir(): RunDirHandle {
    if (this.runId === undefined) {
      throw new Error(
        "FileJournal is not bound to a run; pass runId to the constructor",
      );
    }
    return (
      this.handle ?? resolveRunDirHandle(this.runsRoot, this.runId)
    );
  }

  async readAll(): Promise<readonly JournalRecord[]> {
    const runDir = this.runDir();
    const filePath = join(runDir.path, "journal.jsonl");
    let content: string;
    try {
      content = readContainedFileNoFollow(runDir, "journal.jsonl");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new JournalCorruptionError(
          `journal ${filePath} is a symbolic link`,
          1,
        );
      }
      throw error;
    }
    if (content.length === 0) {
      return [];
    }

    const lines = content.split("\n");
    const tailIsIncomplete = lines[lines.length - 1] !== "";
    // Complete lines are everything before the final split element (which is
    // "" for a well-formed file, or the partial tail being dropped).
    const bodyLines = lines.slice(0, -1);

    // Count ALL bad lines (interior + incomplete tail) before throwing once.
    let badCount = tailIsIncomplete ? 1 : 0;
    const records: JournalRecord[] = [];
    let prevSeq = -1;

    for (const line of bodyLines) {
      let failure: string | null = null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        failure = "line is not valid JSON";
      }
      if (failure === null) {
        failure = envelopeError(parsed);
      }
      if (failure === null) {
        const record = parsed as JournalRecord;
        const expectedSeq = prevSeq + 1;
        if (record.seq !== expectedSeq) {
          failure = `seq ${record.seq} does not continue from ${prevSeq}`;
        } else {
          prevSeq = record.seq;
          records.push(record);
        }
      }
      if (failure !== null) {
        badCount += 1;
      }
    }

    if (badCount > 0) {
      throw new JournalCorruptionError(
        `journal ${filePath} has ${badCount} corrupt or incomplete record(s)`,
        badCount,
      );
    }
    return records;
  }
}
