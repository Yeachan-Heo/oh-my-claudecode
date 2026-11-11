/**
 * Stop Hook Callbacks
 *
 * Provides configurable callback handlers for session end events.
 * Supports file logging, Telegram, and Discord notifications.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, normalize } from 'path';
import { homedir } from 'os';
import { getOMCConfig, } from '../../features/auto-update.js';
/**
 * Format session summary for notifications
 */
export function formatSessionSummary(metrics, format = 'markdown') {
    if (format === 'json') {
        return JSON.stringify(metrics, null, 2);
    }
    const duration = metrics.duration_ms
        ? `${Math.floor(metrics.duration_ms / 1000 / 60)}m ${Math.floor((metrics.duration_ms / 1000) % 60)}s`
        : 'unknown';
    return `# Session Ended

**Session ID:** \`${metrics.session_id}\`
**Duration:** ${duration}
**Reason:** ${metrics.reason}
**Agents Spawned:** ${metrics.agents_spawned}
**Agents Completed:** ${metrics.agents_completed}
**Modes Used:** ${metrics.modes_used.length > 0 ? metrics.modes_used.join(', ') : 'none'}
**Started At:** ${metrics.started_at || 'unknown'}
**Ended At:** ${metrics.ended_at}
`.trim();
}
function normalizeDiscordTagList(tagList) {
    return (tagList ?? []).map((tag) => tag.trim()).filter(Boolean).map((tag) => {
        if (tag === '@here' || tag === '@everyone')
            return tag;
        const roleMatch = tag.match(/^role:(\d+)$/);
        if (roleMatch)
            return `<@&${roleMatch[1]}>`;
        return /^\d+$/.test(tag) ? `<@${tag}>` : tag;
    });
}
function normalizeTelegramTagList(tagList) {
    return (tagList ?? []).map((tag) => tag.trim()).filter(Boolean).map((tag) => tag.startsWith('@') ? tag : `@${tag}`);
}
function prefixMessageWithTags(message, tags) {
    return tags.length === 0 ? message : `${tags.join(' ')}\n${message}`;
}
/** Interpolate path placeholders. */
export function interpolatePath(pathTemplate, sessionId, idempotencyKey) {
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toISOString().split('T')[1].split('.')[0].replace(/:/g, '-');
    const safeSessionId = sessionId.replace(/[/\\..]/g, '_');
    const safeIdempotencyKey = (idempotencyKey ?? '').replace(/[^A-Za-z0-9_-]/g, '_');
    return normalize(pathTemplate.replace(/~/g, homedir()).replace(/\{session_id\}/g, safeSessionId).replace(/\{idempotency_key\}/g, safeIdempotencyKey).replace(/\{date\}/g, date).replace(/\{time\}/g, time));
}
/**
 * A file target containing `{idempotency_key}` converges retries to one path.
 * Other file targets retain their configured overwrite semantics.
 */
async function writeToFile(config, content, sessionId, idempotencyKey) {
    const resolvedPath = interpolatePath(config.path, sessionId, idempotencyKey);
    mkdirSync(dirname(resolvedPath), { recursive: true });
    writeFileSync(resolvedPath, content, { encoding: 'utf-8', mode: 0o600 });
}
/**
 * Deferred remote delivery is terminal after its first manifest attempt: a lost
 * response is indistinguishable from remote acceptance, so it is never retried.
 */
async function sendTelegram(config, message, signal, _idempotencyKey) {
    if (!config.botToken || !config.chatId || !/^[0-9]+:[A-Za-z0-9_-]+$/.test(config.botToken))
        return;
    const response = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: config.chatId, text: message, parse_mode: 'Markdown' }), signal });
    if (!response.ok)
        throw new Error(`Telegram API error: ${response.status}`);
}
/** See sendTelegram: failed Discord delivery is terminal to avoid duplicate remote side effects. */
async function sendDiscord(config, message, signal, _idempotencyKey) {
    if (!config.webhookUrl)
        return;
    const url = new URL(config.webhookUrl);
    const allowed = ['discord.com', 'discordapp.com'];
    if (url.protocol !== 'https:' || !allowed.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)))
        return;
    const response = await fetch(config.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: message }), signal });
    if (!response.ok)
        throw new Error(`Discord webhook error: ${response.status}`);
}
async function runLegacyCallbacks(metrics, options, signal) {
    const callbacks = getOMCConfig().stopHookCallbacks;
    if (!callbacks)
        return;
    const skipPlatforms = new Set(options.skipPlatforms ?? []);
    const idempotencyKey = options.idempotencyKey ?? `session-end:${metrics.session_id}:legacy-callback`;
    const work = [];
    if (!skipPlatforms.has('file') && callbacks.file?.enabled && callbacks.file.path)
        work.push(writeToFile(callbacks.file, formatSessionSummary(metrics, callbacks.file.format || 'markdown'), metrics.session_id, idempotencyKey));
    if (!skipPlatforms.has('telegram') && callbacks.telegram?.enabled)
        work.push(sendTelegram(callbacks.telegram, prefixMessageWithTags(formatSessionSummary(metrics), normalizeTelegramTagList(callbacks.telegram.tagList)), signal, idempotencyKey));
    if (!skipPlatforms.has('discord') && callbacks.discord?.enabled)
        work.push(sendDiscord(callbacks.discord, prefixMessageWithTags(formatSessionSummary(metrics), normalizeDiscordTagList(callbacks.discord.tagList)), signal, idempotencyKey));
    await Promise.all(work);
}
/** Backward-compatible callback entry point used by existing callers and tests. */
export async function triggerStopCallbacks(metrics, _input, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
        await runLegacyCallbacks(metrics, options, controller.signal);
    }
    catch (error) {
        console.error('[stop-callback] Callback failed:', error instanceof Error ? error.message : 'Unknown error');
    }
    finally {
        clearTimeout(timer);
    }
}
function stringList(value) {
    return Array.isArray(value) ? value.filter((item) => item === 'file' || item === 'telegram' || item === 'discord') : [];
}
async function runWithinDeadline(deadlineAt, run) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0)
        return undefined;
    const controller = new AbortController();
    let timer;
    try {
        return await Promise.race([run(controller.signal), new Promise((resolve) => {
                timer = setTimeout(() => { controller.abort(); resolve(undefined); }, remaining);
            })]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
/** Executes deferred actions only after the manifest worker has armed them. */
export async function runSessionEndDeferredAction(action, context) {
    const manifestDeadline = Date.parse(context.deadlineAt);
    const deadlineAt = Math.min(Number.isFinite(manifestDeadline) ? manifestDeadline : Date.now(), Date.now() + Math.max(0, action.budgetMs));
    if (deadlineAt <= Date.now())
        return { status: 'deadline-exceeded' };
    try {
        const result = await runWithinDeadline(deadlineAt, async (signal) => {
            switch (action.name) {
                case 'legacy-callback':
                    await runLegacyCallbacks(context.metrics, {
                        skipPlatforms: stringList(action.payload.skipPlatforms),
                        idempotencyKey: action.idempotencyKey,
                    }, signal);
                    return 'completed';
                // A notification attempt is terminal in the manifest because remote
                // acceptance can precede an unavailable response.
                case 'notification': {
                    const { notify } = await import('../../notifications/index.js');
                    const result = await notify('session-end', { sessionId: context.sessionId, projectPath: context.directory, durationMs: context.metrics.duration_ms, agentsSpawned: context.metrics.agents_spawned, agentsCompleted: context.metrics.agents_completed, modesUsed: context.metrics.modes_used, reason: context.metrics.reason, timestamp: context.metrics.ended_at, profileName: typeof action.payload.profileName === 'string' ? action.payload.profileName : undefined });
                    if (!result?.anySuccess)
                        throw new Error('notification-not-accepted');
                    return 'completed';
                }
                // OpenClaw wake attempts are terminal in the manifest because remote
                // acceptance can precede an unavailable response.
                case 'openclaw-wake': {
                    if (action.payload.enabled !== true || process.env.OMC_OPENCLAW !== '1')
                        return 'skipped';
                    const { wakeOpenClaw } = await import('../../openclaw/index.js');
                    const result = await wakeOpenClaw('session-end', { sessionId: context.sessionId, projectPath: context.directory, reason: typeof action.payload.reason === 'string' ? action.payload.reason : context.metrics.reason });
                    if (!result?.success)
                        throw new Error('openclaw-wake-not-accepted');
                    return 'completed';
                }
                default:
                    return 'skipped';
            }
        });
        return result === undefined ? { status: 'deadline-exceeded' } : { status: result };
    }
    catch (error) {
        return { status: 'failed', detail: error instanceof Error ? error.message : 'Unknown action failure' };
    }
}
//# sourceMappingURL=callbacks.js.map