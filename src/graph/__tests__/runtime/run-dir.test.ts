/**
 * Run-directory containment tests (P1-3): malformed run ids are rejected,
 * symlinked run directories fail closed before any write escapes the runs
 * root, and legitimate resolution keeps every artifact inside the root.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mkdirInterlock = vi.hoisted(() => ({
  before: undefined as ((path: unknown) => void) | undefined,
}));

vi.mock("../../runtime/contained-fd.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../runtime/contained-fd.js")>();
  return {
    ...actual,
    directoryOperations: (...args: Parameters<typeof actual.directoryOperations>) => {
      const operations = actual.directoryOperations(...args);
      return {
        ...operations,
        mkdir: (name: string, mode?: number) => {
          mkdirInterlock.before?.(name);
          operations.mkdir(name, mode);
        },
      };
    },
  };
});
import { resolveRunDir } from "../../runtime/run-dir.js";
import { FileOwnershipFence } from "../../runtime/fence.js";
import {
  computeJournalFingerprint,
  FileJournal,
} from "../../runtime/journal.js";
import { FileProjectionStore } from "../../runtime/store.js";
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

describe("resolveRunDir containment [P1-3]", () => {
  const tempDirs: string[] = [];

  function makeRunsRoot(): string {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "omc-rundir-test-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop() as string, { recursive: true, force: true });
    }
  });

  it("rejects malformed run ids with RangeError", () => {
    // Arrange
    const runsRoot = makeRunsRoot();

    // Act / Assert
    for (const bad of ["../x", "a/b", "a\\b", "", ".", ".."]) {
      expect(() => resolveRunDir(runsRoot, bad), JSON.stringify(bad)).toThrow(
        RangeError,
      );
      expect(
        () => resolveRunDir(runsRoot, bad),
        JSON.stringify(bad),
      ).toThrow("invalid run_id");
    }
  });

  it("creates the run directory inside the runs root and returns the joined path", () => {
    // Arrange
    const runsRoot = makeRunsRoot();

    // Act
    const runDir = resolveRunDir(runsRoot, "run-contained");

    // Assert
    expect(runDir).toBe(join(runsRoot, "run-contained"));
    const runsRootReal = realpathSync(runsRoot);
    const resolved = realpathSync(runDir);
    expect(
      resolved.toLowerCase().startsWith(`${runsRootReal.toLowerCase()}\\`) ||
        resolved.startsWith(`${runsRootReal}/`),
    ).toBe(true);
  });

  it("fails closed on a symlinked run directory and writes nothing outside the root", async () => {
    // Arrange
    const runsRoot = makeRunsRoot();
    const outside = makeRunsRoot();
    mkdirSync(join(outside, "escape-target"), { recursive: true });
    symlinkSync(
      join(outside, "escape-target"),
      join(runsRoot, "run-victim"),
      "dir",
    );

    // Act / Assert — resolution itself refuses.
    expect(() => resolveRunDir(runsRoot, "run-victim")).toThrow(
      "run directory must not be a symbolic link",
    );

    // Persistence components route through the same helper: use-time failure,
    // nothing materialized outside the runs root.
    await expect(
      new FileJournal(runsRoot, "run-victim").append(makeRecord(0)),
    ).rejects.toThrow("symbolic link");
    await expect(
      new FileOwnershipFence(runsRoot, "run-victim").acquire(),
    ).rejects.toThrow("symbolic link");
    expect(() => new FileProjectionStore(runsRoot, "run-victim")).toThrow(
      "symbolic link",
    );
    expect(readdirSync(join(outside, "escape-target"))).toEqual([]);
    expect(existsSync(join(outside, "escape-target", "journal.jsonl"))).toBe(
      false,
    );
    expect(existsSync(join(outside, "escape-target", "owner.lock"))).toBe(false);
    expect(existsSync(join(outside, "escape-target", "projection.json"))).toBe(
      false,
    );
  });

  it("anchors target creation to the original root when its pathname is replaced", () => {
    // Arrange: replace the root pathname immediately before the target mkdir.
    const runsRoot = makeRunsRoot();
    const outside = makeRunsRoot();
    const runId = "run-root-replaced";
    const target = join(runsRoot, runId);
    const originalRoot = `${runsRoot}-original`;
    let swapped = false;
    mkdirInterlock.before = (path) => {
      if (
        !swapped &&
        typeof path === "string" &&
        path === runId
      ) {
        swapped = true;
        renameSync(runsRoot, originalRoot);
        symlinkSync(outside, runsRoot, "dir");
      }
    };

    try {
      // Act: the FD-anchored implementation keeps creating in originalRoot,
      // then fails closed because the validated root pathname was replaced.
      expect(() => resolveRunDir(runsRoot, runId)).toThrow("escapes");
    } finally {
      mkdirInterlock.before = undefined;
      rmSync(runsRoot, { recursive: true, force: true });
      renameSync(originalRoot, runsRoot);
    }

    // Assert: no directory was created below the replacement target.
    expect(swapped).toBe(true);
    expect(existsSync(join(outside, runId))).toBe(false);
    expect(existsSync(target)).toBe(true);
  });

  it("does not follow a target symlink installed during creation", () => {
    // Arrange: install a symlink between the absent check and mkdir attempt.
    const runsRoot = makeRunsRoot();
    const outside = makeRunsRoot();
    const runId = "run-target-replaced";
    const target = join(runsRoot, runId);
    const escaped = join(outside, "created-outside");
    let swapped = false;
    mkdirInterlock.before = (path) => {
      if (
        !swapped &&
        typeof path === "string" &&
        path === runId
      ) {
        swapped = true;
        symlinkSync(escaped, target, "dir");
      }
    };

    try {
      // Act / Assert: the replacement is rejected before any outside mkdir.
      expect(() => resolveRunDir(runsRoot, runId)).toThrow(
        "run directory must not be a symbolic link",
      );
    } finally {
      mkdirInterlock.before = undefined;
    }

    expect(swapped).toBe(true);
    expect(existsSync(escaped)).toBe(false);
  });

  it("keeps component writes inside the runs root for a legitimate run id", async () => {
    // Arrange
    const runsRoot = makeRunsRoot();

    // Act
    const journal = new FileJournal(runsRoot, "run-inside");
    await journal.append(makeRecord(0));
    new FileProjectionStore(runsRoot, "run-inside");
    const fence = new FileOwnershipFence(runsRoot, "run-inside");
    const acquired = await fence.acquire();

    // Assert — every artifact landed under <runsRoot>/run-inside.
    expect(acquired.outcome).toBe("acquired");
    const entries = readdirSync(join(runsRoot, "run-inside")).sort();
    expect(entries).toEqual(["journal.jsonl", "owner.epoch", "owner.lock"]);
    expect(readdirSync(runsRoot)).toEqual(["run-inside"]);
    await fence.release((acquired as { epoch: number }).epoch);
  });
});
