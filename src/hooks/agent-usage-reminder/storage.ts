/**
 * Agent Usage Reminder Storage
 *
 * Persists agent usage state across sessions.
 *
 * Ported from oh-my-opencode's agent-usage-reminder hook.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import { AGENT_USAGE_REMINDER_STORAGE } from './constants.js';
import type { AgentUsageState } from './types.js';

function getStoragePath(sessionID: string): string {
  return join(AGENT_USAGE_REMINDER_STORAGE, `${sessionID}.json`);
}

export function loadAgentUsageState(sessionID: string): AgentUsageState | null {
  const filePath = getStoragePath(sessionID);
  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as AgentUsageState;
  } catch {
    return null;
  }
}

export function saveAgentUsageState(state: AgentUsageState): void {
  if (!existsSync(AGENT_USAGE_REMINDER_STORAGE)) {
    mkdirSync(AGENT_USAGE_REMINDER_STORAGE, { recursive: true });
  }

  const filePath = getStoragePath(state.sessionID);
  writeFileSync(filePath, JSON.stringify(state, null, 2));
}

export function clearAgentUsageState(sessionID: string): void {
  const filePath = getStoragePath(sessionID);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}
