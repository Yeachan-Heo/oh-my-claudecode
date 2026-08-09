// Generalized benchmark scoring types for shared agent evaluations.

export type Severity = "CRITICAL" | "MAJOR" | "MINOR";
export type FindingCategory = "finding" | "missing" | "perspective";
export type Perspective = "security" | "new-hire" | "ops";
export type Domain = "plan" | "code" | "analysis" | "bug" | "task";
export type AgentType = string;

export interface GroundTruthFinding {
  id: string;
  severity: Severity;
  category: FindingCategory;
  perspective?: Perspective;
  summary: string;
  keywords: string[];
  location?: string;
  explanation: string;
}

export interface GroundTruth {
  fixtureId: string;
  fixturePath: string;
  domain: Domain;
  expectedVerdict?: string;
  findings: GroundTruthFinding[];
  isCleanBaseline: boolean;
}

export interface ParsedFinding {
  text: string;
  severity: Severity;
  hasEvidence: boolean;
  matchedGroundTruth?: string;
}

export interface ParsedAgentOutput {
  verdict: string;
  criticalFindings: ParsedFinding[];
  majorFindings: ParsedFinding[];
  minorFindings: ParsedFinding[];
  missingItems: string[];
  perspectiveNotes: {
    security: string[];
    newHire: string[];
    ops: string[];
  };
  hasPreCommitment: boolean;
  hasGapAnalysis: boolean;
  hasMultiPerspective: boolean;
  rawOutput: string;
}

export interface BenchmarkScores {
  truePositiveRate: number;
  falsePositiveRate: number;
  falseNegativeRate: number;
  severityAccuracy: number;
  missingCoverage: number;
  perspectiveCoverage: number;
  evidenceRate: number;
  hasPreCommitment: boolean;
  hasMultiPerspective: boolean;
  hasGapAnalysis: boolean;
  compositeScore: number;
}

export type RunCompletion = "completed" | "failed";
export type FailureReason =
  | "api"
  | "prompt"
  | "parse"
  | "score"
  | "match"
  | "missing-ground-truth";

export interface FixtureResultBase {
  fixtureId: string;
  domain: Domain;
  agentType: AgentType;
  completion: RunCompletion;
  matchedFindings: string[];
  missedFindings: string[];
  spuriousFindings: string[];
  /** Retry-inclusive API-call span. It is not pure model compute time. */
  latencyMs?: number;
  /** Non-API processing after the API response. */
  harnessOverheadMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Present only when both input and output usage are available. */
  totalTokens?: number;
  groundTruthMissing?: boolean;
}

export interface CompletedFixtureResult extends FixtureResultBase {
  completion: "completed";
  parsedOutput: ParsedAgentOutput;
  scores: BenchmarkScores;
}

export interface FailedFixtureResult extends FixtureResultBase {
  completion: "failed";
  failureReason: FailureReason;
  parsedOutput?: never;
  scores?: never;
}

export type FixtureResult = CompletedFixtureResult | FailedFixtureResult;

export interface CompletionCoverage {
  completedA: number;
  failedA: number;
  completedB: number;
  failedB: number;
  failureReasonsA: Partial<Record<FailureReason, number>>;
  failureReasonsB: Partial<Record<FailureReason, number>>;
  pairedFixtures: number;
  aOnlyKeys: string[];
  bOnlyKeys: string[];
}

export interface NumericDiagnostic {
  a?: number;
  b?: number;
  delta?: number;
  pairedCount: number;
  unit: "tokens" | "milliseconds";
  status: "compared" | "insufficient";
}

export interface TokenDimensionDiagnostic {
  total: NumericDiagnostic;
  perFixtureMean: NumericDiagnostic;
}

export interface TokenDiagnostic {
  input: TokenDimensionDiagnostic;
  output: TokenDimensionDiagnostic;
  all: TokenDimensionDiagnostic;
}

export interface DiagnosticComparison {
  completion: CompletionCoverage;
  qualityPairedCount: number;
  tokenCost: TokenDiagnostic;
  apiLatency: NumericDiagnostic;
  harnessOverhead: NumericDiagnostic;
  validity: "valid" | "inconclusive";
  reasons: string[];
}

export interface ComparisonReport {
  timestamp: string;
  model: string;
  results: FixtureResult[];
  aggregateScores: Record<AgentType, BenchmarkScores | null>;
  deltas: Partial<Record<keyof BenchmarkScores, number>>;
  headToHead: Array<{
    fixtureId: string;
    domain: Domain;
    winner: AgentType | "tie";
    delta: number;
  }>;
  diagnostics: DiagnosticComparison;
}

export const SCORING_WEIGHTS = {
  truePositiveRate: 0.25,
  falseNegativeRate: 0.15,
  falsePositiveRate: 0.1,
  missingCoverage: 0.2,
  perspectiveCoverage: 0.1,
  evidenceRate: 0.1,
  processCompliance: 0.1,
} as const;

export const MIN_KEYWORD_MATCHES = 2;
export const ALLOW_ADJACENT_SEVERITY = true;
