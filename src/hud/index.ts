#!/usr/bin/env node
/**
 * OMC HUD - Main Entry Point
 *
 * Statusline command that visualizes oh-my-claudecode state.
 * Receives stdin JSON from Claude Code and outputs formatted statusline.
 */

import { readStdin, getContextPercent, getModelName } from "./stdin.js";
import { parseTranscript } from "./transcript.js";
import {
  readHudState,
  readHudConfig,
  getRunningTasks,
  initializeHUDState,
} from "./state.js";
import {
  readRalphStateForHud,
  readUltraworkStateForHud,
  readPrdStateForHud,
  readAutopilotStateForHud,
} from "./omc-state.js";
import { getUsage } from "./usage-api.js";
import { render } from "./render.js";
import { sanitizeOutput } from "./sanitize.js";
import type {
  HudRenderContext,
  SessionHealth,
  StatuslineStdin,
} from "./types.js";
import {
  extractTokens,
  createSnapshot,
  type TokenSnapshot,
} from "../analytics/token-extractor.js";
import { extractSessionId } from "../analytics/output-estimator.js";
import { getTokenTracker } from "../analytics/token-tracker.js";

// Persistent token snapshot for delta calculations
let previousSnapshot: TokenSnapshot | null = null;

/**
 * Record token usage to analytics tracker.
 * Silent failure - doesn't break HUD rendering.
 */
async function recordTokenUsage(
  stdin: any,
  transcriptData: any,
): Promise<void> {
  try {
    // Debug: Log stdin.context_window data
    if (process.env.OMC_DEBUG) {
      console.error(
        "[TokenRecording] stdin.context_window:",
        JSON.stringify(stdin.context_window),
      );
    }

    // Get model name from stdin
    const modelName = getModelName(stdin);

    // Get running agents from transcript
    const runningAgents =
      transcriptData.agents?.filter((a: any) => a.status === "running") ?? [];
    const agentName =
      runningAgents.length > 0 ? runningAgents[0].name : undefined;

    if (process.env.OMC_DEBUG) {
      console.error("[TokenRecording] agentName determined:", agentName);
    }

    // Extract tokens (delta from previous)
    const extracted = extractTokens(
      stdin,
      previousSnapshot,
      modelName,
      agentName,
    );

    if (process.env.OMC_DEBUG) {
      console.error("[TokenRecording] extracted tokens:", {
        inputTokens: extracted.inputTokens,
        outputTokens: extracted.outputTokens,
        cacheCreationTokens: extracted.cacheCreationTokens,
        cacheReadTokens: extracted.cacheReadTokens,
        agentName: extracted.agentName,
        modelName: extracted.modelName,
      });
    }

    // Only record if there's actual token usage
    if (extracted.inputTokens > 0 || extracted.cacheCreationTokens > 0) {
      if (process.env.OMC_DEBUG) {
        console.error(
          "[TokenRecording] Recording condition PASSED - recording usage",
        );
      }

      // Get session ID
      const sessionId = extractSessionId(stdin.transcript_path);

      // Get tracker and record
      const tracker = getTokenTracker(sessionId);
      await tracker.recordTokenUsage({
        agentName: extracted.agentName,
        modelName: extracted.modelName,
        inputTokens: extracted.inputTokens,
        outputTokens: extracted.outputTokens,
        cacheCreationTokens: extracted.cacheCreationTokens,
        cacheReadTokens: extracted.cacheReadTokens,
      });

      if (process.env.OMC_DEBUG) {
        console.error(
          "[TokenRecording] Successfully recorded usage for agent:",
          extracted.agentName,
        );
      }
    } else {
      if (process.env.OMC_DEBUG) {
        console.error(
          "[TokenRecording] Recording condition FAILED - no token delta detected",
        );
      }
    }

    // Update snapshot for next render
    previousSnapshot = createSnapshot(stdin);
  } catch (error) {
    // Silent failure - don't break HUD rendering
    if (process.env.OMC_DEBUG) {
      console.error("[Analytics] Token recording failed:", error);
    }
  }
}

/**
 * Fallback: compute session analytics from in-memory TokenTracker stats.
 * Used when loadAnalyticsFast() returns null or throws.
 *
 * NOTE: This works because recordTokenUsage() is called BEFORE calculateSessionHealth()
 * in main() (line 167 before line 203). The first call to getTokenTracker(sessionId)
 * creates the singleton with the correct sessionId and populates it. Subsequent calls
 * get the same instance regardless of the sessionId parameter (see token-tracker.ts:274-278).
 * DO NOT reorder recordTokenUsage/calculateSessionHealth in main().
 *
 * @returns Analytics fields or null if no token data available
 */
async function getTokenTrackerFallback(
  sessionId: string,
  durationMs: number,
): Promise<{
  sessionCost: number;
  totalTokens: number;
  cacheHitRate: number;
  costPerHour: number;
} | null> {
  const tracker = getTokenTracker(sessionId);
  const stats = tracker.getSessionStats();

  if (stats.totalInputTokens === 0 && stats.totalCacheCreation === 0) {
    return null;
  }

  const { calculateCost } = await import("../analytics/cost-estimator.js");

  let cost = 0;
  for (const [model, usages] of Object.entries(stats.byModel)) {
    for (const usage of usages) {
      const c = calculateCost({
        modelName: model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        cacheReadTokens: usage.cacheReadTokens,
      });
      cost += c.totalCost;
    }
  }

  const totalTokens = stats.totalInputTokens + stats.totalOutputTokens;
  const totalInput = stats.totalInputTokens + stats.totalCacheCreation + stats.totalCacheRead;
  const cacheHitRate =
    totalInput > 0 ? (stats.totalCacheRead / totalInput) * 100 : 0;
  const hours = durationMs / (1000 * 60 * 60);
  const costPerHour = hours > 0 ? cost / hours : 0;

  return { sessionCost: cost, totalTokens, cacheHitRate, costPerHour };
}

/**
 * Calculate session health from session start time and LIVE stdin data.
 * Uses stdin's current_usage for real-time token display.
 */
async function calculateSessionHealth(
  sessionStart: Date | undefined,
  contextPercent: number,
  stdin: StatuslineStdin,
): Promise<SessionHealth | null> {
  // Calculate duration (use 0 if no session start)
  const durationMs = sessionStart ? Date.now() - sessionStart.getTime() : 0;
  const durationMinutes = Math.floor(durationMs / 60_000);

  let health: SessionHealth["health"] = "healthy";
  if (durationMinutes > 120 || contextPercent > 85) {
    health = "critical";
  } else if (durationMinutes > 60 || contextPercent > 70) {
    health = "warning";
  }

  // Get LIVE token data from stdin (not from analytics files)
  const usage = stdin.context_window?.current_usage;
  const inputTokens = usage?.input_tokens ?? 0;
  const cacheCreationTokens = usage?.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = usage?.cache_read_input_tokens ?? 0;

  // Debug: log token data if OMC_DEBUG is set
  if (process.env.OMC_DEBUG) {
    console.error("[HUD DEBUG] current_usage:", JSON.stringify(usage));
    console.error("[HUD DEBUG] tokens:", {
      inputTokens,
      cacheCreationTokens,
      cacheReadTokens,
    });
  }

  // Calculate totals from live data
  const totalTokens = inputTokens + cacheCreationTokens + cacheReadTokens;
  const totalInputForCache = inputTokens + cacheCreationTokens;
  const cacheHitRate =
    totalInputForCache > 0
      ? (cacheReadTokens / (totalInputForCache + cacheReadTokens)) * 100
      : 0;

  // Estimate output tokens and cost
  let sessionCost = 0;
  let costPerHour = 0;
  const isEstimated = true;

  try {
    const { calculateCost } = await import("../analytics/cost-estimator.js");
    const { estimateOutputTokens } =
      await import("../analytics/output-estimator.js");

    const modelName =
      stdin.model?.id ?? stdin.model?.display_name ?? "claude-sonnet-4.5";
    const estimatedOutput = estimateOutputTokens(inputTokens, modelName);

    const costResult = calculateCost({
      modelName,
      inputTokens,
      outputTokens: estimatedOutput,
      cacheCreationTokens,
      cacheReadTokens,
    });

    sessionCost = costResult.totalCost;

    // Calculate cost per hour
    const hours = durationMs / (1000 * 60 * 60);
    costPerHour = hours > 0 ? sessionCost / hours : 0;

    // Adjust health based on cost (Budget warnings)
    if (sessionCost > 5.0) {
      health = "critical";
    } else if (sessionCost > 2.0 && health !== "critical") {
      health = "warning";
    }
  } catch (error) {
    if (process.env.OMC_DEBUG) {
      console.error("[HUD] Cost calculation failed:", error);
    }
    // Cost calculation failed - continue with zeros
  }

  // Get top agents from tracker
  let topAgents: Array<{ agent: string; cost: number }> = [];
  try {
    const sessionId = extractSessionId(stdin.transcript_path);
    if (sessionId) {
      const tracker = getTokenTracker(sessionId);
      const agents = await tracker.getTopAgents(3);
      topAgents = agents.map((a) => ({ agent: a.agent, cost: a.cost }));
    }
  } catch (error) {
    if (process.env.OMC_DEBUG) {
      console.error("[HUD] Top agents fetch failed:", error);
    }
    // Top agents fetch failed - continue with empty
  }

  return {
    durationMinutes,
    messageCount: 0,
    health,
    sessionCost,
    totalTokens,
    cacheHitRate,
    topAgents,
    costPerHour,
    isEstimated,
  };
}

/**
 * Main HUD entry point
 */
async function main(): Promise<void> {
  try {
    // Initialize HUD state (cleanup stale/orphaned tasks)
    await initializeHUDState();

    // Read stdin from Claude Code
    const stdin = await readStdin();

    if (!stdin) {
      // No stdin - suggest setup
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

    // Record token usage (auto-tracking)
    await recordTokenUsage(stdin, transcriptData);

    // Read OMC state files
    const ralph = readRalphStateForHud(cwd);
    const ultrawork = readUltraworkStateForHud(cwd);
    const prd = readPrdStateForHud(cwd);
    const autopilot = readAutopilotStateForHud(cwd);

    // Read HUD state for background tasks
    const hudState = readHudState(cwd);
    const backgroundTasks = hudState?.backgroundTasks || [];

    // Fetch rate limits from OAuth API (if available)
    const rateLimits =
      config.elements.rateLimits !== false ? await getUsage() : null;

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
      pendingPermission: transcriptData.pendingPermission || null,
      thinkingState: transcriptData.thinkingState || null,
      sessionHealth: await calculateSessionHealth(
        transcriptData.sessionStart,
        getContextPercent(stdin),
        stdin,
      ),
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

    // Render and output
    let output = await render(context, config);

    // Apply safe mode sanitization if enabled (Issue #346)
    // This strips ANSI codes and uses ASCII-only output to prevent
    // terminal rendering corruption during concurrent updates
    if (config.elements.safeMode) {
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

// Run main
main();
