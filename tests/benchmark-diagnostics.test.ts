import type Anthropic from "@anthropic-ai/sdk";

import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";

import {
  DuplicateFixtureKeyError,
  generateComparisonReport,
  generateMarkdownReport,
  keyOf,
  pairResults,
} from "../benchmarks/shared/reporter.ts";
import {
  countFailures,
  callClaude,
  exitCodeForResults,
  fixtureDomainFromDirectory,
  loadGroundTruth,
  parseCliArgs,
  printSummaryTable,
  runBenchmark,
  type Clock,
} from "../benchmarks/shared/runner.ts";
import {
  normalizeForSharedScoring,
  matchFindingsShared,
  scoreFixtureShared,
  validateSharedGroundTruth,
} from "../benchmarks/shared/scorer.ts";
import type {
  BenchmarkScores,
  CompletedFixtureResult,
  FixtureResult,
  GroundTruth,
  ParsedAgentOutput,
} from "../benchmarks/shared/types.ts";

const scores: BenchmarkScores = {
  truePositiveRate: 1,
  falsePositiveRate: 0,
  falseNegativeRate: 0,
  severityAccuracy: 1,
  missingCoverage: 1,
  perspectiveCoverage: 1,
  evidenceRate: 1,
  hasPreCommitment: true,
  hasMultiPerspective: true,
  hasGapAnalysis: true,
  compositeScore: 1,
};

const parsed: ParsedAgentOutput = {
  verdict: "OKAY",
  criticalFindings: [],
  majorFindings: [],
  minorFindings: [],
  missingItems: [],
  perspectiveNotes: { security: [], newHire: [], ops: [] },
  hasPreCommitment: true,
  hasGapAnalysis: true,
  hasMultiPerspective: true,
  rawOutput: "OKAY",
};

const groundTruth: GroundTruth = {
  fixtureId: "fixture-1",
  fixturePath: "fixture-1.json",
  domain: "code",
  expectedVerdict: "OKAY",
  findings: [],
  isCleanBaseline: true,
};

function completed(
  agentType: string,
  overrides: Partial<CompletedFixtureResult> = {},
): CompletedFixtureResult {
  return {
    fixtureId: "fixture-1",
    domain: "code",
    agentType,
    completion: "completed",
    parsedOutput: parsed,
    scores,
    matchedFindings: [],
    missedFindings: [],
    spuriousFindings: [],
    latencyMs: 20,
    harnessOverheadMs: 5,
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
    ...overrides,
  };
}

function benchmarkDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "benchmark-diagnostic-"));
  mkdirSync(join(directory, "ground-truth"));
  return directory;
}

describe("benchmark diagnostic contracts", () => {
  it("maps fixture directories without inherited-key fallthrough", () => {
    expect(fixtureDomainFromDirectory("code")).toBe("code");
    expect(fixtureDomainFromDirectory("bugs")).toBe("bug");
    expect(fixtureDomainFromDirectory("tasks")).toBe("task");
    expect(fixtureDomainFromDirectory("plans")).toBe("plan");
    expect(() => fixtureDomainFromDirectory("bug")).toThrow(
      "Unsupported fixture directory",
    );
    expect(() => fixtureDomainFromDirectory("toString")).toThrow(
      "Unsupported fixture directory",
    );
  });

  it("preserves unknown CLI argument passthrough", () => {
    const originalArgv = process.argv;
    process.argv = ["node", "runner", "--external-flag", "value", "--dry-run"];
    try {
      expect(parseCliArgs(["a", "b"], "results")).toMatchObject({
        agents: ["a", "b"],
        dryRun: true,
      });
    } finally {
      process.argv = originalArgv;
    }
  });

  it("validates shared ground truth and rejects unsupported domains", () => {
    expect(validateSharedGroundTruth(groundTruth)).toEqual(groundTruth);
    expect(() =>
      validateSharedGroundTruth({ ...groundTruth, domain: "unknown" }),
    ).toThrow("Unsupported ground truth domain");
    expect(() =>
      validateSharedGroundTruth({
        ...groundTruth,
        findings: [
          {
            id: "empty",
            severity: "MINOR",
            category: "finding",
            summary: "x",
            keywords: [],
            explanation: "x",
          },
        ],
      }),
    ).toThrow("must have at least one keyword");
    const duplicateFinding = {
      id: "duplicate",
      severity: "MINOR" as const,
      category: "finding" as const,
      summary: "x",
      keywords: ["x"],
      explanation: "x",
    };
    expect(() =>
      validateSharedGroundTruth({
        ...groundTruth,
        findings: [duplicateFinding, duplicateFinding],
      }),
    ).toThrow("Duplicate ground truth finding id");
  });

  it("projects bug and task domains only for canonical scoring", () => {
    const bug = normalizeForSharedScoring({
      ...groundTruth,
      fixtureId: "bug-1",
      fixturePath: "bug-1.json",
      domain: "bug",
      expectedVerdict: "root-cause",
    });
    const task = normalizeForSharedScoring({
      ...groundTruth,
      fixtureId: "task-1",
      fixturePath: "task-1.json",
      domain: "task",
      expectedVerdict: "trivial",
    });
    expect(bug.domain).toBe("analysis");
    expect(task.domain).toBe("analysis");
    expect(bug.expectedVerdict).toBe("REJECT");
    expect(
      normalizeForSharedScoring({ ...groundTruth, expectedVerdict: "REVISE" })
        .expectedVerdict,
    ).toBe("REVISE");
    expect(
      normalizeForSharedScoring({
        ...groundTruth,
        expectedVerdict: "ACCEPT-WITH-RESERVATIONS",
      }).expectedVerdict,
    ).toBe("ACCEPT-WITH-RESERVATIONS");
  });

  it("projects real debugger and executor labels without changing identity", () => {
    const bug = loadGroundTruth(
      join(process.cwd(), "benchmarks", "debugger", "ground-truth"),
      { id: "bug-redis-intermittent", domain: "bug" },
    );
    const task = loadGroundTruth(
      join(process.cwd(), "benchmarks", "executor", "ground-truth"),
      { id: "task-add-timestamp", domain: "task" },
    );
    if (!bug || !task)
      throw new Error("Expected real debugger and executor labels");
    expect(normalizeForSharedScoring(bug)).toMatchObject({
      fixtureId: "bug-redis-intermittent",
      domain: "analysis",
    });
    expect(normalizeForSharedScoring(task)).toMatchObject({
      fixtureId: "task-add-timestamp",
      domain: "analysis",
    });
    expect(scoreFixtureShared(parsed, bug)).toEqual(
      scoreFixtureShared(parsed, { ...bug, domain: "analysis" }),
    );
    expect(matchFindingsShared(parsed, task)).toEqual(
      matchFindingsShared(parsed, { ...task, domain: "analysis" }),
    );
  });

  it("pairs by domain and fixture id without zero-filling missing observations", () => {
    const a = completed("a");
    const b = completed("b");
    expect(keyOf(a)).toBe("code:fixture-1");
    expect(pairResults([a], [b])).toMatchObject({
      aOnlyKeys: [],
      bOnlyKeys: [],
    });

    const unpaired = pairResults(
      [a],
      [completed("b", { fixtureId: "fixture-2" })],
    );
    expect(unpaired.paired).toHaveLength(0);
    expect(unpaired.aOnlyKeys).toEqual(["code:fixture-1"]);
    expect(unpaired.bOnlyKeys).toEqual(["code:fixture-2"]);
  });

  it("rejects duplicate fixture keys on either comparison side", () => {
    expect(() =>
      pairResults([completed("a"), completed("a")], [completed("b")]),
    ).toThrow(DuplicateFixtureKeyError);
    expect(() =>
      pairResults([completed("a")], [completed("b"), completed("b")]),
    ).toThrow("Duplicate fixture key on B");
  });

  it("reports quality, input/output/total tokens, latency, and overhead separately", () => {
    const report = generateComparisonReport(
      [
        completed("a"),
        completed("b", {
          inputTokens: 15,
          outputTokens: 5,
          totalTokens: 20,
          latencyMs: 30,
          harnessOverheadMs: 8,
        }),
      ],
      "a",
      "b",
      "model",
    );
    expect(report.diagnostics.validity).toBe("valid");
    expect(report.diagnostics.tokenCost.input.total).toMatchObject({
      a: 10,
      b: 15,
      delta: -5,
    });
    expect(report.diagnostics.tokenCost.output.total).toMatchObject({
      a: 4,
      b: 5,
      delta: -1,
    });
    expect(report.diagnostics.tokenCost.all.total).toMatchObject({
      a: 14,
      b: 20,
      delta: -6,
    });
    expect(report.diagnostics.tokenCost.all.perFixtureMean).toMatchObject({
      a: 14,
      b: 20,
      delta: -6,
    });
    expect(report.diagnostics.apiLatency).toMatchObject({
      a: 20,
      b: 30,
      delta: -10,
    });
    expect(report.diagnostics.harnessOverhead).toMatchObject({
      a: 5,
      b: 8,
      delta: -3,
    });
    expect(generateMarkdownReport(report, "a", "b")).toContain(
      "does not prove an Opus regression",
    );
    expect(JSON.stringify(report)).not.toContain("expectedVerdict");
    expect(JSON.stringify(report)).not.toContain('"REJECT"');
    expect(generateMarkdownReport(report, "a", "b")).not.toContain("REJECT");
  });

  it("marks empty and same-agent comparisons inconclusive", () => {
    const empty = generateComparisonReport([], "a", "b", "model");
    expect(empty.diagnostics).toMatchObject({
      validity: "inconclusive",
      reasons: ["no paired fixture observations"],
    });
    const same = generateComparisonReport([completed("a")], "a", "a", "model");
    expect(same.diagnostics.validity).toBe("inconclusive");
    expect(same.diagnostics.reasons).toContain(
      "comparison requires two distinct agents",
    );
    expect(same.aggregateScores.a).toBeNull();
    expect(same.headToHead).toEqual([]);
    expect(same.diagnostics.tokenCost.all.total.status).toBe("insufficient");
    expect(same.diagnostics.apiLatency.status).toBe("insufficient");
    expect(generateMarkdownReport(same, "a", "a")).toContain("insufficient");
  });

  it("keeps partial token telemetry visible but total comparison insufficient", () => {
    const report = generateComparisonReport(
      [
        completed("a", { outputTokens: undefined, totalTokens: undefined }),
        completed("b", { outputTokens: undefined, totalTokens: undefined }),
      ],
      "a",
      "b",
      "model",
    );
    expect(report.diagnostics.tokenCost.input.total).toMatchObject({
      a: 10,
      b: 10,
      status: "compared",
    });
    expect(report.diagnostics.tokenCost.output.total.status).toBe(
      "insufficient",
    );
    expect(report.diagnostics.tokenCost.all.total.status).toBe("insufficient");
    expect(report.diagnostics.validity).toBe("inconclusive");
  });

  it("makes total-only token telemetry inconclusive", () => {
    const report = generateComparisonReport(
      [
        completed("a", {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: 14,
        }),
        completed("b", {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: 14,
        }),
      ],
      "a",
      "b",
      "model",
    );
    expect(report.diagnostics.tokenCost.all.total.status).toBe("compared");
    expect(report.diagnostics.tokenCost.input.total.status).toBe(
      "insufficient",
    );
    expect(report.diagnostics.validity).toBe("inconclusive");
  });

  it("uses independent eligible pairs for each measured dimension", () => {
    const report = generateComparisonReport(
      [
        completed("a", { fixtureId: "tokens", latencyMs: undefined }),
        completed("b", { fixtureId: "tokens", latencyMs: undefined }),
        completed("a", {
          fixtureId: "latency",
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
          latencyMs: 40,
        }),
        completed("b", {
          fixtureId: "latency",
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
          latencyMs: 60,
        }),
      ],
      "a",
      "b",
      "model",
    );
    expect(report.diagnostics.tokenCost.all.total.pairedCount).toBe(1);
    expect(report.diagnostics.tokenCost.all.perFixtureMean.a).toBe(14);
    expect(report.diagnostics.apiLatency).toMatchObject({
      pairedCount: 1,
      a: 40,
      b: 60,
    });
    expect(report.diagnostics.validity).toBe("inconclusive");
  });

  it("marks failed runs inconclusive and records failure reasons", () => {
    const failed: FixtureResult = {
      fixtureId: "fixture-1",
      domain: "code",
      agentType: "b",
      completion: "failed",
      failureReason: "api",
      matchedFindings: [],
      missedFindings: [],
      spuriousFindings: [],
      latencyMs: 10,
    };
    const report = generateComparisonReport(
      [completed("a"), failed],
      "a",
      "b",
      "model",
    );
    expect(report.diagnostics.validity).toBe("inconclusive");
    expect(report.diagnostics.completion.failureReasonsB).toEqual({ api: 1 });
    expect(report.aggregateScores.b).toBeNull();
    expect(report.headToHead).toEqual([]);
    expect(countFailures(report.results)).toBe(1);
    expect(exitCodeForResults(report.results)).toBe(1);
    expect(exitCodeForResults([completed("a")])).toBe(0);
  });

  it("uses the configured ground-truth directory", async () => {
    const directory = benchmarkDir();
    const labels = join(directory, "labels");
    mkdirSync(labels);
    writeFileSync(join(labels, "fixture-1.json"), JSON.stringify(groundTruth));
    const ticks = [0, 10, 12, 17];
    const results = await runBenchmark({
      benchmarkDir: directory,
      groundTruthDir: labels,
      agents: [
        {
          agentType: "agent-a",
          systemPrompt: "system",
          userMessageTemplate: (content) => content,
        },
      ],
      fixtures: [{ id: "fixture-1", content: "fixture", domain: "code" }],
      parseFn: () => parsed,
      cliArgs: {
        agents: ["agent-a"],
        fixture: null,
        outputDir: join(directory, "results"),
        model: "model",
        dryRun: false,
      },
      clock: { now: () => ticks.shift() ?? 17 },
      callApi: async () => ({ text: "OKAY", inputTokens: 7, outputTokens: 3 }),
    });
    expect(results[0]).toMatchObject({
      completion: "completed",
      totalTokens: 10,
    });
    expect(results[0]).toMatchObject({ latencyMs: 10, harnessOverheadMs: 5 });
  });

  it("retries retryable Claude calls before returning usage", async () => {
    vi.useFakeTimers();
    try {
      const create = vi
        .fn()
        .mockRejectedValueOnce(new Error("529 overloaded"))
        .mockResolvedValue({
          content: [{ type: "text", text: "OKAY" }],
          usage: { input_tokens: 8, output_tokens: 2 },
        });
      const promise = callClaude(
        { messages: { create } } as unknown as Anthropic,
        "system",
        "fixture",
        "model",
        1,
      );
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toEqual({
        text: "OKAY",
        inputTokens: 8,
        outputTokens: 2,
      });
      expect(create).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("measures API time after prompt construction and preserves zero durations", async () => {
    const directory = benchmarkDir();
    writeFileSync(
      join(directory, "ground-truth", "fixture-1.json"),
      JSON.stringify(groundTruth),
    );
    let now = 0;
    const measured = await runBenchmark({
      benchmarkDir: directory,
      groundTruthDir: join(directory, "ground-truth"),
      agents: [
        {
          agentType: "a",
          systemPrompt: "system",
          userMessageTemplate: (content) => {
            now += 50;
            return content;
          },
        },
      ],
      fixtures: [{ id: "fixture-1", content: "fixture", domain: "code" }],
      parseFn: () => {
        now += 10;
        return parsed;
      },
      cliArgs: {
        agents: ["a"],
        fixture: null,
        outputDir: "",
        model: "model",
        dryRun: false,
      },
      clock: { now: () => now },
      callApi: async () => {
        now += 100;
        return { text: "OKAY" };
      },
    });
    expect(measured[0]).toMatchObject({
      latencyMs: 100,
      harnessOverheadMs: 10,
    });

    const constantClock = { now: () => 5 };
    const zero = await runBenchmark({
      benchmarkDir: directory,
      groundTruthDir: join(directory, "ground-truth"),
      agents: [
        {
          agentType: "a",
          systemPrompt: "system",
          userMessageTemplate: (content) => content,
        },
      ],
      fixtures: [{ id: "fixture-1", content: "fixture", domain: "code" }],
      parseFn: () => parsed,
      cliArgs: {
        agents: ["a"],
        fixture: null,
        outputDir: "",
        model: "model",
        dryRun: false,
      },
      clock: constantClock,
      callApi: async () => ({ text: "OKAY" }),
    });
    expect(zero[0]).toMatchObject({ latencyMs: 0, harnessOverheadMs: 0 });
  });

  it("keeps malformed ground truth fatal", async () => {
    const directory = benchmarkDir();
    writeFileSync(
      join(directory, "ground-truth", "fixture-1.json"),
      "{not-json",
    );
    await expect(
      runBenchmark({
        benchmarkDir: directory,
        groundTruthDir: join(directory, "ground-truth"),
        agents: [
          {
            agentType: "agent-a",
            systemPrompt: "system",
            userMessageTemplate: (content) => content,
          },
        ],
        fixtures: [{ id: "fixture-1", content: "fixture", domain: "code" }],
        parseFn: () => parsed,
        cliArgs: {
          agents: ["agent-a"],
          fixture: null,
          outputDir: "",
          model: "model",
          dryRun: false,
        },
        callApi: async () => ({
          text: "OKAY",
          inputTokens: 7,
          outputTokens: 3,
        }),
      }),
    ).rejects.toThrow();
  });

  it("keeps a missing ground-truth root fatal", () => {
    const directory = benchmarkDir();
    expect(() =>
      loadGroundTruth(join(directory, "not-a-directory"), {
        id: "fixture-1",
        domain: "code",
      }),
    ).toThrow();
  });

  it("rejects mismatched ground-truth identity", () => {
    const directory = benchmarkDir();
    writeFileSync(
      join(directory, "ground-truth", "fixture-1.json"),
      JSON.stringify({ ...groundTruth, domain: "bug" }),
    );
    expect(() =>
      loadGroundTruth(join(directory, "ground-truth"), {
        id: "fixture-1",
        domain: "code",
      }),
    ).toThrow("Ground truth identity mismatch");
  });

  it("preserves typed identity and telemetry for missing ground truth", async () => {
    const directory = benchmarkDir();
    const ticks = [0, 10, 12, 17];
    const clock: Clock = { now: () => ticks.shift() ?? 17 };
    const results = await runBenchmark({
      benchmarkDir: directory,
      groundTruthDir: join(directory, "ground-truth"),
      agents: [
        {
          agentType: "agent-a",
          systemPrompt: "system",
          userMessageTemplate: (content) => content,
        },
      ],
      fixtures: [{ id: "missing", content: "fixture", domain: "task" }],
      parseFn: () => parsed,
      cliArgs: {
        agents: ["agent-a"],
        fixture: null,
        outputDir: join(directory, "results"),
        model: "model",
        dryRun: false,
      },
      clock,
      callApi: async () => ({ text: "OKAY", inputTokens: 7, outputTokens: 3 }),
    });
    expect(results).toEqual([
      expect.objectContaining({
        domain: "task",
        completion: "failed",
        failureReason: "missing-ground-truth",
        groundTruthMissing: true,
        latencyMs: 10,
        harnessOverheadMs: 5,
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
      }),
    ]);
  });

  it("records prompt and parse failures without fabricated quality", async () => {
    const directory = benchmarkDir();
    const promptFailure = await runBenchmark({
      benchmarkDir: directory,
      groundTruthDir: join(directory, "ground-truth"),
      agents: [
        {
          agentType: "a",
          systemPrompt: "system",
          userMessageTemplate: () => {
            throw new Error("prompt");
          },
        },
      ],
      fixtures: [{ id: "fixture-1", content: "fixture", domain: "code" }],
      parseFn: () => parsed,
      cliArgs: {
        agents: ["a"],
        fixture: null,
        outputDir: "",
        model: "model",
        dryRun: false,
      },
      callApi: async () => ({ text: "OKAY" }),
    });
    expect(promptFailure[0]).toMatchObject({
      completion: "failed",
      failureReason: "prompt",
    });

    const parseFailure = await runBenchmark({
      benchmarkDir: directory,
      groundTruthDir: join(directory, "ground-truth"),
      agents: [
        {
          agentType: "a",
          systemPrompt: "system",
          userMessageTemplate: (content) => content,
        },
      ],
      fixtures: [{ id: "fixture-1", content: "fixture", domain: "code" }],
      parseFn: () => {
        throw new Error("parse");
      },
      cliArgs: {
        agents: ["a"],
        fixture: null,
        outputDir: "",
        model: "model",
        dryRun: false,
      },
      callApi: async () => ({ text: "OKAY", inputTokens: 2, outputTokens: 1 }),
    });
    expect(parseFailure[0]).toMatchObject({
      completion: "failed",
      failureReason: "parse",
      totalTokens: 3,
    });
  });

  it("classifies score and match failures while preserving API telemetry", async () => {
    const directory = benchmarkDir();
    writeFileSync(
      join(directory, "ground-truth", "fixture-1.json"),
      JSON.stringify(groundTruth),
    );
    const common = {
      benchmarkDir: directory,
      groundTruthDir: join(directory, "ground-truth"),
      agents: [
        {
          agentType: "a",
          systemPrompt: "system",
          userMessageTemplate: (content: string) => content,
        },
      ],
      fixtures: [
        { id: "fixture-1", content: "fixture", domain: "code" as const },
      ],
      parseFn: () => parsed,
      cliArgs: {
        agents: ["a"],
        fixture: null,
        outputDir: "",
        model: "model",
        dryRun: false,
      },
      callApi: async () => ({ text: "OKAY", inputTokens: 2, outputTokens: 1 }),
    };
    const scoreFailure = await runBenchmark({
      ...common,
      scoreFn: () => {
        throw new Error("score");
      },
    });
    expect(scoreFailure[0]).toMatchObject({
      failureReason: "score",
      totalTokens: 3,
    });

    const matchFailure = await runBenchmark({
      ...common,
      matchFn: () => {
        throw new Error("match");
      },
    });
    expect(matchFailure[0]).toMatchObject({
      failureReason: "match",
      totalTokens: 3,
    });
  });

  it("prints separate rows for identical fixture ids in different domains", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    printSummaryTable(
      [completed("a"), completed("a", { domain: "bug" })],
      ["a"],
    );
    const output = log.mock.calls.flat().join("\n");
    log.mockRestore();
    expect(output).toContain("code:fixture-1");
    expect(output).toContain("bug:fixture-1");
  });
});
