/**
 * Jev config: env contract per issue-3669 "Implementation Decisions".
 *
 * - TYPESAFE_API_KEY: authenticates Jev calls (necessary but not sufficient)
 * - OMC_JEV=off: master switch, disables every point even with a key
 * - OMC_JEV=<point[,point...]>: explicit per-point opt-in; only these points
 *   run. Unset = no points enabled — a key alone sends nothing anywhere
 *   (zero egress by default, per the owner's data-egress review of #4058)
 * - OMC_JEV_TIMEOUT_MS: per-call timeout, default 250
 * - OMC_JEV_MAX_REQUESTS: per-process request cap (0/absent = unlimited)
 * - OMC_JEV_EXCERPT_CHARS: max excerpt length sent in state, default 200
 * - OMC_JEV_ENDPOINT: base URL overlay (stub servers / tests)
 * - OMC_JEV_LOG_DIR: shadow-log directory override (tests)
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

const DEFAULT_TIMEOUT_MS = 250;
const DEFAULT_EXCERPT_CHARS = 200;

/** Points currently promoted to active. Empty until the promotion ticket (07). */
export const ACTIVATED_POINTS: ReadonlySet<string> = new Set<string>();

export interface JevConfig {
  apiKey: string | null;
  masterOff: boolean;
  /** Explicit per-point opt-in; empty = no points enabled. */
  points: ReadonlySet<string>;
  /** `all` wildcard: every registered point is opted in. */
  allPoints: boolean;
  /** Points activated via env (`point:active` entries). */
  activatedPoints: ReadonlySet<string>;
  /** `all:active`: every opted-in point is active. */
  activateAll: boolean;
  timeoutMs: number;
  /** 0 = unlimited. */
  maxRequests: number;
  excerptChars: number;
  endpoint: string;
  logDir: string;
}

export function parseJevConfig(env: NodeJS.ProcessEnv = process.env): JevConfig {
  const raw = env.OMC_JEV?.trim();
  const masterOff = raw === 'off';
  const points = new Set<string>();
  const activatedPoints = new Set<string>();
  let allPoints = false;
  let activateAll = false;
  if (raw && raw !== 'off') {
    for (const entry of raw.split(',')) {
      const token = entry.trim();
      if (!token) continue;
      const colon = token.lastIndexOf(':');
      const name = colon === -1 ? token : token.slice(0, colon);
      const isActive = colon !== -1 && token.slice(colon + 1) === 'active';
      if (name === 'all') {
        allPoints = true;
        if (isActive) activateAll = true;
      } else {
        points.add(name);
        if (isActive) activatedPoints.add(name);
      }
    }
  }
  return {
    apiKey: env.TYPESAFE_API_KEY || null,
    masterOff,
    points,
    allPoints,
    activatedPoints,
    activateAll,
    timeoutMs: positiveInt(env.OMC_JEV_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxRequests: positiveInt(env.OMC_JEV_MAX_REQUESTS, 0),
    excerptChars: positiveInt(env.OMC_JEV_EXCERPT_CHARS, DEFAULT_EXCERPT_CHARS),
    endpoint: env.OMC_JEV_ENDPOINT || JEV_DEFAULT_ENDPOINT,
    logDir: env.OMC_JEV_LOG_DIR || join(getOmcRoot(), 'state', 'jev'),
  };
}

/** Master gate: is Jev enabled at all, independent of per-point state? */
export function isJevEnabled(config: JevConfig): boolean {
  return config.apiKey !== null && !config.masterOff;
}

/**
 * Tri-state for one point: off | shadow | active.
 * Config gates first (key presence, master off, opt-in incl. the `all`
 * wildcard); an enabled point is active when code-activated, env-activated
 * (union semantics: either source suffices), otherwise shadow.
 */
export function pointState(
  point: string,
  config: JevConfig,
  activated: ReadonlySet<string> = ACTIVATED_POINTS,
): 'off' | 'shadow' | 'active' {
  if (!isJevEnabled(config)) return 'off';
  if (!config.allPoints && !config.points.has(point)) return 'off';
  return (activated.has(point) || config.activateAll || config.activatedPoints.has(point))
    ? 'active'
    : 'shadow';
}

/**
 * Recursively bound every string value to `max` chars. Applied to the state
 * sent to Jev and to the state recorded in the shadow log; question
 * definitions are bounded too since they can embed user text.
 */
export function boundExcerpts(value: unknown, max: number): unknown {
  if (typeof value === 'string') {
    return value.length > max ? value.slice(0, max) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => boundExcerpts(item, max));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = boundExcerpts(val, max);
    }
    return out;
  }
  return value;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
