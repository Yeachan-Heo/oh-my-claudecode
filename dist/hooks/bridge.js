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
import { addBackgroundTask, getRunningTaskCount, } from "../hud/background-tasks.js";
import { loadConfig } from "../config/loader.js";
import { isLowTierAgentsEnabled } from "../features/auto-update.js";
import { ULTRAWORK_MESSAGE, ULTRATHINK_MESSAGE, SEARCH_MESSAGE, ANALYZE_MESSAGE, RALPH_MESSAGE, } from "../installer/hooks.js";
// Agent dashboard is used in pre/post-tool-use hot path
import { getAgentDashboard, } from "./subagent-tracker/index.js";
// Session replay recordFileTouch is used in pre-tool-use hot path
import { recordFileTouch, } from "./subagent-tracker/session-replay.js";
const PKILL_F_FLAG_PATTERN = /\bpkill\b.*\s-f\b/;
const PKILL_FULL_FLAG_PATTERN = /\bpkill\b.*--full\b/;
const LOW_TIER_AGENT_REWRITES = {
    'architect-low': 'architect',
    'executor-low': 'executor',
    'designer-low': 'designer',
    'security-reviewer-low': 'security-reviewer',
    'tdd-guide-low': 'tdd-guide',
};
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
function readTeamStagedState(directory, sessionId) {
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
            const parsed = JSON.parse(readFileSync(statePath, "utf-8"));
            if (typeof parsed !== "object" || parsed === null) {
                continue;
            }
            const stateSessionId = parsed.session_id || parsed.sessionId;
            if (sessionId && stateSessionId && stateSessionId !== sessionId) {
                continue;
            }
            return parsed;
        }
        catch {
            continue;
        }
    }
    return null;
}
function getTeamStage(state) {
    return state.stage || state.current_stage || state.currentStage || "team-exec";
}
function isTeamStateTerminal(state) {
    if (state.terminal === true || state.cancelled === true || state.canceled === true || state.completed === true) {
        return true;
    }
    const status = String(state.status || "").toLowerCase();
    const stage = String(getTeamStage(state)).toLowerCase();
    return TEAM_TERMINAL_VALUES.has(status) || TEAM_TERMINAL_VALUES.has(stage);
}
function getTeamStagePrompt(stage) {
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
export function requiredKeysForHook(hookType) {
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
function validateHookInput(input, requiredFields, hookType) {
    if (typeof input !== "object" || input === null)
        return false;
    const obj = input;
    const missing = requiredFields.filter((field) => !(field in obj) || obj[field] === undefined);
    if (missing.length > 0) {
        console.error(`[hook-bridge] validateHookInput failed for "${hookType ?? "unknown"}": missing keys: ${missing.join(", ")}`);
        return false;
    }
    return true;
}
/**
 * Extract prompt text from various input formats
 */
function getPromptText(input) {
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
async function processKeywordDetector(input) {
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
    const messages = [];
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
            case "ecomode":
            case "pipeline":
            case "ralplan":
            case "plan":
            case "tdd":
                messages.push(`[MODE: ${keywordType.toUpperCase()}] Skill invocation handled by UserPromptSubmit hook.`);
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
async function processStopContinuation(_input) {
    // Always allow stop - no hard blocking
    return { continue: true };
}
/**
 * Process Ralph hook (session.idle event)
 * Continues work loops until completion promise is detected and architect verifies
 */
async function processRalph(input) {
    const sessionId = input.sessionId;
    const directory = resolveToWorktreeRoot(input.directory);
    if (!sessionId) {
        return { continue: true };
    }
    // Lazy-load ralph module
    const { readRalphState, incrementRalphIteration, clearRalphState, readVerificationState, getArchitectVerificationPrompt, clearVerificationState, } = await import("./ralph/index.js");
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
        const verificationPrompt = getArchitectVerificationPrompt(verificationState);
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
async function processPersistentMode(input) {
    const sessionId = input.sessionId;
    const directory = resolveToWorktreeRoot(input.directory);
    // Lazy-load persistent-mode and todo-continuation modules
    const { checkPersistentModes, createHookOutput } = await import("./persistent-mode/index.js");
    // Extract stop context for abort detection (supports both camelCase and snake_case)
    const stopContext = {
        stop_reason: input.stop_reason,
        stopReason: input.stopReason,
        user_requested: input.user_requested,
        userRequested: input.userRequested,
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
                import("../notifications/index.js").then(({ notify }) => notify("session-idle", {
                    sessionId,
                    projectPath: directory,
                }).catch(() => { })).catch(() => { });
            }
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
async function processSessionStart(input) {
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
        import("../notifications/index.js").then(({ notify }) => notify("session-start", {
            sessionId,
            projectPath: directory,
        }).catch(() => { })).catch(() => { });
    }
    const messages = [];
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
        }
        else {
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
        }
        catch {
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
export function dispatchAskUserQuestionNotification(sessionId, directory, toolInput) {
    const input = toolInput;
    const questions = input?.questions || [];
    const questionText = questions.map(q => q.question || "").filter(Boolean).join("; ") || "User input requested";
    import("../notifications/index.js").then(({ notify }) => notify("ask-user-question", {
        sessionId,
        projectPath: directory,
        question: questionText,
    }).catch(() => { })).catch(() => { });
}
/** @internal Object wrapper so tests can spy on the dispatch call. */
export const _notify = {
    askUserQuestion: dispatchAskUserQuestionNotification,
};
/**
 * Process pre-tool-use hook
 * Checks delegation enforcement and tracks background tasks
 */
function processPreToolUse(input) {
    const directory = resolveToWorktreeRoot(input.directory);
    // Check delegation enforcement FIRST
    const enforcementResult = processOrchestratorPreTool({
        toolName: input.toolName || "",
        toolInput: input.toolInput || {},
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
    const lowTierRewrite = rewriteLowTierAgentInput(input.toolName, input.toolInput);
    const effectiveToolInput = lowTierRewrite.modifiedInput ?? input.toolInput;
    // Notify when AskUserQuestion is about to execute (issue #597)
    // Fire-and-forget: notify users that input is needed BEFORE the tool blocks
    if (input.toolName === "AskUserQuestion" && input.sessionId) {
        _notify.askUserQuestion(input.sessionId, directory, input.toolInput);
    }
    // Warn about pkill -f self-termination risk (issue #210)
    // Matches: pkill -f, pkill -9 -f, pkill --full, etc.
    if (input.toolName === "Bash") {
        const command = input.toolInput?.command ?? "";
        if (PKILL_F_FLAG_PATTERN.test(command) ||
            PKILL_FULL_FLAG_PATTERN.test(command)) {
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
        const toolInput = effectiveToolInput;
        if (toolInput?.run_in_background) {
            const config = loadConfig();
            const maxBgTasks = config.permissions?.maxBackgroundTasks ?? 5;
            const runningCount = getRunningTaskCount(directory);
            if (runningCount >= maxBgTasks) {
                return {
                    continue: false,
                    reason: `Background process limit reached (${runningCount}/${maxBgTasks}). ` +
                        `Wait for running tasks to complete before starting new ones. ` +
                        `Limit is configurable via permissions.maxBackgroundTasks in config or OMC_MAX_BACKGROUND_TASKS env var.`,
                };
            }
        }
    }
    // Track Task tool invocations for HUD background tasks display
    if (input.toolName === "Task") {
        const toolInput = effectiveToolInput;
        if (toolInput?.description) {
            const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            addBackgroundTask(taskId, toolInput.description, toolInput.subagent_type, directory);
        }
    }
    // Track file ownership for Edit/Write tools
    if (input.toolName === "Edit" || input.toolName === "Write") {
        const toolInput = input.toolInput;
        if (toolInput?.file_path && input.sessionId) {
            // Note: We don't have agent_id here in pre-tool, file ownership is recorded elsewhere
            // Record file touch for replay
            recordFileTouch(directory, input.sessionId, "orchestrator", toolInput.file_path);
        }
    }
    // Inject agent dashboard for Task tool calls (debugging parallel agents)
    if (input.toolName === "Task") {
        const dashboard = getAgentDashboard(directory);
        if (dashboard) {
            const messageParts = [enforcementResult.message, lowTierRewrite.message].filter((part) => typeof part === "string" && part.length > 0);
            const baseMessage = messageParts.join("\n\n");
            const combined = baseMessage
                ? `${baseMessage}\n\n${dashboard}`
                : dashboard;
            return {
                continue: true,
                message: combined,
                ...(lowTierRewrite.modifiedInput !== undefined
                    ? { modifiedInput: lowTierRewrite.modifiedInput }
                    : {}),
            };
        }
    }
    const messageParts = [enforcementResult.message, lowTierRewrite.message].filter((part) => typeof part === "string" && part.length > 0);
    return {
        continue: true,
        ...(messageParts.length > 0 ? { message: messageParts.join("\n\n") } : {}),
        ...(lowTierRewrite.modifiedInput !== undefined
            ? { modifiedInput: lowTierRewrite.modifiedInput }
            : {}),
    };
}
function rewriteLowTierAgentInput(toolName, toolInput) {
    if (!toolName || (toolName !== "Task" && toolName !== "Agent")) {
        return {};
    }
    if (isLowTierAgentsEnabled()) {
        return {};
    }
    if (!toolInput || typeof toolInput !== "object") {
        return {};
    }
    const input = toolInput;
    const rawSubagent = input.subagent_type;
    if (typeof rawSubagent !== "string" || rawSubagent.length === 0) {
        return {};
    }
    const hasPrefix = rawSubagent.startsWith("oh-my-claudecode:");
    const normalized = rawSubagent.replace(/^oh-my-claudecode:/, "");
    const rewrittenBase = LOW_TIER_AGENT_REWRITES[normalized];
    if (!rewrittenBase) {
        return {};
    }
    const rewrittenSubagent = hasPrefix ? `oh-my-claudecode:${rewrittenBase}` : rewrittenBase;
    const modifiedInput = {
        ...input,
        subagent_type: rewrittenSubagent,
    };
    let modelUpgradeNote = "";
    if (input.model === "haiku") {
        modifiedInput.model = "sonnet";
        modelUpgradeNote = " and model=haiku -> sonnet";
    }
    return {
        modifiedInput,
        message: process.env.OMC_DEBUG === "true"
            ? `Low-tier agents disabled via config: rewrote ${rawSubagent} -> ${rewrittenSubagent}${modelUpgradeNote}.`
            : undefined,
    };
}
/**
 * Process post-tool-use hook
 */
function getInvokedSkillName(toolInput) {
    if (!toolInput || typeof toolInput !== "object") {
        return null;
    }
    const input = toolInput;
    const rawSkill = input.skill ??
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
async function processPostToolUse(input) {
    const directory = resolveToWorktreeRoot(input.directory);
    const messages = [];
    // Ensure mode state activation also works when execution starts via Skill tool
    // (e.g., ralplan consensus handoff into Skill("oh-my-claudecode:ralph")).
    const toolName = (input.toolName || "").toLowerCase();
    if (toolName === "skill") {
        const skillName = getInvokedSkillName(input.toolInput);
        if (skillName === "ralph") {
            const { createRalphLoopHook } = await import("./ralph/index.js");
            const promptText = typeof input.prompt === "string" && input.prompt.trim().length > 0
                ? input.prompt
                : "Ralph loop activated via Skill tool";
            const hook = createRalphLoopHook(directory);
            hook.startLoop(input.sessionId, promptText);
        }
    }
    // Run orchestrator post-tool processing (remember tags, verification reminders, etc.)
    const orchestratorResult = processOrchestratorPostTool({
        toolName: input.toolName || "",
        toolInput: input.toolInput || {},
        sessionId: input.sessionId,
        directory,
    }, String(input.toolOutput ?? ""));
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
async function processAutopilot(input) {
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
let _cachedSkipHooks = null;
function getSkipHooks() {
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
export function resetSkipHooksCache() {
    _cachedSkipHooks = null;
}
/**
 * Main hook processor
 * Routes to specific hook handler based on type
 */
export async function processHook(hookType, rawInput) {
    // Environment kill-switches for plugin coexistence
    if (process.env.DISABLE_OMC === "1" || process.env.DISABLE_OMC === "true") {
        return { continue: true };
    }
    const skipHooks = getSkipHooks();
    if (skipHooks.includes(hookType)) {
        return { continue: true };
    }
    // Normalize snake_case fields from Claude Code to camelCase
    const input = normalizeHookInput(rawInput, hookType);
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
                if (!validateHookInput(input, requiredKeysForHook("session-end"), "session-end")) {
                    return { continue: true };
                }
                const { handleSessionEnd } = await import("./session-end/index.js");
                return await handleSessionEnd(input);
            }
            case "subagent-start": {
                if (!validateHookInput(input, requiredKeysForHook("subagent-start"), "subagent-start")) {
                    return { continue: true };
                }
                const { processSubagentStart } = await import("./subagent-tracker/index.js");
                const { recordAgentStart } = await import("./subagent-tracker/session-replay.js");
                const startInput = input;
                // Record to session replay
                recordAgentStart(startInput.cwd, startInput.session_id, startInput.agent_id, startInput.agent_type, startInput.prompt, undefined, // parentMode detected in tracker
                startInput.model);
                return processSubagentStart(startInput);
            }
            case "subagent-stop": {
                if (!validateHookInput(input, requiredKeysForHook("subagent-stop"), "subagent-stop")) {
                    return { continue: true };
                }
                const { processSubagentStop } = await import("./subagent-tracker/index.js");
                const { recordAgentStop } = await import("./subagent-tracker/session-replay.js");
                const stopInput = input;
                const result = processSubagentStop(stopInput);
                // Record to session replay (default to true when SDK doesn't provide success)
                recordAgentStop(stopInput.cwd, stopInput.session_id, stopInput.agent_id, stopInput.agent_type, stopInput.success !== false);
                return result;
            }
            case "pre-compact": {
                if (!validateHookInput(input, requiredKeysForHook("pre-compact"), "pre-compact")) {
                    return { continue: true };
                }
                const { processPreCompact } = await import("./pre-compact/index.js");
                return await processPreCompact(input);
            }
            case "setup-init":
            case "setup-maintenance": {
                if (!validateHookInput(input, requiredKeysForHook(hookType), hookType)) {
                    return { continue: true };
                }
                const { processSetup } = await import("./setup/index.js");
                return await processSetup({
                    ...input,
                    trigger: hookType === "setup-init" ? "init" : "maintenance",
                    hook_event_name: "Setup",
                });
            }
            case "permission-request": {
                if (!validateHookInput(input, requiredKeysForHook("permission-request"), "permission-request")) {
                    return { continue: true };
                }
                const { handlePermissionRequest } = await import("./permission-handler/index.js");
                return await handlePermissionRequest(input);
            }
            default:
                return { continue: true };
        }
    }
    catch (error) {
        // Log error but don't block execution
        console.error(`[hook-bridge] Error in ${hookType}:`, error);
        return { continue: true };
    }
}
/**
 * CLI entry point for shell script invocation
 * Reads JSON from stdin, processes hook, writes JSON to stdout
 */
export async function main() {
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
    const hookType = hookTypeRaw;
    // Read stdin
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    const inputStr = Buffer.concat(chunks).toString("utf-8");
    let input;
    try {
        input = JSON.parse(inputStr);
    }
    catch {
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
//# sourceMappingURL=bridge.js.map