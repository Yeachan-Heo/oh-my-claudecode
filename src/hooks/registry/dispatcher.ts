/**
 * Shadow-mode hook dispatcher — #3698 / #3707.
 *
 * Parses each event once, selects only applicable registry entries in
 * declared order, runs them with per-hook timeout enforcement, applies the
 * declared fail-mode (advisory fail-open with a structured diagnostic;
 * hard-risk fail-closed), and emits structured timing/error records.
 *
 * Shadow mode only: dry-run handlers execute and produce records, but no
 * output is ever merged into a runtime decision — behavior change is
 * impossible by construction. Cutover to active dispatch is #3708.
 *
 * Latency budget (plan §6.3): no-op events p95 <= 50 ms; ordinary advisory
 * events p95 <= 200 ms; no unbounded child process — handlers are in-process
 * functions, and every handler await is bounded by its declared timeout.
 */

import { selectApplicableEntries } from './registry.js';
import type {
  DispatchRecord,
  DispatchResult,
  HookEvent,
  HookHandler,
  HookRegistryEntry,
} from './types.js';

export interface HookDispatcher {
  dispatch(event: HookEvent, input: unknown): Promise<DispatchResult>;
  readonly registry: readonly HookRegistryEntry[];
}

export interface DispatcherOptions {
  /**
   * Dry-run handlers keyed by registry entry id. Only handlers with
   * `dryRun: true` execute; side-effecting handlers are skipped.
   */
  handlers?: ReadonlyMap<string, { handler: HookHandler; dryRun: boolean }>;
  /** Injectable clock for tests. */
  now?: () => number;
}

class HookTimeoutError extends Error {
  constructor(
    public readonly hookId: string,
    public readonly timeoutMs: number,
  ) {
    super(`hook ${hookId} exceeded timeout ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

/** How the matcher input is extracted from a hook event payload. */
function matcherInputFor(event: HookEvent, input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const rec = input as Record<string, unknown>;
  if (event === 'SessionStart') {
    return typeof rec.source === 'string' ? rec.source : undefined;
  }
  if (event === 'PermissionRequest' || event === 'PreToolUse' || event === 'PostToolUse') {
    const tool = rec.tool_name ?? rec.toolName;
    return typeof tool === 'string' ? tool : undefined;
  }
  return typeof rec.matcher === 'string' ? rec.matcher : undefined;
}

async function runWithTimeout(
  entry: HookRegistryEntry,
  handler: HookHandler,
  input: unknown,
): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(handler(input)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new HookTimeoutError(entry.id, entry.timeoutMs)),
          entry.timeoutMs,
        );
        // Never keep a short-lived hook process alive for a shadow timer.
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createHookDispatcher(
  registry: readonly HookRegistryEntry[],
  options: DispatcherOptions = {},
): HookDispatcher {
  const handlers = options.handlers ?? new Map();
  const now = options.now ?? (() => performance.now());

  async function dispatch(event: HookEvent, input: unknown): Promise<DispatchResult> {
    const applicable = selectApplicableEntries(
      registry,
      event,
      matcherInputFor(event, input),
    );
    const records: DispatchRecord[] = [];

    for (const entry of applicable) {
      const registered = handlers.get(entry.id);
      const runnable = registered !== undefined && registered.dryRun;
      const started = now();

      if (!runnable) {
        records.push({
          hookId: entry.id,
          event,
          durationMs: 0,
          status: 'skipped',
          failMode: entry.failMode,
          riskClass: entry.riskClass,
          appliedDecision: 'none',
        });
        continue;
      }

      try {
        await runWithTimeout(entry, registered.handler, input);
        records.push({
          hookId: entry.id,
          event,
          durationMs: now() - started,
          status: 'ok',
          failMode: entry.failMode,
          riskClass: entry.riskClass,
          appliedDecision: 'none',
        });
      } catch (error) {
        const errorClass =
          error instanceof HookTimeoutError
            ? 'TimeoutError'
            : error instanceof Error
              ? error.name
              : 'UnknownError';
        const failOpen = entry.failMode === 'fail-open';
        records.push({
          hookId: entry.id,
          event,
          durationMs: now() - started,
          status: errorClass === 'TimeoutError' ? 'timeout' : 'error',
          errorClass,
          failMode: entry.failMode,
          riskClass: entry.riskClass,
          appliedDecision: failOpen ? 'fail-open' : 'fail-closed',
        });
        if (!failOpen) break; // hard boundary: stop running further hooks
      }
    }

    return { event, records };
  }

  return { dispatch, registry };
}
