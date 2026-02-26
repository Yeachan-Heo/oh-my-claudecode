/**
 * Preemptive Compaction Hook
 *
 * Monitors context usage and warns before hitting the context limit.
 * Encourages proactive compaction to prevent context overflow.
 *
 * Adapted from oh-my-opencode's preemptive-compaction hook.
 *
 * Note: This is a simplified version for Claude Code's shell hook system.
 * The original uses OpenCode's plugin event system for automatic summarization.
 * This version injects warning messages to prompt manual compaction.
 */

import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';

import {
  DEFAULT_THRESHOLD,
  CRITICAL_THRESHOLD,
  COMPACTION_COOLDOWN_MS,
  MAX_WARNINGS,
  CLAUDE_DEFAULT_CONTEXT_LIMIT,
  CHARS_PER_TOKEN,
  CONTEXT_WARNING_MESSAGE,
  CONTEXT_CRITICAL_MESSAGE,
} from './constants.js';
import type {
  ContextUsageResult,
  PreemptiveCompactionConfig,
} from './types.js';

const DEBUG = process.env.PREEMPTIVE_COMPACTION_DEBUG === '1';
const DEBUG_FILE = path.join(tmpdir(), 'preemptive-compaction-debug.log');

/**
 * Rapid-fire debounce window (ms).
 * When multiple tool outputs arrive within this window (e.g. simultaneous
 * subagent completions in swarm/ultrawork), only the first triggers
 * context analysis. Subsequent calls within the window are skipped.
 * This is much shorter than COMPACTION_COOLDOWN_MS (which debounces warnings)
 * and specifically targets the concurrent flood scenario (issue #453).
 */
const RAPID_FIRE_DEBOUNCE_MS = 500;

/**
 * Per-session timestamp of last postToolUse analysis.
 * Used to debounce rapid-fire tool completions.
 */
const lastAnalysisTime = new Map<string, number>();

function debugLog(...args: unknown[]): void {
  if (DEBUG) {
    const msg = `[${new Date().toISOString()}] [preemptive-compaction] ${args
      .map((a) =>
        typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
      )
      .join(' ')}\n`;
    fs.appendFileSync(DEBUG_FILE, msg);
  }
}

/**
 * State tracking for all sessions
 */
const sessionStates = new Map<
  string,
  {
    lastWarningTime: number;
    warningCount: number;
    estimatedTokens: number;
  }
>();

/**
 * Clean up stale session states
 */
function cleanupSessionStates(): void {
  const now = Date.now();
  const MAX_AGE = 30 * 60 * 1000; // 30 minutes

  for (const [sessionId, state] of sessionStates) {
    if (now - state.lastWarningTime > MAX_AGE) {
      sessionStates.delete(sessionId);
      lastAnalysisTime.delete(sessionId);
    }
  }

  // Clean orphaned debounce entries
  for (const sessionId of lastAnalysisTime.keys()) {
    if (!sessionStates.has(sessionId)) {
      lastAnalysisTime.delete(sessionId);
    }
  }
}

// Run cleanup periodically
let cleanupIntervalStarted = false;

/**
 * Estimate tokens from text content
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Analyze context usage based on conversation content
 */
export function analyzeContextUsage(
  content: string,
  config?: PreemptiveCompactionConfig
): ContextUsageResult {
  const warningThreshold = config?.warningThreshold ?? DEFAULT_THRESHOLD;
  const criticalThreshold = config?.criticalThreshold ?? CRITICAL_THRESHOLD;
  const contextLimit = CLAUDE_DEFAULT_CONTEXT_LIMIT;

  const totalTokens = estimateTokens(content);
  const usageRatio = totalTokens / contextLimit;

  const isWarning = usageRatio >= warningThreshold;
  const isCritical = usageRatio >= criticalThreshold;

  let action: 'none' | 'warn' | 'compact' = 'none';
  if (isCritical) {
    action = 'compact';
  } else if (isWarning) {
    action = 'warn';
  }

  return {
    totalTokens,
    usageRatio,
    isWarning,
    isCritical,
    action,
  };
}

/**
 * Get or create session state
 */
function getSessionState(sessionId: string) {
  let state = sessionStates.get(sessionId);
  if (!state) {
    state = {
      lastWarningTime: 0,
      warningCount: 0,
      estimatedTokens: 0,
    };
    sessionStates.set(sessionId, state);
  }
  return state;
}

/**
 * Check if we should show a warning
 */
function shouldShowWarning(
  sessionId: string,
  config?: PreemptiveCompactionConfig
): boolean {
  const state = getSessionState(sessionId);
  const cooldownMs = config?.cooldownMs ?? COMPACTION_COOLDOWN_MS;
  const maxWarnings = config?.maxWarnings ?? MAX_WARNINGS;

  const now = Date.now();

  // Check cooldown
  if (now - state.lastWarningTime < cooldownMs) {
    debugLog('skipping warning - cooldown active', {
      sessionId,
      elapsed: now - state.lastWarningTime,
      cooldown: cooldownMs,
    });
    return false;
  }

  // Check max warnings
  if (state.warningCount >= maxWarnings) {
    debugLog('skipping warning - max reached', {
      sessionId,
      warningCount: state.warningCount,
      maxWarnings,
    });
    return false;
  }

  return true;
}

/**
 * Record that a warning was shown
 */
function recordWarning(sessionId: string): void {
  const state = getSessionState(sessionId);
  state.lastWarningTime = Date.now();
  state.warningCount++;
}

/**
 * Create preemptive compaction hook
 *
 * This hook monitors context usage and injects warning messages
 * when approaching the context limit.
 */
export function createPreemptiveCompactionHook(
  config?: PreemptiveCompactionConfig
) {
  debugLog('createPreemptiveCompactionHook called', { config });

  if (config?.enabled === false) {
    return {
      postToolUse: () => null,
      stop: () => null,
    };
  }

  if (!cleanupIntervalStarted) {
    cleanupIntervalStarted = true;
    // Note: setInterval is intentionally NOT used here — this module runs in
    // short-lived hook processes that exit before any timer fires. Cleanup is
    // done lazily on each invocation via the rapid-fire debounce path instead.
  }

  return {
    /**
     * PostToolUse - Check context usage after large tool outputs
     */
    postToolUse: (input: {
      tool_name: string;
      session_id: string;
      tool_input: Record<string, unknown>;
      tool_response?: string;
    }): string | null => {
      if (!input.tool_response) {
        return null;
      }

      // Only check after tools that produce large outputs
      const toolLower = input.tool_name.toLowerCase();
      const largeOutputTools = ['read', 'grep', 'glob', 'bash', 'webfetch', 'task'];
      if (!largeOutputTools.includes(toolLower)) {
        return null;
      }

      // Rapid-fire debounce: skip analysis if another was done very recently
      // for this session. Prevents concurrent flood when multiple subagents
      // complete simultaneously (issue #453).
      const now = Date.now();
      const lastAnalysis = lastAnalysisTime.get(input.session_id) ?? 0;
      if (now - lastAnalysis < RAPID_FIRE_DEBOUNCE_MS) {
        debugLog('skipping analysis - rapid-fire debounce active', {
          sessionId: input.session_id,
          elapsed: now - lastAnalysis,
          debounceMs: RAPID_FIRE_DEBOUNCE_MS,
        });
        // Still track tokens even when debounced
        const responseTokens = estimateTokens(input.tool_response);
        const state = getSessionState(input.session_id);
        state.estimatedTokens += responseTokens;
        return null;
      }
      lastAnalysisTime.set(input.session_id, now);

      // Estimate response size
      const responseTokens = estimateTokens(input.tool_response);

      // Track cumulative tokens for this session
      const state = getSessionState(input.session_id);
      state.estimatedTokens += responseTokens;

      debugLog('tracking tool output', {
        tool: toolLower,
        responseTokens,
        cumulativeTokens: state.estimatedTokens,
      });

      // Check if approaching limit
      const usage = analyzeContextUsage(
        'x'.repeat(state.estimatedTokens * CHARS_PER_TOKEN),
        config
      );

      if (!usage.isWarning) {
        return null;
      }

      if (!shouldShowWarning(input.session_id, config)) {
        return null;
      }

      recordWarning(input.session_id);

      debugLog('injecting context warning', {
        sessionId: input.session_id,
        usageRatio: usage.usageRatio,
        isCritical: usage.isCritical,
      });

      if (config?.customMessage) {
        return config.customMessage;
      }

      return usage.isCritical
        ? CONTEXT_CRITICAL_MESSAGE
        : CONTEXT_WARNING_MESSAGE;
    },

    /**
     * Stop event - Check context before stopping
     */
    stop: (input: { session_id: string }): string | null => {
      const state = getSessionState(input.session_id);

      // Reset warning count on stop (conversation might continue later)
      if (state.warningCount > 0) {
        debugLog('resetting warning count on stop', {
          sessionId: input.session_id,
          previousCount: state.warningCount,
        });
        state.warningCount = 0;
      }

      // Clear rapid-fire debounce state
      lastAnalysisTime.delete(input.session_id);

      return null;
    },
  };
}

/**
 * Get estimated token usage for a session
 */
export function getSessionTokenEstimate(sessionId: string): number {
  const state = sessionStates.get(sessionId);
  return state?.estimatedTokens ?? 0;
}

/**
 * Reset token estimate for a session (e.g., after compaction)
 */
export function resetSessionTokenEstimate(sessionId: string): void {
  const state = sessionStates.get(sessionId);
  if (state) {
    state.estimatedTokens = 0;
    state.warningCount = 0;
    state.lastWarningTime = 0;
  }
  lastAnalysisTime.delete(sessionId);
}

/**
 * Clear the rapid-fire debounce state for a session (for testing).
 */
export function clearRapidFireDebounce(sessionId: string): void {
  lastAnalysisTime.delete(sessionId);
}

// Re-export types and constants
export type {
  ContextUsageResult,
  PreemptiveCompactionConfig,
} from './types.js';

export { RAPID_FIRE_DEBOUNCE_MS };

export {
  DEFAULT_THRESHOLD,
  CRITICAL_THRESHOLD,
  COMPACTION_COOLDOWN_MS,
  MAX_WARNINGS,
  CLAUDE_DEFAULT_CONTEXT_LIMIT,
  CHARS_PER_TOKEN,
  CONTEXT_WARNING_MESSAGE,
  CONTEXT_CRITICAL_MESSAGE,
} from './constants.js';
