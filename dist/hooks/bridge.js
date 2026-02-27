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
import { resolveToWorktreeRoot, getOmcRoot } from "../lib/worktree-paths.js";
// Hot-path imports: needed on every/most hook invocations (keyword-detector, pre/post-tool-use)
import { removeCodeBlocks, getAllKeywordsWithSizeCheck, applyRalplanGate, sanitizeForKeywordDetection, NON_LATIN_SCRIPT_PATTERN, detectDeprecatedKeywords } from "./keyword-detector/index.js";
import { processOrchestratorPreTool, processOrchestratorPostTool } from "./omc-orchestrator/index.js";
import { normalizeHookInput } from "./bridge-normalize.js";
import { addBackgroundTask, getRunningTaskCount, } from "../hud/background-tasks.js";
import { readHudState, writeHudState } from "../hud/state.js";
import { loadConfig } from "../config/loader.js";
import { writeSkillActiveState } from "./skill-state/index.js";
import { ULTRAWORK_MESSAGE, ULTRATHINK_MESSAGE, SEARCH_MESSAGE, ANALYZE_MESSAGE, RALPH_MESSAGE, PROMPT_TRANSLATION_MESSAGE, } from "../installer/hooks.js";
// Agent dashboard is used in pre/post-tool-use hot path
import { getAgentDashboard, } from "./subagent-tracker/index.js";
// Session replay recordFileTouch is used in pre-tool-use hot path
import { recordFileTouch, } from "./subagent-tracker/session-replay.js";
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
function readTeamStagedState(directory, sessionId) {
    const stateDir = join(getOmcRoot(directory), "state");
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
    const sessionId = input.sessionId;
    const directory = resolveToWorktreeRoot(input.directory);
    const messages = [];
    // Check for deprecated keywords and emit warnings (#1131)
    const deprecationWarnings = detectDeprecatedKeywords(cleanedText);
    if (deprecationWarnings.length > 0) {
        messages.push(...deprecationWarnings);
    }
    // Record prompt submission time in HUD state
    try {
        const hudState = readHudState(directory) || {
            timestamp: new Date().toISOString(),
            backgroundTasks: [],
        };
        hudState.lastPromptTimestamp = new Date().toISOString();
        hudState.timestamp = new Date().toISOString();
        writeHudState(hudState, directory);
    }
    catch {
        // Silent failure - don't break keyword detection
    }
    // Load config for task-size detection settings
    const config = loadConfig();
    const taskSizeConfig = config.taskSizeDetection ?? {};
    // Get all keywords with optional task-size filtering (issue #790)
    const sizeCheckResult = getAllKeywordsWithSizeCheck(cleanedText, {
        enabled: taskSizeConfig.enabled !== false,
        smallWordLimit: taskSizeConfig.smallWordLimit ?? 50,
        largeWordLimit: taskSizeConfig.largeWordLimit ?? 200,
        suppressHeavyModesForSmallTasks: taskSizeConfig.suppressHeavyModesForSmallTasks !== false,
    });
    // Apply ralplan-first gate BEFORE task-size suppression (issue #997).
    // Reconstruct the full keyword set so the gate sees execution keywords
    // that task-size suppression may have already removed for small tasks.
    const fullKeywords = [...sizeCheckResult.keywords, ...sizeCheckResult.suppressedKeywords];
    const gateResult = applyRalplanGate(fullKeywords, cleanedText);
    let keywords;
    if (gateResult.gateApplied) {
        // Gate fired: redirect to ralplan (task-size suppression is moot — we're planning, not executing)
        keywords = gateResult.keywords;
        const gated = gateResult.gatedKeywords.join(', ');
        messages.push(`[RALPLAN GATE] Redirecting ${gated} → ralplan for scoping.\n` +
            `Tip: add a concrete anchor to run directly next time:\n` +
            `  \u2022 "ralph fix the bug in src/auth.ts"  (file path)\n` +
            `  \u2022 "ralph implement #42"               (issue number)\n` +
            `  \u2022 "ralph fix processKeyword"           (symbol name)\n` +
            `Or prefix with \`force:\` / \`!\` to bypass.`);
    }
    else {
        // Gate did not fire: use task-size-suppressed result as normal
        keywords = sizeCheckResult.keywords;
        // Notify user when heavy modes were suppressed for a small task
        if (sizeCheckResult.suppressedKeywords.length > 0 && sizeCheckResult.taskSizeResult) {
            const suppressed = sizeCheckResult.suppressedKeywords.join(', ');
            const reason = sizeCheckResult.taskSizeResult.reason;
            messages.push(`[TASK-SIZE: SMALL] Heavy orchestration mode(s) suppressed: ${suppressed}.\n` +
                `Reason: ${reason}\n` +
                `Running directly without heavy agent stacking. ` +
                `Prefix with \`quick:\`, \`simple:\`, or \`tiny:\` to always use lightweight mode. ` +
                `Use explicit mode keywords (e.g. \`ralph\`) only when you need full orchestration.`);
        }
    }
    const sanitizedText = sanitizeForKeywordDetection(cleanedText);
    if (NON_LATIN_SCRIPT_PATTERN.test(sanitizedText)) {
        messages.push(PROMPT_TRANSLATION_MESSAGE);
    }
    // Wake OpenClaw gateway for keyword-detector (non-blocking, fires for all prompts)
    if (input.sessionId) {
        _openclaw.wake("keyword-detector", {
            sessionId: input.sessionId,
            projectPath: directory,
            prompt: cleanedText,
        });
    }
    if (keywords.length === 0) {
        if (messages.length > 0) {
            return { continue: true, message: messages.join('\n\n---\n\n') };
        }
        return { continue: true };
    }
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
            case "ralplan":
            case "tdd":
                messages.push(`[MODE: ${keywordType.toUpperCase()}] Skill invocation handled by UserPromptSubmit hook.`);
                break;
            case "codex":
            case "gemini": {
                messages.push(`[MAGIC KEYWORD: omc-teams]\n` +
                    `User intent: delegate to ${keywordType} CLI workers via omc-teams.\n` +
                    `Agent type: ${keywordType}. Parse N from user message (default 1).\n` +
                    `Invoke: /omc-teams N:${keywordType} "<task from user message>"`);
                break;
            }
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
 * Process persistent mode hook (enhanced stop continuation)
 * Unified handler for ultrawork, ralph, and todo-continuation.
 *
 * NOTE: The legacy `processRalph` function was removed in issue #1058.
 * Ralph is now handled exclusively by `checkRalphLoop` inside
 * `persistent-mode/index.ts`, which has richer logic (PRD checks,
 * team pipeline coordination, tool-error injection, cancel caching,
 * ultrawork self-heal, and architect rejection handling).
 */
async function processPersistentMode(input) {
    const rawSessionId = input.session_id;
    const sessionId = input.sessionId ?? rawSessionId;
    const directory = resolveToWorktreeRoot(input.directory);
    // Lazy-load persistent-mode and todo-continuation modules
    const { checkPersistentModes, createHookOutput, shouldSendIdleNotification, recordIdleNotificationSent } = await import("./persistent-mode/index.js");
    const { isExplicitCancelCommand } = await import("./todo-continuation/index.js");
    // Extract stop context for abort detection (supports both camelCase and snake_case)
    const stopContext = {
        stop_reason: input.stop_reason,
        stopReason: input.stopReason,
        end_turn_reason: input.end_turn_reason,
        endTurnReason: input.endTurnReason,
        user_requested: input.user_requested,
        userRequested: input.userRequested,
        prompt: input.prompt,
        tool_name: input.tool_name,
        toolName: input.toolName,
        tool_input: input.tool_input,
        toolInput: input.toolInput,
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
                // Always wake OpenClaw on stop — cooldown only applies to user-facing notifications
                _openclaw.wake("stop", { sessionId, projectPath: directory });
                // Per-session cooldown: prevent notification spam when the session idles repeatedly.
                // Uses session-scoped state so one session does not suppress another.
                const stateDir = join(getOmcRoot(directory), "state");
                if (shouldSendIdleNotification(stateDir, sessionId)) {
                    recordIdleNotificationSent(stateDir, sessionId);
                    import("../notifications/index.js").then(({ notify }) => notify("session-idle", {
                        sessionId,
                        projectPath: directory,
                        profileName: process.env.OMC_NOTIFY_PROFILE,
                    }).catch(() => { })).catch(() => { });
                }
            }
            // IMPORTANT: Do NOT clean up reply-listener/session-registry on Stop hooks.
            // Stop can fire for normal "idle" turns while the session is still active.
            // Reply cleanup is handled in the true SessionEnd hook only.
        }
        return output;
    }
    // Explicit cancel should suppress team continuation prompts.
    if (isExplicitCancelCommand(stopContext)) {
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
    const { buildAgentsOverlay } = await import("./agents-overlay.js");
    // Trigger silent auto-update check (non-blocking, checks config internally)
    initSilentAutoUpdate();
    // Send session-start notification (non-blocking, swallows errors)
    if (sessionId) {
        import("../notifications/index.js").then(({ notify }) => notify("session-start", {
            sessionId,
            projectPath: directory,
            profileName: process.env.OMC_NOTIFY_PROFILE,
        }).catch(() => { })).catch(() => { });
        // Wake OpenClaw gateway for session-start (non-blocking)
        _openclaw.wake("session-start", { sessionId, projectPath: directory });
    }
    // Start reply listener daemon if configured (non-blocking, swallows errors)
    if (sessionId) {
        Promise.all([
            import("../notifications/reply-listener.js"),
            import("../notifications/config.js"),
        ]).then(([{ startReplyListener }, { getReplyConfig, getNotificationConfig, getReplyListenerPlatformConfig },]) => {
            const replyConfig = getReplyConfig();
            if (!replyConfig)
                return;
            const notifConfig = getNotificationConfig();
            const platformConfig = getReplyListenerPlatformConfig(notifConfig);
            startReplyListener({
                ...replyConfig,
                ...platformConfig,
            });
        }).catch(() => { });
    }
    const messages = [];
    // Inject startup codebase map (issue #804) — first context item so agents orient quickly
    try {
        const overlayResult = buildAgentsOverlay(directory);
        if (overlayResult.message) {
            messages.push(overlayResult.message);
        }
    }
    catch {
        // Non-blocking: codebase map failure must never break session start
    }
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
        profileName: process.env.OMC_NOTIFY_PROFILE,
    }).catch(() => { })).catch(() => { });
}
/** @internal Object wrapper so tests can spy on the dispatch call. */
export const _notify = {
    askUserQuestion: dispatchAskUserQuestionNotification,
};
/**
 * @internal Object wrapper for OpenClaw gateway dispatch.
 * Mirrors the _notify pattern for testability (tests spy on _openclaw.wake
 * instead of mocking dynamic imports).
 *
 * Fire-and-forget: the lazy import + double .catch() ensures OpenClaw
 * never blocks hooks or surfaces errors.
 */
export const _openclaw = {
    wake: (event, context) => {
        if (process.env.OMC_OPENCLAW !== "1")
            return;
        import("../openclaw/index.js").then(({ wakeOpenClaw }) => wakeOpenClaw(event, context).catch(() => { })).catch(() => { });
    },
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
    // Force-inherit: strip `model` parameter from Task calls so agents inherit
    // the user's Claude Code model setting instead of OMC per-agent routing (issue #1135)
    let forceInheritInput;
    if (input.toolName === "Task") {
        const taskInput = input.toolInput;
        if (taskInput?.model) {
            const config = loadConfig();
            if (config.routing?.forceInherit) {
                const { model: _stripped, ...rest } = taskInput;
                forceInheritInput = rest;
            }
        }
    }
    // Notify when AskUserQuestion is about to execute (issue #597)
    // Fire-and-forget: notify users that input is needed BEFORE the tool blocks
    if (input.toolName === "AskUserQuestion" && input.sessionId) {
        _notify.askUserQuestion(input.sessionId, directory, input.toolInput);
        // Wake OpenClaw gateway for ask-user-question (non-blocking)
        _openclaw.wake("ask-user-question", {
            sessionId: input.sessionId,
            projectPath: directory,
            question: (() => {
                const ti = input.toolInput;
                return ti?.questions?.map(q => q.question || "").filter(Boolean).join("; ") || "";
            })(),
        });
    }
    // Activate skill state when Skill tool is invoked (issue #1033)
    // This writes skill-active-state.json so the Stop hook can prevent premature
    // session termination while a skill is executing.
    if (input.toolName === "Skill") {
        const skillName = getInvokedSkillName(input.toolInput);
        if (skillName) {
            // Use the statically-imported synchronous write so it completes before
            // the Stop hook can fire. The previous fire-and-forget .then() raced with
            // the Stop hook in short-lived processes.
            try {
                writeSkillActiveState(directory, skillName, input.sessionId);
            }
            catch {
                // Skill-state write is best-effort; don't fail the hook on error.
            }
        }
    }
    // Notify when a new agent is spawned via Task tool (issue #761)
    // Fire-and-forget: verbosity filtering is handled inside notify()
    if (input.toolName === "Task" && input.sessionId) {
        const taskInput = input.toolInput;
        const agentType = taskInput?.subagent_type;
        const agentName = agentType?.includes(":")
            ? agentType.split(":").pop()
            : agentType;
        import("../notifications/index.js").then(({ notify }) => notify("agent-call", {
            sessionId: input.sessionId,
            projectPath: directory,
            agentName,
            agentType,
            profileName: process.env.OMC_NOTIFY_PROFILE,
        }).catch(() => { })).catch(() => { });
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
        const toolInput = input.toolInput;
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
        const toolInput = input.toolInput;
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
            const combined = enforcementResult.message
                ? `${enforcementResult.message}\n\n${dashboard}`
                : dashboard;
            return {
                continue: true,
                message: combined,
                ...(forceInheritInput ? { modifiedInput: forceInheritInput } : {}),
            };
        }
    }
    // Wake OpenClaw gateway for pre-tool-use (non-blocking, fires only for allowed tools)
    if (input.sessionId) {
        _openclaw.wake("pre-tool-use", {
            sessionId: input.sessionId,
            projectPath: directory,
            toolName: input.toolName,
        });
    }
    return {
        continue: true,
        ...(enforcementResult.message ? { message: enforcementResult.message } : {}),
        ...(forceInheritInput ? { modifiedInput: forceInheritInput } : {}),
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
    // Wake OpenClaw gateway for post-tool-use (non-blocking, fires for all tools)
    if (input.sessionId) {
        _openclaw.wake("post-tool-use", {
            sessionId: input.sessionId,
            projectPath: directory,
            toolName: input.toolName,
        });
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
                // Ralph is now handled by the unified persistent-mode handler (issue #1058).
                return await processPersistentMode(input);
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
                // De-normalize: SessionEndInput expects snake_case fields (session_id, cwd).
                // normalizeHookInput mapped session_id→sessionId and cwd→directory, so we
                // must reconstruct the snake_case shape before calling the handler.
                const rawSE = input;
                const sessionEndInput = {
                    session_id: (rawSE.sessionId ?? rawSE.session_id),
                    cwd: (rawSE.directory ?? rawSE.cwd),
                    transcript_path: rawSE.transcript_path,
                    permission_mode: (rawSE.permission_mode ?? "default"),
                    hook_event_name: "SessionEnd",
                    reason: rawSE.reason ?? "other",
                };
                return await handleSessionEnd(sessionEndInput);
            }
            case "subagent-start": {
                if (!validateHookInput(input, requiredKeysForHook("subagent-start"), "subagent-start")) {
                    return { continue: true };
                }
                const { processSubagentStart } = await import("./subagent-tracker/index.js");
                // Reconstruct snake_case fields from normalized camelCase input.
                // normalizeHookInput maps cwd→directory and session_id→sessionId,
                // but SubagentStartInput expects the original snake_case field names.
                const normalized = input;
                const startInput = {
                    cwd: (normalized.directory ?? normalized.cwd),
                    session_id: (normalized.sessionId ?? normalized.session_id),
                    agent_id: normalized.agent_id,
                    agent_type: normalized.agent_type,
                    transcript_path: normalized.transcript_path,
                    permission_mode: normalized.permission_mode,
                    hook_event_name: "SubagentStart",
                    prompt: normalized.prompt,
                    model: normalized.model,
                };
                // recordAgentStart is already called inside processSubagentStart,
                // so we don't call it here to avoid duplicate session replay entries.
                return processSubagentStart(startInput);
            }
            case "subagent-stop": {
                if (!validateHookInput(input, requiredKeysForHook("subagent-stop"), "subagent-stop")) {
                    return { continue: true };
                }
                const { processSubagentStop } = await import("./subagent-tracker/index.js");
                // Reconstruct snake_case fields from normalized camelCase input.
                // Same normalization mismatch as subagent-start: cwd→directory, session_id→sessionId.
                const normalizedStop = input;
                const stopInput = {
                    cwd: (normalizedStop.directory ?? normalizedStop.cwd),
                    session_id: (normalizedStop.sessionId ?? normalizedStop.session_id),
                    agent_id: normalizedStop.agent_id,
                    agent_type: normalizedStop.agent_type,
                    transcript_path: normalizedStop.transcript_path,
                    permission_mode: normalizedStop.permission_mode,
                    hook_event_name: "SubagentStop",
                    output: normalizedStop.output,
                    success: normalizedStop.success,
                };
                // recordAgentStop is already called inside processSubagentStop,
                // so we don't call it here to avoid duplicate session replay entries.
                return processSubagentStop(stopInput);
            }
            case "pre-compact": {
                if (!validateHookInput(input, requiredKeysForHook("pre-compact"), "pre-compact")) {
                    return { continue: true };
                }
                const { processPreCompact } = await import("./pre-compact/index.js");
                // De-normalize: PreCompactInput expects snake_case fields (session_id, cwd).
                const rawPC = input;
                const preCompactInput = {
                    session_id: (rawPC.sessionId ?? rawPC.session_id),
                    cwd: (rawPC.directory ?? rawPC.cwd),
                    transcript_path: rawPC.transcript_path,
                    permission_mode: (rawPC.permission_mode ?? "default"),
                    hook_event_name: "PreCompact",
                    trigger: rawPC.trigger ?? "auto",
                    custom_instructions: rawPC.custom_instructions,
                };
                return await processPreCompact(preCompactInput);
            }
            case "setup-init":
            case "setup-maintenance": {
                if (!validateHookInput(input, requiredKeysForHook(hookType), hookType)) {
                    return { continue: true };
                }
                const { processSetup } = await import("./setup/index.js");
                // De-normalize: SetupInput expects snake_case fields (session_id, cwd).
                const rawSetup = input;
                const setupInput = {
                    session_id: (rawSetup.sessionId ?? rawSetup.session_id),
                    cwd: (rawSetup.directory ?? rawSetup.cwd),
                    transcript_path: rawSetup.transcript_path,
                    permission_mode: (rawSetup.permission_mode ?? "default"),
                    hook_event_name: "Setup",
                    trigger: hookType === "setup-init" ? "init" : "maintenance",
                };
                return await processSetup(setupInput);
            }
            case "permission-request": {
                if (!validateHookInput(input, requiredKeysForHook("permission-request"), "permission-request")) {
                    return { continue: true };
                }
                const { handlePermissionRequest } = await import("./permission-handler/index.js");
                // De-normalize: PermissionRequestInput expects snake_case fields
                // (session_id, cwd, tool_name, tool_input).
                const rawPR = input;
                const permissionInput = {
                    session_id: (rawPR.sessionId ?? rawPR.session_id),
                    cwd: (rawPR.directory ?? rawPR.cwd),
                    tool_name: (rawPR.toolName ?? rawPR.tool_name),
                    tool_input: (rawPR.toolInput ?? rawPR.tool_input),
                    transcript_path: rawPR.transcript_path,
                    permission_mode: (rawPR.permission_mode ?? "default"),
                    hook_event_name: "PermissionRequest",
                    tool_use_id: rawPR.tool_use_id,
                };
                return await handlePermissionRequest(permissionInput);
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