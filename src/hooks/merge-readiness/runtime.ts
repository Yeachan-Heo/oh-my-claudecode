import { execFileSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { join, relative } from "path";
import { readModeState, writeModeState } from "../../lib/mode-state-io.js";
import { getOmcRoot, resolveToWorktreeRoot } from "../../lib/worktree-paths.js";
import {
  computeCorrectnessRate,
  hasRequiredDimensionCoverage,
  isCorrectnessPass,
  profileMaxRounds,
  profileThreshold,
  requiredDimensionsForProfile,
  scoreMCQResponse,
  type MergeReadinessMCQAnswer,
  type MergeReadinessMCQQuestion,
} from "./mcq.js";
import type {
  MergeReadinessDimension,
  MergeReadinessEvidence,
  MergeReadinessProfile,
  MergeReadinessPromptResult,
  MergeReadinessResult,
  MergeReadinessState,
} from "./types.js";

const MODE = "merge-readiness";

export function parseMergeReadinessProfile(promptText: string): MergeReadinessProfile {
  if (/\B--deep\b/i.test(promptText)) return "deep";
  if (/\B--quick\b/i.test(promptText)) return "quick";
  return "standard";
}

export function slugifyMergeReadiness(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "change";
}

function runGit(directory: string, args: string[]): { stdout: string; error?: string } {
  try {
    const stdout = execFileSync("git", args, {
      cwd: directory,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: stdout.trim() };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { status?: number; stderr?: string };
    const timedOut = err?.code === "ETIMEDOUT" || /timed out/i.test(String(err?.message || ""));
    const stderr = typeof err?.stderr === "string" ? err.stderr.trim().slice(0, 200) : "";
    const exit = err?.status;
    const error = timedOut
      ? `git ${args[0]} timed out (>10s)`
      : `git ${args[0]} failed (exit ${exit ?? "?"})${stderr ? ": " + stderr : ""}`;
    return { stdout: "", error };
  }
}

function listArtifactFiles(directory: string): string[] {
  const root = getOmcRoot(directory);
  const candidates = ["plans", "artifacts", "logs"]
    .map((segment) => join(root, segment))
    .filter((path) => existsSync(path));
  const found: string[] = [];
  for (const candidate of candidates) {
    const stack = [candidate];
    while (stack.length > 0 && found.length < 40) {
      const current = stack.pop();
      if (!current) continue;
      try {
        const entries = readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
          const full = join(current, entry.name);
          if (entry.isDirectory()) {
            stack.push(full);
          } else if (entry.isFile() && /\.(md|json|txt|log)$/i.test(entry.name)) {
            const relativePath = relative(root, full).replace(/\\/g, "/");
            if (!relativePath.startsWith("artifacts/merge-readiness/") && !relativePath.includes("merge-readiness-state")) {
              found.push(relativePath);
            }
          }
        }
      } catch {
        continue;
      }
    }
  }
  return found.sort();
}

export function collectMergeReadinessEvidence(directory: string, baseRef?: string): MergeReadinessEvidence {
  const worktree = resolveToWorktreeRoot(directory);
  const gitErrors: string[] = [];
  const git = (args: string[]): string => {
    const r = runGit(worktree, args);
    if (r.error) gitErrors.push(r.error);
    return r.stdout;
  };
  const changedFiles = git(["diff", "--name-only", "HEAD"]).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const stagedFiles = git(["diff", "--cached", "--name-only"]).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const untrackedFiles = git(["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const resolvedBase = baseRef || git(["rev-parse", "--abbrev-ref", "@{upstream}"]) || git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const committedBase = resolvedBase ? git(["merge-base", resolvedBase, "HEAD"]) : "";
  const committedFiles = /^[0-9a-f]{7,40}$/.test(committedBase || "")
    ? git(["diff", "--name-only", committedBase + "...HEAD"]).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    : [];
  const trackedChangedFiles = Array.from(new Set([...changedFiles, ...stagedFiles, ...committedFiles])).sort();
  const status = git(["status", "--short"]);
  const diffStat = git(["diff", "--stat", "HEAD"]) || (committedBase ? git(["diff", "--stat", committedBase + "...HEAD"]) : "") || git(["diff", "--cached", "--stat"]);
  const sourceArtifacts = listArtifactFiles(worktree);
  const evidenceText = sourceArtifacts.join("\n").toLowerCase();
  const testEvidence = sourceArtifacts.filter((file) => /test|spec|qa|verify|validation/i.test(file));
  const reviewEvidence = sourceArtifacts.filter((file) => /review|risk|security|readiness|verdict/i.test(file));
  const missingEvidence: string[] = [];
  if (trackedChangedFiles.length === 0 && !status) {
    missingEvidence.push("No changed files or git status evidence were detected.");
  }
  if (!diffStat) {
    missingEvidence.push("No diff stat was detected for the current worktree.");
  }
  if (!/test|spec|qa|verify|validation/.test(evidenceText)) {
    missingEvidence.push("No test or verification artifact was detected under .omc.");
  }
  if (!/review|risk|security|verdict/.test(evidenceText)) {
    missingEvidence.push("No review or risk artifact was detected under .omc.");
  }
  for (const gerr of gitErrors) missingEvidence.push(gerr);
  return { changedFiles: trackedChangedFiles, untrackedFiles, status, diffStat, sourceArtifacts, testEvidence, reviewEvidence, missingEvidence };
}

function extractChangeSummary(promptText: string): string {
  return promptText
    .replace(/^\s*\/(?:oh-my-claudecode:|omc:)?merge-readiness\b/i, "")
    .replace(/\B--(?:quick|standard|deep|from-diff|from-artifacts)\b/gi, "")
    .trim();
}

/** True when the collected evidence lacks the minimal diff/change signal needed to quiz on. */
function hasMinimalEvidence(evidence: MergeReadinessEvidence): boolean {
  return evidence.changedFiles.length > 0 || Boolean(evidence.status) || Boolean(evidence.diffStat) || evidence.sourceArtifacts.length > 0;
}

function parseMergeReadinessSourceMode(promptText: string): { mode?: "diff" | "artifacts"; error?: string } {
  const fromDiff = /(?:^|\s)--from-diff(?=\s|$)/i.test(promptText);
  const fromArtifacts = /(?:^|\s)--from-artifacts(?=\s|$)/i.test(promptText);
  if (fromDiff && fromArtifacts) return { error: "--from-diff and --from-artifacts cannot be used together." };
  if (fromDiff) return { mode: "diff" };
  if (fromArtifacts) return { mode: "artifacts" };
  return {};
}

function hasMinimalEvidenceForMode(evidence: MergeReadinessEvidence, mode: "diff" | "artifacts" | undefined): boolean {
  // Status and untracked files are not a diff: --from-diff requires Git to
  // report a tracked working-tree, staged, or committed change.
  const hasDiff = evidence.changedFiles.length > 0 || Boolean(evidence.diffStat);
  if (mode === "diff") return hasDiff;
  if (mode === "artifacts") return evidence.sourceArtifacts.length > 0;
  return hasDiff || evidence.sourceArtifacts.length > 0;
}

function pickNextQuestion(state: MergeReadinessState): MergeReadinessMCQQuestion | undefined {
  if (state.questions.length === 0) return undefined;
  const answered = new Set(state.answers.map((a) => a.questionId));
  const unanswered = state.questions.filter((q) => !answered.has(q.id));
  if (unanswered.length === 0) return undefined;
  // Prefer required dimensions, then any remaining unanswered question.
  const requiredSet = new Set(state.required_dimensions);
  const requiredNext = unanswered.find((q) => requiredSet.has(q.dimension));
  return requiredNext ?? unanswered[0];
}

/**
 * Recompute correctness rate + per-dimension coverage from recorded MCQ answers.
 * The readiness score is the objective correctness rate (not a heuristic).
 */
function recomputeReadiness(state: MergeReadinessState): void {
  const scores: Partial<Record<MergeReadinessDimension, number>> = {};
  for (const dimension of state.required_dimensions) {
    const dimensionAnswers = state.answers.filter((a) => {
      const question = state.questions.find((q) => q.id === a.questionId);
      return question?.dimension === dimension;
    });
    if (dimensionAnswers.length > 0) {
      const correct = dimensionAnswers.filter((a) => a.isCorrect).length;
      scores[dimension] = correct / dimensionAnswers.length;
    }
  }
  state.dimension_scores = scores;
  state.readiness_score = computeCorrectnessRate(state.answers);
}

function allRequiredAnswered(state: MergeReadinessState): boolean {
  if (state.questions.length === 0) return false;
  const answered = new Set(state.answers.map((a) => a.questionId));
  // Every required dimension must have at least one answered MCQ.
  const answeredDimensions = new Set(
    state.answers
      .map((a) => state.questions.find((q) => q.id === a.questionId)?.dimension)
      .filter((d): d is MergeReadinessDimension => Boolean(d)),
  );
  const coverageOk = state.required_dimensions.every((d) => answeredDimensions.has(d));
  // And every generated question should be answered (no half-finished quiz),
  // unless the profile max rounds caps the count below questions.length.
  const cap = Math.min(state.questions.length, state.max_rounds);
  const answeredInRange = state.answers.filter((a) => answered.has(a.questionId)).length;
  return coverageOk && answeredInRange >= cap;
}

/**
 * Finalize the gate result from recorded answers + evidence.
 *   pass    = all required answered, correctness rate >= threshold, required dims covered -> active=false (release)
 *   paused  = all required answered but correctness rate below threshold -> stays active (gate remains active until re-run + pass)
 *   blocked = missing minimal evidence (no diff/change signal) -> stays active
 * v1 is advisory: checkMergeReadiness is not wired to the Stop hook, so an active gate does not block the session; active gates remain active until pass/override/cancel.
 */
function finalizeIfReady(state: MergeReadinessState, now: string): void {
  recomputeReadiness(state);

  if (!hasMinimalEvidence(state.evidence)) {
    state.phase = "complete";
    state.result = "blocked";
    state.completed_at = now;
    delete state.pending_question;
    return;
  }

  if (!allRequiredAnswered(state)) {
    // Quiz not finished yet; keep the gate active and pending.
    return;
  }

  const rate = state.readiness_score;
  const coverageOk = hasRequiredDimensionCoverage(
    state.answers,
    state.questions,
    state.required_dimensions,
  );

  if (isCorrectnessPass(rate, state.threshold) && coverageOk) {
    state.active = false;
    state.phase = "complete";
    state.result = "pass";
    state.completed_at = now;
    delete state.pending_question;
    return;
  }

  // All required answered but below threshold or missing coverage: paused.
  // Keep active=true so the Stop-hook keeps blocking until the operator
  // re-runs /merge-readiness and passes.
  state.phase = "complete";
  state.result = "paused";
  state.completed_at = now;
  delete state.pending_question;
}

export function readMergeReadinessState(directory: string, sessionId?: string): MergeReadinessState | null {
  return readModeState<MergeReadinessState>(MODE, directory, sessionId) ?? null;
}

export function writeMergeReadinessState(
  directory: string,
  state: MergeReadinessState,
  sessionId?: string,
): void {
  writeModeState(MODE, state as unknown as Record<string, unknown>, directory, sessionId);
}

/**
 * Seed initial merge-readiness state. Called by the bridge on `/merge-readiness`
 * and by the autopilot adapter's onEnter. Collects evidence, picks the profile
 * threshold/maxRounds/required dims from mcq.ts, and marks the state as
 * awaiting AI-generated content (doc + MCQs).
 */
export function createInitialMergeReadinessState(
  directory: string,
  promptText: string,
  sessionId?: string,
  baseRef?: string,
): MergeReadinessState {
  const now = new Date().toISOString();
  const profile = parseMergeReadinessProfile(promptText);
  const changeSummary = extractChangeSummary(promptText);
  const unsupportedFromPr = /\B--from-pr\b/i.test(promptText);
  const sourceModeResult = parseMergeReadinessSourceMode(promptText);
  const sourceMode = sourceModeResult.mode;
  const evidence = collectMergeReadinessEvidence(directory, baseRef);
  const missingEvidence = unsupportedFromPr || Boolean(sourceModeResult.error) || !hasMinimalEvidenceForMode(evidence, sourceMode);
  const state: MergeReadinessState = {
    active: true,
    session_id: sessionId,
    current_phase: MODE,
    phase: "content",
    profile,
    threshold: profileThreshold(profile),
    max_rounds: profileMaxRounds(profile),
    required_dimensions: requiredDimensionsForProfile(profile),
    rounds: [],
    questions: [],
    answers: [],
    awaiting_content: !unsupportedFromPr && !sourceModeResult.error,
    evidence,
    readiness_score: 0,
    dimension_scores: {},
    result: missingEvidence ? "blocked" : "pending",
    why: "",
    whatChanged: "",
    tradeoffs: "",
    risksConsidered: "",
    teamUnderstanding: "",
    started_at: now,
    updated_at: now,
    change_summary: changeSummary,
    slug: slugifyMergeReadiness(changeSummary || "merge-readiness"),
    source_mode: sourceMode,
  };
  if (missingEvidence) {
    state.validation_errors = unsupportedFromPr
      ? ["--from-pr is unsupported: merge-readiness uses local git and .omc evidence only."]
      : sourceModeResult.error
        ? [sourceModeResult.error]
        : ["No minimal evidence for the selected source mode was detected; produce it before running /merge-readiness."];
  }
  writeMergeReadinessState(directory, state, sessionId);
  return state;
}

/**
 * AI writes the generated explanation doc (5 sections) + MCQs into state.
 * Called after the AI has read the evidence and produced narrative + questions.
 * Each question must carry correctOptionId so the runtime can score objectively.
 */
export function setMergeReadinessContent(
  directory: string,
  content: {
    why: string;
    whatChanged: string;
    tradeoffs: string;
    risksConsidered: string;
    teamUnderstanding: string;
    questions: MergeReadinessMCQQuestion[];
  },
  sessionId?: string,
): MergeReadinessState | null {
  const workingDir = resolveToWorktreeRoot(directory);
  const state = readMergeReadinessState(workingDir, sessionId);
  if (!state?.active) return state ?? null;
  const now = new Date().toISOString();
  // Do not re-arm blocked or paused states: a blocked state lacks minimal
  // evidence, and a paused state failed the quiz. Both require a fresh
  // merge_readiness_start (which re-collects evidence) rather than a content
  // re-submit. The refusal preserves the prior attempt's state until the
  // operator re-runs start, which replaces it (v1 does not retain attempt history).
  if (state.result === "blocked" || state.result === "paused") {
    state.validation_errors ??= [state.result === "blocked"
      ? "Blocked: no minimal evidence for the selected source mode. Produce it before submitting content."
      : "Paused: the quiz was not passed. Re-run merge_readiness_start to collect fresh evidence and retry (re-starting replaces the prior attempt's state)."];
    if (state.result === "blocked") {
      state.awaiting_content = true;
      state.phase = "content";
    }
    state.updated_at = now;
    writeMergeReadinessState(workingDir, state, sessionId);
    return state;
  }
  const errors = validateMergeReadinessContent(content, state);
  if (errors.length > 0) {
    state.validation_errors = errors;
    state.awaiting_content = true;
    state.phase = "content";
    state.answers = [];
    state.readiness_score = 0;
    state.dimension_scores = {};
    state.result = "pending";
    delete state.pending_question;
    delete state.completed_at;
    delete state.override_reason;
    state.updated_at = now;
    writeMergeReadinessState(workingDir, state, sessionId);
    return state;
  }
  state.why = content.why.trim();
  state.whatChanged = content.whatChanged.trim();
  state.tradeoffs = content.tradeoffs.trim();
  state.risksConsidered = content.risksConsidered.trim();
  state.teamUnderstanding = content.teamUnderstanding.trim();
  // Cap generated questions at the profile max rounds.
  state.questions = content.questions.slice(0, state.max_rounds);
  // Re-submitted content starts a fresh quiz: clear prior answers, score, and terminal result.
  state.answers = [];
  state.readiness_score = 0;
  state.dimension_scores = {};
  state.result = "pending";
  delete state.completed_at;
  delete state.override_reason;
  delete state.validation_errors;
  state.awaiting_content = false;
  state.phase = "questioning";
  state.updated_at = now;
  state.pending_question = pickNextQuestion(state);
  writeMergeReadinessState(workingDir, state, sessionId);
  return state;
}

/**
 * Record one MCQ answer (objective scoring via scoreMCQResponse), append it,
 * and finalize the gate if all required questions are answered.
 */
export function recordMergeReadinessMCQAnswer(
  directory: string,
  questionId: string,
  selectedOptionId: string,
  sessionId?: string,
): MergeReadinessState | null {
  const workingDir = resolveToWorktreeRoot(directory);
  const state = readMergeReadinessState(workingDir, sessionId);
  if (!state?.active) return state ?? null;
  if (state.awaiting_content || state.phase !== "questioning") return null;
  const question = state.questions.find((q) => q.id === questionId);
  if (!question || state.pending_question?.id !== questionId) return null;
  const normalizedOptionId = selectedOptionId.trim();
  if (!question.options.some((option) => option.id === normalizedOptionId)) return null;
  const now = new Date().toISOString();
  const isCorrect = scoreMCQResponse(question, normalizedOptionId);
  // Replace any prior answer to the same question (idempotent re-answer).
  const filtered = state.answers.filter((a) => a.questionId !== questionId);
  const answer: MergeReadinessMCQAnswer = {
    questionId,
    selectedOptionId: normalizedOptionId,
    isCorrect,
    answeredAt: now,
  };
  state.answers = [...filtered, answer];
  state.updated_at = now;
  delete state.pending_question;
  finalizeIfReady(state, now);
  if (state.active && state.phase === "questioning") {
    state.pending_question = pickNextQuestion(state);
  } else {
    delete state.pending_question;
  }
  writeMergeReadinessState(workingDir, state, sessionId);
  return state;
}

/** Correlate only a marked native AskUserQuestion result to the current MCQ. */
export function recordMergeReadinessAskUserQuestionResult(
  directory: string,
  toolInput: unknown,
  toolOutput: unknown,
  sessionId?: string,
): MergeReadinessState | null {
  const state = readMergeReadinessState(resolveToWorktreeRoot(directory), sessionId);
  const pending = state?.pending_question;
  if (!state?.active || !pending) return state ?? null;
  const inputText = JSON.stringify(toolInput ?? "");
  if (!inputText.includes(`[MERGE READINESS:${pending.id}]`)) return state;
  const outputText = typeof toolOutput === "string" ? toolOutput : JSON.stringify(toolOutput ?? "");
  const selected = pending.options.filter((option) =>
    new RegExp(`(?:^|[\\s\\[\"'])${option.id.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}(?:$|[\\s\\]\"',:])`).test(outputText),
  );
  return selected.length === 1
    ? recordMergeReadinessMCQAnswer(directory, pending.id, selected[0].id, sessionId)
    : state;
}

export function validateMergeReadinessContent(
  content: { why: string; whatChanged: string; tradeoffs: string; risksConsidered: string; teamUnderstanding: string; questions: MergeReadinessMCQQuestion[] },
  state: Pick<MergeReadinessState, "required_dimensions" | "max_rounds">,
): string[] {
  const errors: string[] = [];
  const sections: Array<[string, string]> = [["why", content.why], ["whatChanged", content.whatChanged], ["tradeoffs", content.tradeoffs], ["risksConsidered", content.risksConsidered], ["teamUnderstanding", content.teamUnderstanding]];
  for (const [name, value] of sections) if (!value?.trim()) errors.push(`Narrative section '${name}' is required.`);
  if (!Array.isArray(content.questions) || content.questions.length < state.required_dimensions.length) errors.push("Questions must cover every required dimension.");
  if (content.questions.length > state.max_rounds) errors.push(`Questions exceed the ${state.max_rounds}-question profile limit.`);
  const ids = new Set<string>();
  const dimensions = new Set<MergeReadinessDimension>();
  for (const question of content.questions ?? []) {
    if (!question.id?.trim() || ids.has(question.id)) errors.push("Question ids must be non-empty and unique.");
    ids.add(question.id);
    dimensions.add(question.dimension);
    if (!question.stem?.trim()) errors.push(`Question '${question.id}' needs a stem.`);
    if (!Array.isArray(question.options) || question.options.length < 2) errors.push(`Question '${question.id}' needs at least two options.`);
    const optionIds = new Set(question.options?.map((option) => option.id) ?? []);
    if (optionIds.size !== (question.options?.length ?? 0) || [...optionIds].some((id) => !id?.trim())) errors.push(`Question '${question.id}' has invalid option ids.`);
    if (!optionIds.has(question.correctOptionId)) errors.push(`Question '${question.id}' correctOptionId must identify an option.`);
  }
  for (const dimension of state.required_dimensions) if (!dimensions.has(dimension)) errors.push(`No question covers required dimension '${dimension}'.`);
  return errors;
}

export function overrideMergeReadiness(directory: string, reason: string, sessionId?: string): MergeReadinessState | null {
  const workingDir = resolveToWorktreeRoot(directory);
  const state = readMergeReadinessState(workingDir, sessionId);
  if (!state?.active || !reason.trim()) return state ?? null;
  if (state.result === "blocked") {
    state.validation_errors ??= ["Blocked: resolve the validation errors before overriding."];
    writeMergeReadinessState(workingDir, state, sessionId);
    return state;
  }
  state.active = false;
  state.phase = "complete";
  state.result = "overridden";
  state.override_reason = reason.trim();
  state.completed_at = state.updated_at = new Date().toISOString();
  delete state.pending_question;
  writeMergeReadinessState(workingDir, state, sessionId);
  return state;
}

export function cancelMergeReadiness(directory: string, sessionId?: string): MergeReadinessState | null {
  const workingDir = resolveToWorktreeRoot(directory);
  const state = readMergeReadinessState(workingDir, sessionId);
  if (!state?.active) return state ?? null;
  state.active = false;
  state.phase = "complete";
  state.result = "cancelled";
  state.completed_at = state.updated_at = new Date().toISOString();
  delete state.pending_question;
  writeMergeReadinessState(workingDir, state, sessionId);
  return state;
}

export function formatMergeReadinessQuestionMessage(state: MergeReadinessState): string {
  const scorePct = Math.round(state.readiness_score * 100);
  const thresholdPct = Math.round(state.threshold * 100);
  const scoreLine = state.result === "pending"
    ? `Score: hidden until completion / threshold ${thresholdPct}%`
    : `Score: ${scorePct}% / threshold ${thresholdPct}%`;

  if (state.awaiting_content) {
    return [
      "[MERGE READINESS BLOCKED]",
      "Do not merge yet. The runtime is awaiting the AI-generated explanation doc + MCQs.",
      "Audit record: authoritative session state",
      `Profile: ${state.profile} | threshold ${thresholdPct}% | max rounds ${state.max_rounds}`,
      `Required dimensions: ${state.required_dimensions.join(", ")}`,
      "",
      "AI step: call setMergeReadinessContent with the 5-section doc + up to " +
        `${state.max_rounds} MCQs (each with correctOptionId), then present each MCQ ` +
        "one-per-round via AskUserQuestion and record answers via recordMergeReadinessMCQAnswer.",
    ].join("\n");
  }

  const pending = state.pending_question;
  if (!pending) {
    return `[MERGE READINESS] No pending question. Result: ${state.result}. Score: ${scorePct}% / threshold ${thresholdPct}%. Audit record: authoritative session state.`;
  }

  const answeredCount = state.answers.length;
  const total = Math.min(state.questions.length || state.max_rounds, state.max_rounds);
  const options = Array.isArray(pending.options)
    ? pending.options.map((opt) => `  [${opt.id}] ${opt.text}`).join("\n")
    : "";
  const stem = pending.stem || (pending as { question?: string }).question || "";
  const dimension = pending.dimension ?? "why";
  return [
    "[MERGE READINESS BLOCKED]",
    "Do not merge yet. This post-task gate checks whether the human can explain the change.",
    "Audit record: authoritative session state",
    scoreLine,
    `Answered: ${answeredCount}/${total}`,
    "",
    `Question [${dimension}] (${answeredCount + 1}/${total}): ${stem}`,
    options,
  ].filter((line) => line.length > 0).join("\n");
}

// ---------------------------------------------------------------------------
// Legacy prompt-as-answer fallback (standalone /merge-readiness text path).
// Kept for backward compatibility; the AI-driven MCQ path (setMergeReadinessContent
// + recordMergeReadinessMCQAnswer) is the canonical v1 path.
// ---------------------------------------------------------------------------

/** @deprecated heuristic scorer retained only for the legacy text fallback. */
function scoreAnswer(answer: string): number {
  const normalized = answer.trim().toLowerCase();
  if (!normalized) return 0;
  if (/(不知道|不清楚|说不出|答不出|not sure|don't know|do not know|unknown)/i.test(normalized)) {
    return 0.1;
  }
  const lengthScore = normalized.length >= 140 ? 0.65 : normalized.length >= 70 ? 0.48 : normalized.length >= 30 ? 0.32 : 0.15;
  const signalPatterns = [
    /because|why|为了|因为|目标|原因/,
    /change|changed|改了|变化|行为|影响/,
    /risk|风险|tradeoff|取舍|alternative|替代|权衡/,
    /test|review|verify|验证|测试|评审/,
    /team|maintain|approve|团队|维护|批准|理解/,
  ];
  const signalScore = signalPatterns.reduce((sum, pattern) => sum + (pattern.test(normalized) ? 0.07 : 0), 0);
  return Math.min(1, lengthScore + signalScore);
}

/**
 * @deprecated Legacy text-answer recorder. Only routes to the old open-ended
 * round shape when the state has no AI-generated MCQs yet. When MCQs exist,
 * the AI-driven recordMergeReadinessMCQAnswer path is canonical.
 */
export function recordMergeReadinessAnswer(
  directory: string,
  answer: string,
  sessionId?: string,
): MergeReadinessState | null {
  const workingDir = resolveToWorktreeRoot(directory);
  const state = readMergeReadinessState(workingDir, sessionId);
  if (!state?.active) return state ?? null;
  const now = new Date().toISOString();
  const pendingRound = state.rounds.find((r) => !r.answer);
  if (!pendingRound) return state;
  const score = scoreAnswer(answer);
  state.rounds = state.rounds.map((round) =>
    round.round === pendingRound.round
      ? { ...round, answer: answer.trim(), score, answered_at: now }
      : round,
  );
  state.updated_at = now;
  writeMergeReadinessState(workingDir, state, sessionId);
  return state;
}

export function isLikelyMergeReadinessAnswer(promptText: string): boolean {
  const trimmed = promptText.trim();
  if (!trimmed) return false;
  if (/^\//.test(trimmed)) return false;
  if (/^\$/.test(trimmed)) return false;
  // Only treat as a fallback answer when no AI-generated MCQs are pending;
  // the AI-driven path writes state directly and never hits this.
  return true;
}

export function handleMergeReadinessPromptSubmit(
  directory: string,
  promptText: string,
  sessionId?: string,
): MergeReadinessPromptResult {
  const workingDir = resolveToWorktreeRoot(directory);
  const state = readMergeReadinessState(workingDir, sessionId);
  if (!state?.active) {
    return { handled: false };
  }
  const override = /^\/(?:oh-my-claudecode:|omc:)?merge-readiness\s+--override\s+(.+)$/i.exec(promptText.trim());
  if (!override) return { handled: false };
  const updated = overrideMergeReadiness(workingDir, override[1], sessionId);
  if (!updated || updated.result !== "overridden") return { handled: false };
  return {
    handled: true,
    message: formatMergeReadinessQuestionMessage(updated),
  };
}

/**
 * Stop-hook gate. Reads state; if active and not yet passed, blocks the session
 * and injects the pending MCQ (or an awaiting-content nudge). Releases on pass.
 */
export async function checkMergeReadiness(
  sessionId: string | undefined,
  directory: string,
  cancelInProgress: boolean,
): Promise<{ shouldBlock: boolean; message: string; result: MergeReadinessResult } | null> {
  if (cancelInProgress) return null;
  const workingDir = resolveToWorktreeRoot(directory);
  const state = readMergeReadinessState(workingDir, sessionId);
  if (!state?.active) return null;
  if (state.result === "pass") return null;

  const now = new Date().toISOString();
  state.updated_at = now;
  if (!state.awaiting_content && !state.pending_question && state.result === "pending") {
    state.pending_question = pickNextQuestion(state);
    if (!state.pending_question) {
      finalizeIfReady(state, now);
    }
  }
  writeMergeReadinessState(workingDir, state, sessionId);

  // finalizeIfReady (called above) may have deactivated the gate on pass/paused/
  // blocked. When active=false the session is released; otherwise block.
  if (!state.active) return null;
  return {
    shouldBlock: true,
    message: formatMergeReadinessQuestionMessage(state),
    result: state.result,
  };
}

// Re-export deprecated types for callers that still import them from runtime.
export type { MergeReadinessRound } from "./types.js";
