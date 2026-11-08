/**
 * File-backed projection snapshot store (graph runtime v2).
 *
 * Implements ProjectionStore over `<runsRoot>/<run_id>/projection.json`.
 * The journal is the source of truth; this snapshot only accelerates resume
 * and serves status. Every persist goes through temp+rename
 * (atomicWriteJsonSync); every read fails closed on corruption (AC-3).
 */

import { join } from "path";

import {
  atomicWriteJsonSync,
  type AtomicWriteHooks,
} from "../../lib/atomic-write.js";

import { resolveRunDirHandle } from "./run-dir.js";
import type { RunDirHandle } from "./run-dir.js";
import { readContainedFileNoFollow, withContainedOperations } from "./safe-fs.js";
import type {
  ProjectionSnapshotEnvelope,
  ProjectionStore,
} from "./types.js";

const DESCRIPTOR_HASH_PATTERN = /^[a-f0-9]{64}$/;
const PROJECTION_FILE_NAME = "projection.json";

/** Closed error surface for projection snapshot failures. */
export class ProjectionStoreError extends Error {
  readonly code: "descriptor_mismatch" | "corrupt";

  constructor(code: "descriptor_mismatch" | "corrupt", message: string) {
    super(message);
    this.name = "ProjectionStoreError";
    this.code = code;
  }
}

/**
 * Validates an untrusted parsed envelope; returns it typed or throws corrupt.
 * Fail-closed: never returns partial data (AC-3).
 */
function parseStoredEnvelope(raw: unknown): ProjectionSnapshotEnvelope {
  if (typeof raw !== "object" || raw === null) {
    throw new ProjectionStoreError(
      "corrupt",
      "projection snapshot is not a JSON object",
    );
  }
  const candidate = raw as ProjectionSnapshotEnvelope;
  if (candidate.schema_version !== 1) {
    throw new ProjectionStoreError(
      "corrupt",
      `unsupported projection schema_version: ${String(candidate.schema_version)}`,
    );
  }
  if (
    typeof candidate.descriptor_hash !== "string" ||
    !DESCRIPTOR_HASH_PATTERN.test(candidate.descriptor_hash)
  ) {
    throw new ProjectionStoreError(
      "corrupt",
      "descriptor_hash is not a lowercase sha256 hex digest",
    );
  }
  if (typeof candidate.run_id !== "string" || candidate.run_id.length === 0) {
    throw new ProjectionStoreError(
      "corrupt",
      "projection run_id is missing or invalid",
    );
  }
  if (
    typeof candidate.revision_id !== "string" ||
    candidate.revision_id.length === 0
  ) {
    throw new ProjectionStoreError(
      "corrupt",
      "projection revision_id is missing or invalid",
    );
  }
  if (
    typeof candidate.epoch !== "number" ||
    !Number.isInteger(candidate.epoch) ||
    candidate.epoch < 1
  ) {
    throw new ProjectionStoreError(
      "corrupt",
      "projection epoch is missing or invalid",
    );
  }
  if (
    typeof candidate.saved_at_seq !== "number" ||
    !Number.isInteger(candidate.saved_at_seq) ||
    candidate.saved_at_seq < -1
  ) {
    throw new ProjectionStoreError(
      "corrupt",
      "projection saved_at_seq is missing or invalid",
    );
  }
  if (
    typeof candidate.projection !== "object" ||
    candidate.projection === null ||
    Array.isArray(candidate.projection)
  ) {
    throw new ProjectionStoreError(
      "corrupt",
      "projection body is missing or invalid",
    );
  }
  return candidate;
}

/** Load/save surface over one run's `<run_id>/projection.json`. */
export class FileProjectionStore implements ProjectionStore {
  private readonly runsRoot: string;
  private readonly runId: string;
  private readonly handle?: RunDirHandle;

  constructor(
    runsRoot: string,
    runId: string,
    runDirHandle?: RunDirHandle,
  ) {
    this.runsRoot = runsRoot;
    this.runId = runId;
    this.handle = runDirHandle;
    if (this.handle === undefined) {
      resolveRunDirHandle(runsRoot, runId);
    }
  }

  private runDir(): RunDirHandle {
    return this.handle ?? resolveRunDirHandle(this.runsRoot, this.runId);
  }

  async save(
    envelope: ProjectionSnapshotEnvelope,
    assertOwnership?: () => void,
  ): Promise<void> {
    if (envelope.schema_version !== 1) {
      throw new ProjectionStoreError(
        "corrupt",
        "envelope schema_version must be 1",
      );
    }

    // Binding check first (AC-3): the path is bound to one descriptor/run/revision.
    // A corrupt snapshot is a cache-miss here, not run-fatal: the journal is
    // the source of truth, so treat it as absent and proceed with the overwrite.
    assertOwnership?.();
    let stored: ProjectionSnapshotEnvelope | null;
    try {
      stored = await this.load();
    } catch (err) {
      if (!(err instanceof ProjectionStoreError) || err.code !== "corrupt") {
        throw err;
      }
      stored = null;
    }
    if (
      stored !== null &&
      (envelope.descriptor_hash !== stored.descriptor_hash ||
        envelope.run_id !== stored.run_id ||
        envelope.revision_id !== stored.revision_id)
    ) {
      throw new ProjectionStoreError(
        "descriptor_mismatch",
        `snapshot path bound to descriptor ${stored.descriptor_hash}, run ${stored.run_id}, revision ${stored.revision_id}`,
      );
    }
    if (
      stored !== null &&
      (envelope.epoch < stored.epoch ||
        (envelope.epoch === stored.epoch &&
          envelope.saved_at_seq < stored.saved_at_seq))
    ) {
      throw new ProjectionStoreError(
        "corrupt",
        `projection snapshot regresses from epoch ${stored.epoch} seq ${stored.saved_at_seq} to epoch ${envelope.epoch} seq ${envelope.saved_at_seq}`,
      );
    }

    withContainedOperations(this.runDir(), (operations) => {
      assertOwnership?.();
      const hooks: AtomicWriteHooks | undefined = assertOwnership
        ? {
            beforeRename: assertOwnership,
            afterRename: assertOwnership,
          }
        : undefined;
      atomicWriteJsonSync(PROJECTION_FILE_NAME, envelope, hooks, operations);
    });
  }

  async load(): Promise<ProjectionSnapshotEnvelope | null> {
    const runDir = this.runDir();
    const filePath = join(runDir.path, PROJECTION_FILE_NAME);
    let content: string;
    try {
      content = readContainedFileNoFollow(runDir, PROJECTION_FILE_NAME);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      if ((err as NodeJS.ErrnoException).code === "ELOOP") {
        throw new ProjectionStoreError(
          "corrupt",
          `projection ${filePath} must not be a symbolic link`,
        );
      }
      throw err;
    }

    try {
      return parseStoredEnvelope(JSON.parse(content));
    } catch (err) {
      if (err instanceof ProjectionStoreError) {
        throw err;
      }
      throw new ProjectionStoreError(
        "corrupt",
        "projection.json is not valid JSON",
      );
    }
  }
}
