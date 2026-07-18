import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { claimSessionEndAction, claimSessionEndDiscoveryTickets, claimSessionEndJob, failClosedExhaustedForegroundCleanup, failClosedMissingCoreProducer, finishSessionEndAction, markSessionEndActionRunner, readSessionEndJob, reapStaleSessionEndOwner, recoverPreparedCoreProducer, releaseSessionEndDiscoveryTicket, releaseSessionEndJob, renewSessionEndLease } from './cleanup-manifest.js';
import { runSessionEndAction } from './action-runner.js';
import { armSessionEndActionWatchdog } from './action-watchdog.js';
import { getProcessStartIdentity, isProcessIdentityLive } from '../../platform/process-utils.js';
const WORKER_ARG = '--omc-session-end-worker';
const MAX_WORKER_MS = 10_000;
/** Durable OpenClaw routing is supplied from the manifest to the action runner, never from worker ambient state. */
export function workerEnvironment() {
    const keys = ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'COMSPEC', 'LANG', 'LC_ALL', 'NODE_ENV', 'CLAUDE_CONFIG_DIR', 'OMC_STATE_DIR', 'OMC_HOOK_CONFIG', 'OMC_CONFIG_PATH', 'OMC_NOTIFY', 'OMC_NOTIFY_PROFILE', 'OMC_TELEGRAM', 'OMC_DISCORD', 'OMC_SLACK', 'OMC_WEBHOOK', 'OMC_DISCORD_MENTION', 'OMC_DISCORD_NOTIFIER_BOT_TOKEN', 'OMC_DISCORD_NOTIFIER_CHANNEL', 'OMC_DISCORD_WEBHOOK_URL', 'OMC_TELEGRAM_BOT_TOKEN', 'OMC_TELEGRAM_NOTIFIER_BOT_TOKEN', 'OMC_TELEGRAM_CHAT_ID', 'OMC_TELEGRAM_NOTIFIER_CHAT_ID', 'OMC_TELEGRAM_NOTIFIER_UID', 'OMC_SLACK_WEBHOOK_URL', 'OMC_SLACK_MENTION', 'OMC_SLACK_BOT_TOKEN', 'OMC_SLACK_APP_TOKEN', 'OMC_SLACK_BOT_CHANNEL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', ...(process.env.NODE_ENV === 'test' ? ['OMC_SESSION_END_TEST_PRODUCER_GRACE_MS'] : [])];
    return Object.fromEntries(keys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}
export function spawnSessionEndWorker(payload) {
    try {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), WORKER_ARG, JSON.stringify(payload)], { detached: true, stdio: 'ignore', env: workerEnvironment(), windowsHide: true });
        child.unref();
        return true;
    }
    catch {
        return false;
    }
}
export async function executeSessionEndAction(name, payload, deadlineAt) {
    const legacy = await import('./index.js');
    const routing = readSessionEndJob(payload.directory, payload.sessionId)?.actions.notification.payload;
    if (typeof routing?.notificationProfile === 'string')
        process.env.OMC_NOTIFY_PROFILE = routing.notificationProfile;
    if (routing?.openClawEnabled === true)
        process.env.OMC_OPENCLAW = '1';
    if (name === 'foreground-cleanup')
        return legacy.runForegroundSessionEndCleanup(payload.directory, payload.sessionId, false).then(() => undefined);
    if (name === 'wiki-capture') {
        const intent = readSessionEndJob(payload.directory, payload.sessionId)?.actions['wiki-capture'].payload;
        const { commitWikiSessionEndCaptureIntent } = await import('../wiki/session-hooks.js');
        if (!await commitWikiSessionEndCaptureIntent(intent, { deadlineAt: Math.min(deadlineAt, Date.now() + 9_000) }))
            throw new Error('wiki-capture-incomplete');
        return;
    }
    if (name === 'team-cleanup') {
        const names = readSessionEndJob(payload.directory, payload.sessionId)?.actions['team-cleanup'].payload.initialTeamNames;
        const result = await legacy.cleanupSessionOwnedTeams(payload.directory, payload.sessionId, Array.isArray(names) ? names.filter((name) => typeof name === 'string') : []);
        if (result.failed.length > 0)
            throw new Error(`team-cleanup-incomplete:${result.failed.map(item => item.teamName).join(',')}`);
        return;
    }
    if (name === 'python-cleanup')
        return legacy.cleanupSessionPython(payload.directory, payload.sessionId).then(() => undefined);
    if (name === 'reply-cleanup')
        return legacy.cleanupSessionReplies(payload.sessionId);
    if (name === 'callback')
        return legacy.runSessionEndCallbacks(payload.directory, payload.sessionId, readSessionEndJob(payload.directory, payload.sessionId)?.actions.callback.idempotencyKey, true);
    if (name === 'notification')
        return legacy.runSessionEndNotifications(payload.directory, payload.sessionId, true);
    return legacy.runSessionEndOpenClaw(payload.directory, payload.sessionId, true);
}
async function reapIfProvenStale(payload, deadlineAt) {
    const job = readSessionEndJob(payload.directory, payload.sessionId);
    const owner = job?.owner;
    if (!owner || Date.now() < Date.parse(owner.leaseExpiresAt))
        return;
    const liveness = await isProcessIdentityLive(owner.pid, owner.processStartIdentity, Math.min(deadlineAt, Date.now() + 250));
    if (liveness === 'dead' || liveness === 'mismatch')
        reapStaleSessionEndOwner(payload.directory, payload.sessionId, owner.nonce, owner.leaseGeneration, liveness);
}
function reschedulePendingWorker(payload, job) {
    if (!job || job.phase === 'complete')
        return;
    const retryableAttempts = Object.values(job.actions).filter(action => action.status === 'retryable').map(action => action.attempts);
    const producersReady = ['sealed', 'no-op'].includes(job.producers.core.state)
        && ['sealed', 'no-op'].includes(job.producers.wiki.state);
    const hasPendingAction = producersReady && Object.values(job.actions).some(action => action.status === 'pending');
    const awaitingProducerGrace = Date.now() < Date.parse(job.producerGraceExpiresAt)
        && (job.producers.core.state === 'prepared'
            || (job.producers.core.state === 'absent' && ['sealed', 'no-op'].includes(job.producers.wiki.state)));
    if (!awaitingProducerGrace && retryableAttempts.length === 0 && !hasPendingAction)
        return;
    const delay = awaitingProducerGrace
        ? Math.max(1, Date.parse(job.producerGraceExpiresAt) - Date.now())
        : retryableAttempts.length > 0
            ? Math.min(30_000, 250 * 2 ** Math.min(Math.max(...retryableAttempts), 7))
            : 250;
    setTimeout(() => { void processSessionEndWorker(payload); }, delay);
}
export async function processSessionEndWorker(payload) {
    const deadlineAt = Date.now() + MAX_WORKER_MS;
    const nonce = randomUUID();
    const identity = await getProcessStartIdentity(process.pid, Math.min(deadlineAt, Date.now() + 250));
    if (!identity)
        return;
    let claimed = claimSessionEndJob(payload.directory, payload.sessionId, nonce, identity, deadlineAt);
    if (!claimed) {
        await reapIfProvenStale(payload, deadlineAt);
        claimed = claimSessionEndJob(payload.directory, payload.sessionId, nonce, identity, deadlineAt);
    }
    if (!claimed || !claimed.owner)
        return;
    let admitted = readSessionEndJob(payload.directory, payload.sessionId);
    const graceExpired = admitted ? Date.now() >= Date.parse(admitted.producerGraceExpiresAt) : false;
    if (admitted && graceExpired) {
        recoverPreparedCoreProducer(payload.directory, payload.sessionId);
        failClosedExhaustedForegroundCleanup(payload.directory, payload.sessionId);
        failClosedMissingCoreProducer(payload.directory, payload.sessionId);
        admitted = readSessionEndJob(payload.directory, payload.sessionId);
    }
    let producerReady = Boolean(admitted && ['sealed', 'no-op'].includes(admitted.producers.core.state) && ['sealed', 'no-op'].includes(admitted.producers.wiki.state));
    let generation = claimed.owner.leaseGeneration;
    try {
        for (const name of Object.keys(claimed.actions)) {
            if (Date.now() >= deadlineAt)
                break;
            const before = readSessionEndJob(payload.directory, payload.sessionId);
            if (!before || before.owner?.nonce !== nonce)
                break;
            if (!producerReady && (name !== 'foreground-cleanup' || !graceExpired || before.producers.core.state !== 'prepared'))
                continue;
            if (name === 'wiki-capture' && before.producers.wiki.state === 'absent')
                continue;
            const owned = claimSessionEndAction(payload.directory, payload.sessionId, nonce, name, deadlineAt);
            const action = owned?.actions[name];
            if (!owned || !action || action.status !== 'claimed' || !action.runner)
                continue;
            const renewed = renewSessionEndLease(payload.directory, payload.sessionId, nonce, generation, deadlineAt);
            if (!renewed?.owner)
                break;
            generation = renewed.owner.leaseGeneration;
            if (!markSessionEndActionRunner(payload.directory, payload.sessionId, nonce, name, action.runner.runnerNonce, 'started'))
                break;
            const stopWatchdog = armSessionEndActionWatchdog({ directory: payload.directory, jobId: owned.jobId, action: name, attempt: action.attempts, runnerNonce: action.runner.runnerNonce, deadlineAt: Math.min(deadlineAt, Date.now() + action.budgetMs) });
            const actionDeadline = Math.min(deadlineAt, Date.now() + action.budgetMs);
            let leaseLost = false;
            const heartbeatTimer = setInterval(() => { const renewedLease = renewSessionEndLease(payload.directory, payload.sessionId, nonce, generation, deadlineAt); if (!renewedLease?.owner)
                leaseLost = true;
            else
                generation = renewedLease.owner.leaseGeneration; }, 250);
            heartbeatTimer.unref();
            const result = await runSessionEndAction({ directory: payload.directory, sessionId: payload.sessionId, job: owned, actionName: name, action, ownerNonce: nonce, runnerNonce: action.runner.runnerNonce, deadlineAt: actionDeadline }, () => executeSessionEndAction(name, payload, actionDeadline));
            clearInterval(heartbeatTimer);
            stopWatchdog();
            if (leaseLost)
                break;
            finishSessionEndAction(payload.directory, payload.sessionId, nonce, name, action.runner.runnerNonce, result.completed, result.code);
            if (name === 'foreground-cleanup' && result.completed) {
                recoverPreparedCoreProducer(payload.directory, payload.sessionId);
                const recovered = readSessionEndJob(payload.directory, payload.sessionId);
                producerReady = Boolean(recovered && ['sealed', 'no-op'].includes(recovered.producers.core.state) && ['sealed', 'no-op'].includes(recovered.producers.wiki.state));
            }
            const heartbeat = renewSessionEndLease(payload.directory, payload.sessionId, nonce, generation, deadlineAt);
            if (!heartbeat?.owner)
                break;
            generation = heartbeat.owner.leaseGeneration;
        }
    }
    finally {
        const released = releaseSessionEndJob(payload.directory, payload.sessionId, nonce, generation);
        const terminalized = failClosedExhaustedForegroundCleanup(payload.directory, payload.sessionId);
        reschedulePendingWorker(payload, terminalized ?? released ?? readSessionEndJob(payload.directory, payload.sessionId));
    }
}
/** Bounded fair SessionStart recovery based on durable tickets, not a directory page. */
export function reconcileSessionEndJobs(directory, sessionIds) {
    const tickets = sessionIds ? [...sessionIds].slice(0, 4).map(sessionId => ({ sessionId, nonce: '' })) : claimSessionEndDiscoveryTickets(directory, 4);
    for (const ticket of tickets) {
        const spawned = spawnSessionEndWorker({ directory, sessionId: ticket.sessionId });
        if (ticket.nonce && !spawned)
            releaseSessionEndDiscoveryTicket(directory, ticket.sessionId, ticket.nonce, false);
    }
}
const workerIndex = process.argv.indexOf(WORKER_ARG);
if (workerIndex >= 0) {
    try {
        const payload = JSON.parse(process.argv[workerIndex + 1] ?? '');
        void processSessionEndWorker(payload);
    }
    catch { /* invalid child input exits naturally */ }
}
//# sourceMappingURL=worker.js.map