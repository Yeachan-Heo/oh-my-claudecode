// Smart skill matcher with fuzzy matching, pattern detection, and confidence scoring
// No external dependencies - uses built-in only
/**
 * Match skills against a prompt using multiple matching strategies
 */
export function matchSkills(prompt, skills, options = {}) {
    const { threshold = 30, maxResults = 10 } = options;
    const trimmedPrompt = prompt.trim();
    // Early return for empty or whitespace-only prompts
    if (!trimmedPrompt) {
        return [];
    }
    const normalizedPrompt = trimmedPrompt.toLowerCase();
    const context = extractContext(prompt);
    const results = [];
    for (const skill of skills) {
        const allTriggers = [...skill.triggers, ...(skill.tags || [])];
        const matches = [];
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
            const avgScore = matches.reduce((sum, m) => sum + m.score, 0) / matches.length;
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
export function fuzzyMatch(text, pattern) {
    if (!text.trim() || !pattern.trim())
        return 0;
    // Check if pattern is a substring first (partial match bonus)
    const words = text.split(/\s+/).filter(w => w.length > 0);
    for (const word of words) {
        if (word === pattern)
            return 100;
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
function levenshteinDistance(str1, str2) {
    const m = str1.length;
    const n = str2.length;
    // Create distance matrix
    const dp = Array(m + 1)
        .fill(null)
        .map(() => Array(n + 1).fill(0));
    // Initialize first row and column
    for (let i = 0; i <= m; i++)
        dp[i][0] = i;
    for (let j = 0; j <= n; j++)
        dp[0][j] = j;
    // Fill the matrix
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (str1[i - 1] === str2[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1];
            }
            else {
                dp[i][j] =
                    1 +
                        Math.min(dp[i - 1][j], // deletion
                        dp[i][j - 1], // insertion
                        dp[i - 1][j - 1] // substitution
                        );
            }
        }
    }
    return dp[m][n];
}
/**
 * Pattern-based matching for regex-like triggers
 * Returns confidence score 0-100
 */
function patternMatch(text, pattern) {
    // Check for glob-like patterns
    if (pattern.includes('*')) {
        const regexPattern = pattern.replace(/\*/g, '.*');
        try {
            const regex = new RegExp(regexPattern, 'i');
            if (regex.test(text)) {
                return 85; // High confidence for pattern match
            }
        }
        catch {
            // Invalid regex, skip
        }
    }
    // Check for regex-like patterns (starts with / and has / somewhere after, with optional flags)
    // Supports: /pattern/ or /pattern/flags (e.g., /error/i)
    const regexMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
    if (regexMatch) {
        try {
            const [, regexPattern, flags] = regexMatch;
            const regex = new RegExp(regexPattern, flags || 'i');
            if (regex.test(text)) {
                return 90; // Very high confidence for explicit regex match
            }
        }
        catch {
            // Invalid regex, skip
        }
    }
    return 0;
}
/**
 * Extract contextual information from the prompt
 */
export function extractContext(prompt) {
    const detectedErrors = [];
    const detectedFiles = [];
    const detectedPatterns = [];
    // Error detection
    const errorPatterns = [
        /\b(error|exception|failed|failure|crash|bug)\b/gi,
        /\b([A-Z][a-z]+Error)\b/g, // TypeError, ReferenceError, etc.
        /\b(ENOENT|EACCES|ECONNREFUSED)\b/g, // Node.js error codes
        /at\s+.*\(.*:\d+:\d+\)/g, // Stack trace lines
    ];
    for (const pattern of errorPatterns) {
        const matches = prompt.match(pattern);
        if (matches) {
            detectedErrors.push(...matches.map((m) => m.trim()).filter((m) => m.length > 0));
        }
    }
    // File detection
    const filePatterns = [
        /\b([a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.[a-z]{2,4}\b/g, // Relative paths
        /\b\/[a-zA-Z0-9_\/-]+\.[a-z]{2,4}\b/g, // Absolute paths
        /\bsrc\/[a-zA-Z0-9_\/-]+/g, // src/ paths
    ];
    for (const pattern of filePatterns) {
        const matches = prompt.match(pattern);
        if (matches) {
            detectedFiles.push(...matches.map((m) => m.trim()).filter((m) => m.length > 0));
        }
    }
    // Pattern detection
    const codePatterns = [
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
    for (const { pattern, name } of codePatterns) {
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
export function calculateConfidence(matches, total, matchType) {
    if (total === 0)
        return 0;
    const matchRatio = matches / total;
    const baseScore = matchRatio * 100;
    // Apply multiplier based on match type
    const multipliers = {
        exact: 1.0,
        pattern: 0.9,
        fuzzy: 0.7,
        semantic: 0.8,
    };
    const multiplier = multipliers[matchType] || 0.5;
    const confidence = Math.round(baseScore * multiplier);
    return Math.min(100, Math.max(0, confidence));
}
//# sourceMappingURL=matcher.js.map