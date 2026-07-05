import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { z } from 'zod';

export type LazyCodexJsonStateKind = 'boulder';

export interface LazyCodexStatePaths {
  readonly boulder: string;
  readonly ulwSteering: string;
  readonly ulwLedger: string;
  readonly startWorkLedger: string;
  readonly executorEvidenceLedger: string;
}

export interface LazyCodexJsonStateReadOptions {
  readonly allowBridgeRead?: boolean;
}

export interface LazyCodexJsonStateReadResult {
  readonly source: 'lazycodex' | 'omc-bridge';
  readonly path: string;
  readonly data: unknown;
}

export interface LazyCodexActiveWork {
  readonly activePlan: string;
  readonly planName: string;
  readonly sessionIds: readonly string[];
  readonly status: 'active' | 'paused';
}

export type LazyCodexExecutionStateResult =
  | {
      readonly ok: true;
      readonly work: LazyCodexActiveWork;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

const ACTIVE_WORK_MAX_AGE_MS = 2 * 60 * 60 * 1000;

const BoulderWorkSchema = z.object({
  active_plan: z.string(),
  plan_name: z.string().optional(),
  session_ids: z.array(z.string()).optional(),
  status: z.enum(['active', 'paused', 'completed', 'abandoned']).optional(),
  started_at: z.string().optional(),
  updated_at: z.string().optional(),
}).passthrough();

const BoulderSchema = z.object({
  active_work_id: z.string(),
  works: z.record(BoulderWorkSchema),
}).passthrough();

export function getLazyCodexStatePaths(cwd: string): LazyCodexStatePaths {
  return {
    boulder: join(cwd, '.lazycodex', 'boulder.json'),
    ulwSteering: join(cwd, '.lazycodex', 'ulw-loop', 'steering.json'),
    ulwLedger: join(cwd, '.lazycodex', 'ulw-loop', 'ledger.jsonl'),
    startWorkLedger: join(cwd, '.lazycodex', 'start-work', 'ledger.jsonl'),
    executorEvidenceLedger: join(cwd, '.lazycodex', 'evidence', 'executor-verification.jsonl'),
  };
}

export function readLazyCodexJsonState(
  cwd: string,
  kind: LazyCodexJsonStateKind,
  options: LazyCodexJsonStateReadOptions = {},
): LazyCodexJsonStateReadResult | null {
  const canonicalPath = getLazyCodexJsonStatePath(cwd, kind, 'lazycodex');
  if (existsSync(canonicalPath)) {
    return {
      source: 'lazycodex',
      path: canonicalPath,
      data: JSON.parse(readFileSync(canonicalPath, 'utf8')),
    };
  }

  if (options.allowBridgeRead !== true) {
    return null;
  }

  const bridgePath = getLazyCodexJsonStatePath(cwd, kind, 'omc-bridge');
  if (!existsSync(bridgePath)) {
    return null;
  }

  return {
    source: 'omc-bridge',
    path: bridgePath,
    data: JSON.parse(readFileSync(bridgePath, 'utf8')),
  };
}

export function writeLazyCodexJsonState(cwd: string, kind: LazyCodexJsonStateKind, data: unknown): void {
  const path = getLazyCodexJsonStatePath(cwd, kind, 'lazycodex');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

export function validateLazyCodexExecutionState(cwd: string, sessionId: string): LazyCodexExecutionStateResult {
  const state = readBoulderStateForValidation(cwd);
  if (state === null) {
    return { ok: false, reason: 'missing .lazycodex/boulder.json' };
  }

  if (!state.ok) {
    return { ok: false, reason: state.reason };
  }

  const parsed = BoulderSchema.safeParse(state.data);
  if (!parsed.success) {
    return { ok: false, reason: 'malformed .lazycodex/boulder.json' };
  }

  const activeWork = parsed.data.works[parsed.data.active_work_id];
  if (!activeWork) {
    return { ok: false, reason: 'missing active Boulder work' };
  }

  if (activeWork.status !== 'active' && activeWork.status !== 'paused') {
    return { ok: false, reason: 'no active Boulder work for current session' };
  }

  if (!isCurrentSessionWork(activeWork.session_ids, sessionId)) {
    return { ok: false, reason: 'no active Boulder work for current session' };
  }

  if (isStaleWork(activeWork.updated_at ?? activeWork.started_at)) {
    return { ok: false, reason: 'stale .lazycodex/boulder.json active work' };
  }

  const planPath = resolveTrackedPath(cwd, activeWork.active_plan);
  if (!isInsideDirectory(resolve(cwd), planPath)) {
    return { ok: false, reason: 'active plan escapes project root' };
  }

  if (!existsSync(planPath)) {
    return { ok: false, reason: `missing active plan: ${activeWork.active_plan}` };
  }

  return {
    ok: true,
    work: {
      activePlan: planPath,
      planName: activeWork.plan_name ?? activeWork.active_plan,
      sessionIds: activeWork.session_ids ?? [],
      status: activeWork.status,
    },
  };
}

function readBoulderStateForValidation(cwd: string):
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly reason: string }
  | null {
  try {
    const state = readLazyCodexJsonState(cwd, 'boulder');
    return state === null ? null : { ok: true, data: state.data };
  } catch (error) {
    return { ok: false, reason: boulderReadFailureReason(error) };
  }
}

function boulderReadFailureReason(error: unknown): string {
  if (error instanceof SyntaxError) {
    return 'malformed .lazycodex/boulder.json';
  }
  if (error instanceof Error) {
    return `unreadable .lazycodex/boulder.json: ${error.message}`;
  }
  return 'unreadable .lazycodex/boulder.json';
}

function getLazyCodexJsonStatePath(
  cwd: string,
  kind: LazyCodexJsonStateKind,
  source: 'lazycodex' | 'omc-bridge',
): string {
  switch (kind) {
    case 'boulder':
      return source === 'lazycodex'
        ? getLazyCodexStatePaths(cwd).boulder
        : join(cwd, '.omc', 'state', 'interop', 'lazycodex', 'boulder.json');
  }
}

function normalizeCurrentSessionId(sessionId: string): string {
  return `codex:${sessionId}`;
}

function normalizeTrackedSessionId(sessionId: string): string {
  return sessionId.includes(':') ? sessionId : `opencode:${sessionId}`;
}

function isCurrentSessionWork(sessionIds: readonly string[] | undefined, sessionId: string): boolean {
  const normalizedSessionId = normalizeCurrentSessionId(sessionId);
  return (sessionIds ?? [])
    .map((trackedSessionId) => normalizeTrackedSessionId(trackedSessionId))
    .includes(normalizedSessionId);
}

function isStaleWork(timestamp: string | undefined): boolean {
  if (timestamp === undefined) {
    return false;
  }

  const updatedMs = Date.parse(timestamp);
  if (!Number.isFinite(updatedMs)) {
    return true;
  }

  return Date.now() - updatedMs > ACTIVE_WORK_MAX_AGE_MS;
}

function resolveTrackedPath(cwd: string, trackedPath: string): string {
  return isAbsolute(trackedPath) ? resolve(trackedPath) : resolve(cwd, trackedPath);
}

function isInsideDirectory(directoryPath: string, filePath: string): boolean {
  const relativePath = relative(directoryPath, filePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}
