#!/usr/bin/env node
/* global process, console, fetch, AbortController, setTimeout, clearTimeout, Buffer, TextDecoder */
/**
 * Jev script-side judgment channel (ADR 03671, ticket 15).
 *
 * Plain-Node hook scripts cannot import TypeScript. They consult the judgment
 * program through this one-shot child process: the caller writes one JSON
 * request to stdin and reads one JSON result from stdout.
 *
 * Request:  { point, state, questions, heuristic, permissionMode? }
 * Result:   { mode, answer, answers, confidence, durationMs, breaker? }
 * (`breaker`, only with OMC_JEV_BREAKER=1: the shared breaker {until, reason,
 * since} when it is open after this call)
 *
 * `answer` is the answer to the request's first question (the first answer
 * in server order when that name is missing). `answers` maps every question
 * name to its answer; multi-question points must read it by name, because the
 * API does not guarantee the order of the answers object.
 *
 * mode mirrors the resolver's ResolveMode contract: off (config gates),
 * shadow (twin decides, comparison recorded), active (Jev decides), degraded
 * (a Jev call was attempted and failed - caller falls back to its twin),
 * circuit-open and cap (the shared breaker or request limit held the call
 * back - caller falls back to its twin, as for degraded).
 * The calling script computes its own heuristic twin; this child never sees
 * the twin's code. The TS resolver's request cap and circuit breaker are
 * in-process runtime - meaningless for a one-shot child and omitted here.
 * Their cross-process counterpart is opt-in: OMC_JEV_BREAKER=1 and
 * OMC_JEV_MAX_RPM=<n> share a breaker and a per-minute limit between all
 * processes through files (lib/jev-breaker.mjs); without them nothing changes.
 * Degrade-never-block: any failure exits 0 with mode:"degraded" so a hook
 * process is never killed by a Jev outage.
 *
 * The env parse below mirrors src/hooks/jev/config.ts (same contract: keys,
 * defaults, all/point:active syntax). jev-eval.mjs sets the precedent for
 * deliberate mirrors; parity with the TS parse is locked by the test suite.
 */

import { lstatSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { resolveOmcStateRoot } from "./lib/state-root.mjs";

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_EXCERPT_CHARS = 200;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const JEV_MODEL = "jev-latest";

function positiveInt(raw, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed <= max ? parsed : fallback;
}

/**
 * Per-point excerpt limit: OMC_JEV_EXCERPT_CHARS_<POINT>, with the point name
 * upper-cased and dashes turned into underscores (model-routing reads
 * OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING). Undefined when that variable is unset
 * or not a canonical positive integer. Mirror of excerptCharsFor in config.ts.
 */
export function pointExcerptChars(point, env = process.env) {
  const name = "OMC_JEV_EXCERPT_CHARS_" + String(point).toUpperCase().replace(/-/g, "_");
  return positiveInt(env[name], undefined);
}

/**
 * Points whose state needs more than the global default to be judged at all.
 * model-routing judges the work behind the task, which 200 characters hide.
 * loop-continuation judges whether the task is complete from the last
 * assistant message, which persistent-mode.mjs already bounds to 2000
 * characters (boundLastAssistantMessage); a 200-character cut keeps only its
 * opening. compaction judges tool results by their start and end and the
 * user's last messages (the hooks module bounds them itself, at most 4000
 * characters). task-size, skill-trigger and intent judge the user's prompt and
 * learner-extraction the assistant message; a 200-character cut keeps only
 * the opening of either. learner-extraction uses the same 2000 characters as
 * loop-continuation. Mirror of POINT_DEFAULT_EXCERPT_CHARS in config.ts.
 */
const POINT_DEFAULT_EXCERPT_CHARS = {
  "model-routing": 12000,
  "task-size": 4000,
  "skill-trigger": 1000,
  intent: 1000,
  "learner-extraction": 2000,
  "loop-continuation": 2000,
  compaction: 4000,
};

/**
 * Excerpt limit for one point: its own variable, else the point's default
 * (POINT_DEFAULT_EXCERPT_CHARS), else OMC_JEV_EXCERPT_CHARS, else 200.
 * The global variable does not apply to a point with its own default.
 */
export function resolveExcerptChars(point, env = process.env) {
  return (
    pointExcerptChars(point, env) ??
    (Object.hasOwn(POINT_DEFAULT_EXCERPT_CHARS, point)
      ? POINT_DEFAULT_EXCERPT_CHARS[point]
      : positiveInt(env.OMC_JEV_EXCERPT_CHARS, DEFAULT_EXCERPT_CHARS))
  );
}

/**
 * Resolve the script-side Jev timeout using the same strict contract for the
 * HTTP resolver and its synchronous active-mode parent process.
 */
export function resolveJevTimeoutMs(env = process.env, bufferMs = 0) {
  const timeoutMs = positiveInt(
    env.OMC_JEV_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    MAX_TIMER_DELAY_MS,
  );
  const buffer =
    Number.isSafeInteger(bufferMs) && bufferMs > 0
      ? Math.min(bufferMs, MAX_TIMER_DELAY_MS)
      : 0;
  return Math.min(timeoutMs + buffer, MAX_TIMER_DELAY_MS);
}

/**
 * Mirror of serializeQuestions in src/hooks/jev/client.ts. `score` questions
 * are rejected with HTTP 422 unless their criteria are an ordered low-to-high
 * list; `choice`/`noul` take the named map unchanged (#4091).
 */
export function serializeQuestions(questions) {
  const out = {};
  for (const [name, question] of Object.entries(questions ?? {})) {
    out[name] =
      question?.type === "score" &&
      question.criteria &&
      !Array.isArray(question.criteria)
        ? { ...question, criteria: Object.values(question.criteria) }
        : question;
  }
  return out;
}

/**
 * Points that `all` and `all:active` never enable: they send more than the
 * bounded excerpts of the other points, so each needs its own opt-in. Mirror
 * of NAMED_ONLY_POINTS in src/hooks/jev/config.ts.
 */
export const NAMED_ONLY_POINTS = new Set(["compaction"]);

/**
 * Mirror of parseJevConfig + pointState in src/hooks/jev/config.ts. Returns
 * the tri-state decision the TS resolver makes for one point:
 * off | shadow | active.
 *
 * permissionMode is the hook input's permission_mode. In Claude Code plan
 * mode, OMC_JEV_PLAN_MODE=shadow runs opted-in points in shadow and
 * OMC_JEV_PLAN_MODE=off turns them off; any other value changes nothing.
 * Script channel only: the TS resolver receives no permission mode.
 *
 * Points in NAMED_ONLY_POINTS run only when OMC_JEV names them; `all` and
 * `all:active` leave them off and never activate them.
 */
export function parseJevEnv(point, env = process.env, permissionMode) {
  const raw = (env.OMC_JEV || "").trim();
  if (!env.TYPESAFE_API_KEY || raw === "off") return "off";
  let sawAll = false;
  let activateAll = false;
  let active = false;
  let listed = false;
  let off = false;
  for (const entry of raw.split(",")) {
    const token = entry.trim();
    if (!token) continue;
    const colon = token.lastIndexOf(":");
    const name = colon === -1 ? token : token.slice(0, colon);
    const isActive = colon !== -1 && token.slice(colon + 1) === "active";
    const isOff = colon !== -1 && token.slice(colon + 1).trim().toLowerCase() === "off";
    if (name === "all") {
      if (isOff) {
        // `all:off` withdraws the wildcard instead of enabling it.
        sawAll = false;
        activateAll = false;
      } else {
        sawAll = true;
        if (isActive) activateAll = true;
      }
    } else if (name === point) {
      // `point:off` turns the point off even under `all`; a later non-off entry for the point turns it back on.
      if (isOff) {
        off = true;
        active = false;
      } else {
        off = false;
        listed = true;
        if (isActive) active = true;
      }
    }
  }
  if (off) return "off";
  if (NAMED_ONLY_POINTS.has(point)) {
    sawAll = false;
    activateAll = false;
  }
  if (!sawAll && !listed) return "off";
  if (permissionMode === "plan") {
    const planMode = (env.OMC_JEV_PLAN_MODE || "").trim();
    if (planMode === "shadow" || planMode === "off") return planMode;
  }
  if (activateAll || active) return "active";
  return "shadow";
}

/** Mirror of boundExcerpts in config.ts: recursively bound strings to max chars. */
export function boundExcerpts(value, max) {
  if (typeof value === "string")
    return value.length > max ? value.slice(0, max) : value;
  if (Array.isArray(value))
    return value.map((item) => boundExcerpts(item, max));
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value))
      out[key] = boundExcerpts(val, max);
    return out;
  }
  return value;
}

/** Mirror of validateJevResponse in client.ts. Throws on any invalid shape. */
/**
 * A logged heuristic is comparable with the logged Jev answer only when it is
 * a valid answer to the same question: the first declared question, whose
 * answer is the one logged. Anything else is logged as null (non-comparable).
 */
export function comparableHeuristic(value, questions) {
  const question = Object.values(questions ?? {})[0];
  if (!question || typeof question !== "object") return null;
  switch (question.type) {
    case "choice":
      return typeof value === "string" && Object.hasOwn(question.criteria ?? {}, value) ? value : null;
    case "noul":
      return typeof value === "boolean" ? value : null;
    case "score":
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    default:
      return null;
  }
}

export function validateJevResponse(body) {
  if (body === null || typeof body !== "object")
    throw new Error("invalid response: expected object");
  const answers = body.answers;
  if (
    answers === null ||
    typeof answers !== "object" ||
    Array.isArray(answers)
  ) {
    throw new Error("invalid response: missing answers object");
  }
  const entries = Object.entries(answers);
  if (entries.length === 0)
    throw new Error("invalid response: answers is empty");
  for (const [name, answer] of entries) {
    if (
      answer === null ||
      typeof answer !== "object" ||
      typeof answer.type !== "string"
    ) {
      throw new Error(
        'invalid response: answer "' + name + '" has no string type',
      );
    }
  }
  return body;
}

async function logDirFor(env) {
  if (env.OMC_JEV_LOG_DIR) return env.OMC_JEV_LOG_DIR;
  const omcRoot = await resolveOmcStateRoot(process.cwd());
  return join(omcRoot, "state", "jev");
}

/** The Jev endpoint every channel sends to. Mirror of `endpoint` in config.ts. */
export function resolveJevEndpoint(env = process.env) {
  return env.OMC_JEV_ENDPOINT || DEFAULT_ENDPOINT;
}

/**
 * The shared breaker and request limit (lib/jev-breaker.mjs) for this
 * endpoint and key: {breaker, settings}, or undefined when neither
 * OMC_JEV_BREAKER=1 nor OMC_JEV_MAX_RPM is set. The module is loaded only
 * then; a module that fails to load means no breaker, never a failed request.
 */
export async function loadJevBreaker(env = process.env) {
  if (String(env.OMC_JEV_BREAKER ?? "").trim() !== "1" && !String(env.OMC_JEV_MAX_RPM ?? "").trim()) return undefined;
  try {
    const breaker = await import("./lib/jev-breaker.mjs");
    const settings = breaker.breakerSettings(env, resolveJevEndpoint(env), env.TYPESAFE_API_KEY);
    return settings ? { breaker, settings } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The first `maxChars` characters of a failed response's body, or undefined
 * when it cannot be read within a second. The stream is read only as far as
 * needed and then cancelled. Never throws.
 */
async function readErrorBody(response, maxChars) {
  let timer;
  let reader;
  try {
    const read = async () => {
      if (typeof response.body?.getReader !== "function") return String(await response.text()).slice(0, maxChars);
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (text.length < maxChars) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      return text.slice(0, maxChars);
    };
    return await Promise.race([
      read(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), 1000);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await reader?.cancel();
    } catch {
      // The body is not needed any more.
    }
  }
}

/**
 * Drop the unread rest of a failed response's body, so an endpoint that never
 * ends it cannot keep this process alive after it has printed its result
 * (an active hook waits for the process to end). Never throws.
 */
function dropBody(response) {
  try {
    response.body?.cancel().catch(() => {});
  } catch {
    // Not a real stream (a test double), or already locked: nothing to drop.
  }
}

/** A request that ran shorter than this because of the hook deadline is not counted as a missing response. */
const MIN_COUNTED_REQUEST_MS = 1000;

/**
 * Timeout of one request in the resolver process. With OMC_JEV_BREAKER=1 an
 * active hook passes the moment it kills this process, less 100 ms, in
 * OMC_JEV_HOOK_DEADLINE (epoch ms); the request then ends by that time at the
 * latest (but not within the first 200 ms), so a slow process start cannot
 * push the resolver's own timeout, which records the missing response, past
 * the kill.
 */
export function resolveRequestTimeoutMs(env = process.env, now = Date.now()) {
  const timeoutMs = resolveJevTimeoutMs(env);
  if (String(env.OMC_JEV_BREAKER ?? "").trim() !== "1") return timeoutMs;
  const deadline = Number(env.OMC_JEV_HOOK_DEADLINE);
  if (!Number.isFinite(deadline) || deadline <= 0) return timeoutMs;
  return Math.max(200, Math.min(timeoutMs, deadline - now));
}

/**
 * Mirror of the resolver's shadow-log entry (ShadowLogEntry): the jev-eval
 * tool compares lines regardless of which side wrote them.
 */
async function writeShadowLog(entry, logDir) {
  try {
    await mkdir(logDir, { recursive: true });
    await appendFile(
      join(logDir, "shadow.jsonl"),
      JSON.stringify(entry) + "\n",
      "utf8",
    );
  } catch {
    // Best-effort logging: a logging failure must never affect the judgment.
  }
}

/**
 * One judgment request: config gates, bounded fetch, validated response,
 * shadow-log line. Never throws - every failure degrades to mode:"degraded".
 * fetchFn is a test hook.
 */
export async function resolveRequest(
  request,
  env = process.env,
  fetchFn = fetch,
) {
  const startedAt = Date.now();
  const mode = request.spawnMode ?? parseJevEnv(request.point, env, request.permissionMode);
  if (mode === "off") {
    return { mode, answer: null, answers: null, confidence: undefined, durationMs: 0 };
  }
  // Only the state carries user text. Question definitions are static text
  // written by the hook scripts and go out whole: bounding them would cut the
  // model-routing effort instructions (295 characters) and the intent
  // criterion (209). A question must never embed user text.
  const bound = {
    state: boundExcerpts(request.state, resolveExcerptChars(request.point, env)),
    questions: request.questions,
  };
  // Opt-in shared breaker and request limit: a held-back call is logged and
  // ends like a failed one (the caller uses its twin), without a fetch.
  const guard = await loadJevBreaker(env);
  if (guard) {
    const { skip } = guard.breaker.admitRequest(guard.settings, request.point);
    if (skip) {
      const durationMs = Date.now() - startedAt;
      await writeShadowLog(
        {
          ts: new Date().toISOString(),
          point: request.point,
          mode: skip.mode,
          state: bound.state,
          heuristic: comparableHeuristic(request.heuristic, request.questions),
          jev: null,
          answers: null,
          ...guard.breaker.skipLogFields(skip),
          durationMs,
        },
        await logDirFor(env),
      );
      return {
        mode: skip.mode,
        answer: null,
        answers: null,
        confidence: undefined,
        durationMs,
        ...(skip.breaker ? { breaker: skip.breaker } : {}),
      };
    }
  }
  const controller = new AbortController();
  let timer;
  const timeoutMs = resolveRequestTimeoutMs(env);
  const timeoutPromise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("jev request timed out after " + timeoutMs + "ms"));
    }, timeoutMs);
  });
  let jevAnswer = null;
  let jevAnswers = null;
  let confidence;
  let entryMode = mode;
  // What the breaker needs to classify a failure: the HTTP status and
  // Retry-After, or that no response arrived at all (timeout, network error).
  let failure;
  let responded = false;
  try {
    const response = await Promise.race([
      fetchFn(resolveJevEndpoint(env), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + env.TYPESAFE_API_KEY,
        },
        body: JSON.stringify({
          state: bound.state,
          questions: serializeQuestions(bound.questions),
          model: JEV_MODEL,
        }),
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    responded = true;
    if (!response.ok) {
      if (guard) {
        const retryAfter = response.headers?.get?.("retry-after") ?? undefined;
        failure = { status: response.status, retryAfter };
        // A 429 without a usable Retry-After may state the time in its body.
        if (guard.settings.breaker && response.status === 429 && guard.breaker.retryAfterSeconds(retryAfter) === undefined) {
          failure.body = await readErrorBody(response, guard.breaker.RETRY_BODY_MAX_CHARS);
        }
        dropBody(response);
      }
      throw new Error("jev request failed: HTTP " + response.status);
    }
    const body = validateJevResponse(await response.json());
    const firstQuestion = Object.keys(request.questions ?? {})[0];
    jevAnswer =
      firstQuestion !== undefined && Object.hasOwn(body.answers, firstQuestion)
        ? body.answers[firstQuestion]
        : Object.values(body.answers)[0];
    jevAnswers = body.answers;
    confidence = jevAnswer.confidence;
  } catch (error) {
    entryMode = "degraded";
    console.error(
      "[jev] " +
        request.point +
        ": degraded - " +
        (error instanceof Error ? error.message : String(error)),
    );
    // A request that had less than a second (a slow process start used up the rest before the hook's
    // deadline) says little about the endpoint and is not counted as a missing response.
    if (guard && !responded && timeoutMs >= Math.min(resolveJevTimeoutMs(env), MIN_COUNTED_REQUEST_MS)) failure = { noResponse: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
  const durationMs = Date.now() - startedAt;
  // Tell the breaker before the log write, so concurrent callers see it at once.
  const opened = guard && failure
    ? guard.breaker.recordFailure(guard.settings, guard.breaker.classifyFailure(failure))
    : undefined;
  await writeShadowLog(
    {
      ts: new Date().toISOString(),
      point: request.point,
      mode: entryMode,
      state: bound.state,
      heuristic: comparableHeuristic(request.heuristic, request.questions),
      jev: entryMode === "degraded" ? null : jevAnswer,
      answers: entryMode === "degraded" ? null : jevAnswers,
      confidence,
      durationMs,
    },
    await logDirFor(env),
  );
  return {
    mode: entryMode,
    answer: entryMode === "degraded" ? null : jevAnswer,
    answers: entryMode === "degraded" ? null : jevAnswers,
    confidence,
    durationMs,
    ...(opened ? { breaker: opened } : {}),
  };
}

/** Read one JSON request from stdin, print one JSON result to stdout. */
export async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Read one JSON request from a file and delete it. Used by fire-and-record
 * callers that exit immediately after spawning, where a stdin pipe would race
 * the parent's exit. The request carries raw tool input, so it must never be
 * passed on argv: /proc/<pid>/cmdline is world-readable.
 */
export function readRequestFile(path) {
  let raw;
  const dir = dirname(resolve(path));
  try {
    raw = readFileSync(path, "utf8");
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // The request may already be gone or unavailable for cleanup.
    }

    try {
      const safeTmpDir = resolve(tmpdir());
      const dirBasename = basename(dir);
      const dirStats = lstatSync(dir);

      // Only remove an empty, owned Jev directory directly under os.tmpdir().
      if (
        dirname(dir) === safeTmpDir &&
        dirBasename.startsWith("omc-jev-") &&
        dirStats.isDirectory() &&
        (typeof process.getuid !== "function" ||
          dirStats.uid === process.getuid())
      ) {
        rmdirSync(dir);
      }
    } catch {
      // Best effort: temp dir cleanup is best-effort; never block on it.
    }
  }
  if (!raw) throw new Error("Failed to read request file");
  return JSON.parse(raw);
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const requestFileFlag = process.argv.indexOf("--request-file");
    const requestFile =
      requestFileFlag === -1 ? undefined : process.argv[requestFileFlag + 1];
    const request = requestFile
      ? readRequestFile(requestFile)
      : await readStdinJson();
    const result = await resolveRequest(request);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(
      "[jev] " + (error instanceof Error ? error.message : String(error)),
    );
    console.log(
      JSON.stringify({
        mode: "degraded",
        answer: null,
        confidence: undefined,
        durationMs: 0,
      }),
    );
  }
}
