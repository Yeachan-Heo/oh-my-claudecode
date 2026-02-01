import { randomUUID } from 'node:crypto';
import * as tmux from './tmux.js';
import * as claude from './claude-wrapper.js';
import { SessionRepository } from '../db/index.js';
import { loadConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { globalQueue } from '../utils/queue.js';
import type { Session, User } from '../types.js';

const sessionRepo = new SessionRepository();

export interface CreateSessionOptions {
  name: string;
  workingDirectory: string;
  user: User;
  initialPrompt?: string;
}

export interface SessionManagerStatus {
  activeSessions: number;
  maxSessions: number;
  uptime: number;
  telegramConnected: boolean;
}

let startTime = Date.now();
let telegramConnected = false;

export function setTelegramConnected(connected: boolean): void {
  telegramConnected = connected;
}

export async function createSession(options: CreateSessionOptions): Promise<Session> {
  const config = loadConfig();

  // Check session limit
  const activeCount = sessionRepo.countActive();
  if (activeCount >= (config.maxSessions ?? 5)) {
    throw new Error(`Maximum session limit reached (${config.maxSessions ?? 5})`);
  }

  // Check if name already exists
  const existing = sessionRepo.findByName(options.name);
  if (existing) {
    throw new Error(`Session with name "${options.name}" already exists`);
  }

  const sessionId = randomUUID();

  // Create tmux session
  const tmuxSession = tmux.createSession(sessionId, options.workingDirectory);

  // Create DB record
  const session = sessionRepo.create({
    name: options.name,
    tmuxSession,
    workingDirectory: options.workingDirectory,
    createdBy: options.user.id,
  });

  // Start Claude Code
  await claude.startClaudeSession(
    session.id,
    tmuxSession,
    options.workingDirectory,
    options.initialPrompt
  );

  logger.info('Created session', { sessionId: session.id, name: options.name });

  return session;
}

export async function sendPrompt(sessionId: string, prompt: string, user?: User): Promise<number> {
  const session = sessionRepo.findById(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  if (session.status !== 'active') {
    throw new Error(`Session ${sessionId} is not active (status: ${session.status})`);
  }

  // Queue the prompt to prevent race conditions
  const queuePosition = globalQueue.getQueueLength(sessionId);

  await globalQueue.enqueue(sessionId, async () => {
    claude.sendPrompt(sessionId, prompt);
  });

  return queuePosition;
}

export function getOutput(sessionId: string, lines: number = 100): string {
  const session = sessionRepo.findById(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  return tmux.capturePane(session.tmuxSession, lines);
}

export function killSession(sessionId: string): void {
  const session = sessionRepo.findById(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  // Kill tmux session
  tmux.killSession(session.tmuxSession);

  // Update DB
  sessionRepo.updateStatus(sessionId, 'terminated');

  // Unregister from claude wrapper
  claude.unregisterSession(sessionId);

  logger.info('Killed session', { sessionId });
}

export function listActiveSessions(): Session[] {
  return sessionRepo.findActive();
}

export function getSession(sessionId: string): Session | null {
  return sessionRepo.findById(sessionId);
}

export function getSessionByName(name: string): Session | null {
  return sessionRepo.findByName(name);
}

export function getUserSessions(userId: string): Session[] {
  return sessionRepo.findByUser(userId);
}

export function interruptSession(sessionId: string): void {
  const session = sessionRepo.findById(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  tmux.sendInterrupt(session.tmuxSession);
  logger.info('Interrupted session', { sessionId });
}

export function getStatus(): SessionManagerStatus {
  const config = loadConfig();

  return {
    activeSessions: sessionRepo.countActive(),
    maxSessions: config.maxSessions ?? 5,
    uptime: Date.now() - startTime,
    telegramConnected,
  };
}

/**
 * Recover sessions after bot restart
 */
export function recoverSessions(): void {
  const activeSessions = sessionRepo.findActive();
  const tmuxSessions = tmux.listSessions();
  const tmuxNames = new Set(tmuxSessions.map(s => s.name));

  for (const session of activeSessions) {
    if (tmuxNames.has(session.tmuxSession)) {
      // Session still exists in tmux, register it
      claude.registerSession({
        id: session.id,
        tmuxSession: session.tmuxSession,
        workingDirectory: session.workingDirectory,
      });
      logger.info('Recovered session', { sessionId: session.id });
    } else {
      // Session no longer exists, mark as terminated
      sessionRepo.updateStatus(session.id, 'terminated');
      logger.warn('Session no longer exists in tmux', { sessionId: session.id });
    }
  }
}

/**
 * Clean up old terminated sessions
 */
export function cleanupOldSessions(hoursOld: number = 24): number {
  // This would need a query to find and delete old sessions
  // For now, just log
  logger.info('Cleanup triggered', { hoursOld });
  return 0;
}

/**
 * Initialize session manager
 */
export function initialize(): void {
  startTime = Date.now();
  recoverSessions();
  logger.info('Session manager initialized');
}

/**
 * Shutdown session manager
 */
export function shutdown(): void {
  // Kill all active sessions gracefully
  const activeSessions = listActiveSessions();
  for (const session of activeSessions) {
    try {
      tmux.killSession(session.tmuxSession);
      sessionRepo.updateStatus(session.id, 'terminated');
    } catch (error) {
      logger.error('Failed to kill session during shutdown', { sessionId: session.id, error: String(error) });
    }
  }
  logger.info('Session manager shut down', { sessionsClosed: activeSessions.length });
}
