const MERGE_BOUNDARY_STATEMENT = "Passing means the human can explain the change. It does not approve merge, replace tests, replace review, or accept risk.";
function renderQuestions(questions, answers, result) {
    if (questions.length === 0)
        return "_No quiz questions recorded yet._";
    const answersByQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));
    const revealAll = result === "pass" || result === "paused";
    const revealAnswered = result === "overridden" || result === "cancelled";
    return questions.map((question, index) => {
        const answer = answersByQuestion.get(question.id);
        const options = question.options.map((option) => {
            const marks = [];
            if ((revealAll || (revealAnswered && answer)) && option.id === question.correctOptionId)
                marks.push("correct");
            if (answer?.selectedOptionId === option.id)
                marks.push("selected");
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
function renderList(values, empty) {
    return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : empty;
}
/**
 * Render a prior (terminal) attempt. Prior attempts are terminal by
 * construction, so revealing correctOptionId/isCorrect is safe (not a
 * redaction leak) and gives the operator a complete audit of past tries.
 */
function renderPriorAttempt(attempt, index, revealAssessment) {
    const header = [
        `### Attempt ${index + 1}: ${attempt.result}`,
        `- Profile: ${attempt.profile} | threshold ${Math.round(attempt.threshold * 100)}% | max rounds ${attempt.max_rounds}`,
        `- Readiness score: ${Math.round(attempt.readiness_score * 100)}%`,
        `- Change summary: ${attempt.change_summary || "_No change summary._"}`,
        attempt.override_reason ? `- Override reason: ${attempt.override_reason}` : "",
        attempt.override_owner ? `- Override owner: ${attempt.override_owner}` : "",
        attempt.cancel_owner ? `- Cancel owner: ${attempt.cancel_owner}` : "",
        attempt.started_at ? `- Started: ${attempt.started_at}` : "",
        attempt.completed_at ? `- Completed: ${attempt.completed_at}` : "",
    ].filter((line) => line.length > 0).join("\n");
    const dimensions = attempt.required_dimensions.length > 0
        ? attempt.required_dimensions
            .map((dimension) => `- ${dimension}: ${Math.round((attempt.dimension_scores[dimension] ?? 0) * 100)}%`)
            .join("\n")
        : "_No required dimensions recorded._";
    const qa = attempt.questions.length === 0
        ? "_No quiz questions recorded._"
        : attempt.questions.map((question, qIndex) => {
            const answer = attempt.answers.find((a) => a.questionId === question.id);
            const options = question.options.map((option) => {
                const marks = [];
                if (revealAssessment && option.id === question.correctOptionId)
                    marks.push("correct");
                if (revealAssessment && answer?.selectedOptionId === option.id)
                    marks.push("selected");
                return `- [${option.id}] ${option.text}${marks.length > 0 ? ` _(${marks.join(", ")})_` : ""}`;
            });
            const correctness = answer && revealAssessment
                ? `Correct: ${answer.isCorrect ? "yes" : "no"}`
                : answer
                    ? "_Prior answer recorded; assessment hidden until the current attempt completes._"
                    : "_Not answered._";
            return [
                `#### Q${qIndex + 1}. [${question.dimension}] ${question.stem}`,
                "",
                ...options,
                "",
                correctness,
            ].join("\n");
        }).join("\n\n");
    const evidence = attempt.evidence_summary;
    const evidenceBlock = [
        "#### Evidence Summary",
        `- Changed files: ${evidence.changedFiles.length}`,
        evidence.source_mode ? `- Source mode: ${evidence.source_mode}` : "",
        `- Source artifacts: ${evidence.sourceArtifactCount}`,
        `- Test artifacts: ${evidence.testEvidenceCount}`,
        `- Review artifacts: ${evidence.reviewEvidenceCount}`,
        evidence.missingEvidence.length > 0
            ? `- Missing evidence:\n${evidence.missingEvidence.map((m) => `  - ${m}`).join("\n")}`
            : "- Missing evidence: none",
    ].filter((line) => line.length > 0).join("\n");
    const narrative = [
        "#### Narrative",
        `- Why: ${attempt.why || "_Not recorded._"}`,
        `- What changed: ${attempt.whatChanged || "_Not recorded._"}`,
        `- Tradeoffs: ${attempt.tradeoffs || "_Not recorded._"}`,
        `- Risks considered: ${attempt.risksConsidered || "_Not recorded._"}`,
        `- Team understanding: ${attempt.teamUnderstanding || "_Not recorded._"}`,
    ].join("\n");
    return [header, "", narrative, "", "#### Dimension Coverage", "", dimensions, "", "#### Questions & Answers", "", qa, "", evidenceBlock].join("\n");
}
/** Render the authoritative session state as a report without filesystem side effects. */
export function formatMergeReadinessReport(state) {
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
        state.override_owner ? `Override owner: ${state.override_owner}` : "",
        state.cancel_owner ? `Cancel owner: ${state.cancel_owner}` : "",
        "",
        revealAssessment
            ? `Correctness rate: ${Math.round(state.readiness_score * 100)}% / threshold ${Math.round(state.threshold * 100)}%`
            : `Correctness rate: hidden until completion / threshold ${Math.round(state.threshold * 100)}%`,
        "",
        "Dimension coverage:", "", dimensions || "_No scored dimensions yet._",
        "",
        "",
        state.prior_attempts && state.prior_attempts.length > 0
            ? ["## Prior Attempts", "", ...state.prior_attempts.map((a, i) => renderPriorAttempt(a, i, revealAssessment))].join("\n")
            : "",
        "",
        "## Merge Boundary", "", MERGE_BOUNDARY_STATEMENT,
        "",
    ].filter((line, index, lines) => line !== "" || lines[index - 1] !== "").join("\n");
}
function redactQuestion(question) {
    const redacted = { ...question };
    delete redacted.correctOptionId;
    delete redacted.rationale;
    return redacted;
}
/** Remove answer keys and interim scoring from the public state_read surface. */
export function redactMergeReadinessState(state) {
    const revealAll = state.result === "pass" || state.result === "paused";
    const revealAnswered = state.result === "overridden" || state.result === "cancelled";
    const answeredQuestionIds = new Set(state.answers.map((answer) => answer.questionId));
    const shouldRevealQuestion = (question) => revealAll || (revealAnswered && answeredQuestionIds.has(question.id));
    const redacted = {
        ...state,
        questions: state.questions.map((question) => shouldRevealQuestion(question) ? question : redactQuestion(question)),
        pending_question: state.pending_question
            ? (shouldRevealQuestion(state.pending_question) ? state.pending_question : redactQuestion(state.pending_question))
            : undefined,
        answers: state.answers.map((answer) => {
            if (revealAll || revealAnswered)
                return answer;
            const publicAnswer = { ...answer };
            delete publicAnswer.isCorrect;
            return publicAnswer;
        }),
        rounds: state.rounds.map((round) => {
            if (revealAll || revealAnswered)
                return round;
            const publicRound = { ...round };
            delete publicRound.score;
            return publicRound;
        }),
        // Prior attempts are terminal, but while the CURRENT attempt is still
        // pending/blocked the operator must not read past answer keys from the
        // audit trail. Redact correctOptionId/rationale/isCorrect on retained
        // attempts until the current attempt reaches a terminal state.
        prior_attempts: (revealAll || revealAnswered)
            ? state.prior_attempts
            : (state.prior_attempts ?? []).map((attempt) => ({
                ...attempt,
                questions: attempt.questions.map((q) => redactQuestion(q)),
                answers: attempt.answers.map((a) => {
                    // A previous selection can reveal the key for an equivalent retry.
                    return { questionId: a.questionId, answeredAt: a.answeredAt };
                }),
                readiness_score: undefined,
                dimension_scores: {},
            })),
    };
    if (!revealAll && !revealAnswered) {
        delete redacted.readiness_score;
        delete redacted.dimension_scores;
    }
    return redacted;
}
//# sourceMappingURL=report.js.map