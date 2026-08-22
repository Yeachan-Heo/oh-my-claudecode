import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
vi.mock('../callbacks.js', async () => {
    const actual = await vi.importActual('../callbacks.js');
    return {
        ...actual,
        triggerStopCallbacks: vi.fn(async () => undefined),
    };
});
const fetchMock = vi.fn();
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
const workerMocks = vi.hoisted(() => ({
    processSessionEndWorker: vi.fn(),
    spawnSessionEndWorker: vi.fn(),
}));
vi.mock('../worker.js', () => workerMocks);
vi.mock('../../../lib/worktree-paths.js', async () => {
    const actual = await vi.importActual('../../../lib/worktree-paths.js');
    return { ...actual, resolveToWorktreeRoot: vi.fn((directory) => directory ?? process.cwd()) };
});
import { processSessionEnd, runSessionEndCallbacks, runSessionEndNotifications } from '../index.js';
import { readSessionEndJob } from '../cleanup-manifest.js';
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
        fetchMock.mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.unstubAllEnvs();
    });
    it('defers legacy callbacks without re-dispatching session-end through notify() when config only comes from stopHookCallbacks', async () => {
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
        const manifest = readSessionEndJob(tmpDir, 'session-legacy-only');
        expect(manifest).toEqual(expect.objectContaining({
            producers: expect.objectContaining({ core: expect.objectContaining({ state: 'sealed' }) }),
            actions: expect.objectContaining({
                callback: expect.objectContaining({ status: 'pending', payload: expect.objectContaining({ transcriptPath, reason: 'clear' }) }),
                notification: expect.objectContaining({ status: 'pending' }),
            }),
        }));
        expect(workerMocks.spawnSessionEndWorker).toHaveBeenCalledWith({
            directory: tmpDir,
            sessionId: 'session-legacy-only',
        });
        expect(notify).not.toHaveBeenCalled();
        await runSessionEndCallbacks(tmpDir, 'session-legacy-only');
        expect(fetchMock).toHaveBeenCalledWith('https://discord.com/api/webhooks/legacy', expect.objectContaining({ method: 'POST' }));
        expect(notify).not.toHaveBeenCalled();
    });
    it('defers deduplicated legacy Discord callbacks and explicit notifications to the worker', async () => {
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
        const manifest = readSessionEndJob(tmpDir, 'session-new-discord');
        expect(manifest?.actions.callback).toEqual(expect.objectContaining({ status: 'pending' }));
        expect(manifest?.actions.notification).toEqual(expect.objectContaining({
            status: 'pending',
            payload: expect.objectContaining({ transcriptPath, reason: 'clear' }),
        }));
        expect(notify).not.toHaveBeenCalled();
        await runSessionEndCallbacks(tmpDir, 'session-new-discord');
        await runSessionEndNotifications(tmpDir, 'session-new-discord');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalledWith('session-end', expect.objectContaining({
            sessionId: 'session-new-discord',
            projectPath: tmpDir,
        }));
    });
});
//# sourceMappingURL=duplicate-notifications.test.js.map