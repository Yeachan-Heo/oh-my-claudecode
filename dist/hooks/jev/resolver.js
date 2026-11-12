/**
 * Judgment resolver - the single seam every judgment point consults.
 *
 * Dispatches a named judgment across the off | shadow | active tri-state:
 * - off / cap / circuit-open: twin decides, no fetch, no log (the opt-in
 *   shared breaker and request limit of OMC_JEV_BREAKER / OMC_JEV_MAX_RPM
 *   also return circuit-open / cap, and log the held-back call)
 * - shadow: twin decides; the Jev call is made (waited on unless
 *   blocking:false) and the comparison logged
 * - active: Jev answer decides; the twin result is preserved in the log
 *
 * Degrade paths (timeout, HTTP error, invalid response) return the twin and
 * log mode:"degraded". The resolver never throws and never rejects on the
 * Jev path - only twin() (and mapAnswer()) errors propagate, because twins
 * are existing repo code whose bugs must not be masked.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, renameSync, statSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { JevClientError, queryJev } from './client.js';
import { ACTIVATED_POINTS, boundExcerpts, excerptCharsFor, parseJevConfig, pointState } from './config.js';
const CIRCUIT_FAILURE_THRESHOLD = 3;
let breakerModule;
/**
 * The breaker and request limit shared with the hook scripts
 * (scripts/lib/jev-breaker.mjs), or undefined when neither OMC_JEV_BREAKER=1
 * nor OMC_JEV_MAX_RPM is set. The module is loaded only then; a module that
 * fails to load means no shared breaker, never a failed judgment.
 */
async function loadSharedBreaker(endpoint, apiKey) {
    const env = process.env;
    try {
        breakerModule ??= import('../../../scripts/lib/jev-breaker.mjs');
        const breaker = await breakerModule;
        const settings = breaker.breakerSettings(env, endpoint, apiKey);
        return settings ? { breaker, settings } : undefined;
    }
    catch {
        return undefined;
    }
}
/** Whether OMC_JEV_BREAKER=1 or OMC_JEV_MAX_RPM asks for the shared breaker. Synchronous, so a call without them never yields before it sends. */
function sharedBreakerWanted() {
    const env = process.env;
    return String(env.OMC_JEV_BREAKER ?? '').trim() === '1' || String(env.OMC_JEV_MAX_RPM ?? '').trim() !== '';
}
const runtime = {
    requestCount: 0,
    consecutiveFailures: new Map(),
    openCircuits: new Set(),
    envWarned: new Set(),
};
/** Reset in-process resolver state (request cap, circuit breaker, warnings). Test hook. */
export function resetJevResolverState() {
    runtime.requestCount = 0;
    runtime.consecutiveFailures.clear();
    runtime.openCircuits.clear();
    runtime.envWarned.clear();
}
/** Keep only finite, non-negative token counts; the client does not validate `usage`. */
function sanitizeUsage(usage) {
    if (!usage || typeof usage !== 'object' || Array.isArray(usage))
        return undefined;
    const { input_tokens, output_tokens } = usage;
    const isCount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    return isCount(input_tokens) && isCount(output_tokens) ? { input_tokens, output_tokens } : undefined;
}
/**
 * The answer to the first question asked. The API does not guarantee the
 * order of its answers object, so look it up by name; fall back to the first
 * answer in server order when that name is missing.
 */
function firstAnswer(response, questions) {
    const firstQuestion = Object.keys(questions)[0];
    if (firstQuestion !== undefined && Object.hasOwn(response.answers, firstQuestion)) {
        return response.answers[firstQuestion];
    }
    return Object.values(response.answers)[0];
}
/** Log field name -> the names a hook input may use for it (snake or camel case). */
const LOG_CONTEXT_FIELDS = {
    tool_use_id: ['tool_use_id', 'toolUseId'],
    session_id: ['session_id', 'sessionId'],
    cwd: ['cwd', 'directory'],
    agent_id: ['agent_id', 'agentId'],
    agent_type: ['agent_type', 'agentType'],
    prompt_id: ['prompt_id', 'promptId'],
    request_id: ['request_id'],
};
const LOG_CONTEXT_MAX_CHARS = 1000;
/**
 * The ids of one hook call for the Jev logs: tool_use_id, session_id, cwd,
 * agent_id, agent_type, prompt_id and request_id, read from a hook input
 * (snake or camel case). Only non-empty strings are kept, each cut to 1000
 * characters. Mirror of jevLogContextOf in scripts/jev-resolve.mjs.
 */
export function jevLogContextOf(source) {
    const context = {};
    if (!source || typeof source !== 'object')
        return context;
    const input = source;
    for (const [field, names] of Object.entries(LOG_CONTEXT_FIELDS)) {
        const value = names.map((name) => input[name]).find((candidate) => typeof candidate === 'string' && candidate !== '');
        if (value !== undefined)
            context[field] = value.slice(0, LOG_CONTEXT_MAX_CHARS);
    }
    return context;
}
/**
 * Rotate one Jev log file before an append. A file larger than maxBytes is
 * renamed to <name>-<YYYYMMDD-HHmmss>-<pid>.jsonl (UTC) in the same directory,
 * so the append starts a new file. maxBytes 0 turns rotation off. An existing
 * target is never overwritten, and a failed rename (another process rotated
 * the file first, the file is locked) is ignored: rotation is best-effort and
 * must never cost the line being appended. Rotated files are never deleted.
 * Every writer of a Jev log file calls this right before appending.
 * Mirror of rotateJevLog in scripts/jev-resolve.mjs.
 */
export function rotateJevLog(path, maxBytes, now = new Date()) {
    if (!(maxBytes > 0))
        return;
    try {
        if (statSync(path).size <= maxBytes)
            return;
        const stamp = now.toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');
        const target = path.replace(/\.jsonl$/, '') + '-' + stamp + '-' + process.pid + '.jsonl';
        if (!existsSync(target))
            renameSync(path, target);
    }
    catch {
        // Missing file or failed rename: nothing to rotate, the append goes on.
    }
}
/** Best-effort JSONL append under the shadow-log dir, rotated per OMC_JEV_LOG_MAX_MB. Never throws. */
async function writeShadowLog(entry, config) {
    try {
        await mkdir(config.logDir, { recursive: true });
        const path = join(config.logDir, 'shadow.jsonl');
        rotateJevLog(path, config.logMaxBytes);
        await appendFile(path, JSON.stringify(entry) + '\n', 'utf8');
    }
    catch {
        // Best-effort logging: a logging failure must never affect the judgment.
    }
}
function recordSuccess(point) {
    runtime.consecutiveFailures.delete(point);
}
function recordFailure(point) {
    const count = (runtime.consecutiveFailures.get(point) ?? 0) + 1;
    runtime.consecutiveFailures.set(point, count);
    if (count >= CIRCUIT_FAILURE_THRESHOLD) {
        runtime.openCircuits.add(point);
        console.error('[jev] ' + point + ': circuit open after ' + count + ' consecutive failures');
    }
}
/** Extract the loggable heuristic value, applying mapHeuristic if provided. */
/**
 * A logged heuristic is comparable with the logged Jev answer only when it is
 * a valid answer to the same question: the first declared question, whose
 * answer is the one logged. Anything else is logged as null (non-comparable).
 */
export function comparableHeuristic(value, questions) {
    const question = Object.values(questions)[0];
    if (!question)
        return null;
    switch (question.type) {
        case 'choice':
            return typeof value === 'string' && Object.hasOwn(question.criteria ?? {}, value) ? value : null;
        case 'noul':
            return typeof value === 'boolean' ? value : null;
        case 'score':
            return typeof value === 'number' && Number.isFinite(value) ? value : null;
        default:
            return null;
    }
}
function extractHeuristicForLogging(twinResult, questions, mapHeuristic, questionSet) {
    return comparableHeuristic(mapHeuristic ? mapHeuristic(twinResult, questionSet) : twinResult, questions);
}
export async function resolveJudgment(resolveJudgmentArgs) {
    const args = resolveJudgmentArgs;
    const config = parseJevConfig();
    let mode = pointState(args.point, config);
    if (args.mode && mode !== 'off')
        mode = args.mode;
    // One stderr line when env activation makes Jev decide (warn once per
    // point per process; code-activated and caller-forced stay silent).
    // OMC_JEV_QUIET=1 silences the line: hook processes are one-shot, so
    // per-process once is per-call in practice.
    if (process.env.OMC_JEV_QUIET !== '1' &&
        mode === 'active' &&
        !args.mode &&
        !ACTIVATED_POINTS.has(args.point) &&
        (config.activateAll || config.activatedPoints.has(args.point)) &&
        !runtime.envWarned.has(args.point)) {
        runtime.envWarned.add(args.point);
        console.error('[jev] ' + args.point + ': ACTIVE via env — Jev decides');
    }
    const twinAnswer = () => args.twin();
    // Twin-decided, no-fetch paths. twin() errors propagate by design.
    if (mode === 'off') {
        return { answer: twinAnswer(), source: 'twin', mode };
    }
    if (runtime.openCircuits.has(args.point)) {
        return { answer: twinAnswer(), source: 'twin', mode: 'circuit-open' };
    }
    if (config.maxRequests > 0 && runtime.requestCount >= config.maxRequests) {
        return { answer: twinAnswer(), source: 'twin', mode: 'cap' };
    }
    // Only the state carries user text; question definitions are static (they must never embed user text) and go out whole.
    const boundedState = boundExcerpts(args.state, excerptCharsFor(args.point, config));
    const startedAt = Date.now();
    // OMC_JEV_LOG_CONTEXT: the call's ids and one request_id for every line of this judgment.
    const logFields = config.logContext ? { ...jevLogContextOf(args.logContext), request_id: randomUUID() } : undefined;
    // Opt-in breaker and request limit shared with every process of the machine.
    const shared = sharedBreakerWanted() ? await loadSharedBreaker(config.endpoint, config.apiKey) : undefined;
    // Recheck the process cap right after that await and before admission: concurrent calls passed the first check
    // together, and a call this cap rejects must not reserve a slot of the shared per-minute limit. Nothing yields
    // between this check, admission and the count below, so the cap holds exactly.
    if (config.maxRequests > 0 && runtime.requestCount >= config.maxRequests) {
        return { answer: twinAnswer(), source: 'twin', mode: 'cap' };
    }
    let granted; // the minute's count when this call was admitted (limit only)
    if (shared) {
        const admission = shared.breaker.admitRequest(shared.settings, args.point);
        const { skip } = admission;
        granted = admission.granted;
        if (skip) {
            const heuristic = twinAnswer();
            const loggableHeuristic = extractHeuristicForLogging(heuristic, args.questions, args.mapHeuristic, args.questionSet);
            const logEntry = {
                ts: new Date().toISOString(),
                point: args.point,
                ...logFields,
                mode: skip.mode,
                state: boundedState,
                heuristic: loggableHeuristic,
                jev: null,
                answers: null,
                ...shared.breaker.skipLogFields(skip),
                durationMs: Date.now() - startedAt,
            };
            // For nonblocking shadow calls, don't wait for the log write to complete.
            if (args.blocking === false) {
                void writeShadowLog(logEntry, config);
            }
            else {
                await writeShadowLog(logEntry, config);
            }
            return { answer: heuristic, source: 'twin', mode: skip.mode };
        }
    }
    // Count the request only after shared admission succeeded, so a call held back counts for nothing.
    runtime.requestCount += 1;
    const attempt = (async () => {
        try {
            return { ok: true, response: await queryJev(boundedState, args.questions, {
                    endpoint: config.endpoint,
                    apiKey: config.apiKey,
                    timeoutMs: config.timeoutMs,
                    fetchFn: args.fetchFn,
                    ...(shared?.settings.breaker
                        ? {
                            bodyForRetry: (retryAfter) => shared.breaker.retryAfterSeconds(retryAfter) === undefined
                                ? { maxChars: shared.breaker.RETRY_BODY_MAX_CHARS }
                                : undefined,
                        }
                        : {}),
                }) };
        }
        catch (error) {
            // Classified once: the log reports the same pause the breaker was told (an HTTP-date Retry-After
            // would give a shorter one if read again later).
            const failureClass = shared && error instanceof JevClientError ? shared.breaker.classifyFailure(error) : undefined;
            if (shared && error instanceof JevClientError) {
                shared.breaker.recordFailure(shared.settings, failureClass);
            }
            return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
                failure: error instanceof JevClientError ? error : undefined,
                failureClass,
            };
        }
    })();
    // Under the shared breaker or limit a failed call logs why it failed.
    const failureFields = (failure, failureClass) => shared && failure ? shared.breaker.failureLogFields(shared.settings, failure, granted, failureClass) : {};
    // Non-blocking (detector-type) in shadow mode: return the twin now; log when Jev settles.
    if (mode === 'shadow' && args.blocking === false) {
        const heuristic = twinAnswer();
        const loggableHeuristic = extractHeuristicForLogging(heuristic, args.questions, args.mapHeuristic, args.questionSet);
        void attempt.then((outcome) => {
            if (outcome.ok) {
                recordSuccess(args.point);
                void writeShadowLog(buildLogEntry(args.point, boundedState, startedAt, 'shadow', loggableHeuristic, outcome.response, args.questions, logFields), config);
            }
            else {
                recordFailure(args.point);
                void writeShadowLog(buildLogEntry(args.point, boundedState, startedAt, 'degraded', loggableHeuristic, null, args.questions, logFields, failureFields(outcome.failure, outcome.failureClass)), config);
            }
            // Belt-and-braces: a future throw in this callback must never become an
            // unhandled rejection that kills a one-shot hook process.
        }).catch(() => { });
        return { answer: heuristic, source: 'twin', mode: 'shadow' };
    }
    // Non-blocking (detector-type) in active mode: wait for Jev (bounded by timeout)
    // to enable active mode to work with non-blocking points.
    if (mode === 'active' && args.blocking === false) {
        const heuristic = twinAnswer();
        const loggableHeuristic = extractHeuristicForLogging(heuristic, args.questions, args.mapHeuristic, args.questionSet);
        const outcome = await attempt;
        if (!outcome.ok) {
            recordFailure(args.point);
            await writeShadowLog(buildLogEntry(args.point, boundedState, startedAt, 'degraded', loggableHeuristic, null, args.questions, logFields, failureFields(outcome.failure, outcome.failureClass)), config);
            return { answer: heuristic, source: 'twin', mode: 'degraded' };
        }
        recordSuccess(args.point);
        const jevAnswer = firstAnswer(outcome.response, args.questions);
        await writeShadowLog(buildLogEntry(args.point, boundedState, startedAt, 'active', loggableHeuristic, outcome.response, args.questions, logFields), config);
        const answer = args.mapAnswer ? args.mapAnswer(jevAnswer) : jevAnswer;
        return { answer, source: 'jev', mode: 'active' };
    }
    const outcome = await attempt;
    if (!outcome.ok) {
        recordFailure(args.point);
        console.error('[jev] ' + args.point + ': degraded - ' + outcome.error);
        const heuristic = twinAnswer();
        const loggableHeuristic = extractHeuristicForLogging(heuristic, args.questions, args.mapHeuristic, args.questionSet);
        await writeShadowLog(buildLogEntry(args.point, boundedState, startedAt, 'degraded', loggableHeuristic, null, args.questions, logFields, failureFields(outcome.failure, outcome.failureClass)), config);
        return { answer: heuristic, source: 'twin', mode: 'degraded' };
    }
    recordSuccess(args.point);
    const heuristic = twinAnswer();
    const loggableHeuristic = extractHeuristicForLogging(heuristic, args.questions, args.mapHeuristic, args.questionSet);
    const jevAnswer = firstAnswer(outcome.response, args.questions);
    await writeShadowLog(buildLogEntry(args.point, boundedState, startedAt, mode === 'active' ? 'active' : 'shadow', loggableHeuristic, outcome.response, args.questions, logFields), config);
    if (mode === 'active') {
        const answer = args.mapAnswer ? args.mapAnswer(jevAnswer) : jevAnswer;
        return { answer, source: 'jev', mode: 'active' };
    }
    return { answer: heuristic, source: 'twin', mode: 'shadow' };
}
/** Build one shadow-log comparison line. */
function buildLogEntry(point, boundedState, startedAt, entryMode, heuristic, response, questions, logFields, extra = {}) {
    // With OMC_JEV_LOG_CONTEXT (logFields set) `jev` answers the first question
    // only, null when Jev did not answer it; otherwise firstAnswer's fallback.
    const firstQuestion = Object.keys(questions ?? {})[0];
    const jev = !response
        ? null
        : !logFields
            ? firstAnswer(response, questions ?? {})
            : firstQuestion !== undefined && Object.hasOwn(response.answers, firstQuestion)
                ? response.answers[firstQuestion]
                : null;
    const safeUsage = sanitizeUsage(response?.usage);
    return {
        ts: new Date().toISOString(),
        point,
        ...logFields,
        mode: entryMode,
        state: boundedState,
        heuristic,
        jev,
        answers: response ? response.answers : null,
        confidence: jev?.confidence,
        durationMs: Date.now() - startedAt,
        ...extra,
        ...(safeUsage ? { usage: safeUsage } : {}),
    };
}
//# sourceMappingURL=resolver.js.map