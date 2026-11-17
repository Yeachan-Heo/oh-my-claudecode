import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const SYNTHETIC_THINKING_CONTENT = '[Synthetic thinking block inserted to preserve message structure]';
describe('recovery storage issue #1386 regression', () => {
    const originalXdgDataHome = process.env.XDG_DATA_HOME;
    let dataDir;
    beforeEach(() => {
        dataDir = mkdtempSync(join(tmpdir(), 'issue-1386-recovery-'));
        process.env.XDG_DATA_HOME = dataDir;
        vi.resetModules();
    });
    afterEach(() => {
        if (originalXdgDataHome === undefined) {
            delete process.env.XDG_DATA_HOME;
        }
        else {
            process.env.XDG_DATA_HOME = originalXdgDataHome;
        }
        vi.resetModules();
    });
    it('prepends generic synthetic thinking instead of reusing prior assistant thinking', async () => {
        const sessionID = 'session-1';
        const priorMessageID = 'assistant-1';
        const targetMessageID = 'assistant-2';
        const staleThinking = 'Old reasoning that should never be copied forward';
        const storageRoot = join(dataDir, 'claude-code', 'storage');
        const messageDir = join(storageRoot, 'message', sessionID);
        const priorPartDir = join(storageRoot, 'part', priorMessageID);
        const targetPartDir = join(storageRoot, 'part', targetMessageID);
        mkdirSync(messageDir, { recursive: true });
        mkdirSync(priorPartDir, { recursive: true });
        mkdirSync(targetPartDir, { recursive: true });
        writeFileSync(join(messageDir, `${priorMessageID}.json`), JSON.stringify({
            id: priorMessageID,
            sessionID,
            role: 'assistant',
            time: { created: 1 },
        }));
        writeFileSync(join(messageDir, `${targetMessageID}.json`), JSON.stringify({
            id: targetMessageID,
            sessionID,
            role: 'assistant',
            time: { created: 2 },
        }));
        writeFileSync(join(priorPartDir, 'thinking.json'), JSON.stringify({
            id: 'thinking-1',
            sessionID,
            messageID: priorMessageID,
            type: 'thinking',
            thinking: staleThinking,
        }));
        const { prependThinkingPart } = await import('../storage.js');
        expect(prependThinkingPart(sessionID, targetMessageID)).toBe(true);
        const insertedPart = JSON.parse(readFileSync(join(targetPartDir, 'prt_0000000000_thinking.json'), 'utf-8'));
        expect(insertedPart).toMatchObject({
            type: 'thinking',
            synthetic: true,
            thinking: SYNTHETIC_THINKING_CONTENT,
        });
        expect(insertedPart.thinking).not.toContain(staleThinking);
    });
});
//# sourceMappingURL=storage.test.js.map