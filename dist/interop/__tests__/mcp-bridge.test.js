import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { canUseOmxDirectWriteBridge, getInteropMode, interopReadMessagesTool, interopReadResultsTool, interopSendMessageTool, interopSendOmxMessageTool, interopSendTaskTool, } from '../mcp-bridge.js';
import { initInteropSession, readSharedMessages, readSharedTasks, updateSharedTask } from '../shared-state.js';
describe('interop mcp bridge gating', () => {
    it('getInteropMode normalizes invalid values to off', () => {
        expect(getInteropMode({ OMX_OMC_INTEROP_MODE: 'ACTIVE' })).toBe('active');
        expect(getInteropMode({ OMX_OMC_INTEROP_MODE: 'observe' })).toBe('observe');
        expect(getInteropMode({ OMX_OMC_INTEROP_MODE: 'nonsense' })).toBe('off');
    });
    it('canUseOmxDirectWriteBridge requires all active flags', () => {
        expect(canUseOmxDirectWriteBridge({
            OMX_OMC_INTEROP_ENABLED: '1',
            OMX_OMC_INTEROP_MODE: 'active',
            OMC_INTEROP_TOOLS_ENABLED: '1',
        })).toBe(true);
        expect(canUseOmxDirectWriteBridge({
            OMX_OMC_INTEROP_ENABLED: '1',
            OMX_OMC_INTEROP_MODE: 'observe',
            OMC_INTEROP_TOOLS_ENABLED: '1',
        })).toBe(false);
        expect(canUseOmxDirectWriteBridge({
            OMX_OMC_INTEROP_ENABLED: '0',
            OMX_OMC_INTEROP_MODE: 'active',
            OMC_INTEROP_TOOLS_ENABLED: '1',
        })).toBe(false);
    });
    it('interop_send_omx_message rejects when direct write path is disabled', async () => {
        const savedEnabled = process.env.OMX_OMC_INTEROP_ENABLED;
        const savedMode = process.env.OMX_OMC_INTEROP_MODE;
        const savedTools = process.env.OMC_INTEROP_TOOLS_ENABLED;
        process.env.OMX_OMC_INTEROP_ENABLED = '0';
        process.env.OMX_OMC_INTEROP_MODE = 'off';
        process.env.OMC_INTEROP_TOOLS_ENABLED = '0';
        try {
            const response = await interopSendOmxMessageTool.handler({
                teamName: 'alpha-team',
                fromWorker: 'omc-bridge',
                toWorker: 'worker-1',
                body: 'blocked',
            });
            expect(response.isError).toBe(true);
            const text = response.content[0]?.text ?? '';
            expect(text.toLowerCase()).toContain('disabled');
        }
        finally {
            if (savedEnabled === undefined)
                delete process.env.OMX_OMC_INTEROP_ENABLED;
            else
                process.env.OMX_OMC_INTEROP_ENABLED = savedEnabled;
            if (savedMode === undefined)
                delete process.env.OMX_OMC_INTEROP_MODE;
            else
                process.env.OMX_OMC_INTEROP_MODE = savedMode;
            if (savedTools === undefined)
                delete process.env.OMC_INTEROP_TOOLS_ENABLED;
            else
                process.env.OMC_INTEROP_TOOLS_ENABLED = savedTools;
        }
    });
});
describe('interop mcp bridge artifact surfacing', () => {
    let tempDir;
    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'mcp-bridge-artifacts-'));
        initInteropSession('session-1', tempDir);
    });
    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });
    it('reports artifact-backed task descriptions and results', async () => {
        const description = 'describe ' + 'x'.repeat(5000);
        const sendResponse = await interopSendTaskTool.handler({
            target: 'omx',
            type: 'implement',
            description,
            workingDirectory: tempDir,
        });
        const sendText = sendResponse.content[0]?.text ?? '';
        expect(sendText).toContain('Description artifact:');
        const [task] = readSharedTasks(tempDir);
        expect(task.descriptionArtifact?.path).toBeTruthy();
        updateSharedTask(tempDir, task.id, {
            status: 'completed',
            result: 'result ' + 'y'.repeat(5000),
        });
        const readResponse = await interopReadResultsTool.handler({
            status: 'completed',
            workingDirectory: tempDir,
        });
        const readText = readResponse.content[0]?.text ?? '';
        expect(readText).toContain('Description artifact:');
        expect(readText).toContain('Result artifact:');
        expect(readText).toContain('.omc/state/interop/artifacts/task-description/');
        expect(readText).toContain('.omc/state/interop/artifacts/task-result/');
    });
    it('reports artifact-backed shared messages', async () => {
        const sendResponse = await interopSendMessageTool.handler({
            target: 'omx',
            content: 'message ' + 'z'.repeat(5000),
            workingDirectory: tempDir,
        });
        const sendText = sendResponse.content[0]?.text ?? '';
        expect(sendText).toContain('Content artifact:');
        const [message] = readSharedMessages(tempDir);
        expect(message.contentArtifact?.path).toBeTruthy();
        const readResponse = await interopReadMessagesTool.handler({
            workingDirectory: tempDir,
        });
        const readText = readResponse.content[0]?.text ?? '';
        expect(readText).toContain('Content artifact:');
        expect(readText).toContain('.omc/state/interop/artifacts/message-content/');
    });
});
//# sourceMappingURL=mcp-bridge.test.js.map