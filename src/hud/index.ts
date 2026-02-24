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
import { sanitizeOutput } from "./sanitize.js";
import type {
  HudRenderContext,
  SessionHealth,
} from "./types.js";
import { getRuntimePackageVersion } from "../lib/version.js";
import { compareVersions } from "../features/auto-update.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/**
 * Extract session ID (UUID) from a transcript path.
 */
function extractSessionIdFromPath(transcriptPath: string): string | null {
  if (!transcriptPath) return null;
  const match = transcriptPath.match(/([0-9a-f-]{36})(?:\.jsonl)?$/i);
  return match ? match[1] : null;
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
async function main(watchMode = false): Promise<void> {
  try {
    // Initialize HUD state (cleanup stale/orphaned tasks)
    await initializeHUDState();

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

    const cwd = stdin.cwd || process.cwd();

    // Read configuration (before transcript parsing so we can use staleTaskThresholdMinutes)
    const config = readHudConfig();

    // Parse transcript for agents and todos
    const transcriptData = await parseTranscript(stdin.transcript_path, {
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
    const currentSessionId = extractSessionIdFromPath(stdin.transcript_path);
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
    const rateLimits =
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
    } catch {
      // Ignore version detection errors
    }
    try {
      const updateCacheFile = join(homedir(), '.omc', 'update-check.json');
      if (existsSync(updateCacheFile)) {
        const cached = JSON.parse(readFileSync(updateCacheFile, 'utf-8'));
        if (cached?.latestVersion && omcVersion && compareVersions(omcVersion, cached.latestVersion) < 0) {
          updateAvailable = cached.latestVersion;
        }
      }
    } catch {
      // Ignore update cache read errors
    }

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
      lastSkill: transcriptData.lastActivatedSkill || null,
      rateLimits,
      customBuckets,
      pendingPermission: transcriptData.pendingPermission || null,
      thinkingState: transcriptData.thinkingState || null,
      sessionHealth: await calculateSessionHealth(
        sessionStart,
        getContextPercent(stdin),
      ),
      omcVersion,
      updateAvailable,
      toolCallCount: transcriptData.toolCallCount,
      agentCallCount: transcriptData.agentCallCount,
      skillCallCount: transcriptData.skillCallCount,
      promptTime: hudState?.lastPromptTimestamp
        ? new Date(hudState.lastPromptTimestamp)
        : null,
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
        const omcStateDir = join(cwd, '.omc', 'state');
        if (!existsSync(omcStateDir)) {
          mkdirSync(omcStateDir, { recursive: true });
        }
        const triggerFile = join(omcStateDir, 'compact-requested.json');
        writeFileSync(
          triggerFile,
          JSON.stringify({
            requestedAt: new Date().toISOString(),
            contextPercent: context.contextPercent,
            threshold: config.contextLimitWarning.threshold,
          }),
        );
      } catch {
        // Silent failure — don't break HUD rendering
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
