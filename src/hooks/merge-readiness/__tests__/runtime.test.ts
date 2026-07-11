import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkMergeReadiness,
  cancelMergeReadiness,
  createInitialMergeReadinessState,
  readMergeReadinessState,
  recordMergeReadinessMCQAnswer,
  recordMergeReadinessAskUserQuestionResult,
  overrideMergeReadiness,
  setMergeReadinessContent,
} from "../index.js";
import type { MergeReadinessMCQQuestion } from "../mcq.js";

// Forces writeModeState to return false (read-only FS / full-disk analog) so
// persistOrFailClosed's fail-closed path is exercised without throwing. Other
// tests are unaffected while failWrites stays false.
const persistFail = vi.hoisted(() => ({ failWrites: false }));
vi.mock("../../../lib/mode-state-io.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/mode-state-io.js")>();
  return {
    ...actual,
    writeModeState: (
      mode: string,
      state: Record<string, unknown>,
      directory?: string,
      sessionId?: string,
    ) => {
      if (persistFail.failWrites) return false;
      return actual.writeModeState(mode, state, directory, sessionId);
    },
  };
});

function makeQuestion(
  id: string,
  dimension: "why" | "change" | "tradeoff" | "risk" | "team",
  correctOptionId = "a",
): MergeReadinessMCQQuestion {
  return {
    id,
    dimension,
    stem: `(${dimension}) Pick the correct explanation of this change.`,
    options: [
      { id: "a", text: "Correct understanding of the change." },
      { id: "b", text: "A plausible but wrong explanation." },
      { id: "c", text: "An unrelated statement." },
      { id: "d", text: "Implementation trivia." },
    ],
    correctOptionId,
  };
}

describe("merge-readiness runtime", () => {
  let tempDir: string;
  const sessionId = "merge-readiness-session";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "omc-merge-readiness-"));
    execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore", windowsHide: true });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir, stdio: "ignore", windowsHide: true });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir, stdio: "ignore", windowsHide: true });
    writeFileSync(join(tempDir, "README.md"), "before\n");
    execFileSync("git", ["add", "README.md"], { cwd: tempDir, stdio: "ignore", windowsHide: true });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: tempDir, stdio: "ignore", windowsHide: true });
    writeFileSync(join(tempDir, "README.md"), "after\n");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates the authoritative audit state without writing a report artifact", () => {
    const state = createInitialMergeReadinessState(
      tempDir,
      "/merge-readiness --standard improve docs after review",
      sessionId,
    );

    expect(state.active).toBe(true);
    expect(state.current_phase).toBe("merge-readiness");
    expect(state.phase).toBe("content");
    expect(state.awaiting_content).toBe(true);
    expect(state.questions).toEqual([]);
    expect(state.answers).toEqual([]);
    expect(state.threshold).toBe(0.8);
    expect(state.max_rounds).toBe(5);
    expect(state.required_dimensions).toEqual(["why", "change", "tradeoff", "risk", "team"]);
    expect(state.evidence.changedFiles).toContain("README.md");
    expect("artifact_path" in state).toBe(false);
    expect(existsSync(join(tempDir, ".omc", "artifacts", "merge-readiness"))).toBe(false);
    const persisted = readMergeReadinessState(tempDir, sessionId);
    expect(persisted?.result).toBe("pending");
    expect(persisted?.change_summary).toBe(state.change_summary);
    expect(persisted?.evidence.changedFiles).toEqual(state.evidence.changedFiles);
  });

  it("uses quick profile thresholds (0.70 / 3 rounds / why-change-risk)", () => {
    const state = createInitialMergeReadinessState(tempDir, "/merge-readiness --quick docs gate", sessionId);
    expect(state.profile).toBe("quick");
    expect(state.threshold).toBe(0.7);
    expect(state.max_rounds).toBe(3);
    expect(state.required_dimensions).toEqual(["why", "change", "risk"]);
  });

  it("uses deep profile thresholds (0.90 / 8 rounds / all five dims)", () => {
    const state = createInitialMergeReadinessState(tempDir, "/merge-readiness --deep risky change", sessionId);
    expect(state.profile).toBe("deep");
    expect(state.threshold).toBe(0.9);
    expect(state.max_rounds).toBe(8);
    expect(state.required_dimensions).toEqual(["why", "change", "tradeoff", "risk", "team"]);
  });

  it("setMergeReadinessContent persists doc + MCQs in state and arms first MCQ", () => {
    createInitialMergeReadinessState(tempDir, "/merge-readiness --standard explain docs change", sessionId);
    const questions: MergeReadinessMCQQuestion[] = [
      makeQuestion("q1", "why"),
      makeQuestion("q2", "change"),
      makeQuestion("q3", "tradeoff"),
      makeQuestion("q4", "risk"),
      makeQuestion("q5", "team"),
    ];
    const state = setMergeReadinessContent(
      tempDir,
      {
        why: "Why text",
        whatChanged: "What changed text",
        tradeoffs: "Tradeoff text",
        risksConsidered: "Risk text",
        teamUnderstanding: "Team text",
        questions,
      },
      sessionId,
    );

    expect(state?.awaiting_content).toBe(false);
    expect(state?.questions).toHaveLength(5);
    expect(state?.why).toBe("Why text");
    expect(state?.pending_question?.id).toBe("q1");
    expect(readMergeReadinessState(tempDir, sessionId)?.whatChanged).toBe("What changed text");
    expect(existsSync(join(tempDir, ".omc", "artifacts", "merge-readiness"))).toBe(false);
  });

  it("passes when all required MCQs answered correctly (correctness rate >= threshold)", () => {
    createInitialMergeReadinessState(tempDir, "/merge-readiness --standard explain docs change", sessionId);
    setMergeReadinessContent(
      tempDir,
      {
        why: "Why",
        whatChanged: "What",
        tradeoffs: "Tradeoff",
        risksConsidered: "Risk",
        teamUnderstanding: "Team",
        questions: [
          makeQuestion("q1", "why"),
          makeQuestion("q2", "change"),
          makeQuestion("q3", "tradeoff"),
          makeQuestion("q4", "risk"),
          makeQuestion("q5", "team"),
        ],
      },
      sessionId,
    );

    for (const id of ["q1", "q2", "q3", "q4", "q5"]) {
      recordMergeReadinessMCQAnswer(tempDir, id, "a", sessionId);
    }

    const state = readMergeReadinessState(tempDir, sessionId);
    expect(state?.active).toBe(false);
    expect(state?.result).toBe("pass");
    expect(state?.readiness_score).toBe(1);
    expect(state?.completed_at).toBeTruthy();
  });

  it("pauses when all required MCQs answered but correctness rate below threshold", () => {
    createInitialMergeReadinessState(tempDir, "/merge-readiness --deep risky change", sessionId);
    setMergeReadinessContent(
      tempDir,
      {
        why: "Why",
        whatChanged: "What",
        tradeoffs: "Tradeoff",
        risksConsidered: "Risk",
        teamUnderstanding: "Team",
        questions: [
          makeQuestion("q1", "why"),
          makeQuestion("q2", "change"),
          makeQuestion("q3", "tradeoff"),
          makeQuestion("q4", "risk"),
          makeQuestion("q5", "team"),
        ],
      },
      sessionId,
    );

    // Answer 2/5 correctly -> 0.4 < deep threshold 0.90 -> paused.
    recordMergeReadinessMCQAnswer(tempDir, "q1", "a", sessionId);
    recordMergeReadinessMCQAnswer(tempDir, "q2", "a", sessionId);
    recordMergeReadinessMCQAnswer(tempDir, "q3", "b", sessionId);
    recordMergeReadinessMCQAnswer(tempDir, "q4", "b", sessionId);
    recordMergeReadinessMCQAnswer(tempDir, "q5", "b", sessionId);

    const state = readMergeReadinessState(tempDir, sessionId);
    expect(state?.active).toBe(true);
    expect(state?.result).toBe("paused");
    expect(state?.readiness_score).toBeCloseTo(0.4, 5);
  });

  it("rejects content that does not cover every required dimension (anti-gaming)", () => {
    createInitialMergeReadinessState(tempDir, "/merge-readiness --quick change", sessionId);
    // quick requires why/change/risk; omit "change" so a high score cannot pass without coverage.
    const state = setMergeReadinessContent(tempDir, {
      why: "w", whatChanged: "wc", tradeoffs: "t", risksConsidered: "r", teamUnderstanding: "tu",
      questions: [makeQuestion("q1", "why"), makeQuestion("q2", "why"), makeQuestion("q3", "risk")],
    }, sessionId);
    expect(state?.validation_errors?.some((e) => e.includes("change"))).toBe(true);
    expect(state?.phase).toBe("content");
    expect(state?.result).toBe("pending");
  });

  it("does not start the gate on an unrelated artifact (fail-open fix)", () => {
    const dir = mkdtempSync(join(tmpdir(), "omc-mr-unrelated-"));
    try {
      execFileSync("git", ["init"], { cwd: dir, stdio: "ignore", windowsHide: true });
      execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir, stdio: "ignore", windowsHide: true });
      execFileSync("git", ["config", "user.name", "T"], { cwd: dir, stdio: "ignore", windowsHide: true });
      writeFileSync(join(dir, "README.md"), "x\n");
      execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore", windowsHide: true });
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore", windowsHide: true });
      // Clean tree (no diff) + an unrelated plans file: must block, not start pending.
      mkdirSync(join(dir, ".omc", "plans"), { recursive: true });
      writeFileSync(join(dir, ".omc", "plans", "unrelated.md"), "notes\n");
      const state = createInitialMergeReadinessState(dir, "/merge-readiness --standard change", sessionId);
      expect(state.result).toBe("blocked");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts the gate on a specs-only repo (scan scope fix)", () => {
    const dir = mkdtempSync(join(tmpdir(), "omc-mr-specs-"));
    try {
      execFileSync("git", ["init"], { cwd: dir, stdio: "ignore", windowsHide: true });
      execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir, stdio: "ignore", windowsHide: true });
      execFileSync("git", ["config", "user.name", "T"], { cwd: dir, stdio: "ignore", windowsHide: true });
      writeFileSync(join(dir, "README.md"), "x\n");
      execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore", windowsHide: true });
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore", windowsHide: true });
      // Clean tree + a specs file: specs is now scanned and matches the test-evidence regex.
      mkdirSync(join(dir, ".omc", "specs"), { recursive: true });
      writeFileSync(join(dir, ".omc", "specs", "design.md"), "spec for the change\n");
      const state = createInitialMergeReadinessState(dir, "/merge-readiness --standard change", sessionId);
      expect(state.result).toBe("pending");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves prior terminal attempts across re-start (audit history)", () => {
    createInitialMergeReadinessState(tempDir, "/merge-readiness --quick change", sessionId);
    setMergeReadinessContent(tempDir, {
      why: "w", whatChanged: "wc", tradeoffs: "t", risksConsidered: "r", teamUnderstanding: "tu",
      questions: [makeQuestion("q1", "why"), makeQuestion("q2", "change"), makeQuestion("q3", "risk")],
    }, sessionId);
    // Answer all wrong -> 0/3 = 0 < quick threshold 0.70 -> paused.
    recordMergeReadinessMCQAnswer(tempDir, "q1", "b", sessionId);
    recordMergeReadinessMCQAnswer(tempDir, "q2", "b", sessionId);
    recordMergeReadinessMCQAnswer(tempDir, "q3", "b", sessionId);
    expect(readMergeReadinessState(tempDir, sessionId)?.result).toBe("paused");
    // Re-start should preserve the prior paused attempt in prior_attempts.
    const state = createInitialMergeReadinessState(tempDir, "/merge-readiness --quick retry", sessionId);
    expect(state.prior_attempts?.length).toBe(1);
    expect(state.prior_attempts?.[0].result).toBe("paused");
  });

  it("preserves a full prior-attempt audit record with questions, answers, and scores", () => {
    createInitialMergeReadinessState(tempDir, "/merge-readiness --quick change", sessionId);
    setMergeReadinessContent(tempDir, {
      why: "w", whatChanged: "wc", tradeoffs: "t", risksConsidered: "r", teamUnderstanding: "tu",
      questions: [
        makeQuestion("q1", "why", "a"),
        makeQuestion("q2", "change", "a"),
        makeQuestion("q3", "risk", "a"),
      ],
    }, sessionId);
    // Answer all wrong -> 0/3 = 0 < quick threshold 0.70 -> paused.
    recordMergeReadinessMCQAnswer(tempDir, "q1", "b", sessionId);
    recordMergeReadinessMCQAnswer(tempDir, "q2", "b", sessionId);
    recordMergeReadinessMCQAnswer(tempDir, "q3", "b", sessionId);
    expect(readMergeReadinessState(tempDir, sessionId)?.result).toBe("paused");

    // First re-start: the prior paused attempt is captured in full.
    const state = createInitialMergeReadinessState(tempDir, "/merge-readiness --quick retry", sessionId);
    expect(state.prior_attempts?.length).toBe(1);
    const prior = state.prior_attempts?.[0];
    expect(prior).toBeDefined();
    expect(prior?.result).toBe("paused");
    expect(prior?.readiness_score).toBe(0);
    // Full questions retained with correctOptionId (terminal, safe to reveal).
    expect(prior?.questions).toHaveLength(3);
    expect(prior?.questions.every((q) => typeof q.correctOptionId === "string")).toBe(true);
    // Full answers retained with isCorrect=false (all wrong).
    expect(prior?.answers).toHaveLength(3);
    expect(prior?.answers.every((a) => a.isCorrect === false)).toBe(true);
    // Dimension scores captured.
    expect(prior?.dimension_scores).toBeDefined();
    expect(Object.keys(prior?.dimension_scores ?? {}).length).toBeGreaterThan(0);
    // Evidence summary captured.
    expect(prior?.evidence_summary.sourceArtifactCount).toBeDefined();
    expect(prior?.evidence_summary.testEvidenceCount).toBeDefined();

    // Take the first re-start's gate to a terminal result so a second re-start
    // can append (a pending gate is not captured as a prior attempt).
    setMergeReadinessContent(tempDir, {
      why: "w2", whatChanged: "wc2", tradeoffs: "t2", risksConsidered: "r2", teamUnderstanding: "tu2",
      questions: [
        makeQuestion("q1", "why", "a"),
        makeQuestion("q2", "change", "a"),
        makeQuestion("q3", "risk", "a"),
      ],
    }, sessionId);
    recordMergeReadinessMCQAnswer(tempDir, "q1", "b", sessionId);
    recordMergeReadinessMCQAnswer(tempDir, "q2", "b", sessionId);
    recordMergeReadinessMCQAnswer(tempDir, "q3", "b", sessionId);
    expect(readMergeReadinessState(tempDir, sessionId)?.result).toBe("paused");

    // Second re-start appends a second prior attempt (does not overwrite).
    const state2 = createInitialMergeReadinessState(tempDir, "/merge-readiness --quick retry2", sessionId);
    expect(state2.prior_attempts?.length).toBe(2);
  });

  it("fails closed when state cannot be persisted (invalid session id)", () => {
    // tempDir has a diff, so without the persistence failure this would be pending.
    const state = createInitialMergeReadinessState(tempDir, "/merge-readiness --quick change", "bad/session");
    expect(state.result).toBe("blocked");
    expect(state.validation_errors?.some((e) => e.includes("persisted"))).toBe(true);
  });

  it("mutators never surface a phantom pass/override when the write cannot land", () => {
    // Seed a valid, active, passing gate under a good session.
    createInitialMergeReadinessState(tempDir, "/merge-readiness --quick change", sessionId);
    setMergeReadinessContent(tempDir, {
      why: "w", whatChanged: "wc", tradeoffs: "t", risksConsidered: "r", teamUnderstanding: "tu",
      questions: [makeQuestion("q1", "why"), makeQuestion("q2", "change"), makeQuestion("q3", "risk")],
    }, sessionId);
    recordMergeReadinessMCQAnswer(tempDir, "q1", "a", sessionId);
    recordMergeReadinessMCQAnswer(tempDir, "q2", "a", sessionId);
    recordMergeReadinessMCQAnswer(tempDir, "q3", "a", sessionId);
    expect(readMergeReadinessState(tempDir, sessionId)?.result).toBe("pass");

    // With an invalid session id, the mutator's read path throws (validateSessionId
    // rejects path separators). The contract: the mutator must NOT return a
    // phantom active=false/overridden/pass result when the write cannot land.
    // It throws rather than silently producing a phantom release.
    expect(() => overrideMergeReadiness(tempDir, "Maintainer override.", "bad/session")).toThrow();
    expect(() => cancelMergeReadiness(tempDir, "bad/session")).toThrow();
    // The valid gate is untouched: still a real pass under the good session.
    expect(readMergeReadinessState(tempDir, sessionId)?.result).toBe("pass");
  });

  it("fails closed without recursing when a mutator's write cannot land (read-only FS / full disk)", () => {
    // Seed an active, non-blocked gate under a valid session: real writes succeed
    // and reads still resolve the on-disk state, so the mutator reaches
    // persistOrFailClosed rather than failing earlier on the read path.
    createInitialMergeReadinessState(tempDir, "/merge-readiness --quick change", sessionId);
    setMergeReadinessContent(tempDir, {
      why: "w", whatChanged: "wc", tradeoffs: "t", risksConsidered: "r", teamUnderstanding: "tu",
      questions: [makeQuestion("q1", "why"), makeQuestion("q2", "change"), makeQuestion("q3", "risk")],
    }, sessionId);
    // The next write fails the way writeModeState fails on a read-only FS / full
    // disk: it returns false (does not throw). Previously persistOrFailClosed
    // recursed with identical args here and overflowed the stack (RangeError),
    // also appending a duplicate error per frame.
    persistFail.failWrites = true;
    try {
      const state = overrideMergeReadiness(tempDir, "Maintainer override.", sessionId);
      expect(state?.result).toBe("blocked");
      expect(state?.active).toBe(true);
      expect(state?.validation_errors?.some((e) => e.includes("persisted"))).toBe(true);
      // The fail-closed error must appear exactly once - no unbounded recursion.
      expect(state?.validation_errors?.filter((e) => e.includes("persisted"))).toHaveLength(1);
    } finally {
      persistFail.failWrites = false;
    }
  });

  it("blocked gate message directs to evidence, not content submission", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omc-mr-blocked-msg-"));
    try {
      execFileSync("git", ["init"], { cwd: dir, stdio: "ignore", windowsHide: true });
      execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir, stdio: "ignore", windowsHide: true });
      execFileSync("git", ["config", "user.name", "T"], { cwd: dir, stdio: "ignore", windowsHide: true });
      writeFileSync(join(dir, "README.md"), "x\n");
      execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore", windowsHide: true });
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore", windowsHide: true });
      // Clean tree, no artifacts -> blocked.
      createInitialMergeReadinessState(dir, "/merge-readiness --standard change", sessionId);
      const result = await checkMergeReadiness(sessionId, dir, false);
      expect(result?.message).toContain("Minimal evidence");
      expect(result?.message).not.toContain("setMergeReadinessContent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks when minimal evidence is missing (no diff/change signal)", () => {
    // Fresh git repo with no changes and no status.
    const emptyDir = mkdtempSync(join(tmpdir(), "omc-merge-readiness-empty-"));
    try {
      execFileSync("git", ["init"], { cwd: emptyDir, stdio: "ignore", windowsHide: true });
      execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: emptyDir, stdio: "ignore", windowsHide: true });
      execFileSync("git", ["config", "user.name", "T"], { cwd: emptyDir, stdio: "ignore", windowsHide: true });

      createInitialMergeReadinessState(emptyDir, "/merge-readiness --standard no changes here", sessionId);
      setMergeReadinessContent(
        emptyDir,
        {
          why: "Why",
          whatChanged: "What",
          tradeoffs: "Tradeoff",
          risksConsidered: "Risk",
          teamUnderstanding: "Team",
          questions: [makeQuestion("q1", "why"), makeQuestion("q2", "change"), makeQuestion("q3", "tradeoff"), makeQuestion("q4", "risk"), makeQuestion("q5", "team")],
        },
        sessionId,
      );

      recordMergeReadinessMCQAnswer(emptyDir, "q1", "a", sessionId);
      recordMergeReadinessMCQAnswer(emptyDir, "q2", "a", sessionId);
      recordMergeReadinessMCQAnswer(emptyDir, "q3", "a", sessionId);
      recordMergeReadinessMCQAnswer(emptyDir, "q4", "a", sessionId);
      recordMergeReadinessMCQAnswer(emptyDir, "q5", "a", sessionId);

      const state = readMergeReadinessState(emptyDir, sessionId);
      expect(state?.result).toBe("blocked");
      expect(state?.active).toBe(true);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("parses source flags exactly and rejects conflicting source modes", () => {
    const lookalike = createInitialMergeReadinessState(tempDir, "/merge-readiness summary--from-diff", sessionId);
    expect(lookalike.source_mode).toBeUndefined();
    expect(lookalike.result).toBe("pending");

    const conflicting = createInitialMergeReadinessState(
      tempDir,
      "/merge-readiness --from-diff --from-artifacts change",
      "conflicting-source-session",
    );
    expect(conflicting.result).toBe("blocked");
    expect(conflicting.validation_errors).toContain("--from-diff and --from-artifacts cannot be used together.");
    expect(setMergeReadinessContent(tempDir, {
      why: "Why", whatChanged: "What", tradeoffs: "Tradeoff", risksConsidered: "Risk", teamUnderstanding: "Team",
      questions: [makeQuestion("q1", "why"), makeQuestion("q2", "change"), makeQuestion("q3", "tradeoff"), makeQuestion("q4", "risk"), makeQuestion("q5", "team")],
    }, "conflicting-source-session")?.result).toBe("blocked");
  });

  it("does not accept untracked files as --from-diff evidence", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "omc-merge-readiness-untracked-"));
    try {
      execFileSync("git", ["init"], { cwd: emptyDir, stdio: "ignore", windowsHide: true });
      execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: emptyDir, stdio: "ignore", windowsHide: true });
      execFileSync("git", ["config", "user.name", "T"], { cwd: emptyDir, stdio: "ignore", windowsHide: true });
      writeFileSync(join(emptyDir, "tracked.md"), "tracked\n");
      execFileSync("git", ["add", "tracked.md"], { cwd: emptyDir, stdio: "ignore", windowsHide: true });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: emptyDir, stdio: "ignore", windowsHide: true });
      writeFileSync(join(emptyDir, "untracked.md"), "untracked\n");

      const state = createInitialMergeReadinessState(emptyDir, "/merge-readiness --from-diff only untracked", sessionId);
      expect(state.evidence.untrackedFiles).toEqual(["untracked.md"]);
      expect(state.evidence.changedFiles).toEqual([]);
      expect(state.result).toBe("blocked");
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("cancels a blocked gate while retaining a terminal audit record", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "omc-merge-readiness-cancel-"));
    try {
      execFileSync("git", ["init"], { cwd: emptyDir, stdio: "ignore", windowsHide: true });
      const state = createInitialMergeReadinessState(emptyDir, "/merge-readiness --from-diff no changes", sessionId);
      expect(state.result).toBe("blocked");
      const cancelled = cancelMergeReadiness(emptyDir, sessionId);
      expect(cancelled?.result).toBe("cancelled");
      expect(cancelled?.active).toBe(false);
      expect(readMergeReadinessState(emptyDir, sessionId)?.result).toBe("cancelled");
      expect("artifact_path" in cancelled!).toBe(false);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("scores MCQ answers objectively (selectedOptionId === correctOptionId)", () => {
    createInitialMergeReadinessState(tempDir, "/merge-readiness --quick docs gate", sessionId);
    setMergeReadinessContent(
      tempDir,
      {
        why: "Why",
        whatChanged: "What",
        tradeoffs: "Tradeoff",
        risksConsidered: "Risk",
        teamUnderstanding: "Team",
        questions: [
          makeQuestion("q1", "why", "a"),
          makeQuestion("q2", "change", "b"),
          makeQuestion("q3", "risk", "c"),
        ],
      },
      sessionId,
    );

    recordMergeReadinessMCQAnswer(tempDir, "q1", "a", sessionId); // correct
    recordMergeReadinessMCQAnswer(tempDir, "q2", "a", sessionId); // wrong (correct is b)

    const state = readMergeReadinessState(tempDir, sessionId);
    expect(state?.answers).toHaveLength(2);
    expect(state?.answers[0].isCorrect).toBe(true);
    expect(state?.answers[1].isCorrect).toBe(false);
  });

  it("blocks stop while awaiting content", async () => {
    createInitialMergeReadinessState(tempDir, "/merge-readiness --quick docs gate", sessionId);

    const result = await checkMergeReadiness(sessionId, tempDir, false);

    expect(result?.shouldBlock).toBe(true);
    expect(result?.message).toContain("[MERGE READINESS BLOCKED]");
    expect(result?.message).toContain("awaiting");
  });

  it("blocks stop and shows the pending MCQ after content is set", async () => {
    createInitialMergeReadinessState(tempDir, "/merge-readiness --quick docs gate", sessionId);
    setMergeReadinessContent(
      tempDir,
      {
        why: "Why",
        whatChanged: "What",
        tradeoffs: "Tradeoff",
        risksConsidered: "Risk",
        teamUnderstanding: "Team",
        questions: [makeQuestion("q1", "why"), makeQuestion("q2", "change"), makeQuestion("q3", "risk")],
      },
      sessionId,
    );

    const result = await checkMergeReadiness(sessionId, tempDir, false);

    expect(result?.shouldBlock).toBe(true);
    expect(result?.message).toContain("[MERGE READINESS BLOCKED]");
    expect(result?.message).toContain("[why]");
    expect(result?.message).toContain("(1/3)");
  });

  it("releases stop after the gate passes", async () => {
    createInitialMergeReadinessState(tempDir, "/merge-readiness --quick docs gate", sessionId);
    setMergeReadinessContent(
      tempDir,
      {
        why: "Why",
        whatChanged: "What",
        tradeoffs: "Tradeoff",
        risksConsidered: "Risk",
        teamUnderstanding: "Team",
        questions: [makeQuestion("q1", "why"), makeQuestion("q2", "change"), makeQuestion("q3", "risk")],
      },
      sessionId,
    );

    recordMergeReadinessMCQAnswer(tempDir, "q1", "a", sessionId);
    recordMergeReadinessMCQAnswer(tempDir, "q2", "a", sessionId);
    recordMergeReadinessMCQAnswer(tempDir, "q3", "a", sessionId);

    const result = await checkMergeReadiness(sessionId, tempDir, false);
    expect(result).toBeNull();
  });

  it("keeps invalid content recoverable and does not arm a dead-end quiz", () => {
    createInitialMergeReadinessState(tempDir, "/merge-readiness --quick docs gate", sessionId);
    const state = setMergeReadinessContent(tempDir, {
      why: "", whatChanged: "What", tradeoffs: "Tradeoff", risksConsidered: "Risk", teamUnderstanding: "Team",
      questions: [makeQuestion("q1", "why")],
    }, sessionId);
    expect(state?.awaiting_content).toBe(true);
    expect(state?.pending_question).toBeUndefined();
    expect(state?.validation_errors?.join(" ")).toContain("Narrative section 'why'");
  });

  it("keeps correct-option metadata only in the authoritative state before completion", () => {
    createInitialMergeReadinessState(tempDir, "/merge-readiness --quick docs gate", sessionId);
    const state = setMergeReadinessContent(tempDir, {
      why: "Why", whatChanged: "What", tradeoffs: "Tradeoff", risksConsidered: "Risk", teamUnderstanding: "Team",
      questions: [makeQuestion("q1", "why"), makeQuestion("q2", "change"), makeQuestion("q3", "risk")],
    }, sessionId);
    expect(state?.result).toBe("pending");
    expect(state?.answers).toEqual([]);
  });

  it("requires an offered option and the active question before recording an answer", () => {
    createInitialMergeReadinessState(tempDir, "/merge-readiness --quick docs gate", sessionId);
    setMergeReadinessContent(tempDir, {
      why: "Why", whatChanged: "What", tradeoffs: "Tradeoff", risksConsidered: "Risk", teamUnderstanding: "Team",
      questions: [makeQuestion("q1", "why"), makeQuestion("q2", "change"), makeQuestion("q3", "risk")],
    }, sessionId);
    recordMergeReadinessMCQAnswer(tempDir, "q2", "a", sessionId);
    recordMergeReadinessMCQAnswer(tempDir, "q1", "not-an-option", sessionId);
    expect(readMergeReadinessState(tempDir, sessionId)?.answers).toEqual([]);
  });

  it("releases the soft gate only through a reasoned override", async () => {
    createInitialMergeReadinessState(tempDir, "/merge-readiness --quick docs gate", sessionId);
    expect(overrideMergeReadiness(tempDir, "", sessionId)?.result).toBe("pending");
    expect(overrideMergeReadiness(tempDir, "Maintainer accepts the documented gap.", sessionId)?.result).toBe("overridden");
    expect(await checkMergeReadiness(sessionId, tempDir, false)).toBeNull();
  });

  it("rejects ambiguous AskUserQuestion output instead of guessing an answer", () => {
    createInitialMergeReadinessState(tempDir, "/merge-readiness --quick docs gate", sessionId);
    setMergeReadinessContent(tempDir, {
      why: "Why", whatChanged: "What", tradeoffs: "Tradeoff", risksConsidered: "Risk", teamUnderstanding: "Team",
      questions: [makeQuestion("q1", "why"), makeQuestion("q2", "change"), makeQuestion("q3", "risk")],
    }, sessionId);
    recordMergeReadinessAskUserQuestionResult(tempDir, { question: "[MERGE READINESS:q1] choose" }, "selected [a] or [b]", sessionId);
    expect(readMergeReadinessState(tempDir, sessionId)?.answers).toEqual([]);
  });

  it("does not start the gate on an unrelated artifact in --from-artifacts mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "omc-mr-artifacts-unrelated-"));
    try {
      execFileSync("git", ["init"], { cwd: dir, stdio: "ignore", windowsHide: true });
      execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir, stdio: "ignore", windowsHide: true });
      execFileSync("git", ["config", "user.name", "T"], { cwd: dir, stdio: "ignore", windowsHide: true });
      writeFileSync(join(dir, "README.md"), "x\n");
      execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore", windowsHide: true });
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore", windowsHide: true });
      // Clean tree (no diff) + an unrelated plans file under --from-artifacts:
      // must block, since the artifact is neither a test nor a review artifact.
      mkdirSync(join(dir, ".omc", "plans"), { recursive: true });
      writeFileSync(join(dir, ".omc", "plans", "unrelated.md"), "notes\n");
      const state = createInitialMergeReadinessState(dir, "/merge-readiness --from-artifacts change", sessionId);
      expect(state.result).toBe("blocked");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scans later artifact roots after an earlier root fills its per-directory cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "omc-mr-perroot-cap-"));
    try {
      execFileSync("git", ["init"], { cwd: dir, stdio: "ignore", windowsHide: true });
      execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir, stdio: "ignore", windowsHide: true });
      execFileSync("git", ["config", "user.name", "T"], { cwd: dir, stdio: "ignore", windowsHide: true });
      writeFileSync(join(dir, "README.md"), "x\n");
      execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore", windowsHide: true });
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore", windowsHide: true });
      // Clean tree (no diff). plans/ has 45 unrelated files - more than the
      // 40-per-root cap. specs/ has one valid test-evidence file. Previously the
      // global 40-file cap was exhausted by plans/ and specs/ was never scanned,
      // so --from-artifacts blocked despite valid evidence in a later root.
      mkdirSync(join(dir, ".omc", "plans"), { recursive: true });
      for (let i = 0; i < 45; i++) {
        writeFileSync(join(dir, ".omc", "plans", `plan-${i}.md`), `plan notes ${i}\n`);
      }
      mkdirSync(join(dir, ".omc", "specs"), { recursive: true });
      writeFileSync(join(dir, ".omc", "specs", "design.md"), "spec for the change\n");
      const state = createInitialMergeReadinessState(dir, "/merge-readiness --from-artifacts change", sessionId);
      expect(state.evidence.sourceArtifacts).toContain("specs/design.md");
      expect(state.result).toBe("pending");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts an active ralph mode-state file as evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "omc-mr-ralph-state-"));
    try {
      execFileSync("git", ["init"], { cwd: dir, stdio: "ignore", windowsHide: true });
      execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir, stdio: "ignore", windowsHide: true });
      execFileSync("git", ["config", "user.name", "T"], { cwd: dir, stdio: "ignore", windowsHide: true });
      writeFileSync(join(dir, "README.md"), "x\n");
      execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore", windowsHide: true });
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore", windowsHide: true });
      // Clean tree, but an active ralph mode-state file records a real run.
      mkdirSync(join(dir, ".omc", "state"), { recursive: true });
      writeFileSync(
        join(dir, ".omc", "state", "ralph-state.json"),
        JSON.stringify({ active: true, iteration: 3, started_at: "2026-01-01T00:00:00.000Z", phase: "execute" }),
      );
      const state = createInitialMergeReadinessState(dir, "/merge-readiness --standard change", sessionId);
      expect(state.evidence.sourceArtifacts).toContain("state/ralph-state.json");
      expect(state.result).toBe("pending");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not count a stale/empty mode-state stub as evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "omc-mr-stale-state-"));
    try {
      execFileSync("git", ["init"], { cwd: dir, stdio: "ignore", windowsHide: true });
      execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir, stdio: "ignore", windowsHide: true });
      execFileSync("git", ["config", "user.name", "T"], { cwd: dir, stdio: "ignore", windowsHide: true });
      writeFileSync(join(dir, "README.md"), "x\n");
      execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore", windowsHide: true });
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore", windowsHide: true });
      // Clean tree + a stale ralph-state stub (active:false, phase:init) and a
      // bookkeeping ralph-stop-breaker.json: neither records a real run.
      mkdirSync(join(dir, ".omc", "state"), { recursive: true });
      writeFileSync(
        join(dir, ".omc", "state", "ralph-state.json"),
        JSON.stringify({ active: false, phase: "init" }),
      );
      writeFileSync(
        join(dir, ".omc", "state", "ralph-stop-breaker.json"),
        JSON.stringify({ active: true, iteration: 5 }),
      );
      const state = createInitialMergeReadinessState(dir, "/merge-readiness --standard change", sessionId);
      expect(state.evidence.sourceArtifacts).toEqual([]);
      expect(state.result).toBe("blocked");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
