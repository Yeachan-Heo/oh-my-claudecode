import type { MergeReadinessMCQAnswer, MergeReadinessMCQQuestion, MergeReadinessState } from "./types.js";

const MERGE_BOUNDARY_STATEMENT =
  "Passing means the human can explain the change. It does not approve merge, replace tests, replace review, or accept risk.";

function renderQuestions(
  questions: MergeReadinessMCQQuestion[],
  answers: MergeReadinessMCQAnswer[],
  result: MergeReadinessState["result"],
): string {
  if (questions.length === 0) return "_No quiz questions recorded yet._";
  const answersByQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));
  const revealAll = result === "pass" || result === "paused";
  const revealAnswered = result === "overridden" || result === "cancelled";

  return questions.map((question, index) => {
    const answer = answersByQuestion.get(question.id);
    const options = question.options.map((option) => {
      const marks: string[] = [];
      if ((revealAll || (revealAnswered && answer)) && option.id === question.correctOptionId) marks.push("correct");
      if (answer?.selectedOptionId === option.id) marks.push("selected");
      return `- [${option.id}] ${option.text}${marks.length > 0 ? ` _(${marks.join(", ")})_` : ""}`;
    });
    const correctness = answer && (revealAll || revealAnswered)
      ? `Correct: ${answer.isCorrect ? "yes" : "no"}`
      : answer
        ? "_Answered; correctness hidden until completion._"
        : "_Not answered yet._";
    return [
      `### ${index + 1}. [${question.dimension}] ${question.stem}`,
      "",
      ...options,
      "",
      correctness,
    ].join("\n");
  }).join("\n\n");
}

function renderList(values: string[], empty: string): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : empty;
}

/** Render the authoritative session state as a report without filesystem side effects. */
export function formatMergeReadinessReport(state: MergeReadinessState): string {
  const revealAssessment = ["pass", "paused", "overridden", "cancelled"].includes(state.result);
  const dimensions = revealAssessment
    ? state.required_dimensions
      .map((dimension) => `- ${dimension}: ${Math.round((state.dimension_scores[dimension] ?? 0) * 100)}%`)
      .join("\n")
    : "_Available after the attempt completes._";
  const pending = state.pending_question
    ? `- [${state.pending_question.dimension}] ${state.pending_question.stem}`
    : "_No pending question._";

  return [
    "# Merge Readiness Report",
    "",
    "## Why", "", state.why || "_Not yet generated._",
    "",
    "## What Changed", "", state.whatChanged || "_Not yet generated._",
    "",
    "## Tradeoffs", "", state.tradeoffs || "_Not yet generated._",
    "",
    "## Risks Considered", "", state.risksConsidered || "_Not yet generated._",
    "",
    "## Team Understanding", "", state.teamUnderstanding || "_Not yet generated._",
    "",
    "## Change Summary", "", state.change_summary || "_No change summary provided._",
    "",
    "## Evidence Collected", "",
    "### Changed Files", "", renderList(state.evidence.changedFiles, "_No changed files detected._"),
    "",
    "### Git Status", "", state.evidence.status || "_No git status output._",
    "",
    "### Diff Stat", "", state.evidence.diffStat || "_No diff stat output._",
    "",
    "### Source Artifacts", "", renderList(state.evidence.sourceArtifacts, "_No source artifacts found._"),
    "",
    "### Missing Evidence", "", renderList(state.evidence.missingEvidence, "_No missing evidence recorded._"),
    "",
    "## Human Explainability Quiz", "",
    "This quiz checks whether the human can explain the change. It does not replace tests, review, or maintainer approval.",
    "",
    renderQuestions(state.questions, state.answers, state.result),
    "",
    "## Pending Question", "", pending,
    "",
    "## Readiness", "",
    `Result: ${state.result}`,
    state.override_reason ? `Override reason: ${state.override_reason}` : "",
    "",
    revealAssessment
      ? `Correctness rate: ${Math.round(state.readiness_score * 100)}% / threshold ${Math.round(state.threshold * 100)}%`
      : `Correctness rate: hidden until completion / threshold ${Math.round(state.threshold * 100)}%`,
    "",
    "Dimension coverage:", "", dimensions || "_No scored dimensions yet._",
    "",
    "",
    state.prior_attempts && state.prior_attempts.length > 0
      ? ["## Prior Attempts", "", ...state.prior_attempts.map((a, i) => "- Attempt " + (i + 1) + ": " + a.result + " (score " + Math.round((a.readiness_score ?? 0) * 100) + "%)" + (a.change_summary ? " - " + a.change_summary : ""))].join("\n")
      : "",
    "",
    "## Merge Boundary", "", MERGE_BOUNDARY_STATEMENT,
    "",
  ].filter((line, index, lines) => line !== "" || lines[index - 1] !== "").join("\n");
}

function redactQuestion(question: MergeReadinessMCQQuestion): Record<string, unknown> {
  const redacted: Record<string, unknown> = { ...question };
  delete redacted.correctOptionId;
  delete redacted.rationale;
  return redacted;
}

/** Remove answer keys and interim scoring from the public state_read surface. */
export function redactMergeReadinessState(state: MergeReadinessState): Record<string, unknown> {
  const revealAll = state.result === "pass" || state.result === "paused";
  const revealAnswered = state.result === "overridden" || state.result === "cancelled";
  const answeredQuestionIds = new Set(state.answers.map((answer) => answer.questionId));
  const shouldRevealQuestion = (question: MergeReadinessMCQQuestion): boolean =>
    revealAll || (revealAnswered && answeredQuestionIds.has(question.id));

  const redacted: Record<string, unknown> = {
    ...state,
    questions: state.questions.map((question) => shouldRevealQuestion(question) ? question : redactQuestion(question)),
    pending_question: state.pending_question
      ? (shouldRevealQuestion(state.pending_question) ? state.pending_question : redactQuestion(state.pending_question))
      : undefined,
    answers: state.answers.map((answer) => {
      if (revealAll || revealAnswered) return answer;
      const publicAnswer: Record<string, unknown> = { ...answer };
      delete publicAnswer.isCorrect;
      return publicAnswer;
    }),
    rounds: state.rounds.map((round) => {
      if (revealAll || revealAnswered) return round;
      const publicRound: Record<string, unknown> = { ...round };
      delete publicRound.score;
      return publicRound;
    }),
  };

  if (!revealAll && !revealAnswered) {
    delete redacted.readiness_score;
    delete redacted.dimension_scores;
  }
  return redacted;
}
