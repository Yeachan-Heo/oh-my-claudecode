import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
vi.mock('child_process', () => ({
    spawnSync: vi.fn(),
}));
import { spawnSync } from 'child_process';
describe('CLI win32 platform warning (#923)', () => {
    const originalPlatform = process.platform;
    let warnSpy;
    beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        vi.resetModules();
    });
    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        warnSpy.mockRestore();
        vi.resetModules();
    });
    it('should warn on win32 when tmux is not available', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        vi.mocked(spawnSync).mockReturnValue({ status: 1 });
        const { warnIfWin32 } = await import('../cli/win32-warning.js');
        warnIfWin32();
        expect(warnSpy).toHaveBeenCalled();
        const allOutput = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(allOutput).toContain('win32');
        expect(allOutput).toContain('tmux');
        expect(allOutput).toContain('WSL2');
        expect(allOutput).toContain('psmux');
    });
    it('should NOT warn on win32 when tmux (or psmux) is available', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        vi.mocked(spawnSync).mockReturnValue({ status: 0 });
        const { warnIfWin32 } = await import('../cli/win32-warning.js');
        warnIfWin32();
        expect(warnSpy).not.toHaveBeenCalled();
    });
    it('should NOT warn on linux platform', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        const { warnIfWin32 } = await import('../cli/win32-warning.js');
        warnIfWin32();
        expect(warnSpy).not.toHaveBeenCalled();
    });
    it('should NOT warn on darwin platform', async () => {
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
        const { warnIfWin32 } = await import('../cli/win32-warning.js');
        warnIfWin32();
        expect(warnSpy).not.toHaveBeenCalled();
    });
    it('should not block execution after warning', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        vi.mocked(spawnSync).mockReturnValue({ status: 1 });
        const { warnIfWin32 } = await import('../cli/win32-warning.js');
        let continued = false;
        warnIfWin32();
        continued = true;
        expect(continued).toBe(true);
    });
});
//# sourceMappingURL=cli-win32-warning.test.js.map