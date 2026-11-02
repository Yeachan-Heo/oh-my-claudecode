/**
 * Judgment resolver - the single seam every judgment point consults.
 *
 * Dispatches a named judgment across the off | shadow | active tri-state:
 * - off / cap / circuit-open: twin decides, no fetch, no log
 * - shadow: twin decides; the Jev call is made (waited on unless
 *   blocking:false) and the comparison logged
 * - active: Jev answer decides; the twin result is preserved in the log
 *
 * Degrade paths (timeout, HTTP error, invalid response) return the twin and
 * log mode:"degraded". The resolver never throws and never rejects on the
 * Jev path - only twin() (and mapAnswer()) errors propagate, because twins
 * are existing repo code whose bugs must not be masked.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { queryJev } from './client.js';
import { ACTIVATED_POINTS, boundExcerpts, parseJevConfig, pointState } from './config.js';
const CIRCUIT_FAILURE_THRESHOLD = 3;
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
function firstAnswer(response) {
    return Object.values(response.answers)[0];
}
/** Best-effort JSONL append under the shadow-log dir. Never throws. */
async function writeShadowLog(entry, logDir) {
    try {
        await mkdir(logDir, { recursive: true });
        await appendFile(join(logDir, 'shadow.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
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
    const boundedState = boundExcerpts(args.state, config.excerptChars);
    const boundedQuestions = boundExcerpts(args.questions, config.excerptChars);
    const startedAt = Date.now();
    const attempt = (async () => {
        try {
            return { ok: true, response: await queryJev(boundedState, boundedQuestions, {
                    endpoint: config.endpoint,
                    apiKey: config.apiKey,
                    timeoutMs: config.timeoutMs,
                    fetchFn: args.fetchFn,
                }) };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    })();
    runtime.requestCount += 1;
    // Non-blocking (detector-type) in shadow mode: return the twin now; log when Jev settles.
    if (mode === 'shadow' && args.blocking === false) {
        const heuristic = twinAnswer();
        void attempt.then((outcome) => {
            if (outcome.ok) {
                recordSuccess(args.point);
                void writeShadowLog(buildLogEntry(args.point, boundedState, startedAt, 'shadow', heuristic, firstAnswer(outcome.response), outcome.response.usage), config.logDir);
            }
            else {
                recordFailure(args.point);
                void writeShadowLog(buildLogEntry(args.point, boundedState, startedAt, 'degraded', heuristic, null), config.logDir);
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
        const outcome = await attempt;
        if (!outcome.ok) {
            recordFailure(args.point);
            await writeShadowLog(buildLogEntry(args.point, boundedState, startedAt, 'degraded', heuristic, null), config.logDir);
            return { answer: heuristic, source: 'twin', mode: 'degraded' };
        }
        recordSuccess(args.point);
        const jevAnswer = firstAnswer(outcome.response);
        await writeShadowLog(buildLogEntry(args.point, boundedState, startedAt, 'active', heuristic, jevAnswer, outcome.response.usage), config.logDir);
        const answer = args.mapAnswer ? args.mapAnswer(jevAnswer) : jevAnswer;
        return { answer, source: 'jev', mode: 'active' };
    }
    const outcome = await attempt;
    if (!outcome.ok) {
        recordFailure(args.point);
        console.error('[jev] ' + args.point + ': degraded - ' + outcome.error);
        const heuristic = twinAnswer();
        await writeShadowLog(buildLogEntry(args.point, boundedState, startedAt, 'degraded', heuristic, null), config.logDir);
        return { answer: heuristic, source: 'twin', mode: 'degraded' };
    }
    recordSuccess(args.point);
    const heuristic = twinAnswer();
    const jevAnswer = firstAnswer(outcome.response);
    await writeShadowLog(buildLogEntry(args.point, boundedState, startedAt, mode === 'active' ? 'active' : 'shadow', heuristic, jevAnswer, outcome.response.usage), config.logDir);
    if (mode === 'active') {
        const answer = args.mapAnswer ? args.mapAnswer(jevAnswer) : jevAnswer;
        return { answer, source: 'jev', mode: 'active' };
    }
    return { answer: heuristic, source: 'twin', mode: 'shadow' };
}
/** Build one shadow-log comparison line. */
function buildLogEntry(point, boundedState, startedAt, entryMode, heuristic, jev, usage) {
    const safeUsage = sanitizeUsage(usage);
    return {
        ts: new Date().toISOString(),
        point,
        mode: entryMode,
        state: boundedState,
        heuristic,
        jev,
        confidence: jev?.confidence,
        durationMs: Date.now() - startedAt,
        ...(safeUsage ? { usage: safeUsage } : {}),
    };
}
//# sourceMappingURL=resolver.js.map