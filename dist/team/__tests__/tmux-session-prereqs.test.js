import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        execSync: vi.fn(),
    };
});
import { execSync } from 'child_process';
import { validateTmux } from '../tmux-session.js';
const mockedExecSync = vi.mocked(execSync);
afterEach(() => {
    vi.restoreAllMocks();
});
describe('validateTmux', () => {
    it('skips probing when tmux context is already active', () => {
        mockedExecSync.mockImplementation(() => {
            throw new Error('should not probe');
        });
        expect(() => validateTmux(true)).not.toThrow();
        expect(mockedExecSync).not.toHaveBeenCalled();
    });
    it('probes tmux when context is absent', () => {
        mockedExecSync.mockReturnValue(Buffer.from('tmux 3.4'));
        expect(() => validateTmux(false)).not.toThrow();
        expect(mockedExecSync).toHaveBeenCalledWith('tmux -V', expect.objectContaining({
            encoding: 'utf-8',
            timeout: 5000,
            stdio: 'pipe',
        }));
    });
    it('throws install guidance when tmux is unavailable outside context', () => {
        mockedExecSync.mockImplementation(() => {
            throw new Error('tmux missing');
        });
        expect(() => validateTmux(false)).toThrow(/tmux is not available/i);
    });
});
//# sourceMappingURL=tmux-session-prereqs.test.js.map