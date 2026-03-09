import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
vi.mock('../callbacks.js', () => ({
    triggerStopCallbacks: vi.fn(async () => undefined),
}));
vi.mock('../../../features/auto-update.js', () => ({
    getOMCConfig: vi.fn(() => ({
        silentAutoUpdate: false,
        stopHookCallbacks: undefined,
        notifications: undefined,
        notificationProfiles: undefined,
    })),
}));
vi.mock('../../../notifications/config.js', async () => {
    const actual = await vi.importActual('../../../notifications/config.js');
    return {
        ...actual,
        buildConfigFromEnv: vi.fn(() => null),
        getNotificationConfig: vi.fn(() => null),
        getEnabledPlatforms: vi.fn(() => []),
    };
});
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
import { processSessionEnd } from '../index.js';
import { triggerStopCallbacks } from '../callbacks.js';
import { getOMCConfig } from '../../../features/auto-update.js';
import { buildConfigFromEnv, getEnabledPlatforms, getNotificationConfig } from '../../../notifications/config.js';
import { notify } from '../../../notifications/index.js';
describe('processSessionEnd notification deduplication (issue #1440)', () => {
    let tmpDir;
    let transcriptPath;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-session-end-dedupe-'));
        transcriptPath = path.join(tmpDir, 'transcript.jsonl');
        fs.writeFileSync(transcriptPath, JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'done' }] },
        }), 'utf-8');
        vi.clearAllMocks();
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.unstubAllEnvs();
    });
    it('does not re-dispatch session-end through notify() when config only comes from legacy stopHookCallbacks', async () => {
        vi.mocked(getOMCConfig).mockReturnValue({
            silentAutoUpdate: false,
            stopHookCallbacks: {
                discord: {
                    enabled: true,
                    webhookUrl: 'https://discord.com/api/webhooks/legacy',
                },
            },
            notifications: undefined,
            notificationProfiles: undefined,
        });
        vi.mocked(buildConfigFromEnv).mockReturnValue(null);
        vi.mocked(getNotificationConfig).mockReturnValue({
            enabled: true,
            events: {
                'session-end': { enabled: true },
            },
            discord: {
                enabled: true,
                webhookUrl: 'https://discord.com/api/webhooks/legacy',
            },
        });
        vi.mocked(getEnabledPlatforms).mockReturnValue(['discord']);
        await processSessionEnd({
            session_id: 'session-legacy-only',
            transcript_path: transcriptPath,
            cwd: tmpDir,
            permission_mode: 'default',
            hook_event_name: 'SessionEnd',
            reason: 'clear',
        });
        expect(triggerStopCallbacks).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'session-legacy-only' }), { session_id: 'session-legacy-only', cwd: tmpDir }, { skipPlatforms: [] });
        expect(notify).not.toHaveBeenCalled();
    });
    it('skips the legacy Discord callback when explicit session-end notifications already cover Discord', async () => {
        vi.mocked(getOMCConfig).mockReturnValue({
            silentAutoUpdate: false,
            stopHookCallbacks: {
                discord: {
                    enabled: true,
                    webhookUrl: 'https://discord.com/api/webhooks/legacy',
                },
            },
            notifications: {
                enabled: true,
                events: {
                    'session-end': { enabled: true },
                },
                discord: {
                    enabled: true,
                    webhookUrl: 'https://discord.com/api/webhooks/new',
                },
            },
            notificationProfiles: undefined,
        });
        vi.mocked(buildConfigFromEnv).mockReturnValue(null);
        vi.mocked(getNotificationConfig).mockReturnValue({
            enabled: true,
            events: {
                'session-end': { enabled: true },
            },
            discord: {
                enabled: true,
                webhookUrl: 'https://discord.com/api/webhooks/new',
            },
        });
        vi.mocked(getEnabledPlatforms).mockReturnValue(['discord']);
        await processSessionEnd({
            session_id: 'session-new-discord',
            transcript_path: transcriptPath,
            cwd: tmpDir,
            permission_mode: 'default',
            hook_event_name: 'SessionEnd',
            reason: 'clear',
        });
        expect(triggerStopCallbacks).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'session-new-discord' }), { session_id: 'session-new-discord', cwd: tmpDir }, { skipPlatforms: ['discord'] });
        expect(notify).toHaveBeenCalledWith('session-end', expect.objectContaining({
            sessionId: 'session-new-discord',
            projectPath: tmpDir,
        }));
    });
});
//# sourceMappingURL=duplicate-notifications.test.js.map