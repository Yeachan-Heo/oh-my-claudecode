import type {
  AgentType,
  BenchmarkScores,
  ComparisonReport,
  CompletedFixtureResult,
  DiagnosticComparison,
  FailureReason,
  FixtureResult,
  NumericDiagnostic,
  TokenDimensionDiagnostic,
} from "./types.ts";
import { aggregateScoresUnknownCapable } from "./scorer.ts";

const NUMERIC_SCORE_KEYS: Array<keyof BenchmarkScores> = [
  "truePositiveRate",
  "falsePositiveRate",
  "falseNegativeRate",
  "severityAccuracy",
  "missingCoverage",
  "perspectiveCoverage",
  "evidenceRate",
  "compositeScore",
];

export class DuplicateFixtureKeyError extends Error {
  constructor(side: string, key: string) {
    super(`Duplicate fixture key on ${side}: ${key}`);
    this.name = "DuplicateFixtureKeyError";
  }
}

export function keyOf(
  result: Pick<FixtureResult, "domain" | "fixtureId">,
): string {
  return `${result.domain}:${result.fixtureId}`;
}

function uniqueByKey(
  results: FixtureResult[],
  side: string,
): Map<string, FixtureResult> {
  const map = new Map<string, FixtureResult>();
  for (const result of results) {
    const key = keyOf(result);
    if (map.has(key)) throw new DuplicateFixtureKeyError(side, key);
    map.set(key, result);
  }
  return map;
}

export function pairResults(
  aResults: FixtureResult[],
  bResults: FixtureResult[],
): {
  paired: Array<{ key: string; a: FixtureResult; b: FixtureResult }>;
  aOnlyKeys: string[];
  bOnlyKeys: string[];
} {
  const aByKey = uniqueByKey(aResults, "A");
  const bByKey = uniqueByKey(bResults, "B");
  const paired: Array<{ key: string; a: FixtureResult; b: FixtureResult }> = [];
  const aOnlyKeys: string[] = [];
  const bOnlyKeys: string[] = [];

  for (const [key, a] of aByKey) {
    const b = bByKey.get(key);
    if (b) paired.push({ key, a, b });
    else aOnlyKeys.push(key);
  }
  for (const key of bByKey.keys()) {
    if (!aByKey.has(key)) bOnlyKeys.push(key);
  }

  paired.sort((left, right) => left.key.localeCompare(right.key));
  aOnlyKeys.sort();
  bOnlyKeys.sort();
  return { paired, aOnlyKeys, bOnlyKeys };
}

function aggregate(values: number[], kind: "sum" | "mean"): number | undefined {
  if (values.length === 0) return undefined;
  const total = values.reduce((current, value) => current + value, 0);
  return kind === "sum" ? total : total / values.length;
}

function numericDiagnostic(
  pairs: Array<{ a: FixtureResult; b: FixtureResult }>,
  selector: (result: FixtureResult) => number | undefined,
  unit: NumericDiagnostic["unit"],
  aggregateKind: "sum" | "mean",
): NumericDiagnostic {
  const aValues: number[] = [];
  const bValues: number[] = [];
  for (const pair of pairs) {
    const aValue = selector(pair.a);
    const bValue = selector(pair.b);
    if (aValue === undefined || bValue === undefined) continue;
    aValues.push(aValue);
    bValues.push(bValue);
  }
  const a = aggregate(aValues, aggregateKind);
  const b = aggregate(bValues, aggregateKind);
  return {
    a,
    b,
    delta: a !== undefined && b !== undefined ? a - b : undefined,
    pairedCount: aValues.length,
    unit,
    status: aValues.length > 0 ? "compared" : "insufficient",
  };
}

function tokenDimension(
  pairs: Array<{ a: FixtureResult; b: FixtureResult }>,
  selector: (result: FixtureResult) => number | undefined,
): TokenDimensionDiagnostic {
  return {
    total: numericDiagnostic(pairs, selector, "tokens", "sum"),
    perFixtureMean: numericDiagnostic(pairs, selector, "tokens", "mean"),
  };
}

function failureReasons(
  results: FixtureResult[],
): Partial<Record<FailureReason, number>> {
  const counts: Partial<Record<FailureReason, number>> = {};
  for (const result of results) {
    if (result.completion !== "failed") continue;
    counts[result.failureReason] = (counts[result.failureReason] ?? 0) + 1;
  }
  return counts;
}

function buildDiagnostics(
  aResults: FixtureResult[],
  bResults: FixtureResult[],
  paired: Array<{ a: FixtureResult; b: FixtureResult }>,
  aOnlyKeys: string[],
  bOnlyKeys: string[],
  sameAgent: boolean,
): DiagnosticComparison {
  const qualityPairs = paired.filter(
    (pair) =>
      pair.a.completion === "completed" && pair.b.completion === "completed",
  );
  const measurementPairs = sameAgent ? [] : paired;
  const tokenCost = {
    input: tokenDimension(measurementPairs, (result) => result.inputTokens),
    output: tokenDimension(measurementPairs, (result) => result.outputTokens),
    all: tokenDimension(measurementPairs, (result) => result.totalTokens),
  };
  const apiLatency = numericDiagnostic(
    measurementPairs,
    (result) => result.latencyMs,
    "milliseconds",
    "mean",
  );
  const harnessOverhead = numericDiagnostic(
    measurementPairs,
    (result) => result.harnessOverheadMs,
    "milliseconds",
    "mean",
  );

  const reasons: string[] = [];
  if (sameAgent) reasons.push("comparison requires two distinct agents");
  if (paired.length === 0) reasons.push("no paired fixture observations");
  if (aOnlyKeys.length > 0 || bOnlyKeys.length > 0)
    reasons.push("fixture populations differ");
  if (
    paired.some(
      (pair) =>
        pair.a.completion === "failed" || pair.b.completion === "failed",
    )
  ) {
    reasons.push("one or more paired runs failed");
  }
  if (
    !sameAgent &&
    [tokenCost.input, tokenCost.output, tokenCost.all].some(
      (dimension) => dimension.total.pairedCount !== paired.length,
    )
  ) {
    reasons.push("token telemetry is incomplete");
  }
  if (!sameAgent && apiLatency.pairedCount !== paired.length) {
    reasons.push("API latency telemetry is incomplete");
  }
  if (!sameAgent && harnessOverhead.pairedCount !== paired.length) {
    reasons.push("harness overhead telemetry is incomplete");
  }

  return {
    completion: {
      completedA: aResults.filter((result) => result.completion === "completed")
        .length,
      failedA: aResults.filter((result) => result.completion === "failed")
        .length,
      completedB: bResults.filter((result) => result.completion === "completed")
        .length,
      failedB: bResults.filter((result) => result.completion === "failed")
        .length,
      failureReasonsA: failureReasons(aResults),
      failureReasonsB: failureReasons(bResults),
      pairedFixtures: paired.length,
      aOnlyKeys,
      bOnlyKeys,
    },
    qualityPairedCount: sameAgent ? 0 : qualityPairs.length,
    tokenCost,
    apiLatency,
    harnessOverhead,
    validity: reasons.length === 0 ? "valid" : "inconclusive",
    reasons,
  };
}

export function generateComparisonReport(
  results: FixtureResult[],
  agentA: AgentType,
  agentB: AgentType,
  model: string,
): ComparisonReport {
  const sameAgent = agentA === agentB;
  const aResults = results.filter((result) => result.agentType === agentA);
  const bResults = results.filter((result) => result.agentType === agentB);
  const pairing = pairResults(aResults, bResults);
  const qualityPairs = pairing.paired.filter(
    (
      pair,
    ): pair is {
      key: string;
      a: CompletedFixtureResult;
      b: CompletedFixtureResult;
    } => pair.a.completion === "completed" && pair.b.completion === "completed",
  );
  const aAggregate = sameAgent
    ? null
    : aggregateScoresUnknownCapable(qualityPairs.map((pair) => pair.a));
  const bAggregate = sameAgent
    ? null
    : aggregateScoresUnknownCapable(qualityPairs.map((pair) => pair.b));
  const aggregateScores: Record<AgentType, BenchmarkScores | null> = {
    [agentA]: aAggregate,
    [agentB]: bAggregate,
  };
  const deltas: Partial<Record<keyof BenchmarkScores, number>> = {};
  if (aAggregate && bAggregate) {
    for (const key of NUMERIC_SCORE_KEYS) {
      const aValue = aAggregate[key];
      const bValue = bAggregate[key];
      if (typeof aValue === "number" && typeof bValue === "number") {
        deltas[key] = aValue - bValue;
      }
    }
  }

  const headToHead: ComparisonReport["headToHead"] = sameAgent
    ? []
    : qualityPairs.map(({ a, b }) => {
        const delta = a.scores.compositeScore - b.scores.compositeScore;
        return {
          fixtureId: a.fixtureId,
          domain: a.domain,
          winner: Math.abs(delta) < 0.001 ? "tie" : delta > 0 ? agentA : agentB,
          delta,
        };
      });

  return {
    timestamp: new Date().toISOString(),
    model,
    results,
    aggregateScores,
    deltas,
    headToHead,
    diagnostics: buildDiagnostics(
      aResults,
      bResults,
      pairing.paired,
      pairing.aOnlyKeys,
      pairing.bOnlyKeys,
      sameAgent,
    ),
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function numberOrNA(value: number | undefined, digits = 1): string {
  return value === undefined ? "n/a" : value.toFixed(digits);
}

function diagnosticRow(
  label: string,
  diagnostic: NumericDiagnostic,
  digits = 1,
): string {
  return `| ${label} | ${numberOrNA(diagnostic.a, digits)} | ${numberOrNA(diagnostic.b, digits)} | ${numberOrNA(diagnostic.delta, digits)} | ${diagnostic.pairedCount} | ${diagnostic.status} |`;
}

export function generateMarkdownReport(
  report: ComparisonReport,
  agentA: AgentType,
  agentB: AgentType,
): string {
  const a = report.aggregateScores[agentA];
  const b = report.aggregateScores[agentB];
  const d = report.diagnostics;
  const lines = [
    `# ${agentA} vs ${agentB} Benchmark Report`,
    "",
    `**Date**: ${report.timestamp}`,
    `**Model**: ${report.model}`,
    `**Validity**: ${d.validity.toUpperCase()}`,
    ...(d.reasons.length > 0 ? [`**Reasons**: ${d.reasons.join("; ")}`] : []),
    "",
    "## Evidence-Safe Diagnostic",
    "",
    `| Dimension | ${agentA} | ${agentB} | Delta | Paired | Status |`,
    "|---|---:|---:|---:|---:|---|",
    `| Completion | ${d.completion.completedA} completed / ${d.completion.failedA} failed | ${d.completion.completedB} completed / ${d.completion.failedB} failed | n/a | ${d.completion.pairedFixtures} | ${d.validity} |`,
    `| Scorer quality | ${a ? pct(a.compositeScore) : "n/a"} | ${b ? pct(b.compositeScore) : "n/a"} | ${typeof report.deltas.compositeScore === "number" ? pct(report.deltas.compositeScore) : "n/a"} | ${d.qualityPairedCount} | ${d.qualityPairedCount > 0 ? "compared" : "insufficient"} |`,
    diagnosticRow("Input tokens (total)", d.tokenCost.input.total, 0),
    diagnosticRow(
      "Input tokens (per-fixture mean)",
      d.tokenCost.input.perFixtureMean,
    ),
    diagnosticRow("Output tokens (total)", d.tokenCost.output.total, 0),
    diagnosticRow(
      "Output tokens (per-fixture mean)",
      d.tokenCost.output.perFixtureMean,
    ),
    diagnosticRow("All tokens (total)", d.tokenCost.all.total, 0),
    diagnosticRow(
      "All tokens (per-fixture mean)",
      d.tokenCost.all.perFixtureMean,
    ),
    diagnosticRow("API latency mean (ms)", d.apiLatency),
    diagnosticRow("Harness overhead mean (ms)", d.harnessOverhead),
    "",
    `Unpaired ${agentA}: ${d.completion.aOnlyKeys.join(", ") || "none"}`,
    `Unpaired ${agentB}: ${d.completion.bOnlyKeys.join(", ") || "none"}`,
    "",
    "## Per-Fixture Results",
    "",
  ];

  for (const result of [...report.results].sort((left, right) =>
    keyOf(left).localeCompare(keyOf(right)),
  )) {
    lines.push(
      `- **${keyOf(result)} / ${result.agentType}**: ${result.completion}`,
    );
    if (result.completion === "completed") {
      lines.push(`  - Composite quality: ${pct(result.scores.compositeScore)}`);
    } else {
      lines.push(`  - Failure reason: ${result.failureReason}`);
    }
    lines.push(
      `  - Tokens: input=${result.inputTokens ?? "n/a"}, output=${result.outputTokens ?? "n/a"}, total=${result.totalTokens ?? "n/a"}`,
    );
    lines.push(
      `  - API latency: ${result.latencyMs === undefined ? "n/a" : `${result.latencyMs.toFixed(1)}ms`}`,
    );
    lines.push(
      `  - Harness overhead: ${result.harnessOverheadMs === undefined ? "n/a" : `${result.harnessOverheadMs.toFixed(1)}ms`}`,
    );
  }

  lines.push("");
  lines.push(
    "This diagnostic reports separate observed dimensions. It does not prove an Opus regression or attribute timing to model compute, network, or harness internals beyond the stated boundaries.",
  );
  return lines.join("\n");
}
