import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The Stop hook ships as a dependency-free script that only counts iterations.
 * It never read the PRD, so a story marked `passes: true` stayed
 * `architectVerified: false` forever: the skill forbids the agent from writing
 * that flag (skills/ralph/SKILL.md, Step 5) and the binding lives in the
 * bridge implementation, which no hook invoked. These tests pin the hand-off.
 */
const created: string[] = [];

function writeFakeBridge(dir: string, body: string): void {
  const bridgeDir = join(dir, 'bridge');
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(join(bridgeDir, 'cli.cjs'), body);
}

const ECHO_BRIDGE = `
let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw); } catch {}
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: 'BRIDGE-DELEGATED session=' + (input.session_id || ''),
  }));
});
`;

const FAILING_BRIDGE = 'process.exit(1);\n';

function makeFixture(kind: 'mjs' | 'cjs', bridgeBody: string) {
  const dir = mkdtempSync(join(tmpdir(), `ralph-approval-stop-${kind}-`));
  created.push(dir);
  const home = join(dir, 'home');
  const project = join(dir, 'project');
  const claudeConfigDir = join(home, 'claude-config');
  mkdirSync(project, { recursive: true });
  mkdirSync(claudeConfigDir, { recursive: true });
  execFileSync('git', ['init'], { cwd: project, stdio: 'pipe' });

  // Standalone install layout: the hook sits in hooks/ next to its siblings and
  // lib/, and the bundled bridge is one directory up.
  const hooksDir = join(dir, 'hooks');
  cpSync(join(root, 'scripts'), hooksDir, { recursive: true });
  writeFakeBridge(dir, bridgeBody);

  return {
    dir,
    home,
    project,
    claudeConfigDir,
    hook: join(hooksDir, `persistent-mode.${kind}`),
  };
}

type Fixture = ReturnType<typeof makeFixture>;

function writeRalphState(f: Fixture, sessionId: string): void {
  const sessionDir = join(f.project, '.omc', 'state', 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(sessionDir, 'ralph-state.json'), JSON.stringify({
    active: true,
    session_id: sessionId,
    project_path: f.project,
    started_at: now,
    last_checked_at: now,
    iteration: 1,
    max_iterations: 100,
    prompt: 'finish the phase',
  }));
}

function writePrd(f: Fixture, sessionId: string, stories: Array<Record<string, unknown>>): void {
  const sessionDir = join(f.project, '.omc', 'state', 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'prd.json'), JSON.stringify({
    project: 'fixture',
    branchName: 'fixture',
    description: 'fixture PRD',
    userStories: stories,
  }));
}

function invokeStop(f: Fixture, sessionId: string) {
  const baseEnv = { ...process.env };
  delete baseEnv.CLAUDE_CODE_TASK_LIST_ID;
  const stdout = execFileSync(process.execPath, [f.hook], {
    cwd: f.project,
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId, cwd: f.project }),
    encoding: 'utf8',
    env: {
      ...baseEnv,
      HOME: f.home,
      USERPROFILE: f.home,
      CLAUDE_CONFIG_DIR: f.claudeConfigDir,
      OMC_STATE_DIR: '',
      OMC_PERSISTENT_MODE_TIMEOUT_MS: '8000',
    },
    timeout: 25_000,
  });
  return JSON.parse(stdout.trim());
}

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

describe.each(['mjs', 'cjs'] as const)('Stop hook architect verification hand-off (%s)', (kind) => {
  it('delegates when a passed story still needs reviewer sign-off', () => {
    const f = makeFixture(kind, ECHO_BRIDGE);
    const sessionId = 'ralph-pending-approval';
    writeRalphState(f, sessionId);
    writePrd(f, sessionId, [{
      id: 'US-001',
      title: 'Story',
      description: 'Story',
      acceptanceCriteria: ['done'],
      priority: 1,
      passes: true,
      architectVerified: false,
    }]);

    const result = invokeStop(f, sessionId);

    expect(String(result.reason)).toContain('BRIDGE-DELEGATED');
    expect(String(result.reason)).toContain(sessionId);
  });

  it('keeps the fast continuation path once every passed story is verified', () => {
    const f = makeFixture(kind, ECHO_BRIDGE);
    const sessionId = 'ralph-verified';
    writeRalphState(f, sessionId);
    writePrd(f, sessionId, [{
      id: 'US-001',
      title: 'Story',
      description: 'Story',
      acceptanceCriteria: ['done'],
      priority: 1,
      passes: true,
      architectVerified: true,
    }]);

    const result = invokeStop(f, sessionId);

    expect(String(result.reason)).toContain('RALPH LOOP');
    expect(String(result.reason)).not.toContain('BRIDGE-DELEGATED');
  });

  it('does not delegate while stories are still being worked on', () => {
    const f = makeFixture(kind, ECHO_BRIDGE);
    const sessionId = 'ralph-in-progress';
    writeRalphState(f, sessionId);
    writePrd(f, sessionId, [{
      id: 'US-001',
      title: 'Story',
      description: 'Story',
      acceptanceCriteria: ['done'],
      priority: 1,
      passes: false,
      architectVerified: false,
    }]);

    const result = invokeStop(f, sessionId);

    expect(String(result.reason)).toContain('RALPH LOOP');
    expect(String(result.reason)).not.toContain('BRIDGE-DELEGATED');
  });

  it('does not delegate when no PRD exists', () => {
    const f = makeFixture(kind, ECHO_BRIDGE);
    const sessionId = 'ralph-no-prd';
    writeRalphState(f, sessionId);

    const result = invokeStop(f, sessionId);

    expect(String(result.reason)).toContain('RALPH LOOP');
    expect(String(result.reason)).not.toContain('BRIDGE-DELEGATED');
  });

  it('falls back to the continuation path when the bridge fails', () => {
    const f = makeFixture(kind, FAILING_BRIDGE);
    const sessionId = 'ralph-broken-bridge';
    writeRalphState(f, sessionId);
    writePrd(f, sessionId, [{
      id: 'US-001',
      title: 'Story',
      description: 'Story',
      acceptanceCriteria: ['done'],
      priority: 1,
      passes: true,
      architectVerified: false,
    }]);

    const result = invokeStop(f, sessionId);

    expect(String(result.reason)).toContain('RALPH LOOP');
  });
});

describe('Stop hook architect verification parity', () => {
  it('keeps the gate in every shipped variant', () => {
    const variants = [
      join(root, 'scripts', 'persistent-mode.mjs'),
      join(root, 'scripts', 'persistent-mode.cjs'),
      join(root, 'templates', 'hooks', 'persistent-mode.mjs'),
    ];
    for (const variant of variants) {
      expect(existsSync(variant), variant).toBe(true);
      const source = readFileSync(variant, 'utf8');
      expect(source, variant).toContain('hasPendingArchitectVerification');
      expect(source, variant).toContain('--hook=persistent-mode');
    }
  });
});
