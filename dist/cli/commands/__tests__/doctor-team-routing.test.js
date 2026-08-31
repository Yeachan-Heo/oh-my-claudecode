import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    loadConfig: vi.fn(),
    probeCli: vi.fn(),
}));
vi.mock('../../../config/loader.js', () => ({
    loadConfig: mocks.loadConfig,
}));
vi.mock('../../../team/cli-detection.js', () => ({
    probeCli: mocks.probeCli,
}));
import { doctorTeamRoutingCommand } from '../doctor-team-routing.js';
function configWithProviders(providers) {
    return {
        team: {
            roleRouting: Object.fromEntries(providers.map((provider, index) => [`role-${index}`, { provider }])),
        },
    };
}
function output(spy) {
    return spy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
}
describe('doctorTeamRoutingCommand', () => {
    let logSpy;
    let errorSpy;
    beforeEach(() => {
        mocks.loadConfig.mockReset();
        mocks.probeCli.mockReset();
        mocks.loadConfig.mockReturnValue(configWithProviders([]));
        mocks.probeCli.mockReturnValue({ found: false, error: 'CLI resolver failed' });
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => {
        logSpy.mockRestore();
        errorSpy.mockRestore();
    });
    it('emits ordered JSON probes with resolved fields and only missing providers', async () => {
        mocks.loadConfig.mockReturnValue(configWithProviders(['codex', 'gemini', 'codex']));
        const probeResults = {
            claude: { found: true, path: '/opt/claude', version: 'claude 1.0.0' },
            codex: { found: true, path: '/opt/codex', version: 'codex 2.0.0' },
            gemini: { found: false, error: 'CLI resolver failed' },
        };
        mocks.probeCli.mockImplementation((binary) => probeResults[binary]);
        const exitCode = await doctorTeamRoutingCommand({ json: true });
        const json = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
        expect(exitCode).toBe(0);
        expect(json.probes.map((probe) => probe.provider)).toEqual(['claude', 'codex', 'gemini']);
        expect(json.probes.map((probe) => probe.binary)).toEqual(['claude', 'codex', 'gemini']);
        expect(json.probes[0]).toMatchObject({
            provider: 'claude',
            binary: 'claude',
            found: true,
            path: '/opt/claude',
            version: 'claude 1.0.0',
        });
        expect(json.probes[2]).toMatchObject({
            provider: 'gemini',
            binary: 'gemini',
            found: false,
            error: 'CLI resolver failed',
        });
        expect(json.missing).toEqual(['gemini']);
    });
    it('keeps the all-available human output concise', async () => {
        mocks.loadConfig.mockReturnValue(configWithProviders(['codex']));
        mocks.probeCli.mockImplementation((binary) => ({
            found: true,
            path: `/opt/${binary}`,
            version: `${binary} 1.0.0`,
        }));
        const exitCode = await doctorTeamRoutingCommand({});
        const text = output(logSpy);
        expect(exitCode).toBe(0);
        expect(text).toContain('claude: /opt/claude (claude 1.0.0)');
        expect(text).toContain('codex: /opt/codex (codex 1.0.0)');
        expect(text).toContain('All configured providers are available.');
        expect(text).not.toContain('missing');
        expect(text).not.toContain('fallback');
    });
    it('says selected external workers fail before launch when Claude is found', async () => {
        mocks.loadConfig.mockReturnValue(configWithProviders(['codex']));
        mocks.probeCli.mockImplementation((binary) => binary === 'claude'
            ? { found: true, path: '/opt/claude' }
            : { found: false, error: 'CLI resolver failed' });
        const exitCode = await doctorTeamRoutingCommand({});
        const text = output(logSpy);
        expect(exitCode).toBe(0);
        expect(text).toContain('codex: not found on PATH');
        expect(text).toContain('selected for codex fail before launch');
        expect(text).not.toContain('fallback');
    });
    it('reports strict selected-provider failures when an external route and Claude are missing', async () => {
        mocks.loadConfig.mockReturnValue(configWithProviders(['codex']));
        mocks.probeCli.mockReturnValue({ found: false, error: 'CLI resolver failed' });
        const exitCode = await doctorTeamRoutingCommand({});
        const text = output(logSpy);
        expect(exitCode).toBe(0);
        expect(text).toContain('codex: not found on PATH');
        expect(text).toContain('selected for codex fail before launch');
        expect(text).toContain('orchestrator unavailable');
        expect(text).not.toContain('fallback');
    });
    it('reports orchestrator unavailability without promising a fallback', async () => {
        mocks.loadConfig.mockReturnValue(configWithProviders(['codex']));
        mocks.probeCli.mockImplementation((binary) => binary === 'claude'
            ? { found: false, error: 'CLI resolver failed' }
            : { found: true, path: '/opt/codex', version: 'codex 2.0.0' });
        const exitCode = await doctorTeamRoutingCommand({});
        const text = output(logSpy);
        expect(exitCode).toBe(0);
        expect(text).toContain('claude: not found on PATH');
        expect(text).toContain('orchestrator unavailable');
        expect(text).not.toContain('fallback');
    });
    it('keeps resolved providers found when version enrichment fails or returns blank output', async () => {
        mocks.loadConfig.mockReturnValue(configWithProviders(['codex']));
        mocks.probeCli.mockImplementation((binary) => binary === 'claude'
            ? { found: true, path: '/opt/claude', error: 'version probe returned no output' }
            : { found: true, path: '/opt/codex', error: 'version probe failed' });
        const exitCode = await doctorTeamRoutingCommand({ json: true });
        const json = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
        expect(exitCode).toBe(0);
        expect(json.missing).toEqual([]);
        expect(json.probes).toEqual([
            {
                provider: 'claude',
                binary: 'claude',
                found: true,
                path: '/opt/claude',
                error: 'version probe returned no output',
            },
            {
                provider: 'codex',
                binary: 'codex',
                found: true,
                path: '/opt/codex',
                error: 'version probe failed',
            },
        ]);
        logSpy.mockClear();
        await doctorTeamRoutingCommand({});
        const text = output(logSpy);
        expect(text).toContain('version unavailable');
        expect(text).not.toContain('undefined');
    });
    it('returns one when configuration loading fails', async () => {
        mocks.loadConfig.mockImplementation(() => {
            throw new Error('invalid config');
        });
        const exitCode = await doctorTeamRoutingCommand({ json: true });
        expect(exitCode).toBe(1);
        expect(errorSpy).toHaveBeenCalledWith('[OMC] Failed to load config: invalid config');
        expect(mocks.probeCli).not.toHaveBeenCalled();
    });
});
//# sourceMappingURL=doctor-team-routing.test.js.map