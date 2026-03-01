// src/team/outbox-reader.ts
/**
 * Outbox Reader for MCP Team Bridge
 *
 * Reads outbox messages (worker -> lead) using byte-offset cursor,
 * mirroring the inbox cursor pattern from inbox-outbox.ts.
 */
import { readFileSync, openSync, readSync, closeSync, statSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { getClaudeConfigDir } from '../utils/paths.js';
import { validateResolvedPath, writeFileWithMode, atomicWriteJson, ensureDirWithMode } from './fs-utils.js';
import { sanitizeName } from './tmux-session.js';
const MAX_OUTBOX_READ_SIZE = 10 * 1024 * 1024; // 10MB cap per read
function teamsDir() {
    return join(getClaudeConfigDir(), 'teams');
}
/**
 * Read new outbox messages for a worker using byte-offset cursor.
 * Mirror of readNewInboxMessages() but for the outbox direction.
 */
export function readNewOutboxMessages(teamName, workerName) {
    const safeName = sanitizeName(teamName);
    const safeWorker = sanitizeName(workerName);
    const outboxPath = join(teamsDir(), safeName, 'outbox', `${safeWorker}.jsonl`);
    const cursorPath = join(teamsDir(), safeName, 'outbox', `${safeWorker}.outbox-offset`);
    validateResolvedPath(outboxPath, teamsDir());
    validateResolvedPath(cursorPath, teamsDir());
    if (!existsSync(outboxPath))
        return [];
    // Read cursor
    let cursor = { bytesRead: 0 };
    if (existsSync(cursorPath)) {
        try {
            const raw = readFileSync(cursorPath, 'utf-8');
            cursor = JSON.parse(raw);
        }
        catch {
            cursor = { bytesRead: 0 };
        }
    }
    const stat = statSync(outboxPath);
    // Handle file truncation (cursor > file size)
    if (cursor.bytesRead > stat.size) {
        cursor = { bytesRead: 0 };
    }
    const bytesToRead = Math.min(stat.size - cursor.bytesRead, MAX_OUTBOX_READ_SIZE);
    if (bytesToRead <= 0)
        return [];
    const buf = Buffer.alloc(bytesToRead);
    const fd = openSync(outboxPath, 'r');
    try {
        readSync(fd, buf, 0, bytesToRead, cursor.bytesRead);
    }
    finally {
        closeSync(fd);
    }
    const chunk = buf.toString('utf-8');
    const lines = chunk.split('\n').filter(l => l.trim());
    const messages = [];
    for (const line of lines) {
        try {
            messages.push(JSON.parse(line));
        }
        catch { /* skip malformed lines */ }
    }
    // If the buffer ends mid-line (no trailing newline), backtrack the cursor
    // to the start of that partial line so it is retried on the next read.
    let consumed = bytesToRead;
    if (!chunk.endsWith('\n')) {
        const lastNewline = chunk.lastIndexOf('\n');
        consumed = lastNewline >= 0
            ? Buffer.byteLength(chunk.slice(0, lastNewline + 1), 'utf-8')
            : 0;
    }
    // Update cursor atomically to prevent corruption on crash
    const newCursor = { bytesRead: cursor.bytesRead + consumed };
    const cursorDir = join(teamsDir(), safeName, 'outbox');
    ensureDirWithMode(cursorDir);
    atomicWriteJson(cursorPath, newCursor);
    return messages;
}
/**
 * Read new outbox messages from ALL workers in a team.
 */
export function readAllTeamOutboxMessages(teamName) {
    const safeName = sanitizeName(teamName);
    const outboxDir = join(teamsDir(), safeName, 'outbox');
    if (!existsSync(outboxDir))
        return [];
    const files = readdirSync(outboxDir).filter(f => f.endsWith('.jsonl'));
    const results = [];
    for (const file of files) {
        const workerName = file.replace('.jsonl', '');
        const messages = readNewOutboxMessages(teamName, workerName);
        if (messages.length > 0) {
            results.push({ workerName, messages });
        }
    }
    return results;
}
/**
 * Reset outbox cursor for a worker.
 */
export function resetOutboxCursor(teamName, workerName) {
    const safeName = sanitizeName(teamName);
    const safeWorker = sanitizeName(workerName);
    const cursorPath = join(teamsDir(), safeName, 'outbox', `${safeWorker}.outbox-offset`);
    validateResolvedPath(cursorPath, teamsDir());
    const cursorDir = join(teamsDir(), safeName, 'outbox');
    ensureDirWithMode(cursorDir);
    writeFileWithMode(cursorPath, JSON.stringify({ bytesRead: 0 }));
}
//# sourceMappingURL=outbox-reader.js.map