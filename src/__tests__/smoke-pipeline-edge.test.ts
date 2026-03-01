/**
 * Functional Edge-Case Smoke Tests
 *
 * Covers edge cases for Pipeline Orchestrator, Shared Memory, Config Loader,
 * HUD Rendering, and Mode Deprecation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// SHARED MEMORY MOCK — must be declared before any imports that use it
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

// ============================================================================
// MODE-REGISTRY MOCK — needed by pipeline initPipeline
// ============================================================================

vi.mock('../hooks/mode-registry/index.js', () => ({
  canStartMode: () => ({ allowed: true }),
  registerActiveMode: vi.fn(),
  deregisterActiveMode: vi.fn(),
}));

// ============================================================================
// IMPORTS (after mocks)
// ============================================================================

import {
  writeEntry, readEntry, listEntries, deleteEntry,
  cleanupExpired, listNamespaces, isSharedMemoryEnabled,
} from '../lib/shared-memory.js';

import {
  resolvePipelineConfig, getDeprecationWarning,
  buildPipelineTracking, initPipeline, advanceStage,
  getPipelineStatus, formatPipelineHUD, hasPipelineTracking,
} from '../hooks/autopilot/pipeline.js';

import {
  DEFAULT_PIPELINE_CONFIG, STAGE_ORDER, DEPRECATED_MODE_ALIASES,
} from '../hooks/autopilot/pipeline-types.js';

import { loadEnvConfig } from '../config/loader.js';
import { truncateLineToMaxWidth } from '../hud/render.js';

// ============================================================================
// 1. PIPELINE ORCHESTRATOR EDGE CASES (issue #1132)
// ============================================================================

describe('EDGE: Pipeline Orchestrator (issue #1132)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `edge-pipe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    // Pipeline state uses getOmcRoot(worktreeRoot) — mock returns <dir>/.omc for any arg
    mockGetOmcRoot.mockImplementation((dir?: string) => {
      const base = dir || testDir;
      const omcDir = join(base, '.omc');
      mkdirSync(omcDir, { recursive: true });
      return omcDir;
    });
  });

  afterEach(() => {
    mockGetOmcRoot.mockReset();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('resolvePipelineConfig with explicit execution override', () => {
    const config = resolvePipelineConfig({ execution: 'team' });
    expect(config.execution).toBe('team');
    expect(config.planning).toBe(DEFAULT_PIPELINE_CONFIG.planning);
    expect(config.qa).toBe(DEFAULT_PIPELINE_CONFIG.qa);
  });

  it('resolvePipelineConfig with explicit planning override', () => {
    const config = resolvePipelineConfig({ planning: 'direct' });
    expect(config.planning).toBe('direct');
    expect(config.execution).toBe(DEFAULT_PIPELINE_CONFIG.execution);
  });

  it('resolvePipelineConfig with undefined mode causes no deprecation side effects', () => {
    const config = resolvePipelineConfig(undefined, undefined);
    expect(config).toEqual(DEFAULT_PIPELINE_CONFIG);
  });

  it('deprecated mode ultrawork maps execution to team', () => {
    const config = resolvePipelineConfig(undefined, 'ultrawork');
    expect(config.execution).toBe('team');
  });

  it('deprecated mode ultrapilot maps execution to team', () => {
    const config = resolvePipelineConfig(undefined, 'ultrapilot');
    expect(config.execution).toBe('team');
  });

  it('user overrides take precedence over deprecated mode', () => {
    // ultrawork sets execution=team, but explicit solo overrides it
    const config = resolvePipelineConfig({ execution: 'solo' }, 'ultrawork');
    expect(config.execution).toBe('solo');
  });

  it('getDeprecationWarning returns null for non-deprecated modes: autopilot', () => {
    expect(getDeprecationWarning('autopilot')).toBeNull();
  });

  it('getDeprecationWarning returns null for non-deprecated modes: team', () => {
    expect(getDeprecationWarning('team')).toBeNull();
  });

  it('getDeprecationWarning returns null for arbitrary unknown mode', () => {
    expect(getDeprecationWarning('some-random-mode')).toBeNull();
  });

  it('buildPipelineTracking with all stages disabled leaves only complete sentinel', () => {
    const config = {
      ...DEFAULT_PIPELINE_CONFIG,
      planning: false as const,
      verification: false as const,
      qa: false,
    };
    const tracking = buildPipelineTracking(config);

    // All stages marked skipped except execution (solo mode does not skip execution)
    const statuses = tracking.stages.map(s => ({ id: s.id, status: s.status }));
    const skipped = statuses.filter(s => s.status === 'skipped').map(s => s.id);
    expect(skipped).toContain('ralplan');
    expect(skipped).toContain('ralph');
    expect(skipped).toContain('qa');

    // The only active/pending stage should be execution
    const pending = statuses.filter(s => s.status !== 'skipped').map(s => s.id);
    expect(pending).toContain('execution');
  });

  it('advanceStage on already-complete pipeline returns complete without crashing', () => {
    // Init pipeline, then advance through all stages
    const state = initPipeline(testDir, 'test task', 'edge-sess-complete');
    expect(state).not.toBeNull();

    // Advance through all stages
    let result = { adapter: null as unknown, phase: 'ralplan' as string };
    for (let i = 0; i < 10; i++) {
      result = advanceStage(testDir, 'edge-sess-complete');
      if (result.phase === 'complete') break;
    }

    expect(result.phase).toBe('complete');
    expect(result.adapter).toBeNull();

    // Calling advanceStage again on a completed pipeline should fail gracefully
    const again = advanceStage(testDir, 'edge-sess-complete');
    // Either failed (no state to read for next stage) or complete — must not throw
    expect(['complete', 'failed']).toContain(again.phase);
  });

  it('initPipeline + multiple advanceStage calls: full stage order', () => {
    const state = initPipeline(testDir, 'full stage order test', 'edge-sess-order');
    expect(state).not.toBeNull();

    const phases: string[] = [];

    for (let i = 0; i < 10; i++) {
      const result = advanceStage(testDir, 'edge-sess-order');
      phases.push(result.phase);
      if (result.phase === 'complete') break;
    }

    // Must pass through each active stage and end at complete
    const expectedOrder = ['execution', 'ralph', 'qa', 'complete'];
    expect(phases).toEqual(expectedOrder);
  });

  it('formatPipelineHUD with all stages pending', () => {
    const tracking = buildPipelineTracking(DEFAULT_PIPELINE_CONFIG);
    const hud = formatPipelineHUD(tracking);

    expect(hud).toMatch(/Pipeline \d+\/\d+ stages/);
    // First stage is active (set by buildPipelineTracking via initPipeline, but here
    // buildPipelineTracking alone does NOT set active — it marks first as pending)
    // At minimum, pending stages appear as [..] or active as [>>]
    expect(hud).toMatch(/\[\.\.\]|\[>>\]/);
  });

  it('formatPipelineHUD with mixed stage statuses', () => {
    const tracking = buildPipelineTracking(DEFAULT_PIPELINE_CONFIG);
    // Simulate: ralplan complete, execution active with 2 iters, rest pending
    tracking.stages[0].status = 'complete';
    tracking.stages[1].status = 'active';
    tracking.stages[1].iterations = 2;
    tracking.currentStageIndex = 1;

    const hud = formatPipelineHUD(tracking);
    expect(hud).toContain('[OK]');
    expect(hud).toContain('[>>]');
    expect(hud).toContain('iter 2');
    expect(hud).toMatch(/\[\.\.\]/); // remaining stages still pending
  });

  it('formatPipelineHUD with all stages complete', () => {
    const tracking = buildPipelineTracking(DEFAULT_PIPELINE_CONFIG);
    for (const stage of tracking.stages) {
      if (stage.status !== 'skipped') {
        stage.status = 'complete';
      }
    }
    tracking.currentStageIndex = tracking.stages.length;

    const hud = formatPipelineHUD(tracking);
    // Should show [OK] for each non-skipped stage
    const okCount = (hud.match(/\[OK\]/g) || []).length;
    const activeStages = tracking.stages.filter(s => s.status !== 'skipped').length;
    expect(okCount).toBe(activeStages);
    // Should not show any pending markers
    expect(hud).not.toMatch(/\[\.\.\]/);
  });

  it('STAGE_ORDER contains exactly the four expected stages', () => {
    expect(STAGE_ORDER).toHaveLength(4);
    expect([...STAGE_ORDER]).toEqual(['ralplan', 'execution', 'ralph', 'qa']);
  });

  it('DEFAULT_PIPELINE_CONFIG has expected default values', () => {
    expect(DEFAULT_PIPELINE_CONFIG.planning).toBe('ralplan');
    expect(DEFAULT_PIPELINE_CONFIG.execution).toBe('solo');
    expect(DEFAULT_PIPELINE_CONFIG.qa).toBe(true);
    expect(DEFAULT_PIPELINE_CONFIG.verification).not.toBe(false);
    if (DEFAULT_PIPELINE_CONFIG.verification) {
      expect(DEFAULT_PIPELINE_CONFIG.verification.engine).toBe('ralph');
      expect(DEFAULT_PIPELINE_CONFIG.verification.maxIterations).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// 2. SHARED MEMORY EDGE CASES (issue #1137)
// ============================================================================

describe('EDGE: Shared Memory (issue #1137)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `edge-shmem-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const omcDir = join(testDir, '.omc');
    mkdirSync(omcDir, { recursive: true });
    mockGetOmcRoot.mockReturnValue(omcDir);
  });

  afterEach(() => {
    mockGetOmcRoot.mockReset();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('writeEntry with very large value (100KB JSON)', () => {
    const largeArray = Array.from({ length: 5000 }, (_, i) => ({
      index: i,
      data: 'x'.repeat(10),
      nested: { a: i, b: String(i) },
    }));
    const entry = writeEntry('large-ns', 'big-key', largeArray);
    expect(entry.key).toBe('big-key');
    expect(entry.namespace).toBe('large-ns');

    const read = readEntry('large-ns', 'big-key');
    expect(read).not.toBeNull();
    expect(Array.isArray(read!.value)).toBe(true);
    expect((read!.value as typeof largeArray).length).toBe(5000);
  });

  it('writeEntry overwrites existing entry, preserves createdAt', () => {
    writeEntry('overwrite-ns', 'k', 'original-value');
    const first = readEntry('overwrite-ns', 'k');
    expect(first!.value).toBe('original-value');
    const createdAt = first!.createdAt;

    writeEntry('overwrite-ns', 'k', 'updated-value');
    const second = readEntry('overwrite-ns', 'k');
    expect(second!.value).toBe('updated-value');
    // original createdAt is preserved on overwrite
    expect(second!.createdAt).toBe(createdAt);
    // updatedAt must be >= createdAt (may be identical if same ms, but never earlier)
    expect(new Date(second!.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(createdAt).getTime());
  });

  it('readEntry on non-existent key returns null', () => {
    const result = readEntry('ns-exists', 'no-such-key');
    expect(result).toBeNull();
  });

  it('readEntry on non-existent namespace returns null', () => {
    const result = readEntry('ns-does-not-exist', 'any-key');
    expect(result).toBeNull();
  });

  it('listEntries on empty namespace returns empty array', () => {
    // Create an empty namespace dir
    const omcDir = mockGetOmcRoot();
    mkdirSync(join(omcDir, 'state', 'shared-memory', 'empty-ns'), { recursive: true });

    const items = listEntries('empty-ns');
    expect(items).toEqual([]);
  });

  it('listNamespaces with no namespaces returns empty array', () => {
    const namespaces = listNamespaces();
    expect(namespaces).toEqual([]);
  });

  it('deleteEntry on non-existent key does not throw and returns false', () => {
    let result: boolean;
    expect(() => {
      result = deleteEntry('ghost-ns', 'ghost-key');
    }).not.toThrow();
    expect(result!).toBe(false);
  });

  it('cleanupExpired on empty namespace returns {removed: 0}', () => {
    const omcDir = mockGetOmcRoot();
    mkdirSync(join(omcDir, 'state', 'shared-memory', 'clean-ns'), { recursive: true });

    const result = cleanupExpired('clean-ns');
    expect(result.removed).toBe(0);
  });

  it('namespace isolation: same key in different namespaces holds different values', () => {
    writeEntry('ns-alpha', 'shared-key', { owner: 'alpha', value: 1 });
    writeEntry('ns-beta', 'shared-key', { owner: 'beta', value: 2 });

    const alpha = readEntry('ns-alpha', 'shared-key');
    const beta = readEntry('ns-beta', 'shared-key');

    expect((alpha!.value as any).owner).toBe('alpha');
    expect((beta!.value as any).owner).toBe('beta');
  });

  it('special characters in values: unicode, nested objects, arrays', () => {
    const value = {
      unicode: '日本語テスト \u2603 \uD83D\uDE00',
      nested: { a: { b: { c: [1, 2, 3] } } },
      array: ['foo', 'bar', null, true, 42],
    };
    writeEntry('special-ns', 'special-key', value);
    const entry = readEntry('special-ns', 'special-key');
    expect(entry).not.toBeNull();
    expect((entry!.value as typeof value).unicode).toBe(value.unicode);
    expect((entry!.value as typeof value).nested.a.b.c).toEqual([1, 2, 3]);
    expect((entry!.value as typeof value).array).toEqual(['foo', 'bar', null, true, 42]);
  });
});

// ============================================================================
// 3. CONFIG LOADER EDGE CASES (issue #1135)
// ============================================================================

describe('EDGE: Config Loader forceInherit (issue #1135)', () => {
  const ORIG = process.env.OMC_ROUTING_FORCE_INHERIT;

  afterEach(() => {
    if (ORIG === undefined) delete process.env.OMC_ROUTING_FORCE_INHERIT;
    else process.env.OMC_ROUTING_FORCE_INHERIT = ORIG;
  });

  it('OMC_ROUTING_FORCE_INHERIT=TRUE (uppercase) does not enable forceInherit', () => {
    // Only 'true' (lowercase) is truthy per the === 'true' check in loader
    process.env.OMC_ROUTING_FORCE_INHERIT = 'TRUE';
    const config = loadEnvConfig();
    expect(config.routing?.forceInherit).toBe(false);
  });

  it('OMC_ROUTING_FORCE_INHERIT=1 (number string) does not enable forceInherit', () => {
    process.env.OMC_ROUTING_FORCE_INHERIT = '1';
    const config = loadEnvConfig();
    expect(config.routing?.forceInherit).toBe(false);
  });

  it('OMC_ROUTING_FORCE_INHERIT=yes is not truthy', () => {
    process.env.OMC_ROUTING_FORCE_INHERIT = 'yes';
    const config = loadEnvConfig();
    expect(config.routing?.forceInherit).toBe(false);
  });

  it('OMC_ROUTING_FORCE_INHERIT=" true " (whitespace) does not enable forceInherit', () => {
    process.env.OMC_ROUTING_FORCE_INHERIT = ' true ';
    const config = loadEnvConfig();
    expect(config.routing?.forceInherit).toBe(false);
  });

  it('OMC_ROUTING_FORCE_INHERIT="" (empty string) sets forceInherit to false', () => {
    process.env.OMC_ROUTING_FORCE_INHERIT = '';
    const config = loadEnvConfig();
    // Empty string !== 'true' so forceInherit should be false
    expect(config.routing?.forceInherit).toBe(false);
  });

  it('multiple env vars set simultaneously: all are reflected', () => {
    process.env.OMC_ROUTING_FORCE_INHERIT = 'true';
    process.env.OMC_ROUTING_ENABLED = 'false';
    process.env.OMC_ROUTING_DEFAULT_TIER = 'HIGH';

    const config = loadEnvConfig();
    expect(config.routing?.forceInherit).toBe(true);
    expect(config.routing?.enabled).toBe(false);
    expect(config.routing?.defaultTier).toBe('HIGH');

    // Clean up extra vars
    delete process.env.OMC_ROUTING_ENABLED;
    delete process.env.OMC_ROUTING_DEFAULT_TIER;
  });
});

// ============================================================================
// 4. HUD RENDERING EDGE CASES (issue #1102)
// ============================================================================

describe('EDGE: HUD truncateLineToMaxWidth (issue #1102)', () => {
  it('maxWidth=1 (extreme small) truncates to ellipsis only', () => {
    // targetWidth = max(0, 1-3) = 0, so no visible chars + ellipsis
    const result = truncateLineToMaxWidth('hello world', 1);
    // Result will be just '...' (no visible chars fit before ellipsis with targetWidth=0)
    expect(result).toBe('...');
  });

  it('string exactly at maxWidth is not truncated', () => {
    const str = 'A'.repeat(20);
    const result = truncateLineToMaxWidth(str, 20);
    expect(result).toBe(str);
  });

  it('string one char over maxWidth is truncated with ellipsis', () => {
    const str = 'A'.repeat(21);
    const result = truncateLineToMaxWidth(str, 20);
    expect(result).toContain('...');
    // visible part should be 17 A's + '...' = 20
    expect(result).toBe('A'.repeat(17) + '...');
  });

  it('string with only ANSI codes (no visible text) is not truncated', () => {
    const ansiOnly = '\x1b[32m\x1b[0m\x1b[1m\x1b[0m';
    // visible width is 0, no truncation needed
    const result = truncateLineToMaxWidth(ansiOnly, 80);
    expect(result).toBe(ansiOnly);
  });

  it('mixed ANSI + CJK + ASCII truncates at correct visual column', () => {
    // Each CJK char = 2 columns, ANSI codes not counted
    const line = '\x1b[32m' + '日本語' + '\x1b[0m' + 'ABC';
    // visible: 日(2) 本(2) 語(2) A(1) B(1) C(1) = 9 cols total → no truncation at maxWidth=10
    const notTruncated = truncateLineToMaxWidth(line, 10);
    expect(notTruncated).toBe(line);

    // At maxWidth=5: targetWidth=2 → only '日' fits (2 cols), then ellipsis
    const truncated = truncateLineToMaxWidth(line, 5);
    expect(truncated).toContain('...');
  });

  it('negative maxWidth returns empty string', () => {
    const result = truncateLineToMaxWidth('hello', -5);
    expect(result).toBe('');
  });

  it('maxWidth=0 returns empty string', () => {
    const result = truncateLineToMaxWidth('hello', 0);
    expect(result).toBe('');
  });
});

// ============================================================================
// 5. MODE DEPRECATION EDGE CASES (issue #1131)
// ============================================================================

describe('EDGE: Mode Deprecation (issue #1131)', () => {
  it('DEPRECATED_MODE_ALIASES does NOT contain autopilot', () => {
    expect(DEPRECATED_MODE_ALIASES['autopilot']).toBeUndefined();
  });

  it('DEPRECATED_MODE_ALIASES does NOT contain team', () => {
    expect(DEPRECATED_MODE_ALIASES['team']).toBeUndefined();
  });

  it('DEPRECATED_MODE_ALIASES does NOT contain ralph', () => {
    expect(DEPRECATED_MODE_ALIASES['ralph']).toBeUndefined();
  });

  it('DEPRECATED_MODE_ALIASES does NOT contain ultraqa', () => {
    expect(DEPRECATED_MODE_ALIASES['ultraqa']).toBeUndefined();
  });

  it('each deprecated mode has required fields: config.execution and message', () => {
    for (const [mode, alias] of Object.entries(DEPRECATED_MODE_ALIASES)) {
      expect(alias.config, `${mode} should have config`).toBeDefined();
      expect(alias.config.execution, `${mode}.config.execution should be set`).toBeDefined();
      expect(typeof alias.message, `${mode}.message should be a string`).toBe('string');
      expect(alias.message.length, `${mode}.message should not be empty`).toBeGreaterThan(0);
    }
  });

  it('deprecated mode config has expected pipeline config structure (execution is valid backend)', () => {
    for (const [mode, alias] of Object.entries(DEPRECATED_MODE_ALIASES)) {
      expect(
        ['team', 'solo'],
        `${mode}.config.execution should be a valid ExecutionBackend`
      ).toContain(alias.config.execution);
    }
  });

  it('ultrawork deprecation message references /autopilot migration path', () => {
    const alias = DEPRECATED_MODE_ALIASES['ultrawork'];
    expect(alias.message).toContain('deprecated');
    expect(alias.message).toContain('/autopilot');
  });

  it('ultrapilot deprecation message references /autopilot migration path', () => {
    const alias = DEPRECATED_MODE_ALIASES['ultrapilot'];
    expect(alias.message).toContain('deprecated');
    expect(alias.message).toContain('/autopilot');
  });
});
