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
 * Patterns that indicate a skill might be extractable.
 */
const DETECTION_PATTERNS = [
  // Problem-Solution patterns
  {
    type: 'problem-solution' as const,
    patterns: [
      /the (?:issue|problem|bug|error) was (?:caused by|due to|because)/i,
      /(?:fixed|resolved|solved) (?:the|this) (?:by|with|using)/i,
      /the (?:solution|fix|answer) (?:is|was) to/i,
      /(?:here's|here is) (?:how|what) (?:to|you need to)/i,
    ],
    confidence: 80,
  },
  // Technique patterns
  {
    type: 'technique' as const,
    patterns: [
      /(?:a|the) (?:better|good|proper|correct) (?:way|approach|method) (?:is|to)/i,
      /(?:you should|we should|it's better to) (?:always|never|usually)/i,
      /(?:the trick|the key|the secret) (?:is|here is)/i,
    ],
    confidence: 70,
  },
  // Workaround patterns
  {
    type: 'workaround' as const,
    patterns: [
      /(?:as a|for a) workaround/i,
      /(?:temporarily|for now|until).*(?:you can|we can)/i,
      /(?:hack|trick) (?:to|for|that)/i,
    ],
    confidence: 60,
  },
  // Optimization patterns
  {
    type: 'optimization' as const,
    patterns: [
      /(?:to|for) (?:better|improved|faster) performance/i,
      /(?:optimize|optimizing|optimization) (?:by|with|using)/i,
      /(?:more efficient|efficiently) (?:by|to|if)/i,
    ],
    confidence: 65,
  },
  // Best practice patterns
  {
    type: 'best-practice' as const,
    patterns: [
      /(?:best practice|best practices) (?:is|are|include)/i,
      /(?:recommended|standard|common) (?:approach|pattern|practice)/i,
      /(?:you should always|always make sure to)/i,
    ],
    confidence: 75,
  },
];

/**
 * Keywords that often appear in extractable content.
 */
const TRIGGER_KEYWORDS = [
  // Technical domains
  'react', 'typescript', 'javascript', 'python', 'rust', 'go', 'node',
  'api', 'database', 'sql', 'graphql', 'rest', 'authentication', 'authorization',
  'testing', 'debugging', 'deployment', 'docker', 'kubernetes', 'ci/cd',
  'git', 'webpack', 'vite', 'eslint', 'prettier',
  // Actions
  'error handling', 'state management', 'performance', 'optimization',
  'refactoring', 'migration', 'integration', 'configuration',
  // Patterns
  'pattern', 'architecture', 'design', 'structure', 'convention',
];

/**
 * Detect if a message contains an extractable skill moment.
 */
export function detectExtractableMoment(
  assistantMessage: string,
  userMessage?: string
): DetectionResult {
  const combined = `${userMessage || ''} ${assistantMessage}`.toLowerCase();

  let bestMatch: { type: DetectionResult['patternType']; confidence: number; reason: string } | null = null;

  // Check against detection patterns
  for (const patternGroup of DETECTION_PATTERNS) {
    for (const pattern of patternGroup.patterns) {
      if (pattern.test(assistantMessage)) {
        if (!bestMatch || patternGroup.confidence > bestMatch.confidence) {
          bestMatch = {
            type: patternGroup.type,
            confidence: patternGroup.confidence,
            reason: `Detected ${patternGroup.type} pattern`,
          };
        }
      }
    }
  }

  if (!bestMatch) {
    return {
      detected: false,
      confidence: 0,
      patternType: 'problem-solution',
      suggestedTriggers: [],
      reason: 'No extractable pattern detected',
    };
  }

  // Extract potential trigger keywords
  const suggestedTriggers: string[] = [];
  for (const keyword of TRIGGER_KEYWORDS) {
    if (combined.includes(keyword.toLowerCase())) {
      suggestedTriggers.push(keyword);
    }
  }

  // Boost confidence if multiple triggers found
  const triggerBoost = Math.min(suggestedTriggers.length * 5, 15);
  const finalConfidence = Math.min(bestMatch.confidence + triggerBoost, 100);

  return {
    detected: true,
    confidence: finalConfidence,
    patternType: bestMatch.type,
    suggestedTriggers: suggestedTriggers.slice(0, 5), // Max 5 triggers
    reason: bestMatch.reason,
  };
}

/**
 * Check if detection confidence meets threshold for prompting.
 */
export function shouldPromptExtraction(
  detection: DetectionResult,
  threshold: number = 60
): boolean {
  return detection.detected && detection.confidence >= threshold;
}

/**
 * Generate a prompt for skill extraction confirmation.
 */
export function generateExtractionPrompt(detection: DetectionResult): string {
  const typeDescriptions: Record<DetectionResult['patternType'], string> = {
    'problem-solution': 'a problem and its solution',
    'technique': 'a useful technique',
    'workaround': 'a workaround for a limitation',
    'optimization': 'an optimization approach',
    'best-practice': 'a best practice',
  };

  return `
I noticed this conversation contains ${typeDescriptions[detection.patternType]} that might be worth saving as a reusable skill.

**Confidence:** ${detection.confidence}%
**Suggested triggers:** ${detection.suggestedTriggers.join(', ') || 'None detected'}

Would you like me to extract this as a learned skill? Type \`/learner\` to save it, or continue with your current task.
`.trim();
}
