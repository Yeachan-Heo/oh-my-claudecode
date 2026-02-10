import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import {
  readProbeResult, writeProbeResult, getRegistrationStrategy,
  registerMcpWorker, unregisterMcpWorker, isMcpWorker, listMcpWorkers
} from '../team-registration.js';
import type { ConfigProbeResult } from '../types.js';

const TEST_DIR = join(tmpdir(), '__test_team_reg__');
const TEST_TEAM = 'test-team-reg-team';
const CONFIG_DIR = join(homedir(), '.claude', 'teams', TEST_TEAM);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, '.omc', 'state'), { recursive: true });
  mkdirSync(CONFIG_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  rmSync(CONFIG_DIR, { recursive: true, force: true });
});

describe('probeResult', () => {
  it('writes and reads probe result', () => {
    const result: ConfigProbeResult = { probeResult: 'pass', probedAt: '2026-01-01', version: '1.0' };
    writeProbeResult(TEST_DIR, result);
    expect(readProbeResult(TEST_DIR)?.probeResult).toBe('pass');
  });

  it('returns null when not probed', () => {
    expect(readProbeResult(TEST_DIR)).toBeNull();
  });
});

describe('getRegistrationStrategy', () => {
  it('returns shadow when not probed', () => {
    expect(getRegistrationStrategy(TEST_DIR)).toBe('shadow');
  });

  it('returns config when probe passed', () => {
    writeProbeResult(TEST_DIR, { probeResult: 'pass', probedAt: '', version: '' });
    expect(getRegistrationStrategy(TEST_DIR)).toBe('config');
  });

  it('returns shadow when probe failed', () => {
    writeProbeResult(TEST_DIR, { probeResult: 'fail', probedAt: '', version: '' });
    expect(getRegistrationStrategy(TEST_DIR)).toBe('shadow');
  });

  it('returns shadow when probe partial', () => {
    writeProbeResult(TEST_DIR, { probeResult: 'partial', probedAt: '', version: '' });
    expect(getRegistrationStrategy(TEST_DIR)).toBe('shadow');
  });
});

describe('registerMcpWorker / unregisterMcpWorker', () => {
  it('registers worker in shadow registry', () => {
    registerMcpWorker(TEST_TEAM, 'w1', 'codex', 'gpt-5', 'sess1', '/cwd', TEST_DIR);
    const workers = listMcpWorkers(TEST_TEAM, TEST_DIR);
    expect(workers).toHaveLength(1);
    expect(workers[0].name).toBe('w1');
    expect(workers[0].agentType).toBe('mcp-codex');
  });

  it('replaces existing worker on re-register', () => {
    registerMcpWorker(TEST_TEAM, 'w1', 'codex', 'gpt-5', 'sess1', '/cwd', TEST_DIR);
    registerMcpWorker(TEST_TEAM, 'w1', 'gemini', 'gemini-pro', 'sess2', '/cwd2', TEST_DIR);
    const workers = listMcpWorkers(TEST_TEAM, TEST_DIR);
    expect(workers).toHaveLength(1);
    expect(workers[0].agentType).toBe('mcp-gemini');
  });

  it('registers multiple workers', () => {
    registerMcpWorker(TEST_TEAM, 'w1', 'codex', 'gpt-5', 'sess1', '/cwd', TEST_DIR);
    registerMcpWorker(TEST_TEAM, 'w2', 'gemini', 'gemini-pro', 'sess2', '/cwd', TEST_DIR);
    const workers = listMcpWorkers(TEST_TEAM, TEST_DIR);
    expect(workers).toHaveLength(2);
  });

  it('unregisters worker', () => {
    registerMcpWorker(TEST_TEAM, 'w1', 'codex', 'gpt-5', 'sess1', '/cwd', TEST_DIR);
    unregisterMcpWorker(TEST_TEAM, 'w1', TEST_DIR);
    expect(listMcpWorkers(TEST_TEAM, TEST_DIR)).toEqual([]);
  });

  it('unregister is no-op for nonexistent worker', () => {
    registerMcpWorker(TEST_TEAM, 'w1', 'codex', 'gpt-5', 'sess1', '/cwd', TEST_DIR);
    unregisterMcpWorker(TEST_TEAM, 'w2', TEST_DIR);
    expect(listMcpWorkers(TEST_TEAM, TEST_DIR)).toHaveLength(1);
  });
});

describe('isMcpWorker', () => {
  it('returns true for tmux backend', () => {
    expect(isMcpWorker({ backendType: 'tmux' })).toBe(true);
  });

  it('returns false for other backends', () => {
    expect(isMcpWorker({ backendType: 'other' })).toBe(false);
    expect(isMcpWorker({})).toBe(false);
  });
});
