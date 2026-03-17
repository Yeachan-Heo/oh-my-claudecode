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
  unlinkSync,
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

// Stop breaker constants for first-class mode enforcement
const TEAM_PIPELINE_STOP_BLOCKER_MAX = 20;
const TEAM_PIPELINE_STOP_BLOCKER_TTL_MS = 5 * 60 * 1000; // 5 min
const RALPLAN_STOP_BLOCKER_MAX = 30;
const RALPLAN_STOP_BLOCKER_TTL_MS = 45 * 60 * 1000; // 45 min
const TEAM_TERMINAL_PHASES = new Set([
  "completed",
  "complete",
  "failed",
  "cancelled",
  "canceled",
  "aborted",
  "terminated",
  "done",
]);
const TEAM_ACTIVE_PHASES = new Set([
  "team-plan",
  "team-prd",
  "team-exec",
  "team-verify",
  "team-fix",
  "planning",
  "executing",
  "verify",
  "verification",
  "fix",
  "fixing",
]);

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

function normalizeTeamPhase(state) {
  if (!state || typeof state !== "object") return null;

  const rawPhase = state.current_phase ?? state.phase ?? state.stage;
  if (typeof rawPhase !== "string") return null;

  const phase = rawPhase.trim().toLowerCase();
  if (!phase || TEAM_TERMINAL_PHASES.has(phase)) return null;
  return TEAM_ACTIVE_PHASES.has(phase) ? phase : null;
}

function getSafeReinforcementCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

// ---------------------------------------------------------------------------
// Stop Breaker helpers (shared by team pipeline and ralplan)
// ---------------------------------------------------------------------------

function readStopBreaker(stateDir, name, sessionId, ttlMs) {
  const dir = sessionId
    ? join(stateDir, "sessions", sessionId)
    : stateDir;
  const breakerPath = join(dir, `${name}-stop-breaker.json`);

  try {
    if (!existsSync(breakerPath)) return 0;
    const raw = JSON.parse(readFileSync(breakerPath, "utf-8"));
    if (ttlMs && raw.updated_at) {
      const updatedAt = new Date(raw.updated_at).getTime();
      if (Number.isFinite(updatedAt) && Date.now() - updatedAt > ttlMs) {
        unlinkSync(breakerPath);
        return 0;
      }
    }
    return typeof raw.count === "number" ? raw.count : 0;
  } catch {
    return 0;
  }
}

function writeStopBreaker(stateDir, name, count, sessionId) {
  const dir = sessionId
    ? join(stateDir, "sessions", sessionId)
    : stateDir;

  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const breakerPath = join(dir, `${name}-stop-breaker.json`);
    writeJsonFile(breakerPath, { count, updated_at: new Date().toISOString() });
  } catch {
    // Fail-open
  }
}

/**
 * Check if a cancel signal is in progress for the session.
 * Cancel signals are written by state_clear and expire after 30 seconds.
 * @param {string} stateDir - The .omc/state directory path
 * @param {string} sessionId - Optional session ID
 * @returns {boolean} true if cancel is in progress
 */
function isSessionCancelInProgress(stateDir, sessionId) {
  const CANCEL_SIGNAL_TTL_MS = 30000; // 30 seconds

  // Try session-scoped path first
  if (sessionId) {
    const sessionSignalPath = join(stateDir, 'sessions', sessionId, 'cancel-signal-state.json');
    const signal = readJsonFile(sessionSignalPath);
    if (signal && signal.expires_at) {
      const expiresAt = new Date(signal.expires_at).getTime();
      if (Date.now() < expiresAt) {
        return true;
      }
    }
  }

  // Fall back to legacy path
  const legacySignalPath = join(stateDir, 'cancel-signal-state.json');
  const signal = readJsonFile(legacySignalPath);
  if (signal && signal.expires_at) {
    const expiresAt = new Date(signal.expires_at).getTime();
    if (Date.now() < expiresAt) {
      return true;
    }
  }

  return false;
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
    // Session path not found — fallback: scan ALL session dirs for a state
    // whose session_id matches ours (handles path mismatches)
    try {
      const allSessionsDir = join(stateDir, 'sessions');
      if (existsSync(allSessionsDir)) {
        const dirs = readdirSync(allSessionsDir).filter(d => /^[a-zA-Z0-9]/.test(d));
        for (const dir of dirs) {
          const candidatePath = join(allSessionsDir, dir, filename);
          const candidateState = readJsonFile(candidatePath);
          if (candidateState && candidateState.session_id === sessionId) {
            return { state: candidateState, path: candidatePath, isGlobal: false };
          }
        }
      }
    } catch { /* ignore scan errors */ }
    // Also check legacy path if its session_id matches
    const legacyResult = readStateFile(stateDir, filename);
    if (legacyResult.state && legacyResult.state.session_id === sessionId) {
      return legacyResult;
    }
    return { state: null, path: null, isGlobal: false };
  }
  // No sessionId: fall back to legacy path (backward compat)
  return readStateFile(stateDir, filename);
}

function getActiveSubagentCount(stateDir) {
  try {
    const tracking = readJsonFile(join(stateDir, "subagent-tracking.json"));
    if (!tracking || !Array.isArray(tracking.agents)) {
      return 0;
    }
    return tracking.agents.filter((agent) => agent?.status === "running").length;
  } catch {
    return 0;
  }
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
  const reasons = [
    data.stop_reason,
    data.stopReason,
    data.end_turn_reason,
    data.endTurnReason,
    data.reason,
  ]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.toLowerCase().replace(/[\s-]+/g, "_"));

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

  return reasons.some((reason) => contextPatterns.some((p) => reason.includes(p)));
}

const CRITICAL_CONTEXT_STOP_PERCENT = 95;

function estimateContextPercent(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return 0;

  try {
    const content = readFileSync(transcriptPath, "utf-8");
    const windowMatch = content.match(/"context_window"\s{0,5}:\s{0,5}(\d+)/g);
    const inputMatch = content.match(/"input_tokens"\s{0,5}:\s{0,5}(\d+)/g);
    if (!windowMatch || !inputMatch) return 0;

    const lastWindow = parseInt(windowMatch[windowMatch.length - 1].match(/(\d+)/)[1], 10);
    const lastInput = parseInt(inputMatch[inputMatch.length - 1].match(/(\d+)/)[1], 10);
    if (!Number.isFinite(lastWindow) || lastWindow <= 0 || !Number.isFinite(lastInput)) return 0;
    return Math.round((lastInput / lastWindow) * 100);
  } catch {
    return 0;
  }
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

const AUTHENTICATION_ERROR_PATTERNS = [
  "authentication_error",
  "authentication_failed",
  "auth_error",
  "unauthorized",
  "unauthorised",
  "401",
  "403",
  "forbidden",
  "invalid_token",
  "token_invalid",
  "token_expired",
  "expired_token",
  "oauth_expired",
  "oauth_token_expired",
  "invalid_grant",
  "insufficient_scope",
];

function isAuthenticationError(data) {
  const reason = (data.stop_reason || data.stopReason || "").toLowerCase();
  const endTurnReason = (
    data.end_turn_reason ||
    data.endTurnReason ||
    ""
  ).toLowerCase();

  return AUTHENTICATION_ERROR_PATTERNS.some(
    (pattern) => reason.includes(pattern) || endTurnReason.includes(pattern),
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

    const criticalTranscriptPath = data.transcript_path || data.transcriptPath || "";
    if (estimateContextPercent(criticalTranscriptPath) >= CRITICAL_CONTEXT_STOP_PERCENT) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    // Respect user abort (Ctrl+C, cancel)
    if (isUserAbort(data)) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    // Never block auth failures (401/403/expired OAuth): allow re-auth flow.
    if (isAuthenticationError(data)) {
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
    const ralplan = readStateFileWithSession(stateDir, "ralplan-state.json", sessionId);
    const omcTeams = readStateFileWithSession(stateDir, "omc-teams-state.json", sessionId);

    // Swarm uses swarm-summary.json (not swarm-state.json) + marker file
    const swarmMarker = existsSync(join(stateDir, "swarm-active.marker"));
    const swarmSummary = readJsonFile(join(stateDir, "swarm-summary.json"));

    // Count incomplete items (session-specific + project-local only)
    const taskCount = countIncompleteTasks(sessionId);
    const todoCount = countIncompleteTodos(sessionId, directory);
    const totalIncomplete = taskCount + todoCount;

    // Check if cancel is in progress - if so, allow stop immediately
    // Cache the result to pass to sub-checks (avoids TOCTOU re-reads, issue #1058)
    const cancelInProgress = isSessionCancelInProgress(stateDir, sessionId);
    if (cancelInProgress) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

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

        const ralphReason = `[RALPH LOOP - ITERATION ${iteration + 1}/${maxIter}] Work is NOT done. Continue working.\nWhen FULLY complete (after Architect verification), run /oh-my-claudecode:cancel to cleanly exit ralph mode and clean up all state files. If cancel fails, retry with /oh-my-claudecode:cancel --force.\n${ralph.state.prompt ? `Task: ${ralph.state.prompt}` : ""}`;
        console.log(
          JSON.stringify({
            decision: "block",
            reason: ralphReason,
          }),
        );
        return;
      } else {
        // Do not silently stop Ralph once it hits max iterations; extend and keep going.
        ralph.state.max_iterations = maxIter + 10;
        ralph.state.iteration = maxIter + 1;
        ralph.state.last_checked_at = new Date().toISOString();
        writeJsonFile(ralph.path, ralph.state);
        const extendReason = `[RALPH LOOP - EXTENDED] Max iterations reached; extending to ${ralph.state.max_iterations} and continuing. When FULLY complete (after Architect verification), run /oh-my-claudecode:cancel (or --force).`;
        console.log(JSON.stringify({ decision: "block", reason: extendReason }));
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

          const cancelGuidance = typeof autopilot.state.session_id === "string" && autopilot.state.session_id === sessionId
            ? " When all phases are complete, run /oh-my-claudecode:cancel to cleanly exit and clean up this session's autopilot state files. If cancel fails, retry with /oh-my-claudecode:cancel --force."
            : "";
          console.log(
            JSON.stringify({
              decision: "block",
              reason: `[AUTOPILOT - Phase: ${phase}] Autopilot not complete. Continue working.${cancelGuidance}`,
            }),
          );
          return;
        }
      }
    }

    // Priority 2.5: Team Pipeline (standalone team mode — first-class enforcement)
    // When team runs WITHOUT ralph, this provides stop-hook blocking.
    // When team runs WITH ralph, checkRalphLoop (Priority 1) handles it.
    let teamPipelineHandled = false;
    if (team.state && isSessionMatch(team.state, sessionId)) {
      if (!team.state.active) {
        // Inactive — reset breaker, allow stop, mark as handled
        writeStopBreaker(stateDir, "team-pipeline", 0, sessionId);
        teamPipelineHandled = true;
      } else if (!isStaleState(team.state)) {
        teamPipelineHandled = true;

        // Cancel-in-progress bypass (TOCTOU defense, issue #1058)
        if (!cancelInProgress) {
          // Read phase: canonical field priority matching bridge code
          const rawPhase = team.state.phase
            ?? team.state.current_phase
            ?? team.state.currentStage
            ?? team.state.current_stage
            ?? team.state.stage;

          if (typeof rawPhase !== "string") {
            // No valid phase — fail-open (don't block)
          } else {
            const phase = rawPhase.trim().toLowerCase();

            if (TEAM_TERMINAL_PHASES.has(phase) || phase === "cancel") {
              // Terminal — reset breaker, allow stop
              writeStopBreaker(stateDir, "team-pipeline", 0, sessionId);
            } else if (!TEAM_ACTIVE_PHASES.has(phase)) {
              // Unknown phase — fail-open (don't block)
            } else {
              // Status-level terminal check
              const rawStatus = team.state.status;
              const status = typeof rawStatus === "string" ? rawStatus.trim().toLowerCase() : null;
              if (status && TEAM_TERMINAL_PHASES.has(status)) {
                writeStopBreaker(stateDir, "team-pipeline", 0, sessionId);
              } else if (team.state.cancel?.requested) {
                // Cancel requested — allow stop
                writeStopBreaker(stateDir, "team-pipeline", 0, sessionId);
              } else {
                // Active phase — block with circuit breaker
                const breakerCount = readStopBreaker(stateDir, "team-pipeline", sessionId, TEAM_PIPELINE_STOP_BLOCKER_TTL_MS) + 1;
                if (breakerCount > TEAM_PIPELINE_STOP_BLOCKER_MAX) {
                  writeStopBreaker(stateDir, "team-pipeline", 0, sessionId);
                  // Circuit breaker tripped — allow stop
                } else {
                  writeStopBreaker(stateDir, "team-pipeline", breakerCount, sessionId);
                  sendStopNotification("team", team.state, sessionId, directory).catch(() => {});

                  const teamPipelineReason = `[TEAM PIPELINE - PHASE: ${phase.toUpperCase()} | REINFORCEMENT ${breakerCount}/${TEAM_PIPELINE_STOP_BLOCKER_MAX}] The team pipeline is active in phase "${phase}". Continue working on the team workflow. Do not stop until the pipeline reaches a terminal state (complete/failed/cancelled). When done, run /oh-my-claudecode:cancel to cleanly exit.`;
                  console.log(JSON.stringify({
                    decision: "block",
                    reason: teamPipelineReason,
                  }));
                  return;
                }
              }
            }
          }
        }
      }
    }

    // Priority 2.6: Ralplan (standalone consensus planning — first-class enforcement)
    if (ralplan.state?.active && !isStaleState(ralplan.state) && isSessionMatch(ralplan.state, sessionId)) {
      // Terminal phase detection
      const currentPhase = ralplan.state.current_phase;
      let ralplanTerminal = false;
      if (typeof currentPhase === "string") {
        const terminal = ["complete", "completed", "failed", "cancelled", "canceled", "done"];
        if (terminal.includes(currentPhase.toLowerCase())) {
          writeStopBreaker(stateDir, "ralplan", 0, sessionId);
          ralplanTerminal = true;
        }
      }

      if (!ralplanTerminal && !cancelInProgress) {
        // Circuit breaker
        const breakerCount = readStopBreaker(stateDir, "ralplan", sessionId, RALPLAN_STOP_BLOCKER_TTL_MS) + 1;
        if (breakerCount > RALPLAN_STOP_BLOCKER_MAX) {
          writeStopBreaker(stateDir, "ralplan", 0, sessionId);
          // Circuit breaker tripped — allow stop
        } else {
          writeStopBreaker(stateDir, "ralplan", breakerCount, sessionId);

          sendStopNotification("ralplan", ralplan.state, sessionId, directory).catch(() => {});

          const ralplanReason = `[RALPLAN - CONSENSUS PLANNING | REINFORCEMENT ${breakerCount}/${RALPLAN_STOP_BLOCKER_MAX}] The ralplan consensus workflow is active. Continue the Planner/Architect/Critic loop. Do not stop until consensus is reached or the workflow completes. When done, run /oh-my-claudecode:cancel to cleanly exit.`;
          console.log(JSON.stringify({
            decision: "block",
            reason: ralplanReason,
          }));
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

    // Priority 6: Team (native Claude Code teams) — fallback for cases not handled by Priority 2.5
    if (!teamPipelineHandled && team.state?.active && !isStaleState(team.state) && isSessionMatch(team.state, sessionId)) {
      const phase = normalizeTeamPhase(team.state);
      if (phase) {
        const newCount = getSafeReinforcementCount(team.state.reinforcement_count) + 1;
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

    // Priority 6.5: OMC Teams (tmux CLI workers — independent of native team state)
    if (omcTeams.state?.active && !isStaleState(omcTeams.state) && isSessionMatch(omcTeams.state, sessionId)) {
      const phase = normalizeTeamPhase(omcTeams.state);
      if (phase) {
        const newCount = getSafeReinforcementCount(omcTeams.state.reinforcement_count) + 1;
        if (newCount <= 20) {
          omcTeams.state.reinforcement_count = newCount;
          omcTeams.state.last_checked_at = new Date().toISOString();
          writeJsonFile(omcTeams.path, omcTeams.state);

          // Fire-and-forget notification
          sendStopNotification('omc-teams', omcTeams.state, sessionId, directory).catch(() => {});

          console.log(
            JSON.stringify({
              decision: "block",
              reason: `[OMC TEAMS - Phase: ${phase}] OMC Teams workers active. Continue working. When all workers complete, run /oh-my-claudecode:cancel to cleanly exit. If cancel fails, retry with /oh-my-claudecode:cancel --force.`,
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
        // Max reinforcements reached - deactivate state before allowing stop
        // Without this, state stays active: true and HUD keeps showing ultrawork
        try {
          ultrawork.state.active = false;
          ultrawork.state.deactivated_reason = 'max_reinforcements_reached';
          ultrawork.state.last_checked_at = new Date().toISOString();
          writeJsonFile(ultrawork.path, ultrawork.state);
        } catch { /* best-effort cleanup */ }
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
      } else if (newCount >= 5) {
        // Strong directive: LLM must call cancel NOW
        reason += ` No incomplete tasks detected. You MUST invoke /oh-my-claudecode:cancel immediately to exit ultrawork mode and clean up state files. Call state_clear(mode="ultrawork") if the cancel skill is unavailable.`;
      } else if (newCount >= 3) {
        // Suggest cancel after minimum iterations
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

    // Priority 9: Skill Active State (issue #1033)
    // Skills like code-review, plan, ralplan, tdd, etc. write skill-active-state.json
    // when invoked via the Skill tool. This prevents premature stops mid-skill.
    {
      const skillState = readStateFileWithSession(stateDir, "skill-active-state.json", sessionId);
      if (skillState.state?.active) {
        // Staleness check (per-skill TTL)
        const sLastChecked = skillState.state.last_checked_at ? new Date(skillState.state.last_checked_at).getTime() : 0;
        const sStartedAt = skillState.state.started_at ? new Date(skillState.state.started_at).getTime() : 0;
        const sMostRecent = Math.max(sLastChecked, sStartedAt);
        const sTtl = skillState.state.stale_ttl_ms || 5 * 60 * 1000;
        const sAge = sMostRecent > 0 ? Date.now() - sMostRecent : Infinity;
        const isStale = sMostRecent === 0 || sAge > sTtl;

        if (!isStale && isSessionMatch(skillState.state, sessionId)) {
          const count = skillState.state.reinforcement_count || 0;
          const maxReinforcements = skillState.state.max_reinforcements || 3;

          if (count < maxReinforcements) {
            if (getActiveSubagentCount(stateDir) > 0) {
              console.log(JSON.stringify({ continue: true, suppressOutput: true }));
              return;
            }

            skillState.state.reinforcement_count = count + 1;
            skillState.state.last_checked_at = new Date().toISOString();
            writeJsonFile(skillState.path, skillState.state);

            const skillName = skillState.state.skill_name || "unknown";
            const skillActiveReason = `[SKILL ACTIVE: ${skillName}] The "${skillName}" skill is still executing (reinforcement ${count + 1}/${maxReinforcements}). Continue working on the skill's instructions. Do not stop until the skill completes its workflow.`;
            console.log(JSON.stringify({
              decision: "block",
              reason: skillActiveReason,
            }));
            return;
          } else {
            // Reinforcement limit reached - clear state and allow stop
            try { if (skillState.path && existsSync(skillState.path)) unlinkSync(skillState.path); } catch {}
          }
        }
      }
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
