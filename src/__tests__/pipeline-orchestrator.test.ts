/**
 * Tests for Pipeline Orchestrator (issue #1132)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock mode-registry to allow starting modes in tests
vi.mock('../hooks/mode-registry/index.js', () => ({
  canStartMode: () => ({ allowed: true }),
  registerActiveMode: vi.fn(),
  deregisterActiveMode: vi.fn(),
}));

import {
  resolvePipelineConfig,
  getDeprecationWarning,
  buildPipelineTracking,
  getActiveAdapters,
  initPipeline,
  advanceStage,
  getCurrentStageAdapter,
  getNextStageAdapter,
  failCurrentStage,
  incrementStageIteration,
  getPipelineStatus,
  formatPipelineHUD,
  getCurrentCompletionSignal,
  getSignalToStageMap,
  hasPipelineTracking,
} from '../hooks/autopilot/pipeline.js';
import {
  DEFAULT_PIPELINE_CONFIG,
  STAGE_ORDER,
  DEPRECATED_MODE_ALIASES,
} from '../hooks/autopilot/pipeline-types.js';

describe('Pipeline Orchestrator', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `pipeline-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // Configuration
  // =========================================================================

  describe('resolvePipelineConfig', () => {
    it('returns default config when no overrides', () => {
      const config = resolvePipelineConfig();
      expect(config).toEqual(DEFAULT_PIPELINE_CONFIG);
    });

    it('applies deprecated ultrawork alias (execution: team)', () => {
      const config = resolvePipelineConfig(undefined, 'ultrawork');
      expect(config.execution).toBe('team');
      expect(config.planning).toBe(DEFAULT_PIPELINE_CONFIG.planning);
    });

    it('applies deprecated ultrapilot alias (execution: team)', () => {
      const config = resolvePipelineConfig(undefined, 'ultrapilot');
      expect(config.execution).toBe('team');
    });

    it('applies user overrides on top of defaults', () => {
      const config = resolvePipelineConfig({ qa: false, planning: false });
      expect(config.qa).toBe(false);
      expect(config.planning).toBe(false);
      expect(config.execution).toBe('solo'); // unchanged
    });

    it('user overrides take precedence over deprecated alias', () => {
      const config = resolvePipelineConfig({ execution: 'solo' }, 'ultrawork');
      expect(config.execution).toBe('solo');
    });
  });

  describe('getDeprecationWarning', () => {
    it('returns warning for ultrawork', () => {
      const msg = getDeprecationWarning('ultrawork');
      expect(msg).toContain('/autopilot');
    });

    it('returns warning for ultrapilot', () => {
      const msg = getDeprecationWarning('ultrapilot');
      expect(msg).toContain('/autopilot');
    });

    it('returns null for non-deprecated mode', () => {
      expect(getDeprecationWarning('autopilot')).toBeNull();
      expect(getDeprecationWarning('team')).toBeNull();
    });
  });

  // =========================================================================
  // Pipeline tracking construction
  // =========================================================================

  describe('buildPipelineTracking', () => {
    it('creates 4 stages matching STAGE_ORDER', () => {
      const tracking = buildPipelineTracking(DEFAULT_PIPELINE_CONFIG);
      expect(tracking.stages).toHaveLength(4);
      expect(tracking.stages.map(s => s.id)).toEqual(STAGE_ORDER);
    });

    it('all stages are pending for default config', () => {
      const tracking = buildPipelineTracking(DEFAULT_PIPELINE_CONFIG);
      for (const stage of tracking.stages) {
        expect(stage.status).toBe('pending');
        expect(stage.iterations).toBe(0);
      }
    });

    it('marks skipped stages when config disables them', () => {
      const config = { ...DEFAULT_PIPELINE_CONFIG, qa: false, planning: false as const };
      const tracking = buildPipelineTracking(config);

      const ralplan = tracking.stages.find(s => s.id === 'ralplan')!;
      const qa = tracking.stages.find(s => s.id === 'qa')!;
      expect(ralplan.status).toBe('skipped');
      expect(qa.status).toBe('skipped');

      // First active stage should be 'execution'
      expect(tracking.currentStageIndex).toBe(1);
    });

    it('stores pipeline config in tracking', () => {
      const tracking = buildPipelineTracking(DEFAULT_PIPELINE_CONFIG);
      expect(tracking.pipelineConfig).toEqual(DEFAULT_PIPELINE_CONFIG);
    });
  });

  describe('getActiveAdapters', () => {
    it('returns all adapters for default config', () => {
      const adapters = getActiveAdapters(DEFAULT_PIPELINE_CONFIG);
      expect(adapters.length).toBeGreaterThanOrEqual(3);
    });

    it('returns fewer adapters when stages are skipped', () => {
      const config = { ...DEFAULT_PIPELINE_CONFIG, qa: false, planning: false as const };
      const full = getActiveAdapters(DEFAULT_PIPELINE_CONFIG);
      const reduced = getActiveAdapters(config);
      expect(reduced.length).toBeLessThan(full.length);
    });
  });

  // =========================================================================
  // Stage navigation
  // =========================================================================

  describe('getCurrentStageAdapter / getNextStageAdapter', () => {
    it('returns adapter for first pending stage', () => {
      const tracking = buildPipelineTracking(DEFAULT_PIPELINE_CONFIG);
      tracking.stages[0].status = 'active';
      const adapter = getCurrentStageAdapter(tracking);
      expect(adapter).not.toBeNull();
      expect(adapter!.id).toBe('ralplan');
    });

    it('returns next adapter after current', () => {
      const tracking = buildPipelineTracking(DEFAULT_PIPELINE_CONFIG);
      tracking.stages[0].status = 'active';
      const next = getNextStageAdapter(tracking);
      expect(next).not.toBeNull();
      expect(next!.id).toBe('execution');
    });

    it('returns null when pipeline is complete', () => {
      const tracking = buildPipelineTracking(DEFAULT_PIPELINE_CONFIG);
      tracking.currentStageIndex = tracking.stages.length;
      const adapter = getCurrentStageAdapter(tracking);
      expect(adapter).toBeNull();
    });
  });

  // =========================================================================
  // Pipeline lifecycle (init + advance)
  // =========================================================================

  describe('initPipeline', () => {
    it('creates state with first stage active', () => {
      const state = initPipeline(testDir, 'build auth system', 'sess-1');
      expect(state).not.toBeNull();
      expect(state!.active).toBe(true);
      expect(state!.originalIdea).toBe('build auth system');
      expect(hasPipelineTracking(state!)).toBe(true);
    });

    it('applies deprecated mode config', () => {
      const state = initPipeline(testDir, 'task', 'sess-2', undefined, undefined, 'ultrawork');
      expect(state).not.toBeNull();
      // Pipeline tracking should reflect team execution
      const extended = state as any;
      expect(extended.pipeline.pipelineConfig.execution).toBe('team');
    });
  });

  describe('advanceStage', () => {
    it('advances from ralplan to execution', () => {
      initPipeline(testDir, 'task', 'sess-3');
      const result = advanceStage(testDir, 'sess-3');
      expect(result.adapter).not.toBeNull();
      expect(result.phase).toBe('execution');
    });

    it('returns complete after all stages', () => {
      initPipeline(testDir, 'task', 'sess-4');
      // Advance through all stages
      let result;
      for (let i = 0; i < STAGE_ORDER.length; i++) {
        result = advanceStage(testDir, 'sess-4');
      }
      expect(result!.phase).toBe('complete');
      expect(result!.adapter).toBeNull();
    });
  });

  describe('failCurrentStage', () => {
    it('marks stage as failed', () => {
      initPipeline(testDir, 'task', 'sess-5');
      const ok = failCurrentStage(testDir, 'timeout error', 'sess-5');
      expect(ok).toBe(true);
    });
  });

  describe('incrementStageIteration', () => {
    it('increments iteration counter', () => {
      initPipeline(testDir, 'task', 'sess-6');
      expect(incrementStageIteration(testDir, 'sess-6')).toBe(true);
    });
  });

  // =========================================================================
  // Status & display
  // =========================================================================

  describe('getPipelineStatus', () => {
    it('returns correct summary', () => {
      const tracking = buildPipelineTracking(DEFAULT_PIPELINE_CONFIG);
      tracking.stages[0].status = 'complete';
      tracking.stages[1].status = 'active';
      tracking.currentStageIndex = 1;

      const status = getPipelineStatus(tracking);
      expect(status.completedStages).toContain('ralplan');
      expect(status.currentStage).toBe('execution');
      expect(status.isComplete).toBe(false);
      expect(status.progress).toContain('/');
    });
  });

  describe('formatPipelineHUD', () => {
    it('produces readable HUD string', () => {
      const tracking = buildPipelineTracking(DEFAULT_PIPELINE_CONFIG);
      tracking.stages[0].status = 'complete';
      tracking.stages[1].status = 'active';
      tracking.currentStageIndex = 1;

      const hud = formatPipelineHUD(tracking);
      expect(hud).toContain('[OK]');
      expect(hud).toContain('[>>]');
      expect(hud).toContain('Pipeline');
    });
  });

  // =========================================================================
  // Signal mapping
  // =========================================================================

  describe('signals', () => {
    it('getCurrentCompletionSignal returns signal for active stage', () => {
      const tracking = buildPipelineTracking(DEFAULT_PIPELINE_CONFIG);
      tracking.stages[0].status = 'active';
      const signal = getCurrentCompletionSignal(tracking);
      expect(typeof signal).toBe('string');
      expect(signal!.length).toBeGreaterThan(0);
    });

    it('getSignalToStageMap covers all stages', () => {
      const map = getSignalToStageMap();
      expect(map.size).toBeGreaterThanOrEqual(STAGE_ORDER.length);
    });
  });

  // =========================================================================
  // Constants
  // =========================================================================

  describe('constants', () => {
    it('STAGE_ORDER has correct sequence', () => {
      expect(STAGE_ORDER).toEqual(['ralplan', 'execution', 'ralph', 'qa']);
    });

    it('DEPRECATED_MODE_ALIASES has ultrawork and ultrapilot', () => {
      expect(DEPRECATED_MODE_ALIASES).toHaveProperty('ultrawork');
      expect(DEPRECATED_MODE_ALIASES).toHaveProperty('ultrapilot');
    });
  });
});
