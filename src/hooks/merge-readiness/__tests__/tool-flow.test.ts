import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateTools } from "../../../tools/state-tools.js";

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
    const session = "flow-session";

    const startRes = await start.handler({ summary: "/merge-readiness --quick fix a bug", workingDirectory: tempDir, session_id: session });
    expect(startRes.isError).toBeFalsy();
    expect(textOf(startRes)).toContain("started");

    const questions = [
      { id: "q1", dimension: "why", stem: "why?", options: [{ id: "a", text: "correct" }, { id: "b", text: "wrong" }], correctOptionId: "a" },
      { id: "q2", dimension: "change", stem: "change?", options: [{ id: "a", text: "correct" }, { id: "b", text: "wrong" }], correctOptionId: "a" },
      { id: "q3", dimension: "risk", stem: "risk?", options: [{ id: "a", text: "correct" }, { id: "b", text: "wrong" }], correctOptionId: "a" },
    ];
    const contentRes = await setContent.handler({
      why: "w", whatChanged: "wc", tradeoffs: "t", risksConsidered: "r", teamUnderstanding: "tu",
      questions, workingDirectory: tempDir, session_id: session,
    });
    expect(contentRes.isError).toBeFalsy();
    expect(textOf(contentRes)).toContain("accepted");

    let last = "";
    for (const q of questions) {
      const res = await recordAnswer.handler({ questionId: q.id, optionId: "a", workingDirectory: tempDir, session_id: session });
      last = textOf(res);
    }
    expect(last).toContain("pass");
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
});
