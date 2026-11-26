import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { recordSessionMetrics, type SessionEndInput } from '../index.js';
import {
  flushPendingWrites,
  processSubagentStart,
  processSubagentStop,
} from '../../subagent-tracker/index.js';

let tmpDir: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

function makeInput(sessionId?: string): SessionEndInput {
  return {
    session_id: sessionId as string,
    transcript_path: '/tmp/transcript',
    cwd: tmpDir,
    permission_mode: 'default',
    hook_event_name: 'SessionEnd',
    reason: 'clear',
  };
}

function trackAgents(sessionId?: string): void {
  const base = {
    session_id: sessionId as string,
    transcript_path: '/tmp/transcript',
    cwd: tmpDir,
    permission_mode: 'default',
  };
  for (const id of ['agent-1', 'agent-2']) {
    processSubagentStart({
      ...base,
      hook_event_name: 'SubagentStart',
      agent_id: id,
      agent_type: 'oh-my-claudecode:executor',
    });
  }
  processSubagentStop({
    ...base,
    hook_event_name: 'SubagentStop',
    agent_id: 'agent-1',
    agent_type: 'oh-my-claudecode:executor',
    output: 'done',
  });
  flushPendingWrites();
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-agent-counts-test-'));
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpDir;
  process.env.USERPROFILE = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
});

describe('recordSessionMetrics agent counts', () => {
  it('counts agents the tracker recorded for the ending session', () => {
    trackAgents('current-session');

    const metrics = recordSessionMetrics(tmpDir, makeInput('current-session'));

    expect(metrics.agents_spawned).toBe(2);
    expect(metrics.agents_completed).toBe(1);
  });

  it('counts agents the tracker recorded without a session id', () => {
    trackAgents();

    const metrics = recordSessionMetrics(tmpDir, makeInput());

    expect(metrics.agents_spawned).toBe(2);
    expect(metrics.agents_completed).toBe(1);
  });

  it('still reads the pre-session-scoping subagent-tracking.json', () => {
    const stateDir = path.join(tmpDir, '.omc', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'subagent-tracking.json'),
      JSON.stringify({ agents: [{ status: 'completed' }, { status: 'running' }] }),
    );

    const metrics = recordSessionMetrics(tmpDir, makeInput('current-session'));

    expect(metrics.agents_spawned).toBe(2);
    expect(metrics.agents_completed).toBe(1);
  });

  it('falls back to the unscoped file for an invalid session id', () => {
    trackAgents();

    const metrics = recordSessionMetrics(tmpDir, makeInput('../escape'));

    expect(metrics.agents_spawned).toBe(2);
  });
});
