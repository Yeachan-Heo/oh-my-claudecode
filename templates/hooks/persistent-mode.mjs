#!/usr/bin/env node

/**
 * OMC Persistent Mode Hook (Node.js)
 * Minimal continuation enforcer for all OMC modes.
 * Stripped down for reliability — no optional imports, no PRD, no notepad pruning.
 *
 * Supported modes: ralph, autopilot, ultrapilot, swarm, ultrawork, ultraqa, pipeline, team
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  unlinkSync,
} from "fs";
import { join, dirname, resolve, normalize } from "path";
import { homedir } from "os";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Dynamic import for the shared stdin module
const { readStdin } = await import(
  pathToFileURL(join(__dirname, "lib", "stdin.mjs")).href
);

function readJsonFile(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function writeJsonFile(path, data) {
  try {
    // Ensure directory exists
    const dir = dirname(path);
    if (dir && dir !== "." && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read last tool error from state directory.
 * Returns null if file doesn't exist or error is stale (>60 seconds old).
 */
function readLastToolError(stateDir) {
  const errorPath = join(stateDir, "last-tool-error.json");
  const toolError = readJsonFile(errorPath);

  if (!toolError || !toolError.timestamp) return null;

  // Check staleness - errors older than 60 seconds are ignored
  const parsedTime = new Date(toolError.timestamp).getTime();
  if (!Number.isFinite(parsedTime)) {
    return null; // Invalid timestamp = stale
  }
  const age = Date.now() - parsedTime;
  if (age > 60000) return null;

  return toolError;
}

/**
 * Clear tool error state file atomically.
 */
function clearToolErrorState(stateDir) {
  const errorPath = join(stateDir, "last-tool-error.json");
  try {
    if (existsSync(errorPath)) {
      unlinkSync(errorPath);
    }
  } catch {
    // Ignore errors - file may have been removed already
  }
}

/**
 * Generate retry guidance message for tool errors.
 * After 5+ retries, suggests alternative approaches.
 */
function getToolErrorRetryGuidance(toolError) {
  if (!toolError) return "";

  const retryCount = toolError.retry_count || 1;
  const toolName = toolError.tool_name || "unknown";
  const error = toolError.error || "Unknown error";

  if (retryCount >= 5) {
    return `[TOOL ERROR - ALTERNATIVE APPROACH NEEDED]
The "${toolName}" operation has failed ${retryCount} times.

STOP RETRYING THE SAME APPROACH. Instead:
1. Try a completely different command or approach
2. Check if the environment/dependencies are correct
3. Consider breaking down the task differently
4. If stuck, ask the user for guidance

`;
  }

  return `[TOOL ERROR - RETRY REQUIRED]
The previous "${toolName}" operation failed.

Error: ${error}

REQUIRED ACTIONS:
1. Analyze why the command failed
2. Fix the issue (wrong path? permission? syntax? missing dependency?)
3. RETRY the operation with corrected parameters
4. Continue with your original task after success

Do NOT skip this step. Do NOT move on without fixing the error.

`;
}

/**
 * Staleness threshold for mode states (2 hours in milliseconds).
 * States older than this are treated as inactive to prevent stale state
 * from causing the stop hook to malfunction in new sessions.
 */
const STALE_STATE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Check if a state is stale based on its timestamps.
 * A state is considered stale if it hasn't been updated recently.
 * We check both `last_checked_at` and `started_at` - using whichever is more recent.
 */
function isStaleState(state) {
  if (!state) return true;

  const lastChecked = state.last_checked_at
    ? new Date(state.last_checked_at).getTime()
    : 0;
  const startedAt = state.started_at ? new Date(state.started_at).getTime() : 0;
  const mostRecent = Math.max(lastChecked, startedAt);

  if (mostRecent === 0) return true; // No valid timestamps

  const age = Date.now() - mostRecent;
  return age > STALE_STATE_THRESHOLD_MS;
}

/**
 * Check if a skill active state is stale based on its per-skill TTL.
 * Unlike mode states (which use the global 2-hour threshold), skill states
 * carry their own stale_ttl_ms value set when the skill was activated.
 */
function isStaleSkillState(state) {
  if (!state) return true;
  if (!state.active) return true;

  const lastChecked = state.last_checked_at
    ? new Date(state.last_checked_at).getTime()
    : 0;
  const startedAt = state.started_at ? new Date(state.started_at).getTime() : 0;
  const mostRecent = Math.max(lastChecked, startedAt);

  if (mostRecent === 0) return true;

  const ttl = state.stale_ttl_ms || 5 * 60 * 1000; // Default 5 min
  const age = Date.now() - mostRecent;
  return age > ttl;
}

/**
 * Normalize a path for comparison.
 * Uses path.resolve() + path.normalize() for proper handling of:
 * - Trailing slashes
 * - Path separators (\ vs /)
 * - Relative segments (../, ./)
 * - Case sensitivity on Windows
 */
function normalizePath(p) {
  if (!p) return "";
  // resolve() makes the path absolute, normalize() cleans up separators and relative segments
  let normalized = resolve(p);
  normalized = normalize(normalized);
  // Remove any trailing separators using a single regex that handles both / and \
  normalized = normalized.replace(/[\/\\]+$/, "");
  // On Windows, normalize to lowercase for case-insensitive comparison
  if (process.platform === "win32") {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

/**
 * Check if a state belongs to the current project.
 *
 * For local state files: Accept legacy states without project_path for backward compatibility.
 * For global state files: Require project_path to prevent cross-project leakage.
 *
 * @param state - The state object to check
 * @param currentDirectory - The current working directory
 * @param isGlobalState - Whether this state was loaded from global fallback path
 */
function isStateForCurrentProject(
  state,
  currentDirectory,
  isGlobalState = false,
) {
  if (!state) return true;

  // No project_path in state
  if (!state.project_path) {
    // For global state files, require project_path to prevent cross-project leakage
    if (isGlobalState) {
      return false;
    }
    // For local state files, accept legacy states for backward compatibility
    return true;
  }

  // Compare normalized paths
  return normalizePath(state.project_path) === normalizePath(currentDirectory);
}

/**
 * Read state file from local or global location, tracking the source.
 * Returns { state, path, isGlobal } to track where the state was loaded from.
 */
function readStateFile(stateDir, globalStateDir, filename) {
  const localPath = join(stateDir, filename);
  const globalPath = join(globalStateDir, filename);

  let state = readJsonFile(localPath);
  if (state) return { state, path: localPath, isGlobal: false };

  state = readJsonFile(globalPath);
  if (state) return { state, path: globalPath, isGlobal: true };

  return { state: null, path: localPath, isGlobal: false }; // Default to local for new writes
}

const SESSION_ID_ALLOWLIST = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;

function sanitizeSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== "string") return "";
  return SESSION_ID_ALLOWLIST.test(sessionId) ? sessionId : "";
}

function isValidSessionId(sessionId) {
  return typeof sessionId === "string" && SESSION_ID_ALLOWLIST.test(sessionId);
}

/**
 * Read state file with session-scoped path support.
 * If sessionId is provided, ONLY reads the session-scoped path.
 * Falls back to legacy local/global paths when sessionId is not provided.
 */

function readStateFileWithSession(stateDir, globalStateDir, filename, sessionId) {
  const safeSessionId = sanitizeSessionId(sessionId);
  if (safeSessionId) {
    const sessionsDir = join(stateDir, "sessions", safeSessionId);
    const sessionPath = join(sessionsDir, filename);
    const state = readJsonFile(sessionPath);
    return { state, path: sessionPath, isGlobal: false };
  }

  return readStateFile(stateDir, globalStateDir, filename);
}

/**
 * Count incomplete Tasks from Claude Code's native Task system.
 */
function countIncompleteTasks(sessionId) {
  if (!sessionId || typeof sessionId !== "string") return 0;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) return 0;

  const taskDir = join(homedir(), ".claude", "tasks", sessionId);
  if (!existsSync(taskDir)) return 0;

  let count = 0;
  try {
    const files = readdirSync(taskDir).filter(
      (f) => f.endsWith(".json") && f !== ".lock",
    );
    for (const file of files) {
      try {
        const content = readFileSync(join(taskDir, file), "utf-8");
        const task = JSON.parse(content);
        if (task.status === "pending" || task.status === "in_progress") count++;
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }
  return count;
}

function countIncompleteTodos(sessionId, projectDir) {
  let count = 0;

  // Session-specific todos only (no global scan)
  if (
    sessionId &&
    typeof sessionId === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)
  ) {
    const sessionTodoPath = join(
      homedir(),
      ".claude",
      "todos",
      `${sessionId}.json`,
    );
    try {
      const data = readJsonFile(sessionTodoPath);
      const todos = Array.isArray(data)
        ? data
        : Array.isArray(data?.todos)
          ? data.todos
          : [];
      count += todos.filter(
        (t) => t.status !== "completed" && t.status !== "cancelled",
      ).length;
    } catch {
      /* skip */
    }
  }

  // Project-local todos only
  for (const path of [
    join(projectDir, ".omc", "todos.json"),
    join(projectDir, ".claude", "todos.json"),
  ]) {
    try {
      const data = readJsonFile(path);
      const todos = Array.isArray(data)
        ? data
        : Array.isArray(data?.todos)
          ? data.todos
          : [];
      count += todos.filter(
        (t) => t.status !== "completed" && t.status !== "cancelled",
      ).length;
    } catch {
      /* skip */
    }
  }

  return count;
}

/**
 * Detect if stop was triggered by context-limit related reasons.
 * When context is exhausted, Claude Code needs to stop so it can compact.
 * Blocking these stops causes a deadlock: can't compact because can't stop,
 * can't continue because context is full.
 *
 * See: https://github.com/Yeachan-Heo/oh-my-claudecode/issues/213
 */
function isContextLimitStop(data) {
  const reason = (data.stop_reason || data.stopReason || "").toLowerCase();

  const contextPatterns = [
    "context_limit",
    "context_window",
    "context_exceeded",
    "context_full",
    "max_context",
    "token_limit",
    "max_tokens",
    "conversation_too_long",
    "input_too_long",
  ];

  if (contextPatterns.some((p) => reason.includes(p))) {
    return true;
  }

  const endTurnReason = (
    data.end_turn_reason ||
    data.endTurnReason ||
    ""
  ).toLowerCase();
  if (endTurnReason && contextPatterns.some((p) => endTurnReason.includes(p))) {
    return true;
  }

  return false;
}

/**
 * Detect if stop was triggered by user abort (Ctrl+C, cancel button, etc.)
 */
function isUserAbort(data) {
  if (data.user_requested || data.userRequested) return true;

  const reason = (data.stop_reason || data.stopReason || "").toLowerCase();
  // Exact-match patterns: short generic words that cause false positives with .includes()
  const exactPatterns = ["aborted", "abort", "cancel", "interrupt"];
  // Substring patterns: compound words safe for .includes() matching
  const substringPatterns = [
    "user_cancel",
    "user_interrupt",
    "ctrl_c",
    "manual_stop",
  ];

  return (
    exactPatterns.some((p) => reason === p) ||
    substringPatterns.some((p) => reason.includes(p))
  );
}

async function main() {
  try {
    const input = await readStdin();
    let data = {};
    try {
      data = JSON.parse(input);
    } catch {
      // Invalid JSON - allow stop to prevent hanging
      process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }) + "\n");
      return;
    }

    const directory = data.cwd || data.directory || process.cwd();
    const sessionIdRaw = data.sessionId || data.session_id || data.sessionid || "";
    const sessionId = sanitizeSessionId(sessionIdRaw);
    const hasValidSessionId = isValidSessionId(sessionIdRaw);
    const stateDir = join(directory, ".omc", "state");
    const globalStateDir = join(homedir(), ".omc", "state");

    // CRITICAL: Never block context-limit stops.
    // Blocking these causes a deadlock where Claude Code cannot compact.
    // See: https://github.com/Yeachan-Heo/oh-my-claudecode/issues/213
    if (isContextLimitStop(data)) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    // Respect user abort (Ctrl+C, cancel)
    if (isUserAbort(data)) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    // Read all mode states (session-scoped when sessionId provided)
    const ralph = readStateFileWithSession(
      stateDir,
      globalStateDir,
      "ralph-state.json",
      sessionId,
    );
    const autopilot = readStateFileWithSession(
      stateDir,
      globalStateDir,
      "autopilot-state.json",
      sessionId,
    );
    const ultrapilot = readStateFileWithSession(
      stateDir,
      globalStateDir,
      "ultrapilot-state.json",
      sessionId,
    );
    const ultrawork = readStateFileWithSession(
      stateDir,
      globalStateDir,
      "ultrawork-state.json",
      sessionId,
    );
    const ultraqa = readStateFileWithSession(
      stateDir,
      globalStateDir,
      "ultraqa-state.json",
      sessionId,
    );
    const pipeline = readStateFileWithSession(
      stateDir,
      globalStateDir,
      "pipeline-state.json",
      sessionId,
    );
    const team = readStateFileWithSession(
      stateDir,
      globalStateDir,
      "team-state.json",
      sessionId,
    );

    // Swarm uses swarm-summary.json (not swarm-state.json) + marker file
    // Note: Swarm only reads from local stateDir, never global fallback
    const swarmMarker = existsSync(join(stateDir, "swarm-active.marker"));
    const swarmSummary = readJsonFile(join(stateDir, "swarm-summary.json"));

    // Count incomplete items (session-specific + project-local only)
    const taskCount = countIncompleteTasks(sessionId);
    const todoCount = countIncompleteTodos(sessionId, directory);
    const totalIncomplete = taskCount + todoCount;

    // Priority 1: Ralph Loop (explicit persistence mode)
    // Skip if state is stale (older than 2 hours) - prevents blocking new sessions
    if (
      ralph.state?.active &&
      !isStaleState(ralph.state) &&
      isStateForCurrentProject(ralph.state, directory, ralph.isGlobal)
    ) {
      const sessionMatches = hasValidSessionId
        ? ralph.state.session_id === sessionId
        : !ralph.state.session_id || ralph.state.session_id === sessionId;
      if (sessionMatches) {
        const iteration = ralph.state.iteration || 1;
        const maxIter = ralph.state.max_iterations || 100;

        if (iteration < maxIter) {
          const toolError = readLastToolError(stateDir);
          const errorGuidance = getToolErrorRetryGuidance(toolError);

          ralph.state.iteration = iteration + 1;
          ralph.state.last_checked_at = new Date().toISOString();
          writeJsonFile(ralph.path, ralph.state);

          let reason = `[RALPH LOOP - ITERATION ${iteration + 1}/${maxIter}] Work is NOT done. Continue working.\nWhen FULLY complete (after Architect verification), run /oh-my-claudecode:cancel to cleanly exit ralph mode and clean up all state files. If cancel fails, retry with /oh-my-claudecode:cancel --force.\n${ralph.state.prompt ? `Task: ${ralph.state.prompt}` : ""}`;
          if (errorGuidance) {
            reason = errorGuidance + reason;
          }

          console.log(
            JSON.stringify({
              decision: "block",
              reason,
            }),
          );
          return;
        }

        // Do not silently stop Ralph once it hits max iterations; extend and keep going.
        // This prevents abrupt stops in long-running loops where the model hasn't finished.
        ralph.state.max_iterations = maxIter + 10;
        ralph.state.last_checked_at = new Date().toISOString();
        writeJsonFile(ralph.path, ralph.state);

        console.log(
          JSON.stringify({
            decision: "block",
            reason: `[RALPH LOOP - EXTENDED] Max iterations reached; extending to ${ralph.state.max_iterations} and continuing. When FULLY complete (after Architect verification), run /oh-my-claudecode:cancel (or --force).`,
          }),
        );
        return;
      }
    }

    // Priority 2: Autopilot (high-level orchestration)
    if (
      autopilot.state?.active &&
      !isStaleState(autopilot.state) &&
      isStateForCurrentProject(autopilot.state, directory, autopilot.isGlobal)
    ) {
      const sessionMatches = hasValidSessionId
        ? autopilot.state.session_id === sessionId
        : !autopilot.state.session_id || autopilot.state.session_id === sessionId;
      if (sessionMatches) {
        const phase = autopilot.state.phase || "unspecified";
        if (phase !== "complete") {
          const newCount = (autopilot.state.reinforcement_count || 0) + 1;
          if (newCount <= 20) {
            const toolError = readLastToolError(stateDir);
            const errorGuidance = getToolErrorRetryGuidance(toolError);

            autopilot.state.reinforcement_count = newCount;
            autopilot.state.last_checked_at = new Date().toISOString();
            writeJsonFile(autopilot.path, autopilot.state);

            let reason = `[AUTOPILOT - Phase: ${phase}] Autopilot not complete. Continue working. When all phases are complete, run /oh-my-claudecode:cancel to cleanly exit and clean up state files. If cancel fails, retry with /oh-my-claudecode:cancel --force.`;
            if (errorGuidance) {
              reason = errorGuidance + reason;
            }

            console.log(
              JSON.stringify({
                decision: "block",
                reason,
              }),
            );
            return;
          }
        }
      }
    }

    // Priority 3: Ultrapilot (parallel autopilot)
    if (
      ultrapilot.state?.active &&
      !isStaleState(ultrapilot.state) &&
      (hasValidSessionId
        ? ultrapilot.state.session_id === sessionId
        : !ultrapilot.state.session_id || ultrapilot.state.session_id === sessionId) &&
      isStateForCurrentProject(ultrapilot.state, directory, ultrapilot.isGlobal)
    ) {
      const workers = ultrapilot.state.workers || [];
      const incomplete = workers.filter(
        (w) => w.status !== "complete" && w.status !== "failed",
      ).length;
      if (incomplete > 0) {
        const newCount = (ultrapilot.state.reinforcement_count || 0) + 1;
        if (newCount <= 20) {
          const toolError = readLastToolError(stateDir);
          const errorGuidance = getToolErrorRetryGuidance(toolError);

          ultrapilot.state.reinforcement_count = newCount;
          ultrapilot.state.last_checked_at = new Date().toISOString();
          writeJsonFile(ultrapilot.path, ultrapilot.state);

          let reason = `[ULTRAPILOT] ${incomplete} workers still running. Continue working. When all workers complete, run /oh-my-claudecode:cancel to cleanly exit and clean up state files. If cancel fails, retry with /oh-my-claudecode:cancel --force.`;
          if (errorGuidance) {
            reason = errorGuidance + reason;
          }

          console.log(
            JSON.stringify({
              decision: "block",
              reason,
            }),
          );
          return;
        }
      }
    }

    // Priority 4: Swarm (coordinated agents with SQLite)
    // Note: Swarm only reads from local stateDir, never global fallback
    if (
      swarmMarker &&
      swarmSummary?.active &&
      !isStaleState(swarmSummary) &&
      isStateForCurrentProject(swarmSummary, directory, false)
    ) {
      const pending =
        (swarmSummary.tasks_pending || 0) + (swarmSummary.tasks_claimed || 0);
      if (pending > 0) {
        const newCount = (swarmSummary.reinforcement_count || 0) + 1;
        if (newCount <= 15) {
          const toolError = readLastToolError(stateDir);
          const errorGuidance = getToolErrorRetryGuidance(toolError);

          swarmSummary.reinforcement_count = newCount;
          swarmSummary.last_checked_at = new Date().toISOString();
          writeJsonFile(join(stateDir, "swarm-summary.json"), swarmSummary);

          let reason = `[SWARM ACTIVE] ${pending} tasks remain. Continue working. When all tasks are done, run /oh-my-claudecode:cancel to cleanly exit and clean up state files. If cancel fails, retry with /oh-my-claudecode:cancel --force.`;
          if (errorGuidance) {
            reason = errorGuidance + reason;
          }

          console.log(
            JSON.stringify({
              decision: "block",
              reason,
            }),
          );
          return;
        }
      }
    }

    // Priority 5: Pipeline (sequential stages)
    if (
      pipeline.state?.active &&
      !isStaleState(pipeline.state) &&
      (hasValidSessionId
        ? pipeline.state.session_id === sessionId
        : !pipeline.state.session_id || pipeline.state.session_id === sessionId) &&
      isStateForCurrentProject(pipeline.state, directory, pipeline.isGlobal)
    ) {
      const currentStage = pipeline.state.current_stage || 0;
      const totalStages = pipeline.state.stages?.length || 0;
      if (currentStage < totalStages) {
        const newCount = (pipeline.state.reinforcement_count || 0) + 1;
        if (newCount <= 15) {
          const toolError = readLastToolError(stateDir);
          const errorGuidance = getToolErrorRetryGuidance(toolError);

          pipeline.state.reinforcement_count = newCount;
          pipeline.state.last_checked_at = new Date().toISOString();
          writeJsonFile(pipeline.path, pipeline.state);

          let reason = `[PIPELINE - Stage ${currentStage + 1}/${totalStages}] Pipeline not complete. Continue working. When all stages complete, run /oh-my-claudecode:cancel to cleanly exit and clean up state files. If cancel fails, retry with /oh-my-claudecode:cancel --force.`;
          if (errorGuidance) {
            reason = errorGuidance + reason;
          }

          console.log(
            JSON.stringify({
              decision: "block",
              reason,
            }),
          );
          return;
        }
      }
    }

    // Priority 6: Team (omc-teams / staged pipeline)
    if (
      team.state?.active &&
      !isStaleState(team.state) &&
      isStateForCurrentProject(team.state, directory, team.isGlobal)
    ) {
      const sessionMatches = hasValidSessionId
        ? team.state.session_id === sessionId
        : !team.state.session_id || team.state.session_id === sessionId;
      if (sessionMatches) {
        const phase = team.state.current_phase || "executing";
        const terminalPhases = ["completed", "complete", "failed", "cancelled"];
        if (!terminalPhases.includes(phase)) {
          const newCount = (team.state.reinforcement_count || 0) + 1;
          if (newCount <= 20) {
            const toolError = readLastToolError(stateDir);
            const errorGuidance = getToolErrorRetryGuidance(toolError);

            team.state.reinforcement_count = newCount;
            team.state.last_checked_at = new Date().toISOString();
            writeJsonFile(team.path, team.state);

            let reason = `[TEAM - Phase: ${phase}] Team mode active. Continue working. When all team tasks complete, run /oh-my-claudecode:cancel to cleanly exit. If cancel fails, retry with /oh-my-claudecode:cancel --force.`;
            if (errorGuidance) {
              reason = errorGuidance + reason;
            }

            console.log(
              JSON.stringify({
                decision: "block",
                reason,
              }),
            );
            return;
          }
        }
      }
    }

    // Priority 7: UltraQA (QA cycling)
    if (
      ultraqa.state?.active &&
      !isStaleState(ultraqa.state) &&
      (hasValidSessionId
        ? ultraqa.state.session_id === sessionId
        : !ultraqa.state.session_id || ultraqa.state.session_id === sessionId) &&
      isStateForCurrentProject(ultraqa.state, directory, ultraqa.isGlobal)
    ) {
      const cycle = ultraqa.state.cycle || 1;
      const maxCycles = ultraqa.state.max_cycles || 10;
      if (cycle < maxCycles && !ultraqa.state.all_passing) {
        const toolError = readLastToolError(stateDir);
        const errorGuidance = getToolErrorRetryGuidance(toolError);

        ultraqa.state.cycle = cycle + 1;
        ultraqa.state.last_checked_at = new Date().toISOString();
        writeJsonFile(ultraqa.path, ultraqa.state);

        let reason = `[ULTRAQA - Cycle ${cycle + 1}/${maxCycles}] Tests not all passing. Continue fixing. When all tests pass, run /oh-my-claudecode:cancel to cleanly exit and clean up state files. If cancel fails, retry with /oh-my-claudecode:cancel --force.`;
        if (errorGuidance) {
          reason = errorGuidance + reason;
        }

        console.log(
          JSON.stringify({
            decision: "block",
            reason,
          }),
        );
        return;
      }
    }

    // Priority 8: Ultrawork - ALWAYS continue while active (not just when tasks exist)
    // This prevents false stops from bash errors, transient failures, etc.
    // Session isolation: only block if state belongs to this session (issue #311)
    // If state has session_id, it must match. If no session_id (legacy), allow.
    if (
      ultrawork.state?.active &&
      !isStaleState(ultrawork.state) &&
      (hasValidSessionId
        ? ultrawork.state.session_id === sessionId
        : !ultrawork.state.session_id || ultrawork.state.session_id === sessionId) &&
      isStateForCurrentProject(ultrawork.state, directory, ultrawork.isGlobal)
    ) {
      const newCount = (ultrawork.state.reinforcement_count || 0) + 1;
      const maxReinforcements = ultrawork.state.max_reinforcements || 50;

      if (newCount > maxReinforcements) {
        // Max reinforcements reached - allow stop
        console.log(JSON.stringify({ continue: true, suppressOutput: true }));
        return;
      }

      const toolError = readLastToolError(stateDir);
      const errorGuidance = getToolErrorRetryGuidance(toolError);

      ultrawork.state.reinforcement_count = newCount;
      ultrawork.state.last_checked_at = new Date().toISOString();
      writeJsonFile(ultrawork.path, ultrawork.state);

      let reason = `[ULTRAWORK #${newCount}/${maxReinforcements}] Mode active.`;

      if (totalIncomplete > 0) {
        const itemType = taskCount > 0 ? "Tasks" : "todos";
        reason += ` ${totalIncomplete} incomplete ${itemType} remain. Continue working.`;
      } else if (newCount >= 3) {
        // Only suggest cancel after minimum iterations (guard against no-tasks-created scenario)
        reason += ` If all work is complete, run /oh-my-claudecode:cancel to cleanly exit ultrawork mode and clean up state files. If cancel fails, retry with /oh-my-claudecode:cancel --force. Otherwise, continue working.`;
      } else {
        // Early iterations with no tasks yet - just tell LLM to continue
        reason += ` Continue working - create Tasks to track your progress.`;
      }

      if (ultrawork.state.original_prompt) {
        reason += `\nTask: ${ultrawork.state.original_prompt}`;
      }

      if (errorGuidance) {
        reason = errorGuidance + reason;
      }

      console.log(JSON.stringify({ decision: "block", reason }));
      return;
    }

    // Priority 9: Skill Active State (issue #1033)
    // Skills like code-review, plan, tdd, etc. write skill-active-state.json
    // when invoked via the Skill tool. This prevents premature stops mid-skill.
    const skillState = readStateFileWithSession(
      stateDir,
      globalStateDir,
      "skill-active-state.json",
      sessionId,
    );
    if (
      skillState.state?.active &&
      !isStaleSkillState(skillState.state)
    ) {
      const sessionMatches = hasValidSessionId
        ? skillState.state.session_id === sessionId
        : !skillState.state.session_id || skillState.state.session_id === sessionId;
      if (sessionMatches) {
        const count = skillState.state.reinforcement_count || 0;
        const maxReinforcements = skillState.state.max_reinforcements || 3;

        if (count < maxReinforcements) {
          const toolError = readLastToolError(stateDir);
          const errorGuidance = getToolErrorRetryGuidance(toolError);

          skillState.state.reinforcement_count = count + 1;
          skillState.state.last_checked_at = new Date().toISOString();
          writeJsonFile(skillState.path, skillState.state);

          const skillName = skillState.state.skill_name || "unknown";
          let reason = `[SKILL ACTIVE: ${skillName}] The "${skillName}" skill is still executing (reinforcement ${count + 1}/${maxReinforcements}). Continue working on the skill's instructions. Do not stop until the skill completes its workflow.`;
          if (errorGuidance) {
            reason = errorGuidance + reason;
          }

          console.log(JSON.stringify({ decision: "block", reason }));
          return;
        } else {
          // Reinforcement limit reached - clear state and allow stop
          try {
            if (existsSync(skillState.path)) {
              unlinkSync(skillState.path);
            }
          } catch {
            // Ignore cleanup errors
          }
        }
      }
    }

    // No blocking needed
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  } catch (error) {
    // On any error, allow stop rather than blocking forever
    // CRITICAL: Use process.stdout.write instead of console.log to avoid
    // cascading errors if stdout/stderr are broken (issue #319)
    // Wrap in try-catch to handle EPIPE and other stream errors gracefully
    try {
      process.stderr.write(
        `[persistent-mode] Error: ${error?.message || error}\n`,
      );
    } catch {
      // Ignore stderr errors - we just need to return valid JSON
    }
    try {
      process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }) + "\n");
    } catch {
      // If stdout write fails, the hook will timeout and Claude Code will proceed
      // This is better than hanging forever
      process.exit(0);
    }
  }
}

// Global error handlers to prevent hook from hanging on uncaught errors (issue #319)
process.on("uncaughtException", (error) => {
  try {
    process.stderr.write(
      `[persistent-mode] Uncaught exception: ${error?.message || error}\n`,
    );
  } catch {
    // Ignore
  }
  try {
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }) + "\n");
  } catch {
    // If we can't write, just exit
  }
  process.exit(0);
});

process.on("unhandledRejection", (error) => {
  try {
    process.stderr.write(
      `[persistent-mode] Unhandled rejection: ${error?.message || error}\n`,
    );
  } catch {
    // Ignore
  }
  try {
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }) + "\n");
  } catch {
    // If we can't write, just exit
  }
  process.exit(0);
});

// Safety timeout: if hook doesn't complete in 10 seconds, force exit
// This prevents infinite hangs from any unforeseen issues
const safetyTimeout = setTimeout(() => {
  try {
    process.stderr.write(
      "[persistent-mode] Safety timeout reached, forcing exit\n",
    );
  } catch {
    // Ignore
  }
  try {
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }) + "\n");
  } catch {
    // If we can't write, just exit
  }
  process.exit(0);
}, 10000);

main().finally(() => {
  clearTimeout(safetyTimeout);
});
