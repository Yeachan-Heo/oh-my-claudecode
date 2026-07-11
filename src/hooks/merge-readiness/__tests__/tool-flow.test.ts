import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stateTools } from "../../../tools/state-tools.js";
import { readMergeReadinessState, writeMergeReadinessState } from "../runtime.js";

// Forces writeModeState to return false (read-only FS / full-disk analog) so the
// state_clear failed-write path is exercised. Other tests unaffected while
// failWrites stays false.
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

function findTool(name: string): any {
  const tool = stateTools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
}
function textOf(res: any): string {
  return (res.content?.[0]?.text ?? "") as string;
}

describe("merge-readiness standalone tool flow", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "omc-mr-tools-"));
    execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore", windowsHide: true });
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: tempDir, stdio: "ignore", windowsHide: true });
    execFileSync("git", ["config", "user.name", "T"], { cwd: tempDir, stdio: "ignore", windowsHide: true });
    writeFileSync(join(tempDir, "README.md"), "before\n");
    execFileSync("git", ["add", "."], { cwd: tempDir, stdio: "ignore", windowsHide: true });
    execFileSync("git", ["commit", "-m", "init"], { cwd: tempDir, stdio: "ignore", windowsHide: true });
    writeFileSync(join(tempDir, "README.md"), "after\n");
    // validateWorkingDirectory trusts process.cwd()'s git root, so chdir into
    // tempDir so the tools operate on tempDir's git evidence (not the repo CWD,
    // which is a clean checkout on CI and would yield "blocked").
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    if (originalCwd) process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("start -> set_content -> record_answer reaches pass", async () => {
    const start = findTool("merge_readiness_start");
    const setContent = findTool("merge_readiness_set_content");
    const recordAnswer = findTool("merge_readiness_record_answer");
    const report = findTool("merge_readiness_report");
    const stateRead = findTool("state_read");
    const session = "flow-session";

    const startRes = await start.handler({ summary: "/merge-readiness --quick fix a bug", workingDirectory: tempDir, session_id: session });
    expect(startRes.isError).toBeFalsy();
    expect(textOf(startRes)).toContain("started");

    const questions = [
      { id: "q1", dimension: "why", stem: "why?", options: [{ id: "a", text: "correct" }, { id: "b", text: "wrong" }], correctOptionId: "a", rationale: "private rationale" },
      { id: "q2", dimension: "change", stem: "change?", options: [{ id: "a", text: "correct" }, { id: "b", text: "wrong" }], correctOptionId: "a" },
      { id: "q3", dimension: "risk", stem: "risk?", options: [{ id: "a", text: "correct" }, { id: "b", text: "wrong" }], correctOptionId: "a" },
    ];
    const contentRes = await setContent.handler({
      why: "w", whatChanged: "wc", tradeoffs: "t", risksConsidered: "r", teamUnderstanding: "tu",
      questions, workingDirectory: tempDir, session_id: session,
    });
    expect(contentRes.isError).toBeFalsy();
    expect(textOf(contentRes)).toContain("accepted");
    const pendingReport = await report.handler({ workingDirectory: tempDir, session_id: session });
    expect(textOf(pendingReport)).toContain("# Merge Readiness Report");
    expect(textOf(pendingReport)).toContain("## Why");
    expect(textOf(pendingReport)).toContain("## Merge Boundary");
    expect(textOf(pendingReport)).not.toContain("_(correct");
    expect(textOf(pendingReport)).toContain("hidden until completion");

    const firstAnswer = await recordAnswer.handler({ questionId: "q1", optionId: "a", workingDirectory: tempDir, session_id: session });
    expect(textOf(firstAnswer)).toContain("Answer recorded");
    const internalState = readMergeReadinessState(tempDir, session)!;
    internalState.rounds = [{
      round: 1,
      dimension: "why",
      question: "legacy question",
      answer: "legacy answer",
      score: 1,
      created_at: new Date().toISOString(),
    }];
    writeMergeReadinessState(tempDir, internalState, session);
    const pendingState = await stateRead.handler({ mode: "merge-readiness", workingDirectory: tempDir, session_id: session });
    expect(textOf(pendingState)).not.toContain("correctOptionId");
    expect(textOf(pendingState)).not.toContain("private rationale");
    expect(textOf(pendingState)).not.toContain("isCorrect");
    expect(textOf(pendingState)).not.toContain("readiness_score");
    expect(textOf(pendingState)).not.toContain('"score"');

    let last = "";
    for (const q of questions.slice(1)) {
      const res = await recordAnswer.handler({ questionId: q.id, optionId: "a", workingDirectory: tempDir, session_id: session });
      last = textOf(res);
    }
    expect(last).toContain("pass");
    const finalReport = await report.handler({ workingDirectory: tempDir, session_id: session });
    expect(textOf(finalReport)).toContain("Result: pass");
    expect(textOf(finalReport)).toContain("_(correct, selected)");
    const finalState = await stateRead.handler({ mode: "merge-readiness", workingDirectory: tempDir, session_id: session });
    expect(textOf(finalState)).toContain("correctOptionId");
    expect(textOf(finalState)).toContain("private rationale");
  });

  it("set_content without start errors instead of silently succeeding", async () => {
    const setContent = findTool("merge_readiness_set_content");
    const res = await setContent.handler({
      why: "w", whatChanged: "wc", tradeoffs: "t", risksConsidered: "r", teamUnderstanding: "tu",
      questions: [], workingDirectory: tempDir, session_id: "no-start-session",
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("no active gate");
  });

  it("exposes cancellation and state_clear as durable audit-preserving operations", async () => {
    const start = findTool("merge_readiness_start");
    const cancel = findTool("merge_readiness_cancel");
    const clear = findTool("state_clear");
    const session = "cancel-session";

    await start.handler({ summary: "/merge-readiness --quick change", workingDirectory: tempDir, session_id: session });
    const cancelResult = await cancel.handler({ workingDirectory: tempDir, session_id: session });
    expect(textOf(cancelResult)).toContain("cancelled");
    expect(readMergeReadinessState(tempDir, session)?.result).toBe("cancelled");

    await start.handler({ summary: "/merge-readiness --quick change", workingDirectory: tempDir, session_id: session });
    const clearResult = await clear.handler({ mode: "merge-readiness", workingDirectory: tempDir, session_id: session });
    expect(textOf(clearResult)).toContain("durable state audit records");
    expect(readMergeReadinessState(tempDir, session)?.result).toBe("cancelled");
    const repeatedClear = await clear.handler({ mode: "merge-readiness", workingDirectory: tempDir, session_id: session });
    expect(textOf(repeatedClear)).toContain("No active merge-readiness gate found");
    expect(readMergeReadinessState(tempDir, session)?.result).toBe("cancelled");
  });

  it("state_get_status does not leak correctOptionId/rationale while pending", async () => {
    const start = findTool("merge_readiness_start");
    const setContent = findTool("merge_readiness_set_content");
    const getStatus = findTool("state_get_status");
    const session = "leak-session";

    await start.handler({ summary: "/merge-readiness --quick change", workingDirectory: tempDir, session_id: session });
    await setContent.handler({
      why: "w", whatChanged: "wc", tradeoffs: "t", risksConsidered: "r", teamUnderstanding: "tu",
      questions: [
        { id: "q1", dimension: "why", stem: "why?", options: [{ id: "a", text: "correct" }, { id: "b", text: "wrong" }], correctOptionId: "a", rationale: "private rationale" },
        { id: "q2", dimension: "change", stem: "change?", options: [{ id: "a", text: "correct" }, { id: "b", text: "wrong" }], correctOptionId: "a" },
        { id: "q3", dimension: "risk", stem: "risk?", options: [{ id: "a", text: "correct" }, { id: "b", text: "wrong" }], correctOptionId: "a" },
      ],
      workingDirectory: tempDir, session_id: session,
    });

    const status = await getStatus.handler({ mode: "merge-readiness", workingDirectory: tempDir, session_id: session });
    const preview = textOf(status);
    expect(preview).not.toContain("correctOptionId");
    expect(preview).not.toContain("private rationale");
    expect(preview).not.toContain("readiness_score");
  });

  it("refuses to re-submit content on a paused (failed-quiz) gate, preserving the audit record", async () => {
    const start = findTool("merge_readiness_start");
    const setContent = findTool("merge_readiness_set_content");
    const recordAnswer = findTool("merge_readiness_record_answer");
    const session = "paused-session";

    await start.handler({ summary: "/merge-readiness --quick change", workingDirectory: tempDir, session_id: session });
    const questions = [
      { id: "q1", dimension: "why", stem: "why?", options: [{ id: "a", text: "correct" }, { id: "b", text: "wrong" }], correctOptionId: "a" },
      { id: "q2", dimension: "change", stem: "change?", options: [{ id: "a", text: "correct" }, { id: "b", text: "wrong" }], correctOptionId: "a" },
      { id: "q3", dimension: "risk", stem: "risk?", options: [{ id: "a", text: "correct" }, { id: "b", text: "wrong" }], correctOptionId: "a" },
    ];
    await setContent.handler({
      why: "w", whatChanged: "wc", tradeoffs: "t", risksConsidered: "r", teamUnderstanding: "tu",
      questions, workingDirectory: tempDir, session_id: session,
    });
    // Answer all wrong -> 0/3 = 0 < quick threshold 0.70 -> paused.
    for (const q of questions) {
      await recordAnswer.handler({ questionId: q.id, optionId: "b", workingDirectory: tempDir, session_id: session });
    }
    expect(readMergeReadinessState(tempDir, session)?.result).toBe("paused");

    // Re-submitting content on a paused gate must be refused: no fresh quiz
    // without re-collecting evidence, and the failed attempt is preserved.
    const resubmit = await setContent.handler({
      why: "w2", whatChanged: "wc2", tradeoffs: "t2", risksConsidered: "r2", teamUnderstanding: "tu2",
      questions, workingDirectory: tempDir, session_id: session,
    });
    expect(resubmit.isError).toBe(true);
    expect(textOf(resubmit)).toContain("Paused");
    expect(readMergeReadinessState(tempDir, session)?.result).toBe("paused");
  });

  it("refuses to submit content on a terminal (pass) gate instead of false-accepting", async () => {
    const start = findTool("merge_readiness_start");
    const setContent = findTool("merge_readiness_set_content");
    const recordAnswer = findTool("merge_readiness_record_answer");
    const session = "terminal-session";

    await start.handler({ summary: "/merge-readiness --quick change", workingDirectory: tempDir, session_id: session });
    const questions = [
      { id: "q1", dimension: "why", stem: "why?", options: [{ id: "a", text: "correct" }, { id: "b", text: "wrong" }], correctOptionId: "a" },
      { id: "q2", dimension: "change", stem: "change?", options: [{ id: "a", text: "correct" }, { id: "b", text: "wrong" }], correctOptionId: "a" },
      { id: "q3", dimension: "risk", stem: "risk?", options: [{ id: "a", text: "correct" }, { id: "b", text: "wrong" }], correctOptionId: "a" },
    ];
    await setContent.handler({
      why: "w", whatChanged: "wc", tradeoffs: "t", risksConsidered: "r", teamUnderstanding: "tu",
      questions, workingDirectory: tempDir, session_id: session,
    });
    for (const q of questions) {
      await recordAnswer.handler({ questionId: q.id, optionId: "a", workingDirectory: tempDir, session_id: session });
    }
    expect(readMergeReadinessState(tempDir, session)?.result).toBe("pass");
    expect(readMergeReadinessState(tempDir, session)?.active).toBe(false);

    // Gate is terminal (pass, active=false). setMergeReadinessContent returns the
    // inactive state (non-null), so the handler MUST check state.active - not
    // just null - or it false-accepts and arms a dead-end quiz on a resumed/
    // passed session.
    const resubmit = await setContent.handler({
      why: "w2", whatChanged: "wc2", tradeoffs: "t2", risksConsidered: "r2", teamUnderstanding: "tu2",
      questions, workingDirectory: tempDir, session_id: session,
    });
    expect(resubmit.isError).toBe(true);
    expect(textOf(resubmit)).toContain("no active gate");
    expect(textOf(resubmit)).not.toContain("accepted");
    // The terminal pass state is untouched (no new quiz armed).
    expect(readMergeReadinessState(tempDir, session)?.result).toBe("pass");
    expect(readMergeReadinessState(tempDir, session)?.active).toBe(false);
  });

  it("state_clear without session_id only cancels the caller's session", async () => {
    const start = findTool("merge_readiness_start");
    const clear = findTool("state_clear");
    // Start active gates in two distinct sessions.
    await start.handler({ summary: "/merge-readiness --quick change", workingDirectory: tempDir, session_id: "sess-A" });
    await start.handler({ summary: "/merge-readiness --quick change", workingDirectory: tempDir, session_id: "sess-B" });
    expect(readMergeReadinessState(tempDir, "sess-A")?.active).toBe(true);
    expect(readMergeReadinessState(tempDir, "sess-B")?.active).toBe(true);
    // Clear with no session_id, caller resolved from env = sess-A.
    const prevSid = process.env.CLAUDE_SESSION_ID;
    process.env.CLAUDE_SESSION_ID = "sess-A";
    try {
      await clear.handler({ mode: "merge-readiness", workingDirectory: tempDir });
    } finally {
      if (prevSid === undefined) delete process.env.CLAUDE_SESSION_ID; else process.env.CLAUDE_SESSION_ID = prevSid;
    }
    // sess-A cancelled, sess-B untouched (no cross-session clear).
    expect(readMergeReadinessState(tempDir, "sess-A")?.result).toBe("cancelled");
    expect(readMergeReadinessState(tempDir, "sess-B")?.active).toBe(true);
  });

  it("state_clear does not advance on-disk state on failed write (durable non-advance)", async () => {
    const start = findTool("merge_readiness_start");
    const setContent = findTool("merge_readiness_set_content");
    const clear = findTool("state_clear");
    const session = "clear-failwrite-session";

    await start.handler({ summary: "/merge-readiness --quick change", workingDirectory: tempDir, session_id: session });
    await setContent.handler({
      why: "w", whatChanged: "wc", tradeoffs: "t", risksConsidered: "r", teamUnderstanding: "tu",
      questions: [
        { id: "q1", dimension: "why", stem: "why?", options: [{ id: "a", text: "c" }, { id: "b", text: "w" }], correctOptionId: "a" },
        { id: "q2", dimension: "change", stem: "change?", options: [{ id: "a", text: "c" }, { id: "b", text: "w" }], correctOptionId: "a" },
        { id: "q3", dimension: "risk", stem: "risk?", options: [{ id: "a", text: "c" }, { id: "b", text: "w" }], correctOptionId: "a" },
      ],
      workingDirectory: tempDir, session_id: session,
    });
    expect(readMergeReadinessState(tempDir, session)?.active).toBe(true);

    persistFail.failWrites = true;
    let res: any;
    try {
      res = await clear.handler({ mode: "merge-readiness", workingDirectory: tempDir, session_id: session });
    } finally {
      persistFail.failWrites = false;
    }
    // The handler must report the failed cancellation as an error, not "no active gate".
    expect(res?.isError).toBe(true);
    expect(textOf(res)).toContain("FAILED");
    // On-disk state did not advance to cancelled; the gate stays armed.
    expect(readMergeReadinessState(tempDir, session)?.active).toBe(true);
    expect(readMergeReadinessState(tempDir, session)?.result).not.toBe("cancelled");
  });

  it("record_answer surfaces a failed write as an error, not a normal terminal", async () => {
    const start = findTool("merge_readiness_start");
    const setContent = findTool("merge_readiness_set_content");
    const recordAnswer = findTool("merge_readiness_record_answer");
    const session = "record-failwrite-session";

    await start.handler({ summary: "/merge-readiness --quick change", workingDirectory: tempDir, session_id: session });
    await setContent.handler({
      why: "w", whatChanged: "wc", tradeoffs: "t", risksConsidered: "r", teamUnderstanding: "tu",
      questions: [
        { id: "q1", dimension: "why", stem: "why?", options: [{ id: "a", text: "c" }, { id: "b", text: "w" }], correctOptionId: "a" },
        { id: "q2", dimension: "change", stem: "change?", options: [{ id: "a", text: "c" }, { id: "b", text: "w" }], correctOptionId: "a" },
        { id: "q3", dimension: "risk", stem: "risk?", options: [{ id: "a", text: "c" }, { id: "b", text: "w" }], correctOptionId: "a" },
      ],
      workingDirectory: tempDir, session_id: session,
    });

    persistFail.failWrites = true;
    let res: any;
    try {
      res = await recordAnswer.handler({ questionId: "q1", optionId: "a", workingDirectory: tempDir, session_id: session });
    } finally {
      persistFail.failWrites = false;
    }
    // The handler must report the failed answer write as an error, not "Answer recorded".
    expect(res?.isError).toBe(true);
    expect(textOf(res)).toContain("NOT recorded");
    expect(textOf(res)).not.toContain("Answer recorded");
    // On-disk answer was not advanced.
    expect(readMergeReadinessState(tempDir, session)?.answers).toEqual([]);
  });

  it("merge_readiness_cancel surfaces a failed write as an error, not no active gate", async () => {
    const start = findTool("merge_readiness_start");
    const setContent = findTool("merge_readiness_set_content");
    const cancel = findTool("merge_readiness_cancel");
    const session = "cancel-tool-failwrite-session";

    await start.handler({ summary: "/merge-readiness --quick change", workingDirectory: tempDir, session_id: session });
    await setContent.handler({
      why: "w", whatChanged: "wc", tradeoffs: "t", risksConsidered: "r", teamUnderstanding: "tu",
      questions: [
        { id: "q1", dimension: "why", stem: "why?", options: [{ id: "a", text: "c" }, { id: "b", text: "w" }], correctOptionId: "a" },
        { id: "q2", dimension: "change", stem: "change?", options: [{ id: "a", text: "c" }, { id: "b", text: "w" }], correctOptionId: "a" },
        { id: "q3", dimension: "risk", stem: "risk?", options: [{ id: "a", text: "c" }, { id: "b", text: "w" }], correctOptionId: "a" },
      ],
      workingDirectory: tempDir, session_id: session,
    });

    persistFail.failWrites = true;
    let res: any;
    try {
      res = await cancel.handler({ workingDirectory: tempDir, session_id: session });
    } finally {
      persistFail.failWrites = false;
    }
    // The direct cancel tool must report the failed write as an error, not "no active gate".
    expect(res?.isError).toBe(true);
    expect(textOf(res)).toContain("FAILED");
    expect(textOf(res)).not.toContain("no active gate");
    // On-disk gate still armed.
    expect(readMergeReadinessState(tempDir, session)?.active).toBe(true);
  });
});
