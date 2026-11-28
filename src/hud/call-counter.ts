/**
 * OMC HUD - Call Counter
 *
 * Counts the tool, agent and skill calls of a transcript. A call is one
 * tool_use id: transcripts can hold the same block in more than one record.
 *
 * Large transcripts are counted over the whole file. Each run reads only what
 * was appended since the checkpoint saved by an earlier run, and at most a
 * fixed number of bytes, so a long backlog is spread over several renders.
 */

import { createHash } from "crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  unlinkSync,
} from "fs";
import { basename, dirname, join } from "path";
import { atomicWriteFileSync } from "../lib/atomic-write.js";

export interface CallCounts {
  toolCallCount: number;
  agentCallCount: number;
  skillCallCount: number;
}

/** What one run leaves for the next; saved as a whole, so it is consistent. */
interface Checkpoint extends CallCounts {
  version: number;
  /** Inode of the counted file; another one means the file was replaced. */
  fileId: string;
  /** Bytes counted so far: the end of a line, unless skippingLine is set. */
  offset: number;
  /** The offset is inside a line that is too long to be counted. */
  skippingLine: boolean;
  /** See digestBefore; detects a rewritten file. */
  anchor: string;
  /** Keys of the calls already counted. */
  seen: string[];
}

const CHECKPOINT_VERSION = 1;
const READ_CHUNK_BYTES = 1024 * 1024;
const MAX_BYTES_PER_RUN = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const ANCHOR_BYTES = 256;
// Bounds memory and checkpoint size; later calls are no longer de-duplicated.
const MAX_SEEN_CALLS = 100_000;
// A younger temp file may belong to a write that is still in progress.
const STALE_TEMP_AGE_MS = 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const TOOL_USE_MARKER = Buffer.from('"tool_use"');
const AGENT_TOOL_NAMES = new Set(["Task", "proxy_Task", "Agent", "proxy_Agent"]);
const SKILL_TOOL_NAMES = new Set(["Skill", "proxy_Skill"]);

export function isAgentTool(name: string): boolean {
  return AGENT_TOOL_NAMES.has(name);
}

export function isSkillTool(name: string): boolean {
  return SKILL_TOOL_NAMES.has(name);
}

function digest(value: string | Buffer): string {
  return createHash("sha1").update(value).digest("base64url").slice(0, 16);
}

/** Count a tool_use block unless its id was counted before. */
export function countCall(
  counts: CallCounts,
  seen: Set<string>,
  id: string,
  name: string,
): void {
  const key = digest(String(id));
  if (seen.has(key)) return;
  if (seen.size < MAX_SEEN_CALLS) seen.add(key);
  counts.toolCallCount++;
  if (isAgentTool(name)) counts.agentCallCount++;
  if (isSkillTool(name)) counts.skillCallCount++;
}

function countLine(line: Buffer, counts: CallCounts, seen: Set<string>): void {
  // Parsing is the expensive part and most lines hold no call.
  if (!line.includes(TOOL_USE_MARKER)) return;
  try {
    const content = JSON.parse(line.toString("utf8"))?.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type === "tool_use" && block.id && block.name) {
        countCall(counts, seen, block.id, block.name);
      }
    }
  } catch {
    // Skip malformed lines
  }
}

/** Digest of the first bytes of the file and of the last ones before offset */
function digestBefore(fd: number, offset: number): string {
  const length = Math.min(ANCHOR_BYTES, offset);
  const buffer = Buffer.alloc(2 * length);
  readSync(fd, buffer, 0, length, 0);
  readSync(fd, buffer, length, length, offset - length);
  return digest(buffer);
}

function isCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function readCheckpoint(statePath: string): Checkpoint | null {
  try {
    const saved = JSON.parse(readFileSync(statePath, "utf8")) as Checkpoint;
    const valid =
      saved.version === CHECKPOINT_VERSION &&
      isCount(saved.offset) &&
      isCount(saved.toolCallCount) &&
      isCount(saved.agentCallCount) &&
      isCount(saved.skillCallCount) &&
      Array.isArray(saved.seen);
    return valid ? saved : null;
  } catch {
    return null;
  }
}

/**
 * Remove what interrupted writes of the checkpoint left next to it: the
 * temporary file and the rollback copy that atomicWriteFileSync creates.
 */
function removeStaleTempFiles(statePath: string): void {
  const dir = dirname(statePath);
  const name = basename(statePath);
  const prefixes = [`.${name}.tmp.`, `${name}.rollback.`];
  try {
    for (const entry of readdirSync(dir)) {
      const ours = prefixes.some(
        (prefix) =>
          entry.startsWith(prefix) && UUID_PATTERN.test(entry.slice(prefix.length)),
      );
      if (!ours) continue;
      try {
        const path = join(dir, entry);
        // The writer creates regular files only; a link is never followed
        const stats = lstatSync(path);
        if (stats.isFile() && Date.now() - stats.mtimeMs > STALE_TEMP_AGE_MS) {
          unlinkSync(path);
        }
      } catch {
        // Another run removed it first
      }
    }
  } catch {
    // No state directory yet
  }
}

/**
 * Count the calls of the whole transcript.
 *
 * @param transcriptPath - Transcript JSONL file
 * @param statePath - Checkpoint file; without it every run starts at byte 0
 * @param maxBytesPerRun - A run stops at the first line end past this budget
 * @param maxLineBytes - Longer lines are skipped, which bounds memory
 * @returns The counts, or null while the checkpoint has not reached the end of
 *   the file, or when the file cannot be read
 */
export function countTranscriptCalls(
  transcriptPath: string,
  statePath?: string,
  maxBytesPerRun: number = MAX_BYTES_PER_RUN,
  maxLineBytes: number = MAX_LINE_BYTES,
): CallCounts | null {
  let fd: number | null = null;
  try {
    fd = openSync(transcriptPath, "r");
    const stats = fstatSync(fd, { bigint: true });
    const size = Number(stats.size);
    const fileId = String(stats.ino);

    const saved = statePath ? readCheckpoint(statePath) : null;
    // The digest also fails for a file cut off before the saved offset.
    const resume =
      saved &&
      saved.fileId === fileId &&
      saved.anchor === digestBefore(fd, saved.offset)
        ? saved
        : null;

    const counts: CallCounts = {
      toolCallCount: resume?.toolCallCount ?? 0,
      agentCallCount: resume?.agentCallCount ?? 0,
      skillCallCount: resume?.skillCallCount ?? 0,
    };
    const seen = new Set<string>(resume?.seen);
    const startOffset = resume?.offset ?? 0;
    let skippingLine = resume?.skippingLine === true;
    let offset = startOffset;
    let position = startOffset;
    let overBudget = false;
    // The bytes of the line in progress that earlier chunks delivered
    let partial: Buffer[] = [];
    let partialBytes = 0;
    const chunkBuffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);

    while (!overBudget && position < size) {
      const bytesRead = readSync(
        fd,
        chunkBuffer,
        0,
        Math.min(chunkBuffer.length, size - position),
        position,
      );
      if (bytesRead <= 0) return null; // The file shrank while being read

      const chunk = chunkBuffer.subarray(0, bytesRead);
      let lineStart = 0;
      let lineEnd = chunk.indexOf(10);
      while (lineEnd !== -1 && !overBudget) {
        if (!skippingLine && partialBytes + lineEnd - lineStart <= maxLineBytes) {
          const rest = chunk.subarray(lineStart, lineEnd);
          countLine(partialBytes ? Buffer.concat([...partial, rest]) : rest, counts, seen);
        }
        skippingLine = false;
        partial = [];
        partialBytes = 0;
        lineStart = lineEnd + 1;
        offset = position + lineStart;
        overBudget = offset - startOffset >= maxBytesPerRun;
        lineEnd = chunk.indexOf(10, lineStart);
      }
      if (overBudget) break;

      const restBytes = bytesRead - lineStart;
      if (partialBytes + restBytes > maxLineBytes) {
        skippingLine = true;
        partial = [];
        partialBytes = 0;
      }
      position += bytesRead;
      if (skippingLine) {
        offset = position;
        overBudget = offset - startOffset >= maxBytesPerRun;
      } else if (restBytes > 0) {
        partial.push(Buffer.from(chunk.subarray(lineStart)));
        partialBytes += restBytes;
      }
    }

    if (statePath && offset !== resume?.offset) {
      const checkpoint: Checkpoint = {
        version: CHECKPOINT_VERSION,
        fileId,
        offset,
        skippingLine,
        anchor: digestBefore(fd, offset),
        ...counts,
        seen: [...seen],
      };
      removeStaleTempFiles(statePath);
      try {
        atomicWriteFileSync(statePath, JSON.stringify(checkpoint));
      } catch {
        // A later run counts these bytes again
      }
    }

    if (overBudget && offset < size) return null;
    // A last line without a newline counts now but stays out of the checkpoint,
    // so it is not counted twice once it is complete.
    if (partialBytes > 0) countLine(Buffer.concat(partial), counts, seen);
    return counts;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
