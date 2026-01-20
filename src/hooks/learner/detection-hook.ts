/**
 * Detection Hook
 *
 * Integrates skill detection into the message flow.
 */

import { detectExtractableMoment, shouldPromptExtraction, generateExtractionPrompt } from './detector.js';
import { isLearnerEnabled } from './index.js';
import type { DetectionResult } from './detector.js';

/**
 * Configuration for detection behavior.
 */
export interface DetectionConfig {
  /** Minimum confidence to prompt (0-100) */
  promptThreshold: number;
  /** Cooldown between prompts (messages) */
  promptCooldown: number;
  /** Enable/disable auto-detection */
  enabled: boolean;
}

const DEFAULT_CONFIG: DetectionConfig = {
  promptThreshold: 60,
  promptCooldown: 5,
  enabled: true,
};

/**
 * Session state for detection.
 */
interface SessionDetectionState {
  messagesSincePrompt: number;
  lastDetection: DetectionResult | null;
  promptedCount: number;
}

const sessionStates = new Map<string, SessionDetectionState>();

/**
 * Get or create session state.
 */
function getSessionState(sessionId: string): SessionDetectionState {
  if (!sessionStates.has(sessionId)) {
    sessionStates.set(sessionId, {
      messagesSincePrompt: 0,
      lastDetection: null,
      promptedCount: 0,
    });
  }
  return sessionStates.get(sessionId)!;
}

/**
 * Process assistant response for skill detection.
 * Returns prompt text if extraction should be suggested, null otherwise.
 */
export function processResponseForDetection(
  assistantMessage: string,
  userMessage: string | undefined,
  sessionId: string,
  config: Partial<DetectionConfig> = {}
): string | null {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  if (!mergedConfig.enabled || !isLearnerEnabled()) {
    return null;
  }

  const state = getSessionState(sessionId);
  state.messagesSincePrompt++;

  // Check cooldown
  if (state.messagesSincePrompt < mergedConfig.promptCooldown) {
    return null;
  }

  // Detect extractable moment
  const detection = detectExtractableMoment(assistantMessage, userMessage);
  state.lastDetection = detection;

  // Check if we should prompt
  if (shouldPromptExtraction(detection, mergedConfig.promptThreshold)) {
    state.messagesSincePrompt = 0;
    state.promptedCount++;
    return generateExtractionPrompt(detection);
  }

  return null;
}

/**
 * Get the last detection result for a session.
 */
export function getLastDetection(sessionId: string): DetectionResult | null {
  return sessionStates.get(sessionId)?.lastDetection || null;
}

/**
 * Clear detection state for a session.
 */
export function clearDetectionState(sessionId: string): void {
  sessionStates.delete(sessionId);
}

/**
 * Get detection statistics for a session.
 */
export function getDetectionStats(sessionId: string): {
  messagesSincePrompt: number;
  promptedCount: number;
  lastDetection: DetectionResult | null;
} {
  const state = sessionStates.get(sessionId);
  if (!state) {
    return {
      messagesSincePrompt: 0,
      promptedCount: 0,
      lastDetection: null,
    };
  }
  return {
    messagesSincePrompt: state.messagesSincePrompt,
    promptedCount: state.promptedCount,
    lastDetection: state.lastDetection,
  };
}
