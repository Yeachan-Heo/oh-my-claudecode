/**
 * Jev config: env contract per issue-3669 "Implementation Decisions".
 *
 * - TYPESAFE_API_KEY: authenticates Jev calls (necessary but not sufficient)
 * - OMC_JEV=off: master switch, disables every point even with a key
 * - OMC_JEV=<point[,point...]>: explicit per-point opt-in; only these points
 *   run. Unset = no points enabled — a key alone sends nothing anywhere
 *   (zero egress by default, per the owner's data-egress review of #4058)
 * - OMC_JEV_TIMEOUT_MS: per-call timeout, default 2000 (measured single-question
 *   round-trips are 465-605 ms, so a sub-second default degrades every call)
 * - OMC_JEV_MAX_REQUESTS: per-process request cap (0/absent = unlimited)
 * - OMC_JEV_EXCERPT_CHARS: max excerpt length sent in state, default 200
 * - OMC_JEV_EXCERPT_CHARS_<POINT>: the same limit for one point (point name
 *   upper-cased, dashes as underscores, e.g. OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING).
 *   Points with their own default (POINT_DEFAULT_EXCERPT_CHARS: model-routing,
 *   task-size, skill-trigger, intent, learner-extraction, loop-continuation)
 *   ignore OMC_JEV_EXCERPT_CHARS; set the point's own variable to change them.
 * - OMC_JEV_ENDPOINT: base URL overlay (stub servers / tests)
 * - OMC_JEV_LOG_DIR: directory of the Jev logs, default state/jev under the
 *   state root; the hook scripts write their own logs there too
 * - OMC_JEV_LOG_MAX_MB: size limit in MiB of each Jev log file; a larger
 *   file is renamed before the next append (see rotateJevLog in
 *   resolver.ts). Unset or not a canonical positive integer = no rotation
 * - OMC_JEV_LOG_CONTEXT=1: shadow-log lines carry the ids of the hook call
 *   (ResolveJudgmentArgs.logContext) and a request_id, and their `jev` and
 *   confidence answer the first question only (see isJevLogContextEnabled)
 * - OMC_JEV_STATE_OMIT_IDS=1: loop-continuation and simplifier-trigger send
 *   their state without session_id and cwd (see isJevStateOmitIdsEnabled)
 * - OMC_JEV_QUIET=1: silence the env-activation stderr warning (hook
 *   processes are one-shot, so warn-once-per-process degrades to warn-every)
 *
 * Per-point activation defaults to shadow. A point runs active when listed in
 * the compile-time ACTIVATED_POINTS, activated via env (point:active suffix,
 * or the `all` wildcard — see below), or when the caller forces mode: 'active'
 * on a single resolveJudgment call. Promotion (ticket 07) flips entries in
 * ACTIVATED_POINTS; env activation is the user-facing one-line experiment
 * channel (ADR 03672).
 *
 * OMC_JEV entry syntax: `point` (shadow) | `point:active` (active) | `all`
 * (every registered point, shadow) | `all:active` (every point, active).
 * Unknown point names are ignored.
 */
import { join } from 'node:path';
import { getOmcRoot } from '../../lib/worktree-paths.js';
export const JEV_DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_EXCERPT_CHARS = 200;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const BYTES_PER_MB = 1024 * 1024;
const MAX_LOG_MB = Math.floor(Number.MAX_SAFE_INTEGER / BYTES_PER_MB);
/** Points currently promoted to active. Empty until the promotion ticket (07). */
export const ACTIVATED_POINTS = new Set();
/**
 * Points that `all` and `all:active` never enable: they send more than the
 * bounded excerpts of the other points (`compaction` sends tool results and
 * user messages from the conversation), so each needs its own entry in
 * OMC_JEV. Mirror of NAMED_ONLY_POINTS in scripts/jev-resolve.mjs.
 */
export const NAMED_ONLY_POINTS = new Set(['compaction']);
export function parseJevConfig(env = process.env) {
    const raw = env.OMC_JEV?.trim();
    const masterOff = raw === 'off';
    const points = new Set();
    const activatedPoints = new Set();
    let allPoints = false;
    let activateAll = false;
    if (raw && raw !== 'off') {
        for (const entry of raw.split(',')) {
            const token = entry.trim();
            if (!token)
                continue;
            const colon = token.lastIndexOf(':');
            const name = colon === -1 ? token : token.slice(0, colon);
            const isActive = colon !== -1 && token.slice(colon + 1) === 'active';
            if (name === 'all') {
                allPoints = true;
                if (isActive)
                    activateAll = true;
            }
            else {
                points.add(name);
                if (isActive)
                    activatedPoints.add(name);
            }
        }
    }
    const pointExcerptChars = {};
    for (const [key, value] of Object.entries(env)) {
        const match = /^OMC_JEV_EXCERPT_CHARS_([A-Z0-9_]+)$/.exec(key);
        const parsed = match ? positiveInt(value, 0) : 0;
        if (match && parsed > 0)
            pointExcerptChars[match[1]] = parsed;
    }
    return {
        apiKey: env.TYPESAFE_API_KEY || null,
        masterOff,
        points,
        allPoints,
        activatedPoints,
        activateAll,
        timeoutMs: positiveInt(env.OMC_JEV_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, MAX_TIMER_DELAY_MS),
        maxRequests: positiveInt(env.OMC_JEV_MAX_REQUESTS, 0),
        excerptChars: positiveInt(env.OMC_JEV_EXCERPT_CHARS, DEFAULT_EXCERPT_CHARS),
        pointExcerptChars,
        endpoint: env.OMC_JEV_ENDPOINT || JEV_DEFAULT_ENDPOINT,
        logDir: env.OMC_JEV_LOG_DIR || join(getOmcRoot(), 'state', 'jev'),
        logMaxBytes: positiveInt(env.OMC_JEV_LOG_MAX_MB, 0, MAX_LOG_MB) * BYTES_PER_MB,
        logContext: isJevLogContextEnabled(env),
    };
}
/**
 * Points whose state needs more than the global default to be judged at all.
 * model-routing judges the work behind the task, which 200 characters hide.
 * loop-continuation judges whether the task is complete; the script hook
 * (scripts/persistent-mode.mjs) sends the last assistant message, which it
 * already bounds to 2000 characters, and a 200-character cut keeps only its
 * opening. Here the state carries the continuation message only.
 * compaction judges tool results by their start and end and the user's last
 * messages (hooks/jev-compaction.mjs bounds them itself, at most 4000
 * characters). task-size, skill-trigger and intent judge the user's prompt and
 * learner-extraction the assistant message; a 200-character cut keeps only
 * the opening of either. learner-extraction uses the same 2000 characters as
 * loop-continuation. Mirror of POINT_DEFAULT_EXCERPT_CHARS in scripts/jev-resolve.mjs
 * and DEFAULT_EXCERPT_CHARS in hooks/jev-compaction.mjs.
 */
export const POINT_DEFAULT_EXCERPT_CHARS = {
    'model-routing': 12000,
    'task-size': 4000,
    'skill-trigger': 1000,
    intent: 1000,
    'learner-extraction': 2000,
    'loop-continuation': 2000,
    compaction: 4000,
};
/**
 * Excerpt limit for one point: its own variable, else the point's default
 * (POINT_DEFAULT_EXCERPT_CHARS: model-routing, task-size, skill-trigger, intent, learner-extraction, loop-continuation, compaction), else OMC_JEV_EXCERPT_CHARS.
 * The global variable does not apply to a point with its own default.
 */
export function excerptCharsFor(point, config) {
    return (config.pointExcerptChars[point.toUpperCase().replace(/-/g, '_')] ??
        (Object.hasOwn(POINT_DEFAULT_EXCERPT_CHARS, point)
            ? POINT_DEFAULT_EXCERPT_CHARS[point]
            : config.excerptChars));
}
/**
 * OMC_JEV_LOG_CONTEXT=1 (or `true`): shadow-log lines carry the ids of the
 * hook call and a request_id, and their `jev` and confidence belong to the
 * first question only. Mirror of isJevLogContextEnabled in
 * scripts/jev-resolve.mjs.
 */
export function isJevLogContextEnabled(env = process.env) {
    return ['1', 'true'].includes(String(env.OMC_JEV_LOG_CONTEXT ?? '').trim().toLowerCase());
}
/**
 * OMC_JEV_STATE_OMIT_IDS=1 (or `true`): the states sent to Jev leave out the
 * ids that describe the session rather than the work: `session_id` in the
 * loop-continuation state and `cwd` in the simplifier-trigger state. Mirror
 * of isJevStateOmitIdsEnabled in scripts/jev-resolve.mjs.
 */
export function isJevStateOmitIdsEnabled(env = process.env) {
    return ['1', 'true'].includes(String(env.OMC_JEV_STATE_OMIT_IDS ?? '').trim().toLowerCase());
}
/** Master gate: is Jev enabled at all, independent of per-point state? */
export function isJevEnabled(config) {
    return config.apiKey !== null && !config.masterOff;
}
/**
 * Tri-state for one point: off | shadow | active.
 * Config gates first (key presence, master off, opt-in incl. the `all`
 * wildcard); an enabled point is active when code-activated, env-activated
 * (union semantics: either source suffices), otherwise shadow.
 */
export function pointState(point, config, activated = ACTIVATED_POINTS) {
    if (!isJevEnabled(config))
        return 'off';
    const namedOnly = NAMED_ONLY_POINTS.has(point);
    if ((namedOnly || !config.allPoints) && !config.points.has(point))
        return 'off';
    return (activated.has(point) || (!namedOnly && config.activateAll) || config.activatedPoints.has(point))
        ? 'active'
        : 'shadow';
}
/**
 * Recursively bound every string value to `max` chars. Applied to the state
 * sent to Jev and to the state recorded in the shadow log. Question
 * definitions are static text and are not bounded.
 */
export function boundExcerpts(value, max) {
    if (typeof value === 'string') {
        return value.length > max ? value.slice(0, max) : value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => boundExcerpts(item, max));
    }
    if (value !== null && typeof value === 'object') {
        const out = {};
        for (const [key, val] of Object.entries(value)) {
            out[key] = boundExcerpts(val, max);
        }
        return out;
    }
    return value;
}
function positiveInt(raw, fallback, max = Number.MAX_SAFE_INTEGER) {
    if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw))
        return fallback;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed <= max ? parsed : fallback;
}
//# sourceMappingURL=config.js.map