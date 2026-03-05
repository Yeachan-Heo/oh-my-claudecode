import { mkdir, appendFile, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { sendToWorker } from './tmux-session.js';
import { TeamPaths, absPath } from './state-paths.js';
function mailboxPath(teamName, workerName, cwd) {
    return absPath(cwd, TeamPaths.mailbox(teamName, workerName));
}
function legacyMailboxPath(teamName, workerName, cwd) {
    return mailboxPath(teamName, workerName, cwd).replace(/\.json$/i, '.jsonl');
}
function normalizeLegacyMessage(raw) {
    if (raw.type === 'notified')
        return null;
    const messageId = typeof raw.message_id === 'string' && raw.message_id.trim() !== ''
        ? raw.message_id
        : (typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id : '');
    const fromWorker = typeof raw.from_worker === 'string' && raw.from_worker.trim() !== ''
        ? raw.from_worker
        : (typeof raw.from === 'string' ? raw.from : '');
    const toWorker = typeof raw.to_worker === 'string' && raw.to_worker.trim() !== ''
        ? raw.to_worker
        : (typeof raw.to === 'string' ? raw.to : '');
    const body = typeof raw.body === 'string' ? raw.body : '';
    const createdAt = typeof raw.created_at === 'string' && raw.created_at.trim() !== ''
        ? raw.created_at
        : (typeof raw.createdAt === 'string' ? raw.createdAt : '');
    if (!messageId || !fromWorker || !toWorker || !body || !createdAt)
        return null;
    return {
        message_id: messageId,
        from_worker: fromWorker,
        to_worker: toWorker,
        body,
        created_at: createdAt,
        ...(typeof raw.notified_at === 'string' ? { notified_at: raw.notified_at } : {}),
        ...(typeof raw.notifiedAt === 'string' ? { notified_at: raw.notifiedAt } : {}),
        ...(typeof raw.delivered_at === 'string' ? { delivered_at: raw.delivered_at } : {}),
        ...(typeof raw.deliveredAt === 'string' ? { delivered_at: raw.deliveredAt } : {}),
    };
}
async function readMailboxFile(teamName, workerName, cwd) {
    const canonicalPath = mailboxPath(teamName, workerName, cwd);
    try {
        const raw = await readFile(canonicalPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.messages)) {
            return { worker: workerName, messages: parsed.messages };
        }
    }
    catch {
        // fallback to legacy JSONL below
    }
    const legacyPath = legacyMailboxPath(teamName, workerName, cwd);
    try {
        const raw = await readFile(legacyPath, 'utf-8');
        const messagesById = new Map();
        const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
        for (const line of lines) {
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (!parsed || typeof parsed !== 'object')
                continue;
            const normalized = normalizeLegacyMessage(parsed);
            if (!normalized)
                continue;
            messagesById.set(normalized.message_id, normalized);
        }
        return { worker: workerName, messages: [...messagesById.values()] };
    }
    catch {
        return { worker: workerName, messages: [] };
    }
}
async function writeMailboxFile(teamName, workerName, cwd, mailbox) {
    const canonicalPath = mailboxPath(teamName, workerName, cwd);
    await mkdir(join(canonicalPath, '..'), { recursive: true });
    await writeFile(canonicalPath, JSON.stringify(mailbox, null, 2), 'utf-8');
}
/**
 * Send a short trigger to a worker via tmux send-keys.
 * Uses literal mode (-l) to avoid stdin buffer interference.
 * Message MUST be < 200 chars.
 * Returns false on error — never throws.
 * File state is written BEFORE this is called (write-then-notify pattern).
 */
export async function sendTmuxTrigger(paneId, triggerType, payload) {
    const message = payload ? `${triggerType}:${payload}` : triggerType;
    const truncated = message.length > 200 ? message.slice(0, 200) : message;
    try {
        return await sendToWorker('', paneId, truncated);
    }
    catch {
        return false;
    }
}
/**
 * Write an instruction to a worker inbox, then send tmux trigger.
 * Write-then-notify: file is written first, trigger is sent after.
 * Notified flag set only on successful trigger.
 */
export async function queueInboxInstruction(teamName, workerName, instruction, paneId, cwd) {
    const inboxPath = join(cwd, `.omc/state/team/${teamName}/workers/${workerName}/inbox.md`);
    await mkdir(join(inboxPath, '..'), { recursive: true });
    // Write FIRST (write-then-notify)
    const entry = `\n\n---\n${instruction}\n_queued: ${new Date().toISOString()}_\n`;
    await appendFile(inboxPath, entry, 'utf-8');
    // Notify AFTER write
    await sendTmuxTrigger(paneId, 'check-inbox');
}
/**
 * Send a direct message from one worker to another.
 * Write to mailbox first, then send tmux trigger to recipient.
 */
export async function queueDirectMessage(teamName, fromWorker, toWorker, body, toPaneId, cwd) {
    const mailbox = await readMailboxFile(teamName, toWorker, cwd);
    const message = {
        message_id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        from_worker: fromWorker,
        to_worker: toWorker,
        body,
        created_at: new Date().toISOString(),
    };
    // Write FIRST
    mailbox.messages.push(message);
    await writeMailboxFile(teamName, toWorker, cwd, mailbox);
    // Update notifiedAt after successful trigger
    const notified = await sendTmuxTrigger(toPaneId, 'new-message', fromWorker);
    if (notified) {
        const updated = await readMailboxFile(teamName, toWorker, cwd);
        const entry = updated.messages.find((candidate) => candidate.message_id === message.message_id);
        if (entry)
            entry.notified_at = new Date().toISOString();
        await writeMailboxFile(teamName, toWorker, cwd, updated);
    }
}
/**
 * Broadcast a message to all workers.
 * Write to each mailbox first, then send triggers.
 */
export async function queueBroadcastMessage(teamName, fromWorker, body, workerPanes, // workerName -> paneId
cwd) {
    const workerNames = Object.keys(workerPanes);
    // Write to all mailboxes FIRST
    const messageId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    for (const toWorker of workerNames) {
        const mailbox = await readMailboxFile(teamName, toWorker, cwd);
        const message = {
            message_id: messageId,
            from_worker: fromWorker,
            to_worker: toWorker,
            body,
            created_at: new Date().toISOString(),
        };
        mailbox.messages.push(message);
        await writeMailboxFile(teamName, toWorker, cwd, mailbox);
    }
    // Send triggers to all (best-effort)
    await Promise.all(workerNames.map(toWorker => sendTmuxTrigger(workerPanes[toWorker], 'new-message', fromWorker)));
}
/**
 * Read unread messages from a worker mailbox.
 * Returns messages since the given cursor (message ID or timestamp).
 */
export async function readMailbox(teamName, workerName, cwd) {
    const mailbox = await readMailboxFile(teamName, workerName, cwd);
    return mailbox.messages.map((message) => ({
        id: message.message_id,
        from: message.from_worker,
        body: message.body,
        createdAt: message.created_at,
    }));
}
//# sourceMappingURL=tmux-comm.js.map