import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
vi.mock('../callbacks.js', () => ({
    triggerStopCallbacks: vi.fn(async () => undefined),
    runSessionEndDeferredAction: vi.fn(async () => ({ status: 'completed' })),
}));
vi.mock('../../../notifications/index.js', () => ({
    notify: vi.fn(async () => undefined),
}));
vi.mock('../../../tools/python-repl/bridge-manager.js', () => ({
    cleanupBridgeSessions: vi.fn(async () => ({
        requestedSessions: 0,
        foundSessions: 0,
        terminatedSessions: 0,
        errors: [],
    })),
}));
import { processSessionEndCleanupWorker } from '../index.js';
import { prepareCoreManifest, sealCoreManifest, sealWikiManifest } from '../cleanup-manifest.js';
import { cleanupBridgeSessions } from '../../../tools/python-repl/bridge-manager.js';
describe('processSessionEndCleanupWorker python bridge cleanup', () => {
    let tmpDir;
    let transcriptPath;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-session-end-bridge-'));
        transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.clearAllMocks();
    });
    it('passes extracted python_repl sessions to cleanupBridgeSessions', async () => {
        const transcriptLines = [
            JSON.stringify({
                type: 'assistant',
                message: {
                    content: [
                        { type: 'tool_use', name: 'mcp__t__python_repl', input: { action: 'execute', researchSessionID: 'bridge-A' } },
                        { type: 'tool_use', name: 'python_repl', input: { action: 'get_state', researchSessionID: 'bridge-B' } },
                    ],
                },
            }),
        ];
        fs.writeFileSync(transcriptPath, transcriptLines.join('\n'), 'utf-8');
        prepareCoreManifest(tmpDir, 'session-123', { transcriptPath });
        sealCoreManifest(tmpDir, 'session-123');
        sealWikiManifest(tmpDir, 'session-123');
        await processSessionEndCleanupWorker({
            directory: tmpDir,
            sessionId: 'session-123',
            transcriptPath,
            cleanupBudgetMs: 2000,
        });
        expect(cleanupBridgeSessions).toHaveBeenCalledTimes(1);
        const calledWith = vi.mocked(cleanupBridgeSessions).mock.calls[0]?.[0];
        expect(calledWith.sort()).toEqual(['bridge-A', 'bridge-B'].sort());
    });
});
//# sourceMappingURL=session-end-bridge-cleanup.test.js.map