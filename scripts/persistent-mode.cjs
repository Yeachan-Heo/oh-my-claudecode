#!/usr/bin/env node

/**
 * OMC Persistent Mode Hook (Node.js)
 * Minimal continuation enforcer for all OMC modes.
 * Stripped down for reliability — no optional imports, no PRD, no notepad pruning.
 *
 * Supported modes: ralph, autopilot, ultrapilot, swarm, ultrawork, ultraqa, pipeline, team
 */

const {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
} = require("fs");
const { join, dirname, resolve, normalize } = require("path");
const { homedir } = require("os");

async function readStdin(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; process.stdin.removeAllListeners(); process.stdin.destroy(); resolve(Buffer.concat(chunks).toString("utf-8")); }
    }, timeoutMs);
    process.stdin.on("data", (chunk) => { chunks.push(chunk); });
    process.stdin.on("end", () => { if (!settled) { settled = true; clearTimeout(timeout); resolve(Buffer.concat(chunks).toString("utf-8")); } });
    process.stdin.on("error", () => { if (!settled) { settled = true; clearTimeout(timeout); resolve(""); } });
    if (process.stdin.readableEnded) { if (!settled) { settled = true; clearTimeout(timeout); resolve(Buffer.concat(chunks).toString("utf-8")); } }
  });
}

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
 * Read the session-idle notification cooldown in seconds from ~/.omc/config.json.
 * Default: 60. 0 = disabled.
 */
function getIdleCooldownSeconds() {
  const configPath = join(homedir(), '.omc', 'config.json');
  const config = readJsonFile(configPath);
  const val = config?.notificationCooldown?.sessionIdleSeconds;
  if (typeof val === 'number') return val;
  return 60;
}

/**
 * Check whether the session-idle cooldown has elapsed.
 * Returns true if the notification should be sent.
 */
function shouldSendIdleNotification(stateDir) {
  const cooldownSecs = getIdleCooldownSeconds();
  if (cooldownSecs === 0) return true; // cooldown disabled

  const cooldownPath = join(stateDir, 'idle-notif-cooldown.json');
  const data = readJsonFile(cooldownPath);
  if (data?.lastSentAt) {
    const elapsed = (Date.now() - new Date(data.lastSentAt).getTime()) / 1000;
    if (Number.isFinite(elapsed) && elapsed < cooldownSecs) return false;
  }
  return true;
}

/**
 * Record that the session-idle notification was sent.
 */
function recordIdleNotificationSent(stateDir) {
  const cooldownPath = join(stateDir, 'idle-notif-cooldown.json');
  writeJsonFile(cooldownPath, { lastSentAt: new Date().toISOString() });
}

/**
 * Send stop notification (fire-and-forget, non-blocking).
 * Only notifies on first stop to avoid spam.
 */
async function sendStopNotification(modeName, stateData, sessionId, directory) {
  // Only notify once per mode activation
  if (stateData._stopNotified) return;

  try {
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    if (!pluginRoot) return;

    const { pathToFileURL } = require('url');
    const { notify } = await import(pathToFileURL(join(pluginRoot, 'dist', 'notifications', 'index.js')).href);

    await notify('session-stop', {
      sessionId: sessionId,
      projectPath: directory,
      activeMode: modeName,
      iteration: stateData.iteration || stateData.reinforcement_count || 1,
      maxIterations: stateData.max_iterations || stateData.max_reinforcements || 100,
      incompleteTasks: undefined, // Caller can override
    }).catch(() => {});

    // Mark as notified to prevent duplicate notifications
    stateData._stopNotified = true;
  } catch {
    // Notification module not available, skip silently
  }
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
 * Normalize a path for comparison.
 */
function normalizePath(p) {
  if (!p) return "";
  let normalized = resolve(p);
  normalized = normalize(normalized);
  normalized = normalized.replace(/[\/\\]+$/, "");
  if (process.platform === "win32") {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

/**
 * Check if a state belongs to the requesting session.
 * When sessionId is known: require exact match with state.session_id.
 * When sessionId is empty/unknown: only match state without session_id (legacy compat).
 */
function isSessionMatch(state, sessionId) {
  if (!state) return false;
  if (sessionId) {
    // Session is known: require exact match
    return state.session_id === sessionId;
  }
  // No session_id from hook: only match legacy state (no session_id in state)
  return !state.session_id;
}

/**
 * Check if a state belongs to the current project.
 */
function isStateForCurrentProject(
  state,
  currentDirectory,
  isGlobalState = false,
) {
  if (!state) return true;

  if (!state.project_path) {
    if (isGlobalState) {
      return false;
    }
    return true;
  }

  return normalizePath(state.project_path) === normalizePath(currentDirectory);
}

/**
 * Read state file from local location only.
 */
function readStateFile(stateDir, filename) {
  const localPath = join(stateDir, filename);
  const state = readJsonFile(localPath);
  return { state, path: localPath, isGlobal: false };
}

/**
 * Read state file with session-scoped path support and fallback to legacy path.
 */
function readStateFileWithSession(stateDir, filename, sessionId) {
  // Try session-scoped path first (and ONLY) when sessionId is available
  if (sessionId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) {
    const sessionsDir = join(stateDir, 'sessions', sessionId);
    const sessionPath = join(sessionsDir, filename);
    const state = readJsonFile(sessionPath);
    if (state) {
      return { state, path: sessionPath, isGlobal: false };
    }
    // Session path not found — do NOT fall back to legacy
    return { state: null, path: null, isGlobal: false };
  }
  // No sessionId: fall back to legacy path (backward compat)
  return readStateFile(stateDir, filename);
}

/**
 * Count incomplete Tasks from Claude Code's native Task system.
 */
function countIncompleteTasks(sessionId) {
  if (!sessionId || typeof sessionId !== "string") return 0;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) return 0;

  const cfgDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const taskDir = join(cfgDir, "tasks", sessionId);
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
    } catch {}

    const directory = data.cwd || data.directory || process.cwd();
    const sessionId = data.session_id || data.sessionId || "";
    const stateDir = join(directory, ".omc", "state");

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

    // Read all mode states (session-scoped with legacy fallback)
    const ralph = readStateFileWithSession(stateDir, "ralph-state.json", sessionId);
    const autopilot = readStateFileWithSession(stateDir, "autopilot-state.json", sessionId);
    const ultrapilot = readStateFileWithSession(stateDir, "ultrapilot-state.json", sessionId);
    const ultrawork = readStateFileWithSession(stateDir, "ultrawork-state.json", sessionId);
    const ultraqa = readStateFileWithSession(stateDir, "ultraqa-state.json", sessionId);
    const pipeline = readStateFileWithSession(stateDir, "pipeline-state.json", sessionId);
    const team = readStateFileWithSession(stateDir, "team-state.json", sessionId);

    // Swarm uses swarm-summary.json (not swarm-state.json) + marker file
    const swarmMarker = existsSync(join(stateDir, "swarm-active.marker"));
    const swarmSummary = readJsonFile(join(stateDir, "swarm-summary.json"));

    // Count incomplete items (session-specific + project-local only)
    const taskCount = countIncompleteTasks(sessionId);
    const todoCount = countIncompleteTodos(sessionId, directory);
    const totalIncomplete = taskCount + todoCount;

    // Priority 1: Ralph Loop (explicit persistence mode)
    // Skip if state is stale (older than 2 hours) - prevents blocking new sessions
    if (ralph.state?.active && !isStaleState(ralph.state) && isSessionMatch(ralph.state, sessionId)) {
      const iteration = ralph.state.iteration || 1;
      const maxIter = ralph.state.max_iterations || 100;

      if (iteration < maxIter) {
        ralph.state.iteration = iteration + 1;
        ralph.state.last_checked_at = new Date().toISOString();
        writeJsonFile(ralph.path, ralph.state);

        // Fire-and-forget notification
        sendStopNotification('ralph', ralph.state, sessionId, directory).catch(() => {});

        console.log(
          JSON.stringify({
            decision: "block",
            reason: `[RALPH LOOP - ITERATION ${iteration + 1}/${maxIter}] Work is NOT done. Continue working.\nWhen FULLY complete (after Architect verification), run /oh-my-claudecode:cancel to cleanly exit ralph mode and clean up all state files. If cancel fails, retry with /oh-my-claudecode:cancel --force.\n${ralph.state.prompt ? `Task: ${ralph.state.prompt}` : ""}`,
          }),
        );
        return;
      }
    }

    // Priority 2: Autopilot (high-level orchestration)
    if (autopilot.state?.active && !isStaleState(autopilot.state) && isSessionMatch(autopilot.state, sessionId)) {
      const phase = autopilot.state.phase || "unknown";
      if (phase !== "complete") {
        const newCount = (autopilot.state.reinforcement_count || 0) + 1;
        if (newCount <= 20) {
          autopilot.state.reinforcement_count = newCount;
          autopilot.state.last_checked_at = new Date().toISOString();
          writeJsonFile(autopilot.path, autopilot.state);

          // Fire-and-forget notification
          sendStopNotification('autopilot', autopilot.state, sessionId, directory).catch(() => {});

          console.log(
            JSON.stringify({
              decision: "block",
              reason: `[AUTOPILOT - Phase: ${phase}] Autopilot not complete. Continue working. When all phases are complete, run /oh-my-claudecode:cancel to cleanly exit and clean up state files. If cancel fails, retry with /oh-my-claudecode:cancel --force.`,
            }),
          );
          return;
        }
      }
    }

    // Priority 3: Ultrapilot (parallel autopilot)
    if (ultrapilot.state?.active && !isStaleState(ultrapilot.state) && isSessionMatch(ultrapilot.state, sessionId)) {
      const workers = ultrapilot.state.workers || [];
      const incomplete = workers.filter(
        (w) => w.status !== "complete" && w.status !== "failed",
      ).length;
      if (incomplete > 0) {
        const newCount = (ultrapilot.state.reinforcement_count || 0) + 1;
        if (newCount <= 20) {
          ultrapilot.state.reinforcement_count = newCount;
          ultrapilot.state.last_checked_at = new Date().toISOString();
          writeJsonFile(ultrapilot.path, ultrapilot.state);

          // Fire-and-forget notification
          sendStopNotification('ultrapilot', ultrapilot.state, sessionId, directory).catch(() => {});

          console.log(
            JSON.stringify({
              decision: "block",
              reason: `[ULTRAPILOT] ${incomplete} workers still running. Continue working. When all workers complete, run /oh-my-claudecode:cancel to cleanly exit and clean up state files. If cancel fails, retry with /oh-my-claudecode:cancel --force.`,
            }),
          );
          return;
        }
      }
    }

    // Priority 4: Swarm (coordinated agents with SQLite)
    if (swarmMarker && swarmSummary?.active && !isStaleState(swarmSummary)) {
      const pending =
        (swarmSummary.tasks_pending || 0) + (swarmSummary.tasks_claimed || 0);
      if (pending > 0) {
        const newCount = (swarmSummary.reinforcement_count || 0) + 1;
        if (newCount <= 15) {
          swarmSummary.reinforcement_count = newCount;
          swarmSummary.last_checked_at = new Date().toISOString();
          writeJsonFile(join(stateDir, "swarm-summary.json"), swarmSummary);

          // Fire-and-forget notification
          sendStopNotification('swarm', swarmSummary, sessionId, directory).catch(() => {});

          console.log(
            JSON.stringify({
              decision: "block",
              reason: `[SWARM ACTIVE] ${pending} tasks remain. Continue working. When all tasks are done, run /oh-my-claudecode:cancel to cleanly exit and clean up state files. If cancel fails, retry with /oh-my-claudecode:cancel --force.`,
            }),
          );
          return;
        }
      }
    }

    // Priority 5: Pipeline (sequential stages)
    if (pipeline.state?.active && !isStaleState(pipeline.state) && isSessionMatch(pipeline.state, sessionId)) {
      const currentStage = pipeline.state.current_stage || 0;
      const totalStages = pipeline.state.stages?.length || 0;
      if (currentStage < totalStages) {
        const newCount = (pipeline.state.reinforcement_count || 0) + 1;
        if (newCount <= 15) {
          pipeline.state.reinforcement_count = newCount;
          pipeline.state.last_checked_at = new Date().toISOString();
          writeJsonFile(pipeline.path, pipeline.state);

          // Fire-and-forget notification
          sendStopNotification('pipeline', pipeline.state, sessionId, directory).catch(() => {});

          console.log(
            JSON.stringify({
              decision: "block",
              reason: `[PIPELINE - Stage ${currentStage + 1}/${totalStages}] Pipeline not complete. Continue working. When all stages complete, run /oh-my-claudecode:cancel to cleanly exit and clean up state files. If cancel fails, retry with /oh-my-claudecode:cancel --force.`,
            }),
          );
          return;
        }
      }
    }

    // Priority 6: Team (omc-teams / staged pipeline)
    if (team.state?.active && !isStaleState(team.state) && isSessionMatch(team.state, sessionId)) {
      const phase = team.state.current_phase || "executing";
      const terminalPhases = ["completed", "complete", "failed", "cancelled"];
      if (!terminalPhases.includes(phase)) {
        const newCount = (team.state.reinforcement_count || 0) + 1;
        if (newCount <= 20) {
          team.state.reinforcement_count = newCount;
          team.state.last_checked_at = new Date().toISOString();
          writeJsonFile(team.path, team.state);

          // Fire-and-forget notification
          sendStopNotification('team', team.state, sessionId, directory).catch(() => {});

          console.log(
            JSON.stringify({
              decision: "block",
              reason: `[TEAM - Phase: ${phase}] Team mode active. Continue working. When all team tasks complete, run /oh-my-claudecode:cancel to cleanly exit. If cancel fails, retry with /oh-my-claudecode:cancel --force.`,
            }),
          );
          return;
        }
      }
    }

    // Priority 7: UltraQA (QA cycling)
    if (ultraqa.state?.active && !isStaleState(ultraqa.state) && isSessionMatch(ultraqa.state, sessionId)) {
      const cycle = ultraqa.state.cycle || 1;
      const maxCycles = ultraqa.state.max_cycles || 10;
      if (cycle < maxCycles && !ultraqa.state.all_passing) {
        ultraqa.state.cycle = cycle + 1;
        ultraqa.state.last_checked_at = new Date().toISOString();
        writeJsonFile(ultraqa.path, ultraqa.state);

        // Fire-and-forget notification
        sendStopNotification('ultraqa', ultraqa.state, sessionId, directory).catch(() => {});

        console.log(
          JSON.stringify({
            decision: "block",
            reason: `[ULTRAQA - Cycle ${cycle + 1}/${maxCycles}] Tests not all passing. Continue fixing. When all tests pass, run /oh-my-claudecode:cancel to cleanly exit and clean up state files. If cancel fails, retry with /oh-my-claudecode:cancel --force.`,
          }),
        );
        return;
      }
    }

    // Priority 8: Ultrawork - ALWAYS continue while active (not just when tasks exist)
    // This prevents false stops from bash errors, transient failures, etc.
    // Session isolation: only block if state belongs to this session (issue #311)
    // Project isolation: only block if state belongs to this project
    if (
      ultrawork.state?.active &&
      !isStaleState(ultrawork.state) &&
      isSessionMatch(ultrawork.state, sessionId) &&
      isStateForCurrentProject(ultrawork.state, directory, ultrawork.isGlobal)
    ) {
      const newCount = (ultrawork.state.reinforcement_count || 0) + 1;
      const maxReinforcements = ultrawork.state.max_reinforcements || 50;

      if (newCount > maxReinforcements) {
        // Max reinforcements reached - allow stop
        console.log(JSON.stringify({ continue: true, suppressOutput: true }));
        return;
      }

      ultrawork.state.reinforcement_count = newCount;
      ultrawork.state.last_checked_at = new Date().toISOString();
      writeJsonFile(ultrawork.path, ultrawork.state);

      // Fire-and-forget notification
      sendStopNotification('ultrawork', ultrawork.state, sessionId, directory).catch(() => {});

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

      console.log(JSON.stringify({ decision: "block", reason }));
      return;
    }

    // No blocking needed — Claude is truly idle.
    // Send session-idle notification (fire-and-forget) so external integrations
    // (Telegram, Discord) know the session went idle without any active mode.
    // Per-session cooldown prevents notification spam when the session idles repeatedly.
    if (sessionId && shouldSendIdleNotification(stateDir)) {
      try {
        const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
        if (pluginRoot) {
          const { pathToFileURL } = require('url');
          import(pathToFileURL(join(pluginRoot, 'dist', 'notifications', 'index.js')).href)
            .then(({ notify }) =>
              notify('session-idle', {
                sessionId,
                projectPath: directory,
              }).catch(() => {})
            )
            .catch(() => {});
          recordIdleNotificationSent(stateDir);
        }
      } catch {
        // Notification module not available, skip silently
      }
    }
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  } catch (error) {
    // On any error, allow stop rather than blocking forever
    console.error(`[persistent-mode] Error: ${error.message}`);
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

main();
