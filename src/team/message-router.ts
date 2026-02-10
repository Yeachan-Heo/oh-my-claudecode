// src/team/message-router.ts

/**
 * Message routing abstraction for hybrid teams.
 *
 * Routes messages to the correct backend:
 * - Claude native members: returns instruction for SendMessage tool
 * - MCP workers: appends to worker's inbox JSONL file
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { appendFileWithMode, ensureDirWithMode, validateResolvedPath } from './fs-utils.js';
import { getTeamMembers } from './unified-team.js';
import { sanitizeName } from './tmux-session.js';
import type { InboxMessage } from './types.js';

export interface RouteResult {
  method: 'native' | 'inbox';
  details: string;
}

export interface BroadcastResult {
  nativeRecipients: string[];
  inboxRecipients: string[];
}

/**
 * Route a message to a team member regardless of backend.
 * - Claude native: returns instruction to use SendMessage tool
 * - MCP worker: appends to worker's inbox JSONL
 */
export function routeMessage(
  teamName: string,
  recipientName: string,
  content: string,
  workingDirectory: string
): RouteResult {
  const members = getTeamMembers(teamName, workingDirectory);
  const member = members.find(m => m.name === recipientName);

  if (!member) {
    return {
      method: 'native',
      details: `Unknown recipient "${recipientName}". Use SendMessage tool to attempt delivery.`,
    };
  }

  if (member.backend === 'claude-native') {
    return {
      method: 'native',
      details: `Use SendMessage tool to send to "${recipientName}".`,
    };
  }

  // MCP worker: write to inbox
  const teamsBase = join(homedir(), '.claude', 'teams');
  const inboxDir = join(teamsBase, sanitizeName(teamName), 'inbox');
  ensureDirWithMode(inboxDir);
  const inboxPath = join(inboxDir, `${sanitizeName(recipientName)}.jsonl`);
  validateResolvedPath(inboxPath, teamsBase);

  const message: InboxMessage = {
    type: 'message',
    content,
    timestamp: new Date().toISOString(),
  };

  appendFileWithMode(inboxPath, JSON.stringify(message) + '\n');

  return {
    method: 'inbox',
    details: `Message written to ${recipientName}'s inbox.`,
  };
}

/**
 * Broadcast to all team members.
 * - Claude native: returns list for SendMessage broadcast
 * - MCP workers: appends to each worker's inbox
 */
export function broadcastToTeam(
  teamName: string,
  content: string,
  workingDirectory: string
): BroadcastResult {
  const members = getTeamMembers(teamName, workingDirectory);
  const nativeRecipients: string[] = [];
  const inboxRecipients: string[] = [];

  for (const member of members) {
    if (member.backend === 'claude-native') {
      nativeRecipients.push(member.name);
    } else {
      // Write to each MCP worker's inbox
      const teamsBase = join(homedir(), '.claude', 'teams');
      const inboxDir = join(teamsBase, sanitizeName(teamName), 'inbox');
      ensureDirWithMode(inboxDir);
      const inboxPath = join(inboxDir, `${sanitizeName(member.name)}.jsonl`);
      validateResolvedPath(inboxPath, teamsBase);

      const message: InboxMessage = {
        type: 'message',
        content,
        timestamp: new Date().toISOString(),
      };

      appendFileWithMode(inboxPath, JSON.stringify(message) + '\n');
      inboxRecipients.push(member.name);
    }
  }

  return { nativeRecipients, inboxRecipients };
}
