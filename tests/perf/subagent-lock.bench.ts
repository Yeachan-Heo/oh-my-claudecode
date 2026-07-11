/**
 * Benchmark: subagent-tracking RMW latency under no contention.
 *
 * Measures per-update wall time for sequential updates. Local Linux keeps the
 * strict p99 <= 8ms guard; CI runners use repeated samples and a wider p50/p99
 * envelope so an isolated scheduler/filesystem stall does not fail dev, while
 * still catching sustained lock slowdowns and hangs (median-p50, median-p99,
 * and max-p99 ceilings). GitHub-hosted runners routinely sustain ~23-31ms p50
 * / ~30-32ms p99 on a healthy path, so the CI ceilings sit above that band.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { performance } from "perf_hooks";
import { mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  flushPendingWrites,
  executeFlush,
  type SubagentTrackingState,
} from "../../src/hooks/subagent-tracker/index.js";
import {
  clearWorktreeCache,
  resolveSessionStatePaths,
} from "../../src/lib/worktree-paths.js";

const N = 100;
const TRACKING_STATE_NAME = "subagent-tracking";
const WARMUP_RUNS = 1;
const MEASURED_RUNS = 5;
const LOCAL_P99_LIMIT_MS = 8;
// CI ceilings sit above the GitHub-hosted runner steady-state band (p50
// ~23-31ms, p99 ~30-32ms) so healthy runs pass, while still catching sustained
// slowdowns/hangs via the median-p50, median-p99, and max-p99 guards. The
// strict 8ms target is kept for LOCAL runs only (LOCAL_P99_LIMIT_MS). See #3352.
const CI_MEDIAN_P50_LIMIT_MS = 40;
const CI_MEDIAN_P99_LIMIT_MS = 25;
const CI_MEDIAN_P99_JITTER_MARGIN_MS = 20;
const CI_MAX_P99_LIMIT_MS = 100;
const isCi = process.env.CI === "true" || process.env.CI === "1";

function makeEmptyState(): SubagentTrackingState {
  return {
    agents: [],
    total_spawned: 0,
    total_completed: 0,
    total_failed: 0,
    last_updated: new Date().toISOString(),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

type BenchmarkSummary = {
  p50: number;
  p95: number;
  p99: number;
  max: number;
};

function summarize(sorted: number[]): BenchmarkSummary {
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return percentile(sorted, 50);
}

describe("subagent-lock benchmark", () => {
  const dirs: string[] = [];
  beforeEach(() => {
    clearWorktreeCache();
  });

  afterEach(() => {
    flushPendingWrites();
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
    clearWorktreeCache();
  });

  function makeTempDir(): string {
    const dir = join(tmpdir(), `omc-bench-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    // Create the .omc/state dir so resolveSessionStatePaths can resolve paths
    mkdirSync(join(dir, ".omc", "state"), { recursive: true });
    dirs.push(dir);
    return dir;
  }

  function assertPersistedRun(
    dir: string,
    sessionId: string,
    expectedAgents: number,
  ): void {
    const statePath = resolveSessionStatePaths(
      TRACKING_STATE_NAME,
      sessionId,
      dir,
    ).effectiveWrite;
    const persisted = JSON.parse(
      readFileSync(statePath, "utf8"),
    ) as SubagentTrackingState;
    const actualAgentIds = persisted.agents
      .map((agent) => agent.agent_id)
      .sort();
    const expectedAgentIds = Array.from(
      { length: expectedAgents },
      (_value, index) => `agent-${index}`,
    ).sort();

    expect(persisted.total_spawned).toBe(expectedAgents);
    expect(actualAgentIds).toEqual(expectedAgentIds);
  }

  /**
   * Run N sequential executeFlush calls and return sorted per-update timings.
   */
  function runBenchmark(dir: string, sessionId: string): number[] {
    const samples: number[] = [];

    for (let i = 0; i < N; i++) {
      const state = makeEmptyState();
      state.agents.push({
        agent_id: `agent-${i}`,
        agent_type: "oh-my-claudecode:executor",
        started_at: new Date().toISOString(),
        parent_mode: "ultrawork",
        status: "running",
        task_description: `task-${i}`,
      });
      state.total_spawned = i + 1;

      const t0 = performance.now();
      // executeFlush does the full RMW critical section under lock
      const succeeded = executeFlush(dir, state, sessionId);
      const elapsed = performance.now() - t0;
      expect(succeeded, `locked RMW update ${i} must succeed`).toBe(true);
      samples.push(elapsed);
    }

    // Persistence validation is intentionally outside every timed interval.
    assertPersistedRun(dir, sessionId, N);

    return samples.slice().sort((a, b) => a - b);
  }

  function runMeasuredBenchmarks(): BenchmarkSummary[] {
    const summaries: BenchmarkSummary[] = [];

    for (let run = 0; run < WARMUP_RUNS + MEASURED_RUNS; run++) {
      const dir = makeTempDir();
      const sessionId = `bench-session-${Date.now()}-${run}`;
      const summary = summarize(runBenchmark(dir, sessionId));
      if (run >= WARMUP_RUNS) summaries.push(summary);
    }

    return summaries;
  }

  it("rejects a successful flush when the expected state was not persisted", () => {
    const dir = makeTempDir();
    const sessionId = `bench-write-failure-${Date.now()}`;
    const statePath = resolveSessionStatePaths(
      TRACKING_STATE_NAME,
      sessionId,
      dir,
    ).effectiveWrite;
    mkdirSync(statePath, { recursive: true });

    const state = makeEmptyState();
    state.agents.push({
      agent_id: "agent-0",
      agent_type: "oh-my-claudecode:executor",
      started_at: new Date().toISOString(),
      parent_mode: "ultrawork",
      status: "running",
      task_description: "write-failure",
    });
    state.total_spawned = 1;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(executeFlush(dir, state, sessionId)).toBe(true);
      expect(() => assertPersistedRun(dir, sessionId, 1)).toThrow();
    } finally {
      errorSpy.mockRestore();
    }
  });

  // Linux hard assertion with CI-noise-tolerant aggregation.
  it.runIf(process.platform === "linux")(
    `sequential locked updates stay within Linux latency guardrails`,
    () => {
      const summaries = runMeasuredBenchmarks();
      const p50s = summaries.map((summary) => summary.p50);
      const p99s = summaries.map((summary) => summary.p99);
      const medianP50 = median(p50s);
      const medianP99 = median(p99s);
      const maxP99 = Math.max(...p99s);
      const ciMedianP99Limit = CI_MEDIAN_P99_LIMIT_MS + CI_MEDIAN_P99_JITTER_MARGIN_MS;

      console.log(
        `[subagent-lock bench] Linux CI=${isCi} N=${N} measuredRuns=${MEASURED_RUNS}` +
        ` medianP50=${medianP50.toFixed(3)}ms medianP99=${medianP99.toFixed(3)}ms` +
        ` ciMedianP99Limit=${ciMedianP99Limit}ms maxP99=${maxP99.toFixed(3)}ms` +
        ` p99s=${p99s.map((p99) => p99.toFixed(3)).join(",")}`,
      );

      if (isCi) {
        // GitHub-hosted runners can occasionally pause filesystem lock RMW by
        // a few milliseconds even when the sustained path is healthy. Keep the
        // historical 25ms target plus a narrow jitter margin for median p99,
        // while median p50 and max-p99 still catch sustained slowdowns/hangs.
        expect(medianP50).toBeLessThanOrEqual(CI_MEDIAN_P50_LIMIT_MS);
        expect(medianP99).toBeLessThanOrEqual(ciMedianP99Limit);
        expect(maxP99).toBeLessThanOrEqual(CI_MAX_P99_LIMIT_MS);
      } else {
        expect(medianP99).toBeLessThanOrEqual(LOCAL_P99_LIMIT_MS);
      }
    },
  );

  // All platforms: log p99 without failing
  it("logs p99 latency on all platforms (informational)", () => {
    const dir = makeTempDir();
    const sessionId = `bench-session-${Date.now()}`;

    const summary = summarize(runBenchmark(dir, sessionId));

    console.log(
      `[subagent-lock bench] platform=${process.platform}  N=${N}` +
      `  p50=${summary.p50.toFixed(3)}ms  p95=${summary.p95.toFixed(3)}ms` +
      `  p99=${summary.p99.toFixed(3)}ms  max=${summary.max.toFixed(3)}ms`,
    );

    // Sanity: p99 must always be positive and less than 30s (catches hangs)
    expect(summary.p99).toBeGreaterThan(0);
    expect(summary.p99).toBeLessThan(30_000);
  });
});
