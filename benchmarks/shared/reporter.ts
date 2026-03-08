/**
 * Generalized report generator for agent benchmark results.
 *
 * Produces both machine-readable JSON and human-readable markdown
 * comparing two agent variants (e.g., old prompt vs new prompt).
 */

import type {
  AgentType,
  BenchmarkScores,
  ComparisonReport,
  FixtureResult,
  AgentBenchmarkReport,
} from './types.ts';
import { aggregateScores } from './scorer.ts';

// ============================================================
// Public: generateAgentReport
// ============================================================

/**
 * Build a single-agent benchmark report.
 */
export function generateAgentReport(
  results: FixtureResult[],
  agentType: AgentType,
  model: string,
): AgentBenchmarkReport {
  return {
    timestamp: new Date().toISOString(),
    model,
    agentType,
    results,
    aggregateScores: aggregateScores(results),
  };
}

// ============================================================
// Public: generateComparisonReport
// ============================================================

/**
 * Build a comparison report between two agent variants.
 */
export function generateComparisonReport(
  results: FixtureResult[],
  agentA: AgentType,
  agentB: AgentType,
  model: string,
): ComparisonReport {
  const aResults = results.filter((r) => r.agentType === agentA);
  const bResults = results.filter((r) => r.agentType === agentB);

  const aAggregate = aggregateScores(aResults);
  const bAggregate = aggregateScores(bResults);

  const aggregateScoresMap: Record<AgentType, BenchmarkScores> = {
    [agentA]: aAggregate,
    [agentB]: bAggregate,
  };

  // Per-metric deltas (A minus B) for numeric fields only
  const numericKeys: Array<keyof BenchmarkScores> = [
    'truePositiveRate',
    'falsePositiveRate',
    'falseNegativeRate',
    'severityAccuracy',
    'missingCoverage',
    'perspectiveCoverage',
    'evidenceRate',
    'compositeScore',
  ];

  const deltas: Partial<Record<keyof BenchmarkScores, number>> = {};
  for (const key of numericKeys) {
    const aVal = aAggregate[key];
    const bVal = bAggregate[key];
    if (typeof aVal === 'number' && typeof bVal === 'number') {
      deltas[key] = aVal - bVal;
    }
  }

  // Head-to-head per fixture
  const fixtureIds = Array.from(new Set(results.map((r) => r.fixtureId)));
  const headToHead: ComparisonReport['headToHead'] = fixtureIds.map((fixtureId) => {
    const a = aResults.find((r) => r.fixtureId === fixtureId);
    const b = bResults.find((r) => r.fixtureId === fixtureId);

    const aScore = a?.scores.compositeScore ?? 0;
    const bScore = b?.scores.compositeScore ?? 0;
    const delta = aScore - bScore;

    let winner: AgentType | 'tie';
    if (Math.abs(delta) < 0.001) {
      winner = 'tie';
    } else if (delta > 0) {
      winner = agentA;
    } else {
      winner = agentB;
    }

    return { fixtureId, winner, delta };
  });

  return {
    timestamp: new Date().toISOString(),
    model,
    results,
    aggregateScores: aggregateScoresMap,
    deltas,
    headToHead,
  };
}

// ============================================================
// Markdown formatting helpers
// ============================================================

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function sign(value: number): string {
  return value >= 0 ? `+${pct(value)}` : `-${pct(Math.abs(value))}`;
}

function bool(value: boolean): string {
  return value ? 'yes' : 'no';
}

const METRIC_LABELS: Partial<Record<keyof BenchmarkScores, string>> = {
  truePositiveRate: 'True Positive Rate',
  falseNegativeRate: 'False Negative Rate',
  falsePositiveRate: 'False Positive Rate',
  severityAccuracy: 'Severity Accuracy',
  missingCoverage: 'Missing Coverage',
  perspectiveCoverage: 'Perspective Coverage',
  evidenceRate: 'Evidence Rate',
  compositeScore: 'Composite Score',
};

const SUMMARY_METRICS: Array<keyof BenchmarkScores> = [
  'truePositiveRate',
  'falseNegativeRate',
  'falsePositiveRate',
  'severityAccuracy',
  'missingCoverage',
  'perspectiveCoverage',
  'evidenceRate',
  'compositeScore',
];

// ============================================================
// Public: generateMarkdownReport
// ============================================================

/**
 * Render a human-readable markdown comparison report.
 */
export function generateMarkdownReport(
  report: ComparisonReport,
  agentA: AgentType,
  agentB: AgentType,
): string {
  const a = report.aggregateScores[agentA];
  const b = report.aggregateScores[agentB];

  if (!a || !b) {
    return `# Benchmark Report\n\nError: Missing aggregate scores for agents "${agentA}" and/or "${agentB}".\n`;
  }

  const fixtureCount = new Set(report.results.map((r) => r.fixtureId)).size;

  const lines: string[] = [];

  // ---- Header ----
  lines.push(`# ${agentA} vs ${agentB} Benchmark Report`);
  lines.push('');
  lines.push(`**Date**: ${report.timestamp}`);
  lines.push(`**Model**: ${report.model}`);
  lines.push(`**Fixtures**: ${fixtureCount}`);
  lines.push('');

  // ---- Summary Table ----
  lines.push('## Summary Table');
  lines.push('');
  lines.push(`| Metric | ${agentA} | ${agentB} | Delta |`);
  lines.push('|--------|-------------|--------|-------|');

  for (const key of SUMMARY_METRICS) {
    const label = METRIC_LABELS[key] ?? key;
    const aVal = a[key];
    const bVal = b[key];
    if (typeof aVal === 'number' && typeof bVal === 'number') {
      const delta = aVal - bVal;
      lines.push(`| ${label} | ${pct(aVal)} | ${pct(bVal)} | ${sign(delta)} |`);
    }
  }

  lines.push(`| Pre-Commitment | ${bool(a.hasPreCommitment)} | ${bool(b.hasPreCommitment)} | - |`);
  lines.push(`| Multi-Perspective | ${bool(a.hasMultiPerspective)} | ${bool(b.hasMultiPerspective)} | - |`);
  lines.push(`| Gap Analysis | ${bool(a.hasGapAnalysis)} | ${bool(b.hasGapAnalysis)} | - |`);
  lines.push('');

  // ---- Per-Fixture Results ----
  lines.push('## Per-Fixture Results');
  lines.push('');

  const fixtureIds = Array.from(new Set(report.results.map((r) => r.fixtureId))).sort();

  for (const fixtureId of fixtureIds) {
    lines.push(`### ${fixtureId}`);
    lines.push('');

    for (const agentType of [agentA, agentB]) {
      const result = report.results.find(
        (r) => r.fixtureId === fixtureId && r.agentType === agentType,
      );
      if (!result) continue;

      const s = result.scores;
      lines.push(
        `- **${agentType}**: composite=${pct(s.compositeScore)} ` +
          `tp=${pct(s.truePositiveRate)} fn=${pct(s.falseNegativeRate)} ` +
          `fp=${pct(s.falsePositiveRate)}`,
      );
      lines.push(
        `  - Matched: ${result.matchedFindings.length}/${result.matchedFindings.length + result.missedFindings.length} findings`,
      );

      if (result.missedFindings.length > 0) {
        lines.push(`  - Missed: ${result.missedFindings.join(', ')}`);
      }
      if (result.spuriousFindings.length > 0) {
        const preview = result.spuriousFindings
          .slice(0, 3)
          .map((t) => t.slice(0, 60).replace(/\n/g, ' '))
          .join('; ');
        lines.push(`  - Spurious: ${preview}${result.spuriousFindings.length > 3 ? ' ...' : ''}`);
      }

      if (result.latencyMs !== undefined) {
        lines.push(`  - Latency: ${(result.latencyMs / 1000).toFixed(1)}s`);
      }
    }
    lines.push('');
  }

  // ---- Statistical Summary ----
  lines.push('## Statistical Summary');
  lines.push('');

  const meanDelta = report.headToHead.reduce((acc, h) => acc + h.delta, 0) /
    Math.max(report.headToHead.length, 1);

  const wins = report.headToHead.filter((h) => h.winner === agentA).length;
  const losses = report.headToHead.filter((h) => h.winner === agentB).length;
  const ties = report.headToHead.filter((h) => h.winner === 'tie').length;

  lines.push(`- Mean composite delta: ${sign(meanDelta)}`);
  lines.push(`- Win/Loss/Tie (${agentA} perspective): ${wins}/${losses}/${ties}`);
  lines.push('');

  return lines.join('\n');
}
