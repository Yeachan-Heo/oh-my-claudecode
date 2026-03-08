import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
const { mockSpawn, mockResolveDaemonModulePath, mockIsTmuxAvailable } = vi.hoisted(() => ({
    mockSpawn: vi.fn(),
    mockResolveDaemonModulePath: vi.fn(),
    mockIsTmuxAvailable: vi.fn(() => true),
}));
vi.mock('child_process', () => ({
    spawn: mockSpawn,
}));
vi.mock('../../utils/daemon-module-path.js', () => ({
    resolveDaemonModulePath: mockResolveDaemonModulePath,
}));
vi.mock('../../features/rate-limit-wait/tmux-detector.js', async () => {
    const actual = await vi.importActual('../../features/rate-limit-wait/tmux-detector.js');
    return {
        ...actual,
        isTmuxAvailable: mockIsTmuxAvailable,
    };
});
describe('daemon bootstrap', () => {
    const originalEnv = { ...process.env };
    const testDir = join(tmpdir(), `omc-daemon-bootstrap-test-${Date.now()}`);
    let startDaemon;
    beforeEach(async () => {
        vi.resetModules();
        mockSpawn.mockReset();
        mockResolveDaemonModulePath.mockReset();
        mockIsTmuxAvailable.mockReset();
        mockIsTmuxAvailable.mockReturnValue(true);
        mockResolveDaemonModulePath.mockReturnValue('/repo/dist/features/rate-limit-wait/daemon.js');
        ({ startDaemon } = await import('../../features/rate-limit-wait/daemon.js'));
    });
    afterEach(() => {
        process.env = { ...originalEnv };
        rmSync(testDir, { recursive: true, force: true });
    });
    it('uses resolved daemon module path and sanitized child env when starting', () => {
        const unref = vi.fn();
        mockSpawn.mockReturnValue({ pid: 4242, unref });
        process.env.PATH = '/usr/bin:/bin';
        process.env.TMUX = '/tmp/tmux-1000/default,100,0';
        process.env.ANTHROPIC_API_KEY = 'super-secret';
        process.env.GITHUB_TOKEN = 'token-should-not-leak';
        const config = {
            stateFilePath: join(testDir, 'state.json'),
            pidFilePath: join(testDir, 'daemon.pid'),
            logFilePath: join(testDir, 'daemon.log'),
            pollIntervalMs: 1234,
            verbose: true,
        };
        const result = startDaemon(config);
        expect(result.success).toBe(true);
        expect(result.message).toContain('Daemon started with PID 4242');
        expect(unref).toHaveBeenCalledTimes(1);
        expect(mockResolveDaemonModulePath).toHaveBeenCalledTimes(1);
        expect(mockResolveDaemonModulePath).toHaveBeenCalledWith(expect.any(String), ['features', 'rate-limit-wait', 'daemon.js']);
        expect(mockSpawn).toHaveBeenCalledTimes(1);
        const [command, args, spawnOptions] = mockSpawn.mock.calls[0];
        expect(command).toBe('node');
        expect(args[0]).toBe('-e');
        expect(args[1]).toContain("import('/repo/dist/features/rate-limit-wait/daemon.js')");
        expect(spawnOptions?.detached).toBe(true);
        expect(spawnOptions?.stdio).toBe('ignore');
        const childEnv = spawnOptions?.env;
        expect(childEnv.PATH).toBe('/usr/bin:/bin');
        expect(childEnv.TMUX).toBe('/tmp/tmux-1000/default,100,0');
        expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
        expect(childEnv.GITHUB_TOKEN).toBeUndefined();
        const configPath = childEnv.OMC_DAEMON_CONFIG_FILE;
        expect(configPath).toBeTruthy();
        expect(existsSync(configPath)).toBe(true);
        const persistedConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
        expect(persistedConfig.pollIntervalMs).toBe(1234);
        expect(persistedConfig.verbose).toBe(true);
    });
    it('returns already running when config pid file points to a live process', () => {
        const config = {
            stateFilePath: join(testDir, 'state.json'),
            pidFilePath: join(testDir, 'daemon.pid'),
            logFilePath: join(testDir, 'daemon.log'),
        };
        // Use current process PID so isDaemonRunning() reports true.
        mkdirSync(testDir, { recursive: true });
        writeFileSync(config.pidFilePath, String(process.pid));
        const result = startDaemon(config);
        expect(result.success).toBe(false);
        expect(result.message).toBe('Daemon is already running');
        expect(mockSpawn).not.toHaveBeenCalled();
    });
});
//# sourceMappingURL=daemon-bootstrap.test.js.map