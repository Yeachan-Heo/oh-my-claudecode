/**
 * Session Recovery Storage Operations
 *
 * Functions for reading and manipulating stored session data.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, } from 'node:fs';
import { join } from 'node:path';
import { MESSAGE_STORAGE, PART_STORAGE, THINKING_TYPES, META_TYPES, PLACEHOLDER_TEXT, } from './constants.js';
/**
 * Generate a unique part ID
 */
export function generatePartId() {
    const timestamp = Date.now().toString(16);
    const random = Math.random().toString(36).substring(2, 10);
    return `prt_${timestamp}${random}`;
}
/**
 * Get the directory containing messages for a session
 */
export function getMessageDir(sessionID) {
    if (!existsSync(MESSAGE_STORAGE))
        return '';
    const directPath = join(MESSAGE_STORAGE, sessionID);
    if (existsSync(directPath)) {
        return directPath;
    }
    for (const dir of readdirSync(MESSAGE_STORAGE)) {
        const sessionPath = join(MESSAGE_STORAGE, dir, sessionID);
        if (existsSync(sessionPath)) {
            return sessionPath;
        }
    }
    return '';
}
/**
 * Read all messages for a session
 */
export function readMessages(sessionID) {
    const messageDir = getMessageDir(sessionID);
    if (!messageDir || !existsSync(messageDir))
        return [];
    const messages = [];
    for (const file of readdirSync(messageDir)) {
        if (!file.endsWith('.json'))
            continue;
        try {
            const content = readFileSync(join(messageDir, file), 'utf-8');
            messages.push(JSON.parse(content));
        }
        catch {
            continue;
        }
    }
    return messages.sort((a, b) => {
        const aTime = a.time?.created ?? 0;
        const bTime = b.time?.created ?? 0;
        if (aTime !== bTime)
            return aTime - bTime;
        return a.id.localeCompare(b.id);
    });
}
/**
 * Read all parts for a message
 */
export function readParts(messageID) {
    const partDir = join(PART_STORAGE, messageID);
    if (!existsSync(partDir))
        return [];
    const parts = [];
    for (const file of readdirSync(partDir)) {
        if (!file.endsWith('.json'))
            continue;
        try {
            const content = readFileSync(join(partDir, file), 'utf-8');
            parts.push(JSON.parse(content));
        }
        catch {
            continue;
        }
    }
    return parts;
}
/**
 * Check if a part has content (not thinking/meta)
 */
export function hasContent(part) {
    if (THINKING_TYPES.has(part.type))
        return false;
    if (META_TYPES.has(part.type))
        return false;
    if (part.type === 'text') {
        const textPart = part;
        return !!(textPart.text?.trim());
    }
    if (part.type === 'tool' || part.type === 'tool_use') {
        return true;
    }
    if (part.type === 'tool_result') {
        return true;
    }
    return false;
}
/**
 * Check if a message has content
 */
export function messageHasContent(messageID) {
    const parts = readParts(messageID);
    return parts.some(hasContent);
}
/**
 * Inject a text part into a message
 */
export function injectTextPart(sessionID, messageID, text) {
    const partDir = join(PART_STORAGE, messageID);
    if (!existsSync(partDir)) {
        mkdirSync(partDir, { recursive: true });
    }
    const partId = generatePartId();
    const part = {
        id: partId,
        sessionID,
        messageID,
        type: 'text',
        text,
        synthetic: true,
    };
    try {
        writeFileSync(join(partDir, `${partId}.json`), JSON.stringify(part, null, 2));
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Find all messages with empty content
 */
export function findEmptyMessages(sessionID) {
    const messages = readMessages(sessionID);
    const emptyIds = [];
    for (const msg of messages) {
        if (!messageHasContent(msg.id)) {
            emptyIds.push(msg.id);
        }
    }
    return emptyIds;
}
/**
 * Find empty message by index (with fuzzy matching)
 */
export function findEmptyMessageByIndex(sessionID, targetIndex) {
    const messages = readMessages(sessionID);
    // Try nearby indices in case of system messages causing offset
    const indicesToTry = [
        targetIndex,
        targetIndex - 1,
        targetIndex + 1,
        targetIndex - 2,
        targetIndex + 2,
        targetIndex - 3,
        targetIndex - 4,
        targetIndex - 5,
    ];
    for (const idx of indicesToTry) {
        if (idx < 0 || idx >= messages.length)
            continue;
        const targetMsg = messages[idx];
        if (!messageHasContent(targetMsg.id)) {
            return targetMsg.id;
        }
    }
    return null;
}
/**
 * Find messages that have thinking blocks
 */
export function findMessagesWithThinkingBlocks(sessionID) {
    const messages = readMessages(sessionID);
    const result = [];
    for (const msg of messages) {
        if (msg.role !== 'assistant')
            continue;
        const parts = readParts(msg.id);
        const hasThinking = parts.some((p) => THINKING_TYPES.has(p.type));
        if (hasThinking) {
            result.push(msg.id);
        }
    }
    return result;
}
/**
 * Find messages that have thinking but no content
 */
export function findMessagesWithThinkingOnly(sessionID) {
    const messages = readMessages(sessionID);
    const result = [];
    for (const msg of messages) {
        if (msg.role !== 'assistant')
            continue;
        const parts = readParts(msg.id);
        if (parts.length === 0)
            continue;
        const hasThinking = parts.some((p) => THINKING_TYPES.has(p.type));
        const hasTextContent = parts.some(hasContent);
        if (hasThinking && !hasTextContent) {
            result.push(msg.id);
        }
    }
    return result;
}
/**
 * Find messages with orphan thinking (thinking not first)
 */
export function findMessagesWithOrphanThinking(sessionID) {
    const messages = readMessages(sessionID);
    const result = [];
    for (const msg of messages) {
        if (msg.role !== 'assistant')
            continue;
        const parts = readParts(msg.id);
        if (parts.length === 0)
            continue;
        const sortedParts = [...parts].sort((a, b) => a.id.localeCompare(b.id));
        const firstPart = sortedParts[0];
        const firstIsThinking = THINKING_TYPES.has(firstPart.type);
        if (!firstIsThinking) {
            result.push(msg.id);
        }
    }
    return result;
}
/**
 * Find the most recent thinking content from previous assistant messages
 */
function findLastThinkingContent(sessionID, beforeMessageID) {
    const messages = readMessages(sessionID);
    const currentIndex = messages.findIndex((m) => m.id === beforeMessageID);
    if (currentIndex === -1)
        return '';
    for (let i = currentIndex - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role !== 'assistant')
            continue;
        const parts = readParts(msg.id);
        for (const part of parts) {
            if (THINKING_TYPES.has(part.type)) {
                const thinking = part.thinking;
                const reasoning = part.text;
                const content = thinking || reasoning;
                if (content && content.trim().length > 0) {
                    return content;
                }
            }
        }
    }
    return '';
}
/**
 * Prepend a thinking part to a message
 */
export function prependThinkingPart(sessionID, messageID) {
    const partDir = join(PART_STORAGE, messageID);
    if (!existsSync(partDir)) {
        mkdirSync(partDir, { recursive: true });
    }
    const previousThinking = findLastThinkingContent(sessionID, messageID);
    const partId = `prt_0000000000_thinking`;
    const part = {
        id: partId,
        sessionID,
        messageID,
        type: 'thinking',
        thinking: previousThinking || '[Continuing from previous reasoning]',
        synthetic: true,
    };
    try {
        writeFileSync(join(partDir, `${partId}.json`), JSON.stringify(part, null, 2));
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Strip all thinking parts from a message
 */
export function stripThinkingParts(messageID) {
    const partDir = join(PART_STORAGE, messageID);
    if (!existsSync(partDir))
        return false;
    let anyRemoved = false;
    for (const file of readdirSync(partDir)) {
        if (!file.endsWith('.json'))
            continue;
        try {
            const filePath = join(partDir, file);
            const content = readFileSync(filePath, 'utf-8');
            const part = JSON.parse(content);
            if (THINKING_TYPES.has(part.type)) {
                unlinkSync(filePath);
                anyRemoved = true;
            }
        }
        catch {
            continue;
        }
    }
    return anyRemoved;
}
/**
 * Replace empty text parts with placeholder text
 */
export function replaceEmptyTextParts(messageID, replacementText = PLACEHOLDER_TEXT) {
    const partDir = join(PART_STORAGE, messageID);
    if (!existsSync(partDir))
        return false;
    let anyReplaced = false;
    for (const file of readdirSync(partDir)) {
        if (!file.endsWith('.json'))
            continue;
        try {
            const filePath = join(partDir, file);
            const content = readFileSync(filePath, 'utf-8');
            const part = JSON.parse(content);
            if (part.type === 'text') {
                const textPart = part;
                if (!textPart.text?.trim()) {
                    textPart.text = replacementText;
                    textPart.synthetic = true;
                    writeFileSync(filePath, JSON.stringify(textPart, null, 2));
                    anyReplaced = true;
                }
            }
        }
        catch {
            continue;
        }
    }
    return anyReplaced;
}
/**
 * Find messages with empty text parts
 */
export function findMessagesWithEmptyTextParts(sessionID) {
    const messages = readMessages(sessionID);
    const result = [];
    for (const msg of messages) {
        const parts = readParts(msg.id);
        const hasEmptyTextPart = parts.some((p) => {
            if (p.type !== 'text')
                return false;
            const textPart = p;
            return !textPart.text?.trim();
        });
        if (hasEmptyTextPart) {
            result.push(msg.id);
        }
    }
    return result;
}
/**
 * Find message by index that needs thinking block
 */
export function findMessageByIndexNeedingThinking(sessionID, targetIndex) {
    const messages = readMessages(sessionID);
    if (targetIndex < 0 || targetIndex >= messages.length)
        return null;
    const targetMsg = messages[targetIndex];
    if (targetMsg.role !== 'assistant')
        return null;
    const parts = readParts(targetMsg.id);
    if (parts.length === 0)
        return null;
    const sortedParts = [...parts].sort((a, b) => a.id.localeCompare(b.id));
    const firstPart = sortedParts[0];
    const firstIsThinking = THINKING_TYPES.has(firstPart.type);
    if (!firstIsThinking) {
        return targetMsg.id;
    }
    return null;
}
//# sourceMappingURL=storage.js.map