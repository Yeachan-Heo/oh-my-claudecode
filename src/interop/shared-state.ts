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

export interface InteropConfig {
  sessionId: string;
  createdAt: string;
  omcCwd: string;
  omxCwd?: string;
  status: 'active' | 'completed' | 'failed';
}

export interface SharedTask {
  id: string;
  source: 'omc' | 'omx';
  target: 'omc' | 'omx';
  type: 'analyze' | 'implement' | 'review' | 'test' | 'custom';
  description: string;
  context?: Record<string, unknown>;
  files?: string[];
  createdAt: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  result?: string;
  error?: string;
  completedAt?: string;
}

export interface SharedMessage {
  id: string;
  source: 'omc' | 'omx';
  target: 'omc' | 'omx';
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
  read: boolean;
}

// Zod schemas for runtime validation
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
  context: z.record(z.unknown()).optional(),
  files: z.array(z.string()).optional(),
  createdAt: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
  result: z.string().optional(),
  error: z.string().optional(),
  completedAt: z.string().optional(),
});

const SharedMessageSchema = z.object({
  id: z.string(),
  source: z.enum(['omc', 'omx']),
  target: z.enum(['omc', 'omx']),
  content: z.string(),
  metadata: z.record(z.unknown()).optional(),
  timestamp: z.string(),
  read: z.boolean(),
});

/**
 * Get the interop directory path for a worktree
 */
export function getInteropDir(cwd: string): string {
  return join(cwd, '.omc', 'state', 'interop');
}

/**
 * Initialize an interop session
 * Creates the interop directory and session config
 */
export function initInteropSession(
  sessionId: string,
  omcCwd: string,
  omxCwd?: string
): InteropConfig {
  const interopDir = getInteropDir(omcCwd);

  // Ensure directory exists
  if (!existsSync(interopDir)) {
    mkdirSync(interopDir, { recursive: true });
  }

  const config: InteropConfig = {
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
export function readInteropConfig(cwd: string): InteropConfig | null {
  const configPath = join(getInteropDir(cwd), 'config.json');

  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const result = InteropConfigSchema.safeParse(JSON.parse(content));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Add a shared task for cross-tool communication
 */
export function addSharedTask(
  cwd: string,
  task: Omit<SharedTask, 'id' | 'createdAt' | 'status'>
): SharedTask {
  const interopDir = getInteropDir(cwd);

  const fullTask: SharedTask = {
    ...task,
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    createdAt: new Date().toISOString(),
    status: 'pending',
  };

  const taskPath = join(interopDir, 'tasks', `${fullTask.id}.json`);

  // Ensure tasks directory exists
  const tasksDir = join(interopDir, 'tasks');
  if (!existsSync(tasksDir)) {
    mkdirSync(tasksDir, { recursive: true });
  }

  atomicWriteJsonSync(taskPath, fullTask);

  return fullTask;
}

/**
 * Read all shared tasks
 */
export function readSharedTasks(cwd: string, filter?: {
  source?: 'omc' | 'omx';
  target?: 'omc' | 'omx';
  status?: SharedTask['status'];
}): SharedTask[] {
  const tasksDir = join(getInteropDir(cwd), 'tasks');

  if (!existsSync(tasksDir)) {
    return [];
  }

  const files = readdirSync(tasksDir).filter(f => f.endsWith('.json'));
  const tasks: SharedTask[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(join(tasksDir, file), 'utf-8');
      const parsed = SharedTaskSchema.safeParse(JSON.parse(content));
      if (!parsed.success) continue;
      const task = parsed.data;

      // Apply filters
      if (filter?.source && task.source !== filter.source) continue;
      if (filter?.target && task.target !== filter.target) continue;
      if (filter?.status && task.status !== filter.status) continue;

      tasks.push(task);
    } catch {
      // Skip invalid task files
    }
  }

  // Sort by creation time (newest first)
  return tasks.sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

/**
 * Update a shared task
 */
export function updateSharedTask(
  cwd: string,
  taskId: string,
  updates: Partial<Omit<SharedTask, 'id' | 'createdAt'>>
): SharedTask | null {
  const taskPath = join(getInteropDir(cwd), 'tasks', `${taskId}.json`);

  if (!existsSync(taskPath)) {
    return null;
  }

  try {
    const content = readFileSync(taskPath, 'utf-8');
    const parsed = SharedTaskSchema.safeParse(JSON.parse(content));
    if (!parsed.success) return null;
    const task = parsed.data;

    const updatedTask: SharedTask = {
      ...task,
      ...updates,
    };

    // Set completedAt if status changed to completed/failed
    if (
      (updates.status === 'completed' || updates.status === 'failed') &&
      !updatedTask.completedAt
    ) {
      updatedTask.completedAt = new Date().toISOString();
    }

    atomicWriteJsonSync(taskPath, updatedTask);

    return updatedTask;
  } catch {
    return null;
  }
}

/**
 * Add a shared message for cross-tool communication
 */
export function addSharedMessage(
  cwd: string,
  message: Omit<SharedMessage, 'id' | 'timestamp' | 'read'>
): SharedMessage {
  const interopDir = getInteropDir(cwd);

  const fullMessage: SharedMessage = {
    ...message,
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    timestamp: new Date().toISOString(),
    read: false,
  };

  const messagePath = join(interopDir, 'messages', `${fullMessage.id}.json`);

  // Ensure messages directory exists
  const messagesDir = join(interopDir, 'messages');
  if (!existsSync(messagesDir)) {
    mkdirSync(messagesDir, { recursive: true });
  }

  atomicWriteJsonSync(messagePath, fullMessage);

  return fullMessage;
}

/**
 * Read shared messages
 */
export function readSharedMessages(cwd: string, filter?: {
  source?: 'omc' | 'omx';
  target?: 'omc' | 'omx';
  unreadOnly?: boolean;
}): SharedMessage[] {
  const messagesDir = join(getInteropDir(cwd), 'messages');

  if (!existsSync(messagesDir)) {
    return [];
  }

  const files = readdirSync(messagesDir).filter(f => f.endsWith('.json'));
  const messages: SharedMessage[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(join(messagesDir, file), 'utf-8');
      const parsed = SharedMessageSchema.safeParse(JSON.parse(content));
      if (!parsed.success) continue;
      const message = parsed.data;

      // Apply filters
      if (filter?.source && message.source !== filter.source) continue;
      if (filter?.target && message.target !== filter.target) continue;
      if (filter?.unreadOnly && message.read) continue;

      messages.push(message);
    } catch {
      // Skip invalid message files
    }
  }

  // Sort by timestamp (newest first)
  return messages.sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}

/**
 * Mark a message as read
 */
export function markMessageAsRead(cwd: string, messageId: string): boolean {
  const messagePath = join(getInteropDir(cwd), 'messages', `${messageId}.json`);

  if (!existsSync(messagePath)) {
    return false;
  }

  try {
    const content = readFileSync(messagePath, 'utf-8');
    const parsed = SharedMessageSchema.safeParse(JSON.parse(content));
    if (!parsed.success) return false;
    const message = parsed.data;

    message.read = true;
    atomicWriteJsonSync(messagePath, message);

    return true;
  } catch {
    return false;
  }
}

/**
 * Clean up interop session
 * Removes all tasks and messages for a session
 */
export function cleanupInterop(cwd: string, options?: {
  keepTasks?: boolean;
  keepMessages?: boolean;
  olderThan?: number; // milliseconds
}): { tasksDeleted: number; messagesDeleted: number } {
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

          if (options?.olderThan) {
            const content = readFileSync(filePath, 'utf-8');
            const taskParsed = SharedTaskSchema.safeParse(JSON.parse(content));
            if (!taskParsed.success) continue;
            const task = taskParsed.data;
            const taskTime = new Date(task.createdAt).getTime();

            if (taskTime < cutoffTime) {
              unlinkSync(filePath);
              tasksDeleted++;
            }
          } else {
            unlinkSync(filePath);
            tasksDeleted++;
          }
        } catch {
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

          if (options?.olderThan) {
            const content = readFileSync(filePath, 'utf-8');
            const msgParsed = SharedMessageSchema.safeParse(JSON.parse(content));
            if (!msgParsed.success) continue;
            const message = msgParsed.data;
            const messageTime = new Date(message.timestamp).getTime();

            if (messageTime < cutoffTime) {
              unlinkSync(filePath);
              messagesDeleted++;
            }
          } else {
            unlinkSync(filePath);
            messagesDeleted++;
          }
        } catch {
          // Skip files that can't be deleted
        }
      }
    }
  }

  return { tasksDeleted, messagesDeleted };
}
