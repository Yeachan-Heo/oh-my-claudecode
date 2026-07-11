import { createHash } from "crypto";
import { closeSync, constants, existsSync, mkdirSync, openSync, readlinkSync, realpathSync, writeFileSync } from "fs";
import { basename, dirname, isAbsolute, join, relative } from "path";
import { getOmcRoot } from "../../lib/worktree-paths.js";
import { createArtifactDescriptorFromPath, writeTextArtifact, type ArtifactDescriptor } from "../../shared/artifact-descriptor.js";
import type {
  MergeReadinessDimension,
  MergeReadinessEvidence,
  MergeReadinessMCQAnswer,
  MergeReadinessMCQQuestion,
  MergeReadinessResult,
  MergeReadinessRound,
} from "./types.js";

export interface MergeReadinessQuestion {
  question: string;
  expectedAnswerFocus?: string;
}

export interface MergeReadinessArtifactInput {
  slug: string;
  why: string;
  whatChanged: string;
  tradeoffs: string;
  risksConsidered: string;
  teamUnderstanding: string;
  questions: MergeReadinessQuestion[];
  result: Exclude<MergeReadinessResult, "pending">;
  createdAt?: string;
}

export interface RuntimeMergeReadinessArtifactInput {
  slug: string;
  changeSummary: string;
  evidence: MergeReadinessEvidence;
  /** @deprecated retained for backward-compatible callers; MCQ path uses questions/answers. */
  rounds: MergeReadinessRound[];
  result: MergeReadinessResult;
  readinessScore: number;
  dimensionScores: Partial<Record<MergeReadinessDimension, number>>;
  createdAt?: string;
  // AI-generated explanation narrative (5 sections).
  why?: string;
  whatChanged?: string;
  tradeoffs?: string;
  risksConsidered?: string;
  teamUnderstanding?: string;
  // Objective MCQ quiz.
  questions?: MergeReadinessMCQQuestion[];
  answers?: MergeReadinessMCQAnswer[];
  /** Correctness threshold for the active profile, in [0, 1]. */
  threshold?: number;
  /** Required dimensions for the active profile. */
  requiredDimensions?: MergeReadinessDimension[];
  /** Next unanswered MCQ (shown by the Stop-hook when the gate is not yet passed). */
  pendingQuestion?: MergeReadinessMCQQuestion;
  overrideReason?: string;
  /** Invoking session id; included in the artifact filename to avoid cross-session collisions. */
  sessionId?: string;
}

export function getMergeReadinessArtifactPath(
  directory: string,
  slug: string,
  createdAt: Date = new Date(),
  sessionId?: string,
): string {
  const timestamp = createdAt
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  // Sanitize slug: strip path separators / traversal so a caller slug cannot escape the dir.
  const safeSlug = slug.replace(/[^a-zA-Z0-9-_]/g, "-").replace(/^-+|-+$/g, "") || "change";
  // Hash(sessionId+timestamp) suffix: collision-resistant + does not leak the raw session id.
  const suffix = sessionId ? "-" + createHash("sha256").update(sessionId + timestamp).digest("hex").slice(0, 8) : "";
  return join(getOmcRoot(directory), "artifacts", "merge-readiness", `${timestamp}${suffix}-${safeSlug}.md`);
}

export function formatMergeReadinessArtifact(
  input: MergeReadinessArtifactInput,
): string {
  const questions = input.questions.length > 0
    ? input.questions
      .map((question, index) => {
        const focus = question.expectedAnswerFocus
          ? `\n   - Expected answer focus: ${question.expectedAnswerFocus}`
          : "";
        return `${index + 1}. ${question.question}${focus}`;
      })
      .join("\n")
    : "_No questions recorded._";

  return [
    "# Merge Readiness Report",
    "",
    "## Why",
    "",
    input.why,
    "",
    "## What Changed",
    "",
    input.whatChanged,
    "",
    "## Tradeoffs",
    "",
    input.tradeoffs,
    "",
    "## Risks Considered",
    "",
    input.risksConsidered,
    "",
    "## Team Understanding",
    "",
    input.teamUnderstanding,
    "",
    "## Human Quiz",
    "",
    questions,
    "",
    "## Result",
    "",
    input.result,
    "",
    "Passing this gate means the human can explain the change. It does not approve merge, replace tests, replace review, or accept risk on behalf of maintainers.",
    "",
  ].join("\n");
}

const MERGE_BOUNDARY_STATEMENT =
  "Passing means the human can explain the change. It does not approve merge, replace tests, replace review, or accept risk.";

function renderMCQTranscript(
  questions: MergeReadinessMCQQuestion[],
  answers: MergeReadinessMCQAnswer[],
  result: MergeReadinessResult,
): string {
  if (questions.length === 0) return "_No quiz questions recorded yet._";
  const answersByQuestion = new Map(answers.map((a) => [a.questionId, a]));
  const revealAll = result === "pass" || result === "paused";
  const revealAnswered = result === "overridden" || result === "cancelled";
  return questions
    .map((question, index) => {
      const answer = answersByQuestion.get(question.id);
      const optionLines = question.options.map((option) => {
        const marks: string[] = [];
        if ((revealAll || (revealAnswered && answer)) && option.id === question.correctOptionId) marks.push("correct");
        if (answer && option.id === answer.selectedOptionId) marks.push("selected");
        const suffix = marks.length > 0 ? ` _(${marks.join(", ")})_` : "";
        return `- [${option.id}] ${option.text}${suffix}`;
      });
      const isCorrectLine = answer && (revealAll || revealAnswered)
        ? `Correct: ${answer.isCorrect ? "yes" : "no"}`
        : "_Not answered yet._";
      return [
        `### ${index + 1}. [${question.dimension}] ${question.stem}`,
        "",
        ...optionLines,
        "",
        isCorrectLine,
      ].join("\n");
    })
    .join("\n\n");
}

export function formatRuntimeMergeReadinessArtifact(
  input: RuntimeMergeReadinessArtifactInput,
): string {
  const changedFiles = input.evidence.changedFiles.length > 0
    ? input.evidence.changedFiles.map((file) => `- ${file}`).join("\n")
    : "_No changed files detected._";
  const artifacts = input.evidence.sourceArtifacts.length > 0
    ? input.evidence.sourceArtifacts.map((file) => `- ${file}`).join("\n")
    : "_No source artifacts found._";
  const missing = input.evidence.missingEvidence.length > 0
    ? input.evidence.missingEvidence.map((item) => `- ${item}`).join("\n")
    : "_No missing evidence recorded._";
  const questions = input.questions ?? [];
  const answers = input.answers ?? [];
  const mcqTranscript = renderMCQTranscript(questions, answers, input.result);
  const dimensionCoverage = input.requiredDimensions && input.requiredDimensions.length > 0
    ? input.requiredDimensions
      .map((dim) => `- ${dim}: ${Math.round((input.dimensionScores[dim] ?? 0) * 100)}%`)
      .join("\n")
    : (Object.entries(input.dimensionScores)
      .map(([dimension, score]) => `- ${dimension}: ${Math.round((score ?? 0) * 100)}%`)
      .join("\n") || "_No scored dimensions yet._");
  const thresholdPct = Math.round((input.threshold ?? 0) * 100);
  const scorePct = Math.round(input.readinessScore * 100);
  const pendingLine = input.pendingQuestion
    ? `- [${input.pendingQuestion.dimension}] ${input.pendingQuestion.stem}`
    : "_No pending question._";

  return [
    "# Merge Readiness Report",
    "",
    "## Why",
    "",
    input.why && input.why.trim().length > 0 ? input.why.trim() : "_Not yet generated._",
    "",
    "## What Changed",
    "",
    input.whatChanged && input.whatChanged.trim().length > 0 ? input.whatChanged.trim() : "_Not yet generated._",
    "",
    "## Tradeoffs",
    "",
    input.tradeoffs && input.tradeoffs.trim().length > 0 ? input.tradeoffs.trim() : "_Not yet generated._",
    "",
    "## Risks Considered",
    "",
    input.risksConsidered && input.risksConsidered.trim().length > 0 ? input.risksConsidered.trim() : "_Not yet generated._",
    "",
    "## Team Understanding",
    "",
    input.teamUnderstanding && input.teamUnderstanding.trim().length > 0 ? input.teamUnderstanding.trim() : "_Not yet generated._",
    "",
    "## Change Summary",
    "",
    input.changeSummary || "_No change summary provided._",
    "",
    "## Evidence Collected",
    "",
    "### Changed Files",
    "",
    changedFiles,
    "",
    "### Git Status",
    "",
    input.evidence.status || "_No git status output._",
    "",
    "### Diff Stat",
    "",
    input.evidence.diffStat || "_No diff stat output._",
    "",
    "### Source Artifacts",
    "",
    artifacts,
    "",
    "### Missing Evidence",
    "",
    missing,
    "",
    "## Human Explainability Quiz",
    "",
    "This quiz checks whether the human can explain the change. It does not replace tests, review, or maintainer approval.",
    "",
    mcqTranscript,
    "",
    "## Pending Question",
    "",
    pendingLine,
    "",
    "## Readiness",
    "",
    `Result: ${input.result}`,
    input.overrideReason ? `\nOverride reason: ${input.overrideReason}` : "",
    "",
    `Correctness rate: ${scorePct}% / threshold ${thresholdPct}%`,
    "",
    "Dimension coverage:",
    "",
    dimensionCoverage,
    "",
    "## Merge Boundary",
    "",
    MERGE_BOUNDARY_STATEMENT,
    "",
  ].join("\n");
}

export function writeMergeReadinessArtifact(
  directory: string,
  input: MergeReadinessArtifactInput,
): ArtifactDescriptor {
  const createdAt = input.createdAt ? new Date(input.createdAt) : new Date();
  return writeTextArtifact({
    path: getMergeReadinessArtifactPath(directory, input.slug, createdAt),
    content: formatMergeReadinessArtifact(input),
    kind: "merge-readiness",
    producer: { system: "omc", component: "merge-readiness" },
    retention: "persistent",
    createdAt: createdAt.toISOString(),
  });
}

export function writeRuntimeMergeReadinessArtifact(
  directory: string,
  input: RuntimeMergeReadinessArtifactInput,
  artifactPath?: string,
): ArtifactDescriptor {
  const createdAt = input.createdAt ? new Date(input.createdAt) : new Date();
  const path = artifactPath ?? getMergeReadinessArtifactPath(directory, input.slug, createdAt, input.sessionId);
  const content = formatRuntimeMergeReadinessArtifact(input);
  const descriptor = { kind: "merge-readiness" as const, producer: { system: "omc" as const, component: "merge-readiness-runtime" }, retention: "persistent" as const, createdAt: createdAt.toISOString() };
  mkdirSync(dirname(path), { recursive: true });
  const root = realpathSync(getOmcRoot(directory));
  // Handle-relative containment (Linux/macOS): open the artifact dir with O_NOFOLLOW|O_DIRECTORY,
  // readlink /proc/self/fd (or /dev/fd) to verify the open fd resolves under the OMC root, then
  // write the file RELATIVE to that fd. The fd is fixed once opened, so an ancestor swap after the
  // check cannot redirect the write -> operation-time containment invariant.
  if (process.platform !== "win32") {
    const fdBase = existsSync("/proc/self/fd") ? "/proc/self/fd" : "/dev/fd";
    let dirFd: number | undefined;
    try {
      dirFd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const resolved = readlinkSync(`${fdBase}/${dirFd}`);
      const rel = relative(root, resolved);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        closeSync(dirFd);
        throw new Error("merge-readiness artifact dir escapes the OMC root (possible symlink tampering)");
      }
      writeFileSync(`${fdBase}/${dirFd}/${basename(path)}`, content, { encoding: "utf-8", mode: 0o600 });
      closeSync(dirFd);
      return createArtifactDescriptorFromPath(path, descriptor);
    } catch (e) {
      if (dirFd !== undefined) { try { closeSync(dirFd); } catch { /* best-effort */ } }
      throw e;
    }
  }
  // Windows fallback: realpath containment (ancestor TOCTOU window remains; documented limitation).
  let resolvedDir: string;
  try { resolvedDir = realpathSync(dirname(path)); } catch { resolvedDir = dirname(path); }
  const rel2 = relative(root, resolvedDir);
  if (rel2.startsWith("..") || isAbsolute(rel2)) {
    throw new Error("merge-readiness artifact path escapes the OMC root (possible symlink tampering)");
  }
  return writeTextArtifact({ path, content, ...descriptor });
}

export const getUnderstandingGateArtifactPath = getMergeReadinessArtifactPath;
export const formatUnderstandingGateArtifact = formatMergeReadinessArtifact;
export const writeUnderstandingGateArtifact = writeMergeReadinessArtifact;
