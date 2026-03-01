// src/team/inbox-outbox.ts
/**
 * Inbox/Outbox JSONL Messaging for MCP Team Bridge
 *
 * File-based communication channels between team lead and MCP workers.
 * Uses JSONL format with offset cursor for efficient incremental reads.
 */
import { readFileSync, existsSync, statSync, unlinkSync, renameSync, openSync, readSync, closeSync } from 'fs';
import { join, dirname } from 'path';
import { getClaudeConfigDir } from '../utils/paths.js';
import { sanitizeName } from './tmux-session.js';
import { appendFileWithMode, writeFileWithMode, atomicWriteJson, ensureDirWithMode, validateResolvedPath } from './fs-utils.js';
/** Maximum bytes to read from inbox in a single call (10 MB) */
const MAX_INBOX_READ_SIZE = 10 * 1024 * 1024;
// --- Path helpers ---
function teamsDir(teamName) {
    const result = join(getClaudeConfigDir(), 'teams', sanitizeName(teamName));
    validateResolvedPath(result, join(getClaudeConfigDir(), 'teams'));
    return result;
}
function inboxPath(teamName, workerName) {
    return join(teamsDir(teamName), 'inbox', `${sanitizeName(workerName)}.jsonl`);
}
function inboxCursorPath(teamName, workerName) {
    return join(teamsDir(teamName), 'inbox', `${sanitizeName(workerName)}.offset`);
}
function outboxPath(teamName, workerName) {
    return join(teamsDir(teamName), 'outbox', `${sanitizeName(workerName)}.jsonl`);
}
function signalPath(teamName, workerName) {
    return join(teamsDir(teamName), 'signals', `${sanitizeName(workerName)}.shutdown`);
}
function drainSignalPath(teamName, workerName) {
    return join(teamsDir(teamName), 'signals', `${sanitizeName(workerName)}.drain`);
}
/** Ensure directory exists for a file path */
function ensureDir(filePath) {
    const dir = dirname(filePath);
    ensureDirWithMode(dir);
}
// --- Outbox (worker -> lead) ---
/**
 * Append a message to the outbox JSONL file.
 * Creates directories if needed.
 */
export function appendOutbox(teamName, workerName, message) {
    const filePath = outboxPath(teamName, workerName);
    ensureDir(filePath);
    appendFileWithMode(filePath, JSON.stringify(message) + '\n');
}
/**
 * Rotate outbox if it exceeds maxLines.
 * Keeps the most recent maxLines/2 entries, discards older.
 * Prevents unbounded growth.
 *
 * NOTE: Rotation events are not audit-logged here to avoid circular dependency
 * on audit-log.ts. The caller (e.g., mcp-team-bridge.ts) should log rotation
 * events using the 'outbox_rotated' audit event type after calling this function.
 */
export function rotateOutboxIfNeeded(teamName, workerName, maxLines) {
    const filePath = outboxPath(teamName, workerName);
    if (!existsSync(filePath))
        return;
    try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        if (lines.length <= maxLines)
            return;
        // Keep the most recent half
        const keepCount = Math.floor(maxLines / 2);
        // When keepCount is 0 (maxLines <= 1), slice(-0) returns the full array — a no-op.
        // Explicitly clear in that case instead.
        const kept = keepCount === 0 ? [] : lines.slice(-keepCount);
        const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
        writeFileWithMode(tmpPath, kept.join('\n') + '\n');
        renameSync(tmpPath, filePath);
    }
    catch {
        // Rotation failure is non-fatal
    }
}
/**
 * Rotate inbox if it exceeds maxSizeBytes.
 * Keeps the most recent half of lines, discards older.
 * Prevents unbounded growth of inbox files.
 *
 * NOTE: Rotation events are not audit-logged here to avoid circular dependency
 * on audit-log.ts. The caller (e.g., mcp-team-bridge.ts) should log rotation
 * events using the 'inbox_rotated' audit event type after calling this function.
 */
export function rotateInboxIfNeeded(teamName, workerName, maxSizeBytes) {
    const filePath = inboxPath(teamName, workerName);
    if (!existsSync(filePath))
        return;
    try {
        const stat = statSync(filePath);
        if (stat.size <= maxSizeBytes)
            return;
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        // Keep the most recent half
        const keepCount = Math.max(1, Math.floor(lines.length / 2));
        const kept = lines.slice(-keepCount);
        const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
        writeFileWithMode(tmpPath, kept.join('\n') + '\n');
        renameSync(tmpPath, filePath);
        // Reset cursor since file content changed
        const cursorFile = inboxCursorPath(teamName, workerName);
        atomicWriteJson(cursorFile, { bytesRead: 0 });
    }
    catch {
        // Rotation failure is non-fatal
    }
}
// --- Inbox (lead -> worker) ---
/**
 * Read new inbox messages using offset cursor.
 *
 * Uses byte-offset cursor to avoid clock skew issues:
 * 1. Read cursor from {worker}.offset file (default: 0)
 * 2. Open inbox JSONL, seek to offset
 * 3. Read from offset to EOF
 * 4. Parse new JSONL lines
 * 5. Update cursor to new file position
 *
 * Handles file truncation (cursor > file size) by resetting cursor.
 */
export function readNewInboxMessages(teamName, workerName) {
    const inbox = inboxPath(teamName, workerName);
    const cursorFile = inboxCursorPath(teamName, workerName);
    if (!existsSync(inbox))
        return [];
    // Read cursor
    let offset = 0;
    if (existsSync(cursorFile)) {
        try {
            const cursor = JSON.parse(readFileSync(cursorFile, 'utf-8'));
            offset = cursor.bytesRead;
        }
        catch { /* reset to 0 */ }
    }
    // Check file size
    const stat = statSync(inbox);
    // Handle file truncation (cursor beyond file size)
    if (stat.size < offset) {
        offset = 0;
    }
    if (stat.size <= offset)
        return []; // No new data
    // Read from offset (capped to prevent OOM on huge inboxes)
    const readSize = stat.size - offset;
    const cappedSize = Math.min(readSize, MAX_INBOX_READ_SIZE);
    if (cappedSize < readSize) {
        console.warn(`[inbox-outbox] Inbox for ${workerName} exceeds ${MAX_INBOX_READ_SIZE} bytes, reading truncated`);
    }
    const fd = openSync(inbox, 'r');
    const buffer = Buffer.alloc(cappedSize);
    try {
        readSync(fd, buffer, 0, buffer.length, offset);
    }
    finally {
        closeSync(fd);
    }
    const newData = buffer.toString('utf-8');
    // Find the last newline in the buffer to avoid processing partial trailing lines.
    // This prevents livelock when the capped buffer ends mid-line: we only process
    // up to the last complete line boundary and leave the partial for the next read.
    const lastNewlineIdx = newData.lastIndexOf('\n');
    if (lastNewlineIdx === -1) {
        // No complete line in buffer — don't advance cursor, wait for more data
        return [];
    }
    const completeData = newData.substring(0, lastNewlineIdx + 1);
    const messages = [];
    let bytesProcessed = 0;
    const lines = completeData.split('\n');
    // Remove trailing empty string from split — completeData always ends with '\n',
    // so the last element is always '' and doesn't represent real data.
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    for (const line of lines) {
        if (!line.trim()) {
            // Account for the newline separator byte(s). Check for \r\n (CRLF) by
            // looking at whether the line ends with \r (split on \n leaves \r attached).
            bytesProcessed += Buffer.byteLength(line, 'utf-8') + 1; // +1 for the \n
            continue;
        }
        // Strip trailing \r if present (from CRLF line endings)
        const cleanLine = line.endsWith('\r') ? line.slice(0, -1) : line;
        const lineBytes = Buffer.byteLength(line, 'utf-8') + 1; // +1 for the \n
        try {
            messages.push(JSON.parse(cleanLine));
            bytesProcessed += lineBytes;
        }
        catch {
            // Malformed JSONL line: log a warning, advance cursor past it, and continue.
            // Stopping here would permanently wedge the inbox cursor.
            console.warn(`[inbox-outbox] Skipping malformed JSONL line for ${workerName}: ${cleanLine.slice(0, 80)}`);
            bytesProcessed += lineBytes;
        }
    }
    // Advance cursor only through last successfully parsed content
    const newOffset = offset + (bytesProcessed > 0 ? bytesProcessed : 0);
    ensureDir(cursorFile);
    const newCursor = { bytesRead: newOffset > offset ? newOffset : offset };
    atomicWriteJson(cursorFile, newCursor);
    return messages;
}
/** Read ALL inbox messages (for initial load or debugging) */
export function readAllInboxMessages(teamName, workerName) {
    const inbox = inboxPath(teamName, workerName);
    if (!existsSync(inbox))
        return [];
    try {
        const content = readFileSync(inbox, 'utf-8');
        const messages = [];
        for (const line of content.split('\n')) {
            if (!line.trim())
                continue;
            try {
                messages.push(JSON.parse(line));
            }
            catch { /* skip malformed */ }
        }
        return messages;
    }
    catch {
        return [];
    }
}
/** Clear inbox (truncate file + reset cursor) */
export function clearInbox(teamName, workerName) {
    const inbox = inboxPath(teamName, workerName);
    const cursorFile = inboxCursorPath(teamName, workerName);
    if (existsSync(inbox)) {
        try {
            writeFileWithMode(inbox, '');
        }
        catch { /* ignore */ }
    }
    if (existsSync(cursorFile)) {
        try {
            writeFileWithMode(cursorFile, JSON.stringify({ bytesRead: 0 }));
        }
        catch { /* ignore */ }
    }
}
// --- Shutdown signals ---
/** Write a shutdown signal file */
export function writeShutdownSignal(teamName, workerName, requestId, reason) {
    const filePath = signalPath(teamName, workerName);
    ensureDir(filePath);
    const signal = {
        requestId,
        reason,
        timestamp: new Date().toISOString(),
    };
    writeFileWithMode(filePath, JSON.stringify(signal, null, 2));
}
/** Check if shutdown signal exists, return parsed content or null */
export function checkShutdownSignal(teamName, workerName) {
    const filePath = signalPath(teamName, workerName);
    if (!existsSync(filePath))
        return null;
    try {
        const raw = readFileSync(filePath, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
/** Delete the shutdown signal file after processing */
export function deleteShutdownSignal(teamName, workerName) {
    const filePath = signalPath(teamName, workerName);
    if (existsSync(filePath)) {
        try {
            unlinkSync(filePath);
        }
        catch { /* ignore */ }
    }
}
// --- Drain signals ---
/** Write a drain signal for a worker */
export function writeDrainSignal(teamName, workerName, requestId, reason) {
    const filePath = drainSignalPath(teamName, workerName);
    ensureDir(filePath);
    const signal = {
        requestId,
        reason,
        timestamp: new Date().toISOString(),
    };
    writeFileWithMode(filePath, JSON.stringify(signal, null, 2));
}
/** Check if a drain signal exists for a worker */
export function checkDrainSignal(teamName, workerName) {
    const filePath = drainSignalPath(teamName, workerName);
    if (!existsSync(filePath))
        return null;
    try {
        const raw = readFileSync(filePath, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
/** Delete a drain signal file */
export function deleteDrainSignal(teamName, workerName) {
    const filePath = drainSignalPath(teamName, workerName);
    if (existsSync(filePath)) {
        try {
            unlinkSync(filePath);
        }
        catch { /* ignore */ }
    }
}
// --- Cleanup ---
/** Remove all inbox/outbox/signal files for a worker */
export function cleanupWorkerFiles(teamName, workerName) {
    const files = [
        inboxPath(teamName, workerName),
        inboxCursorPath(teamName, workerName),
        outboxPath(teamName, workerName),
        signalPath(teamName, workerName),
        drainSignalPath(teamName, workerName),
    ];
    for (const f of files) {
        if (existsSync(f)) {
            try {
                unlinkSync(f);
            }
            catch { /* ignore */ }
        }
    }
}
//# sourceMappingURL=inbox-outbox.js.map