import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

/** Mirrors createHookOutput(): the real bridge answers { continue, message }. */
const REAL_SHAPE_BRIDGE = `
let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw); } catch {}
  process.stdout.write(JSON.stringify({
    continue: false,
    message: 'BRIDGE-DELEGATED session=' + (input.session_id || ''),
  }));
});
`;

/** Fails unless the caller bypasses the interactive CLI parser (P1-1). */
const PARSER_GUARD_BRIDGE = `
let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  if (process.env.OMC_CLI_SKIP_PARSE !== '1') {
    process.stderr.write('Already inside a session. Nested launches are not supported.\\n');
    process.exit(1);
  }
  let input = {};
  try { input = JSON.parse(raw); } catch {}
  process.stdout.write(JSON.stringify({
    continue: false,
    message: 'BRIDGE-DELEGATED session=' + (input.session_id || ''),
  }));
});
`;

const FAILING_BRIDGE = 'process.exit(1);\n';

/** Never answers, so the delegation budget is the only thing that ends it. */
const STALLING_BRIDGE = 'setTimeout(() => {}, 60000);\n';

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

function governingRevision(acceptanceCriteria: string[], criterionAmendments: unknown[] = []): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ acceptanceCriteria, criterionAmendments }))
    .digest('hex')}`;
}

function story(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const acceptanceCriteria = ['done'];
  return {
    id: 'US-001',
    title: 'Story',
    description: 'Story',
    acceptanceCriteria,
    priority: 1,
    passes: true,
    completionCriteriaRevision: governingRevision(acceptanceCriteria),
    architectVerified: false,
    ...overrides,
  };
}

function writePrdAt(path: string, stories: Array<Record<string, unknown>>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    project: 'fixture',
    branchName: 'fixture',
    description: 'fixture PRD',
    userStories: stories,
  }));
}

function writeSessionPrd(f: Fixture, sessionId: string, stories: Array<Record<string, unknown>>): void {
  writePrdAt(join(f.project, '.omc', 'state', 'sessions', sessionId, 'prd.json'), stories);
}

function writeVerificationRequest(f: Fixture, sessionId: string, extra: Record<string, unknown> = {}): void {
  const sessionDir = join(f.project, '.omc', 'state', 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'ralph-verification-state.json'), JSON.stringify({
    pending: true,
    completion_claim: 'all stories complete',
    verification_attempts: 0,
    max_verification_attempts: 3,
    requested_at: new Date().toISOString(),
    original_task: 'finish the phase',
    critic_mode: 'architect',
    request_id: 'completion-request',
    ...extra,
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
    const f = makeFixture(kind, REAL_SHAPE_BRIDGE);
    const sessionId = 'ralph-pending-approval';
    writeRalphState(f, sessionId);
    writeSessionPrd(f, sessionId, [story()]);

    const result = invokeStop(f, sessionId);

    expect(String(result.reason)).toContain('BRIDGE-DELEGATED');
    expect(String(result.reason)).toContain(sessionId);
  });

  it('converts the bridge { continue, message } answer into a Stop block', () => {
    const f = makeFixture(kind, REAL_SHAPE_BRIDGE);
    const sessionId = 'ralph-output-adaptation';
    writeRalphState(f, sessionId);
    writeSessionPrd(f, sessionId, [story()]);

    const result = invokeStop(f, sessionId);

    // `continue: false` alone would stop the agent and drop the prompt.
    expect(result.decision).toBe('block');
    expect(result.continue).toBeUndefined();
    expect(String(result.reason)).toContain('BRIDGE-DELEGATED');
  });

  it('bypasses the interactive CLI parser when spawning the bridge', () => {
    const f = makeFixture(kind, PARSER_GUARD_BRIDGE);
    const sessionId = 'ralph-skip-parse';
    writeRalphState(f, sessionId);
    writeSessionPrd(f, sessionId, [story()]);

    const result = invokeStop(f, sessionId);

    expect(String(result.reason)).toContain('BRIDGE-DELEGATED');
  });

  it('keeps delegating while a run-level verification request is pending', () => {
    const f = makeFixture(kind, REAL_SHAPE_BRIDGE);
    const sessionId = 'ralph-completion-pending';
    writeRalphState(f, sessionId);
    // Every story is signed off, so only the pending request can trigger this.
    writeSessionPrd(f, sessionId, [story({ architectVerified: true, architectVerificationCriteriaRevision: governingRevision(['done']) })]);
    writeVerificationRequest(f, sessionId, { verification_scope: 'completion' });

    const result = invokeStop(f, sessionId);

    expect(String(result.reason)).toContain('BRIDGE-DELEGATED');
  });

  it('resolves a project-level PRD instead of assuming it sits beside the state file', () => {
    const f = makeFixture(kind, REAL_SHAPE_BRIDGE);
    const sessionId = 'ralph-project-prd';
    writeRalphState(f, sessionId);
    writePrdAt(join(f.project, '.omc', 'prd.json'), [story()]);

    const result = invokeStop(f, sessionId);

    expect(String(result.reason)).toContain('BRIDGE-DELEGATED');
  });

  it('resolves a PRD at the project root', () => {
    const f = makeFixture(kind, REAL_SHAPE_BRIDGE);
    const sessionId = 'ralph-root-prd';
    writeRalphState(f, sessionId);
    writePrdAt(join(f.project, 'prd.json'), [story()]);

    const result = invokeStop(f, sessionId);

    expect(String(result.reason)).toContain('BRIDGE-DELEGATED');
  });

  it('keeps the fast continuation path once every passed story is verified', () => {
    const f = makeFixture(kind, REAL_SHAPE_BRIDGE);
    const sessionId = 'ralph-verified';
    writeRalphState(f, sessionId);
    writeSessionPrd(f, sessionId, [story({ architectVerified: true, architectVerificationCriteriaRevision: governingRevision(['done']) })]);

    const result = invokeStop(f, sessionId);

    expect(String(result.reason)).toContain('RALPH LOOP');
    expect(String(result.reason)).not.toContain('BRIDGE-DELEGATED');
  });

  it('does not delegate while stories are still being worked on', () => {
    const f = makeFixture(kind, REAL_SHAPE_BRIDGE);
    const sessionId = 'ralph-in-progress';
    writeRalphState(f, sessionId);
    writeSessionPrd(f, sessionId, [story({ passes: false, completionCriteriaRevision: undefined })]);

    const result = invokeStop(f, sessionId);

    expect(String(result.reason)).toContain('RALPH LOOP');
    expect(String(result.reason)).not.toContain('BRIDGE-DELEGATED');
  });

  it('does not delegate for an unbound passes flag', () => {
    const f = makeFixture(kind, REAL_SHAPE_BRIDGE);
    const sessionId = 'ralph-unbound-claim';
    writeRalphState(f, sessionId);
    // A hand-edited `passes: true` without the revision binding is not a
    // completion claim; the bridge would ignore it too.
    writeSessionPrd(f, sessionId, [story({ completionCriteriaRevision: undefined })]);

    const result = invokeStop(f, sessionId);

    expect(String(result.reason)).toContain('RALPH LOOP');
    expect(String(result.reason)).not.toContain('BRIDGE-DELEGATED');
  });

  it('does not delegate when no PRD exists', () => {
    const f = makeFixture(kind, REAL_SHAPE_BRIDGE);
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
    writeSessionPrd(f, sessionId, [story()]);

    const result = invokeStop(f, sessionId);

    expect(String(result.reason)).toContain('RALPH LOOP');
  });
});

describe('Stop hook delegation budget', () => {
  it('shares one deadline across bridge candidates', () => {
    const f = makeFixture('mjs', STALLING_BRIDGE);
    const sessionId = 'ralph-stall-budget';
    writeRalphState(f, sessionId);
    writeSessionPrd(f, sessionId, [story()]);

    // A stalling `omc-cli` on PATH is the second candidate. With a per-candidate
    // budget the two stalls would take twice the delegation timeout.
    const binDir = join(f.dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const stallingCli = join(binDir, 'omc-cli');
    writeFileSync(stallingCli, `#!${process.execPath}\nsetTimeout(() => {}, 60000);\n`, { mode: 0o755 });

    const startedAt = Date.now();
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
        PATH: `${binDir}:${baseEnv.PATH ?? ''}`,
      },
      timeout: 25_000,
    });
    const elapsed = Date.now() - startedAt;

    // Shared budget is 6s; two independent 8s budgets would exceed 16s.
    expect(elapsed).toBeLessThan(12_000);
    expect(String(JSON.parse(stdout.trim()).reason)).toContain('RALPH LOOP');
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
      expect(source, variant).toContain('storyNeedsReviewerSignoff');
      expect(source, variant).toContain('hasPendingVerificationRequest');
      expect(source, variant).toContain('resolvePrdPath');
      expect(source, variant).toContain('adaptBridgeOutput');
      expect(source, variant).toContain('OMC_CLI_SKIP_PARSE');
      expect(source, variant).toContain('--hook=persistent-mode');
    }
  });
});
