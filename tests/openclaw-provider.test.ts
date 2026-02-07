
import { describe, it, expect, vi } from 'vitest';
import { createSisyphusSession } from '../src/index';

// Mock the openclaw-core module
vi.mock('../src/mcp/openclaw-core.js', () => ({
  detectOpenclawCli: () => '/usr/local/bin/openclaw',
  getOpenclawInfo: () => ({
    installed: true,
    cliPath: '/usr/local/bin/openclaw',
    version: '2026.2.7-5',
  }),
  isGatewayRunning: async () => true,
  spawnOpenclawAgent: async () => ({ success: true, sessionKey: 'test-session-key' }),
  sendToSession: async () => ({ success: true }),
}));

describe('OpenClaw Provider Integration', () => {
  it('should include openclawMcpServer when creating a session', () => {
    const session = createSisyphusSession();
    const mcpServers = session.queryOptions.options.mcpServers;

    expect(mcpServers).toHaveProperty('oc');
  });

  it('should include mcp__oc__* in the allowedTools list', () => {
    const session = createSisyphusSession();
    const allowedTools = session.queryOptions.options.allowedTools;

    expect(allowedTools).toContain('mcp__oc__*');
  });
});
