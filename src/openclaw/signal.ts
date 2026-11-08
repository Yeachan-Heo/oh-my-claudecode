import type { OpenClawContext, OpenClawHookEvent, OpenClawSignal } from "./types.js";

const CLAUDE_TEMP_CWD_PATTERN = /zsh:\d+: permission denied:.*\/T\/claude-[a-z0-9]+-cwd/gi;
const CLAUDE_EXIT_CODE_PREFIX = /^Error: Exit code \d+\s*$/gm;
const PR_CREATE_PATTERN = /\bgh\s+pr\s+create\b/i;
const PR_URL_PATTERN = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/i;

const TEST_COMMAND_PATTERNS: Array<{ pattern: RegExp; runner: string }> = [
  { pattern: /\b(?:npm|pnpm|yarn|bun)\s+test\b/i, runner: "package-test" },
  { pattern: /\bnpx\s+vitest\b|\bvitest\b/i, runner: "vitest" },
  { pattern: /\bnpx\s+jest\b|\bjest\b/i, runner: "jest" },
  { pattern: /\bpytest\b|\bpython\s+-m\s+pytest\b/i, runner: "pytest" },
  { pattern: /\bcargo\s+test\b/i, runner: "cargo-test" },
  { pattern: /\bgo\s+test\b/i, runner: "go-test" },
  { pattern: /\bmake\s+test\b/i, runner: "make-test" },
];

function stripClaudeTempCwdErrors(output: string): string {
  return output.replace(CLAUDE_TEMP_CWD_PATTERN, "");
}

function isNonZeroExitWithOutput(output: string): boolean {
  const cleaned = stripClaudeTempCwdErrors(output);
  if (!CLAUDE_EXIT_CODE_PREFIX.test(cleaned)) return false;
  CLAUDE_EXIT_CODE_PREFIX.lastIndex = 0;

  const remaining = cleaned.replace(CLAUDE_EXIT_CODE_PREFIX, "").trim();
  CLAUDE_EXIT_CODE_PREFIX.lastIndex = 0;
  if (!remaining) return false;

  const contentErrorPatterns = [
    /error:/i,
    /failed/i,
    /\bFAIL\b/,
    /cannot/i,
    /permission denied/i,
    /command not found/i,
    /no such file/i,
    /fatal:/i,
    /abort/i,
  ];

  return !contentErrorPatterns.some((pattern) => pattern.test(remaining));
}

function detectBashFailure(output: string): boolean {
  const cleaned = stripClaudeTempCwdErrors(output);
  const errorPatterns = [
    /error:/i,
    /failed/i,
    /\bFAIL\b/,
    /cannot/i,
    /permission denied/i,
    /command not found/i,
    /no such file/i,
    /exit code: [1-9]/i,
    /exit status [1-9]/i,
    /fatal:/i,
    /abort/i,
  ];

  return errorPatterns.some((pattern) => pattern.test(cleaned));
}

function detectWriteFailure(output: string): boolean {
  const cleaned = stripClaudeTempCwdErrors(output);
  const errorPatterns = [
    /\berror:/i,
    /\bfailed to\b/i,
    /\bwrite failed\b/i,
    /\boperation failed\b/i,
    /permission denied/i,
    /read-only/i,
    /\bno such file\b/i,
    /\bdirectory not found\b/i,
  ];

  return errorPatterns.some((pattern) => pattern.test(cleaned));
}

function getCommand(toolInput: unknown): string | undefined {
  if (!toolInput || typeof toolInput !== "object") return undefined;
  const raw = (toolInput as Record<string, unknown>).command;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function detectTestRunner(command?: string): string | undefined {
  if (!command) return undefined;
  return TEST_COMMAND_PATTERNS.find(({ pattern }) => pattern.test(command))?.runner;
}

function summarize(value: unknown, maxLength = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(" | ");

  if (!normalized) return undefined;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 2)).trimEnd()}…`;
}

function getToolPhase(toolName: string | undefined, toolOutput: unknown): "finished" | "failed" {
  if (typeof toolOutput !== "string" || toolOutput.trim().length === 0) {
    return "finished";
  }

  if (toolName === "Bash") {
    if (isNonZeroExitWithOutput(toolOutput)) return "finished";
    return detectBashFailure(toolOutput) ? "failed" : "finished";
  }

  if (toolName === "Edit" || toolName === "Write") {
    return detectWriteFailure(toolOutput) ? "failed" : "finished";
  }

  return "finished";
}

function buildToolSignal(event: "pre-tool-use" | "post-tool-use", context: OpenClawContext): OpenClawSignal {
  const toolName = context.toolName || "unknown";
  const command = getCommand(context.toolInput);
  const testRunner = toolName === "Bash" ? detectTestRunner(command) : undefined;
  const isPrCreate = toolName === "Bash" && !!command && PR_CREATE_PATTERN.test(command);
  const phase = event === "pre-tool-use" ? "started" : getToolPhase(context.toolName, context.toolOutput);
  const summary = summarize(context.toolOutput ?? command);

  if (testRunner) {
    return {
      kind: "test",
      name: "test-run",
      phase,
      routeKey: `test.${phase}`,
      priority: "high",
      toolName,
      command,
      testRunner,
      summary,
    };
  }

  if (isPrCreate) {
    const output = typeof context.toolOutput === "string" ? context.toolOutput : "";
    const prUrl = output.match(PR_URL_PATTERN)?.[0];
    const routeKey =
      phase === "started" ? "pull-request.started" : phase === "failed" ? "pull-request.failed" : "pull-request.created";
    return {
      kind: "pull-request",
      name: "pull-request-create",
      phase,
      routeKey,
      priority: "high",
      toolName,
      command,
      prUrl,
      summary: summarize(prUrl ? `${prUrl}${summary ? ` ${summary}` : ""}` : summary),
    };
  }

  return {
    kind: "tool",
    name: "tool-use",
    phase,
    routeKey: `tool.${phase}`,
    priority: phase === "failed" ? "high" : "low",
    toolName,
    summary,
  };
}

export function buildOpenClawSignal(event: OpenClawHookEvent, context: OpenClawContext): OpenClawSignal {
  switch (event) {
    case "session-start":
      return {
        kind: "session",
        name: "session",
        phase: "started",
        routeKey: "session.started",
        priority: "high",
      };
    case "session-end":
      return {
        kind: "session",
        name: "session",
        phase: "finished",
        routeKey: "session.finished",
        priority: "high",
        summary: summarize(context.reason),
      };
    case "stop":
      return {
        kind: "session",
        name: "session-idle",
        phase: "idle",
        routeKey: "session.idle",
        priority: "high",
      };
    case "keyword-detector":
      return {
        kind: "keyword",
        name: "keyword-detected",
        phase: "detected",
        routeKey: "keyword.detected",
        priority: "low",
        summary: summarize(context.prompt),
      };
    case "ask-user-question":
      return {
        kind: "question",
        name: "ask-user-question",
        phase: "requested",
        routeKey: "question.requested",
        priority: "high",
        summary: summarize(context.question),
      };
    case "pre-tool-use":
    case "post-tool-use":
      return buildToolSignal(event, context);
    default:
      return {
        kind: "tool",
        name: "tool-use",
        phase: "finished",
        routeKey: "tool.finished",
        priority: "low",
      };
  }
}
