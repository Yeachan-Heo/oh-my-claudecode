import {
  aggregateScores as aggregateCanonicalScores,
  matchFindings as matchCanonicalFindings,
  scoreFixture as scoreCanonicalFixture,
} from "../harsh-critic/scoring/scorer.ts";
import type {
  AgentType as CanonicalAgentType,
  Domain as CanonicalDomain,
  FixtureResult as CanonicalFixtureResult,
  GroundTruth as CanonicalGroundTruth,
  HarshCriticVerdict,
} from "../harsh-critic/scoring/types.ts";
import type {
  BenchmarkScores,
  CompletedFixtureResult,
  Domain,
  FixtureResult,
  GroundTruth,
  GroundTruthFinding,
  ParsedAgentOutput,
} from "./types.ts";

const CANONICAL_DOMAIN_PROJECTION: Record<Domain, CanonicalDomain> = {
  plan: "plan",
  code: "code",
  analysis: "analysis",
  bug: "analysis",
  task: "analysis",
};

function canonicalVerdict(value: string | undefined): HarshCriticVerdict {
  return value === "REJECT" ||
    value === "REVISE" ||
    value === "ACCEPT" ||
    value === "ACCEPT-WITH-RESERVATIONS"
    ? value
    : "REJECT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDomain(value: unknown): value is Domain {
  return (
    value === "plan" ||
    value === "code" ||
    value === "analysis" ||
    value === "bug" ||
    value === "task"
  );
}

function validateFinding(value: unknown, index: number): GroundTruthFinding {
  if (!isRecord(value))
    throw new Error(`Ground truth finding ${index} must be an object`);
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error(`Ground truth finding ${index} has no id`);
  }
  if (
    !Array.isArray(value.keywords) ||
    value.keywords.some((keyword) => typeof keyword !== "string")
  ) {
    throw new Error(`Ground truth finding ${index} has invalid keywords`);
  }
  if (value.keywords.length === 0) {
    throw new Error(
      `Ground truth finding ${index} must have at least one keyword`,
    );
  }
  const severity = value.severity;
  if (severity !== "CRITICAL" && severity !== "MAJOR" && severity !== "MINOR") {
    throw new Error(`Ground truth finding ${index} has invalid severity`);
  }
  const category = value.category;
  if (
    category !== "finding" &&
    category !== "missing" &&
    category !== "perspective"
  ) {
    throw new Error(`Ground truth finding ${index} has invalid category`);
  }
  const perspective = value.perspective;
  if (
    perspective !== undefined &&
    perspective !== "security" &&
    perspective !== "new-hire" &&
    perspective !== "ops"
  ) {
    throw new Error(`Ground truth finding ${index} has invalid perspective`);
  }
  if (
    typeof value.summary !== "string" ||
    typeof value.explanation !== "string"
  ) {
    throw new Error(`Ground truth finding ${index} has invalid text fields`);
  }
  if (value.location !== undefined && typeof value.location !== "string") {
    throw new Error(`Ground truth finding ${index} has invalid location`);
  }
  return {
    id: value.id,
    severity,
    category,
    perspective,
    summary: value.summary,
    keywords: value.keywords.map((keyword) => String(keyword)),
    location: value.location,
    explanation: value.explanation,
  };
}

export function validateSharedGroundTruth(value: unknown): GroundTruth {
  if (!isRecord(value)) throw new Error("Ground truth must be an object");
  if (typeof value.fixtureId !== "string" || value.fixtureId.length === 0) {
    throw new Error("Ground truth fixtureId is required");
  }
  if (typeof value.fixturePath !== "string" || value.fixturePath.length === 0) {
    throw new Error("Ground truth fixturePath is required");
  }
  if (!isDomain(value.domain))
    throw new Error(`Unsupported ground truth domain: ${String(value.domain)}`);
  if (!Array.isArray(value.findings))
    throw new Error("Ground truth findings must be an array");
  if (typeof value.isCleanBaseline !== "boolean") {
    throw new Error("Ground truth isCleanBaseline must be boolean");
  }
  const findings = value.findings.map(validateFinding);
  const findingIds = new Set<string>();
  for (const finding of findings) {
    if (findingIds.has(finding.id)) {
      throw new Error(`Duplicate ground truth finding id: ${finding.id}`);
    }
    findingIds.add(finding.id);
  }
  return {
    fixtureId: value.fixtureId,
    fixturePath: value.fixturePath,
    domain: value.domain,
    expectedVerdict:
      typeof value.expectedVerdict === "string"
        ? value.expectedVerdict
        : undefined,
    findings,
    isCleanBaseline: value.isCleanBaseline,
  };
}

export function normalizeForSharedScoring(
  groundTruth: GroundTruth,
): CanonicalGroundTruth {
  const validated = validateSharedGroundTruth(groundTruth);
  return {
    fixtureId: validated.fixtureId,
    fixturePath: validated.fixturePath,
    domain: CANONICAL_DOMAIN_PROJECTION[validated.domain],
    // The canonical scorer does not read this field. Keep non-canonical placeholders private.
    expectedVerdict: canonicalVerdict(validated.expectedVerdict),
    findings: validated.findings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      category: finding.category,
      perspective: finding.perspective,
      summary: finding.summary,
      keywords: [...finding.keywords],
      location: finding.location,
      explanation: finding.explanation,
    })),
    isCleanBaseline: validated.isCleanBaseline,
  };
}

export function scoreFixtureShared(
  parsedOutput: ParsedAgentOutput,
  groundTruth: GroundTruth,
): BenchmarkScores {
  return scoreCanonicalFixture(
    parsedOutput,
    normalizeForSharedScoring(groundTruth),
  );
}

export function matchFindingsShared(
  parsedOutput: ParsedAgentOutput,
  groundTruth: GroundTruth,
): { matchedIds: string[]; missedIds: string[]; spuriousTexts: string[] } {
  const result = matchCanonicalFindings(
    parsedOutput,
    normalizeForSharedScoring(groundTruth),
  );
  return {
    matchedIds: result.matchedIds,
    missedIds: result.missedIds,
    spuriousTexts: result.spuriousTexts,
  };
}

function toCanonicalResult(
  result: CompletedFixtureResult,
): CanonicalFixtureResult {
  return {
    fixtureId: result.fixtureId,
    domain: CANONICAL_DOMAIN_PROJECTION[result.domain],
    agentType: "critic" satisfies CanonicalAgentType,
    parsedOutput: result.parsedOutput,
    scores: result.scores,
    matchedFindings: [...result.matchedFindings],
    missedFindings: [...result.missedFindings],
    spuriousFindings: [...result.spuriousFindings],
  };
}

export function aggregateScoresUnknownCapable(
  results: FixtureResult[],
): BenchmarkScores | null {
  const completed = results.filter(
    (result): result is CompletedFixtureResult =>
      result.completion === "completed",
  );
  if (completed.length === 0) return null;
  return aggregateCanonicalScores(completed.map(toCanonicalResult));
}
