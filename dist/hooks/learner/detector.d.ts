/**
 * Extractable Moment Detector
 *
 * Detects patterns in conversation that indicate a skill could be extracted.
 */
export interface DetectionResult {
    /** Whether an extractable moment was detected */
    detected: boolean;
    /** Confidence score (0-100) */
    confidence: number;
    /** Type of pattern detected */
    patternType: 'problem-solution' | 'technique' | 'workaround' | 'optimization' | 'best-practice';
    /** Suggested trigger keywords */
    suggestedTriggers: string[];
    /** Reason for detection */
    reason: string;
}
/**
 * Detect if a message contains an extractable skill moment.
 */
export declare function detectExtractableMoment(assistantMessage: string, userMessage?: string): DetectionResult;
/**
 * Check if detection confidence meets threshold for prompting.
 */
export declare function shouldPromptExtraction(detection: DetectionResult, threshold?: number): boolean;
/**
 * Generate a prompt for skill extraction confirmation.
 */
export declare function generateExtractionPrompt(detection: DetectionResult): string;
//# sourceMappingURL=detector.d.ts.map