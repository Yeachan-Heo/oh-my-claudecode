/**
 * ClawdCoder MCP Tools Integration Tests
 *
 * Tests all 6 MCP tools for graceful degradation when bot is not running,
 * stale PID detection, and proper error handling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  clawdcoderStatus,
  clawdcoderSessionList,
  clawdcoderSessionCreate,
  clawdcoderSessionSend,
  clawdcoderSessionOutput,
  clawdcoderSessionKill,
} from '../../tools/clawdcoder-tools.js';
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

describe('ClawdCoder MCP Tools - Bot Not Running', () => {
  const stateDir = join(homedir(), '.omc', 'state');
  const pidPath = join(stateDir, 'clawdcoder.pid');
  const socketPath = join(stateDir, 'clawdcoder.sock');

  beforeEach(() => {
    // Ensure no PID or socket file exists
    if (existsSync(pidPath)) unlinkSync(pidPath);
    if (existsSync(socketPath)) unlinkSync(socketPath);
  });

  afterEach(() => {
    // Clean up any files created during tests
    if (existsSync(pidPath)) unlinkSync(pidPath);
    if (existsSync(socketPath)) unlinkSync(socketPath);
  });

  it('clawdcoder_status returns not running message', async () => {
    const result = await clawdcoderStatus.handler({});

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('not running');
    expect(result.content[0].text).toContain('omc clawdcoder start');
    expect(result.content[0].text).toContain('/oh-my-claudecode:omc-setup');
  });

  it('clawdcoder_session_list returns not running message', async () => {
    const result = await clawdcoderSessionList.handler({});

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('not running');
    expect(result.content[0].text).toContain('omc clawdcoder start');
  });

  it('clawdcoder_session_create returns not running message', async () => {
    const result = await clawdcoderSessionCreate.handler({
      name: 'test-session',
      project_dir: '/tmp/test-project',
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('not running');
    expect(result.content[0].text).toContain('omc clawdcoder start');
  });

  it('clawdcoder_session_create with prompt returns not running message', async () => {
    const result = await clawdcoderSessionCreate.handler({
      name: 'test-session',
      project_dir: '/tmp/test-project',
      prompt: 'Initial prompt here',
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('not running');
  });

  it('clawdcoder_session_send returns not running message', async () => {
    const result = await clawdcoderSessionSend.handler({
      session_id: 'test-session-id',
      prompt: 'Hello Claude!',
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('not running');
    expect(result.content[0].text).toContain('omc clawdcoder start');
  });

  it('clawdcoder_session_output returns not running message', async () => {
    const result = await clawdcoderSessionOutput.handler({
      session_id: 'test-session-id',
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('not running');
  });

  it('clawdcoder_session_output with lines parameter returns not running message', async () => {
    const result = await clawdcoderSessionOutput.handler({
      session_id: 'test-session-id',
      lines: 50,
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('not running');
  });

  it('clawdcoder_session_kill returns not running message', async () => {
    const result = await clawdcoderSessionKill.handler({
      session_id: 'test-session-id',
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('not running');
    expect(result.content[0].text).toContain('omc clawdcoder start');
  });
});

describe('ClawdCoder MCP Tools - Stale PID Detection', () => {
  const stateDir = join(homedir(), '.omc', 'state');
  const pidPath = join(stateDir, 'clawdcoder.pid');
  const socketPath = join(stateDir, 'clawdcoder.sock');

  beforeEach(() => {
    // Ensure state directory exists
    mkdirSync(stateDir, { recursive: true });

    // Write a stale PID (process that doesn't exist - use very high number)
    writeFileSync(pidPath, '99999999');
  });

  afterEach(() => {
    // Clean up test files
    if (existsSync(pidPath)) unlinkSync(pidPath);
    if (existsSync(socketPath)) unlinkSync(socketPath);
  });

  it('detects stale PID and returns not running for status', async () => {
    const result = await clawdcoderStatus.handler({});

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('not running');
    expect(result.content[0].text).toContain('omc clawdcoder start');
  });

  it('detects stale PID and returns not running for session_list', async () => {
    const result = await clawdcoderSessionList.handler({});

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain('not running');
  });

  it('detects stale PID and returns not running for session_create', async () => {
    const result = await clawdcoderSessionCreate.handler({
      name: 'test',
      project_dir: '/tmp/test',
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain('not running');
  });

  it('detects stale PID and returns not running for session_send', async () => {
    const result = await clawdcoderSessionSend.handler({
      session_id: 'test',
      prompt: 'hello',
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain('not running');
  });

  it('detects stale PID and returns not running for session_output', async () => {
    const result = await clawdcoderSessionOutput.handler({
      session_id: 'test',
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain('not running');
  });

  it('detects stale PID and returns not running for session_kill', async () => {
    const result = await clawdcoderSessionKill.handler({
      session_id: 'test',
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain('not running');
  });
});

describe('ClawdCoder MCP Tools - Schema Validation', () => {
  it('clawdcoder_status has correct schema', () => {
    expect(clawdcoderStatus.name).toBe('clawdcoder_status');
    expect(clawdcoderStatus.description).toContain('status');
    expect(clawdcoderStatus.schema).toEqual({});
  });

  it('clawdcoder_session_list has correct schema', () => {
    expect(clawdcoderSessionList.name).toBe('clawdcoder_session_list');
    expect(clawdcoderSessionList.description).toContain('List');
    expect(clawdcoderSessionList.schema).toEqual({});
  });

  it('clawdcoder_session_create has correct schema', () => {
    expect(clawdcoderSessionCreate.name).toBe('clawdcoder_session_create');
    expect(clawdcoderSessionCreate.description).toContain('Create');
    expect(clawdcoderSessionCreate.schema).toHaveProperty('name');
    expect(clawdcoderSessionCreate.schema).toHaveProperty('project_dir');
    expect(clawdcoderSessionCreate.schema).toHaveProperty('prompt');
  });

  it('clawdcoder_session_send has correct schema', () => {
    expect(clawdcoderSessionSend.name).toBe('clawdcoder_session_send');
    expect(clawdcoderSessionSend.description).toContain('Send');
    expect(clawdcoderSessionSend.schema).toHaveProperty('session_id');
    expect(clawdcoderSessionSend.schema).toHaveProperty('prompt');
  });

  it('clawdcoder_session_output has correct schema', () => {
    expect(clawdcoderSessionOutput.name).toBe('clawdcoder_session_output');
    expect(clawdcoderSessionOutput.description).toContain('output');
    expect(clawdcoderSessionOutput.schema).toHaveProperty('session_id');
    expect(clawdcoderSessionOutput.schema).toHaveProperty('lines');
  });

  it('clawdcoder_session_kill has correct schema', () => {
    expect(clawdcoderSessionKill.name).toBe('clawdcoder_session_kill');
    expect(clawdcoderSessionKill.description).toContain('Terminate');
    expect(clawdcoderSessionKill.schema).toHaveProperty('session_id');
  });
});

describe('ClawdCoder MCP Tools - Response Format', () => {
  it('all tools return consistent response format', async () => {
    const tools = [
      clawdcoderStatus.handler({}),
      clawdcoderSessionList.handler({}),
      clawdcoderSessionCreate.handler({ name: 'test', project_dir: '/tmp' }),
      clawdcoderSessionSend.handler({ session_id: 'test', prompt: 'hi' }),
      clawdcoderSessionOutput.handler({ session_id: 'test' }),
      clawdcoderSessionKill.handler({ session_id: 'test' }),
    ];

    const results = await Promise.all(tools);

    for (const result of results) {
      expect(result).toHaveProperty('content');
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);

      for (const item of result.content) {
        expect(item).toHaveProperty('type', 'text');
        expect(item).toHaveProperty('text');
        expect(typeof item.text).toBe('string');
      }
    }
  });
});
