/**
 * Regression tests for HUD transcript agent lifecycle tracking.
 *
 * Covers bugs that caused agents to be stuck as "running" in the HUD
 * long after they had finished:
 *
 *   1. Foreground agent results containing the literal string
 *      "Async agent launched" (e.g. investigation reports that quote
 *      prior launch messages) were misclassified as background launches
 *      by the naive `.includes()` check, and never flipped to completed.
 *
 *   2. Background agent completions arrive as `<task-notification>`
 *      user-role messages where `message.content` is either a plain
 *      string or a list containing a `tool_result` block with the
 *      notification text. The parser originally only handled
 *      array-shaped content and used the wrong tag spelling
 *      (`<task_id>` instead of the real `<task-id>`).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseTranscript } from "../../hud/transcript.js";

const tempDirs: string[] = [];

function createTempTranscript(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "omc-hud-agent-lifecycle-"));
  tempDirs.push(dir);
  const p = join(dir, "transcript.jsonl");
  writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
  return p;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("HUD transcript — agent lifecycle", () => {
  describe("foreground agent completion", () => {
    it("marks a foreground Task agent as completed when its tool_result arrives", async () => {
      const transcriptPath = createTempTranscript([
        {
          timestamp: "2026-04-07T00:00:00.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_fg_001",
                name: "Task",
                input: { subagent_type: "Explore", description: "Find X" },
              },
            ],
          },
        },
        {
          timestamp: "2026-04-07T00:01:30.000Z",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_fg_001",
                content: [{ type: "text", text: "Here are the results of exploring X..." }],
              },
            ],
          },
        },
      ]);

      // Disable stale-agent GC so the test is deterministic regardless of
      // the wall-clock delta between the fixture timestamps and test run time.
      const result = await parseTranscript(transcriptPath, { staleTaskThresholdMinutes: 10 ** 9 });
      const fg = result.agents.find((a) => a.id === "toolu_fg_001");
      expect(fg).toBeDefined();
      expect(fg?.status).toBe("completed");
    });

    it("preserves native teammate names from named Task calls", async () => {
      const transcriptPath = createTempTranscript([
        {
          timestamp: "2026-04-07T00:00:00.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_team_001",
                name: "Task",
                input: {
                  name: "worker-1",
                  subagent_type: "executor",
                  description: "Implement HUD fix",
                },
              },
            ],
          },
        },
      ]);

      const result = await parseTranscript(transcriptPath, { staleTaskThresholdMinutes: 10 ** 9 });
      const teammate = result.agents.find((a) => a.id === "toolu_team_001");
      expect(teammate?.name).toBe("worker-1");
      expect(teammate?.type).toBe("executor");
      expect(teammate?.description).toBe("Implement HUD fix");
    });

    it("preserves native teammate names from proxied Agent calls", async () => {
      const transcriptPath = createTempTranscript([
        {
          timestamp: "2026-04-07T00:00:00.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_proxy_agent_001",
                name: "proxy_Agent",
                input: {
                  name: "worker-2",
                  subagent_type: "executor",
                  description: "Review HUD fix",
                },
              },
            ],
          },
        },
      ]);

      const result = await parseTranscript(transcriptPath, { staleTaskThresholdMinutes: 10 ** 9 });
      const teammate = result.agents.find((a) => a.id === "toolu_proxy_agent_001");
      expect(teammate?.name).toBe("worker-2");
      expect(teammate?.type).toBe("executor");
      expect(teammate?.description).toBe("Review HUD fix");
    });

    it("does NOT misclassify a foreground agent result as a background launch when the result text incidentally contains the phrase 'Async agent launched'", async () => {
      // This is the regression case. An Explore agent investigation report
      // quoted earlier background-launch notifications in its output. The
      // naive `.includes("Async agent launched")` check on the tool_result
      // content flagged the whole result as a background launch, keeping
      // the agent stuck as "running" until the 30-minute stale GC fired.
      const transcriptPath = createTempTranscript([
        {
          timestamp: "2026-04-07T00:00:00.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_fg_quote",
                name: "Task",
                input: { subagent_type: "Explore", description: "Investigate stuck agents" },
              },
            ],
          },
        },
        {
          timestamp: "2026-04-07T00:02:00.000Z",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_fg_quote",
                content: [
                  {
                    type: "text",
                    text:
                      "Investigation report:\n\nThe existing parser checks for 'Async agent launched' " +
                      "in the content of every tool_result. This is a false positive because the phrase " +
                      "appears here in the investigation output, quoting a prior launch notification.",
                  },
                ],
              },
            ],
          },
        },
      ]);

      // Disable stale-agent GC so the test is deterministic regardless of
      // the wall-clock delta between the fixture timestamps and test run time.
      const result = await parseTranscript(transcriptPath, { staleTaskThresholdMinutes: 10 ** 9 });
      const agent = result.agents.find((a) => a.id === "toolu_fg_quote");
      expect(agent).toBeDefined();
      expect(agent?.status).toBe("completed");
    });

    it("correctly classifies a genuine 'Async agent launched' message as a background launch (agent stays running)", async () => {
      const transcriptPath = createTempTranscript([
        {
          timestamp: "2026-04-07T00:00:00.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_bg_001",
                name: "Task",
                input: { subagent_type: "Explore", description: "Long-running scan" },
              },
            ],
          },
        },
        {
          timestamp: "2026-04-07T00:00:02.000Z",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_bg_001",
                content: [
                  {
                    type: "text",
                    text:
                      "Async agent launched successfully.\n" +
                      "agentId: abc123deadbeef (internal ID - do not mention to user.)\n" +
                      "The agent is working in the background.",
                  },
                ],
              },
            ],
          },
        },
      ]);

      // Disable stale-agent GC so the test is deterministic regardless of
      // the wall-clock delta between the fixture timestamps and test run time.
      const result = await parseTranscript(transcriptPath, { staleTaskThresholdMinutes: 10 ** 9 });
      const agent = result.agents.find((a) => a.id === "toolu_bg_001");
      expect(agent).toBeDefined();
      expect(agent?.status).toBe("running");
    });
  });

  describe("background agent completion via task-notification", () => {
    it("marks a background agent as completed when a string-shaped task-notification arrives", async () => {
      const transcriptPath = createTempTranscript([
        {
          timestamp: "2026-04-07T00:00:00.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_bg_str",
                name: "Task",
                input: { subagent_type: "general-purpose", description: "Check PR status" },
              },
            ],
          },
        },
        {
          timestamp: "2026-04-07T00:00:02.000Z",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_bg_str",
                content: [
                  { type: "text", text: "Async agent launched successfully.\nagentId: bgjob001\n" },
                ],
              },
            ],
          },
        },
        // Task-notification arrives later as a user-role message with
        // STRING-shaped content (real Claude Code shape).
        {
          timestamp: "2026-04-07T00:10:00.000Z",
          message: {
            role: "user",
            content:
              "<task-notification>\n" +
              "<task-id>bgjob001</task-id>\n" +
              "<tool-use-id>toolu_bg_str</tool-use-id>\n" +
              "<status>completed</status>\n" +
              "<summary>Background agent finished.</summary>\n" +
              "</task-notification>",
          },
        },
      ]);

      // Disable stale-agent GC so the test is deterministic regardless of
      // the wall-clock delta between the fixture timestamps and test run time.
      const result = await parseTranscript(transcriptPath, { staleTaskThresholdMinutes: 10 ** 9 });
      const agent = result.agents.find((a) => a.id === "toolu_bg_str");
      expect(agent).toBeDefined();
      expect(agent?.status).toBe("completed");
    });

    it("marks a background agent as completed when the task-notification is nested inside a tool_result block", async () => {
      const transcriptPath = createTempTranscript([
        {
          timestamp: "2026-04-07T00:00:00.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_bg_nested",
                name: "Task",
                input: { subagent_type: "Explore", description: "Deep scan" },
              },
            ],
          },
        },
        {
          timestamp: "2026-04-07T00:00:02.000Z",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_bg_nested",
                content: [
                  { type: "text", text: "Async agent launched successfully.\nagentId: nestedjob\n" },
                ],
              },
            ],
          },
        },
        // Task-notification inside a tool_result.content string (also a real shape).
        {
          timestamp: "2026-04-07T00:05:00.000Z",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_wrapper_xyz",
                content:
                  "<task-notification>\n" +
                  "<task-id>nestedjob</task-id>\n" +
                  "<tool-use-id>toolu_bg_nested</tool-use-id>\n" +
                  "<status>completed</status>\n" +
                  "</task-notification>",
              },
            ],
          },
        },
      ]);

      // Disable stale-agent GC so the test is deterministic regardless of
      // the wall-clock delta between the fixture timestamps and test run time.
      const result = await parseTranscript(transcriptPath, { staleTaskThresholdMinutes: 10 ** 9 });
      const agent = result.agents.find((a) => a.id === "toolu_bg_nested");
      expect(agent).toBeDefined();
      expect(agent?.status).toBe("completed");
    });

    it("accepts the legacy underscore-cased <task_id> tag as a fallback for older format transcripts", async () => {
      const transcriptPath = createTempTranscript([
        {
          timestamp: "2026-04-07T00:00:00.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_legacy",
                name: "Task",
                input: { subagent_type: "Explore", description: "Legacy format" },
              },
            ],
          },
        },
        {
          timestamp: "2026-04-07T00:00:02.000Z",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_legacy",
                content: [
                  { type: "text", text: "Async agent launched successfully.\nagentId: legacy1\n" },
                ],
              },
            ],
          },
        },
        {
          timestamp: "2026-04-07T00:05:00.000Z",
          message: {
            role: "user",
            content:
              "<task_id>legacy1</task_id><tool_use_id>toolu_legacy</tool_use_id><status>completed</status>",
          },
        },
      ]);

      // Disable stale-agent GC so the test is deterministic regardless of
      // the wall-clock delta between the fixture timestamps and test run time.
      const result = await parseTranscript(transcriptPath, { staleTaskThresholdMinutes: 10 ** 9 });
      const agent = result.agents.find((a) => a.id === "toolu_legacy");
      expect(agent).toBeDefined();
      expect(agent?.status).toBe("completed");
    });
  });
});
