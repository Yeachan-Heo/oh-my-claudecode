/**
 * Shared State Management for Cross-Tool Interoperability
 *
 * Manages shared state files at .omc/state/interop/ for communication
 * between OMC (Claude Code) and OMX (Codex CLI).
 *
 * Uses atomic writes for safety and supports task/message passing.
 */
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { z } from 'zod';
import { atomicWriteJsonSync } from '../lib/atomic-write.js';
import { withFileLockSync } from '../lib/file-lock.js';
import { createArtifactHandoff, writeTextArtifact, } from '../shared/artifact-descriptor.js';
const INTEROP_ARTIFACT_THRESHOLD_BYTES = 2048;
// Zod schemas for runtime validation
const ArtifactProducerSchema = z.object({
    system: z.enum(['omc', 'omx']),
    component: z.string(),
    worker: z.string().optional(),
});
const ArtifactDescriptorSchema = z.object({
    kind: z.string(),
    path: z.string(),
    contentHash: z.string().optional(),
    createdAt: z.string(),
    producer: ArtifactProducerSchema,
    sizeBytes: z.number().optional(),
    retention: z.enum(['ephemeral', 'session', 'until-completion', 'persistent']),
    expiresAt: z.string().optional(),
});
const InteropConfigSchema = z.object({
    sessionId: z.string(),
    createdAt: z.string(),
    omcCwd: z.string(),
    omxCwd: z.string().optional(),
    status: z.enum(['active', 'completed', 'failed']),
});
const SharedTaskSchema = z.object({
    id: z.string(),
    source: z.enum(['omc', 'omx']),
    target: z.enum(['omc', 'omx']),
    type: z.enum(['analyze', 'implement', 'review', 'test', 'custom']),
    description: z.string(),
    descriptionArtifact: ArtifactDescriptorSchema.optional(),
    context: z.record(z.unknown()).optional(),
    files: z.array(z.string()).optional(),
    createdAt: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
    result: z.string().optional(),
    resultArtifact: ArtifactDescriptorSchema.optional(),
    error: z.string().optional(),
    completedAt: z.string().optional(),
});
const SharedMessageSchema = z.object({
    id: z.string(),
    source: z.enum(['omc', 'omx']),
    target: z.enum(['omc', 'omx']),
    content: z.string(),
    contentArtifact: ArtifactDescriptorSchema.optional(),
    metadata: z.record(z.unknown()).optional(),
    timestamp: z.string(),
    read: z.boolean(),
});
function getInteropArtifactsDir(cwd, category) {
    return join(getInteropDir(cwd), 'artifacts', category);
}
function createSharedStateTextHandoff(params) {
    return createArtifactHandoff({
        body: params.body,
        thresholdBytes: INTEROP_ARTIFACT_THRESHOLD_BYTES,
        descriptorFactory: () => writeTextArtifact({
            path: join(getInteropArtifactsDir(params.cwd, params.category), `${params.entityId}.md`),
            content: params.body,
            kind: params.category,
            producer: {
                system: params.source,
                component: 'interop-shared-state',
            },
            retention: params.retention,
        }),
    });
}
function resolveSharedStateTextHandoff(params) {
    const handoff = createSharedStateTextHandoff(params);
    return handoff.mode === 'inline'
        ? { text: handoff.body }
        : { text: handoff.summary, artifact: handoff.descriptor };
}
function unlinkArtifact(descriptor) {
    if (!descriptor?.path)
        return;
    try {
        if (existsSync(descriptor.path)) {
            unlinkSync(descriptor.path);
        }
    }
    catch {
        // best-effort cleanup only
    }
}
/**
 * Get the interop directory path for a worktree
 */
export function getInteropDir(cwd) {
    return join(cwd, '.omc', 'state', 'interop');
}
/**
 * Initialize an interop session
 * Creates the interop directory and session config
 */
export function initInteropSession(sessionId, omcCwd, omxCwd) {
    const interopDir = getInteropDir(omcCwd);
    mkdirSync(interopDir, { recursive: true });
    const config = {
        sessionId,
        createdAt: new Date().toISOString(),
        omcCwd,
        omxCwd,
        status: 'active',
    };
    const configPath = join(interopDir, 'config.json');
    atomicWriteJsonSync(configPath, config);
    return config;
}
/**
 * Read interop configuration
 */
export function readInteropConfig(cwd) {
    const configPath = join(getInteropDir(cwd), 'config.json');
    if (!existsSync(configPath)) {
        return null;
    }
    try {
        const content = readFileSync(configPath, 'utf-8');
        const result = InteropConfigSchema.safeParse(JSON.parse(content));
        return result.success ? result.data : null;
    }
    catch {
        return null;
    }
}
/**
 * Add a shared task for cross-tool communication
 */
export function addSharedTask(cwd, task) {
    const interopDir = getInteropDir(cwd);
    const fullTask = {
        ...task,
        id: `task-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`,
        createdAt: new Date().toISOString(),
        status: 'pending',
    };
    const descriptionHandoff = resolveSharedStateTextHandoff({
        cwd,
        category: 'task-description',
        entityId: fullTask.id,
        body: task.description,
        source: task.source,
        retention: 'until-completion',
    });
    fullTask.description = descriptionHandoff.text;
    fullTask.descriptionArtifact = descriptionHandoff.artifact;
    const taskPath = join(interopDir, 'tasks', `${fullTask.id}.json`);
    const tasksDir = join(interopDir, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    atomicWriteJsonSync(taskPath, fullTask);
    return fullTask;
}
/**
 * Read all shared tasks
 */
export function readSharedTasks(cwd, filter) {
    const tasksDir = join(getInteropDir(cwd), 'tasks');
    if (!existsSync(tasksDir)) {
        return [];
    }
    const files = readdirSync(tasksDir).filter(f => f.endsWith('.json'));
    const tasks = [];
    for (const file of files) {
        try {
            const content = readFileSync(join(tasksDir, file), 'utf-8');
            const parsed = SharedTaskSchema.safeParse(JSON.parse(content));
            if (!parsed.success)
                continue;
            const task = parsed.data;
            // Apply filters
            if (filter?.source && task.source !== filter.source)
                continue;
            if (filter?.target && task.target !== filter.target)
                continue;
            if (filter?.status && task.status !== filter.status)
                continue;
            tasks.push(task);
        }
        catch {
            // Skip invalid task files
        }
    }
    // Sort by creation time (newest first)
    return tasks.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}
/**
 * Update a shared task
 */
export function updateSharedTask(cwd, taskId, updates) {
    const taskPath = join(getInteropDir(cwd), 'tasks', `${taskId}.json`);
    if (!existsSync(taskPath)) {
        return null;
    }
    try {
        return withFileLockSync(taskPath + '.lock', () => {
            const content = readFileSync(taskPath, 'utf-8');
            const parsed = SharedTaskSchema.safeParse(JSON.parse(content));
            if (!parsed.success)
                return null;
            const task = parsed.data;
            const updatedTask = {
                ...task,
                ...updates,
            };
            if (typeof updates.description === 'string') {
                const descriptionHandoff = resolveSharedStateTextHandoff({
                    cwd,
                    category: 'task-description',
                    entityId: task.id,
                    body: updates.description,
                    source: task.source,
                    retention: 'until-completion',
                });
                updatedTask.description = descriptionHandoff.text;
                updatedTask.descriptionArtifact = descriptionHandoff.artifact;
            }
            if (typeof updates.result === 'string') {
                const resultHandoff = resolveSharedStateTextHandoff({
                    cwd,
                    category: 'task-result',
                    entityId: task.id,
                    body: updates.result,
                    source: task.source,
                    retention: 'until-completion',
                });
                updatedTask.result = resultHandoff.text;
                updatedTask.resultArtifact = resultHandoff.artifact;
            }
            // Set completedAt if status changed to completed/failed
            if ((updates.status === 'completed' || updates.status === 'failed') &&
                !updatedTask.completedAt) {
                updatedTask.completedAt = new Date().toISOString();
            }
            atomicWriteJsonSync(taskPath, updatedTask);
            return updatedTask;
        });
    }
    catch {
        return null;
    }
}
/**
 * Add a shared message for cross-tool communication
 */
export function addSharedMessage(cwd, message) {
    const interopDir = getInteropDir(cwd);
    const fullMessage = {
        ...message,
        id: `msg-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`,
        timestamp: new Date().toISOString(),
        read: false,
    };
    const contentHandoff = resolveSharedStateTextHandoff({
        cwd,
        category: 'message-content',
        entityId: fullMessage.id,
        body: message.content,
        source: message.source,
        retention: 'session',
    });
    fullMessage.content = contentHandoff.text;
    fullMessage.contentArtifact = contentHandoff.artifact;
    const messagePath = join(interopDir, 'messages', `${fullMessage.id}.json`);
    const messagesDir = join(interopDir, 'messages');
    mkdirSync(messagesDir, { recursive: true });
    atomicWriteJsonSync(messagePath, fullMessage);
    return fullMessage;
}
/**
 * Read shared messages
 */
export function readSharedMessages(cwd, filter) {
    const messagesDir = join(getInteropDir(cwd), 'messages');
    if (!existsSync(messagesDir)) {
        return [];
    }
    const files = readdirSync(messagesDir).filter(f => f.endsWith('.json'));
    const messages = [];
    for (const file of files) {
        try {
            const content = readFileSync(join(messagesDir, file), 'utf-8');
            const parsed = SharedMessageSchema.safeParse(JSON.parse(content));
            if (!parsed.success)
                continue;
            const message = parsed.data;
            // Apply filters
            if (filter?.source && message.source !== filter.source)
                continue;
            if (filter?.target && message.target !== filter.target)
                continue;
            if (filter?.unreadOnly && message.read)
                continue;
            messages.push(message);
        }
        catch {
            // Skip invalid message files
        }
    }
    // Sort by timestamp (newest first)
    return messages.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}
/**
 * Mark a message as read
 */
export function markMessageAsRead(cwd, messageId) {
    const messagePath = join(getInteropDir(cwd), 'messages', `${messageId}.json`);
    if (!existsSync(messagePath)) {
        return false;
    }
    try {
        const content = readFileSync(messagePath, 'utf-8');
        const parsed = SharedMessageSchema.safeParse(JSON.parse(content));
        if (!parsed.success)
            return false;
        const message = parsed.data;
        message.read = true;
        atomicWriteJsonSync(messagePath, message);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Clean up interop session
 * Removes all tasks and messages for a session
 */
export function cleanupInterop(cwd, options) {
    const interopDir = getInteropDir(cwd);
    let tasksDeleted = 0;
    let messagesDeleted = 0;
    const cutoffTime = options?.olderThan
        ? Date.now() - options.olderThan
        : 0;
    // Clean up tasks
    if (!options?.keepTasks) {
        const tasksDir = join(interopDir, 'tasks');
        if (existsSync(tasksDir)) {
            const files = readdirSync(tasksDir).filter(f => f.endsWith('.json'));
            for (const file of files) {
                try {
                    const filePath = join(tasksDir, file);
                    const content = readFileSync(filePath, 'utf-8');
                    const taskParsed = SharedTaskSchema.safeParse(JSON.parse(content));
                    if (!taskParsed.success)
                        continue;
                    const task = taskParsed.data;
                    const taskTime = new Date(task.createdAt).getTime();
                    if (!options?.olderThan || taskTime < cutoffTime) {
                        unlinkArtifact(task.descriptionArtifact);
                        unlinkArtifact(task.resultArtifact);
                        unlinkSync(filePath);
                        tasksDeleted++;
                    }
                }
                catch {
                    // Skip files that can't be deleted
                }
            }
        }
    }
    // Clean up messages
    if (!options?.keepMessages) {
        const messagesDir = join(interopDir, 'messages');
        if (existsSync(messagesDir)) {
            const files = readdirSync(messagesDir).filter(f => f.endsWith('.json'));
            for (const file of files) {
                try {
                    const filePath = join(messagesDir, file);
                    const content = readFileSync(filePath, 'utf-8');
                    const msgParsed = SharedMessageSchema.safeParse(JSON.parse(content));
                    if (!msgParsed.success)
                        continue;
                    const message = msgParsed.data;
                    const messageTime = new Date(message.timestamp).getTime();
                    if (!options?.olderThan || messageTime < cutoffTime) {
                        unlinkArtifact(message.contentArtifact);
                        unlinkSync(filePath);
                        messagesDeleted++;
                    }
                }
                catch {
                    // Skip files that can't be deleted
                }
            }
        }
    }
    return { tasksDeleted, messagesDeleted };
}
//# sourceMappingURL=shared-state.js.map