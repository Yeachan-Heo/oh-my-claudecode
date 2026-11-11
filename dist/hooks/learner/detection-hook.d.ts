/**
 * Detection Hook
 *
 * Integrates skill detection into the message flow.
 */
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
/**
 * Process assistant response for skill detection.
 * Returns prompt text if extraction should be suggested, null otherwise.
 */
export declare function processResponseForDetection(assistantMessage: string, userMessage: string | undefined, sessionId: string, config?: Partial<DetectionConfig>): string | null;
/**
 * Get the last detection result for a session.
 */
export declare function getLastDetection(sessionId: string): DetectionResult | null;
/**
 * Clear detection state for a session.
 */
export declare function clearDetectionState(sessionId: string): void;
/**
 * Get detection statistics for a session.
 */
export declare function getDetectionStats(sessionId: string): {
    messagesSincePrompt: number;
    promptedCount: number;
    lastDetection: DetectionResult | null;
};
//# sourceMappingURL=detection-hook.d.ts.map