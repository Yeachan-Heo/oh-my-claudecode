import { describe, it, expect, vi } from 'vitest';
import { sendTmuxTrigger } from '../tmux-comm.js';
import { sendToWorker } from '../tmux-session.js';
vi.mock('../tmux-session.js', () => ({
    sendToWorker: vi.fn(),
}));
describe('sendTmuxTrigger', () => {
    it('delegates to sendToWorker robust path', async () => {
        vi.mocked(sendToWorker).mockResolvedValueOnce(true);
        const result = await sendTmuxTrigger('%1', 'check-inbox');
        expect(result).toBe(true);
        expect(sendToWorker).toHaveBeenCalledWith('', '%1', 'check-inbox');
    });
    it('returns false on tmux error (does not throw)', async () => {
        vi.mocked(sendToWorker).mockRejectedValueOnce(new Error('tmux not found'));
        const result = await sendTmuxTrigger('%99', 'check-inbox');
        expect(result).toBe(false);
    });
    it('rejects messages over 200 chars (security: no silent truncation)', async () => {
        vi.mocked(sendToWorker).mockClear();
        const longMsg = 'a'.repeat(300);
        const result = await sendTmuxTrigger('%1', longMsg);
        expect(result).toBe(false);
        expect(sendToWorker).not.toHaveBeenCalled();
    });
});
//# sourceMappingURL=tmux-comm.test.js.map