/**
 * Tests for the SessionEnd chain-enqueuer hook registration (software factory
 * third link): the omc-setup installer must register the SessionEnd hook that
 * forwards to the OMC bridge (--hook=session-end → planChainEnqueue), and the
 * registration must be idempotent (no duplicate writes on repeat installs).
 *
 * Tests exercise the real installer code path: getHooksSettingsConfig() for
 * the desired config and mergeHookGroups() for the settings.json merge.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mergeHookGroups, isOmcHook, type HookGroup, type InstallResult } from '../installer/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');

function makeResult(): InstallResult {
  return {
    success: true,
    message: '',
    installedAgents: [],
    installedCommands: [],
    installedSkills: [],
    hooksConfigured: true,
    hookConflicts: [],
    errors: [],
  };
}

function merge(
  existingGroups: HookGroup[],
  newOmcGroups: HookGroup[],
): { merged: HookGroup[]; logMessages: string[]; result: InstallResult } {
  const logMessages: string[] = [];
  const result = makeResult();
  const merged = mergeHookGroups('SessionEnd', existingGroups, newOmcGroups, {}, (msg) => logMessages.push(msg), result);
  return { merged, logMessages, result };
}

async function loadSessionEndConfig(): Promise<HookGroup[]> {
  const { getHooksSettingsConfig } = await import('../installer/hooks.js');
  const groups = (getHooksSettingsConfig().hooks as Record<string, HookGroup[]>).SessionEnd;
  expect(groups).toBeDefined();
  return groups;
}

// ── Desired config: SessionEnd chain-enqueuer entry ──────────────────────────

describe('chain-enqueuer SessionEnd registration (factory third link)', () => {
  it('registers a SessionEnd hook group delegating to the bridge entry', async () => {
    const groups = await loadSessionEndConfig();

    expect(groups).toHaveLength(1);
    const hook = groups[0].hooks[0];
    expect(hook.type).toBe('command');
    expect(hook.command).toContain('hooks/session-end.mjs');
    // SessionEnd hooks must be async (issue #3240: Windows shutdown kills
    // synchronous SessionEnd hooks before completion).
    expect((hook as { async?: boolean }).async).toBe(true);
    // The command must be recognized as OMC-owned so the merge logic treats
    // existing registrations as OMC state (idempotent skip, legacy cleanup).
    expect(isOmcHook(hook.command)).toBe(true);
  });

  it('bridge forwarder template exists and targets the chain-enqueuing bridge path', () => {
    const templatePath = join(REPO_ROOT, 'templates', 'hooks', 'session-end.mjs');
    expect(existsSync(templatePath)).toBe(true);

    const source = readFileSync(templatePath, 'utf8');
    // Must delegate to --hook=session-end (bridge), the only entry that runs
    // processSessionEnd → planChainEnqueue. publishSessionEndBootstrap (the
    // plugin scripts/session-end.mjs path) does not enqueue chains.
    expect(source).toContain("'--hook=session-end'");
    expect(source).toContain('bridge');
  });

  // ── 未注册 → 注册成功 ─────────────────────────────────────────────────────

  it('unregistered event: merge installs the chain-enqueuer hook', async () => {
    const desired = await loadSessionEndConfig();
    const { merged, logMessages, result } = merge([], desired);

    expect(merged).toEqual(desired);
    expect(logMessages[0]).toMatch(/Installed SessionEnd hook/);
    expect(result.hookConflicts).toHaveLength(0);
  });

  // ── 已注册 → 幂等跳过 ─────────────────────────────────────────────────────

  it('already registered: merge skips without duplicating the hook', async () => {
    const desired = await loadSessionEndConfig();
    const existing = JSON.parse(JSON.stringify(desired)) as HookGroup[];
    const { merged, logMessages, result } = merge(existing, desired);

    expect(merged).toEqual(existing);
    expect(merged).toHaveLength(1);
    expect(logMessages[0]).toMatch(/already configured, skipping/);
    expect(result.hookConflicts).toHaveLength(0);
  });

  it('repeat installs converge to a stable settings shape (no duplicate groups)', async () => {
    const desired = await loadSessionEndConfig();

    // Simulate two consecutive installs against the same settings.json.
    const first = merge([], desired).merged;
    const second = merge(first, desired).merged;

    expect(second).toEqual(desired);
    expect(second).toHaveLength(1);
  });
});

// ── Forwarder subprocess smoke test ──────────────────────────────────────────

describe('templates/hooks/session-end.mjs forwarder', () => {
  it('consumes a SessionEnd payload and exits 0 even when the bridge is unreachable', () => {
    const templatePath = join(REPO_ROOT, 'templates', 'hooks', 'session-end.mjs');
    const payload = JSON.stringify({
      session_id: 'test-session',
      transcript_path: '',
      cwd: REPO_ROOT,
      hook_event_name: 'SessionEnd',
      reason: 'prompt_input_exit',
    });

    // Best-effort contract: whatever the bridge resolution outcome (omc-cli
    // present or not), the forwarder must exit 0 and never block shutdown.
    // Strip CLAUDE_PLUGIN_ROOT so the test never runs the real bridge against
    // a fabricated session payload.
    const env = { ...process.env } as Record<string, string | undefined>;
    delete env.CLAUDE_PLUGIN_ROOT;
    const stdout = execFileSync(process.execPath, [templatePath], {
      input: payload,
      timeout: 20000,
      windowsHide: true,
      env: env as NodeJS.ProcessEnv,
    });
    expect(stdout.toString()).toBeDefined();
  });
});
