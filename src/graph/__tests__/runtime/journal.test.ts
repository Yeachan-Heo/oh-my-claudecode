/**
 * FileJournal tests — round-trip, fail-closed corruption handling (AC-8),
 * and ordered concurrent appends.
 */

import {
  mkdirSync,
  mkdtempSync, realpathSync,
  linkSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeJournalFingerprint,
  FileJournal,
} from "../../runtime/journal.js";
import { FileOwnershipFence } from "../../runtime/fence.js";
import { JournalCorruptionError } from "../../runtime/types.js";
import type {
  JournalAppendRecord,
  JournalRecord,
} from "../../runtime/types.js";

const HASH = "a".repeat(64);

function makeRecord(seq: number): JournalRecord {
  const record = {
    seq,
    epoch: 1,
    descriptor_hash: HASH,
    transition: {
      outcome: "succeeded",
      transition_id: `t-${seq}`,
      activation_id: "act-1",
      node_id: "node-1",
      fingerprint_version: 1,
      request_fingerprint: "fp",
      descriptor_hash: HASH,
      selected_edge_ids: [],
      created_activation_ids: [],
      attempt_id: `attempt-${seq}`,
      evidence_refs: [],
    },
  } satisfies JournalAppendRecord;
  return {
    ...record,
    journal_fingerprint: computeJournalFingerprint(record),
  };
}

describe("FileJournal", () => {
  const tempDirs: string[] = [];

  function makeRunsRoot(): string {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "omc-journal-test-"));
    tempDirs.push(dir);
    return dir;
  }

  function journalPath(runsRoot: string): string {
    return join(runsRoot, "run-1", "journal.jsonl");
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop() as string, { recursive: true, force: true });
    }
  });

  it("round-trips appended records in seq order", async () => {
    // Arrange
    const runsRoot = makeRunsRoot();
    const journal = new FileJournal(runsRoot, "run-1");
    const expected = [makeRecord(0), makeRecord(1), makeRecord(2)];

    // Act
    for (const record of expected) {
      await journal.append(record);
    }
    const records = await journal.readAll();

    // Assert
    expect(records).toEqual(expected);
  });

  it("returns [] when the journal file does not exist", async () => {
    // Arrange
    const runsRoot = makeRunsRoot();
    const journal = new FileJournal(runsRoot, "run-1");

    // Act
    const records = await journal.readAll();

    // Assert
    expect(records).toEqual([]);
  });

  it("returns [] when the journal file is empty", async () => {
    // Arrange
    const runsRoot = makeRunsRoot();
    mkdirSync(join(runsRoot, "run-1"), { recursive: true });
    writeFileSync(journalPath(runsRoot), "", "utf8");
    const journal = new FileJournal(runsRoot, "run-1");

    // Act
    const records = await journal.readAll();

    // Assert
    expect(records).toEqual([]);
  });

  it("fails closed when journal.jsonl is a symlink", async () => {
    const runsRoot = makeRunsRoot();
    const outside = join(makeRunsRoot(), "outside.jsonl");
    writeFileSync(outside, "outside", "utf8");
    mkdirSync(join(runsRoot, "run-1"), { recursive: true });
    symlinkSync(outside, journalPath(runsRoot));
    const journal = new FileJournal(runsRoot, "run-1");

    await expect(journal.readAll()).rejects.toBeInstanceOf(
      JournalCorruptionError,
    );
    await expect(journal.append(makeRecord(0))).rejects.toBeInstanceOf(
      JournalCorruptionError,
    );
    expect(readFileSync(outside, "utf8")).toBe("outside");
  });

  it("fails closed when journal.jsonl is a hardlink to an outside inode", async () => {
    const runsRoot = makeRunsRoot();
    const outside = join(makeRunsRoot(), "outside.jsonl");
    writeFileSync(outside, "outside", "utf8");
    mkdirSync(join(runsRoot, "run-1"), { recursive: true });
    linkSync(outside, journalPath(runsRoot));
    const journal = new FileJournal(runsRoot, "run-1");

    await expect(journal.append(makeRecord(0))).rejects.toThrow(
      "private regular file",
    );
    expect(readFileSync(outside, "utf8")).toBe("outside");
  });

  it("throws JournalCorruptionError with truncatedCount >= 1 on a trailing partial line [AC-8]", async () => {
    // Arrange
    const runsRoot = makeRunsRoot();
    mkdirSync(join(runsRoot, "run-1"), { recursive: true });
    writeFileSync(
      journalPath(runsRoot),
      `${JSON.stringify(makeRecord(0))}\n{"seq":7`,
      "utf8",
    );
    const journal = new FileJournal(runsRoot, "run-1");

    // Act + Assert
    let error: unknown;
    try {
      await journal.readAll();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(JournalCorruptionError);
    expect((error as JournalCorruptionError).truncatedCount).toBeGreaterThanOrEqual(1);
  });

  it("counts all interior corrupt lines before throwing", async () => {
    // Arrange
    const runsRoot = makeRunsRoot();
    mkdirSync(join(runsRoot, "run-1"), { recursive: true });
    writeFileSync(
      journalPath(runsRoot),
      [
        JSON.stringify(makeRecord(0)),
        "{not json",
        JSON.stringify(makeRecord(1)),
        JSON.stringify({ seq: 2, epoch: 0 }),
        "",
      ].join("\n"),
      "utf8",
    );
    const journal = new FileJournal(runsRoot, "run-1");

    // Act + Assert
    let error: unknown;
    try {
      await journal.readAll();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(JournalCorruptionError);
    expect((error as JournalCorruptionError).truncatedCount).toBe(2);
  });

  it("throws when a record skips a seq value", async () => {
    // Arrange
    const runsRoot = makeRunsRoot();
    const journal = new FileJournal(runsRoot, "run-1");
    await journal.append(makeRecord(0));
    await journal.append({ ...makeRecord(2), seq: 2 });

    // Act + Assert
    await expect(journal.readAll()).rejects.toThrow(JournalCorruptionError);
  });

  it("throws when descriptor_hash does not match the hash format", async () => {
    // Arrange
    const runsRoot = makeRunsRoot();
    const journal = new FileJournal(runsRoot, "run-1");
    await journal.append({ ...makeRecord(0), descriptor_hash: "not-a-hash" });

    // Act + Assert
    await expect(journal.readAll()).rejects.toThrow(JournalCorruptionError);
  });

  it("persists exactly five ordered lines under chained concurrent appends", async () => {
    // Arrange
    const runsRoot = makeRunsRoot();
    const journal = new FileJournal(runsRoot, "run-1");
    const records = [0, 1, 2, 3, 4].map(makeRecord);

    // Act: fire all five appends without sequential awaits; chaining via
    // p.then(...) keeps order deterministic.
    let chained: Promise<void> = Promise.resolve();
    for (const record of records) {
      chained = chained.then(() => journal.append(record));
    }
    await chained;

    // Assert
    const lines = readFileSync(journalPath(runsRoot), "utf8")
      .split("\n")
      .filter((line) => line !== "");
    expect(lines).toHaveLength(5);
    const parsed = lines.map((line) => JSON.parse(line) as JournalRecord);
    expect(parsed.map((record) => record.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(await journal.readAll()).toEqual(records);
  });

  it("rolls back a journal line when ownership is lost at publication", async () => {
    const runsRoot = makeRunsRoot();
    const runDir = join(runsRoot, "run-1");
    mkdirSync(runDir, { recursive: true });
    const fence = new FileOwnershipFence(runsRoot, "run-1");
    await expect(fence.acquire()).resolves.toEqual({
      outcome: "acquired",
      epoch: 1,
    });
    let checks = 0;
    const ownershipCheck = () => {
      checks += 1;
      if (checks === 3) {
        // Simulate takeover between the append's write and post-fsync check.
        // The stale append must be removed through its open fd.
        rmSync(join(runDir, "owner.lock"), { force: true });
      }
      fence.assertEpoch(1);
    };
    const journal = new FileJournal(
      runsRoot,
      "run-1",
      undefined,
      ownershipCheck,
    );

    await expect(journal.append(makeRecord(0))).rejects.toThrow("not owned");
    expect(await journal.readAll()).toEqual([]);
  });
});
