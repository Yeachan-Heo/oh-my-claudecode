import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "fs";
import { createHash } from "crypto";
import { basename, join, parse, relative, resolve, sep } from "path";
import { getClaudeConfigDir } from "../../utils/config-dir.js";
import { verifyWorkflowDescriptor } from "./pipeline.js";
import type { AutopilotState } from "./types.js";
import { TextDecoder } from "util";

const NAMED_SIGNALS: Record<string, string> = {
  ralplan: "PIPELINE_RALPLAN_COMPLETE",
  execution: "PIPELINE_EXECUTION_COMPLETE",
  ralph: "PIPELINE_RALPH_COMPLETE",
  qa: "PIPELINE_QA_COMPLETE",
};
const TRANSCRIPT_CHUNK_BYTES = 64 * 1024;
const MAX_JSONL_RECORD_BYTES = 8 * 1024 * 1024;
export const WORKFLOW_TRANSCRIPT_RECORD_TOO_LARGE = "workflow_transcript_record_too_large";
const namedWorkflowTranscriptFailures = new Map<string, string>();
export function takeNamedWorkflowTranscriptFailure(sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  const failure = namedWorkflowTranscriptFailures.get(sessionId) ?? null;
  namedWorkflowTranscriptFailures.delete(sessionId);
  return failure;
}
function clearNamedWorkflowTranscriptFailure(sessionId: string | undefined): void {
  if (sessionId) namedWorkflowTranscriptFailures.delete(sessionId);
}





type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: RecordValue, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}
function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function validFileIdentity(value: unknown): value is RecordValue {
  return (
    isRecord(value) &&
    exactKeys(value, [
      "device",
      "inode",
      "size",
      "mtimeNs",
      "ctimeNs",
      "contentSha256",
    ]) &&
    safeInteger(value.device) &&
    safeInteger(value.inode) &&
    safeInteger(value.size) &&
    typeof value.mtimeNs === "string" &&
    /^\d+$/.test(value.mtimeNs) &&
    typeof value.ctimeNs === "string" &&
    /^\d+$/.test(value.ctimeNs) &&
    typeof value.contentSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.contentSha256)
  );
}

/** Named persisted state is supported only where its no-follow contract can be enforced. */
export function namedWorkflowRuntimeSupported(): boolean {
  return (
    process.platform === "linux" &&
    typeof constants.O_NOFOLLOW === "number" &&
    typeof constants.O_DIRECTORY === "number" &&
    typeof constants.O_RDONLY === "number" &&
    (() => {
      try {
        return lstatSync("/proc/self/fd").isDirectory();
      } catch {
        return false;
      }
    })() &&
    process.env.OMC_TEST_FLOCK_AVAILABLE !== "0" &&
    (existsSync("/usr/bin/flock") || existsSync("/bin/flock"))
  );
}

function noFollowCanonicalFile(
  path: string,
  root: string,
): { fd: number; path: string } | null {
  const canonicalRoot = realpathSync(root);
  const absolute = resolve(path);
  if (absolute !== path) return null;
  const relativePath = relative(canonicalRoot, absolute);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  )
    return null;
  const pathRoot = parse(absolute).root;
  const components = absolute.slice(pathRoot.length).split(sep).filter(Boolean);
  let fd: number | undefined;
  try {
    fd = openSync(pathRoot, constants.O_RDONLY | constants.O_DIRECTORY);
    for (let index = 0; index < components.length; index += 1) {
      const final = index === components.length - 1;
      const nextFd = openSync(
        `/proc/self/fd/${fd}/${components[index]}`,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          (final ? 0 : constants.O_DIRECTORY),
      );
      const stat = fstatSync(nextFd);
      if ((final && !stat.isFile()) || (!final && !stat.isDirectory())) {
        closeSync(nextFd);
        return null;
      }
      closeSync(fd);
      fd = nextFd;
    }
    const canonicalPath = realpathSync(`/proc/self/fd/${fd}`);
    if (
      canonicalPath !== absolute ||
      !canonicalPath.startsWith(canonicalRoot + sep)
    )
      return null;
    const result = { fd, path: canonicalPath };
    fd = undefined;
    return result;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort descriptor cleanup */
      }
    }
  }
}

function validBoundaryShape(value: unknown, sessionId: string | undefined): boolean {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "transcriptPath",
      "transcriptRoot",
      "transcriptBasename",
      "sessionId",
      "byteOffset",
      "fileIdentity",
    ]) ||
    typeof sessionId !== "string" ||
    value.sessionId !== sessionId ||
    typeof value.transcriptRoot !== "string" ||
    resolve(value.transcriptRoot) !== value.transcriptRoot ||
    typeof value.transcriptPath !== "string" ||
    resolve(value.transcriptPath) !== value.transcriptPath ||
    basename(value.transcriptPath) !== `${sessionId}.jsonl` ||
    value.transcriptBasename !== `${sessionId}.jsonl` ||
    !safeInteger(value.byteOffset) ||
    !validFileIdentity(value.fileIdentity) ||
    value.fileIdentity.size !== value.byteOffset
  )
    return false;
  const relativePath = relative(value.transcriptRoot, value.transcriptPath);
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`)
  );
}

function validBoundary(
  value: unknown,
  sessionId: string | undefined,
  root: string,
): boolean {
  if (!validBoundaryShape(value, sessionId)) return false;
  const boundary = value as unknown as NonNullable<NonNullable<AutopilotState["pipelineTracking"]>["activationBoundary"]>;
  if (boundary.transcriptRoot !== root) return false;
  const opened = noFollowCanonicalFile(boundary.transcriptPath, root);
  if (!opened) return false;
  try {
    const stat = fstatSync(opened.fd);
    const identity = boundary.fileIdentity;
    if (
      stat.dev !== identity.device ||
      stat.ino !== identity.inode ||
      stat.size < boundary.byteOffset ||
      identity.size !== boundary.byteOffset
    )
      return false;
    return hashTranscriptRange(opened.fd, 0, boundary.byteOffset) === identity.contentSha256;
  } catch {
    return false;
  } finally {
    closeSync(opened.fd);
  }
}

function hashTranscriptRange(fd: number, start: number, end: number): string | null {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(TRANSCRIPT_CHUNK_BYTES);
  for (let offset = start; offset < end;) { const count = readSync(fd, chunk, 0, Math.min(chunk.length, end - offset), offset); if (count <= 0) return null; hash.update(chunk.subarray(0, count)); offset += count; }
  return hash.digest("hex");
}
function scanTranscriptJsonl(fd: number, start: number, end: number, sessionId: string, callback?: (line: string, byteOffset: number, lineNumber: number, recordContentSha256: string) => boolean, hash?: ReturnType<typeof createHash>): boolean {
  const chunk = Buffer.allocUnsafe(TRANSCRIPT_CHUNK_BYTES);
  const record = Buffer.allocUnsafe(MAX_JSONL_RECORD_BYTES + 1);
  let recordBytes = 0;
  let byteOffset = start;
  let lineNumber = 0;
  const decodeRecord = (length: number): string | null => {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(record.subarray(0, length));
    } catch {
      return null;
    }
  };
  const emitRecord = (crlf: boolean): boolean => {
    const length = recordBytes - (crlf && recordBytes > 0 && record[recordBytes - 1] === 0x0d ? 1 : 0);
    const line = decodeRecord(length);
    if (line === null) return false;
    return !callback || callback(line, byteOffset, lineNumber, createHash("sha256").update(record.subarray(0, length)).digest("hex"));
  };
  for (let offset = start; offset < end;) {
    const maxRead = recordBytes >= MAX_JSONL_RECORD_BYTES ? 1 : MAX_JSONL_RECORD_BYTES + 1 - recordBytes;
    const count = readSync(fd, chunk, 0, Math.min(chunk.length, end - offset, maxRead), offset);
    if (count <= 0) return false;
    hash?.update(chunk.subarray(0, count));
    for (let index = 0; index < count; index += 1) {
      const byte = chunk[index];
      if (byte === 0x0a) {
        if (!emitRecord(true)) return false;
        byteOffset += recordBytes + 1;
        recordBytes = 0;
        lineNumber += 1;
      } else if ((recordBytes === MAX_JSONL_RECORD_BYTES && byte !== 0x0d) || recordBytes > MAX_JSONL_RECORD_BYTES) {
        namedWorkflowTranscriptFailures.set(sessionId, WORKFLOW_TRANSCRIPT_RECORD_TOO_LARGE);
        return false;
      } else {
        record[recordBytes++] = byte;
      }
    }
    offset += count;
  }
  if (recordBytes > MAX_JSONL_RECORD_BYTES) {
    namedWorkflowTranscriptFailures.set(sessionId, WORKFLOW_TRANSCRIPT_RECORD_TOO_LARGE);
    return false;
  }
  return recordBytes === 0 || emitRecord(false);
}
type StableTranscript = { fd: number; path: string; identity: RecordValue; hashRange: (start: number, end: number) => string | null; scanJsonl: (start: number, end: number, callback?: (line: string, byteOffset: number, lineNumber: number, recordContentSha256: string) => boolean) => boolean };
function closeStableTranscript(transcript: StableTranscript | null): void { if (transcript) closeSync(transcript.fd); }
function readStableTranscript(path: string, sessionId: string, root: string): StableTranscript | null {
  const opened = noFollowCanonicalFile(path, root); if (!opened || opened.path !== path || basename(opened.path) !== `${sessionId}.jsonl`) return null;
  try {
    const before = fstatSync(opened.fd, { bigint: true }); if (!before.isFile()) return null; const size = Number(before.size); const hash = createHash("sha256"); if (!scanTranscriptJsonl(opened.fd, 0, size, sessionId, undefined, hash)) return null; const contentSha256 = hash.digest("hex");
    const after = fstatSync(opened.fd, { bigint: true }); if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return null;
    const fd = opened.fd; opened.fd = -1;
    return { fd, path: opened.path, identity: { device: Number(after.dev), inode: Number(after.ino), size: Number(after.size), mtimeNs: after.mtimeNs.toString(), ctimeNs: after.ctimeNs.toString(), contentSha256 }, hashRange: (start, end) => start >= 0 && end >= start && end <= size ? hashTranscriptRange(fd, start, end) : null, scanJsonl: (start, end, callback) => start >= 0 && end >= start && end <= size ? scanTranscriptJsonl(fd, start, end, sessionId, callback) : false };
  } catch { return null; } finally { if (opened.fd !== -1) closeSync(opened.fd); }
}

function assistantText(record: RecordValue): string | null {
  const content = record.message;
  if (
    !isRecord(content) ||
    !Array.isArray(content.content) ||
    content.content.length === 0
  )
    return null;
  const text: string[] = [];
  for (const block of content.content) {
    if (!isRecord(block)) return null;
    if (
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.trim().length > 0
    ) {
      text.push(block.text);
    } else if (
      block.type === "thinking" &&
      typeof block.thinking === "string"
    ) {
      continue;
    } else if (
      block.type === "redacted_thinking" &&
      typeof block.data === "string"
    ) {
      continue;
    } else {
      return null;
    }
  }
  return text.length > 0 ? text.join("") : null;
}

function authenticatedObservation(
  observation: RecordValue,
  sessionId: string,
  root: string,
): boolean {
  const boundary = observation.activationBoundary as RecordValue;
  const stable = observation.stableFile as RecordValue;
  if (
    !validBoundary(boundary, sessionId, root) ||
    typeof boundary.transcriptPath !== "string"
  )
    return false;
  const transcript = readStableTranscript(
    boundary.transcriptPath,
    sessionId,
    root,
  );
  if (!transcript) return false;
  try {
    if (
      transcript.identity.device !== stable.device ||
      transcript.identity.inode !== stable.inode ||
      Number(transcript.identity.size) < Number(stable.size) ||
      transcript.hashRange(0, Number(stable.size)) !== stable.contentSha256 ||
      Number(observation.byteOffset) < Number(boundary.byteOffset) ||
      Number(observation.byteOffset) >= Number(stable.size)
    )
      return false;

    let matched = false;
    const scanned = transcript.scanJsonl(
      Number(boundary.byteOffset),
      Number(stable.size),
      (line, byteOffset, lineNumber, recordContentSha256) => {
        if (byteOffset !== observation.byteOffset || lineNumber !== observation.lineNumber)
          return true;
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch {
          return false;
        }
        if (!isRecord(record)) return false;
        const message = record.message;
        const text = assistantText(record);
        matched =
          recordContentSha256 === observation.recordContentSha256 &&
          record.sessionId === sessionId &&
          record.type === "assistant" &&
          isRecord(message) &&
          message.role === "assistant" &&
          !record.isMeta &&
          !record.isReplay &&
          !record.replay &&
          !record.meta &&
          text !== null &&
          !text.includes("<local-command-stdout>") &&
          text.trim() === `Signal: ${observation.signalId}`;
        return matched;
      },
    );
    return scanned && matched;
  } finally {
    closeStableTranscript(transcript);
  }
}

export type NamedWorkflowValidation = {
  tracking: NonNullable<AutopilotState["pipelineTracking"]>;
  task: string;
};

/** Validate persisted named workflow structure without filesystem or transcript access. */
export function validateNamedWorkflowStateStructure(
  state: AutopilotState,
  sessionId: string | undefined,
): NamedWorkflowValidation | null {
  if (
    !Object.prototype.hasOwnProperty.call(state, "workflow") ||
    !Object.prototype.hasOwnProperty.call(state, "workflowRunId") ||
    !Object.prototype.hasOwnProperty.call(state, "pipelineTracking")
  ) return null;
  const workflow = state.workflow;
  const tracking = state.pipelineTracking;
  const task = typeof state.prompt === "string" ? state.prompt.trim() : "";
  if (
    !verifyWorkflowDescriptor(workflow) ||
    typeof sessionId !== "string" ||
    typeof state.session_id !== "string" ||
    state.session_id !== sessionId ||
    !isRecord(tracking) ||
    task.length === 0 ||
    typeof state.active !== "boolean" ||
    typeof state.workflowRunId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      state.workflowRunId,
    )
  )
    return null;
  const terminal = state.phase === "complete";
  if (terminal && state.active) return null;
  const maximumStageIndex = terminal
    ? workflow.stages.length
    : workflow.stages.length - 1;
  if (
    !exactKeys(tracking, ["stages", "currentStageIndex", "trackingRevision", "activationBoundary", "completionObservations"]) ||
    !Array.isArray(tracking.stages) ||
    !Array.isArray(tracking.completionObservations) ||
    !safeInteger(tracking.currentStageIndex) ||
    !safeInteger(tracking.trackingRevision) ||
    tracking.currentStageIndex > maximumStageIndex ||
    tracking.trackingRevision !== tracking.currentStageIndex ||
    tracking.completionObservations.length !== tracking.currentStageIndex ||
    (terminal &&
      (tracking.currentStageIndex !== workflow.stages.length ||
        tracking.trackingRevision !== workflow.stages.length ||
        tracking.completionObservations.length !== workflow.stages.length)) ||
    !validBoundaryShape(tracking.activationBoundary, sessionId) ||
    tracking.stages.length !== workflow.stages.length
  )
    return null;
  for (let index = 0; index < tracking.stages.length; index += 1) {
    const stage = tracking.stages[index];
    if (!isRecord(stage)) return null;
    const status = terminal ? "complete" : index < tracking.currentStageIndex ? "complete" : index === tracking.currentStageIndex ? "active" : "pending";
    const keys = status === "complete" ? ["id", "status", "iterations", "startedAt", "completedAt"] : status === "active" ? ["id", "status", "iterations", "startedAt"] : ["id", "status", "iterations"];
    if (!exactKeys(stage, keys) || stage.id !== workflow.stages[index] || stage.status !== status || !safeInteger(stage.iterations) || (stage.startedAt !== undefined && !timestamp(stage.startedAt)) || (stage.completedAt !== undefined && !timestamp(stage.completedAt))) return null;
  }
  let previousObservation: RecordValue | null = null;
  for (let index = 0; index < tracking.completionObservations.length; index += 1) {
    const observation = tracking.completionObservations[index];
    if (!isRecord(observation) || !exactKeys(observation, ["stageId", "sessionId", "signalId", "lineNumber", "byteOffset", "recordContentSha256", "stableFile", "activationBoundary", "observedAt"]) || observation.stageId !== workflow.stages[index] || observation.sessionId !== sessionId || observation.signalId !== NAMED_SIGNALS[String(observation.stageId)] || !safeInteger(observation.lineNumber) || !safeInteger(observation.byteOffset) || typeof observation.recordContentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(observation.recordContentSha256) || !validFileIdentity(observation.stableFile) || !validBoundaryShape(observation.activationBoundary, sessionId) || !timestamp(observation.observedAt)) return null;
    const boundary = observation.activationBoundary as unknown as RecordValue;
    const stable = observation.stableFile as RecordValue;
    if (Number(observation.byteOffset) < Number(boundary.byteOffset) || Number(stable.size) <= Number(observation.byteOffset)) return null;
    if (previousObservation) {
      const previousBoundary = previousObservation.activationBoundary as RecordValue;
      const previousStable = previousObservation.stableFile as RecordValue;
      if (boundary.transcriptPath !== previousBoundary.transcriptPath || boundary.byteOffset !== previousStable.size || JSON.stringify(boundary.fileIdentity) !== JSON.stringify(previousStable)) return null;
    }
    previousObservation = observation;
  }
  if (previousObservation) {
    const current = tracking.activationBoundary as unknown as RecordValue;
    const stable = previousObservation.stableFile as RecordValue;
    const boundary = previousObservation.activationBoundary as RecordValue;
    if (current.transcriptPath !== boundary.transcriptPath || current.byteOffset !== stable.size || JSON.stringify(current.fileIdentity) !== JSON.stringify(stable)) return null;
  }
  if (terminal ? state.phase !== "complete" : state.phase !== workflow.stages[tracking.currentStageIndex]) return null;
  return { tracking: tracking as NonNullable<AutopilotState["pipelineTracking"]>, task };
}

/** Validate the complete descriptor and authenticated transcript chain without mutating state. */
export function validateNamedWorkflowState(
  state: AutopilotState,
  sessionId: string | undefined,
): NamedWorkflowValidation | null {
  clearNamedWorkflowTranscriptFailure(sessionId);
  const structural = validateNamedWorkflowStateStructure(state, sessionId);
  if (!structural) return null;
  const workflow = state.workflow;
  const tracking = state.pipelineTracking;
  const task = typeof state.prompt === "string" ? state.prompt.trim() : "";
  let root: string;
  try {
    root = realpathSync(join(getClaudeConfigDir(), "projects"));
  } catch {
    return null;
  }
  if (
    !verifyWorkflowDescriptor(workflow) ||
    state.session_id !== sessionId ||
    !isRecord(tracking) ||
    task.length === 0 ||
    typeof state.workflowRunId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      state.workflowRunId,
    )
  )
    return null;
  const terminal = state.active === false && state.phase === "complete";
  const maximumStageIndex = terminal
    ? workflow.stages.length
    : workflow.stages.length - 1;
  if (
    !exactKeys(tracking, [
      "stages",
      "currentStageIndex",
      "trackingRevision",
      "activationBoundary",
      "completionObservations",
    ]) ||
    !Array.isArray(tracking.stages) ||
    !Array.isArray(tracking.completionObservations) ||
    !safeInteger(tracking.currentStageIndex) ||
    !safeInteger(tracking.trackingRevision) ||
    tracking.currentStageIndex > maximumStageIndex ||
    tracking.trackingRevision !== tracking.currentStageIndex ||
    tracking.completionObservations.length !== tracking.currentStageIndex ||
    (terminal &&
      (tracking.currentStageIndex !== workflow.stages.length ||
        tracking.trackingRevision !== workflow.stages.length ||
        tracking.completionObservations.length !== workflow.stages.length)) ||
    !validBoundary(tracking.activationBoundary, sessionId, root) ||
    tracking.stages.length !== workflow.stages.length
  )
    return null;
  for (let index = 0; index < tracking.stages.length; index += 1) {
    const stage = tracking.stages[index];
    if (!isRecord(stage)) return null;
    const status = terminal
      ? "complete"
      : index < tracking.currentStageIndex
        ? "complete"
        : index === tracking.currentStageIndex
          ? "active"
          : "pending";
    const keys =
      status === "complete"
        ? ["id", "status", "iterations", "startedAt", "completedAt"]
        : status === "active"
          ? ["id", "status", "iterations", "startedAt"]
          : ["id", "status", "iterations"];
    if (
      !exactKeys(stage, keys) ||
      stage.id !== workflow.stages[index] ||
      stage.status !== status ||
      !safeInteger(stage.iterations) ||
      (stage.startedAt !== undefined && !timestamp(stage.startedAt)) ||
      (stage.completedAt !== undefined && !timestamp(stage.completedAt))
    )
      return null;
  }
  let previousObservation: RecordValue | null = null;
  for (
    let index = 0;
    index < tracking.completionObservations.length;
    index += 1
  ) {
    const observation = tracking.completionObservations[index];
    if (
      !isRecord(observation) ||
      !exactKeys(observation, [
        "stageId",
        "sessionId",
        "signalId",
        "lineNumber",
        "byteOffset",
        "recordContentSha256",
        "stableFile",
        "activationBoundary",
        "observedAt",
      ]) ||
      observation.stageId !== workflow.stages[index] ||
      observation.sessionId !== sessionId ||
      observation.signalId !== NAMED_SIGNALS[String(observation.stageId)] ||
      !safeInteger(observation.lineNumber) ||
      !safeInteger(observation.byteOffset) ||
      typeof observation.recordContentSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(observation.recordContentSha256) ||
      !validFileIdentity(observation.stableFile) ||
      !timestamp(observation.observedAt) ||
      !authenticatedObservation(observation, sessionId!, root)
    )
      return null;
    const boundary = observation.activationBoundary as unknown as RecordValue;
    const stable = observation.stableFile as unknown as RecordValue;
    if (
      Number(observation.byteOffset) < Number(boundary.byteOffset) ||
      Number(stable.size) <= Number(observation.byteOffset)
    )
      return null;
    if (previousObservation) {
      const previousBoundary =
        previousObservation.activationBoundary as RecordValue;
      const previousStable = previousObservation.stableFile as RecordValue;
      if (
        boundary.transcriptPath !== previousBoundary.transcriptPath ||
        boundary.byteOffset !== previousStable.size ||
        JSON.stringify(boundary.fileIdentity) !== JSON.stringify(previousStable)
      )
        return null;
    }
    previousObservation = observation;
  }
  if (previousObservation) {
    const current = tracking.activationBoundary as unknown as RecordValue;
    const stable = previousObservation.stableFile as RecordValue;
    const boundary = previousObservation.activationBoundary as RecordValue;
    if (
      current.transcriptPath !== boundary.transcriptPath ||
      current.byteOffset !== stable.size ||
      JSON.stringify(current.fileIdentity) !== JSON.stringify(stable)
    )
      return null;
  }
  if (
    terminal
      ? state.phase !== "complete"
      : state.phase !== workflow.stages[tracking.currentStageIndex]
  )
    return null;
  return {
    tracking: tracking as NonNullable<AutopilotState["pipelineTracking"]>,
    task,
  };
}

export type PreparedNamedWorkflowAdvance = {
  updated: AutopilotState;
  commitToken: {
    transcriptPath: string;
    transcriptIdentity: RecordValue;
    stageId: string;
    sessionId: string;
    boundary: RecordValue;
    evidenceHash: string;
  };
};

/**
 * Reauthenticate a prepared transcript observation immediately before persistence.
 * Callers must invoke this while holding the state mutation lock.
 */
export function refreshNamedWorkflowBoundaryForCommit(
  advance: PreparedNamedWorkflowAdvance,
): boolean {
  clearNamedWorkflowTranscriptFailure(advance.commitToken.sessionId);
  let root: string;
  try {
    root = realpathSync(join(getClaudeConfigDir(), "projects"));
  } catch {
    return false;
  }
  const token = advance.commitToken;
  const transcript = readStableTranscript(token.transcriptPath, token.sessionId, root);
  if (!transcript) return false;
  try {
    if (
      transcript.path !== token.transcriptPath ||
      !sameFileIdentity(transcript.identity, token.transcriptIdentity)
    ) return false;

    const observation = advance.updated.pipelineTracking?.completionObservations.at(-1);
    if (!observation || !isRecord(observation)) return false;
    const boundary = observation.activationBoundary;
    if (
      !isRecord(boundary) ||
      JSON.stringify(boundary) !== JSON.stringify(token.boundary) ||
      observation.stageId !== token.stageId ||
      observation.sessionId !== token.sessionId ||
      observation.recordContentSha256 !== token.evidenceHash
    ) return false;

    const evidence = findCompletionEvidence(
      transcript,
      Number(boundary.byteOffset),
      Number(transcript.identity.size),
      token.sessionId,
      NAMED_SIGNALS[token.stageId],
    );
    if (!evidence || evidence.hash !== token.evidenceHash) return false;

    advance.updated.pipelineTracking!.activationBoundary = {
      transcriptPath: transcript.path,
      transcriptRoot: root,
      transcriptBasename: `${token.sessionId}.jsonl`,
      sessionId: token.sessionId,
      byteOffset: Number(transcript.identity.size),
      fileIdentity: transcript.identity as never,
    };
    return true;
  } finally {
    closeStableTranscript(transcript);
  }
}

function sameFileIdentity(left: RecordValue, right: RecordValue): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.contentSha256 === right.contentSha256
  );
}

function findCompletionEvidence(
  transcript: StableTranscript,
  boundaryOffset: number,
  endOffset: number,
  sessionId: string,
  signal: string | undefined,
): { byteOffset: number; lineNumber: number; hash: string } | null {
  if (!signal) return null;
  let evidence: { byteOffset: number; lineNumber: number; hash: string } | null = null;
  const valid = transcript.scanJsonl(boundaryOffset, endOffset, (line, byteOffset, lineNumber, hash) => {
    if (line.trim().length === 0) return false;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return false;
    }
    const message = isRecord(record) ? record.message : null;
    const text = isRecord(record) ? assistantText(record) : null;
    if (
      !evidence &&
      isRecord(record) &&
      record.sessionId === sessionId &&
      record.type === "assistant" &&
      isRecord(message) &&
      message.role === "assistant" &&
      !record.isMeta &&
      !record.isReplay &&
      !record.replay &&
      !record.meta &&
      text !== null &&
      !text.includes("<local-command-stdout>") &&
      text.trim() === `Signal: ${signal}`
    ) {
      evidence = {
        byteOffset,
        lineNumber,
        hash,
      };
    }
    return true;
  });
  return valid ? evidence : null;
}

/**
 * Prepare an authenticated, one-stage named workflow transition from its
 * append-only transcript. The caller must persist this exact update atomically.
 */
export function prepareNamedWorkflowAdvance(
  state: AutopilotState,
  sessionId: string | undefined,
): PreparedNamedWorkflowAdvance | null {
  clearNamedWorkflowTranscriptFailure(sessionId);
  const validated = validateNamedWorkflowState(state, sessionId);
  if (!validated || !sessionId || !state.workflow || !state.pipelineTracking)
    return null;

  let root: string;
  try {
    root = realpathSync(join(getClaudeConfigDir(), "projects"));
  } catch {
    return null;
  }
  const boundary = state.pipelineTracking
    .activationBoundary as unknown as RecordValue;
  const transcript = readStableTranscript(
    String(boundary.transcriptPath),
    sessionId,
    root,
  );
  const stageIndex = state.pipelineTracking.currentStageIndex;
  const stageId = state.workflow.stages[stageIndex];
  const signal = NAMED_SIGNALS[stageId];
  if (!transcript) return null;
  if (!signal) {
    closeStableTranscript(transcript);
    return null;
  }

  const evidence = findCompletionEvidence(
    transcript,
    Number(boundary.byteOffset),
    Number(transcript.identity.size),
    sessionId,
    signal,
  );
  if (!evidence) {
    closeStableTranscript(transcript);
    return null;
  }
  const observedAt = new Date().toISOString();
  const updated = structuredClone(state);
  const tracking = updated.pipelineTracking!;
  tracking.stages[stageIndex].status = "complete";
  tracking.stages[stageIndex].completedAt = observedAt;
  const nextIndex = stageIndex + 1;
  tracking.currentStageIndex = nextIndex;
  tracking.trackingRevision += 1;
  tracking.completionObservations.push({
    stageId,
    sessionId,
    signalId: signal,
    lineNumber: evidence.lineNumber,
    byteOffset: evidence.byteOffset,
    recordContentSha256: evidence.hash,
    stableFile: transcript.identity as never,
    activationBoundary: structuredClone(
      state.pipelineTracking!.activationBoundary!,
    ),
    observedAt,
  });
  tracking.activationBoundary = {
    transcriptPath: transcript.path,
    transcriptRoot: root,
    transcriptBasename: `${sessionId}.jsonl`,
    sessionId,
    byteOffset: Number(transcript.identity.size),
    fileIdentity: transcript.identity as never,
  };
  closeStableTranscript(transcript);
  if (nextIndex < updated.workflow!.stages.length) {
    tracking.stages[nextIndex].status = "active";
    tracking.stages[nextIndex].startedAt = observedAt;
    updated.phase = updated.workflow!.stages[nextIndex];
  } else {
    updated.active = false;
    updated.phase = "complete";
    updated.completed_at = observedAt;
  }
  return {
    updated,
    commitToken: {
      transcriptPath: transcript.path,
      transcriptIdentity: transcript.identity,
      stageId,
      sessionId,
      boundary: structuredClone(boundary),
      evidenceHash: evidence.hash,
    },
  };
}
