import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { routeMessage, broadcastToTeam } from '../message-router.js';
import { registerMcpWorker } from '../team-registration.js';
import { writeHeartbeat } from '../heartbeat.js';

describe('message-router', () => {
  let testDir: string;
  const teamName = 'test-router';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'message-router-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    // Clean up inbox files that may have been created
    try {
      const inboxDir = join(homedir(), '.claude', 'teams', teamName, 'inbox');
      rmSync(inboxDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  function registerWorker(name: string, agentType: string = 'mcp-codex') {
    const provider = agentType === 'mcp-gemini' ? 'gemini' : 'codex' as const;
    registerMcpWorker(teamName, name, provider, 'gpt-5.3-codex', `${teamName}-${name}`, testDir, testDir);
    // Write heartbeat so worker shows up as alive
    writeHeartbeat(testDir, {
      workerName: name,
      teamName,
      provider: 'codex',
      pid: process.pid,
      lastPollAt: new Date().toISOString(),
      status: 'polling',
      consecutiveErrors: 0,
    });
  }

  describe('routeMessage', () => {
    it('routes to MCP worker via inbox', () => {
      registerWorker('codex-1');

      const result = routeMessage(teamName, 'codex-1', 'Hello worker', testDir);
      expect(result.method).toBe('inbox');
      expect(result.details).toContain('inbox');

      // Verify inbox file was written
      const inboxPath = join(homedir(), '.claude', 'teams', teamName, 'inbox', 'codex-1.jsonl');
      expect(existsSync(inboxPath)).toBe(true);
      const content = readFileSync(inboxPath, 'utf-8').trim();
      const msg = JSON.parse(content);
      expect(msg.content).toBe('Hello worker');
      expect(msg.type).toBe('message');
    });

    it('returns native instruction for unknown recipient', () => {
      const result = routeMessage(teamName, 'unknown-worker', 'Hello', testDir);
      expect(result.method).toBe('native');
      expect(result.details).toContain('Unknown recipient');
    });
  });

  describe('broadcastToTeam', () => {
    it('broadcasts to all MCP workers', () => {
      registerWorker('worker1');
      registerWorker('worker2');

      const result = broadcastToTeam(teamName, 'Team announcement', testDir);
      expect(result.inboxRecipients).toContain('worker1');
      expect(result.inboxRecipients).toContain('worker2');
      expect(result.nativeRecipients).toEqual([]);

      // Verify both inbox files were written
      const inbox1 = join(homedir(), '.claude', 'teams', teamName, 'inbox', 'worker1.jsonl');
      const inbox2 = join(homedir(), '.claude', 'teams', teamName, 'inbox', 'worker2.jsonl');
      expect(existsSync(inbox1)).toBe(true);
      expect(existsSync(inbox2)).toBe(true);
    });

    it('returns empty arrays when no members', () => {
      const result = broadcastToTeam(teamName, 'Hello', testDir);
      expect(result.nativeRecipients).toEqual([]);
      expect(result.inboxRecipients).toEqual([]);
    });
  });
});
