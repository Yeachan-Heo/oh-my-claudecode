#!/usr/bin/env node
/**
 * OMC HUD - Main Entry Point
 *
 * Statusline command that visualizes oh-my-claudecode state.
 * Receives stdin JSON from Claude Code and outputs formatted statusline.
 */

import { readStdin, writeStdinCache, readStdinCache, getContextPercent, getModelName } from "./stdin.js";
import { parseTranscript } from "./transcript.js";
import {
  readHudState,
  readHudConfig,
  getRunningTasks,
  writeHudState,
  initializeHUDState,
} from "./state.js";
import {
  readRalphStateForHud,
  readUltraworkStateForHud,
  readPrdStateForHud,
  readAutopilotStateForHud,
} from "./omc-state.js";
import { getUsage } from "./usage-api.js";
import { executeCustomProvider } from "./custom-rate-provider.js";
import { render } from "./render.js";
import { detectApiKeySource } from "./elements/api-key-source.js";
import { refreshMissionBoardState } from "./mission-board.js";
import { sanitizeOutput } from "./sanitize.js";
import type {
  HudRenderContext,
  SessionHealth,
  SessionSummaryState,
} from "./types.js";
import { getRuntimePackageVersion } from "../lib/version.js";
import { compareVersions } from "../features/auto-update.js";
import { resolveToWorktreeRoot, resolveTranscriptPath } from "../lib/worktree-paths.js";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { access, readFile } from "fs/promises";
import { join, basename, dirname } from "path";
import { homedir } from "os";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { getOmcRoot } from "../lib/worktree-paths.js";

/**
 * Extract session ID (UUID) from a transcript path.
 */
function extractSessionIdFromPath(transcriptPath: string): string | null {
  if (!transcriptPath) return null;
  const match = transcriptPath.match(/([0-9a-f-]{36})(?:\.jsonl)?$/i);
  return match ? match[1] : null;
}


/**
 * Read cached session summary from state directory.
 */
function readSessionSummary(stateDir: string, sessionId: string): SessionSummaryState | null {
  const statePath = join(stateDir, `session-summary-${sessionId}.json`);
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Spawn the session-summary script in the background to generate/update summary.
 * Fire-and-forget: does not block HUD rendering.
 */
function spawnSessionSummaryScript(transcriptPath: string, stateDir: string, sessionId: string): void {
  // Resolve the script path relative to this file's location
  // In compiled output: dist/hud/index.js -> ../../scripts/session-summary.mjs
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(thisDir, '..', '..', 'scripts', 'session-summary.mjs');

  if (!existsSync(scriptPath)) {
    if (process.env.OMC_DEBUG) {
      console.error('[HUD] session-summary script not found:', scriptPath);
    }
    return;
  }

  try {
    const child = spawn('node', [scriptPath, transcriptPath, stateDir, sessionId], {
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'session-summary' },
    });
    child.unref();
  } catch (error) {
    if (process.env.OMC_DEBUG) {
      console.error('[HUD] Failed to spawn session-summary:', error instanceof Error ? error.message : error);
    }
  }
}

/**
 * Calculate session health from session start time and context usage.
 */
async function calculateSessionHealth(
  sessionStart: Date | undefined,
  contextPercent: number,
): Promise<SessionHealth | null> {
  const durationMs = sessionStart ? Date.now() - sessionStart.getTime() : 0;
  const durationMinutes = Math.floor(durationMs / 60_000);
  let health: SessionHealth['health'] = 'healthy';
  if (durationMinutes > 120 || contextPercent > 85) health = 'critical';
  else if (durationMinutes > 60 || contextPercent > 70) health = 'warning';
  return { durationMinutes, messageCount: 0, health };
}

/**
 * Main HUD entry point
 * @param watchMode - true when called from the --watch polling loop (stdin is TTY)
 */
async function main(watchMode = false, skipInit = false): Promise<void> {
  try {
    // Initialize HUD state (cleanup stale/orphaned tasks)
    if (!skipInit) {
      await initializeHUDState();
    }

    // Read stdin from Claude Code
    let stdin = await readStdin();

    if (stdin) {
      // Persist for --watch mode so it can read data when stdin is a TTY
      writeStdinCache(stdin);
    } else if (watchMode) {
      // In watch mode stdin is always a TTY; fall back to last cached value
      stdin = readStdinCache();
      if (!stdin) {
        // Cache not yet populated (first poll before statusline fires)
        console.log("[OMC] Starting...");
        return;
      }
    } else {
      // Non-watch invocation with no stdin - suggest setup
      console.log("[OMC] run /omc-setup to install properly");
      return;
    }

    const cwd = resolveToWorktreeRoot(stdin.cwd || undefined);

    // Read configuration (before transcript parsing so we can use staleTaskThresholdMinutes)
    const config = readHudConfig();

    // Resolve worktree-mismatched transcript paths (issue #1094)
    const resolvedTranscriptPath = resolveTranscriptPath(stdin.transcript_path, cwd);

    // Parse transcript for agents and todos
    const transcriptData = await parseTranscript(resolvedTranscriptPath, {
      staleTaskThresholdMinutes: config.staleTaskThresholdMinutes,
    });

    // Read OMC state files
    const ralph = readRalphStateForHud(cwd);
    const ultrawork = readUltraworkStateForHud(cwd);
    const prd = readPrdStateForHud(cwd);
    const autopilot = readAutopilotStateForHud(cwd);

    // Read HUD state for background tasks
    const hudState = readHudState(cwd);
    const _backgroundTasks = hudState?.backgroundTasks || [];

    // Persist session start time to survive tail-parsing resets (#528)
    // When tail parsing kicks in for large transcripts, sessionStart comes from
    // the first entry in the tail chunk rather than the actual session start.
    // We persist the real start time in HUD state on first observation.
    // Scoped per session ID so a new session in the same cwd resets the timestamp.
    let sessionStart = transcriptData.sessionStart;
    const currentSessionId = extractSessionIdFromPath(resolvedTranscriptPath ?? stdin.transcript_path);
    const sameSession = hudState?.sessionId === currentSessionId;
    if (sameSession && hudState?.sessionStartTimestamp) {
      // Use persisted value (the real session start) - but validate first
      const persisted = new Date(hudState.sessionStartTimestamp);
      if (!isNaN(persisted.getTime())) {
        sessionStart = persisted;
      }
      // If invalid, fall through to transcript-derived sessionStart
    } else if (sessionStart) {
      // First time seeing session start (or new session) - persist it
      const stateToWrite = hudState || { timestamp: new Date().toISOString(), backgroundTasks: [] };
      stateToWrite.sessionStartTimestamp = sessionStart.toISOString();
      stateToWrite.sessionId = currentSessionId ?? undefined;
      stateToWrite.timestamp = new Date().toISOString();
      writeHudState(stateToWrite, cwd);
    }

    // Fetch rate limits from OAuth API (if available)
    const rateLimitsResult =
      config.elements.rateLimits !== false ? await getUsage() : null;

    // Fetch custom rate limit buckets (if configured)
    const customBuckets =
      config.rateLimitsProvider?.type === 'custom'
        ? await executeCustomProvider(config.rateLimitsProvider)
        : null;

    // Read OMC version and update check cache
    let omcVersion: string | null = null;
    let updateAvailable: string | null = null;
    try {
      omcVersion = getRuntimePackageVersion();
      if (omcVersion === 'unknown') omcVersion = null;
    } catch (error) {
      // Ignore version detection errors
      if (process.env.OMC_DEBUG) {
        console.error('[HUD] Version detection error:', error instanceof Error ? error.message : error);
      }
    }
    // Async file read to avoid blocking event loop (Issue #1273)
    try {
      const updateCacheFile = join(homedir(), '.omc', 'update-check.json');
      await access(updateCacheFile);
      const content = await readFile(updateCacheFile, 'utf-8');
      const cached = JSON.parse(content);
      if (cached?.latestVersion && omcVersion && compareVersions(omcVersion, cached.latestVersion) < 0) {
        updateAvailable = cached.latestVersion;
      }
    } catch (error) {
      // Ignore update cache read errors - expected if file doesn't exist yet
      if (process.env.OMC_DEBUG) {
        console.error('[HUD] Update cache read error:', error instanceof Error ? error.message : error);
      }
    }

    // Session summary: read cached state and trigger background regeneration if needed
    let sessionSummary: SessionSummaryState | null = null;
    const sessionSummaryEnabled = config.elements.sessionSummary ?? false;
    if (sessionSummaryEnabled && resolvedTranscriptPath && currentSessionId) {
      const omcStateDir = join(getOmcRoot(cwd), 'state');
      sessionSummary = readSessionSummary(omcStateDir, currentSessionId);

      // Debounce: only spawn script if cache is absent or older than 60 seconds.
      // This prevents spawning a child process on every HUD poll (every ~1s).
      // The child script still checks turn-count freshness internally.
      const shouldSpawn = !sessionSummary?.generatedAt
        || (Date.now() - new Date(sessionSummary.generatedAt).getTime() > 60_000);

      if (shouldSpawn) {
        spawnSessionSummaryScript(resolvedTranscriptPath, omcStateDir, currentSessionId);
      }
    }

    const missionBoardEnabled = config.missionBoard?.enabled ?? config.elements.missionBoard ?? false;
    const missionBoard = missionBoardEnabled
      ? await refreshMissionBoardState(cwd, config.missionBoard)
      : null;

    // Build render context
    const context: HudRenderContext = {
      contextPercent: getContextPercent(stdin),
      modelName: getModelName(stdin),
      ralph,
      ultrawork,
      prd,
      autopilot,
      activeAgents: transcriptData.agents.filter((a) => a.status === "running"),
      todos: transcriptData.todos,
      backgroundTasks: getRunningTasks(hudState),
      cwd,
      missionBoard,
      lastSkill: transcriptData.lastActivatedSkill || null,
      rateLimitsResult,
      customBuckets,
      pendingPermission: transcriptData.pendingPermission || null,
      thinkingState: transcriptData.thinkingState || null,
      sessionHealth: await calculateSessionHealth(
        sessionStart,
        getContextPercent(stdin),
      ),
      lastRequestTokenUsage: transcriptData.lastRequestTokenUsage || null,
      sessionTotalTokens: transcriptData.sessionTotalTokens ?? null,
      omcVersion,
      updateAvailable,
      toolCallCount: transcriptData.toolCallCount,
      agentCallCount: transcriptData.agentCallCount,
      skillCallCount: transcriptData.skillCallCount,
      promptTime: hudState?.lastPromptTimestamp
        ? new Date(hudState.lastPromptTimestamp)
        : null,
      apiKeySource: config.elements.apiKeySource
        ? detectApiKeySource(cwd)
        : null,
      profileName: process.env.CLAUDE_CONFIG_DIR
        ? basename(process.env.CLAUDE_CONFIG_DIR).replace(/^\./, '')
        : null,
      sessionSummary,
    };

    // Debug: log data if OMC_DEBUG is set
    if (process.env.OMC_DEBUG) {
      console.error(
        "[HUD DEBUG] stdin.context_window:",
        JSON.stringify(stdin.context_window),
      );
      console.error(
        "[HUD DEBUG] sessionHealth:",
        JSON.stringify(context.sessionHealth),
      );
    }

    // autoCompact: write trigger file when context exceeds threshold
    // A companion hook can read this file to inject a /compact suggestion.
    if (
      config.contextLimitWarning.autoCompact &&
      context.contextPercent >= config.contextLimitWarning.threshold
    ) {
      try {
        const omcStateDir = join(getOmcRoot(cwd), 'state');
        mkdirSync(omcStateDir, { recursive: true });
        const triggerFile = join(omcStateDir, 'compact-requested.json');
        writeFileSync(
          triggerFile,
          JSON.stringify({
            requestedAt: new Date().toISOString(),
            contextPercent: context.contextPercent,
            threshold: config.contextLimitWarning.threshold,
          }),
        );
      } catch (error) {
        // Silent failure — don't break HUD rendering
        if (process.env.OMC_DEBUG) {
          console.error('[HUD] Auto-compact trigger write error:', error instanceof Error ? error.message : error);
        }
      }
    }

    // Render and output
    let output = await render(context, config);

    // Apply safe mode sanitization if enabled (Issue #346)
    // This strips ANSI codes and uses ASCII-only output to prevent
    // terminal rendering corruption during concurrent updates
    // On Windows, always use safe mode to prevent terminal rendering issues
    // with non-breaking spaces and ANSI escape sequences
    const useSafeMode = config.elements.safeMode || process.platform === 'win32';

    if (useSafeMode) {
      output = sanitizeOutput(output);
      // In safe mode, use regular spaces (don't convert to non-breaking)
      console.log(output);
    } else {
      // Replace spaces with non-breaking spaces for terminal alignment
      const formattedOutput = output.replace(/ /g, "\u00A0");
      console.log(formattedOutput);
    }
  } catch (error) {
    // Distinguish installation errors from runtime errors
    const isInstallError =
      error instanceof Error &&
      (error.message.includes("ENOENT") ||
        error.message.includes("MODULE_NOT_FOUND") ||
        error.message.includes("Cannot find module"));

    if (isInstallError) {
      console.log("[OMC] run /omc-setup to install properly");
    } else {
      // Output fallback message to stdout for status line visibility
      console.log("[OMC] HUD error - check stderr");
      // Log actual runtime errors to stderr for debugging
      console.error(
        "[OMC HUD Error]",
        error instanceof Error ? error.message : error,
      );
    }
  }
}

// Export for programmatic use (e.g., omc hud --watch loop)
export { main };

// Auto-run (unconditional so dynamic import() via omc-hud.mjs wrapper works correctly)
main();
