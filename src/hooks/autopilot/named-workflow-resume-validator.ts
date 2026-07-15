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

const NAMED_SIGNALS: Record<string, string> = {
  ralplan: "PIPELINE_RALPLAN_COMPLETE",
  execution: "PIPELINE_EXECUTION_COMPLETE",
  ralph: "PIPELINE_RALPH_COMPLETE",
  qa: "PIPELINE_QA_COMPLETE",
};
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

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

function validBoundary(
  value: unknown,
  sessionId: string | undefined,
  root: string,
): boolean {
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
    value.transcriptRoot !== root ||
    value.transcriptBasename !== `${sessionId}.jsonl` ||
    typeof value.transcriptPath !== "string" ||
    basename(value.transcriptPath) !== `${sessionId}.jsonl` ||
    !safeInteger(value.byteOffset) ||
    value.byteOffset > MAX_TRANSCRIPT_BYTES ||
    !validFileIdentity(value.fileIdentity)
  )
    return false;
  const opened = noFollowCanonicalFile(value.transcriptPath, root);
  if (!opened) return false;
  try {
    const stat = fstatSync(opened.fd);
    const identity = value.fileIdentity;
    if (
      stat.dev !== identity.device ||
      stat.ino !== identity.inode ||
      stat.size < value.byteOffset ||
      identity.size !== value.byteOffset
    )
      return false;
    const prefix = Buffer.alloc(value.byteOffset);
    if (readSync(opened.fd, prefix, 0, prefix.length, 0) !== prefix.length)
      return false;
    return (
      createHash("sha256").update(prefix).digest("hex") ===
      identity.contentSha256
    );
  } catch {
    return false;
  } finally {
    closeSync(opened.fd);
  }
}

function readStableTranscript(
  path: string,
  sessionId: string,
  root: string,
): { content: Buffer; path: string; identity: RecordValue } | null {
  const opened = noFollowCanonicalFile(path, root);
  if (
    !opened ||
    opened.path !== path ||
    basename(opened.path) !== `${sessionId}.jsonl`
  )
    return null;
  try {
    const before = fstatSync(opened.fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_TRANSCRIPT_BYTES))
      return null;
    const content = Buffer.alloc(Number(before.size));
    for (let offset = 0; offset < content.length; ) {
      const count = readSync(
        opened.fd,
        content,
        offset,
        content.length - offset,
        offset,
      );
      if (count <= 0) return null;
      offset += count;
    }
    const after = fstatSync(opened.fd, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      return null;
    return {
      content,
      path: opened.path,
      identity: {
        device: Number(after.dev),
        inode: Number(after.ino),
        size: Number(after.size),
        mtimeNs: after.mtimeNs.toString(),
        ctimeNs: after.ctimeNs.toString(),
        contentSha256: createHash("sha256").update(content).digest("hex"),
      },
    };
  } catch {
    return null;
  } finally {
    closeSync(opened.fd);
  }
}

function assistantText(record: RecordValue): string | null {
  const content = record.message;
  if (
    !isRecord(content) ||
    !Array.isArray(content.content) ||
    content.content.length === 0
  )
    return null;
  const text = content.content.map((block) =>
    isRecord(block) &&
    block.type === "text" &&
    typeof block.text === "string" &&
    block.text.trim().length > 0
      ? block.text
      : null,
  );
  return text.every((value) => value !== null) ? text.join("") : null;
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
  if (
    !transcript ||
    transcript.identity.device !== stable.device ||
    transcript.identity.inode !== stable.inode ||
    Number(transcript.identity.size) < Number(stable.size) ||
    createHash("sha256")
      .update(transcript.content.subarray(0, Number(stable.size)))
      .digest("hex") !== stable.contentSha256 ||
    Number(observation.byteOffset) < Number(boundary.byteOffset) ||
    Number(observation.byteOffset) >= Number(stable.size)
  )
    return false;

  const lines = transcript.content
    .subarray(Number(boundary.byteOffset), Number(stable.size))
    .toString("utf8")
    .split(/\n/);
  let byteOffset = Number(boundary.byteOffset);
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const rawLine = lines[lineNumber];
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (
      byteOffset === observation.byteOffset &&
      lineNumber === observation.lineNumber
    ) {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        return false;
      }
      if (!isRecord(record)) return false;
      const message = record.message;
      const text = assistantText(record);
      return (
        createHash("sha256").update(line).digest("hex") ===
          observation.recordContentSha256 &&
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
        text.trim() === `Signal: ${NAMED_SIGNALS[String(observation.stageId)]}`
      );
    }
    byteOffset += Buffer.byteLength(rawLine) + 1;
  }
  return false;
}

export type NamedWorkflowValidation = {
  tracking: NonNullable<AutopilotState["pipelineTracking"]>;
  task: string;
};

/** Validate the complete descriptor and authenticated transcript chain without mutating state. */
export function validateNamedWorkflowState(
  state: AutopilotState,
  sessionId: string | undefined,
): NamedWorkflowValidation | null {
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
    tracking.currentStageIndex >= workflow.stages.length ||
    tracking.trackingRevision !== tracking.currentStageIndex ||
    tracking.completionObservations.length !== tracking.currentStageIndex ||
    !validBoundary(tracking.activationBoundary, sessionId, root) ||
    tracking.stages.length !== workflow.stages.length
  )
    return null;
  for (let index = 0; index < tracking.stages.length; index += 1) {
    const stage = tracking.stages[index];
    if (!isRecord(stage)) return null;
    const status =
      index < tracking.currentStageIndex
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
      Number(stable.size) < Number(observation.byteOffset)
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
  if (state.phase !== workflow.stages[tracking.currentStageIndex]) return null;
  return {
    tracking: tracking as NonNullable<AutopilotState["pipelineTracking"]>,
    task,
  };
}

/**
 * Prepare an authenticated, one-stage named workflow transition from its
 * append-only transcript. The caller must persist this exact update atomically.
 */
export function prepareNamedWorkflowAdvance(
  state: AutopilotState,
  sessionId: string | undefined,
): AutopilotState | null {
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
  if (!transcript || !signal) return null;

  let byteOffset = Number(boundary.byteOffset);
  let evidence: { byteOffset: number; lineNumber: number; hash: string } | null =
    null;
  const lines = transcript.content
    .subarray(byteOffset)
    .toString("utf8")
    .split(/\n/);
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const rawLine = lines[lineNumber];
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length === 0) {
      if (lineNumber === lines.length - 1 && line === "") continue;
      return null;
    }

    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return null;
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
        hash: createHash("sha256").update(line).digest("hex"),
      };
    }
    byteOffset += Buffer.byteLength(rawLine) + 1;
  }

  if (!evidence) return null;
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
  if (nextIndex < updated.workflow!.stages.length) {
    tracking.stages[nextIndex].status = "active";
    tracking.stages[nextIndex].startedAt = observedAt;
    tracking.activationBoundary = {
      transcriptPath: transcript.path,
      transcriptRoot: root,
      transcriptBasename: `${sessionId}.jsonl`,
      sessionId,
      byteOffset: Number(transcript.identity.size),
      fileIdentity: transcript.identity as never,
    };
    updated.phase = updated.workflow!.stages[nextIndex];
  } else {
    updated.active = false;
    updated.phase = "complete";
    updated.completed_at = observedAt;
  }
  return updated;
}
