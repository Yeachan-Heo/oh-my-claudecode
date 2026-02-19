/**
 * Hook Bridge - TypeScript logic invoked by shell scripts
 *
 * This module provides the main entry point for shell hooks to call TypeScript
 * for complex processing. The shell script reads stdin, passes it to this module,
 * and writes the JSON output to stdout.
 *
 * Usage from shell:
 * ```bash
 * #!/bin/bash
 * INPUT=$(cat)
 * echo "$INPUT" | node ~/.claude/omc/hook-bridge.mjs --hook=keyword-detector
 * ```
 */

import { pathToFileURL } from 'url';
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { resolveToWorktreeRoot } from "../lib/worktree-paths.js";

// Hot-path imports: needed on every/most hook invocations (keyword-detector, pre/post-tool-use)
import { removeCodeBlocks, getAllKeywords } from "./keyword-detector/index.js";
import { processOrchestratorPreTool, processOrchestratorPostTool } from "./omc-orchestrator/index.js";
import { normalizeHookInput } from "./bridge-normalize.js";
import {
  addBackgroundTask,
  getRunningTaskCount,
} from "../hud/background-tasks.js";
import { loadConfig } from "../config/loader.js";
import {
  ULTRAWORK_MESSAGE,
  ULTRATHINK_MESSAGE,
  SEARCH_MESSAGE,
  ANALYZE_MESSAGE,
  TODO_CONTINUATION_PROMPT,
  RALPH_MESSAGE,
} from "../installer/hooks.js";
// Agent dashboard is used in pre/post-tool-use hot path
import {
  getAgentDashboard,
} from "./subagent-tracker/index.js";
// Session replay recordFileTouch is used in pre-tool-use hot path
import {
  recordFileTouch,
} from "./subagent-tracker/session-replay.js";

// Type-only imports for lazy-loaded modules (zero runtime cost)
import type { SubagentStartInput, SubagentStopInput } from "./subagent-tracker/index.js";
import type { PreCompactInput } from "./pre-compact/index.js";
import type { SetupInput } from "./setup/index.js";
import type { PermissionRequestInput } from "./permission-handler/index.js";
import type { SessionEndInput } from "./session-end/index.js";
import type { StopContext } from "./todo-continuation/index.js";

const PKILL_F_FLAG_PATTERN = /\bpkill\b.*\s-f\b/;
const PKILL_FULL_FLAG_PATTERN = /\bpkill\b.*--full\b/;

const TEAM_TERMINAL_VALUES = new Set([
  "completed",
  "complete",
  "cancelled",
  "canceled",
  "cancel",
  "failed",
  "aborted",
  "terminated",
  "done",
]);

interface TeamStagedState {
  active?: boolean;
  stage?: string;
  current_stage?: string;
  currentStage?: string;
  status?: string;
  session_id?: string;
  sessionId?: string;
  team_name?: string;
  teamName?: string;
  started_at?: string;
  startedAt?: string;
  task?: string;
  cancelled?: boolean;
  canceled?: boolean;
  completed?: boolean;
  terminal?: boolean;
}

function readTeamStagedState(
  directory: string,
  sessionId?: string,
): TeamStagedState | null {
  const stateDir = join(directory, ".omc", "state");
  const statePaths = sessionId
    ? [
        join(stateDir, "sessions", sessionId, "team-state.json"),
        join(stateDir, "team-state.json"),
      ]
    : [join(stateDir, "team-state.json")];

  for (const statePath of statePaths) {
    if (!existsSync(statePath)) {
      continue;
    }

    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as TeamStagedState;
      if (typeof parsed !== "object" || parsed === null) {
        continue;
      }

      const stateSessionId = parsed.session_id || parsed.sessionId;
      if (sessionId && stateSessionId && stateSessionId !== sessionId) {
        continue;
      }

      return parsed;
    } catch {
      continue;
    }
  }

  return null;
}

function getTeamStage(state: TeamStagedState): string {
  return state.stage || state.current_stage || state.currentStage || "team-exec";
}

function isTeamStateTerminal(state: TeamStagedState): boolean {
  if (state.terminal === true || state.cancelled === true || state.canceled === true || state.completed === true) {
    return true;
  }

  const status = String(state.status || "").toLowerCase();
  const stage = String(getTeamStage(state)).toLowerCase();

  return TEAM_TERMINAL_VALUES.has(status) || TEAM_TERMINAL_VALUES.has(stage);
}

function getTeamStagePrompt(stage: string): string {
  switch (stage) {
    case "team-plan":
      return "Continue planning and decomposition, then move into execution once the task graph is ready.";
    case "team-prd":
      return "Continue clarifying scope and acceptance criteria, then proceed to execution once criteria are explicit.";
    case "team-exec":
      return "Continue execution: monitor teammates, unblock dependencies, and drive tasks to terminal status for this pass.";
    case "team-verify":
      return "Continue verification: validate outputs, run required checks, and decide pass or fix-loop entry.";
    case "team-fix":
      return "Continue fix loop work, then return to execution/verification until no required follow-up remains.";
    default:
      return "Continue from the current Team stage and preserve staged workflow semantics.";
  }
}

/**
 * Returns the required camelCase keys for a given hook type.
 * Centralizes key requirements to avoid drift between normalization and validation.
 */
export function requiredKeysForHook(hookType: string): string[] {
  switch (hookType) {
    case "session-end":
    case "subagent-start":
    case "subagent-stop":
    case "pre-compact":
    case "setup-init":
    case "setup-maintenance":
      return ["sessionId", "directory"];
    case "permission-request":
      return ["sessionId", "directory", "toolName"];
    default:
      return [];
  }
}

/**
 * Validates that an input object contains all required fields.
 * Returns true if all required fields are present, false otherwise.
 * Logs missing keys at debug level on failure.
 */
function validateHookInput<T>(
  input: unknown,
  requiredFields: string[],
  hookType?: string,
): input is T {
  if (typeof input !== "object" || input === null) return false;
  const obj = input as Record<string, unknown>;
  const missing = requiredFields.filter(
    (field) => !(field in obj) || obj[field] === undefined,
  );
  if (missing.length > 0) {
    console.error(
      `[hook-bridge] validateHookInput failed for "${hookType ?? "unknown"}": missing keys: ${missing.join(", ")}`,
    );
    return false;
  }
  return true;
}

/**
 * Input format from Claude Code hooks (via stdin)
 */
export interface HookInput {
  /** Session identifier */
  sessionId?: string;
  /** User prompt text */
  prompt?: string;
  /** Message content (alternative to prompt) */
  message?: {
    content?: string;
  };
  /** Message parts (alternative structure) */
  parts?: Array<{
    type: string;
    text?: string;
  }>;
  /** Tool name (for tool hooks) */
  toolName?: string;
  /** Tool input parameters */
  toolInput?: unknown;
  /** Tool output (for post-tool hooks) */
  toolOutput?: unknown;
  /** Working directory */
  directory?: string;
}

/**
 * Output format for Claude Code hooks (to stdout)
 */
export interface HookOutput {
  /** Whether to continue with the operation */
  continue: boolean;
  /** Optional message to inject into context */
  message?: string;
  /** Reason for blocking (when continue=false) */
  reason?: string;
  /** Modified tool input (for pre-tool hooks) */
  modifiedInput?: unknown;
}

/**
 * Hook types that can be processed
 */
export type HookType =
  | "keyword-detector"
  | "stop-continuation"
  | "ralph"
  | "persistent-mode"
  | "session-start"
  | "session-end" // NEW: Cleanup and metrics on session end
  | "pre-tool-use"
  | "post-tool-use"
  | "autopilot"
  | "subagent-start" // NEW: Track agent spawns
  | "subagent-stop" // NEW: Verify agent completion
  | "pre-compact" // NEW: Save state before compaction
  | "setup-init" // NEW: One-time initialization
  | "setup-maintenance" // NEW: Periodic maintenance
  | "permission-request" // NEW: Smart auto-approval
  | "code-simplifier"; // NEW: Auto-simplify recently modified files on Stop

/**
 * Extract prompt text from various input formats
 */
function getPromptText(input: HookInput): string {
  if (input.prompt) {
    return input.prompt;
  }
  if (input.message?.content) {
    return input.message.content;
  }
  if (input.parts) {
    return input.parts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join(" ");
  }
  return "";
}

/**
 * Process keyword detection hook
 * Detects magic keywords and returns injection message
 * Also activates persistent state for modes that require it (ralph, ultrawork)
 */
async function processKeywordDetector(input: HookInput): Promise<HookOutput> {
  const promptText = getPromptText(input);
  if (!promptText) {
    return { continue: true };
  }

  // Remove code blocks to prevent false positives
  const cleanedText = removeCodeBlocks(promptText);

  // Get all keywords (supports multiple keywords in one prompt)
  const keywords = getAllKeywords(cleanedText);

  if (keywords.length === 0) {
    return { continue: true };
  }

  const sessionId = input.sessionId;
  const directory = resolveToWorktreeRoot(input.directory);
  const messages: string[] = [];

  // Process each keyword and collect messages
  for (const keywordType of keywords) {
    switch (keywordType) {
      case "ralph": {
        // Lazy-load ralph module
        const { createRalphLoopHook } = await import("./ralph/index.js");
        // Activate ralph state which also auto-activates ultrawork
        const hook = createRalphLoopHook(directory);
        hook.startLoop(sessionId, promptText);
        messages.push(RALPH_MESSAGE);
        break;
      }

      case "ultrawork": {
        // Lazy-load ultrawork module
        const { activateUltrawork } = await import("./ultrawork/index.js");
        // Activate persistent ultrawork state
        activateUltrawork(promptText, sessionId, directory);
        messages.push(ULTRAWORK_MESSAGE);
        break;
      }

      case "ultrathink":
        messages.push(ULTRATHINK_MESSAGE);
        break;

      case "deepsearch":
        messages.push(SEARCH_MESSAGE);
        break;

      case "analyze":
        messages.push(ANALYZE_MESSAGE);
        break;

      // For modes without dedicated message constants, return generic activation message
      // These are handled by UserPromptSubmit hook for skill invocation
      case "cancel":
      case "autopilot":
      case "team":
      case "pipeline":
      case "ralplan":
      case "plan":
      case "tdd":
        messages.push(
          `[MODE: ${keywordType.toUpperCase()}] Skill invocation handled by UserPromptSubmit hook.`,
        );
        break;

      default:
        // Skip unknown keywords
        break;
    }
  }

  // Return combined message with delimiter
  if (messages.length === 0) {
    return { continue: true };
  }

  return {
    continue: true,
    message: messages.join("\n\n---\n\n"),
  };
}

/**
 * Process stop continuation hook
 * NOTE: Simplified to always return continue: true (soft enforcement only).
 * All continuation enforcement is now done via message injection, not blocking.
 */
async function processStopContinuation(_input: HookInput): Promise<HookOutput> {
  // Always allow stop - no hard blocking
  return { continue: true };
}

/**
 * Process Ralph hook (session.idle event)
 * Continues work loops until completion promise is detected and architect verifies
 */
async function processRalph(input: HookInput): Promise<HookOutput> {
  const sessionId = input.sessionId;
  const directory = resolveToWorktreeRoot(input.directory);

  if (!sessionId) {
    return { continue: true };
  }

  // Lazy-load ralph module
  const {
    readRalphState,
    incrementRalphIteration,
    clearRalphState,
    readVerificationState,
    getArchitectVerificationPrompt,
    clearVerificationState,
  } = await import("./ralph/index.js");

  // Read Ralph state
  const state = readRalphState(directory);

  if (!state || !state.active) {
    return { continue: true };
  }

  // Strict session isolation: only process state for matching session
  if (state.session_id !== sessionId) {
    return { continue: true };
  }

  // Check for existing verification state (architect verification in progress)
  const verificationState = readVerificationState(directory);

  if (verificationState?.pending) {
    // Check if architect has approved (by looking for the tag in transcript)
    // This is handled more thoroughly in persistent-mode hook
    // Here we just remind to spawn architect if verification is pending
    const verificationPrompt =
      getArchitectVerificationPrompt(verificationState);
    return {
      continue: true,
      message: verificationPrompt,
    };
  }

  // Check max iterations
  if (state.iteration >= state.max_iterations) {
    clearRalphState(directory);
    clearVerificationState(directory);
    return {
      continue: true,
      message: `[RALPH LOOP STOPPED] Max iterations (${state.max_iterations}) reached without completion.`,
    };
  }

  // Increment and continue
  const newState = incrementRalphIteration(directory);
  if (!newState) {
    return { continue: true };
  }

  const continuationPrompt = `[RALPH LOOP - ITERATION ${newState.iteration}/${newState.max_iterations}]

The task is NOT complete yet. Continue working.

IMPORTANT:
- Review your progress so far
- Continue from where you left off
- When FULLY complete (after Architect verification), run \`/oh-my-claudecode:cancel\` to cleanly exit and clean up state files. If cancel fails, retry with \`/oh-my-claudecode:cancel --force\`.
- Do not stop until the task is truly done

Original task:
${newState.prompt}`;

  return {
    continue: true,
    message: continuationPrompt,
  };
}

/**
 * Process persistent mode hook (enhanced stop continuation)
 * Unified handler for ultrawork, ralph, and todo-continuation
 */
async function processPersistentMode(input: HookInput): Promise<HookOutput> {
  const sessionId = input.sessionId;
  const directory = resolveToWorktreeRoot(input.directory);

  // Lazy-load persistent-mode and todo-continuation modules
  const { checkPersistentModes, createHookOutput } = await import("./persistent-mode/index.js");

  // Extract stop context for abort detection (supports both camelCase and snake_case)
  const stopContext: StopContext = {
    stop_reason: (input as Record<string, unknown>).stop_reason as
      | string
      | undefined,
    stopReason: (input as Record<string, unknown>).stopReason as
      | string
      | undefined,
    user_requested: (input as Record<string, unknown>).user_requested as
      | boolean
      | undefined,
    userRequested: (input as Record<string, unknown>).userRequested as
      | boolean
      | undefined,
  };

  const result = await checkPersistentModes(sessionId, directory, stopContext);
  const output = createHookOutput(result);

  const teamState = readTeamStagedState(directory, sessionId);
  if (!teamState || teamState.active !== true || isTeamStateTerminal(teamState)) {
    // No persistent mode and no active team — Claude is truly idle.
    // Send session-idle notification (non-blocking) unless this was a user abort or context limit.
    if (result.mode === "none" && sessionId) {
      const isAbort = stopContext.user_requested === true || stopContext.userRequested === true;
      const isContextLimit = stopContext.stop_reason === "context_limit" || stopContext.stopReason === "context_limit";
      if (!isAbort && !isContextLimit) {
        import("../notifications/index.js").then(({ notify }) =>
          notify("session-idle", {
            sessionId,
            projectPath: directory,
            profileName: process.env.OMC_NOTIFY_PROFILE,
          }).catch(() => {})
        ).catch(() => {});
      }

      // IMPORTANT: Do NOT clean up reply-listener/session-registry on Stop hooks.
      // Stop can fire for normal "idle" turns while the session is still active.
      // Reply cleanup is handled in the true SessionEnd hook only.
    }
    return output;
  }

  const stage = getTeamStage(teamState);
  const stagePrompt = getTeamStagePrompt(stage);
  const teamName = teamState.team_name || teamState.teamName || "team";
  const currentMessage = output.message ? `${output.message}\n` : "";

  return {
    ...output,
    message: `${currentMessage}<team-stage-continuation>

[TEAM MODE CONTINUATION]

Team "${teamName}" is currently in stage: ${stage}
${stagePrompt}

While stage state is active and non-terminal, keep progressing the staged workflow.
When team verification passes or cancel is requested, allow terminal cleanup behavior.

</team-stage-continuation>

---

`,
  };
}

/**
 * Process session start hook
 * Restores persistent mode states and injects context if needed
 */
async function processSessionStart(input: HookInput): Promise<HookOutput> {
  const sessionId = input.sessionId;
  const directory = resolveToWorktreeRoot(input.directory);

  // Lazy-load session-start dependencies
  const { initSilentAutoUpdate } = await import("../features/auto-update.js");
  const { readAutopilotState } = await import("./autopilot/index.js");
  const { readUltraworkState } = await import("./ultrawork/index.js");
  const { checkIncompleteTodos } = await import("./todo-continuation/index.js");

  // Trigger silent auto-update check (non-blocking, checks config internally)
  initSilentAutoUpdate();

  // Send session-start notification (non-blocking, swallows errors)
  if (sessionId) {
    import("../notifications/index.js").then(({ notify }) =>
      notify("session-start", {
        sessionId,
        projectPath: directory,
        profileName: process.env.OMC_NOTIFY_PROFILE,
      }).catch(() => {})
    ).catch(() => {});
  }

  // Start reply listener daemon if configured (non-blocking, swallows errors)
  if (sessionId) {
    Promise.all([
      import("../notifications/reply-listener.js"),
      import("../notifications/config.js"),
    ]).then(
      ([
        { startReplyListener },
        { getReplyConfig, getNotificationConfig, getReplyListenerPlatformConfig },
      ]) => {
      const replyConfig = getReplyConfig();
      if (!replyConfig) return;
      const notifConfig = getNotificationConfig();
      const platformConfig = getReplyListenerPlatformConfig(notifConfig);
      startReplyListener({
        ...replyConfig,
        ...platformConfig,
      });
    }).catch(() => {});
  }

  const messages: string[] = [];

  // Check for active autopilot state - only restore if it belongs to this session
  const autopilotState = readAutopilotState(directory);
  if (autopilotState?.active && autopilotState.session_id === sessionId) {
    messages.push(`<session-restore>

[AUTOPILOT MODE RESTORED]

You have an active autopilot session from ${autopilotState.started_at}.
Original idea: ${autopilotState.originalIdea}
Current phase: ${autopilotState.phase}

Continue autopilot execution until complete.

</session-restore>

---

`);
  }

  // Check for active ultrawork state - only restore if it belongs to this session
  const ultraworkState = readUltraworkState(directory);
  if (ultraworkState?.active && ultraworkState.session_id === sessionId) {
    messages.push(`<session-restore>

[ULTRAWORK MODE RESTORED]

You have an active ultrawork session from ${ultraworkState.started_at}.
Original task: ${ultraworkState.original_prompt}

Continue working in ultrawork mode until all tasks are complete.

</session-restore>

---

`);
  }

  const teamState = readTeamStagedState(directory, sessionId);
  if (teamState?.active) {
    const teamName = teamState.team_name || teamState.teamName || "team";
    const stage = getTeamStage(teamState);

    if (isTeamStateTerminal(teamState)) {
      messages.push(`<session-restore>

[TEAM MODE TERMINAL STATE DETECTED]

Team "${teamName}" stage state is terminal (${stage}).
If this is expected, run normal cleanup/cancel completion flow and clear stale Team state files.

</session-restore>

---

`);
    } else {
      messages.push(`<session-restore>

[TEAM MODE RESTORED]

You have an active Team staged run for "${teamName}".
Current stage: ${stage}
${getTeamStagePrompt(stage)}

Resume from this stage and continue the staged Team workflow.

</session-restore>

---

`);
    }
  }

  // Load root AGENTS.md if it exists (deepinit output - issue #613)
  const agentsMdPath = join(directory, 'AGENTS.md');
  if (existsSync(agentsMdPath)) {
    try {
      let agentsContent = readFileSync(agentsMdPath, 'utf-8').trim();
      if (agentsContent) {
        // Truncate to ~5000 tokens (20000 chars) to avoid context bloat
        const MAX_AGENTS_CHARS = 20000;
        let truncationNotice = '';
        if (agentsContent.length > MAX_AGENTS_CHARS) {
          agentsContent = agentsContent.slice(0, MAX_AGENTS_CHARS);
          truncationNotice = `\n\n[Note: Content was truncated. For full context, read: ${agentsMdPath}]`;
        }
        messages.push(`<session-restore>

[ROOT AGENTS.md LOADED]

The following project documentation was generated by deepinit to help AI agents understand the codebase:

${agentsContent}${truncationNotice}

</session-restore>

---

`);
      }
    } catch {
      // Skip if file can't be read
    }
  }

  // Check for incomplete todos
  const todoResult = await checkIncompleteTodos(sessionId, directory);
  if (todoResult.count > 0) {
    messages.push(`<session-restore>

[PENDING TASKS DETECTED]

You have ${todoResult.count} incomplete tasks from a previous session.
Please continue working on these tasks.

</session-restore>

---

`);
  }

  if (messages.length > 0) {
    return {
      continue: true,
      message: messages.join("\n"),
    };
  }

  return { continue: true };
}

/**
 * Fire-and-forget notification for AskUserQuestion (issue #597).
 * Extracted for testability; the dynamic import makes direct assertion
 * on the notify() call timing-sensitive, so tests spy on this wrapper instead.
 */
export function dispatchAskUserQuestionNotification(
  sessionId: string,
  directory: string,
  toolInput: unknown,
): void {
  const input = toolInput as { questions?: Array<{ question?: string }> } | undefined;
  const questions = input?.questions || [];
  const questionText = questions.map(q => q.question || "").filter(Boolean).join("; ") || "User input requested";

  import("../notifications/index.js").then(({ notify }) =>
    notify("ask-user-question", {
      sessionId,
      projectPath: directory,
      question: questionText,
      profileName: process.env.OMC_NOTIFY_PROFILE,
    }).catch(() => {})
  ).catch(() => {});
}

/** @internal Object wrapper so tests can spy on the dispatch call. */
export const _notify = {
  askUserQuestion: dispatchAskUserQuestionNotification,
};

/**
 * Process pre-tool-use hook
 * Checks delegation enforcement and tracks background tasks
 */
function processPreToolUse(input: HookInput): HookOutput {
  const directory = resolveToWorktreeRoot(input.directory);

  // Check delegation enforcement FIRST
  const enforcementResult = processOrchestratorPreTool({
    toolName: input.toolName || "",
    toolInput: (input.toolInput as Record<string, unknown>) || {},
    sessionId: input.sessionId,
    directory,
  });

  // If enforcement blocks, return immediately
  if (!enforcementResult.continue) {
    return {
      continue: false,
      reason: enforcementResult.reason,
      message: enforcementResult.message,
    };
  }

  // Notify when AskUserQuestion is about to execute (issue #597)
  // Fire-and-forget: notify users that input is needed BEFORE the tool blocks
  if (input.toolName === "AskUserQuestion" && input.sessionId) {
    _notify.askUserQuestion(input.sessionId, directory, input.toolInput);
  }

  // Notify when a new agent is spawned via Task tool (issue #761)
  // Fire-and-forget: verbosity filtering is handled inside notify()
  if (input.toolName === "Task" && input.sessionId) {
    const taskInput = input.toolInput as {
      subagent_type?: string;
      description?: string;
    } | undefined;
    const agentType = taskInput?.subagent_type;
    const agentName = agentType?.includes(":")
      ? agentType.split(":").pop()
      : agentType;
    import("../notifications/index.js").then(({ notify }) =>
      notify("agent-call", {
        sessionId: input.sessionId!,
        projectPath: directory,
        agentName,
        agentType,
        profileName: process.env.OMC_NOTIFY_PROFILE,
      }).catch(() => {})
    ).catch(() => {});
  }

  // Warn about pkill -f self-termination risk (issue #210)
  // Matches: pkill -f, pkill -9 -f, pkill --full, etc.
  if (input.toolName === "Bash") {
    const command = (input.toolInput as { command?: string })?.command ?? "";
    if (
      PKILL_F_FLAG_PATTERN.test(command) ||
      PKILL_FULL_FLAG_PATTERN.test(command)
    ) {
      return {
        continue: true,
        message: [
          "WARNING: `pkill -f` matches its own process command line and will self-terminate the shell (exit code 144 = SIGTERM).",
          "Safer alternatives:",
          "  - `pkill <exact-process-name>` (without -f)",
          '  - `kill $(pgrep -f "pattern")` (pgrep does not kill itself)',
          "Proceeding anyway, but the command may kill this shell session.",
        ].join("\n"),
      };
    }
  }

  // Background process guard - prevent forkbomb (issue #302)
  // Block new background tasks if limit is exceeded
  if (input.toolName === "Task" || input.toolName === "Bash") {
    const toolInput = input.toolInput as
      | {
          description?: string;
          subagent_type?: string;
          run_in_background?: boolean;
          command?: string;
        }
      | undefined;

    if (toolInput?.run_in_background) {
      const config = loadConfig();
      const maxBgTasks = config.permissions?.maxBackgroundTasks ?? 5;
      const runningCount = getRunningTaskCount(directory);

      if (runningCount >= maxBgTasks) {
        return {
          continue: false,
          reason:
            `Background process limit reached (${runningCount}/${maxBgTasks}). ` +
            `Wait for running tasks to complete before starting new ones. ` +
            `Limit is configurable via permissions.maxBackgroundTasks in config or OMC_MAX_BACKGROUND_TASKS env var.`,
        };
      }
    }
  }

  // Track Task tool invocations for HUD background tasks display
  if (input.toolName === "Task") {
    const toolInput = input.toolInput as
      | {
          description?: string;
          subagent_type?: string;
          run_in_background?: boolean;
        }
      | undefined;

    if (toolInput?.description) {
      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      addBackgroundTask(
        taskId,
        toolInput.description,
        toolInput.subagent_type,
        directory,
      );
    }
  }

  // Track file ownership for Edit/Write tools
  if (input.toolName === "Edit" || input.toolName === "Write") {
    const toolInput = input.toolInput as { file_path?: string } | undefined;
    if (toolInput?.file_path && input.sessionId) {
      // Note: We don't have agent_id here in pre-tool, file ownership is recorded elsewhere
      // Record file touch for replay
      recordFileTouch(
        directory,
        input.sessionId,
        "orchestrator",
        toolInput.file_path,
      );
    }
  }

  // Inject agent dashboard for Task tool calls (debugging parallel agents)
  if (input.toolName === "Task") {
    const dashboard = getAgentDashboard(directory);
    if (dashboard) {
      const combined = enforcementResult.message
        ? `${enforcementResult.message}\n\n${dashboard}`
        : dashboard;
      return {
        continue: true,
        message: combined,
      };
    }
  }

  return {
    continue: true,
    ...(enforcementResult.message ? { message: enforcementResult.message } : {}),
  };
}


/**
 * Process post-tool-use hook
 */
function getInvokedSkillName(toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== "object") {
    return null;
  }

  const input = toolInput as Record<string, unknown>;
  const rawSkill =
    input.skill ??
    input.skill_name ??
    input.skillName ??
    input.command ??
    null;

  if (typeof rawSkill !== "string" || rawSkill.trim().length === 0) {
    return null;
  }

  const normalized = rawSkill.trim();
  const namespaced = normalized.includes(":")
    ? normalized.split(":").at(-1)
    : normalized;
  return namespaced?.toLowerCase() || null;
}

async function processPostToolUse(input: HookInput): Promise<HookOutput> {
  const directory = resolveToWorktreeRoot(input.directory);
  const messages: string[] = [];

  // Ensure mode state activation also works when execution starts via Skill tool
  // (e.g., ralplan consensus handoff into Skill("oh-my-claudecode:ralph")).
  const toolName = (input.toolName || "").toLowerCase();
  if (toolName === "skill") {
    const skillName = getInvokedSkillName(input.toolInput);
    if (skillName === "ralph") {
      const { createRalphLoopHook } = await import("./ralph/index.js");
      const promptText =
        typeof input.prompt === "string" && input.prompt.trim().length > 0
          ? input.prompt
          : "Ralph loop activated via Skill tool";
      const hook = createRalphLoopHook(directory);
      hook.startLoop(input.sessionId, promptText);
    }
  }

  // Run orchestrator post-tool processing (remember tags, verification reminders, etc.)
  const orchestratorResult = processOrchestratorPostTool(
    {
      toolName: input.toolName || "",
      toolInput: (input.toolInput as Record<string, unknown>) || {},
      sessionId: input.sessionId,
      directory,
    },
    String(input.toolOutput ?? ""),
  );

  if (orchestratorResult.message) {
    messages.push(orchestratorResult.message);
  }

  // After Task completion, show updated agent dashboard
  if (input.toolName === "Task") {
    const dashboard = getAgentDashboard(directory);
    if (dashboard) {
      messages.push(dashboard);
    }
  }

  if (messages.length > 0) {
    return {
      continue: true,
      message: messages.join("\n\n"),
    };
  }

  return { continue: true };
}

/**
 * Process autopilot hook
 * Manages autopilot state and injects phase prompts
 */
async function processAutopilot(input: HookInput): Promise<HookOutput> {
  const directory = resolveToWorktreeRoot(input.directory);

  // Lazy-load autopilot module
  const { readAutopilotState, getPhasePrompt } = await import("./autopilot/index.js");

  const state = readAutopilotState(directory, input.sessionId);

  if (!state || !state.active) {
    return { continue: true };
  }

  // Check phase and inject appropriate prompt
  const context = {
    idea: state.originalIdea,
    specPath: state.expansion.spec_path || ".omc/autopilot/spec.md",
    planPath: state.planning.plan_path || ".omc/plans/autopilot-impl.md",
  };

  const phasePrompt = getPhasePrompt(state.phase, context);

  if (phasePrompt) {
    return {
      continue: true,
      message: `[AUTOPILOT - Phase: ${state.phase.toUpperCase()}]\n\n${phasePrompt}`,
    };
  }

  return { continue: true };
}

/**
 * Cached parsed OMC_SKIP_HOOKS for performance (env vars don't change during process lifetime)
 */
let _cachedSkipHooks: string[] | null = null;
function getSkipHooks(): string[] {
  if (_cachedSkipHooks === null) {
    _cachedSkipHooks =
      process.env.OMC_SKIP_HOOKS?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) ?? [];
  }
  return _cachedSkipHooks;
}

/**
 * Reset the skip hooks cache (for testing only)
 */
export function resetSkipHooksCache(): void {
  _cachedSkipHooks = null;
}

/**
 * Main hook processor
 * Routes to specific hook handler based on type
 */
export async function processHook(
  hookType: HookType,
  rawInput: HookInput,
): Promise<HookOutput> {
  // Environment kill-switches for plugin coexistence
  if (process.env.DISABLE_OMC === "1" || process.env.DISABLE_OMC === "true") {
    return { continue: true };
  }
  const skipHooks = getSkipHooks();
  if (skipHooks.includes(hookType)) {
    return { continue: true };
  }

  // Normalize snake_case fields from Claude Code to camelCase
  const input = normalizeHookInput(rawInput, hookType) as HookInput;

  try {
    switch (hookType) {
      case "keyword-detector":
        return await processKeywordDetector(input);

      case "stop-continuation":
        return await processStopContinuation(input);

      case "ralph":
        return await processRalph(input);

      case "persistent-mode":
        return await processPersistentMode(input);

      case "session-start":
        return await processSessionStart(input);

      case "pre-tool-use":
        return processPreToolUse(input);

      case "post-tool-use":
        return await processPostToolUse(input);

      case "autopilot":
        return await processAutopilot(input);

      // Lazy-loaded async hook types
      case "session-end": {
        if (!validateHookInput<SessionEndInput>(input, requiredKeysForHook("session-end"), "session-end")) {
          return { continue: true };
        }
        const { handleSessionEnd } = await import("./session-end/index.js");
        return await handleSessionEnd(input as SessionEndInput);
      }

      case "subagent-start": {
        if (
          !validateHookInput<SubagentStartInput>(input, requiredKeysForHook("subagent-start"), "subagent-start")
        ) {
          return { continue: true };
        }
        const { processSubagentStart } = await import("./subagent-tracker/index.js");
        // Reconstruct snake_case fields from normalized camelCase input.
        // normalizeHookInput maps cwd→directory and session_id→sessionId,
        // but SubagentStartInput expects the original snake_case field names.
        const normalized = input as unknown as Record<string, unknown>;
        const startInput: SubagentStartInput = {
          cwd: (normalized.directory ?? normalized.cwd) as string,
          session_id: (normalized.sessionId ?? normalized.session_id) as string,
          agent_id: normalized.agent_id as string,
          agent_type: normalized.agent_type as string,
          transcript_path: normalized.transcript_path as string,
          permission_mode: normalized.permission_mode as string,
          hook_event_name: "SubagentStart",
          prompt: normalized.prompt as string | undefined,
          model: normalized.model as string | undefined,
        };
        // recordAgentStart is already called inside processSubagentStart,
        // so we don't call it here to avoid duplicate session replay entries.
        return processSubagentStart(startInput);
      }

      case "subagent-stop": {
        if (
          !validateHookInput<SubagentStopInput>(input, requiredKeysForHook("subagent-stop"), "subagent-stop")
        ) {
          return { continue: true };
        }
        const { processSubagentStop } = await import("./subagent-tracker/index.js");
        // Reconstruct snake_case fields from normalized camelCase input.
        // Same normalization mismatch as subagent-start: cwd→directory, session_id→sessionId.
        const normalizedStop = input as unknown as Record<string, unknown>;
        const stopInput: SubagentStopInput = {
          cwd: (normalizedStop.directory ?? normalizedStop.cwd) as string,
          session_id: (normalizedStop.sessionId ?? normalizedStop.session_id) as string,
          agent_id: normalizedStop.agent_id as string,
          agent_type: normalizedStop.agent_type as string,
          transcript_path: normalizedStop.transcript_path as string,
          permission_mode: normalizedStop.permission_mode as string,
          hook_event_name: "SubagentStop",
          output: normalizedStop.output as string | undefined,
          success: normalizedStop.success as boolean | undefined,
        };
        // recordAgentStop is already called inside processSubagentStop,
        // so we don't call it here to avoid duplicate session replay entries.
        return processSubagentStop(stopInput);
      }

      case "pre-compact": {
        if (!validateHookInput<PreCompactInput>(input, requiredKeysForHook("pre-compact"), "pre-compact")) {
          return { continue: true };
        }
        const { processPreCompact } = await import("./pre-compact/index.js");
        return await processPreCompact(input as PreCompactInput);
      }

      case "setup-init":
      case "setup-maintenance": {
        if (!validateHookInput<SetupInput>(input, requiredKeysForHook(hookType), hookType)) {
          return { continue: true };
        }
        const { processSetup } = await import("./setup/index.js");
        return await processSetup({
          ...(input as SetupInput),
          trigger: hookType === "setup-init" ? "init" : "maintenance",
          hook_event_name: "Setup",
        });
      }

      case "permission-request": {
        if (
          !validateHookInput<PermissionRequestInput>(input, requiredKeysForHook("permission-request"), "permission-request")
        ) {
          return { continue: true };
        }
        const { handlePermissionRequest } = await import("./permission-handler/index.js");
        return await handlePermissionRequest(input as PermissionRequestInput);
      }

      case "code-simplifier": {
        const directory = input.directory ?? process.cwd();
        const stateDir = join(resolveToWorktreeRoot(directory), ".omc", "state");
        const { processCodeSimplifier } = await import("./code-simplifier/index.js");
        const result = processCodeSimplifier(directory, stateDir);
        if (result.shouldBlock) {
          return { continue: false, message: result.message };
        }
        return { continue: true };
      }

      default:
        return { continue: true };
    }
  } catch (error) {
    // Log error but don't block execution
    console.error(`[hook-bridge] Error in ${hookType}:`, error);
    return { continue: true };
  }
}

/**
 * CLI entry point for shell script invocation
 * Reads JSON from stdin, processes hook, writes JSON to stdout
 */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const hookArg = args.find((a) => a.startsWith("--hook="));

  if (!hookArg) {
    console.error("Usage: node hook-bridge.mjs --hook=<type>");
    process.exit(1);
  }

  const hookTypeRaw = hookArg.slice("--hook=".length).trim();
  if (!hookTypeRaw) {
    console.error("Invalid hook argument format: missing hook type");
    process.exit(1);
  }
  const hookType = hookTypeRaw as HookType;

  // Read stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  const inputStr = Buffer.concat(chunks).toString("utf-8");

  let input: HookInput;
  try {
    input = JSON.parse(inputStr);
  } catch {
    input = {};
  }

  // Process hook
  const output = await processHook(hookType, input);

  // Write output to stdout
  console.log(JSON.stringify(output));
}

// Run if called directly
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[hook-bridge] Fatal error:", err);
    process.exit(1);
  });
}
