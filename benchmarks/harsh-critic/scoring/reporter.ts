/**
 * Report generator for benchmark results.
 *
 * Produces both machine-readable JSON (BenchmarkReport) and human-readable
 * markdown summaries comparing harsh-critic vs critic agents.
 */

import type {
  AgentType,
  BenchmarkReport,
  BenchmarkScores,
  FixtureResult,
} from './types.js';
import { aggregateScores } from './scorer.js';

// ============================================================
// Public: generateJsonReport
// ============================================================

/**
 * Build a structured BenchmarkReport from raw fixture results.
 *
 * @param results - All FixtureResult entries (both agent types, all fixtures).
 * @param model   - Model identifier used during the benchmark run.
 */
export function generateJsonReport(
  results: FixtureResult[],
  model: string,
): BenchmarkReport {
  const harshResults = results.filter((r) => r.agentType === 'harsh-critic');
  const criticResults = results.filter((r) => r.agentType === 'critic');

  const harshAggregate = aggregateScores(harshResults);
  const criticAggregate = aggregateScores(criticResults);

  const aggregateScoresMap: Record<AgentType, BenchmarkScores> = {
    'harsh-critic': harshAggregate,
    'critic': criticAggregate,
  };

  // Per-metric deltas (harsh-critic minus critic) for numeric fields only
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
    const harshVal = harshAggregate[key];
    const criticVal = criticAggregate[key];
    if (typeof harshVal === 'number' && typeof criticVal === 'number') {
      deltas[key] = harshVal - criticVal;
    }
  }

  // Head-to-head per fixture (match by fixtureId)
  const fixtureIds = Array.from(new Set(results.map((r) => r.fixtureId)));
  const headToHead: BenchmarkReport['headToHead'] = fixtureIds.map((fixtureId) => {
    const harsh = harshResults.find((r) => r.fixtureId === fixtureId);
    const critic = criticResults.find((r) => r.fixtureId === fixtureId);

    const harshScore = harsh?.scores.compositeScore ?? 0;
    const criticScore = critic?.scores.compositeScore ?? 0;
    const delta = harshScore - criticScore;

    let winner: AgentType | 'tie';
    if (Math.abs(delta) < 0.001) {
      winner = 'tie';
    } else if (delta > 0) {
      winner = 'harsh-critic';
    } else {
      winner = 'critic';
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
 * Render a human-readable markdown report from a BenchmarkReport.
 */
export function generateMarkdownReport(report: BenchmarkReport): string {
  const harsh = report.aggregateScores['harsh-critic'];
  const critic = report.aggregateScores['critic'];

  const fixtureCount = new Set(report.results.map((r) => r.fixtureId)).size;

  const lines: string[] = [];

  // ---- Header ----
  lines.push('# Harsh-Critic Benchmark Report');
  lines.push('');
  lines.push(`**Date**: ${report.timestamp}`);
  lines.push(`**Model**: ${report.model}`);
  lines.push(`**Fixtures**: ${fixtureCount}`);
  lines.push('');

  // ---- Summary Table ----
  lines.push('## Summary Table');
  lines.push('');
  lines.push('| Metric | harsh-critic | critic | Delta |');
  lines.push('|--------|-------------|--------|-------|');

  for (const key of SUMMARY_METRICS) {
    const label = METRIC_LABELS[key] ?? key;
    const harshVal = harsh[key];
    const criticVal = critic[key];
    if (typeof harshVal === 'number' && typeof criticVal === 'number') {
      const delta = harshVal - criticVal;
      lines.push(`| ${label} | ${pct(harshVal)} | ${pct(criticVal)} | ${sign(delta)} |`);
    }
  }

  // Process compliance booleans
  lines.push(`| Pre-Commitment | ${bool(harsh.hasPreCommitment)} | ${bool(critic.hasPreCommitment)} | — |`);
  lines.push(`| Multi-Perspective | ${bool(harsh.hasMultiPerspective)} | ${bool(critic.hasMultiPerspective)} | — |`);
  lines.push(`| Gap Analysis | ${bool(harsh.hasGapAnalysis)} | ${bool(critic.hasGapAnalysis)} | — |`);
  lines.push('');

  // ---- Per-Fixture Results ----
  lines.push('## Per-Fixture Results');
  lines.push('');

  const fixtureIds = Array.from(new Set(report.results.map((r) => r.fixtureId))).sort();

  for (const fixtureId of fixtureIds) {
    lines.push(`### ${fixtureId}`);
    lines.push('');

    for (const agentType of ['harsh-critic', 'critic'] as AgentType[]) {
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
        lines.push(`  - Spurious: ${preview}${result.spuriousFindings.length > 3 ? ' …' : ''}`);
      }
    }
    lines.push('');
  }

  // ---- Statistical Summary ----
  lines.push('## Statistical Summary');
  lines.push('');

  const meanDelta = report.headToHead.reduce((acc, h) => acc + h.delta, 0) /
    Math.max(report.headToHead.length, 1);

  const wins = report.headToHead.filter((h) => h.winner === 'harsh-critic').length;
  const losses = report.headToHead.filter((h) => h.winner === 'critic').length;
  const ties = report.headToHead.filter((h) => h.winner === 'tie').length;

  lines.push(`- Mean composite delta: ${sign(meanDelta)}`);
  lines.push(`- Win/Loss/Tie: ${wins}/${losses}/${ties}`);
  lines.push('');

  // ---- Key Insight ----
  lines.push('## Key Insight');
  lines.push('');

  // Find metric with largest absolute improvement for harsh-critic
  let largestMetric: string = 'compositeScore';
  let largestDelta = 0;

  for (const key of SUMMARY_METRICS) {
    const delta = report.deltas[key];
    if (typeof delta === 'number' && Math.abs(delta) > Math.abs(largestDelta)) {
      largestDelta = delta;
      largestMetric = key;
    }
  }

  const label = METRIC_LABELS[largestMetric as keyof BenchmarkScores] ?? largestMetric;
  const direction = largestDelta >= 0 ? 'improved' : 'regressed';
  lines.push(
    `**${label}** showed the largest difference: harsh-critic ${direction} by ${sign(largestDelta)} over critic.`,
  );
  lines.push('');

  return lines.join('\n');
}
