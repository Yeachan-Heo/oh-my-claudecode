/**
 * Generalized Benchmark Scoring Types for Agent Evaluation
 *
 * Extends the harsh-critic scoring types to support all agent benchmarks:
 * code-reviewer, debugger, executor, and critic/harsh-critic.
 */

// ============================================================
// GROUND TRUTH
// ============================================================

export type Severity = 'CRITICAL' | 'MAJOR' | 'MINOR';

export type FindingCategory = 'finding' | 'missing' | 'perspective';

export type Perspective = 'security' | 'new-hire' | 'ops';

/** Domains across all agent types */
export type Domain = 'plan' | 'code' | 'analysis' | 'bug' | 'task';

/** Agent type is a free-form string to support any agent benchmark */
export type AgentType = string;

/**
 * A single expected finding in a fixture's ground truth.
 * Each finding has keywords that must appear in a matching agent output.
 */
export interface GroundTruthFinding {
  /** Unique identifier, e.g. "AUTH-CRIT-1" */
  id: string;
  /** Expected severity level */
  severity: Severity;
  /** Whether this is a direct finding, a missing item, or a perspective-specific finding */
  category: FindingCategory;
  /** Which perspective this finding relates to (if category is 'perspective') */
  perspective?: Perspective;
  /** Short description of the embedded flaw */
  summary: string;
  /** Keywords that must appear in a matching agent finding (>= 2 must match) */
  keywords: string[];
  /** File:line or section reference if applicable */
  location?: string;
  /** Why this is a real issue (for documentation) */
  explanation: string;
}

/**
 * Ground truth for a single fixture.
 * Generalized to support all agent types.
 */
export interface GroundTruth {
  /** Fixture identifier matching the filename (without extension) */
  fixtureId: string;
  /** Path to the fixture file relative to the benchmark directory */
  fixturePath: string;
  /** Domain of the fixture */
  domain: Domain;
  /** Expected verdict/classification from the agent (optional — not all agents produce verdicts) */
  expectedVerdict?: string;
  /** All expected findings embedded in the fixture */
  findings: GroundTruthFinding[];
  /** Whether this is a clean baseline (for false-positive testing) */
  isCleanBaseline: boolean;
}

// ============================================================
// PARSED AGENT OUTPUT
// ============================================================

/**
 * A single finding extracted from agent output.
 */
export interface ParsedFinding {
  /** Raw text of the finding */
  text: string;
  /** Severity as stated by the agent */
  severity: Severity;
  /** Whether the finding includes file:line or specific code references */
  hasEvidence: boolean;
  /** ID of the matched ground-truth finding (set during scoring) */
  matchedGroundTruth?: string;
}

/**
 * Structured representation of an agent's output.
 * Generalized to cover all agent types — not all fields are relevant for all agents.
 */
export interface ParsedAgentOutput {
  /** The agent's verdict/classification string (if applicable) */
  verdict: string;
  /** Findings categorized by severity */
  criticalFindings: ParsedFinding[];
  majorFindings: ParsedFinding[];
  minorFindings: ParsedFinding[];
  /** Items from the "What's Missing" section */
  missingItems: string[];
  /** Multi-perspective notes (critic/reviewer agents) */
  perspectiveNotes: {
    security: string[];
    newHire: string[];
    ops: string[];
  };
  /** Whether the agent made pre-commitment predictions before investigation */
  hasPreCommitment: boolean;
  /** Whether the agent's output includes a gap analysis section */
  hasGapAnalysis: boolean;
  /** Whether the agent addressed multiple perspectives */
  hasMultiPerspective: boolean;
  /** Raw output text (for debugging) */
  rawOutput: string;
}

// ============================================================
// SCORING
// ============================================================

/**
 * Scores for a single agent run against a single fixture.
 */
export interface BenchmarkScores {
  // Core detection metrics (0-1 scale)
  /** Findings that match ground truth / total ground truth */
  truePositiveRate: number;
  /** Findings that don't match any ground truth / total agent findings */
  falsePositiveRate: number;
  /** Ground truth items not found / total ground truth */
  falseNegativeRate: number;

  // Severity accuracy
  /** Correct severity rating / total matched findings */
  severityAccuracy: number;

  // Gap detection (the key differentiator)
  /** "What's Missing" items matching ground truth / total missing-category ground truth */
  missingCoverage: number;
  /** Perspective findings matching ground truth / total perspective-category ground truth */
  perspectiveCoverage: number;

  // Evidence quality
  /** CRITICAL+MAJOR findings with file:line evidence / total CRITICAL+MAJOR findings */
  evidenceRate: number;

  // Process compliance (boolean flags)
  /** Pre-commitment predictions present */
  hasPreCommitment: boolean;
  /** All 3 perspectives addressed */
  hasMultiPerspective: boolean;
  /** "What's Missing" section present and non-empty */
  hasGapAnalysis: boolean;

  // Aggregate
  /** Weighted combination of all metrics */
  compositeScore: number;
}

/**
 * Result of running one agent against one fixture.
 */
export interface FixtureResult {
  fixtureId: string;
  domain: Domain;
  agentType: AgentType;
  parsedOutput: ParsedAgentOutput;
  scores: BenchmarkScores;
  /** Ground truth findings that were matched */
  matchedFindings: string[];
  /** Ground truth findings that were missed */
  missedFindings: string[];
  /** Agent findings that didn't match any ground truth */
  spuriousFindings: string[];
  /** Latency in milliseconds */
  latencyMs?: number;
  /** Input tokens consumed */
  inputTokens?: number;
  /** Output tokens consumed */
  outputTokens?: number;
}

/**
 * Aggregated result for a single agent across all fixtures.
 */
export interface AgentBenchmarkReport {
  /** Timestamp of the benchmark run */
  timestamp: string;
  /** Model used for the benchmark */
  model: string;
  /** Agent being benchmarked */
  agentType: AgentType;
  /** Per-fixture results */
  results: FixtureResult[];
  /** Aggregate scores */
  aggregateScores: BenchmarkScores;
}

/**
 * Comparison report between two agents (old vs new prompt).
 */
export interface ComparisonReport {
  /** Timestamp of the benchmark run */
  timestamp: string;
  /** Model used for the benchmark */
  model: string;
  /** Per-fixture results for each agent */
  results: FixtureResult[];
  /** Aggregate scores per agent */
  aggregateScores: Record<AgentType, BenchmarkScores>;
  /** Per-metric deltas (agent A minus agent B) */
  deltas: Partial<Record<keyof BenchmarkScores, number>>;
  /** Per-fixture win/loss/tie */
  headToHead: Array<{
    fixtureId: string;
    winner: AgentType | 'tie';
    delta: number;
  }>;
}

// ============================================================
// SCORING WEIGHTS
// ============================================================

/**
 * Weights for composite score calculation.
 * Sum to 1.0.
 */
export const SCORING_WEIGHTS = {
  truePositiveRate: 0.25,
  falseNegativeRate: 0.15,   // inverted: lower is better
  falsePositiveRate: 0.10,   // inverted: lower is better
  missingCoverage: 0.20,     // key differentiator
  perspectiveCoverage: 0.10,
  evidenceRate: 0.10,
  processCompliance: 0.10,
} as const;

/**
 * Minimum keyword matches required to consider a ground truth finding "matched".
 */
export const MIN_KEYWORD_MATCHES = 2;

/**
 * Whether severity must match exactly or can be within 1 level.
 * Adjacent severities: CRITICAL<->MAJOR, MAJOR<->MINOR
 */
export const ALLOW_ADJACENT_SEVERITY = true;
