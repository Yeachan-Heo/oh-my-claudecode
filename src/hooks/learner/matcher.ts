// Smart skill matcher with fuzzy matching, pattern detection, and confidence scoring
// No external dependencies - uses built-in only

export interface MatchResult {
  skillId: string;
  confidence: number; // 0-100
  matchedTriggers: string[];
  matchType: 'exact' | 'fuzzy' | 'pattern' | 'semantic';
  context: MatchContext;
}

export interface MatchContext {
  detectedErrors: string[]; // e.g., ["TypeError", "ENOENT"]
  detectedFiles: string[]; // e.g., ["src/foo.ts"]
  detectedPatterns: string[]; // e.g., ["async/await", "promise"]
}

interface SkillInput {
  id: string;
  triggers: string[];
  tags?: string[];
}

interface MatchOptions {
  threshold?: number; // Minimum confidence score (default: 30)
  maxResults?: number; // Maximum results to return (default: 10)
}

/**
 * Match skills against a prompt using multiple matching strategies
 */
export function matchSkills(
  prompt: string,
  skills: SkillInput[],
  options: MatchOptions = {}
): MatchResult[] {
  const { threshold = 30, maxResults = 10 } = options;
  const trimmedPrompt = prompt.trim();

  // Early return for empty or whitespace-only prompts
  if (!trimmedPrompt) {
    return [];
  }

  const normalizedPrompt = trimmedPrompt.toLowerCase();
  const context = extractContext(prompt);
  const results: MatchResult[] = [];

  for (const skill of skills) {
    const allTriggers = [...skill.triggers, ...(skill.tags || [])];
    const matches: Array<{
      trigger: string;
      score: number;
      type: MatchResult['matchType'];
    }> = [];

    for (const trigger of allTriggers) {
      const normalizedTrigger = trigger.toLowerCase();

      // 1. Exact match (highest confidence)
      if (normalizedPrompt.includes(normalizedTrigger)) {
        matches.push({ trigger, score: 100, type: 'exact' });
        continue;
      }

      // 2. Pattern match (regex/glob-like patterns)
      const patternScore = patternMatch(normalizedPrompt, normalizedTrigger);
      if (patternScore > 0) {
        matches.push({ trigger, score: patternScore, type: 'pattern' });
        continue;
      }

      // 3. Fuzzy match (Levenshtein distance)
      const fuzzyScore = fuzzyMatch(normalizedPrompt, normalizedTrigger);
      if (fuzzyScore >= 60) {
        matches.push({ trigger, score: fuzzyScore, type: 'fuzzy' });
      }
    }

    if (matches.length > 0) {
      // Calculate overall confidence based on best matches
      const bestMatch = matches.reduce((a, b) => (a.score > b.score ? a : b));
      const avgScore =
        matches.reduce((sum, m) => sum + m.score, 0) / matches.length;
      const confidence = Math.round(bestMatch.score * 0.7 + avgScore * 0.3);

      if (confidence >= threshold) {
        results.push({
          skillId: skill.id,
          confidence,
          matchedTriggers: matches.map((m) => m.trigger),
          matchType: bestMatch.type,
          context,
        });
      }
    }
  }

  // Sort by confidence (descending) and limit results
  return results
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, maxResults);
}

/**
 * Fuzzy string matching using Levenshtein distance
 * Returns confidence score 0-100
 */
export function fuzzyMatch(text: string, pattern: string): number {
  if (!text.trim() || !pattern.trim()) return 0;

  // Check if pattern is a substring first (partial match bonus)
  const words = text.split(/\s+/).filter(w => w.length > 0);
  for (const word of words) {
    if (word === pattern) return 100;
    if (word.length > 0 && pattern.length > 0 &&
        (word.includes(pattern) || pattern.includes(word))) {
      return 80;
    }
  }

  // Calculate Levenshtein distance for each word
  let bestScore = 0;
  for (const word of words) {
    const distance = levenshteinDistance(word, pattern);
    const maxLen = Math.max(word.length, pattern.length);
    const similarity = maxLen > 0 ? ((maxLen - distance) / maxLen) * 100 : 0;
    bestScore = Math.max(bestScore, similarity);
  }

  return Math.round(bestScore);
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1: string, str2: string): number {
  const m = str1.length;
  const n = str2.length;

  // Create distance matrix
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  // Initialize first row and column
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  // Fill the matrix
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] =
          1 +
          Math.min(
            dp[i - 1][j], // deletion
            dp[i][j - 1], // insertion
            dp[i - 1][j - 1] // substitution
          );
      }
    }
  }

  return dp[m][n];
}

/**
 * Cache for compiled trigger regexes to avoid recompilation on every call.
 * Key: original pattern string, Value: compiled RegExp or null (invalid).
 */
const triggerRegexCache = new Map<string, { regex: RegExp; score: number } | null>();

/**
 * Pattern-based matching for regex-like triggers
 * Returns confidence score 0-100
 */
function patternMatch(text: string, pattern: string): number {
  let cached = triggerRegexCache.get(pattern);
  if (cached === undefined) {
    cached = compileTriggerRegex(pattern);
    triggerRegexCache.set(pattern, cached);
  }
  if (cached) {
    cached.regex.lastIndex = 0; // Reset stateful regex (g/y flags)
  }
  if (cached && cached.regex.test(text)) {
    return cached.score;
  }
  return 0;
}

function compileTriggerRegex(pattern: string): { regex: RegExp; score: number } | null {
  // Check for glob-like patterns
  if (pattern.includes('*')) {
    const regexPattern = pattern.replace(/\*/g, '.*');
    try {
      return { regex: new RegExp(regexPattern, 'i'), score: 85 };
    } catch {
      return null;
    }
  }

  // Check for regex-like patterns (starts with / and has / somewhere after, with optional flags)
  // Supports: /pattern/ or /pattern/flags (e.g., /error/i)
  const regexMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
  if (regexMatch) {
    try {
      const [, regexPattern, flags] = regexMatch;
      return { regex: new RegExp(regexPattern, flags || 'i'), score: 90 };
    } catch {
      return null;
    }
  }

  return null;
}

// Pre-compiled context detection patterns (module-level to avoid reallocation per call)
const ERROR_PATTERNS = [
  /\b(error|exception|failed|failure|crash|bug)\b/gi,
  /\b([A-Z][a-z]+Error)\b/g, // TypeError, ReferenceError, etc.
  /\b(ENOENT|EACCES|ECONNREFUSED)\b/g, // Node.js error codes
  /at\s+.*\(.*:\d+:\d+\)/g, // Stack trace lines
];

const FILE_PATTERNS = [
  /\b([a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.[a-z]{2,4}\b/g, // Relative paths
  /\b\/[a-zA-Z0-9_\/-]+\.[a-z]{2,4}\b/g, // Absolute paths
  /\bsrc\/[a-zA-Z0-9_\/-]+/g, // src/ paths
];

const CODE_PATTERNS = [
  { pattern: /\basync\b.*\bawait\b/gi, name: 'async/await' },
  { pattern: /\bpromise\b/gi, name: 'promise' },
  { pattern: /\bcallback\b/gi, name: 'callback' },
  { pattern: /\bregex\b|\bregular expression\b/gi, name: 'regex' },
  { pattern: /\bapi\b/gi, name: 'api' },
  { pattern: /\btest\b.*\b(unit|integration|e2e)\b/gi, name: 'testing' },
  { pattern: /\b(typescript|ts)\b/gi, name: 'typescript' },
  { pattern: /\b(javascript|js)\b/gi, name: 'javascript' },
  { pattern: /\breact\b/gi, name: 'react' },
  { pattern: /\bgit\b/gi, name: 'git' },
];

/**
 * Extract contextual information from the prompt
 */
export function extractContext(prompt: string): MatchContext {
  const detectedErrors: string[] = [];
  const detectedFiles: string[] = [];
  const detectedPatterns: string[] = [];

  // Error detection
  for (const pattern of ERROR_PATTERNS) {
    pattern.lastIndex = 0; // Reset stateful regex
    const matches = prompt.match(pattern);
    if (matches) {
      detectedErrors.push(
        ...matches.map((m) => m.trim()).filter((m) => m.length > 0)
      );
    }
  }

  // File detection
  for (const pattern of FILE_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = prompt.match(pattern);
    if (matches) {
      detectedFiles.push(
        ...matches.map((m) => m.trim()).filter((m) => m.length > 0)
      );
    }
  }

  // Pattern detection
  for (const { pattern, name } of CODE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(prompt)) {
      detectedPatterns.push(name);
    }
  }

  // Deduplicate and normalize
  return {
    detectedErrors: [...new Set(detectedErrors)],
    detectedFiles: [...new Set(detectedFiles)],
    detectedPatterns: [...new Set(detectedPatterns)],
  };
}

/**
 * Calculate confidence score based on match metrics
 */
export function calculateConfidence(
  matches: number,
  total: number,
  matchType: string
): number {
  if (total === 0) return 0;

  const matchRatio = matches / total;
  const baseScore = matchRatio * 100;

  // Apply multiplier based on match type
  const multipliers: Record<string, number> = {
    exact: 1.0,
    pattern: 0.9,
    fuzzy: 0.7,
    semantic: 0.8,
  };

  const multiplier = multipliers[matchType] || 0.5;
  const confidence = Math.round(baseScore * multiplier);

  return Math.min(100, Math.max(0, confidence));
}
