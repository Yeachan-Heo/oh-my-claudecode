/**
 * Tests for FileProjectionStore (graph runtime v2).
 *
 * Covers round-trip fidelity, missing-file null, fail-closed corruption,
 * descriptor binding (AC-3), and idempotent resave.
 */
import {
  mkdirSync,
  mkdtempSync, realpathSync,
  renameSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileProjectionStore } from "../../runtime/store.js";
import { FileOwnershipFence } from "../../runtime/fence.js";
import type { ProjectionSnapshotEnvelope } from "../../runtime/types.js";
import type { GraphSchedulerProjection } from "../../types.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function makeProjection(): GraphSchedulerProjection {
  return {
    descriptor_hash: HASH_A,
    run_id: "run-1",
    revision_id: "rev-1",
    activations: {},
    cohorts: {},
    branch_tokens: {},
    traversal_counts: { "node-a": 2 },
    committed_transitions: {},
    terminal_verification_activation_ids: [],
  };
}

function makeEnvelope(
  overrides: Partial<ProjectionSnapshotEnvelope> = {},
): ProjectionSnapshotEnvelope {
  return {
    schema_version: 1,
    descriptor_hash: HASH_A,
    run_id: "run-1",
    revision_id: "rev-1",
    epoch: 1,
    saved_at_seq: 0,
    projection: makeProjection(),
    ...overrides,
  };
}

describe("FileProjectionStore", () => {
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(realpathSync(tmpdir()), "omc-projection-store-"));
  });

  afterEach(() => {
    rmSync(runsRoot, { recursive: true, force: true });
  });

  it("round-trips envelope fields and projection deeply", async () => {
    const store = new FileProjectionStore(runsRoot, "run-1");
    const envelope = makeEnvelope({ epoch: 3, saved_at_seq: 7 });
    const snapshot = structuredClone(envelope);

    await store.save(envelope);
    const loaded = await store.load();

    expect(loaded).not.toBeNull();
    expect(loaded?.schema_version).toBe(snapshot.schema_version);
    expect(loaded?.descriptor_hash).toBe(snapshot.descriptor_hash);
    expect(loaded?.run_id).toBe(snapshot.run_id);
    expect(loaded?.revision_id).toBe(snapshot.revision_id);
    expect(loaded?.epoch).toBe(snapshot.epoch);
    expect(loaded?.saved_at_seq).toBe(snapshot.saved_at_seq);
    expect(loaded?.projection).toEqual(snapshot.projection);
  });

  it("returns null when no snapshot exists yet", async () => {
    const store = new FileProjectionStore(runsRoot, "run-missing");
    await expect(store.load()).resolves.toBeNull();
  });

  it("throws code corrupt on unparseable bytes on disk", async () => {
    const runDir = join(runsRoot, "run-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "projection.json"), "{not json");
    const store = new FileProjectionStore(runsRoot, "run-1");

    await expect(store.load()).rejects.toMatchObject({
      name: "ProjectionStoreError",
      code: "corrupt",
    });
  });

  it("fails closed on a structurally incomplete snapshot envelope", async () => {
    const runDir = join(runsRoot, "run-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "projection.json"),
      JSON.stringify({ schema_version: 1, descriptor_hash: HASH_A }),
      "utf8",
    );
    const store = new FileProjectionStore(runsRoot, "run-1");

    await expect(store.load()).rejects.toMatchObject({ code: "corrupt" });
  });

  it("fails closed when projection.json is a symlink", async () => {
    const runDir = join(runsRoot, "run-1");
    const outside = join(runsRoot, "outside.json");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(outside, JSON.stringify(makeEnvelope()), "utf8");
    symlinkSync(outside, join(runDir, "projection.json"));
    const store = new FileProjectionStore(runsRoot, "run-1");

    await expect(store.load()).rejects.toMatchObject({ code: "corrupt" });
  });

  it("rejects a different descriptor_hash over an existing snapshot", async () => {
    const store = new FileProjectionStore(runsRoot, "run-1");
    await store.save(makeEnvelope());

    await expect(
      store.save(makeEnvelope({ descriptor_hash: HASH_B })),
    ).rejects.toMatchObject({ code: "descriptor_mismatch" });
  });

  it("accepts idempotent resave and serves the latest snapshot", async () => {
    const store = new FileProjectionStore(runsRoot, "run-1");
    await store.save(makeEnvelope({ epoch: 1, saved_at_seq: 2 }));
    await store.save(makeEnvelope({ epoch: 2, saved_at_seq: 5 }));

    const loaded = await store.load();
    expect(loaded?.epoch).toBe(2);
    expect(loaded?.saved_at_seq).toBe(5);
  });

  it("rejects a revision_id change for the same run", async () => {
    const store = new FileProjectionStore(runsRoot, "run-1");
    await store.save(makeEnvelope());

    await expect(
      store.save(makeEnvelope({ revision_id: "rev-2" })),
    ).rejects.toMatchObject({ code: "descriptor_mismatch" });
  });

  it("treats corrupt snapshot bytes as cache-miss on save; load stays fail-closed", async () => {
    const runDir = join(runsRoot, "run-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "projection.json"), "{corrupt");
    const store = new FileProjectionStore(runsRoot, "run-1");
    const envelope = makeEnvelope({ epoch: 2, saved_at_seq: 9 });

    await expect(store.load()).rejects.toMatchObject({ code: "corrupt" });
    await expect(store.save(envelope)).resolves.toBeUndefined();
    const loaded = await store.load();
    expect(loaded?.epoch).toBe(2);
    expect(loaded?.saved_at_seq).toBe(9);
  });

  it("rolls back a snapshot when ownership changes at publication", async () => {
    const runDir = join(runsRoot, "run-1");
    mkdirSync(runDir, { recursive: true });
    const fence = new FileOwnershipFence(runsRoot, "run-1", {
      staleGraceMs: 1000,
    });
    await expect(fence.acquire()).resolves.toEqual({
      outcome: "acquired",
      epoch: 1,
    });
    const store = new FileProjectionStore(runsRoot, "run-1");
    const oldEnvelope = makeEnvelope({ epoch: 1, saved_at_seq: 0 });
    await store.save(oldEnvelope, () => fence.assertEpoch(1));

    let checks = 0;
    const assertOwnership = (): void => {
      checks += 1;
      // save() invokes this callback at the atomic writer's after-rename
      // boundary. Replace the lock there to emulate a takeover during
      // publication; the writer must reject and restore oldEnvelope.
      if (checks === 4) {
        renameSync(join(runDir, "owner.lock"), join(runDir, "owner.lock.stolen"));
        writeFileSync(
          join(runDir, "owner.lock"),
          JSON.stringify({ pid: process.pid, epoch: 2, timestamp: Date.now() }),
          "utf8",
        );
      }
      fence.assertEpoch(1);
    };

    await expect(
      store.save(makeEnvelope({ epoch: 1, saved_at_seq: 1 }), assertOwnership),
    ).rejects.toThrow();
    expect(JSON.parse(readFileSync(join(runDir, "projection.json"), "utf8"))).toEqual(
      oldEnvelope,
    );
    await expect(store.load()).resolves.toEqual(oldEnvelope);
  });
});
