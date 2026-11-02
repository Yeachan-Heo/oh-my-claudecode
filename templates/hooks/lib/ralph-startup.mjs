/**
 * Ralph Loop Startup Helper
 *
 * Provides a unified way to initialize ralph state with PRD mode for both
 * the bridge and plugin scripts. This ensures consistency between:
 * - src/hooks/bridge.ts processPostToolUse
 * - scripts/post-tool-verifier.mjs
 * - scripts/keyword-detector.mjs
 */

import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { basename, join, dirname } from 'path';
import { execFileSync } from 'child_process';

const SESSION_ID_ALLOWLIST = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;

/**
 * Detect and strip critic mode flag from prompt (case-insensitive)
 * Matches: --critic=<mode> where mode is one of: architect, critic, codex
 */
export function detectCriticModeFlag(prompt) {
  const match = prompt.match(/--critic=([a-zA-Z]+)/i);
  if (match) {
    const mode = match[1].toLowerCase();
    if (['architect', 'critic', 'codex'].includes(mode)) {
      return mode;
    }
  }
  return null;
}

/**
 * Strip critic mode flag from prompt text and trim whitespace
 */
export function stripCriticModeFlag(prompt) {
  return prompt.replace(/\s*--critic=[a-zA-Z]+\s*/gi, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Detect and strip --no-prd flag from prompt (case-insensitive)
 */
export function detectNoPrdFlag(prompt) {
  return /--no-prd/i.test(prompt);
}

/**
 * Strip --no-prd flag from prompt text and trim whitespace
 */
export function stripNoPrdFlag(prompt) {
  return prompt.replace(/\s*--no-prd\s*/gi, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Get the session state directory path
 */
export function getSessionStateDir(omcRoot, sessionId) {
  if (!sessionId || !SESSION_ID_ALLOWLIST.test(sessionId)) {
    return null;
  }
  return join(omcRoot, 'state', 'sessions', sessionId);
}

/**
 * Create a minimal PRD scaffold in the .omc directory
 * Returns true if created or already exists, false on error
 */
export function createPrdScaffold(directory, sessionId) {
  try {
    const omcRoot = directory; // The .omc root is passed as directory
    const prdPath = join(omcRoot, 'prd.json');

    // Don't overwrite existing PRD
    if (existsSync(prdPath)) {
      return true;
    }

    // Create parent directories
    mkdirSync(dirname(prdPath), { recursive: true });

    // Create a minimal PRD scaffold
    const now = new Date().toISOString();
    const scaffold = {
      project: 'Unknown Project',
      branch: 'unknown',
      description: 'Ralph loop initialized via Skill tool',
      created_at: now,
      stories: [
        {
          id: 'initial-task',
          title: 'Initial Task',
          description: 'Complete the initial task',
          acceptanceCriteria: ['Task completed successfully'],
          passes: false,
          architectVerified: false,
          priority: 1,
        },
      ],
      archived_stories: [],
      feedback_commands: [],
    };

    writeFileSync(prdPath, JSON.stringify(scaffold, null, 2), { mode: 0o600 });
    return true;
  } catch (e) {
    console.error('[ralph-startup] Error creating PRD scaffold:', e.message);
    return false;
  }
}

/**
 * Initialize ralph state with PRD mode for Skill invocation
 * 
 * This function is called when the Skill tool invokes ralph via post-tool-verifier.mjs (PostToolUse hook).
 * It ensures consistent state initialization matching what src/hooks/bridge.ts does.
 * 
 * Note: Does not overwrite existing ralph state if it's already active from keyword detection.
 */
export function initializeRalphStateForSkill(
  directory,
  omcRoot,
  sessionId,
  prompt = 'Ralph loop activated via Skill tool',
) {
  try {
    // Validate session ID
    if (!sessionId || !SESSION_ID_ALLOWLIST.test(sessionId)) {
      return false;
    }

    // Normalize the prompt
    const rawPrompt = typeof prompt === 'string' && prompt.trim().length > 0
      ? prompt
      : 'Ralph loop activated via Skill tool';

    const criticMode = detectCriticModeFlag(rawPrompt);
    const cleanPrompt = stripCriticModeFlag(stripNoPrdFlag(rawPrompt));

    // Get git branch name (with fallback)
    let branchName = 'ralph/task';
    try {
      branchName = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: directory,
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true,
      }).trim();
    } catch {
      // Fallback outside git repos
    }

    // Create PRD scaffold
    const prdCreated = createPrdScaffold(omcRoot, sessionId);
    if (!prdCreated) {
      console.error('[ralph-startup] Failed to create PRD scaffold');
      return false;
    }

    // Get session state directory
    const sessionStateDir = getSessionStateDir(omcRoot, sessionId);
    if (!sessionStateDir) {
      return false;
    }

    // Create parent directories
    mkdirSync(sessionStateDir, { recursive: true });

    // Create ralph state with prd_mode: true
    const now = new Date().toISOString();
    const state = {
      active: true,
      iteration: 1,
      max_iterations: 100,
      started_at: now,
      prompt: cleanPrompt,
      session_id: sessionId,
      project_path: directory,
      critic_mode: criticMode ?? 'architect',
      prd_mode: true, // CRITICAL: This flag enables PRD mode
    };

    // Write ralph state
    const ralphStatePath = join(sessionStateDir, 'ralph.json');
    writeFileSync(ralphStatePath, JSON.stringify(state, null, 2), { mode: 0o600 });

    return true;
  } catch (e) {
    console.error('[ralph-startup] Error initializing ralph state:', e.message);
    return false;
  }
}
