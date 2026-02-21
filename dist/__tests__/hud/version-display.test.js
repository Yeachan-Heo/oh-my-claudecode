import { describe, it, expect } from 'vitest';
import { render } from '../../hud/render.js';
import { DEFAULT_HUD_CONFIG } from '../../hud/types.js';
function createMinimalContext(overrides = {}) {
    return {
        contextPercent: 30,
        modelName: 'claude-sonnet-4.6',
        ralph: null,
        ultrawork: null,
        prd: null,
        autopilot: null,
        activeAgents: [],
        todos: [],
        backgroundTasks: [],
        cwd: '/tmp/test',
        lastSkill: null,
        rateLimits: null,
        customBuckets: null,
        pendingPermission: null,
        thinkingState: null,
        sessionHealth: null,
        omcVersion: null,
        updateAvailable: null,
        toolCallCount: 0,
        agentCallCount: 0,
        skillCallCount: 0,
        ...overrides,
    };
}
function createMinimalConfig(overrides = {}) {
    return {
        ...DEFAULT_HUD_CONFIG,
        elements: {
            ...DEFAULT_HUD_CONFIG.elements,
            omcLabel: true,
            rateLimits: false,
            ralph: false,
            autopilot: false,
            prdStory: false,
            activeSkills: false,
            lastSkill: false,
            contextBar: false,
            agents: false,
            backgroundTasks: false,
            todos: false,
            permissionStatus: false,
            thinking: false,
            sessionHealth: false,
            ...overrides,
        },
    };
}
describe('HUD version display and update notification', () => {
    describe('OMC label without version', () => {
        it('renders [OMC] when omcVersion is null', async () => {
            const ctx = createMinimalContext({ omcVersion: null });
            const config = createMinimalConfig();
            const output = await render(ctx, config);
            expect(output).toContain('[OMC]');
            expect(output).not.toContain('#');
        });
    });
    describe('OMC label with version', () => {
        it('renders [OMC#X.Y.Z] when omcVersion is set', async () => {
            const ctx = createMinimalContext({ omcVersion: '4.1.10' });
            const config = createMinimalConfig();
            const output = await render(ctx, config);
            expect(output).toContain('[OMC#4.1.10]');
        });
        it('renders version without update notice when updateAvailable is null', async () => {
            const ctx = createMinimalContext({ omcVersion: '4.1.10', updateAvailable: null });
            const config = createMinimalConfig();
            const output = await render(ctx, config);
            expect(output).toContain('[OMC#4.1.10]');
            expect(output).not.toContain('->');
            expect(output).not.toContain('omc update');
        });
    });
    describe('update notification', () => {
        it('renders update notification when updateAvailable is set', async () => {
            const ctx = createMinimalContext({ omcVersion: '4.1.10', updateAvailable: '4.2.0' });
            const config = createMinimalConfig();
            const output = await render(ctx, config);
            expect(output).toContain('[OMC#4.1.10]');
            expect(output).toContain('-> 4.2.0');
            expect(output).toContain('omc update');
        });
        it('renders update notification without version when omcVersion is null', async () => {
            const ctx = createMinimalContext({ omcVersion: null, updateAvailable: '4.2.0' });
            const config = createMinimalConfig();
            const output = await render(ctx, config);
            expect(output).toContain('[OMC]');
            expect(output).toContain('-> 4.2.0');
        });
    });
    describe('omcLabel disabled', () => {
        it('does not render OMC label when omcLabel is false', async () => {
            const ctx = createMinimalContext({ omcVersion: '4.1.10', updateAvailable: '4.2.0' });
            const config = createMinimalConfig({ omcLabel: false });
            const output = await render(ctx, config);
            expect(output).not.toContain('[OMC');
            expect(output).not.toContain('omc update');
        });
    });
});
//# sourceMappingURL=version-display.test.js.map