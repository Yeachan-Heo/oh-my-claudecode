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

import { removeCodeBlocks, getAllKeywords } from "./keyword-detector/index.js";
import {
  readRalphState,
  incrementRalphIteration,
  clearRalphState,
  createRalphLoopHook,
} from "./ralph/index.js";
import { processOrchestratorPreTool } from "./omc-orchestrator/index.js";
import {
  addBackgroundTask,
  getRunningTaskCount,
} from "../hud/background-tasks.js";
import { loadConfig } from "../config/loader.js";
import {
  readVerificationState,
  getArchitectVerificationPrompt,
  clearVerificationState,
} from "./ralph/index.js";
import {
  checkIncompleteTodos,
  StopContext,
} from "./todo-continuation/index.js";
import {
  checkPersistentModes,
  createHookOutput,
} from "./persistent-mode/index.js";
import { activateUltrawork, readUltraworkState } from "./ultrawork/index.js";
import {
  readAutopilotState,
  isAutopilotActive,
  getPhasePrompt,
  transitionPhase,
  formatCompactSummary,
} from "./autopilot/index.js";
import {
  ULTRAWORK_MESSAGE,
  ULTRATHINK_MESSAGE,
  SEARCH_MESSAGE,
  ANALYZE_MESSAGE,
  TODO_CONTINUATION_PROMPT,
  RALPH_MESSAGE,
} from "../installer/hooks.js";

// New async hook imports
import {
  processSubagentStart,
  processSubagentStop,
  getAgentDashboard,
  getAgentObservatory,
  recordFileOwnership,
  suggestInterventions,
  type SubagentStartInput,
  type SubagentStopInput,
} from "./subagent-tracker/index.js";

import {
  recordAgentStart,
  recordAgentStop,
  recordToolEvent,
  recordFileTouch,
} from "./subagent-tracker/session-replay.js";
import {
  processPreCompact,
  type PreCompactInput,
} from "./pre-compact/index.js";
import { processSetup, type SetupInput } from "./setup/index.js";
import {
  handlePermissionRequest,
  type PermissionRequestInput,
} from "./permission-handler/index.js";
import { handleSessionEnd, type SessionEndInput } from "./session-end/index.js";
import { initSilentAutoUpdate } from "../features/auto-update.js";

const PKILL_F_FLAG_PATTERN = /\bpkill\b.*\s-f\b/;
const PKILL_FULL_FLAG_PATTERN = /\bpkill\b.*--full\b/;

/**
 * Validates that an input object contains all required fields.
 * Returns true if all required fields are present, false otherwise.
 */
function validateHookInput<T>(
  input: unknown,
  requiredFields: string[],
): input is T {
  if (typeof input !== "object" || input === null) return false;
  const obj = input as Record<string, unknown>;
  return requiredFields.every(
    (field) => field in obj && obj[field] !== undefined,
  );
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
  | "permission-request"; // NEW: Smart auto-approval

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
function processKeywordDetector(input: HookInput): HookOutput {
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
  const directory = input.directory || process.cwd();
  const messages: string[] = [];

  // Process each keyword and collect messages
  for (const keywordType of keywords) {
    switch (keywordType) {
      case "ralph": {
        // Activate ralph state which also auto-activates ultrawork
        const hook = createRalphLoopHook(directory);
        hook.startLoop(sessionId || "cli-session", promptText);
        messages.push(RALPH_MESSAGE);
        break;
      }

      case "ultrawork":
        // Activate persistent ultrawork state
        activateUltrawork(promptText, sessionId, directory);
        messages.push(ULTRAWORK_MESSAGE);
        break;

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
      case "ultrapilot":
      case "ecomode":
      case "swarm":
      case "pipeline":
      case "ralplan":
      case "plan":
      case "tdd":
      case "research":
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
  const directory = input.directory || process.cwd();

  if (!sessionId) {
    return { continue: true };
  }

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
  const directory = input.directory || process.cwd();

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
  return createHookOutput(result);
}

/**
 * Process session start hook
 * Restores persistent mode states and injects context if needed
 */
async function processSessionStart(input: HookInput): Promise<HookOutput> {
  const sessionId = input.sessionId;
  const directory = input.directory || process.cwd();

  // Trigger silent auto-update check (non-blocking, checks config internally)
  initSilentAutoUpdate();

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
 * Process pre-tool-use hook
 * Checks delegation enforcement and tracks background tasks
 */
function processPreToolUse(input: HookInput): HookOutput {
  const directory = input.directory || process.cwd();

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
      const baseMessage = enforcementResult.message || "";
      const combined = baseMessage
        ? `${baseMessage}\n\n${dashboard}`
        : dashboard;
      return { continue: true, message: combined };
    }
  }

  // Return enforcement message if present (warning), otherwise continue silently
  return enforcementResult.message
    ? { continue: true, message: enforcementResult.message }
    : { continue: true };
}

/**
 * Process post-tool-use hook
 */
function processPostToolUse(input: HookInput): HookOutput {
  const directory = input.directory || process.cwd();

  // After Task completion, show updated agent dashboard
  if (input.toolName === "Task") {
    const dashboard = getAgentDashboard(directory);
    if (dashboard) {
      return {
        continue: true,
        message: dashboard,
      };
    }
  }

  return { continue: true };
}

/**
 * Process autopilot hook
 * Manages autopilot state and injects phase prompts
 */
function processAutopilot(input: HookInput): HookOutput {
  const directory = input.directory || process.cwd();

  const state = readAutopilotState(directory);

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
  input: HookInput,
): Promise<HookOutput> {
  // Environment kill-switches for plugin coexistence
  if (process.env.DISABLE_OMC === "1" || process.env.DISABLE_OMC === "true") {
    return { continue: true };
  }
  const skipHooks = getSkipHooks();
  if (skipHooks.includes(hookType)) {
    return { continue: true };
  }

  try {
    switch (hookType) {
      case "keyword-detector":
        return processKeywordDetector(input);

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
        return processPostToolUse(input);

      case "autopilot":
        return processAutopilot(input);

      // New async hook types
      case "session-end": {
        if (!validateHookInput<SessionEndInput>(input, ["session_id", "cwd"])) {
          console.error(
            "[hook-bridge] Invalid SessionEndInput - missing required fields",
          );
          return { continue: true };
        }
        return await handleSessionEnd(input as SessionEndInput);
      }

      case "subagent-start": {
        if (
          !validateHookInput<SubagentStartInput>(input, ["session_id", "cwd"])
        ) {
          console.error(
            "[hook-bridge] Invalid SubagentStartInput - missing required fields",
          );
          return { continue: true };
        }
        const startInput = input as SubagentStartInput;
        // Record to session replay
        recordAgentStart(
          startInput.cwd,
          startInput.session_id,
          startInput.agent_id,
          startInput.agent_type,
          startInput.prompt,
          undefined, // parentMode detected in tracker
          startInput.model,
        );
        return processSubagentStart(startInput);
      }

      case "subagent-stop": {
        if (
          !validateHookInput<SubagentStopInput>(input, ["session_id", "cwd"])
        ) {
          console.error(
            "[hook-bridge] Invalid SubagentStopInput - missing required fields",
          );
          return { continue: true };
        }
        const stopInput = input as SubagentStopInput;
        const result = processSubagentStop(stopInput);
        // Record to session replay (default to true when SDK doesn't provide success)
        recordAgentStop(
          stopInput.cwd,
          stopInput.session_id,
          stopInput.agent_id,
          stopInput.agent_type,
          stopInput.success !== false,
        );
        return result;
      }

      case "pre-compact": {
        if (!validateHookInput<PreCompactInput>(input, ["session_id", "cwd"])) {
          console.error(
            "[hook-bridge] Invalid PreCompactInput - missing required fields",
          );
          return { continue: true };
        }
        return await processPreCompact(input as PreCompactInput);
      }

      case "setup-init":
      case "setup-maintenance": {
        if (!validateHookInput<SetupInput>(input, ["session_id", "cwd"])) {
          console.error(
            "[hook-bridge] Invalid SetupInput - missing required fields",
          );
          return { continue: true };
        }
        return await processSetup({
          ...(input as SetupInput),
          trigger: hookType === "setup-init" ? "init" : "maintenance",
          hook_event_name: "Setup",
        });
      }

      case "permission-request": {
        if (
          !validateHookInput<PermissionRequestInput>(input, [
            "session_id",
            "cwd",
            "tool_name",
          ])
        ) {
          console.error(
            "[hook-bridge] Invalid PermissionRequestInput - missing required fields",
          );
          return { continue: true };
        }
        return await handlePermissionRequest(input as PermissionRequestInput);
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
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[hook-bridge] Fatal error:", err);
    process.exit(1);
  });
}
