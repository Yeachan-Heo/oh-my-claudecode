/**
 * Tests for issue #3730: SessionStart restores the PreCompact checkpoint
 * when the session resumes from compaction (source === 'compact').
 *
 * Exercises the real scripts/session-start.mjs entrypoint the same way
 * Claude Code does (stdin JSON payload), against a built dist tree.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT_PATH = join(__dirname, '..', '..', 'scripts', 'session-start.mjs');
const NODE = process.execPath;

function makeProject(root: string): string {
  const project = join(root, 'project');
  // session-start validateCwd requires a real workspace anchor (.git / .omc-workspace)
  mkdirSync(join(project, '.git'), { recursive: true });
  return project;
}

function writeCheckpoint(project: string, createdAt: string, extra: Record<string, unknown> = {}): string {
  const dir = join(project, '.omc', 'state', 'checkpoints');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `checkpoint-${createdAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      created_at: createdAt,
      trigger: 'auto',
      active_modes: {},
      todo_summary: { pending: 2, in_progress: 1, completed: 4 },
      wisdom_exported: false,
      ...extra,
    }),
    'utf-8',
  );
  return file;
}

interface RunResult {
  stdout: string;
}

function runHook(payload: Record<string, unknown>, project: string, home: string): RunResult {
  const stdout = execFileSync(NODE, [SCRIPT_PATH], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      // No plugin root: the restore import is skipped when unset, which is
      // covered separately; with it unset this returns the baseline output.
    },
    timeout: 15000,
  });
  return { stdout };
}

function runHookWithPlugin(
  payload: Record<string, unknown>,
  project: string,
  home: string,
): RunResult {
  const stdout = execFileSync(NODE, [SCRIPT_PATH], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_PLUGIN_ROOT: join(__dirname, '..', '..'),
    },
    timeout: 15000,
  });
  return { stdout };
}

function parseContext(stdout: string): string {
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  return parsed.hookSpecificOutput?.additionalContext || '';
}

describe('session-start.mjs PreCompact checkpoint restore (issue #3730)', () => {
  let tempDir: string;
  let home: string;
  let project: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-precompact-session-start-'));
    home = join(tempDir, 'home');
    mkdirSync(home, { recursive: true });
    project = makeProject(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('restores the newest checkpoint when source=compact', () => {
    writeCheckpoint(project, new Date(Date.now() - 60_000).toISOString());
    writeCheckpoint(
      project,
      new Date().toISOString(),
      {
        plan_refs: {
          boulder: {
            active_plan: '/repo/.omc/plans/epic.md',
            plan_name: 'epic',
            progress: { total: 3, completed: 2, isComplete: false },
          },
        },
      },
    );

    const { stdout } = runHookWithPlugin(
      {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: 'session-3730',
        cwd: project,
      },
      project,
      home,
    );

    const context = parseContext(stdout);
    expect(context).toContain('PRECOMPACT CHECKPOINT RESTORED');
    expect(context).toContain('epic');
    expect(context).toContain('2/3 steps done');
  });

  it('does not restore on plain startup (no source)', () => {
    writeCheckpoint(project, new Date().toISOString());

    const { stdout } = runHookWithPlugin(
      {
        hook_event_name: 'SessionStart',
        session_id: 'session-3730',
        cwd: project,
      },
      project,
      home,
    );

    const context = parseContext(stdout);
    expect(context).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
  });

  it('does not restore on source=startup', () => {
    writeCheckpoint(project, new Date().toISOString());

    const { stdout } = runHookWithPlugin(
      {
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: 'session-3730',
        cwd: project,
      },
      project,
      home,
    );

    expect(parseContext(stdout)).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
  });

  it('does not restore on source=resume', () => {
    writeCheckpoint(project, new Date().toISOString());

    const { stdout } = runHookWithPlugin(
      {
        hook_event_name: 'SessionStart',
        source: 'resume',
        session_id: 'session-3730',
        cwd: project,
      },
      project,
      home,
    );

    expect(parseContext(stdout)).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
  });

  it('does not restore a second time for the same session (replay guard)', () => {
    writeCheckpoint(project, new Date().toISOString());

    const first = runHookWithPlugin(
      {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: 'session-3730',
        cwd: project,
      },
      project,
      home,
    );
    expect(parseContext(first.stdout)).toContain('PRECOMPACT CHECKPOINT RESTORED');

    const second = runHookWithPlugin(
      {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: 'session-3730',
        cwd: project,
      },
      project,
      home,
    );
    expect(parseContext(second.stdout)).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
  });

  it('fails open (no restore) on a malformed checkpoint', () => {
    const dir = join(project, '.omc', 'state', 'checkpoints');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'checkpoint-broken.json'), '{not json', 'utf-8');

    const { stdout } = runHookWithPlugin(
      {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: 'session-3730',
        cwd: project,
      },
      project,
      home,
    );

    expect(parseContext(stdout)).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
  });

  it('fails open (no restore) when no checkpoints exist', () => {
    const { stdout } = runHookWithPlugin(
      {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: 'session-3730',
        cwd: project,
      },
      project,
      home,
    );

    expect(parseContext(stdout)).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
  });

  it('writes the replay marker under the session-scoped restore directory', () => {
    const file = writeCheckpoint(project, new Date().toISOString());

    runHookWithPlugin(
      {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: 'session-3730',
        cwd: project,
      },
      project,
      home,
    );

    const markerPath = join(project, '.omc', 'state', 'checkpoints-restored', 'session-3730', 'restored.json');
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
    expect(marker.checkpoint).toBe(file);
  });

  it('does not restore for a session when the checkpoint belongs to another project', () => {
    // Checkpoint exists only in an unrelated directory.
    const otherProject = makeProject(join(tempDir, 'other'));
    writeCheckpoint(otherProject, new Date().toISOString());

    const { stdout } = runHookWithPlugin(
      {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: 'session-3730',
        cwd: project,
      },
      project,
      home,
    );

    expect(parseContext(stdout)).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
  });

  it('restores without CLAUDE_PLUGIN_ROOT set (self-contained helper, no dist dependency)', () => {
    writeCheckpoint(project, new Date().toISOString());

    const { stdout } = runHook(
      {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: 'session-3730',
        cwd: project,
      },
      project,
      home,
    );

    // The restore helper is inline (scripts/lib), so restore works in a
    // clean checkout with no build step and no plugin root.
    expect(parseContext(stdout)).toContain('PRECOMPACT CHECKPOINT RESTORED');
  });
  it('does not restore and does not write a marker for a traversal session ID (P1 security)', () => {
    writeCheckpoint(project, new Date().toISOString());

    const { stdout } = runHook(
      {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: '../../../../../../tmp/escaped-3730-hook-trav',
        cwd: project,
      },
      project,
      home,
    );

    expect(parseContext(stdout)).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
    // No marker escapes the omc root
    expect(existsSync('/tmp/escaped-3730-hook-trav/restored.json')).toBe(false);
  });

  it('does not restore for separator-containing session IDs', () => {
    writeCheckpoint(project, new Date().toISOString());

    for (const bad of ['a/b', 'a\\b', 'a b', 'a..b']) {
      const { stdout } = runHook(
        {
          hook_event_name: 'SessionStart',
          source: 'compact',
          session_id: bad,
          cwd: project,
        },
        project,
        home,
      );
      expect(parseContext(stdout)).not.toContain('PRECOMPACT CHECKPOINT RESTORED');
    }
  });
});

// Template parity: the templates/hooks/lib/precompact-restore.mjs helper must
// reject the same traversal payloads as the scripts/ copy.
describe('templates/hooks/lib/precompact-restore.mjs parity (issue #3730 security)', () => {
  const TEMPLATE_HELPER = join(__dirname, '..', '..', 'templates', 'hooks', 'lib', 'precompact-restore.mjs');

  let tempDir: string;
  let project: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-precompact-template-parity-'));
    project = join(tempDir, 'project');
    mkdirSync(join(project, '.omc', 'state', 'checkpoints'), { recursive: true });
    writeFileSync(
      join(project, '.omc', 'state', 'checkpoints', 'checkpoint-now.json'),
      JSON.stringify({ created_at: new Date().toISOString(), trigger: 'auto', active_modes: {}, todo_summary: { pending: 1, in_progress: 0, completed: 0 }, wisdom_exported: false }),
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects traversal session IDs in the template helper (parity with scripts/)', async () => {
    const mod = await import(pathToFileURL(TEMPLATE_HELPER).href) as { restorePreCompactCheckpoint: (root: string, sid: string) => { text: string } | null };
    const omcRoot = join(project, '.omc');
    const result = mod.restorePreCompactCheckpoint(omcRoot, '../../../../../../tmp/escaped-3730-template-trav');
    expect(result).toBeNull();
    expect(existsSync('/tmp/escaped-3730-template-trav/restored.json')).toBe(false);
  });

  it('restores a valid session ID in the template helper (parity with scripts/)', async () => {
    const mod = await import(pathToFileURL(TEMPLATE_HELPER).href) as { restorePreCompactCheckpoint: (root: string, sid: string) => { text: string } | null };
    const omcRoot = join(project, '.omc');
    const result = mod.restorePreCompactCheckpoint(omcRoot, 'valid-session-3730');
    expect(result).not.toBeNull();
    expect(result!.text).toContain('PRECOMPACT CHECKPOINT RESTORED');
  });
});
