#!/usr/bin/env node
/* global console, process, Buffer */
/**
 * Repair a Claude Code transcript that no longer resumes after a Jev compaction
 * (the `compaction` point, hooks/jev-compaction.mjs).
 *
 * Symptom: `claude --resume` (or sending a message to a finished subagent) fails with
 *   API Error: 400 ... `server_tool_use` ids must be unique per assistant turn
 *
 * Cause: the compaction module hands some assistant rows back to the host as they are (the `handle` of the row). The host
 * writes them behind the compaction boundary as copies: a new `uuid`, the same `message.id`. The originals stay in the file
 * before the boundary. On resume the host joins the assistant rows of one `message.id` from the whole file, also rows that
 * are not on the `parentUuid` chain of the last message, so every block of such a message is sent twice. `tool_use`
 * blocks are de-duplicated by id, `server_tool_use` (the advisor tool), `thinking` and `text` blocks are not.
 *
 * Repair: an assistant row that is NOT on the chain, whose `message.id` also belongs to a message on the chain and
 * whose join would repeat a `server_tool_use` id, gets a new `message.id` of the same byte length (the last 4 characters
 * become `Z` and three hex digits). The host then no longer joins it. Nothing else in the row changes. The rows of one
 * message between the same two compaction boundaries get the same new id, so they stay one message. Only rows that stand
 * in the file before the first row of the chain are changed; such a row after it is reported (exit 2), and so is a chain
 * that would still repeat a `server_tool_use` id without the changed rows.
 *
 * Usage: node scripts/jev-repair-transcript.mjs <transcript.jsonl>... [--write] [--json]
 *   default   check only: lists the rows that would change and writes nothing
 *   --write   write the repaired file. A copy of the original goes next to it first (<file>.pre-repair, then
 *             <file>.pre-repair.1 ... when one exists), and the new content replaces the file in one rename.
 *             Close the session that owns the transcript first: a change found just before the rename stops the write.
 *   --json    machine-readable report
 *
 * Pure Node, zero dependencies. Exit codes: 0 nothing to repair (or repaired with --write), 1 rows need repair (check
 * mode), 2 usage error, unreadable file, a write error or a row that cannot be repaired safely (nothing is written then).
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { pathToFileURL } from 'node:url';

// 'Z' + three hex digits: how many distinct new ids one message id can get.
export const SUFFIX_VALUES = 4096;
const SERVER_BLOCK = 'server_tool_use';
const NEWLINE = 0x0a;

class RepairError extends Error {}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const messageIdOf = (row) => (isObject(row.message) && typeof row.message.id === 'string' && row.message.id ? row.message.id : null);

// Whether joining these rows into one message repeats a server_tool_use id.
function repeatsServerId(rows) {
  const ids = rows.flatMap((row) => (Array.isArray(row.object.message.content) ? row.object.message.content : []))
    .filter((block) => isObject(block) && block.type === SERVER_BLOCK && typeof block.id === 'string')
    .map((block) => block.id);
  return ids.length !== new Set(ids).size;
}

// Rows of the transcript with their byte offsets. A line that is not a JSON object contributes nothing.
function readRows(buffer) {
  const rows = [];
  let start = 0;
  let line = 0;
  while (start < buffer.length) {
    let end = buffer.indexOf(NEWLINE, start);
    end = end < 0 ? buffer.length : end + 1; // the line keeps its newline
    line += 1;
    try {
      const object = JSON.parse(buffer.toString('utf8', start, end));
      if (isObject(object)) rows.push({ object, line, offset: start, raw: buffer.subarray(start, end) });
    } catch {
      // not JSON: left as it is
    }
    start = end;
  }
  return rows;
}

// The rows reachable from the last user or assistant row through `parentUuid`, the way the resume walks them.
function chainOf(rows) {
  const byUuid = new Map();
  for (const row of rows) if (typeof row.object.uuid === 'string' && row.object.uuid) byUuid.set(row.object.uuid, row);
  let leaf = null;
  for (const row of rows) {
    if (byUuid.has(row.object.uuid) && (row.object.type === 'user' || row.object.type === 'assistant')) leaf = row;
  }
  const chain = new Set();
  const seen = new Set();
  for (let current = leaf; current && !seen.has(current.object.uuid); ) {
    seen.add(current.object.uuid);
    chain.add(current);
    const parent = current.object.parentUuid;
    current = typeof parent === 'string' && parent ? byUuid.get(parent) : null;
  }
  return chain;
}

// A message id not used in the file yet: the last 4 characters become 'Z' and three hex digits.
function freshId(messageId, used, counter) {
  const head = messageId.slice(0, -4);
  for (let tries = 0; tries < SUFFIX_VALUES; tries += 1) {
    counter.n += 1;
    const candidate = `${head}Z${(counter.n % SUFFIX_VALUES).toString(16).padStart(3, '0')}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  throw new RepairError(`no free message id left for ${messageId}: all ${SUFFIX_VALUES} suffixes of "${head}Z..." are taken`);
}

// The row with its message id replaced in place (same byte length), checked by parsing it again.
function rewriteRow(row, newId) {
  const oldId = messageIdOf(row.object);
  const needle = Buffer.from(`"id":"${oldId}"`);
  const replacement = Buffer.from(`"id":"${newId}"`);
  if (replacement.length !== needle.length) throw new RepairError(`line ${row.line}: message id ${oldId} cannot be replaced by a name of the same length`);
  const messageAt = row.raw.indexOf('"message":');
  const at = row.raw.indexOf(needle, messageAt < 0 ? 0 : messageAt);
  if (at < 0) throw new RepairError(`line ${row.line}: the text "id":"${oldId}" was not found in the row (unusual spacing or escaping)`);
  const fixed = Buffer.concat([row.raw.subarray(0, at), replacement, row.raw.subarray(at + needle.length)]);
  const check = JSON.parse(fixed.toString('utf8'));
  if (check.message?.id !== newId || check.uuid !== row.object.uuid) throw new RepairError(`line ${row.line}: the rewritten row does not parse back as expected`);
  check.message.id = oldId;
  if (JSON.stringify(check) !== JSON.stringify(row.object)) throw new RepairError(`line ${row.line}: the rewritten row differs in more than the message id`);
  return fixed;
}

/**
 * Plan the repair of one transcript (a Buffer of JSONL).
 * Returns { rows, chain, messages, fixes: [{ line, offset, messageId, newId, uuid, fixed }] }; throws RepairError when a
 * row cannot be repaired safely.
 */
export function planRepair(buffer) {
  const rows = readRows(buffer);
  const chain = chainOf(rows);
  const rowsOfMessage = new Map();
  const used = new Set();
  for (const row of rows) {
    const id = messageIdOf(row.object);
    if (!id) continue;
    used.add(id);
    if (row.object.type !== 'assistant') continue;
    if (!rowsOfMessage.has(id)) rowsOfMessage.set(id, []);
    rowsOfMessage.get(id).push(row);
  }
  const chainMessages = new Set();
  for (const row of chain) if (row.object.type === 'assistant' && messageIdOf(row.object)) chainMessages.add(messageIdOf(row.object));
  // The copies come from earlier in the file: after a compaction the chain starts at its boundary row.
  let chainStart = Infinity;
  for (const row of chain) chainStart = Math.min(chainStart, row.offset);
  const boundaries = rows.filter((row) => row.object.type === 'system' && row.object.subtype === 'compact_boundary').map((row) => row.offset);
  const stretchOf = (row) => boundaries.filter((offset) => offset < row.offset).length;

  const fixes = [];
  const counter = { n: 0 };
  const affected = new Set();
  for (const messageId of chainMessages) {
    const group = rowsOfMessage.get(messageId);
    if (!repeatsServerId(group)) continue; // the join would not repeat a server_tool_use id
    const newIds = new Map(); // one new id per stretch between boundaries: the rows of one message stay one message
    for (const row of group) {
      if (chain.has(row)) continue;
      if (row.offset > chainStart) throw new RepairError(`line ${row.line}: a row of ${messageId} off the chain stands after the start of the chain, so it is not a copy from before a compaction; nothing was changed`);
      const stretch = stretchOf(row);
      if (!newIds.has(stretch)) newIds.set(stretch, freshId(messageId, used, counter));
      const newId = newIds.get(stretch);
      fixes.push({ line: row.line, offset: row.offset, messageId, newId, uuid: row.object.uuid ?? null, fixed: rewriteRow(row, newId) });
      affected.add(messageId);
    }
    if (repeatsServerId(group.filter((row) => chain.has(row)))) throw new RepairError(`${messageId} repeats a server_tool_use id on the chain itself, which changing rows off the chain does not repair; nothing was changed`);
  }
  fixes.sort((a, b) => a.line - b.line);
  return { rows: rows.length, chain: chain.size, messages: affected.size, fixes };
}

/** The transcript with the planned rows replaced (same length as the input). */
export function applyRepair(buffer, fixes) {
  const out = Buffer.from(buffer);
  for (const fix of fixes) fix.fixed.copy(out, fix.offset);
  return out;
}

function freeBackupPath(path) {
  for (let n = 0; ; n += 1) {
    const candidate = n === 0 ? `${path}.pre-repair` : `${path}.pre-repair.${n}`;
    if (!existsSync(candidate)) return candidate;
  }
}

/**
 * Write `repaired` over `path`: a copy of `original` (the bytes that were repaired) next to it first, then a temporary file
 * in the same directory and one rename. The write stops, and the copy is removed again, when the file is no longer what
 * `original` holds just before the rename (a row appended after that check is lost, so the session has to be closed).
 * Returns the path of the copy.
 */
export function writeRepaired(path, original, repaired) {
  const mode = statSync(path).mode & 0o777;
  const backup = freeBackupPath(path);
  let backupCreated = false;
  let fd = null;
  let created = false;
  try {
    // Marked as created as soon as the exclusive open succeeds, so a write that fails afterwards (ENOSPC,
    // EFBIG) removes the truncated copy instead of leaving it under the backup name.
    fd = openSync(backup, 'wx', mode);
    backupCreated = true;
    let copied = 0;
    while (copied < original.length) copied += writeSync(fd, original, copied, original.length - copied);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    const temp = `${path}.repair-${process.pid}.tmp`;
    fd = openSync(temp, 'wx', mode);
    created = true;
    let written = 0;
    while (written < repaired.length) written += writeSync(fd, repaired, written, repaired.length - written);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    chmodSync(temp, mode);
    if (!readFileSync(path).equals(original)) throw new RepairError(`${path} changed while it was being repaired (is the session still running?); nothing was written`);
    renameSync(temp, path);
  } catch (error) {
    if (fd !== null) closeSync(fd);
    if (created) {
      try {
        unlinkSync(`${path}.repair-${process.pid}.tmp`);
      } catch {
        // no temporary file left
      }
    }
    if (backupCreated) {
      try {
        unlinkSync(backup); // the copy belongs to this write only
      } catch {
        // no backup left
      }
    }
    throw error;
  }
  return backup;
}

/** Check (and with write: repair) one transcript file. Returns the report; throws RepairError for an unusable file. */
export function repairTranscript(path, { write = false } = {}) {
  let original;
  try {
    original = readFileSync(path);
  } catch (error) {
    throw new RepairError(`cannot read ${path}: ${error.code || error.message}`);
  }
  const plan = planRepair(original);
  const report = {
    path,
    rows: plan.rows,
    chainRows: plan.chain,
    messages: plan.messages,
    rowsToRepair: plan.fixes.length,
    fixes: plan.fixes.map(({ line, messageId, newId }) => ({ line, messageId, newId })),
    written: false,
    backup: null,
  };
  if (write && plan.fixes.length) {
    report.backup = writeRepaired(path, original, applyRepair(original, plan.fixes));
    report.written = true;
  }
  return report;
}

function usage() {
  return 'usage: node scripts/jev-repair-transcript.mjs <transcript.jsonl>... [--write] [--json]';
}

function formatReport(report) {
  const lines = [`${report.path}: ${report.rows} rows, ${report.chainRows} on the chain`];
  if (!report.rowsToRepair) {
    lines.push('  nothing to repair');
    return lines.join('\n');
  }
  lines.push(`  ${report.rowsToRepair} rows outside the chain (of ${report.messages} messages) would rejoin their messages on resume`);
  for (const fix of report.fixes) lines.push(`  line ${fix.line}: ${fix.messageId} -> ${fix.newId}`);
  lines.push(report.written ? `  written; copy of the original: ${report.backup}` : '  check only, nothing written (add --write to repair)');
  return lines.join('\n');
}

export function main(argv) {
  let write = false;
  let json = false;
  const paths = [];
  for (const arg of argv) {
    if (arg === '--write') write = true;
    else if (arg === '--json') json = true;
    else if (arg.startsWith('--')) {
      console.error(`unknown flag: ${arg}\n${usage()}`);
      return 2;
    } else paths.push(arg);
  }
  if (!paths.length) {
    console.error(usage());
    return 2;
  }
  let exit = 0;
  const reports = [];
  for (const path of paths) {
    let report;
    try {
      report = repairTranscript(path, { write });
      if (report.rowsToRepair && !report.written) exit = Math.max(exit, 1);
    } catch (error) {
      // A write error (EEXIST, EACCES, ENOSPC ...) is not a RepairError but ends this file the same way.
      const detail = error instanceof RepairError ? error.message : `write failed: ${error?.code || error?.message || error}`;
      report = { path, error: detail };
      exit = 2;
    }
    reports.push(report);
    if (!json) console.log(report.error ? `${report.path}: ERROR ${report.error}` : formatReport(report));
  }
  if (json) console.log(JSON.stringify(reports, null, 2));
  return exit;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = main(process.argv.slice(2));
