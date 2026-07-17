import { execFileSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join, relative } from "path";
import { readModeState, writeModeState } from "../../lib/mode-state-io.js";
import { MODE_NAMES, MODE_STATE_FILE_MAP } from "../../lib/mode-names.js";
import { getOmcRoot, resolveToWorktreeRoot, validateSessionId } from "../../lib/worktree-paths.js";
import { computeCorrectnessRate, hasRequiredDimensionCoverage, isCorrectnessPass, profileMaxRounds, profileThreshold, requiredDimensionsForProfile, scoreMCQResponse, } from "./mcq.js";
const MODE = "merge-readiness";
// The MCP caller controls session_id, so it is only a state-scope selector and
// must never be used as override authority. The server launcher injects the
// authenticated principal and the allowlist; neither value is accepted from a
// tool call or slash-command argument.
const MAINTAINER_PRINCIPAL_ENV = "OMC_MERGE_READINESS_AUTHENTICATED_PRINCIPAL";
const MAINTAINER_ALLOWLIST_ENV = "OMC_MERGE_READINESS_MAINTAINERS";
function resolveAuthenticatedMaintainerPrincipal() {
    const principal = process.env[MAINTAINER_PRINCIPAL_ENV]?.trim();
    const allowedPrincipals = (process.env[MAINTAINER_ALLOWLIST_ENV] ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    if (!principal || !allowedPrincipals.includes(principal))
        return null;
    return principal;
}
export function parseMergeReadinessProfile(promptText) {
    if (/\B--deep\b/i.test(promptText))
        return "deep";
    if (/\B--quick\b/i.test(promptText))
        return "quick";
    return "standard";
}
export function slugifyMergeReadiness(input) {
    const slug = input
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48);
    return slug || "change";
}
function runGit(directory, args) {
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
    }
    catch (e) {
        const err = e;
        const timedOut = err?.code === "ETIMEDOUT" || /timed out/i.test(String(err?.message || ""));
        const stderr = typeof err?.stderr === "string" ? err.stderr.trim().slice(0, 200) : "";
        const exit = err?.status;
        const error = timedOut
            ? `git ${args[0]} timed out (>10s)`
            : `git ${args[0]} failed (exit ${exit ?? "?"})${stderr ? ": " + stderr : ""}`;
        return { stdout: "", error };
    }
}
const EVIDENCE_MODE_STATE_FILES = new Set([
    MODE_STATE_FILE_MAP[MODE_NAMES.RALPH],
    MODE_STATE_FILE_MAP[MODE_NAMES.AUTOPILOT],
    MODE_STATE_FILE_MAP[MODE_NAMES.TEAM],
    MODE_STATE_FILE_MAP[MODE_NAMES.ULTRAWORK],
    MODE_STATE_FILE_MAP[MODE_NAMES.ULTRAQA],
    MODE_STATE_FILE_MAP[MODE_NAMES.RALPLAN],
    MODE_STATE_FILE_MAP[MODE_NAMES.AUTORESEARCH],
]);
const NON_EVIDENCE_STATE_SUFFIXES = ["-stop-breaker.json", "-last-steer-at", "-continue-steer.lock"];
function isNonEvidenceStateFile(name) {
    return NON_EVIDENCE_STATE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}
function modeStateRecordsRun(filePath) {
    try {
        const raw = readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
            if (parsed.active === true)
                return true;
            if (typeof parsed.iteration === "number" && parsed.iteration > 0)
                return true;
            if (typeof parsed.started_at === "string" && parsed.started_at.length > 0)
                return true;
            if (typeof parsed.phase === "string" && parsed.phase.length > 0 && parsed.phase !== "init")
                return true;
        }
    }
    catch {
        // Unreadable/unparseable state is not evidence.
    }
    return false;
}
function listArtifactFiles(directory, sessionId) {
    const root = getOmcRoot(directory);
    const dirCandidates = ["plans", "artifacts", "logs", "specs", "interviews"]
        .map((segment) => join(root, segment))
        .filter((path) => existsSync(path));
    const found = [];
    const seen = new Set();
    const pushRelative = (full) => {
        const relativePath = relative(root, full).replace(/\\/g, "/");
        if (relativePath.startsWith("artifacts/merge-readiness/"))
            return;
        if (relativePath.includes("merge-readiness-state"))
            return;
        if (seen.has(relativePath))
            return;
        seen.add(relativePath);
        found.push(relativePath);
    };
    // Cap evidence per artifact root (not globally): a repo with many unrelated
    // files under plans/ must not exhaust the cap before logs/specs/interviews
    // are inspected, or valid test/review evidence in those later roots is missed
    // and the gate blocks incorrectly on artifact-only / --from-artifacts runs.
    const MAX_PER_ROOT = 40;
    for (const candidate of dirCandidates) {
        const stack = [candidate];
        let perRoot = 0;
        while (stack.length > 0 && perRoot < MAX_PER_ROOT) {
            const current = stack.pop();
            if (!current)
                continue;
            try {
                const entries = readdirSync(current, { withFileTypes: true });
                for (const entry of entries) {
                    if (perRoot >= MAX_PER_ROOT)
                        break;
                    const full = join(current, entry.name);
                    if (entry.isDirectory()) {
                        stack.push(full);
                    }
                    else if (entry.isFile() && /\.(md|json|txt|log)$/i.test(entry.name)) {
                        pushRelative(full);
                        perRoot++;
                    }
                }
            }
            catch {
                continue;
            }
        }
    }
    // Scan .omc/state/ for canonical mode-state files that record a real run
    // (the "relevant mode state artifacts" advertised in SKILL.md). Scan the
    // legacy/global state dir AND the current session's session-scoped state dir,
    // so a --from-artifacts run after a session-scoped workflow (ralph/team/etc.)
    // counts the current session's mode state as evidence.
    const stateDir = join(root, "state");
    const scanStateDir = (dir) => {
        if (!existsSync(dir))
            return;
        try {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                if (!entry.isFile() || !entry.name.endsWith(".json"))
                    continue;
                if (isNonEvidenceStateFile(entry.name))
                    continue;
                if (!EVIDENCE_MODE_STATE_FILES.has(entry.name))
                    continue;
                const full = join(dir, entry.name);
                if (!modeStateRecordsRun(full))
                    continue;
                pushRelative(full);
            }
        }
        catch {
            // Unreadable state dir: skip.
        }
    };
    scanStateDir(stateDir);
    if (sessionId) {
        scanStateDir(join(stateDir, "sessions", sessionId));
    }
    return found.sort();
}
export function collectMergeReadinessEvidence(directory, baseRef, sessionId) {
    const worktree = resolveToWorktreeRoot(directory);
    const gitErrors = [];
    const git = (args) => {
        const r = runGit(worktree, args);
        if (r.error)
            gitErrors.push(r.error);
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
    const sourceArtifacts = listArtifactFiles(worktree, sessionId);
    const evidenceText = sourceArtifacts.join("\n").toLowerCase();
    const testEvidence = sourceArtifacts.filter((file) => /test|spec|qa|verify|validation/i.test(file));
    const reviewEvidence = sourceArtifacts.filter((file) => /review|risk|security|readiness|verdict/i.test(file));
    const missingEvidence = [];
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
    for (const gerr of gitErrors)
        missingEvidence.push(gerr);
    return { changedFiles: trackedChangedFiles, untrackedFiles, status, diffStat, sourceArtifacts, testEvidence, reviewEvidence, missingEvidence, base_ref: resolvedBase };
}
function extractChangeSummary(promptText) {
    return promptText
        .replace(/^\s*\/(?:oh-my-claudecode:|omc:)?merge-readiness\b/i, "")
        .replace(/\B--(?:quick|standard|deep|from-diff|from-artifacts)\b/gi, "")
        .trim();
}
/** True when the collected evidence lacks the minimal diff/change signal needed to quiz on. */
function hasMinimalEvidence(evidence) {
    return evidence.changedFiles.length > 0 || Boolean(evidence.status) || Boolean(evidence.diffStat) || evidence.sourceArtifacts.length > 0;
}
function parseMergeReadinessSourceMode(promptText) {
    const fromDiff = /(?:^|\s)--from-diff(?=\s|$)/i.test(promptText);
    const fromArtifacts = /(?:^|\s)--from-artifacts(?=\s|$)/i.test(promptText);
    if (fromDiff && fromArtifacts)
        return { error: "--from-diff and --from-artifacts cannot be used together." };
    if (fromDiff)
        return { mode: "diff" };
    if (fromArtifacts)
        return { mode: "artifacts" };
    return {};
}
function hasModeStateArtifact(evidence) {
    return evidence.sourceArtifacts.some((path) => {
        const name = path.slice(path.lastIndexOf("/") + 1);
        return EVIDENCE_MODE_STATE_FILES.has(name);
    });
}
function hasMinimalEvidenceForMode(evidence, mode) {
    const hasDiff = evidence.changedFiles.length > 0 || Boolean(evidence.diffStat);
    const hasRelevantArtifact = evidence.testEvidence.length > 0
        || evidence.reviewEvidence.length > 0
        || hasModeStateArtifact(evidence);
    if (mode === "diff")
        return hasDiff;
    if (mode === "artifacts")
        return hasRelevantArtifact;
    return hasDiff || hasRelevantArtifact;
}
function pickNextQuestion(state) {
    if (state.questions.length === 0)
        return undefined;
    const answered = new Set(state.answers.map((a) => a.questionId));
    const unanswered = state.questions.filter((q) => !answered.has(q.id));
    if (unanswered.length === 0)
        return undefined;
    // Prefer required dimensions, then any remaining unanswered question.
    const requiredSet = new Set(state.required_dimensions);
    const requiredNext = unanswered.find((q) => requiredSet.has(q.dimension));
    return requiredNext ?? unanswered[0];
}
/**
 * Recompute correctness rate + per-dimension coverage from recorded MCQ answers.
 * The readiness score is the objective correctness rate (not a heuristic).
 */
function recomputeReadiness(state) {
    const scores = {};
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
function allRequiredAnswered(state) {
    if (state.questions.length === 0)
        return false;
    const answered = new Set(state.answers.map((a) => a.questionId));
    // Every required dimension must have at least one answered MCQ.
    const answeredDimensions = new Set(state.answers
        .map((a) => state.questions.find((q) => q.id === a.questionId)?.dimension)
        .filter((d) => Boolean(d)));
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
function finalizeIfReady(state, now) {
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
    const coverageOk = hasRequiredDimensionCoverage(state.answers, state.questions, state.required_dimensions);
    if (isCorrectnessPass(rate, state.threshold) && coverageOk) {
        state.active = false;
        state.phase = "complete";
        state.result = "pass";
        state.completed_at = now;
        delete state.pending_question;
        return;
    }
    // All required answered but below threshold or missing coverage: paused.
    // Keep active=true so the gate stays armed until the operator re-runs
    // /merge-readiness and passes. v1 is advisory: checkMergeReadiness is not
    // wired to the Stop hook, so this does not block the session; the gate
    // remains active until pass/override/cancel.
    state.phase = "complete";
    state.result = "paused";
    state.completed_at = now;
    delete state.pending_question;
}
export function readMergeReadinessState(directory, sessionId) {
    return readModeState(MODE, directory, sessionId) ?? null;
}
export function writeMergeReadinessState(directory, state, sessionId) {
    return writeModeState(MODE, state, directory, sessionId);
}
/**
 * Persist state and fail closed if the write cannot land (invalid session id
 * or state path). Prevents phantom pass/override/cancel results from surfacing
 * when the authoritative state file cannot be written. Mutators that would
 * otherwise report a terminal release (active=false) instead force-block so the
 * operator must resolve the session id and re-run.
 */
function persistOrFailClosed(workingDir, state, sessionId) {
    const persisted = writeMergeReadinessState(workingDir, state, sessionId);
    if (persisted)
        return state;
    state.active = true;
    state.phase = "complete";
    state.result = "blocked";
    state.awaiting_content = false;
    delete state.pending_question;
    state.validation_errors = [
        ...(state.validation_errors ?? []),
        "Merge-readiness state could not be persisted (invalid session id or state path). Resolve the session id and re-run merge_readiness_start.",
    ];
    // Return the fail-closed state directly. Do NOT recurse: re-invoking
    // writeMergeReadinessState with the same session id/path will fail
    // identically (read-only FS, full disk, EACCES), so the recursion would
    // never terminate - it would also append a duplicate error per frame -
    // and would overflow the stack instead of returning the intended blocked
    // state. The on-disk state is unchanged here (the write above did not
    // land), so the gate stays armed until the operator resolves the session
    // id and re-runs merge_readiness_start.
    return state;
}
/**
 * Seed initial merge-readiness state. Called by the bridge on `/merge-readiness`
 * and by the autopilot adapter's onEnter. Collects evidence, picks the profile
 * threshold/maxRounds/required dims from mcq.ts, and marks the state as
 * awaiting AI-generated content (doc + MCQs).
 */
export function createInitialMergeReadinessState(directory, promptText, sessionId, baseRef) {
    // Validate sessionId before any path join: listArtifactFiles joins it into
    // .omc/state/sessions/<sessionId>/ for evidence collection, and an unvalidated
    // traversal id (../../) would scan arbitrary directories outside that scope.
    if (sessionId)
        validateSessionId(sessionId);
    const now = new Date().toISOString();
    const profile = parseMergeReadinessProfile(promptText);
    const changeSummary = extractChangeSummary(promptText);
    const unsupportedFromPr = /\B--from-pr\b/i.test(promptText);
    const sourceModeResult = parseMergeReadinessSourceMode(promptText);
    const sourceMode = sourceModeResult.mode;
    const evidence = collectMergeReadinessEvidence(directory, baseRef, sessionId);
    const missingEvidence = unsupportedFromPr || Boolean(sourceModeResult.error) || !hasMinimalEvidenceForMode(evidence, sourceMode);
    const state = {
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
        awaiting_content: !missingEvidence,
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
    let prior = null;
    try {
        prior = readMergeReadinessState(directory, sessionId);
    }
    catch {
        // An invalid session id throws on the read path (validateSessionId); treat
        // as no prior attempt. The write below will fail-closed on the same id.
        prior = null;
    }
    // Refuse to overwrite an active (pending) attempt. A pending prior has not
    // reached a terminal state (pass/override/cancel) or paused, so silently
    // re-starting would discard its recorded content/answers without leaving a
    // prior-attempt audit record. Force the operator to cancel (which records a
    // cancel_owner audit entry) or let the attempt finalize first. Paused and
    // terminal priors fall through to the retention branch below and may resume.
    if (prior && prior.result === "pending") {
        const phase = prior.phase ?? "content";
        const answerCount = (prior.answers ?? []).length;
        throw new Error(`An active merge-readiness attempt is still in progress (phase: ${phase}, ${answerCount} answer(s) recorded). ` +
            `Re-running merge_readiness_start would overwrite it and lose its audit trail. ` +
            `Cancel it first via merge_readiness_cancel, or let it pass/pause; the prior attempt is retained in the audit history once terminal.`);
    }
    if (prior && prior.result !== "pending" && prior.completed_at) {
        const priorAttempt = {
            profile: prior.profile,
            threshold: prior.threshold,
            max_rounds: prior.max_rounds,
            required_dimensions: [...prior.required_dimensions],
            change_summary: prior.change_summary,
            slug: prior.slug,
            why: prior.why,
            whatChanged: prior.whatChanged,
            tradeoffs: prior.tradeoffs,
            risksConsidered: prior.risksConsidered,
            teamUnderstanding: prior.teamUnderstanding,
            started_at: prior.started_at,
            completed_at: prior.completed_at,
            result: prior.result,
            override_reason: prior.override_reason,
            override_owner: prior.override_owner,
            cancel_owner: prior.cancel_owner,
            readiness_score: prior.readiness_score,
            dimension_scores: { ...prior.dimension_scores },
            questions: prior.questions.map((q) => ({ ...q, options: q.options.map((o) => ({ ...o })) })),
            answers: prior.answers.map((a) => ({ ...a })),
            evidence_summary: {
                changedFiles: [...prior.evidence.changedFiles],
                source_mode: prior.source_mode,
                missingEvidence: [...prior.evidence.missingEvidence],
                sourceArtifactCount: prior.evidence.sourceArtifacts.length,
                testEvidenceCount: prior.evidence.testEvidence.length,
                reviewEvidenceCount: prior.evidence.reviewEvidence.length,
            },
        };
        state.prior_attempts = [...(prior.prior_attempts ?? []), priorAttempt];
    }
    const persisted = writeMergeReadinessState(directory, state, sessionId);
    if (!persisted) {
        throw new Error("Merge-readiness could not create durable state. The workflow was not started; restore state storage and retry.");
    }
    return state;
}
/**
 * AI writes the generated explanation doc (5 sections) + MCQs into state.
 * Called after the AI has read the evidence and produced narrative + questions.
 * Each question must carry correctOptionId so the runtime can score objectively.
 */
export function setMergeReadinessContent(directory, content, sessionId) {
    const workingDir = resolveToWorktreeRoot(directory);
    const state = readMergeReadinessState(workingDir, sessionId);
    if (!state?.active)
        return state ?? null;
    const now = new Date().toISOString();
    // Do not re-arm blocked or paused states: a blocked state lacks minimal
    // evidence, and a paused state failed the quiz. Both require a fresh
    // merge_readiness_start (which re-collects evidence) rather than a content
    // re-submit. The prior attempt is appended to prior_attempts on re-start, so
    // the audit history is retained across retries.
    if (state.result === "blocked" || state.result === "paused") {
        state.validation_errors ??= [state.result === "blocked"
                ? "Blocked: no minimal evidence for the selected source mode. Produce it before submitting content."
                : "Paused: the quiz was not passed. Re-run merge_readiness_start to collect fresh evidence and retry; the prior attempt is retained in the audit history."];
        if (state.result === "blocked") {
            state.awaiting_content = true;
            state.phase = "content";
        }
        state.updated_at = now;
        return persistOrFailClosed(workingDir, state, sessionId);
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
        return persistOrFailClosed(workingDir, state, sessionId);
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
    return persistOrFailClosed(workingDir, state, sessionId);
}
/**
 * Record one MCQ answer (objective scoring via scoreMCQResponse), append it,
 * and finalize the gate if all required questions are answered.
 */
export function recordMergeReadinessMCQAnswer(directory, questionId, selectedOptionId, sessionId) {
    const workingDir = resolveToWorktreeRoot(directory);
    const state = readMergeReadinessState(workingDir, sessionId);
    if (!state?.active)
        return state ?? null;
    if (state.awaiting_content || state.phase !== "questioning")
        return null;
    const question = state.questions.find((q) => q.id === questionId);
    if (!question || state.pending_question?.id !== questionId)
        return null;
    const normalizedOptionId = selectedOptionId.trim();
    if (!question.options.some((option) => option.id === normalizedOptionId))
        return null;
    const now = new Date().toISOString();
    const isCorrect = scoreMCQResponse(question, normalizedOptionId);
    // Replace any prior answer to the same question (idempotent re-answer).
    const filtered = state.answers.filter((a) => a.questionId !== questionId);
    const answer = {
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
    }
    else {
        delete state.pending_question;
    }
    return persistOrFailClosed(workingDir, state, sessionId);
}
/** Correlate only a marked native AskUserQuestion result to the current MCQ. */
export function recordMergeReadinessAskUserQuestionResult(directory, toolInput, toolOutput, sessionId) {
    const state = readMergeReadinessState(resolveToWorktreeRoot(directory), sessionId);
    const pending = state?.pending_question;
    if (!state?.active || !pending)
        return state ?? null;
    const inputText = JSON.stringify(toolInput ?? "");
    if (!inputText.includes(`[MERGE READINESS:${pending.id}]`))
        return state;
    const outputText = typeof toolOutput === "string" ? toolOutput : JSON.stringify(toolOutput ?? "");
    const selected = pending.options.filter((option) => new RegExp(`(?:^|[\\s\\[\"'])${option.id.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}(?:$|[\\s\\]\"',:])`).test(outputText));
    return selected.length === 1
        ? recordMergeReadinessMCQAnswer(directory, pending.id, selected[0].id, sessionId)
        : state;
}
export function validateMergeReadinessContent(content, state) {
    const errors = [];
    const sections = [["why", content.why], ["whatChanged", content.whatChanged], ["tradeoffs", content.tradeoffs], ["risksConsidered", content.risksConsidered], ["teamUnderstanding", content.teamUnderstanding]];
    for (const [name, value] of sections)
        if (!value?.trim())
            errors.push(`Narrative section '${name}' is required.`);
    if (!Array.isArray(content.questions) || content.questions.length < state.required_dimensions.length)
        errors.push("Questions must cover every required dimension.");
    if (content.questions.length > state.max_rounds)
        errors.push(`Questions exceed the ${state.max_rounds}-question profile limit.`);
    const ids = new Set();
    const dimensions = new Set();
    for (const question of content.questions ?? []) {
        if (!question.id?.trim() || ids.has(question.id))
            errors.push("Question ids must be non-empty and unique.");
        ids.add(question.id);
        dimensions.add(question.dimension);
        if (!question.stem?.trim())
            errors.push(`Question '${question.id}' needs a stem.`);
        if (!Array.isArray(question.options) || question.options.length < 2)
            errors.push(`Question '${question.id}' needs at least two options.`);
        const optionIds = new Set(question.options?.map((option) => option.id) ?? []);
        if (optionIds.size !== (question.options?.length ?? 0) || [...optionIds].some((id) => !id?.trim()))
            errors.push(`Question '${question.id}' has invalid option ids.`);
        if (!optionIds.has(question.correctOptionId))
            errors.push(`Question '${question.id}' correctOptionId must identify an option.`);
    }
    for (const dimension of state.required_dimensions)
        if (!dimensions.has(dimension))
            errors.push(`No question covers required dimension '${dimension}'.`);
    return errors;
}
export function overrideMergeReadiness(directory, reason, sessionId) {
    const workingDir = resolveToWorktreeRoot(directory);
    const state = readMergeReadinessState(workingDir, sessionId);
    if (!state?.active || !reason.trim())
        return state ?? null;
    const principal = resolveAuthenticatedMaintainerPrincipal();
    if (!principal) {
        state.validation_errors = [
            ...(state.validation_errors ?? []),
            "Override rejected: no authenticated maintainer principal is available for this MCP server. Configure OMC_MERGE_READINESS_AUTHENTICATED_PRINCIPAL and OMC_MERGE_READINESS_MAINTAINERS in the trusted server launcher.",
        ];
        return persistOrFailClosed(workingDir, state, sessionId);
    }
    if (state.result === "blocked") {
        state.validation_errors ??= ["Blocked: resolve the validation errors before overriding."];
        return persistOrFailClosed(workingDir, state, sessionId);
    }
    state.active = false;
    state.phase = "complete";
    state.result = "overridden";
    state.override_reason = reason.trim();
    state.override_owner = principal;
    state.completed_at = state.updated_at = new Date().toISOString();
    delete state.pending_question;
    return persistOrFailClosed(workingDir, state, sessionId);
}
export function cancelMergeReadiness(directory, sessionId) {
    const workingDir = resolveToWorktreeRoot(directory);
    const state = readMergeReadinessState(workingDir, sessionId);
    if (!state?.active)
        return state ?? null;
    state.active = false;
    state.phase = "complete";
    state.result = "cancelled";
    // Record who cancelled for audit parity with override_owner. The state_clear
    // bulk/legacy path cancels with no session id; record a synthetic owner there
    // rather than rejecting (cancel is an abandonment, not a discretionary bypass).
    state.cancel_owner = sessionId ?? "legacy";
    state.completed_at = state.updated_at = new Date().toISOString();
    delete state.pending_question;
    return persistOrFailClosed(workingDir, state, sessionId);
}
export function formatMergeReadinessQuestionMessage(state) {
    const scorePct = Math.round(state.readiness_score * 100);
    const thresholdPct = Math.round(state.threshold * 100);
    const scoreLine = state.result === "pending"
        ? `Score: hidden until completion / threshold ${thresholdPct}%`
        : `Score: ${scorePct}% / threshold ${thresholdPct}%`;
    if (state.result === "blocked") {
        const noDiff = state.evidence.changedFiles.length === 0 && !state.evidence.diffStat;
        const baseRef = state.evidence.base_ref;
        const diffHint = baseRef
            ? `call merge_readiness_start with summary "--from-diff" and baseRef "${baseRef}"`
            : "call merge_readiness_start with summary \"--from-diff\" and an explicit baseRef";
        const evidenceGuidance = noDiff
            ? `No diff detected. If changes are committed, ${diffHint}; if relying on .omc artifacts, use --from-artifacts. If there are truly no changes, a merge-readiness gate is not needed.`
            : "Produce the test/review evidence under .omc, then re-run /merge-readiness (merge_readiness_start).";
        return [
            "[MERGE READINESS BLOCKED]",
            "Do not merge yet. Minimal evidence for the change is missing.",
            evidenceGuidance,
            ...(state.validation_errors ?? []),
        ].join("\n");
    }
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
    const stem = pending.stem || pending.question || "";
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
function scoreAnswer(answer) {
    const normalized = answer.trim().toLowerCase();
    if (!normalized)
        return 0;
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
export function recordMergeReadinessAnswer(directory, answer, sessionId) {
    const workingDir = resolveToWorktreeRoot(directory);
    const state = readMergeReadinessState(workingDir, sessionId);
    if (!state?.active)
        return state ?? null;
    const now = new Date().toISOString();
    const pendingRound = state.rounds.find((r) => !r.answer);
    if (!pendingRound)
        return state;
    const score = scoreAnswer(answer);
    state.rounds = state.rounds.map((round) => round.round === pendingRound.round
        ? { ...round, answer: answer.trim(), score, answered_at: now }
        : round);
    state.updated_at = now;
    return persistOrFailClosed(workingDir, state, sessionId);
}
export function isLikelyMergeReadinessAnswer(promptText) {
    const trimmed = promptText.trim();
    if (!trimmed)
        return false;
    if (/^\//.test(trimmed))
        return false;
    if (/^\$/.test(trimmed))
        return false;
    // Only treat as a fallback answer when no AI-generated MCQs are pending;
    // the AI-driven path writes state directly and never hits this.
    return true;
}
export function handleMergeReadinessPromptSubmit(directory, promptText, sessionId) {
    const workingDir = resolveToWorktreeRoot(directory);
    const state = readMergeReadinessState(workingDir, sessionId);
    if (!state?.active) {
        return { handled: false };
    }
    const override = /^\/(?:oh-my-claudecode:|omc:)?merge-readiness\s+--override\s+(.+)$/i.exec(promptText.trim());
    if (!override)
        return { handled: false };
    const updated = overrideMergeReadiness(workingDir, override[1], sessionId);
    if (!updated || updated.result !== "overridden")
        return { handled: false };
    return {
        handled: true,
        message: formatMergeReadinessQuestionMessage(updated),
    };
}
/**
 * Stop-hook gate. Reads state; if active and not yet passed, blocks the session
 * and injects the pending MCQ (or an awaiting-content nudge). Releases on pass.
 */
export async function checkMergeReadiness(sessionId, directory, cancelInProgress) {
    if (cancelInProgress)
        return null;
    const workingDir = resolveToWorktreeRoot(directory);
    const state = readMergeReadinessState(workingDir, sessionId);
    if (!state?.active)
        return null;
    if (state.result === "pass")
        return null;
    const now = new Date().toISOString();
    state.updated_at = now;
    if (!state.awaiting_content && !state.pending_question && state.result === "pending") {
        state.pending_question = pickNextQuestion(state);
        if (!state.pending_question) {
            finalizeIfReady(state, now);
        }
    }
    const persisted = writeMergeReadinessState(workingDir, state, sessionId);
    // finalizeIfReady (called above) may have deactivated the gate on pass/paused/
    // blocked. When active=false the session is released; otherwise block.
    if (!state.active) {
        // Fail-closed: if the write could not land (invalid session id/state path),
        // do NOT release the gate on a phantom pass/paused/blocked result. Force a
        // block so the operator resolves the session id and re-runs.
        if (!persisted) {
            return {
                shouldBlock: true,
                message: "Merge-readiness state could not be persisted (invalid session id or state path). Resolve the session id and re-run merge_readiness_start.",
                result: "blocked",
            };
        }
        return null;
    }
    return {
        shouldBlock: true,
        message: formatMergeReadinessQuestionMessage(state),
        result: state.result,
    };
}
//# sourceMappingURL=runtime.js.map