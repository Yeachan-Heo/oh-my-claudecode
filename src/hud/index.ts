#!/usr/bin/env node
/**
 * OMC HUD - Main Entry Point
 *
 * Statusline command that visualizes oh-my-claudecode state.
 * Receives stdin JSON from Claude Code and outputs formatted statusline.
 */

import { readStdin, getContextPercent, getModelName } from './stdin.js';
import { parseTranscript } from './transcript.js';
import { readHudState, readHudConfig, getRunningTasks, initializeHUDState } from './state.js';
import {
  readRalphStateForHud,
  readUltraworkStateForHud,
  readPrdStateForHud,
  readAutopilotStateForHud,
} from './omc-state.js';
import { getUsage } from './usage-api.js';
import { render } from './render.js';
import type { HudRenderContext, SessionHealth } from './types.js';

/**
 * Calculate session health from session start time and context usage.
 */
function calculateSessionHealth(
  sessionStart: Date | undefined,
  contextPercent: number
): SessionHealth | null {
  if (!sessionStart) return null;

  const durationMs = Date.now() - sessionStart.getTime();
  const durationMinutes = Math.floor(durationMs / 60_000);

  let health: SessionHealth['health'] = 'healthy';
  if (durationMinutes > 120 || contextPercent > 85) {
    health = 'critical';
  } else if (durationMinutes > 60 || contextPercent > 70) {
    health = 'warning';
  }

  return { durationMinutes, messageCount: 0, health };
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
      console.log('[OMC] run /omc-setup to install properly');
      return;
    }

    const cwd = stdin.cwd || process.cwd();

    // Parse transcript for agents and todos
    const transcriptData = await parseTranscript(stdin.transcript_path);

    // Read OMC state files
    const ralph = readRalphStateForHud(cwd);
    const ultrawork = readUltraworkStateForHud(cwd);
    const prd = readPrdStateForHud(cwd);
    const autopilot = readAutopilotStateForHud(cwd);

    // Read HUD state for background tasks
    const hudState = readHudState(cwd);
    const backgroundTasks = hudState?.backgroundTasks || [];

    // Read configuration
    const config = readHudConfig();

    // Fetch rate limits from OAuth API (if available)
    const rateLimits = config.elements.rateLimits !== false
      ? await getUsage()
      : null;

    // Build render context
    const context: HudRenderContext = {
      contextPercent: getContextPercent(stdin),
      modelName: getModelName(stdin),
      ralph,
      ultrawork,
      prd,
      autopilot,
      activeAgents: transcriptData.agents.filter((a) => a.status === 'running'),
      todos: transcriptData.todos,
      backgroundTasks: getRunningTasks(hudState),
      cwd,
      lastSkill: transcriptData.lastActivatedSkill || null,
      rateLimits,
      pendingPermission: transcriptData.pendingPermission || null,
      thinkingState: transcriptData.thinkingState || null,
      sessionHealth: calculateSessionHealth(transcriptData.sessionStart, getContextPercent(stdin))
    };

    // Render and output
    const output = await render(context, config);

    // Replace spaces with non-breaking spaces for terminal alignment
    const formattedOutput = output.replace(/ /g, '\u00A0');
    console.log(formattedOutput);
  } catch (error) {
    // On any error, suggest setup
    console.log('[OMC] run /omc-setup to install properly');
  }
}

// Run main
main();
