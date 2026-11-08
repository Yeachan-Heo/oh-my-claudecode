/**
 * Auto-Learner Module
 *
 * Automatically detects skill-worthy patterns during work sessions.
 * Tracks problem-solution pairs and suggests skill extraction.
 */

import { createHash } from "crypto";
import type { SkillMetadata } from "./types.js";

const ABSOLUTE_PATH_PATTERN =
  /(?:^|\s)((?:[A-Z]:)?(?:\/|\\)[\w\/\\.-]+\.\w+)/gi;
const RELATIVE_PATH_PATTERN = /(?:^|\s)(\.\.?\/[\w\/.-]+\.\w+)/gi;
const SIMPLE_PATH_PATTERN = /(?:^|\s)([\w-]+(?:\/[\w-]+)+\.\w+)/gi;
const ERROR_MESSAGE_PATTERN = /(?:Error|Exception|Warning):\s*([^\n]+)/gi;
const TYPE_ERROR_PATTERN =
  /(?:Type|Reference|Syntax|Range|URI)Error:\s*([^\n]+)/gi;
const ERROR_CODE_PATTERN = /E[A-Z]+:\s*([^\n]+)/gi;
const QUOTED_STRING_PATTERN = /['"`]([^'"`]+)['"`]/g;
const PASCAL_CASE_PATTERN = /\b([A-Z][a-zA-Z0-9]{2,})\b/g;

/**
 * Detected pattern that could become a skill.
 */
export interface PatternDetection {
  id: string;
  problem: string;
  solution: string;
  confidence: number; // 0-100 skill-worthiness score
  occurrences: number; // How many times pattern seen
  firstSeen: number; // Timestamp
  lastSeen: number; // Timestamp
  suggestedTriggers: string[]; // Auto-generated triggers
  suggestedTags: string[]; // Auto-generated tags
}

/**
 * Auto-learner session state.
 */
export interface AutoLearnerState {
  sessionId: string;
  patterns: Map<string, PatternDetection>;
  suggestedSkills: PatternDetection[]; // Ready to suggest to user
}

/**
 * Default threshold for suggesting skills.
 */
const DEFAULT_SUGGESTION_THRESHOLD = 70;

/**
 * Keywords that boost skill-worthiness score.
 */
const HIGH_VALUE_KEYWORDS = [
  "error",
  "failed",
  "crash",
  "bug",
  "fix",
  "workaround",
  "solution",
  "resolved",
];

/**
 * Common file extensions that indicate technical content.
 */
const TECHNICAL_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
];

/**
 * Generic patterns that lower skill-worthiness.
 */
const GENERIC_PATTERNS = [
  "try again",
  "restart",
  "check the docs",
  "google it",
  "look at the error",
];

/**
 * Initialize state for a session.
 */
export function initAutoLearner(sessionId: string): AutoLearnerState {
  return {
    sessionId,
    patterns: new Map(),
    suggestedSkills: [],
  };
}

/**
 * Generate a content hash for deduplication.
 */
function generateContentHash(problem: string, solution: string): string {
  const normalized = `${problem.toLowerCase().trim()}::${solution.toLowerCase().trim()}`;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Extract file paths from text.
 */
function extractFilePaths(text: string): string[] {
  const paths: string[] = [];

  // Match common path patterns
  const pathPatterns = [
    ABSOLUTE_PATH_PATTERN,
    RELATIVE_PATH_PATTERN,
    SIMPLE_PATH_PATTERN,
  ];

  for (const pattern of pathPatterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      if (match[1]) {
        paths.push(match[1].trim());
      }
    }
  }

  return [...new Set(paths)];
}

/**
 * Extract error messages from text.
 */
function extractErrorMessages(text: string): string[] {
  const errors: string[] = [];

  // Match common error patterns
  const errorPatterns = [
    ERROR_MESSAGE_PATTERN,
    TYPE_ERROR_PATTERN,
    ERROR_CODE_PATTERN,
  ];

  for (const pattern of errorPatterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      if (match[1]) {
        errors.push(match[1].trim());
      }
    }
  }

  return [...new Set(errors)];
}

/**
 * Extract key technical terms from text.
 */
function extractKeyTerms(text: string): string[] {
  const terms: string[] = [];

  // Extract quoted strings (likely command names or technical terms)
  const quotedMatches = text.matchAll(QUOTED_STRING_PATTERN);
  for (const match of quotedMatches) {
    if (match[1] && match[1].length > 2 && match[1].length < 30) {
      terms.push(match[1]);
    }
  }

  // Extract capitalized technical terms (like React, TypeScript, etc.)
  const capitalizedMatches = text.matchAll(PASCAL_CASE_PATTERN);
  for (const match of capitalizedMatches) {
    if (match[1] && !["The", "This", "That", "There"].includes(match[1])) {
      terms.push(match[1]);
    }
  }

  return [...new Set(terms)];
}

/**
 * Extract triggers from problem and solution text.
 */
export function extractTriggers(problem: string, solution: string): string[] {
  const triggers = new Set<string>();

  // Add error messages as triggers
  const errors = extractErrorMessages(problem);
  for (const error of errors.slice(0, 3)) {
    // Limit to 3 errors
    // Take first 5 words of error message
    const words = error.split(/\s+/).slice(0, 5).join(" ");
    if (words.length > 5) {
      triggers.add(words);
    }
  }

  // Add file paths (basenames only)
  const paths = extractFilePaths(problem + " " + solution);
  for (const path of paths.slice(0, 3)) {
    // Limit to 3 paths
    const basename = path.split(/[/\\]/).pop();
    if (basename && basename.length > 3) {
      triggers.add(basename);
    }
  }

  // Add key terms
  const terms = extractKeyTerms(problem + " " + solution);
  for (const term of terms.slice(0, 5)) {
    // Limit to 5 terms
    if (term.length > 3 && term.length < 30) {
      triggers.add(term.toLowerCase());
    }
  }

  // Add high-value keywords if present
  const combinedText = (problem + " " + solution).toLowerCase();
  for (const keyword of HIGH_VALUE_KEYWORDS) {
    if (combinedText.includes(keyword)) {
      triggers.add(keyword);
    }
  }

  return Array.from(triggers).slice(0, 10); // Max 10 triggers
}

/**
 * Generate tags based on content analysis.
 */
function generateTags(problem: string, solution: string): string[] {
  const tags = new Set<string>();
  const combinedText = (problem + " " + solution).toLowerCase();

  // Language/framework detection
  const langMap: Record<string, string> = {
    typescript: "typescript",
    javascript: "javascript",
    python: "python",
    react: "react",
    vue: "vue",
    angular: "angular",
    node: "nodejs",
    "node.js": "nodejs",
    rust: "rust",
    go: "golang",
  };

  for (const [keyword, tag] of Object.entries(langMap)) {
    if (combinedText.includes(keyword)) {
      tags.add(tag);
    }
  }

  // Problem category detection
  if (combinedText.includes("error") || combinedText.includes("bug")) {
    tags.add("debugging");
  }
  if (combinedText.includes("test") || combinedText.includes("spec")) {
    tags.add("testing");
  }
  if (combinedText.includes("build") || combinedText.includes("compile")) {
    tags.add("build");
  }
  if (combinedText.includes("performance") || combinedText.includes("slow")) {
    tags.add("performance");
  }
  if (
    combinedText.includes("security") ||
    combinedText.includes("vulnerability")
  ) {
    tags.add("security");
  }

  // File type detection
  const paths = extractFilePaths(problem + " " + solution);
  for (const path of paths) {
    for (const ext of TECHNICAL_EXTENSIONS) {
      if (path.endsWith(ext)) {
        tags.add("code");
        break;
      }
    }
  }

  return Array.from(tags).slice(0, 5); // Max 5 tags
}

/**
 * Calculate skill-worthiness score (0-100).
 */
export function calculateSkillWorthiness(pattern: PatternDetection): number {
  let score = 50; // Base score

  const combinedText = (pattern.problem + " " + pattern.solution).toLowerCase();

  // Boost for specificity
  const hasFilePaths =
    extractFilePaths(pattern.problem + " " + pattern.solution).length > 0;
  if (hasFilePaths) {
    score += 15;
  }

  const hasErrorMessages = extractErrorMessages(pattern.problem).length > 0;
  if (hasErrorMessages) {
    score += 15;
  }

  // Boost for high-value keywords
  let keywordCount = 0;
  for (const keyword of HIGH_VALUE_KEYWORDS) {
    if (combinedText.includes(keyword)) {
      keywordCount++;
    }
  }
  score += Math.min(keywordCount * 5, 20); // Max 20 points from keywords

  // Boost for multiple occurrences
  if (pattern.occurrences > 1) {
    score += Math.min((pattern.occurrences - 1) * 10, 30); // Max 30 points
  }

  // Boost for detailed solution (longer is better, to a point)
  const solutionLength = pattern.solution.length;
  if (solutionLength > 100) {
    score += 10;
  }
  if (solutionLength > 300) {
    score += 10;
  }

  // Penalty for generic patterns
  for (const generic of GENERIC_PATTERNS) {
    if (combinedText.includes(generic)) {
      score -= 15;
    }
  }

  // Penalty for very short content
  if (pattern.problem.length < 20 || pattern.solution.length < 30) {
    score -= 20;
  }

  // Penalty for missing triggers
  if (pattern.suggestedTriggers.length === 0) {
    score -= 25;
  }

  // Ensure score is in valid range
  return Math.max(0, Math.min(100, score));
}

/**
 * Record a problem-solution pair.
 * Returns the pattern if it's new or updated, null if ignored.
 */
export function recordPattern(
  state: AutoLearnerState,
  problem: string,
  solution: string,
): PatternDetection | null {
  // Basic validation
  if (!problem || !solution) {
    return null;
  }

  const trimmedProblem = problem.trim();
  const trimmedSolution = solution.trim();

  if (trimmedProblem.length < 10 || trimmedSolution.length < 20) {
    return null;
  }

  // Generate hash for deduplication
  const hash = generateContentHash(trimmedProblem, trimmedSolution);

  // Check if pattern already exists
  const existingPattern = state.patterns.get(hash);

  if (existingPattern) {
    // Update existing pattern
    existingPattern.occurrences++;
    existingPattern.lastSeen = Date.now();
    existingPattern.confidence = calculateSkillWorthiness(existingPattern);

    // Re-evaluate for suggestion
    if (
      existingPattern.confidence >= DEFAULT_SUGGESTION_THRESHOLD &&
      !state.suggestedSkills.find((p) => p.id === existingPattern.id)
    ) {
      state.suggestedSkills.push(existingPattern);
    }

    return existingPattern;
  }

  // Create new pattern
  const triggers = extractTriggers(trimmedProblem, trimmedSolution);
  const tags = generateTags(trimmedProblem, trimmedSolution);

  const newPattern: PatternDetection = {
    id: hash,
    problem: trimmedProblem,
    solution: trimmedSolution,
    occurrences: 1,
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    suggestedTriggers: triggers,
    suggestedTags: tags,
    confidence: 0, // Will be calculated below
  };

  // Calculate initial confidence
  newPattern.confidence = calculateSkillWorthiness(newPattern);

  // Store pattern
  state.patterns.set(hash, newPattern);

  // Add to suggestions if worthy
  if (newPattern.confidence >= DEFAULT_SUGGESTION_THRESHOLD) {
    state.suggestedSkills.push(newPattern);
  }

  return newPattern;
}

/**
 * Get ready-to-suggest skills (confidence above threshold).
 */
export function getSuggestedSkills(
  state: AutoLearnerState,
  threshold: number = DEFAULT_SUGGESTION_THRESHOLD,
): PatternDetection[] {
  return state.suggestedSkills
    .filter((p) => p.confidence >= threshold)
    .sort((a, b) => b.confidence - a.confidence);
}

/**
 * Convert pattern to skill metadata (partial).
 */
export function patternToSkillMetadata(
  pattern: PatternDetection,
): Partial<SkillMetadata> {
  // Generate a descriptive name from the problem
  const problemWords = pattern.problem.split(/\s+/).slice(0, 6).join(" ");
  const name =
    problemWords.length > 50 ? problemWords.slice(0, 50) + "..." : problemWords;

  return {
    name,
    description: pattern.problem.slice(0, 200),
    triggers: pattern.suggestedTriggers,
    tags: pattern.suggestedTags,
    source: "extracted" as const,
    quality: pattern.confidence,
    usageCount: 0,
  };
}
