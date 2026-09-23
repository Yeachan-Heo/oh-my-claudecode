#!/usr/bin/env node
/* global process, console, fetch, AbortController, setTimeout, clearTimeout, Buffer */
/**
 * Jev script-side judgment channel (ADR 03671, ticket 15).
 *
 * Plain-Node hook scripts cannot import TypeScript. They consult the judgment
 * program through this one-shot child process: the caller writes one JSON
 * request to stdin and reads one JSON result from stdout.
 *
 * Request:  { point, state, questions, heuristic }
 * Result:   { mode, answer, confidence, durationMs }
 *
 * mode mirrors the resolver's ResolveMode contract: off (config gates),
 * shadow (twin decides, comparison recorded), active (Jev decides), degraded
 * (a Jev call was attempted and failed - caller falls back to its twin).
 * The calling script computes its own heuristic twin; this child never sees
 * the twin's code. Request cap and circuit breaker are in-process resolver
 * runtime - meaningless for a one-shot child and intentionally omitted.
 * Degrade-never-block: any failure exits 0 with mode:"degraded" so a hook
 * process is never killed by a Jev outage.
 *
 * The env parse below mirrors src/hooks/jev/config.ts (same contract: keys,
 * defaults, all/point:active syntax). jev-eval.mjs sets the precedent for
 * deliberate mirrors; parity with the TS parse is locked by the test suite.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveOmcStateRoot } from './lib/state-root.mjs';

const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_TIMEOUT_MS = 250;
const DEFAULT_EXCERPT_CHARS = 200;
const JEV_MODEL = 'jev-latest';

/**
 * Mirror of parseJevConfig + pointState in src/hooks/jev/config.ts. Returns
 * the tri-state decision the TS resolver makes for one point:
 * off | shadow | active.
 */
export function parseJevEnv(point, env = process.env) {
  const raw = (env.OMC_JEV || '').trim();
  if (!env.TYPESAFE_API_KEY || raw === 'off') return 'off';
  let sawAll = false;
  let activateAll = false;
  let active = false;
  let listed = false;
  for (const entry of raw.split(',')) {
    const token = entry.trim();
    if (!token) continue;
    const colon = token.lastIndexOf(':');
    const name = colon === -1 ? token : token.slice(0, colon);
    const isActive = colon !== -1 && token.slice(colon + 1) === 'active';
    if (name === 'all') {
      sawAll = true;
      if (isActive) activateAll = true;
    } else if (name === point) {
      listed = true;
      if (isActive) active = true;
    }
  }
  if (!sawAll && !listed) return 'off';
  if (activateAll || active) return 'active';
  return 'shadow';
}

/** Mirror of boundExcerpts in config.ts: recursively bound strings to max chars. */
export function boundExcerpts(value, max) {
  if (typeof value === 'string') return value.length > max ? value.slice(0, max) : value;
  if (Array.isArray(value)) return value.map((item) => boundExcerpts(item, max));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = boundExcerpts(val, max);
    return out;
  }
  return value;
}

/** Mirror of validateJevResponse in client.ts. Throws on any invalid shape. */
export function validateJevResponse(body) {
  if (body === null || typeof body !== 'object') throw new Error('invalid response: expected object');
  const answers = body.answers;
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new Error('invalid response: missing answers object');
  }
  const entries = Object.entries(answers);
  if (entries.length === 0) throw new Error('invalid response: answers is empty');
  for (const [name, answer] of entries) {
    if (answer === null || typeof answer !== 'object' || typeof answer.type !== 'string') {
      throw new Error('invalid response: answer "' + name + '" has no string type');
    }
  }
  return body;
}

async function logDirFor(env) {
  if (env.OMC_JEV_LOG_DIR) return env.OMC_JEV_LOG_DIR;
  const omcRoot = await resolveOmcStateRoot(process.cwd());
  return join(omcRoot, 'state', 'jev');
}

/**
 * Mirror of the resolver's shadow-log entry (ShadowLogEntry): the jev-eval
 * tool compares lines regardless of which side wrote them.
 */
async function writeShadowLog(entry, logDir) {
  try {
    await mkdir(logDir, { recursive: true });
    await appendFile(join(logDir, 'shadow.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Best-effort logging: a logging failure must never affect the judgment.
  }
}

/**
 * One judgment request: config gates, bounded fetch, validated response,
 * shadow-log line. Never throws - every failure degrades to mode:"degraded".
 * fetchFn is a test hook.
 */
export async function resolveRequest(request, env = process.env, fetchFn = fetch) {
  const startedAt = Date.now();
  const mode = parseJevEnv(request.point, env);
  if (mode === 'off') {
    return { mode, answer: null, confidence: undefined, durationMs: 0 };
  }
  const max = Number.parseInt(env.OMC_JEV_EXCERPT_CHARS || '', 10);
  const bound = boundExcerpts(
    { state: request.state, questions: request.questions },
    Number.isFinite(max) && max > 0 ? max : DEFAULT_EXCERPT_CHARS,
  );
  const controller = new AbortController();
  let timer;
  const timeoutMsRaw = Number.parseInt(env.OMC_JEV_TIMEOUT_MS || '', 10);
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : DEFAULT_TIMEOUT_MS;
  const timeoutPromise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('jev request timed out after ' + timeoutMs + 'ms'));
    }, timeoutMs);
  });
  let jevAnswer = null;
  let confidence;
  let entryMode = mode;
  try {
    const response = await Promise.race([
      fetchFn(env.OMC_JEV_ENDPOINT || DEFAULT_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + env.TYPESAFE_API_KEY,
        },
        body: JSON.stringify({ state: bound.state, questions: bound.questions, model: JEV_MODEL }),
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    if (!response.ok) throw new Error('jev request failed: HTTP ' + response.status);
    const body = validateJevResponse(await response.json());
    jevAnswer = Object.values(body.answers)[0];
    confidence = jevAnswer.confidence;
  } catch (error) {
    entryMode = 'degraded';
    console.error('[jev] ' + request.point + ': degraded - ' + (error instanceof Error ? error.message : String(error)));
  } finally {
    if (timer) clearTimeout(timer);
  }
  const durationMs = Date.now() - startedAt;
  await writeShadowLog({
    ts: new Date().toISOString(),
    point: request.point,
    mode: entryMode,
    state: bound.state,
    heuristic: request.heuristic ?? null,
    jev: entryMode === 'degraded' ? null : jevAnswer,
    confidence,
    durationMs,
  }, await logDirFor(env));
  return { mode: entryMode, answer: entryMode === 'degraded' ? null : jevAnswer, confidence, durationMs };
}

/** Read one JSON request from stdin, print one JSON result to stdout. */
export async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const request = await readStdinJson();
    const result = await resolveRequest(request);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error('[jev] ' + (error instanceof Error ? error.message : String(error)));
    console.log(JSON.stringify({ mode: 'degraded', answer: null, confidence: undefined, durationMs: 0 }));
  }
}
