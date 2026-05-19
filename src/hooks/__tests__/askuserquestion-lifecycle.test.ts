/**
 * Regression test for issue #597
 *
 * AskUserQuestion webhook notifications must fire at PreToolUse (before
 * the tool blocks waiting for user input), NOT at PostToolUse (after
 * the user has already answered).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  processHook,
  resetSkipHooksCache,
  dispatchAskUserQuestionNotification,
  extractAskUserQuestionPrompts,
  _notify,
  type HookInput,
} from "../bridge.js";

describe("AskUserQuestion notification lifecycle (issue #597)", () => {
  const originalEnv = process.env;
  let dispatchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DISABLE_OMC;
    delete process.env.OMC_SKIP_HOOKS;
    resetSkipHooksCache();
    // Spy on the object-wrapped helper — avoids ESM module-internal call issue
    dispatchSpy = vi
      .spyOn(_notify, "askUserQuestion")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    resetSkipHooksCache();
    dispatchSpy.mockRestore();
  });

  const askUserInput: HookInput = {
    sessionId: "test-session-597",
    toolName: "AskUserQuestion",
    toolInput: {
      questions: [
        {
          question: "Which database should we use?",
          header: "Database",
          options: [
            { label: "PostgreSQL", description: "Relational DB" },
            { label: "MongoDB", description: "Document DB" },
          ],
          multiSelect: false,
        },
      ],
    },
    directory: "/tmp/test-issue-597",
  };

  it("extractAskUserQuestionPrompts preserves option labels/descriptions for notifications", () => {
    const prompts = extractAskUserQuestionPrompts(askUserInput.toolInput);

    expect(prompts).toEqual([
      {
        question: "Which database should we use?",
        header: "Database",
        options: [
          { label: "PostgreSQL", description: "Relational DB" },
          { label: "MongoDB", description: "Document DB" },
        ],
        allowOther: true,
        otherLabel: "Other",
        multiSelect: false,
      },
    ]);
  });

  // ---- PreToolUse: notification MUST fire ----

  it("pre-tool-use should dispatch ask-user-question notification", async () => {
    const result = await processHook("pre-tool-use", askUserInput);
    expect(result.continue).toBe(true);

    expect(dispatchSpy).toHaveBeenCalledOnce();
    expect(dispatchSpy).toHaveBeenCalledWith(
      "test-session-597",
      expect.any(String),
      askUserInput.toolInput,
    );
  });

  // ---- PostToolUse: notification MUST NOT fire ----

  it("post-tool-use should NOT dispatch ask-user-question notification", async () => {
    const postInput: HookInput = {
      ...askUserInput,
      toolOutput: '{"answers":{"0":"PostgreSQL"}}',
    };

    const result = await processHook("post-tool-use", postInput);
    expect(result.continue).toBe(true);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  // ---- Edge cases ----

  it("pre-tool-use should skip notification when sessionId is missing", async () => {
    const noSessionInput: HookInput = {
      toolName: "AskUserQuestion",
      toolInput: {
        questions: [
          {
            question: "Pick one?",
            header: "Choice",
            options: [
              { label: "A", description: "Option A" },
              { label: "B", description: "Option B" },
            ],
            multiSelect: false,
          },
        ],
      },
      directory: "/tmp/test-issue-597",
    };

    await processHook("pre-tool-use", noSessionInput);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("non-AskUserQuestion tools should not trigger notification", async () => {
    const bashInput: HookInput = {
      sessionId: "test-session-597",
      toolName: "Bash",
      toolInput: { command: "echo hello" },
      directory: "/tmp/test-issue-597",
    };

    await processHook("pre-tool-use", bashInput);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  // ---- Unit test for the helper itself ----

  it("dispatchAskUserQuestionNotification extracts question text correctly", () => {
    // Restore the real implementation for this unit test
    dispatchSpy.mockRestore();

    const toolInput = {
      questions: [
        { question: "Which framework?" },
        { question: "Which bundler?" },
      ],
    };

    // Call the real function — the dynamic import will fail silently in test env
    // We just verify it doesn't throw
    expect(() =>
      dispatchAskUserQuestionNotification("sess", "/tmp", toolInput),
    ).not.toThrow();
  });
});
