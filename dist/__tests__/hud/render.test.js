import { describe, it, expect, vi, beforeEach } from 'vitest';
import { limitOutputLines } from '../../hud/render.js';
import { render } from '../../hud/render.js';
import { DEFAULT_HUD_CONFIG, PRESET_CONFIGS } from '../../hud/types.js';
import { stringWidth } from '../../utils/string-width.js';
// Mock git elements
vi.mock('../../hud/elements/git.js', () => ({
    renderGitRepo: vi.fn(() => 'repo:my-repo'),
    renderGitBranch: vi.fn(() => 'branch:main'),
}));
vi.mock('../../hud/elements/cwd.js', () => ({
    renderCwd: vi.fn(() => '~/workspace/project'),
}));
describe('limitOutputLines', () => {
    describe('basic functionality', () => {
        it('returns all lines when count is within limit', () => {
            const lines = ['line1', 'line2', 'line3'];
            const result = limitOutputLines(lines, 5);
            expect(result).toEqual(['line1', 'line2', 'line3']);
            expect(result).toHaveLength(3);
        });
        it('returns all lines when count equals limit', () => {
            const lines = ['line1', 'line2', 'line3', 'line4'];
            const result = limitOutputLines(lines, 4);
            expect(result).toEqual(['line1', 'line2', 'line3', 'line4']);
            expect(result).toHaveLength(4);
        });
        it('truncates lines with indicator when count exceeds limit', () => {
            const lines = ['header', 'detail1', 'detail2', 'detail3', 'detail4', 'detail5'];
            const result = limitOutputLines(lines, 4);
            expect(result).toEqual(['header', 'detail1', 'detail2', '... (+3 lines)']);
            expect(result).toHaveLength(4);
        });
        it('preserves the first (header) line when truncating', () => {
            const lines = ['[OMC] Header Line', 'Agents: ...', 'Todos: ...', 'Analytics: ...', 'Extra: ...'];
            const result = limitOutputLines(lines, 3);
            expect(result[0]).toBe('[OMC] Header Line');
            expect(result).toHaveLength(3);
            expect(result[2]).toBe('... (+3 lines)');
        });
        it('handles empty array', () => {
            const result = limitOutputLines([], 4);
            expect(result).toEqual([]);
            expect(result).toHaveLength(0);
        });
        it('handles single line array', () => {
            const result = limitOutputLines(['only line'], 4);
            expect(result).toEqual(['only line']);
            expect(result).toHaveLength(1);
        });
    });
    describe('truncation indicator', () => {
        it('shows correct count of truncated lines', () => {
            const lines = ['line1', 'line2', 'line3', 'line4', 'line5', 'line6'];
            const result = limitOutputLines(lines, 3);
            expect(result).toEqual(['line1', 'line2', '... (+4 lines)']);
        });
        it('shows +2 lines when truncating 5 lines to 4', () => {
            const lines = ['a', 'b', 'c', 'd', 'e'];
            const result = limitOutputLines(lines, 4);
            expect(result[3]).toBe('... (+2 lines)');
        });
    });
    describe('default value usage', () => {
        it('uses DEFAULT_HUD_CONFIG.elements.maxOutputLines when maxLines not specified', () => {
            const defaultLimit = DEFAULT_HUD_CONFIG.elements.maxOutputLines;
            const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
            const result = limitOutputLines(lines);
            expect(result).toHaveLength(defaultLimit);
        });
        it('uses DEFAULT_HUD_CONFIG.elements.maxOutputLines when maxLines is undefined', () => {
            const defaultLimit = DEFAULT_HUD_CONFIG.elements.maxOutputLines;
            const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
            const result = limitOutputLines(lines, undefined);
            expect(result).toHaveLength(defaultLimit);
        });
        it('overrides default when maxLines is explicitly provided', () => {
            const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
            const result = limitOutputLines(lines, 2);
            expect(result).toHaveLength(2);
            expect(result).toEqual(['line1', '... (+9 lines)']);
        });
    });
    describe('edge cases', () => {
        it('handles maxLines of 1', () => {
            const lines = ['header', 'detail1', 'detail2'];
            const result = limitOutputLines(lines, 1);
            expect(result).toEqual(['... (+3 lines)']);
            expect(result).toHaveLength(1);
        });
        it('clamps maxLines of 0 to 1', () => {
            const lines = ['header', 'detail1'];
            const result = limitOutputLines(lines, 0);
            expect(result).toEqual(['... (+2 lines)']);
            expect(result).toHaveLength(1);
        });
        it('clamps negative maxLines to 1', () => {
            const lines = ['header', 'detail1', 'detail2'];
            const result = limitOutputLines(lines, -5);
            expect(result).toHaveLength(1);
        });
        it('does not mutate the original array', () => {
            const original = ['line1', 'line2', 'line3', 'line4', 'line5'];
            const originalCopy = [...original];
            limitOutputLines(original, 2);
            expect(original).toEqual(originalCopy);
        });
        it('handles lines with multiline content (newlines within strings)', () => {
            const lines = ['header\nwith newline', 'detail1', 'detail2'];
            const result = limitOutputLines(lines, 2);
            expect(result).toEqual(['header\nwith newline', '... (+2 lines)']);
        });
        it('handles lines with empty strings', () => {
            const lines = ['header', '', 'detail', ''];
            const result = limitOutputLines(lines, 3);
            expect(result).toEqual(['header', '', '... (+2 lines)']);
        });
    });
    describe('preset-specific defaults', () => {
        it('has correct maxOutputLines for each preset', () => {
            expect(PRESET_CONFIGS.minimal.maxOutputLines).toBe(2);
            expect(PRESET_CONFIGS.focused.maxOutputLines).toBe(4);
            expect(PRESET_CONFIGS.full.maxOutputLines).toBe(12);
            expect(PRESET_CONFIGS.dense.maxOutputLines).toBe(6);
            expect(PRESET_CONFIGS.opencode.maxOutputLines).toBe(4);
        });
    });
    describe('Issue #222 scenario simulation', () => {
        it('prevents input field shrinkage by limiting excessive HUD output', () => {
            const excessiveOutput = [
                '[OMC] Rate: 45% | Context: 30%',
                'agents: architect(5m) | executor(2m) | explorer',
                'todos: [1/5] Implementing feature X',
                'Analytics: $1.23 | 50k tokens | Cache: 67%',
                'Budget warning: Approaching limit',
                'Agent detail 1: Working on...',
                'Agent detail 2: Searching...',
                'Extra line that would cause shrinkage',
            ];
            const result = limitOutputLines(excessiveOutput, 4);
            expect(result).toHaveLength(4);
            expect(result[0]).toContain('[OMC]');
            expect(result[3]).toBe('... (+5 lines)');
        });
        it('works with DEFAULT_HUD_CONFIG elements.maxOutputLines value of 4', () => {
            expect(DEFAULT_HUD_CONFIG.elements.maxOutputLines).toBe(4);
        });
    });
});
describe('gitInfoPosition configuration', () => {
    const createMockContext = () => ({
        contextPercent: 30,
        modelName: 'claude-sonnet-4-5',
        ralph: null,
        ultrawork: null,
        prd: null,
        autopilot: null,
        activeAgents: [],
        todos: [],
        backgroundTasks: [],
        cwd: '/home/user/project',
        lastSkill: null,
        rateLimitsResult: null,
        customBuckets: null,
        pendingPermission: null,
        thinkingState: null,
        sessionHealth: { durationMinutes: 10, messageCount: 5, health: 'healthy' },
        omcVersion: '4.5.4',
        updateAvailable: null,
        toolCallCount: 0,
        agentCallCount: 0,
        skillCallCount: 0,
        promptTime: null,
        apiKeySource: null,
        profileName: null,
    });
    const createMockConfig = (gitInfoPosition) => ({
        preset: 'focused',
        elements: {
            ...DEFAULT_HUD_CONFIG.elements,
            cwd: true,
            gitRepo: true,
            gitBranch: true,
            gitInfoPosition,
            omcLabel: true,
            rateLimits: false,
            ralph: false,
            autopilot: false,
            prdStory: false,
            activeSkills: false,
            contextBar: false,
            agents: false,
            backgroundTasks: false,
            todos: false,
            promptTime: false,
            sessionHealth: false,
        },
        thresholds: DEFAULT_HUD_CONFIG.thresholds,
        staleTaskThresholdMinutes: 30,
        contextLimitWarning: DEFAULT_HUD_CONFIG.contextLimitWarning,
        usageApiPollIntervalMs: DEFAULT_HUD_CONFIG.usageApiPollIntervalMs,
    });
    beforeEach(() => {
        vi.clearAllMocks();
    });
    describe('default value', () => {
        it('defaults to "above" for backward compatibility', () => {
            expect(DEFAULT_HUD_CONFIG.elements.gitInfoPosition).toBe('above');
        });
    });
    describe('preset configurations', () => {
        it('all presets have gitInfoPosition set to "above"', () => {
            expect(PRESET_CONFIGS.minimal.gitInfoPosition).toBe('above');
            expect(PRESET_CONFIGS.focused.gitInfoPosition).toBe('above');
            expect(PRESET_CONFIGS.full.gitInfoPosition).toBe('above');
            expect(PRESET_CONFIGS.dense.gitInfoPosition).toBe('above');
            expect(PRESET_CONFIGS.opencode.gitInfoPosition).toBe('above');
        });
    });
    describe('render with gitInfoPosition: above', () => {
        it('places git info line before the main HUD header', async () => {
            const context = createMockContext();
            const config = createMockConfig('above');
            const result = await render(context, config);
            const lines = result.split('\n');
            // First line should be git info
            expect(lines[0]).toContain('repo:my-repo');
            expect(lines[0]).toContain('branch:main');
            // Second line should be the main HUD header (with ANSI codes from bold())
            expect(lines[1]).toMatch(/\[OMC/);
        });
        it('maintains traditional layout with git info above', async () => {
            const context = createMockContext();
            const config = createMockConfig('above');
            const result = await render(context, config);
            const lines = result.split('\n');
            expect(lines.length).toBeGreaterThanOrEqual(2);
            // Git info comes first
            expect(lines[0]).toContain('~/workspace/project');
            // Main header comes second (with ANSI codes from bold())
            expect(lines[1]).toMatch(/\[OMC/);
        });
    });
    describe('render with gitInfoPosition: below', () => {
        it('places git info line after the main HUD header', async () => {
            const context = createMockContext();
            const config = createMockConfig('below');
            const result = await render(context, config);
            const lines = result.split('\n');
            // First line should be the main HUD header (with ANSI codes from bold())
            expect(lines[0]).toMatch(/\[OMC/);
            // Second line should be git info
            expect(lines[1]).toContain('repo:my-repo');
            expect(lines[1]).toContain('branch:main');
        });
        it('places main header before git info', async () => {
            const context = createMockContext();
            const config = createMockConfig('below');
            const result = await render(context, config);
            const lines = result.split('\n');
            expect(lines.length).toBeGreaterThanOrEqual(2);
            // Main header comes first (with ANSI codes from bold())
            expect(lines[0]).toMatch(/\[OMC/);
            // Git info comes second
            expect(lines[1]).toContain('~/workspace/project');
        });
    });
    describe('fallback behavior', () => {
        it('defaults to "above" when gitInfoPosition is undefined', async () => {
            const context = createMockContext();
            const config = createMockConfig('above');
            // Simulate undefined by omitting from elements
            const { gitInfoPosition: _, ...elementsWithoutPosition } = config.elements;
            const configWithoutPosition = {
                ...config,
                elements: elementsWithoutPosition,
            };
            const result = await render(context, configWithoutPosition);
            const lines = result.split('\n');
            // Should default to above behavior
            // Git info should be in the first line (if present)
            const firstLineIsGitInfo = lines[0]?.includes('repo:') || lines[0]?.includes('branch:');
            const firstLineIsHeader = lines[0]?.includes('[OMC]');
            // Either git info is first, or if no git info, header is first
            expect(firstLineIsGitInfo || firstLineIsHeader).toBe(true);
        });
    });
    describe('rate limit rendering', () => {
        it('prefers stale usage percentages over [API 429] when cached data exists', async () => {
            const context = createMockContext();
            context.rateLimitsResult = {
                rateLimits: {
                    fiveHourPercent: 45,
                    weeklyPercent: 12,
                    fiveHourResetsAt: null,
                    weeklyResetsAt: null,
                },
                error: 'rate_limited',
            };
            const config = createMockConfig('above');
            config.elements.rateLimits = true;
            const result = await render(context, config);
            expect(result).toContain('45%');
            expect(result).toContain('12%');
            expect(result).not.toContain('[API 429]');
        });
    });
});
describe('maxWidth wrapMode behavior', () => {
    const createMockContext = () => ({
        contextPercent: 30,
        modelName: '',
        ralph: null,
        ultrawork: null,
        prd: null,
        autopilot: null,
        activeAgents: [],
        todos: [],
        backgroundTasks: [],
        cwd: '/home/user/project',
        lastSkill: null,
        rateLimitsResult: null,
        customBuckets: null,
        pendingPermission: null,
        thinkingState: null,
        sessionHealth: null,
        omcVersion: '4.5.4',
        updateAvailable: null,
        toolCallCount: 0,
        agentCallCount: 0,
        skillCallCount: 0,
        promptTime: null,
        apiKeySource: null,
        profileName: null,
    });
    const createWrapConfig = (wrapMode, maxWidth, maxOutputLines = 6) => ({
        preset: 'focused',
        elements: {
            ...DEFAULT_HUD_CONFIG.elements,
            omcLabel: true,
            rateLimits: false,
            ralph: false,
            autopilot: false,
            prdStory: false,
            activeSkills: false,
            contextBar: true,
            agents: false,
            backgroundTasks: false,
            todos: false,
            promptTime: false,
            sessionHealth: false,
            maxOutputLines,
        },
        thresholds: DEFAULT_HUD_CONFIG.thresholds,
        staleTaskThresholdMinutes: 30,
        contextLimitWarning: {
            ...DEFAULT_HUD_CONFIG.contextLimitWarning,
            threshold: 101,
        },
        usageApiPollIntervalMs: DEFAULT_HUD_CONFIG.usageApiPollIntervalMs,
        maxWidth,
        wrapMode,
    });
    it('uses truncate mode by default when wrapMode is not provided', async () => {
        const context = createMockContext();
        context.contextPercent = 88; // makes header longer
        const config = createWrapConfig('truncate', 24);
        delete config.wrapMode;
        const result = await render(context, config);
        const lines = result.split('\n');
        expect(lines[0]).toMatch(/\.\.\.$/);
    });
    it('wraps long HUD lines at separator boundaries in wrap mode', async () => {
        const context = createMockContext();
        context.contextPercent = 88;
        const config = createWrapConfig('wrap', 24);
        const result = await render(context, config);
        const lines = result.split('\n');
        expect(lines.length).toBeGreaterThan(1);
        expect(lines[0]).toContain('[OMC');
        lines.forEach(line => {
            expect(stringWidth(line)).toBeLessThanOrEqual(24);
        });
    });
    it('respects maxOutputLines after wrap expansion', async () => {
        const context = createMockContext();
        context.contextPercent = 88;
        const config = createWrapConfig('wrap', 14, 2);
        const result = await render(context, config);
        const lines = result.split('\n');
        expect(lines).toHaveLength(2);
        lines.forEach(line => {
            expect(stringWidth(line)).toBeLessThanOrEqual(14);
        });
    });
    it('keeps truncation indicator within maxWidth when maxOutputLines is hit', async () => {
        const context = createMockContext();
        context.contextPercent = 88;
        const config = createWrapConfig('wrap', 8, 1);
        const result = await render(context, config);
        const lines = result.split('\n');
        expect(lines).toHaveLength(1);
        expect(stringWidth(lines[0] ?? '')).toBeLessThanOrEqual(8);
    });
});
//# sourceMappingURL=render.test.js.map