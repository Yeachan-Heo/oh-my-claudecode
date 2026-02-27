import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolvePipelineConfig, getDeprecationWarning, buildPipelineTracking, getActiveAdapters, readPipelineTracking, initPipeline, getCurrentStageAdapter, advanceStage, failCurrentStage, incrementStageIteration, getCurrentCompletionSignal, getSignalToStageMap, getPipelineStatus, formatPipelineHUD, hasPipelineTracking, } from '../pipeline.js';
import { DEFAULT_PIPELINE_CONFIG, STAGE_ORDER, DEPRECATED_MODE_ALIASES, } from '../pipeline-types.js';
import { ralplanAdapter, executionAdapter, ralphAdapter, qaAdapter, RALPLAN_COMPLETION_SIGNAL, EXECUTION_COMPLETION_SIGNAL, RALPH_COMPLETION_SIGNAL, QA_COMPLETION_SIGNAL, ALL_ADAPTERS, getAdapterById, } from '../adapters/index.js';
import { readAutopilotState } from '../state.js';
describe('Pipeline Types', () => {
    it('should have 4 stages in canonical order', () => {
        expect(STAGE_ORDER).toEqual(['ralplan', 'execution', 'ralph', 'qa']);
    });
    it('should define default pipeline config', () => {
        expect(DEFAULT_PIPELINE_CONFIG).toEqual({
            planning: 'ralplan',
            execution: 'solo',
            verification: { engine: 'ralph', maxIterations: 100 },
            qa: true,
        });
    });
    it('should define deprecation aliases for ultrawork and ultrapilot', () => {
        expect(DEPRECATED_MODE_ALIASES).toHaveProperty('ultrawork');
        expect(DEPRECATED_MODE_ALIASES).toHaveProperty('ultrapilot');
        expect(DEPRECATED_MODE_ALIASES.ultrawork.config.execution).toBe('team');
        expect(DEPRECATED_MODE_ALIASES.ultrapilot.config.execution).toBe('team');
    });
});
describe('Stage Adapters', () => {
    it('should have 4 adapters in order', () => {
        expect(ALL_ADAPTERS).toHaveLength(4);
        expect(ALL_ADAPTERS.map(a => a.id)).toEqual(['ralplan', 'execution', 'ralph', 'qa']);
    });
    it('should look up adapters by id', () => {
        expect(getAdapterById('ralplan')).toBe(ralplanAdapter);
        expect(getAdapterById('execution')).toBe(executionAdapter);
        expect(getAdapterById('ralph')).toBe(ralphAdapter);
        expect(getAdapterById('qa')).toBe(qaAdapter);
        expect(getAdapterById('nonexistent')).toBeUndefined();
    });
    describe('ralplanAdapter', () => {
        it('should skip when planning is false', () => {
            expect(ralplanAdapter.shouldSkip({ ...DEFAULT_PIPELINE_CONFIG, planning: false })).toBe(true);
        });
        it('should not skip when planning is ralplan', () => {
            expect(ralplanAdapter.shouldSkip(DEFAULT_PIPELINE_CONFIG)).toBe(false);
        });
        it('should not skip when planning is direct', () => {
            expect(ralplanAdapter.shouldSkip({ ...DEFAULT_PIPELINE_CONFIG, planning: 'direct' })).toBe(false);
        });
        it('should have correct completion signal', () => {
            expect(ralplanAdapter.completionSignal).toBe(RALPLAN_COMPLETION_SIGNAL);
        });
        it('should generate ralplan prompt when planning is ralplan', () => {
            const prompt = ralplanAdapter.getPrompt({
                idea: 'build a CLI tool',
                directory: '/tmp/test',
                config: DEFAULT_PIPELINE_CONFIG,
            });
            expect(prompt).toContain('RALPLAN');
            expect(prompt).toContain('Consensus Planning');
            expect(prompt).toContain(RALPLAN_COMPLETION_SIGNAL);
        });
        it('should generate direct prompt when planning is direct', () => {
            const prompt = ralplanAdapter.getPrompt({
                idea: 'build a CLI tool',
                directory: '/tmp/test',
                config: { ...DEFAULT_PIPELINE_CONFIG, planning: 'direct' },
            });
            expect(prompt).toContain('PLANNING (Direct)');
            expect(prompt).toContain(RALPLAN_COMPLETION_SIGNAL);
        });
    });
    describe('executionAdapter', () => {
        it('should never skip', () => {
            expect(executionAdapter.shouldSkip(DEFAULT_PIPELINE_CONFIG)).toBe(false);
            expect(executionAdapter.shouldSkip({ ...DEFAULT_PIPELINE_CONFIG, execution: 'team' })).toBe(false);
        });
        it('should generate team prompt for team mode', () => {
            const prompt = executionAdapter.getPrompt({
                idea: 'test',
                directory: '/tmp',
                config: { ...DEFAULT_PIPELINE_CONFIG, execution: 'team' },
            });
            expect(prompt).toContain('Team Mode');
            expect(prompt).toContain('TeamCreate');
            expect(prompt).toContain(EXECUTION_COMPLETION_SIGNAL);
        });
        it('should generate solo prompt for solo mode', () => {
            const prompt = executionAdapter.getPrompt({
                idea: 'test',
                directory: '/tmp',
                config: DEFAULT_PIPELINE_CONFIG,
            });
            expect(prompt).toContain('Solo Mode');
            expect(prompt).toContain(EXECUTION_COMPLETION_SIGNAL);
        });
    });
    describe('ralphAdapter', () => {
        it('should skip when verification is false', () => {
            expect(ralphAdapter.shouldSkip({ ...DEFAULT_PIPELINE_CONFIG, verification: false })).toBe(true);
        });
        it('should not skip when verification is configured', () => {
            expect(ralphAdapter.shouldSkip(DEFAULT_PIPELINE_CONFIG)).toBe(false);
        });
        it('should include maxIterations in prompt', () => {
            const prompt = ralphAdapter.getPrompt({
                idea: 'test',
                directory: '/tmp',
                config: {
                    ...DEFAULT_PIPELINE_CONFIG,
                    verification: { engine: 'ralph', maxIterations: 50 },
                },
            });
            expect(prompt).toContain('50');
            expect(prompt).toContain(RALPH_COMPLETION_SIGNAL);
        });
    });
    describe('qaAdapter', () => {
        it('should skip when qa is false', () => {
            expect(qaAdapter.shouldSkip({ ...DEFAULT_PIPELINE_CONFIG, qa: false })).toBe(true);
        });
        it('should not skip when qa is true', () => {
            expect(qaAdapter.shouldSkip(DEFAULT_PIPELINE_CONFIG)).toBe(false);
        });
    });
});
describe('resolvePipelineConfig', () => {
    it('should return defaults when no overrides', () => {
        expect(resolvePipelineConfig()).toEqual(DEFAULT_PIPELINE_CONFIG);
    });
    it('should apply user overrides', () => {
        const config = resolvePipelineConfig({ execution: 'team', qa: false });
        expect(config.execution).toBe('team');
        expect(config.qa).toBe(false);
        expect(config.planning).toBe('ralplan'); // unchanged
    });
    it('should apply deprecated mode aliases', () => {
        const config = resolvePipelineConfig(undefined, 'ultrawork');
        expect(config.execution).toBe('team');
    });
    it('should let user overrides win over deprecated aliases', () => {
        const config = resolvePipelineConfig({ execution: 'solo' }, 'ultrawork');
        expect(config.execution).toBe('solo');
    });
    it('should return defaults for unknown deprecated modes', () => {
        const config = resolvePipelineConfig(undefined, 'unknown');
        expect(config).toEqual(DEFAULT_PIPELINE_CONFIG);
    });
});
describe('getDeprecationWarning', () => {
    it('should return warning for ultrawork', () => {
        const warning = getDeprecationWarning('ultrawork');
        expect(warning).toContain('deprecated');
    });
    it('should return warning for ultrapilot', () => {
        const warning = getDeprecationWarning('ultrapilot');
        expect(warning).toContain('deprecated');
    });
    it('should return null for non-deprecated modes', () => {
        expect(getDeprecationWarning('autopilot')).toBeNull();
        expect(getDeprecationWarning('team')).toBeNull();
    });
});
describe('buildPipelineTracking', () => {
    it('should create stages for all 4 stages with default config', () => {
        const tracking = buildPipelineTracking(DEFAULT_PIPELINE_CONFIG);
        expect(tracking.stages).toHaveLength(4);
        expect(tracking.stages.map(s => s.id)).toEqual(STAGE_ORDER);
        expect(tracking.stages.every(s => s.status === 'pending')).toBe(true);
        expect(tracking.currentStageIndex).toBe(0);
    });
    it('should mark skipped stages', () => {
        const config = {
            planning: false,
            execution: 'solo',
            verification: false,
            qa: false,
        };
        const tracking = buildPipelineTracking(config);
        expect(tracking.stages[0].status).toBe('skipped'); // ralplan
        expect(tracking.stages[1].status).toBe('pending'); // execution
        expect(tracking.stages[2].status).toBe('skipped'); // ralph
        expect(tracking.stages[3].status).toBe('skipped'); // qa
        expect(tracking.currentStageIndex).toBe(1); // first non-skipped
    });
    it('should store the config', () => {
        const tracking = buildPipelineTracking(DEFAULT_PIPELINE_CONFIG);
        expect(tracking.pipelineConfig).toEqual(DEFAULT_PIPELINE_CONFIG);
    });
});
describe('getActiveAdapters', () => {
    it('should return all adapters with default config', () => {
        const adapters = getActiveAdapters(DEFAULT_PIPELINE_CONFIG);
        expect(adapters).toHaveLength(4);
    });
    it('should exclude skipped adapters', () => {
        const config = {
            planning: false,
            execution: 'solo',
            verification: false,
            qa: true,
        };
        const adapters = getActiveAdapters(config);
        expect(adapters).toHaveLength(2);
        expect(adapters.map(a => a.id)).toEqual(['execution', 'qa']);
    });
});
describe('Signal mapping', () => {
    it('should map all completion signals to stage IDs', () => {
        const map = getSignalToStageMap();
        expect(map.get(RALPLAN_COMPLETION_SIGNAL)).toBe('ralplan');
        expect(map.get(EXECUTION_COMPLETION_SIGNAL)).toBe('execution');
        expect(map.get(RALPH_COMPLETION_SIGNAL)).toBe('ralph');
        expect(map.get(QA_COMPLETION_SIGNAL)).toBe('qa');
    });
});
describe('Pipeline Orchestrator (with state)', () => {
    let testDir;
    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'pipeline-test-'));
    });
    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });
    describe('initPipeline', () => {
        it('should initialize autopilot state with pipeline tracking', () => {
            const state = initPipeline(testDir, 'build a CLI');
            expect(state).not.toBeNull();
            expect(state.active).toBe(true);
            expect(state.originalIdea).toBe('build a CLI');
            expect(hasPipelineTracking(state)).toBe(true);
            const tracking = readPipelineTracking(state);
            expect(tracking).not.toBeNull();
            expect(tracking.stages).toHaveLength(4);
            expect(tracking.stages[0].status).toBe('active'); // first stage activated
            expect(tracking.stages[0].startedAt).toBeTruthy();
        });
        it('should apply pipeline config overrides', () => {
            const state = initPipeline(testDir, 'test', undefined, undefined, {
                execution: 'team',
                verification: false,
            });
            const tracking = readPipelineTracking(state);
            expect(tracking.pipelineConfig.execution).toBe('team');
            expect(tracking.pipelineConfig.verification).toBe(false);
            expect(tracking.stages[2].status).toBe('skipped'); // ralph skipped
        });
        it('should handle deprecated mode names', () => {
            const state = initPipeline(testDir, 'test', undefined, undefined, undefined, 'ultrawork');
            const tracking = readPipelineTracking(state);
            expect(tracking.pipelineConfig.execution).toBe('team');
        });
    });
    describe('getCurrentStageAdapter', () => {
        it('should return the first adapter', () => {
            const state = initPipeline(testDir, 'test');
            const tracking = readPipelineTracking(state);
            const adapter = getCurrentStageAdapter(tracking);
            expect(adapter).toBe(ralplanAdapter);
        });
        it('should skip to first active stage', () => {
            const state = initPipeline(testDir, 'test', undefined, undefined, {
                planning: false,
            });
            const tracking = readPipelineTracking(state);
            const adapter = getCurrentStageAdapter(tracking);
            expect(adapter).toBe(executionAdapter);
        });
    });
    describe('getCurrentCompletionSignal', () => {
        it('should return the current stage completion signal', () => {
            const state = initPipeline(testDir, 'test');
            const tracking = readPipelineTracking(state);
            expect(getCurrentCompletionSignal(tracking)).toBe(RALPLAN_COMPLETION_SIGNAL);
        });
    });
    describe('advanceStage', () => {
        it('should advance from ralplan to execution', () => {
            initPipeline(testDir, 'test');
            const { adapter, phase } = advanceStage(testDir);
            expect(adapter).toBe(executionAdapter);
            expect(phase).toBe('execution');
            // Verify state persisted
            const state = readAutopilotState(testDir);
            const tracking = readPipelineTracking(state);
            expect(tracking.stages[0].status).toBe('complete');
            expect(tracking.stages[1].status).toBe('active');
            expect(tracking.currentStageIndex).toBe(1);
        });
        it('should skip disabled stages during advance', () => {
            initPipeline(testDir, 'test', undefined, undefined, {
                verification: false, // skip ralph
            });
            // Advance past ralplan
            advanceStage(testDir);
            // Advance past execution — should skip ralph and go to qa
            const { adapter, phase } = advanceStage(testDir);
            expect(adapter).toBe(qaAdapter);
            expect(phase).toBe('qa');
        });
        it('should return complete when all stages done', () => {
            initPipeline(testDir, 'test', undefined, undefined, {
                planning: false,
                verification: false,
                qa: false,
            });
            // Only execution is active — advance completes pipeline
            const { adapter, phase } = advanceStage(testDir);
            expect(adapter).toBeNull();
            expect(phase).toBe('complete');
        });
    });
    describe('failCurrentStage', () => {
        it('should mark current stage as failed', () => {
            initPipeline(testDir, 'test');
            failCurrentStage(testDir, 'Something went wrong');
            const state = readAutopilotState(testDir);
            const tracking = readPipelineTracking(state);
            expect(tracking.stages[0].status).toBe('failed');
            expect(tracking.stages[0].error).toBe('Something went wrong');
        });
    });
    describe('incrementStageIteration', () => {
        it('should increment the current stage iteration counter', () => {
            initPipeline(testDir, 'test');
            incrementStageIteration(testDir);
            incrementStageIteration(testDir);
            const state = readAutopilotState(testDir);
            const tracking = readPipelineTracking(state);
            expect(tracking.stages[0].iterations).toBe(2);
        });
    });
    describe('getPipelineStatus', () => {
        it('should report initial status', () => {
            const state = initPipeline(testDir, 'test');
            const tracking = readPipelineTracking(state);
            const status = getPipelineStatus(tracking);
            expect(status.currentStage).toBe('ralplan');
            expect(status.completedStages).toEqual([]);
            expect(status.pendingStages).toEqual(['execution', 'ralph', 'qa']);
            expect(status.skippedStages).toEqual([]);
            expect(status.isComplete).toBe(false);
            expect(status.progress).toBe('0/4 stages');
        });
        it('should show progress after advancing', () => {
            initPipeline(testDir, 'test');
            advanceStage(testDir);
            const state = readAutopilotState(testDir);
            const tracking = readPipelineTracking(state);
            const status = getPipelineStatus(tracking);
            expect(status.currentStage).toBe('execution');
            expect(status.completedStages).toEqual(['ralplan']);
            expect(status.progress).toBe('1/4 stages');
        });
    });
    describe('formatPipelineHUD', () => {
        it('should format initial HUD', () => {
            const state = initPipeline(testDir, 'test');
            const tracking = readPipelineTracking(state);
            const hud = formatPipelineHUD(tracking);
            expect(hud).toContain('[>>]'); // active stage
            expect(hud).toContain('[..]'); // pending stages
            expect(hud).toContain('0/4 stages');
        });
        it('should show skipped stages', () => {
            const state = initPipeline(testDir, 'test', undefined, undefined, {
                verification: false,
            });
            const tracking = readPipelineTracking(state);
            const hud = formatPipelineHUD(tracking);
            expect(hud).toContain('[--]'); // skipped
        });
    });
});
//# sourceMappingURL=pipeline.test.js.map