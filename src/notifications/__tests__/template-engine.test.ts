/**
 * Tests for the template interpolation engine.
 *
 * Covers:
 * - Simple variable interpolation
 * - Missing variables become empty string
 * - {{#if}}...{{/if}} conditionals
 * - Computed variables (duration, time, modesDisplay, etc.)
 * - Default template parity with formatter.ts
 * - Template validation
 */

import { describe, it, expect } from "vitest";
import {
  interpolateTemplate,
  getDefaultTemplate,
  validateTemplate,
  computeTemplateVariables,
} from "../template-engine.js";
import {
  formatSessionStart,
  formatSessionEnd,
  formatSessionStop,
  formatSessionIdle,
  formatAskUserQuestion,
  formatAgentCall,
} from "../formatter.js";
import type { NotificationPayload, NotificationEvent } from "../types.js";

/** Build a minimal payload for testing. */
function makePayload(
  overrides: Partial<NotificationPayload> = {},
): NotificationPayload {
  return {
    event: "session-end",
    sessionId: "test-session-123",
    message: "",
    timestamp: "2026-02-25T10:30:00.000Z",
    ...overrides,
  };
}

describe("interpolateTemplate", () => {
  it("replaces simple variables", () => {
    const payload = makePayload({ projectName: "my-project" });
    const result = interpolateTemplate("Hello {{projectName}}", payload);
    expect(result).toBe("Hello my-project");
  });

  it("replaces multiple variables", () => {
    const payload = makePayload({
      sessionId: "s1",
      projectName: "proj",
    });
    const result = interpolateTemplate(
      "Session {{sessionId}} in {{projectName}}",
      payload,
    );
    expect(result).toBe("Session s1 in proj");
  });

  it("replaces unknown/missing variables with empty string", () => {
    const payload = makePayload();
    const result = interpolateTemplate("Value: {{nonexistent}}", payload);
    expect(result).toBe("Value:");
  });

  it("replaces undefined payload fields with empty string", () => {
    const payload = makePayload({ projectName: undefined });
    const result = interpolateTemplate("Project: {{projectName}}", payload);
    expect(result).toBe("Project:");
  });
});

describe("{{#if}} conditionals", () => {
  it("shows content when variable is truthy", () => {
    const payload = makePayload({ tmuxSession: "omc-session" });
    const result = interpolateTemplate(
      "{{#if tmuxSession}}tmux: {{tmuxSession}}{{/if}}",
      payload,
    );
    expect(result).toBe("tmux: omc-session");
  });

  it("hides content when variable is empty", () => {
    const payload = makePayload({ tmuxSession: undefined });
    const result = interpolateTemplate(
      "{{#if tmuxSession}}tmux: {{tmuxSession}}{{/if}}",
      payload,
    );
    expect(result).toBe("");
  });

  it("hides content when variable is falsy (empty string)", () => {
    const payload = makePayload({ reason: "" });
    const result = interpolateTemplate(
      "{{#if reason}}Reason: {{reason}}{{/if}}",
      payload,
    );
    expect(result).toBe("");
  });

  it("handles incompleteTasks=0 as truthy (distinguishable from undefined)", () => {
    const payload = makePayload({ incompleteTasks: 0 });
    const result = interpolateTemplate(
      "{{#if incompleteTasks}}Tasks: {{incompleteTasks}}{{/if}}",
      payload,
    );
    expect(result).toBe("Tasks: 0");
  });

  it("handles incompleteTasks=undefined as falsy", () => {
    const payload = makePayload({ incompleteTasks: undefined });
    const result = interpolateTemplate(
      "{{#if incompleteTasks}}Tasks: {{incompleteTasks}}{{/if}}",
      payload,
    );
    expect(result).toBe("");
  });

  it("handles incompleteTasks>0 as truthy", () => {
    const payload = makePayload({ incompleteTasks: 5 });
    const result = interpolateTemplate(
      "{{#if incompleteTasks}}Tasks: {{incompleteTasks}}{{/if}}",
      payload,
    );
    expect(result).toBe("Tasks: 5");
  });

  it("handles multiline conditional content", () => {
    const payload = makePayload({ contextSummary: "did work" });
    const result = interpolateTemplate(
      "{{#if contextSummary}}\n**Summary:** {{contextSummary}}{{/if}}",
      payload,
    );
    expect(result).toBe("\n**Summary:** did work");
  });
});

describe("computed variables", () => {
  it("duration formats milliseconds", () => {
    const payload = makePayload({ durationMs: 323000 });
    const vars = computeTemplateVariables(payload);
    expect(vars.duration).toBe("5m 23s");
  });

  it("duration handles hours", () => {
    const payload = makePayload({ durationMs: 7323000 });
    const vars = computeTemplateVariables(payload);
    expect(vars.duration).toBe("2h 2m 3s");
  });

  it("duration handles zero/undefined as unknown", () => {
    expect(computeTemplateVariables(makePayload({ durationMs: 0 })).duration).toBe("unknown");
    expect(computeTemplateVariables(makePayload({ durationMs: undefined })).duration).toBe("unknown");
  });

  it("time formats timestamp", () => {
    const payload = makePayload({ timestamp: "2026-02-25T10:30:00.000Z" });
    const vars = computeTemplateVariables(payload);
    // Just check it's non-empty (locale-dependent)
    expect(vars.time).toBeTruthy();
  });

  it("modesDisplay joins modes", () => {
    const payload = makePayload({ modesUsed: ["ralph", "ultrawork"] });
    const vars = computeTemplateVariables(payload);
    expect(vars.modesDisplay).toBe("ralph, ultrawork");
  });

  it("modesDisplay is empty when no modes", () => {
    const payload = makePayload({ modesUsed: [] });
    const vars = computeTemplateVariables(payload);
    expect(vars.modesDisplay).toBe("");
  });

  it("iterationDisplay formats X/Y", () => {
    const payload = makePayload({ iteration: 3, maxIterations: 10 });
    const vars = computeTemplateVariables(payload);
    expect(vars.iterationDisplay).toBe("3/10");
  });

  it("iterationDisplay is empty when either is null", () => {
    expect(
      computeTemplateVariables(makePayload({ iteration: 3 })).iterationDisplay,
    ).toBe("");
    expect(
      computeTemplateVariables(makePayload({ maxIterations: 10 }))
        .iterationDisplay,
    ).toBe("");
  });

  it("agentDisplay formats completed/total", () => {
    const payload = makePayload({
      agentsSpawned: 5,
      agentsCompleted: 3,
    });
    const vars = computeTemplateVariables(payload);
    expect(vars.agentDisplay).toBe("3/5 completed");
  });

  it("agentDisplay defaults completed to 0", () => {
    const payload = makePayload({ agentsSpawned: 5 });
    const vars = computeTemplateVariables(payload);
    expect(vars.agentDisplay).toBe("0/5 completed");
  });

  it("agentDisplay is empty when agentsSpawned is undefined", () => {
    const payload = makePayload();
    const vars = computeTemplateVariables(payload);
    expect(vars.agentDisplay).toBe("");
  });

  it("projectDisplay uses projectName", () => {
    const payload = makePayload({ projectName: "my-proj" });
    const vars = computeTemplateVariables(payload);
    expect(vars.projectDisplay).toBe("my-proj");
  });

  it("projectDisplay falls back to basename of projectPath", () => {
    const payload = makePayload({
      projectName: undefined,
      projectPath: "/home/user/workspace/cool-project",
    });
    const vars = computeTemplateVariables(payload);
    expect(vars.projectDisplay).toBe("cool-project");
  });

  it("projectDisplay defaults to unknown", () => {
    const payload = makePayload({
      projectName: undefined,
      projectPath: undefined,
    });
    const vars = computeTemplateVariables(payload);
    expect(vars.projectDisplay).toBe("unknown");
  });

  it("footer includes tmux and project", () => {
    const payload = makePayload({
      tmuxSession: "omc-1",
      projectName: "proj",
    });
    const vars = computeTemplateVariables(payload);
    expect(vars.footer).toBe("**tmux:** `omc-1` | **project:** `proj`");
  });

  it("footer omits tmux when not set", () => {
    const payload = makePayload({ projectName: "proj" });
    const vars = computeTemplateVariables(payload);
    expect(vars.footer).toBe("**project:** `proj`");
  });

  it("tmuxTailBlock formats with code fence", () => {
    const payload = makePayload({ tmuxTail: "line1\nline2" });
    const vars = computeTemplateVariables(payload);
    expect(vars.tmuxTailBlock).toContain("**Recent output:**");
    expect(vars.tmuxTailBlock).toContain("```");
  });

  it("tmuxTailBlock is empty when no tmuxTail", () => {
    const payload = makePayload();
    const vars = computeTemplateVariables(payload);
    expect(vars.tmuxTailBlock).toBe("");
  });

  it("reasonDisplay falls back to unknown", () => {
    const payload = makePayload({ reason: undefined });
    const vars = computeTemplateVariables(payload);
    expect(vars.reasonDisplay).toBe("unknown");
  });

  it("reasonDisplay uses reason when present", () => {
    const payload = makePayload({ reason: "user_request" });
    const vars = computeTemplateVariables(payload);
    expect(vars.reasonDisplay).toBe("user_request");
  });
});

describe("validateTemplate", () => {
  it("valid template has no unknown vars", () => {
    const result = validateTemplate("Hello {{projectName}} at {{time}}");
    expect(result.valid).toBe(true);
    expect(result.unknownVars).toEqual([]);
  });

  it("detects unknown variables", () => {
    const result = validateTemplate("{{typoVariable}} and {{sessionId}}");
    expect(result.valid).toBe(false);
    expect(result.unknownVars).toContain("typoVariable");
    expect(result.unknownVars).not.toContain("sessionId");
  });

  it("detects unknown vars in conditionals", () => {
    const result = validateTemplate("{{#if badVar}}content{{/if}}");
    expect(result.valid).toBe(false);
    expect(result.unknownVars).toContain("badVar");
  });

  it("does not duplicate unknown vars", () => {
    const result = validateTemplate("{{bad}} and {{bad}}");
    expect(result.unknownVars).toEqual(["bad"]);
  });
});

describe("getDefaultTemplate", () => {
  it("returns a template for each event type", () => {
    const events: NotificationEvent[] = [
      "session-start",
      "session-stop",
      "session-end",
      "session-idle",
      "ask-user-question",
      "agent-call",
    ];
    for (const event of events) {
      const template = getDefaultTemplate(event);
      expect(template).toBeTruthy();
      expect(typeof template).toBe("string");
    }
  });

  it("returns fallback for unknown event", () => {
    const template = getDefaultTemplate("unknown-event" as NotificationEvent);
    expect(template).toBe("Event: {{event}}");
  });
});

describe("default template parity with formatter.ts", () => {
  // These tests verify that default templates produce identical output
  // to the hardcoded formatters.

  const fullPayload = makePayload({
    event: "session-end",
    sessionId: "test-session-abc",
    timestamp: "2026-02-25T10:30:00.000Z",
    tmuxSession: "omc-test",
    projectName: "my-project",
    projectPath: "/home/user/my-project",
    durationMs: 323000,
    reason: "user_request",
    agentsSpawned: 5,
    agentsCompleted: 3,
    modesUsed: ["ralph", "ultrawork"],
    contextSummary: "Implemented the feature",
    activeMode: "ralph",
    iteration: 3,
    maxIterations: 10,
    incompleteTasks: 2,
    question: "What should I do next?",
    agentName: "executor",
    agentType: "oh-my-claudecode:executor",
  });

  it("session-start matches formatSessionStart", () => {
    const p = { ...fullPayload, event: "session-start" as const };
    const fromFormatter = formatSessionStart(p);
    const fromTemplate = interpolateTemplate(getDefaultTemplate("session-start"), p);
    expect(fromTemplate).toBe(fromFormatter);
  });

  it("session-stop matches formatSessionStop", () => {
    const p = { ...fullPayload, event: "session-stop" as const };
    const fromFormatter = formatSessionStop(p);
    const fromTemplate = interpolateTemplate(getDefaultTemplate("session-stop"), p);
    expect(fromTemplate).toBe(fromFormatter);
  });

  it("session-end matches formatSessionEnd", () => {
    const p = { ...fullPayload, event: "session-end" as const };
    const fromFormatter = formatSessionEnd(p);
    const fromTemplate = interpolateTemplate(getDefaultTemplate("session-end"), p);
    expect(fromTemplate).toBe(fromFormatter);
  });

  it("session-idle matches formatSessionIdle", () => {
    const p = { ...fullPayload, event: "session-idle" as const };
    const fromFormatter = formatSessionIdle(p);
    const fromTemplate = interpolateTemplate(getDefaultTemplate("session-idle"), p);
    expect(fromTemplate).toBe(fromFormatter);
  });

  it("ask-user-question matches formatAskUserQuestion", () => {
    const p = { ...fullPayload, event: "ask-user-question" as const };
    const fromFormatter = formatAskUserQuestion(p);
    const fromTemplate = interpolateTemplate(
      getDefaultTemplate("ask-user-question"),
      p,
    );
    expect(fromTemplate).toBe(fromFormatter);
  });

  it("agent-call matches formatAgentCall", () => {
    const p = { ...fullPayload, event: "agent-call" as const };
    const fromFormatter = formatAgentCall(p);
    const fromTemplate = interpolateTemplate(
      getDefaultTemplate("agent-call"),
      p,
    );
    expect(fromTemplate).toBe(fromFormatter);
  });

  // Minimal payloads (no optional fields) - ensures conditionals work
  it("session-end minimal matches formatter", () => {
    const p = makePayload({
      event: "session-end",
      sessionId: "s1",
      durationMs: 5000,
      projectPath: "/tmp/proj",
    });
    const fromFormatter = formatSessionEnd(p);
    const fromTemplate = interpolateTemplate(
      getDefaultTemplate("session-end"),
      p,
    );
    expect(fromTemplate).toBe(fromFormatter);
  });

  it("session-idle minimal matches formatter", () => {
    const p = makePayload({
      event: "session-idle",
      projectName: "proj",
    });
    const fromFormatter = formatSessionIdle(p);
    const fromTemplate = interpolateTemplate(
      getDefaultTemplate("session-idle"),
      p,
    );
    expect(fromTemplate).toBe(fromFormatter);
  });

  it("ask-user-question without question matches formatter", () => {
    const p = makePayload({
      event: "ask-user-question",
      projectName: "proj",
    });
    const fromFormatter = formatAskUserQuestion(p);
    const fromTemplate = interpolateTemplate(
      getDefaultTemplate("ask-user-question"),
      p,
    );
    expect(fromTemplate).toBe(fromFormatter);
  });

  it("agent-call minimal matches formatter", () => {
    const p = makePayload({
      event: "agent-call",
      projectName: "proj",
    });
    const fromFormatter = formatAgentCall(p);
    const fromTemplate = interpolateTemplate(
      getDefaultTemplate("agent-call"),
      p,
    );
    expect(fromTemplate).toBe(fromFormatter);
  });

  it("session-start without tmux matches formatter", () => {
    const p = makePayload({
      event: "session-start",
      projectName: "proj",
      tmuxSession: undefined,
    });
    const fromFormatter = formatSessionStart(p);
    const fromTemplate = interpolateTemplate(
      getDefaultTemplate("session-start"),
      p,
    );
    expect(fromTemplate).toBe(fromFormatter);
  });

  it("session-stop minimal matches formatter", () => {
    const p = makePayload({
      event: "session-stop",
      projectName: "proj",
    });
    const fromFormatter = formatSessionStop(p);
    const fromTemplate = interpolateTemplate(
      getDefaultTemplate("session-stop"),
      p,
    );
    expect(fromTemplate).toBe(fromFormatter);
  });
});

describe("post-processing", () => {
  it("preserves consecutive newlines (no collapsing)", () => {
    const payload = makePayload({ projectName: "proj" });
    const template = "Line1\n\n\n\nLine2";
    const result = interpolateTemplate(template, payload);
    expect(result).toBe("Line1\n\n\n\nLine2");
  });

  it("trims trailing whitespace", () => {
    const payload = makePayload({ projectName: "proj" });
    const template = "Content\n\n";
    const result = interpolateTemplate(template, payload);
    expect(result).toBe("Content");
  });
});
