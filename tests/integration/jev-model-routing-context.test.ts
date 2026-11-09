/**
 * model-routing state: real pre-tool-enforcer.mjs subprocess against a mock
 * Jev endpoint. Covers what the hook sends as state: the task bounded by
 * OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING, and the opt-in extra fields from
 * OMC_JEV_MODEL_ROUTING_CONTEXT (description, last user message of the parent
 * session).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const API_KEY = "test-key-123";

type WireBody = { state: Record<string, unknown> };

const ANSWERS = {
  "model-tier": { type: "choice", choice: "sonnet", confidence: 0.9 },
  effort: { type: "score", score: 1, confidence: 0.7 },
};

// Keep the test's event loop free: the hook's synchronous Jev child must be
// able to POST to the HTTP server running in this process.
function runEnforcer(input: Record<string, unknown>, env: NodeJS.ProcessEnv, cwd: string) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(PROJECT_ROOT, "scripts", "pre-tool-enforcer.mjs")], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    child.stdin.on("error", reject);
    child.stdin.end(JSON.stringify(input));
  });
}

describe("pre-tool-enforcer.mjs: Jev model-routing state", () => {
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  let server: Server;
  let requests: WireBody[];

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "jev-context-"));
    requests = [];
    server = createServer((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        raw += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(raw) as WireBody);
        response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
        response.end(JSON.stringify({ answers: ANSWERS }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected local TCP endpoint");
    env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: cwd,
      USERPROFILE: cwd,
      XDG_CONFIG_HOME: join(cwd, "config"),
      CLAUDE_CONFIG_DIR: join(cwd, "claude"),
      NODE_NO_WARNINGS: "1",
      OMC_DISABLE_MULTIREPO: "1",
      OMC_STATE_DIR: join(cwd, ".omc"),
      OMC_JEV_LOG_DIR: join(cwd, "jev-logs"),
      OMC_JEV_QUIET: "1",
      OMC_JEV_TIMEOUT_MS: "2000",
      OMC_PRE_TOOL_ADVISORY_COOLDOWN_MS: "0",
      TYPESAFE_API_KEY: API_KEY,
      OMC_JEV_ENDPOINT: `http://127.0.0.1:${address.port}/v1/systemone`,
      OMC_JEV: "model-routing:active",
    };
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  function agentInput(prompt: string, transcriptPath?: string, toolInput: Record<string, unknown> = {}) {
    return {
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: {
        description: "Trace the flaky auth test",
        prompt,
        subagent_type: "general-purpose",
        model: "haiku",
        ...toolInput,
      },
      cwd,
      session_id: "test-sess-context",
      ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
    };
  }

  async function sentState(
    input: ReturnType<typeof agentInput>,
    extraEnv: NodeJS.ProcessEnv = {},
  ): Promise<Record<string, unknown>> {
    const result = await runEnforcer(input, { ...env, ...extraEnv }, cwd);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(requests).toHaveLength(1);
    return requests[0].state;
  }

  // Claude Code names the transcript of a session `<session_id>.jsonl`.
  function writeTranscript(entries: unknown[], name = "test-sess-context.jsonl", eol = "\n"): string {
    const path = join(cwd, name);
    writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join(eol) + eol, "utf8");
    return path;
  }

  const userEntry = (content: unknown, extra: Record<string, unknown> = {}) => ({
    type: "user",
    message: { role: "user", content },
    ...extra,
  });

  it("sends the subagent type and the task only, up to 12000 characters of it, by default", async () => {
    const state = await sentState(agentInput("t".repeat(13000)));
    expect(Object.keys(state).sort()).toEqual(["subagent_type", "task", "tool_name"]);
    expect(state.task).toBe("t".repeat(12000));
  }, 15000);

  it("OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING raises the task limit", async () => {
    const state = await sentState(agentInput("t".repeat(3000)), { OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING: "2500" });
    expect(state.task).toBe("t".repeat(2500));
  }, 15000);

  it("OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING wins over OMC_JEV_EXCERPT_CHARS", async () => {
    const state = await sentState(agentInput("t".repeat(3000)), {
      OMC_JEV_EXCERPT_CHARS: "1000",
      OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING: "80",
    });
    expect(state.task).toBe("t".repeat(80));
  }, 15000);

  it("ignores the global OMC_JEV_EXCERPT_CHARS, which does not apply to model-routing", async () => {
    const state = await sentState(agentInput("t".repeat(3000)), { OMC_JEV_EXCERPT_CHARS: "1000" });
    expect(state.task).toBe("t".repeat(3000));
  }, 15000);

  it("adds the description and the last user message of the parent session when enabled", async () => {
    const transcript = writeTranscript([
      userEntry("an older request"),
      userEntry([{ type: "text", text: "Fix the flaky auth test <system-reminder>hook noise</system-reminder>" }]),
      userEntry([{ type: "tool_result", tool_use_id: "t1", content: "tool output" }]),
      userEntry("<task-notification>agent finished</task-notification>"),
      userEntry("a meta message", { isMeta: true }),
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "On it." }] } },
    ]);
    const state = await sentState(agentInput("Look at the test.", transcript), {
      OMC_JEV_MODEL_ROUTING_CONTEXT: "1",
    });
    expect(state.description).toBe("Trace the flaky auth test");
    expect(state.parent_last_user_message).toBe("Fix the flaky auth test");
    expect(state.task).toBe("Look at the test.");
  }, 15000);

  it("sends no parent message when the transcript is missing; the description still goes", async () => {
    const state = await sentState(agentInput("Look at the test.", join(cwd, "missing.jsonl")), {
      OMC_JEV_MODEL_ROUTING_CONTEXT: "true",
    });
    expect(state.description).toBe("Trace the flaky auth test");
    expect(state).not.toHaveProperty("parent_last_user_message");
  }, 15000);

  it("cuts the parent message to 4000 characters even with a higher point limit", async () => {
    const transcript = writeTranscript([userEntry("m".repeat(5000))]);
    const state = await sentState(agentInput("Look at the test.", transcript), {
      OMC_JEV_MODEL_ROUTING_CONTEXT: "1",
      OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING: "12000",
    });
    expect(state.parent_last_user_message).toBe("m".repeat(4000));
  }, 15000);

  it("skips compact summaries, command notices and sidechain entries, and reads CRLF transcripts", async () => {
    const transcript = writeTranscript(
      [
        userEntry("Fix the flaky auth test"),
        userEntry("This session is being continued from a previous conversation.", { isCompactSummary: true }),
        userEntry("<command-name>/compact</command-name>"),
        userEntry("a subagent prompt", { isSidechain: true }),
      ],
      "test-sess-context.jsonl",
      "\r\n",
    );
    const state = await sentState(agentInput("Look at the test.", transcript), {
      OMC_JEV_MODEL_ROUTING_CONTEXT: "1",
    });
    expect(state.parent_last_user_message).toBe("Fix the flaky auth test");
  }, 15000);

  it("skips interruption markers and the notices of the Claude desktop app", async () => {
    const transcript = writeTranscript([
      userEntry("Fix the flaky auth test"),
      userEntry("[Request interrupted by user for tool use]"),
      userEntry("<side-sessions-event>side session finished</side-sessions-event>"),
      userEntry("<ci-monitor-event>checks passed</ci-monitor-event>"),
      userEntry('<scheduled-task name="nightly" file="nightly.md">run it</scheduled-task>'),
      userEntry('<cross-session-message from="other" name="other">hello</cross-session-message>'),
      userEntry([{ type: "text", text: "<system-reminder>notice</system-reminder>Another Claude session sent a message:\n<message>run the suite</message>" }]),
    ]);
    const state = await sentState(agentInput("Look at the test.", transcript), {
      OMC_JEV_MODEL_ROUTING_CONTEXT: "1",
    });
    expect(state.parent_last_user_message).toBe("Fix the flaky auth test");
  }, 15000);

  it("still reads a user message that only mentions another Claude session", async () => {
    const message = "Why did I see 'Another Claude session sent a message' in the log?";
    const transcript = writeTranscript([userEntry("an older request"), userEntry(message)]);
    const state = await sentState(agentInput("Look at the test.", transcript), {
      OMC_JEV_MODEL_ROUTING_CONTEXT: "1",
    });
    expect(state.parent_last_user_message).toBe(message);
  }, 15000);

  it("reads only the transcript of the active session", async () => {
    const transcript = writeTranscript([userEntry("Fix the flaky auth test")], "another-session.jsonl");
    const state = await sentState(agentInput("Look at the test.", transcript), {
      OMC_JEV_MODEL_ROUTING_CONTEXT: "1",
    });
    expect(state.description).toBe("Trace the flaky auth test");
    expect(state).not.toHaveProperty("parent_last_user_message");
  }, 15000);

  it("does not let a small point limit change which calls are asked about", async () => {
    // The executor agent defines its own model, which the hook finds by subagent_type. A point limit
    // of 12 bounds the state sent to Jev, not the fields the hook decides on.
    const state = await sentState(
      agentInput("t".repeat(100), undefined, { subagent_type: "oh-my-claudecode:executor", model: undefined }),
      { OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING: "12" },
    );
    expect(state.task).toBe("t".repeat(12));
  }, 15000);

  it("bounds the parent message with the point limit", async () => {
    const transcript = writeTranscript([userEntry("m".repeat(3000))]);
    const state = await sentState(agentInput("Look at the test.", transcript), {
      OMC_JEV_MODEL_ROUTING_CONTEXT: "1",
      OMC_JEV_EXCERPT_CHARS_MODEL_ROUTING: "1200",
    });
    expect(state.parent_last_user_message).toBe("m".repeat(1200));
  }, 15000);

  it.each(["0", "", "no", "yes"])("leaves the state alone when OMC_JEV_MODEL_ROUTING_CONTEXT is %j", async (value) => {
    const transcript = writeTranscript([userEntry("Fix the flaky auth test")]);
    const state = await sentState(agentInput("Look at the test.", transcript), {
      OMC_JEV_MODEL_ROUTING_CONTEXT: value,
    });
    expect(Object.keys(state).sort()).toEqual(["subagent_type", "task", "tool_name"]);
  }, 15000);
});
