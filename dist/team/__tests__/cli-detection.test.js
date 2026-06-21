import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { detectCli, detectAllClis } from '../cli-detection.js';
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        spawnSync: vi.fn(actual.spawnSync),
    };
});
function setProcessPlatform(platform) {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    return () => {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    };
}
describe('cli-detection', () => {
    it('uses shell:true for Windows provider version probes', () => {
        const mockSpawnSync = vi.mocked(spawnSync);
        const restorePlatform = setProcessPlatform('win32');
        mockSpawnSync
            .mockReturnValueOnce({ status: 0, stdout: 'codex 1.0.0', stderr: '', pid: 0, output: [], signal: null })
            .mockReturnValueOnce({ status: 0, stdout: 'C:\\Tools\\codex.cmd', stderr: '', pid: 0, output: [], signal: null });
        expect(detectCli('codex')).toEqual({
            available: true,
            version: 'codex 1.0.0',
            path: 'C:\\Tools\\codex.cmd',
        });
        expect(mockSpawnSync).toHaveBeenNthCalledWith(1, 'codex', ['--version'], { timeout: 5000, shell: true });
        expect(mockSpawnSync).toHaveBeenNthCalledWith(2, 'where', ['codex'], { timeout: 5000 });
        restorePlatform();
        mockSpawnSync.mockRestore();
    });
    it('detectAllClis probes the antigravity binary (agy)', () => {
        const mockSpawnSync = vi.mocked(spawnSync);
        // Make every probe report not-found so we exercise the agy version probe.
        mockSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null });
        const result = detectAllClis();
        expect(result).toHaveProperty('antigravity');
        expect(result.antigravity).toEqual({ available: false });
        expect(mockSpawnSync).toHaveBeenCalledWith('agy', ['--version'], expect.objectContaining({ timeout: 5000 }));
        mockSpawnSync.mockRestore();
    });
});
//# sourceMappingURL=cli-detection.test.js.map