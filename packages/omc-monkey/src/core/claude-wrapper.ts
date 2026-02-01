import { spawn, type ChildProcess } from 'node:child_process';
import { sendKeys, capturePane, sendInterrupt } from './tmux.js';
import { logger } from '../utils/logger.js';

export interface ClaudeSession {
  id: string;
  tmuxSession: string;
  process?: ChildProcess;
  workingDirectory: string;
}

const activeSessions = new Map<string, ClaudeSession>();

/**
 * Start a new Claude Code session inside a tmux session
 */
export async function startClaudeSession(
  sessionId: string,
  tmuxSession: string,
  workingDirectory: string,
  initialPrompt?: string
): Promise<ClaudeSession> {
  const session: ClaudeSession = {
    id: sessionId,
    tmuxSession,
    workingDirectory,
  };

  activeSessions.set(sessionId, session);

  // Start Claude Code in the tmux session
  sendKeys(tmuxSession, 'claude');

  // If there's an initial prompt, send it after Claude starts
  // Use a small delay to ensure Claude is ready
  if (initialPrompt) {
    // Wait for Claude to initialize before sending the prompt
    await new Promise(resolve => setTimeout(resolve, 2000));
    sendKeys(tmuxSession, initialPrompt);
  }

  logger.info('Started Claude session', { sessionId, tmuxSession, workingDirectory });

  return session;
}

/**
 * Send a prompt to an existing Claude session
 */
export function sendPrompt(sessionId: string, prompt: string): void {
  const session = activeSessions.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  sendKeys(session.tmuxSession, prompt);
  logger.debug('Sent prompt to session', { sessionId, promptLength: prompt.length });
}

/**
 * Resume a Claude session
 */
export function resumeSession(sessionId: string, tmuxSession: string): void {
  sendKeys(tmuxSession, `claude --resume ${sessionId}`);
  logger.info('Resumed Claude session', { sessionId });
}

/**
 * Continue the last Claude session
 */
export function continueSession(tmuxSession: string): void {
  sendKeys(tmuxSession, 'claude --continue');
  logger.info('Continued Claude session', { tmuxSession });
}

/**
 * Interrupt the current Claude operation
 */
export function interruptSession(sessionId: string): void {
  const session = activeSessions.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  sendInterrupt(session.tmuxSession);
  logger.info('Interrupted Claude session', { sessionId });
}

/**
 * Get the current output from a Claude session
 */
export function getSessionOutput(sessionId: string, lines: number = 100): string {
  const session = activeSessions.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  return capturePane(session.tmuxSession, lines);
}

/**
 * Register an existing session (for recovery after restart)
 */
export function registerSession(session: ClaudeSession): void {
  activeSessions.set(session.id, session);
}

/**
 * Unregister a session
 */
export function unregisterSession(sessionId: string): void {
  activeSessions.delete(sessionId);
}

/**
 * Get a registered session
 */
export function getSession(sessionId: string): ClaudeSession | undefined {
  return activeSessions.get(sessionId);
}

/**
 * Get all registered sessions
 */
export function getAllSessions(): ClaudeSession[] {
  return Array.from(activeSessions.values());
}
