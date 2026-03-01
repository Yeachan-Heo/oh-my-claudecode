/**
 * Functional Smoke Tests — main → dev changelog
 *
 * Tests real behavior of new features and fixes against the live codebase.
 * Not mocked (except filesystem isolation) — exercises actual code paths.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// 1. SHARED MEMORY — Cross-session KV store (issue #1137)
// ============================================================================

const mockGetOmcRoot = vi.fn<(worktreeRoot?: string) => string>();
vi.mock('../lib/worktree-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/worktree-paths.js')>();
  return {
    ...actual,
    getOmcRoot: (...args: [string?]) => mockGetOmcRoot(...args),
    validateWorkingDirectory: (dir?: string) => dir || '/tmp',
  };
});

import {
  writeEntry, readEntry, listEntries, deleteEntry,
  cleanupExpired, listNamespaces, isSharedMemoryEnabled,
} from '../lib/shared-memory.js';

describe('SMOKE: Shared Memory (issue #1137)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `smoke-shmem-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const omcDir = join(testDir, '.omc');
    mkdirSync(omcDir, { recursive: true });
    mockGetOmcRoot.mockReturnValue(omcDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('end-to-end: multi-agent handoff scenario', () => {
    // Agent 1 writes context for Agent 2
    writeEntry('team-alpha', 'auth-decision', {
      method: 'JWT',
      expiresIn: '24h',
      refreshEnabled: true,
    });
    writeEntry('team-alpha', 'db-schema', {
      tables: ['users', 'sessions', 'tokens'],
      migrations: 2,
    });

    // Agent 2 reads context
    const authCtx = readEntry('team-alpha', 'auth-decision');
    expect(authCtx).not.toBeNull();
    expect((authCtx!.value as any).method).toBe('JWT');

    const dbCtx = readEntry('team-alpha', 'db-schema');
    expect((dbCtx!.value as any).tables).toContain('sessions');

    // List keys in namespace
    const keys = listEntries('team-alpha');
    expect(keys).toHaveLength(2);
    expect(keys.map(k => k.key).sort()).toEqual(['auth-decision', 'db-schema']);

    // Different namespace is isolated
    writeEntry('team-beta', 'auth-decision', { method: 'OAuth2' });
    expect((readEntry('team-beta', 'auth-decision')!.value as any).method).toBe('OAuth2');
    expect((readEntry('team-alpha', 'auth-decision')!.value as any).method).toBe('JWT');

    // List all namespaces
    expect(listNamespaces()).toEqual(['team-alpha', 'team-beta']);
  });

  it('TTL auto-expiry works in practice', () => {
    // Write with already-expired TTL by manipulating the file directly
    const omcDir = mockGetOmcRoot();
    const nsDir = join(omcDir, 'state', 'shared-memory', 'ttl-ns');
    mkdirSync(nsDir, { recursive: true });
    writeFileSync(join(nsDir, 'expired.json'), JSON.stringify({
      key: 'expired',
      value: 'stale data',
      namespace: 'ttl-ns',
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: '2020-01-01T00:00:00Z',
      ttl: 60,
      expiresAt: '2020-01-01T00:01:00Z', // long expired
    }));

    // Write a live entry
    writeEntry('ttl-ns', 'live-key', 'fresh data', 86400);

    // Read expired → null, file deleted
    expect(readEntry('ttl-ns', 'expired')).toBeNull();
    expect(existsSync(join(nsDir, 'expired.json'))).toBe(false);

    // Read live → exists
    const live = readEntry('ttl-ns', 'live-key');
    expect(live!.value).toBe('fresh data');
    expect(live!.expiresAt).toBeTruthy();
  });

  it('security: path traversal is blocked', () => {
    expect(() => writeEntry('../../../etc', 'passwd', 'evil')).toThrow();
    expect(() => readEntry('ns', '../../etc/shadow')).toThrow();
    expect(() => writeEntry('ns..secret', 'key', 'v')).toThrow();
  });

  it('cleanup removes only expired entries', () => {
    writeEntry('cleanup-ns', 'keeper', 'I stay');
    const omcDir = mockGetOmcRoot();
    const nsDir = join(omcDir, 'state', 'shared-memory', 'cleanup-ns');
    for (const key of ['dead1', 'dead2', 'dead3']) {
      writeFileSync(join(nsDir, `${key}.json`), JSON.stringify({
        key, value: 'old', namespace: 'cleanup-ns',
        createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z',
        ttl: 1, expiresAt: '2020-01-01T00:00:01Z',
      }));
    }

    const result = cleanupExpired('cleanup-ns');
    expect(result.removed).toBe(3);

    // keeper survives
    expect(readEntry('cleanup-ns', 'keeper')!.value).toBe('I stay');
    expect(listEntries('cleanup-ns')).toHaveLength(1);
  });

  it('config gate returns enabled by default', () => {
    expect(isSharedMemoryEnabled()).toBe(true);
  });
});

// ============================================================================
// 2. MODEL ROUTING — forceInherit (issue #1135)
// ============================================================================

import { routeTask, getModelForTask, analyzeTaskComplexity, quickTierForAgent } from '../features/model-routing/router.js';

describe('SMOKE: Model Routing — forceInherit (issue #1135)', () => {
  const BASE_CONFIG = {
    enabled: true,
    defaultTier: 'MEDIUM' as const,
    escalationEnabled: false,
    maxEscalations: 0,
    tierModels: { LOW: 'haiku', MEDIUM: 'sonnet', HIGH: 'opus' },
  };

  it('forceInherit=true: every agent type returns inherit', () => {
    const agents = ['architect', 'executor', 'explore', 'writer', 'debugger', 'verifier', 'planner', 'critic'];
    for (const agent of agents) {
      const result = routeTask(
        { taskPrompt: 'Refactor the entire auth system with security audit', agentType: agent },
        { ...BASE_CONFIG, forceInherit: true },
      );
      expect(result.model).toBe('inherit');
      expect(result.modelType).toBe('inherit');
      expect(result.confidence).toBe(1.0);
    }
  });

  it('forceInherit=false: routing works normally', () => {
    const simple = routeTask(
      { taskPrompt: 'find all .ts files', agentType: 'explore' },
      { ...BASE_CONFIG, forceInherit: false },
    );
    expect(simple.model).not.toBe('inherit');
    expect(['haiku', 'sonnet', 'opus']).toContain(simple.modelType);

    const complex = routeTask(
      { taskPrompt: 'Redesign the entire database architecture with migration plan for production', agentType: 'architect' },
      { ...BASE_CONFIG, forceInherit: false },
    );
    expect(complex.model).not.toBe('inherit');
  });

  it('complexity analysis produces meaningful output', () => {
    const analysis = analyzeTaskComplexity(
      'Refactor authentication to use JWT tokens across all 15 microservices with backward compatibility',
      'architect',
    );
    expect(analysis.tier).toBeDefined();
    expect(analysis.model).toBeDefined();
    expect(analysis.analysis).toContain('Tier');
    expect(analysis.signals.wordCount).toBeGreaterThan(5);
  });

  it('quickTierForAgent returns expected defaults', () => {
    expect(quickTierForAgent('architect')).toBe('HIGH');
    expect(quickTierForAgent('explore')).toBe('LOW');
    expect(quickTierForAgent('executor')).toBe('MEDIUM');
    expect(quickTierForAgent('unknown-agent')).toBeNull();
  });
});

// ============================================================================
// 3. PIPELINE ORCHESTRATOR (issue #1132)
// ============================================================================

vi.mock('../hooks/mode-registry/index.js', () => ({
  canStartMode: () => ({ allowed: true }),
  registerActiveMode: vi.fn(),
  deregisterActiveMode: vi.fn(),
}));

import {
  resolvePipelineConfig, getDeprecationWarning,
  buildPipelineTracking, initPipeline, advanceStage,
  getPipelineStatus, formatPipelineHUD, hasPipelineTracking,
} from '../hooks/autopilot/pipeline.js';
import { DEFAULT_PIPELINE_CONFIG, STAGE_ORDER } from '../hooks/autopilot/pipeline-types.js';

describe('SMOKE: Pipeline Orchestrator (issue #1132)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `smoke-pipe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('full pipeline lifecycle: init → advance through all stages → complete', () => {
    const state = initPipeline(testDir, 'Build a REST API with auth, CRUD, and tests', 'smoke-sess');
    expect(state).not.toBeNull();
    expect(state!.active).toBe(true);
    expect(hasPipelineTracking(state!)).toBe(true);

    // Check initial status
    const tracking = (state as any).pipeline;
    const status0 = getPipelineStatus(tracking);
    expect(status0.currentStage).toBe('ralplan');
    expect(status0.isComplete).toBe(false);

    // Advance: ralplan → execution
    const r1 = advanceStage(testDir, 'smoke-sess');
    expect(r1.phase).toBe('execution');

    // Advance: execution → ralph
    const r2 = advanceStage(testDir, 'smoke-sess');
    expect(r2.phase).toBe('ralph');

    // Advance: ralph → qa
    const r3 = advanceStage(testDir, 'smoke-sess');
    expect(r3.phase).toBe('qa');

    // Advance: qa → complete
    const r4 = advanceStage(testDir, 'smoke-sess');
    expect(r4.phase).toBe('complete');
    expect(r4.adapter).toBeNull();
  });

  it('deprecated mode "ultrawork" maps to execution=team', () => {
    const config = resolvePipelineConfig(undefined, 'ultrawork');
    expect(config.execution).toBe('team');
    expect(config.planning).toBe('ralplan'); // unchanged default

    const warning = getDeprecationWarning('ultrawork');
    expect(warning).toContain('deprecated');
    expect(warning).toContain('/autopilot');
  });

  it('skipping stages works correctly', () => {
    const config = { ...DEFAULT_PIPELINE_CONFIG, qa: false, planning: false as const };
    const tracking = buildPipelineTracking(config);

    const status = getPipelineStatus(tracking);
    expect(status.skippedStages).toContain('ralplan');
    expect(status.skippedStages).toContain('qa');
    expect(status.pendingStages).toContain('execution');
  });

  it('HUD format is human-readable', () => {
    const tracking = buildPipelineTracking(DEFAULT_PIPELINE_CONFIG);
    tracking.stages[0].status = 'complete';
    tracking.stages[1].status = 'active';
    tracking.stages[1].iterations = 3;
    tracking.currentStageIndex = 1;

    const hud = formatPipelineHUD(tracking);
    expect(hud).toMatch(/Pipeline \d+\/\d+ stages/);
    expect(hud).toContain('[OK]');
    expect(hud).toContain('[>>]');
    expect(hud).toContain('iter 3');
  });
});

// ============================================================================
// 4. OMC-OMX INTEROP ADAPTER (issue #1123)
// ============================================================================

import {
  omxStatusToOmc, omcStatusToOmx,
  mapOmxRoleToCliAgent, omxTaskToTaskFile, taskFileToOmxTask,
  teamConfigToOmx, omxMailboxToInboxMarkdown, isOmxWorker,
} from '../interop/worker-adapter.js';

describe('SMOKE: OMC-OMX Interop Adapter (issue #1123)', () => {
  it('full task round-trip: OMX → OMC → OMX preserves data', () => {
    const original = {
      id: 'task-42',
      subject: 'Implement auth middleware',
      description: 'Add JWT validation middleware to Express routes',
      status: 'blocked' as const,
      owner: 'codex-worker-1',
      blocked_by: ['task-41'],
      depends_on: ['task-41'],
      created_at: '2026-02-28T00:00:00Z',
    };

    // OMX → OMC
    const taskFile = omxTaskToTaskFile(original);
    expect(taskFile.id).toBe('task-42');
    expect(taskFile.status).toBe('pending'); // lossy: blocked → pending
    expect(taskFile.blockedBy).toEqual(['task-41']);

    // OMC → OMX (round-trip recovery)
    const recovered = taskFileToOmxTask(taskFile);
    expect(recovered.id).toBe('task-42');
    expect(recovered.status).toBe('blocked'); // recovered!
    expect(recovered.subject).toBe('Implement auth middleware');
  });

  it('all 5 OMX statuses map correctly', () => {
    const statuses = ['pending', 'blocked', 'in_progress', 'completed', 'failed'] as const;
    for (const s of statuses) {
      const result = omxStatusToOmc(s);
      expect(result.annotation.originalSystem).toBe('omx');
      expect(result.annotation.originalStatus).toBe(s);
      if (s === 'blocked') {
        expect(result.status).toBe('pending');
        expect(result.annotation.lossy).toBe(true);
      } else {
        expect(result.status).toBe(s);
        expect(result.annotation.lossy).toBe(false);
      }
    }
  });

  it('role mapping handles all CLI types', () => {
    expect(mapOmxRoleToCliAgent('claude')).toBe('claude');
    expect(mapOmxRoleToCliAgent('codex')).toBe('codex');
    expect(mapOmxRoleToCliAgent('gemini')).toBe('gemini');
    expect(mapOmxRoleToCliAgent('CODEX')).toBe('codex');
    expect(mapOmxRoleToCliAgent('developer')).toBe('claude');
    expect(mapOmxRoleToCliAgent('researcher')).toBe('claude');
  });

  it('teamConfigToOmx produces valid OMX config', () => {
    const omxConfig = teamConfigToOmx({
      teamName: 'feature-auth',
      workerCount: 3,
      agentTypes: ['claude' as any, 'codex' as any, 'gemini' as any],
      tasks: [
        { subject: 'Backend API', description: 'Build REST endpoints' },
        { subject: 'Frontend UI', description: 'Build React components' },
        { subject: 'Tests', description: 'Write E2E tests' },
      ],
      cwd: '/project',
    });

    expect(omxConfig.name).toBe('feature-auth');
    expect(omxConfig.worker_count).toBe(3);
    expect(omxConfig.workers).toHaveLength(3);
    expect(omxConfig.workers[0].role).toBe('claude');
    expect(omxConfig.workers[1].role).toBe('codex');
    expect(omxConfig.next_task_id).toBe(4);
  });

  it('markdown inbox format is readable', () => {
    const md = omxMailboxToInboxMarkdown({
      message_id: 'msg-1',
      from_worker: 'codex-worker-2',
      to_worker: 'leader',
      body: 'Completed backend API with 12 endpoints. All tests passing.',
      created_at: '2026-02-28T12:00:00Z',
    });

    expect(md).toContain('## Message from codex-worker-2');
    expect(md).toContain('12 endpoints');
    expect(md).toContain('2026-02-28');
  });

  it('isOmxWorker distinguishes worker types', () => {
    expect(isOmxWorker({ workerName: 'w1', agentType: 'codex', interopMode: 'omx' })).toBe(true);
    expect(isOmxWorker({ workerName: 'w2', agentType: 'claude', interopMode: 'omc' })).toBe(false);
  });
});

// ============================================================================
// 5. SHELL PATH RESOLUTION (issue #1128)
// ============================================================================

describe('SMOKE: Shell PATH Resolution (issue #1128)', () => {
  it('resolves real shell PATH on Linux', async () => {
    vi.resetModules();
    const mod = await import('../team/shell-path.js');
    mod._resetShellPathCache();

    const path = mod.resolveShellPath();
    expect(path.length).toBeGreaterThan(0);
    // Should contain at least /usr/bin or similar
    expect(path).toMatch(/\/usr\/bin|\/bin|\/usr\/local\/bin/);
  });

  it('resolvedEnv contains PATH and preserves existing vars', async () => {
    vi.resetModules();
    const mod = await import('../team/shell-path.js');
    mod._resetShellPathCache();

    const env = mod.resolvedEnv({ TEST_SMOKE_VAR: 'smoke-value' });
    expect(env.TEST_SMOKE_VAR).toBe('smoke-value');
    expect(env.HOME || env.USERPROFILE).toBeTruthy();

    const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH')!;
    expect(env[pathKey]!.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// 6. HUD maxWidth (issue #1102)
// ============================================================================

import { truncateLineToMaxWidth } from '../hud/render.js';

describe('SMOKE: HUD maxWidth truncation (issue #1102)', () => {
  it('truncates long lines to maxWidth', () => {
    const long = 'A'.repeat(200);
    const truncated = truncateLineToMaxWidth(long, 80);
    // visible width ≤ 80
    expect(truncated.length).toBeLessThanOrEqual(83); // 80 + '...'
    expect(truncated).toContain('...');
  });

  it('does not truncate short lines', () => {
    const short = 'Hello World';
    expect(truncateLineToMaxWidth(short, 80)).toBe(short);
  });

  it('handles CJK double-width characters', () => {
    const cjk = '日本語テスト'.repeat(20); // ~240 visible columns (each char = 2)
    const truncated = truncateLineToMaxWidth(cjk, 40);
    expect(truncated).toContain('...');
  });

  it('handles ANSI escape codes without counting them as width', () => {
    const ansi = '\x1b[32mGreen Text Here\x1b[0m';
    // visible text = "Green Text Here" (15 chars), ANSI codes don't count
    const truncated = truncateLineToMaxWidth(ansi, 80);
    expect(truncated).toBe(ansi); // should not truncate
  });

  it('handles empty string and zero width', () => {
    expect(truncateLineToMaxWidth('', 80)).toBe('');
    expect(truncateLineToMaxWidth('hello', 0)).toBe('');
  });
});

// ============================================================================
// 7. LSP TIMEOUT CONFIG (issue #1106)
// ============================================================================

describe('SMOKE: LSP Timeout Config (issue #1106)', () => {
  it('default timeout is 15000ms', async () => {
    vi.resetModules();
    delete process.env.OMC_LSP_TIMEOUT_MS;
    const mod = await import('../tools/lsp/client.js');
    expect(mod.DEFAULT_LSP_REQUEST_TIMEOUT_MS).toBe(15_000);
  });

  it('respects OMC_LSP_TIMEOUT_MS env var', async () => {
    vi.resetModules();
    process.env.OMC_LSP_TIMEOUT_MS = '45000';
    const mod = await import('../tools/lsp/client.js');
    expect(mod.DEFAULT_LSP_REQUEST_TIMEOUT_MS).toBe(45_000);
    delete process.env.OMC_LSP_TIMEOUT_MS;
  });

  it('falls back to default for invalid values', async () => {
    for (const invalid of ['abc', '0', '-100', '']) {
      vi.resetModules();
      process.env.OMC_LSP_TIMEOUT_MS = invalid;
      const mod = await import('../tools/lsp/client.js');
      expect(mod.DEFAULT_LSP_REQUEST_TIMEOUT_MS).toBe(15_000);
    }
    delete process.env.OMC_LSP_TIMEOUT_MS;
  });
});

// ============================================================================
// 8. MODE DEPRECATION (issue #1131)
// ============================================================================

import { DEPRECATED_MODE_ALIASES } from '../hooks/autopilot/pipeline-types.js';

describe('SMOKE: Mode Deprecation (issue #1131)', () => {
  it('ultrawork is deprecated with migration path', () => {
    const alias = DEPRECATED_MODE_ALIASES['ultrawork'];
    expect(alias).toBeDefined();
    expect(alias.config.execution).toBe('team');
    expect(alias.message).toContain('deprecated');
    expect(alias.message).toContain('/autopilot');
  });

  it('ultrapilot is deprecated with migration path', () => {
    const alias = DEPRECATED_MODE_ALIASES['ultrapilot'];
    expect(alias).toBeDefined();
    expect(alias.config.execution).toBe('team');
    expect(alias.message).toContain('deprecated');
  });

  it('autopilot is NOT deprecated', () => {
    expect(DEPRECATED_MODE_ALIASES['autopilot']).toBeUndefined();
    expect(DEPRECATED_MODE_ALIASES['team']).toBeUndefined();
  });
});

// ============================================================================
// 9. forceInherit ENV VAR (issue #1135)
// ============================================================================

import { loadEnvConfig } from '../config/loader.js';

describe('SMOKE: forceInherit env var (issue #1135)', () => {
  const originalVal = process.env.OMC_ROUTING_FORCE_INHERIT;

  afterEach(() => {
    if (originalVal === undefined) delete process.env.OMC_ROUTING_FORCE_INHERIT;
    else process.env.OMC_ROUTING_FORCE_INHERIT = originalVal;
  });

  it('OMC_ROUTING_FORCE_INHERIT=true enables forceInherit', () => {
    process.env.OMC_ROUTING_FORCE_INHERIT = 'true';
    const config = loadEnvConfig();
    expect(config.routing?.forceInherit).toBe(true);
  });

  it('OMC_ROUTING_FORCE_INHERIT=false disables forceInherit', () => {
    process.env.OMC_ROUTING_FORCE_INHERIT = 'false';
    const config = loadEnvConfig();
    expect(config.routing?.forceInherit).toBe(false);
  });

  it('unset env var leaves forceInherit undefined', () => {
    delete process.env.OMC_ROUTING_FORCE_INHERIT;
    const config = loadEnvConfig();
    expect(config.routing?.forceInherit).toBeUndefined();
  });
});
