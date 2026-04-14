/**
 * Keyword Detector Hook
 *
 * Detects magic keywords in user prompts and returns the appropriate
 * mode message to inject into context.
 *
 * Ported from oh-my-opencode's keyword-detector hook.
 */

import {
  classifyTaskSize,
  isHeavyMode,
  type TaskSizeResult,
  type TaskSizeThresholds,
} from '../task-size-detector/index.js';

export type KeywordType =
  | 'cancel'      // Priority 1
  | 'ralph'       // Priority 2
  | 'autopilot'   // Priority 3
  | 'team'        // Priority 4.5 (team mode)
  | 'ultrawork'   // Priority 5
  | 'ralplan'     // Priority 8
  | 'tdd'         // Priority 9
  | 'code-review' // Priority 10
  | 'security-review' // Priority 10.5
  | 'ultrathink'  // Priority 11
  | 'deepsearch'  // Priority 12
  | 'deep-interview' // Priority 13.5
  | 'analyze'     // Priority 13
  | 'codex'       // Priority 15
  | 'gemini'      // Priority 16
  | 'ccg';        // Priority 8.5 (Claude-Codex-Gemini orchestration)

export interface DetectedKeyword {
  type: KeywordType;
  keyword: string;
  position: number;
}

/**
 * Keyword patterns for each mode
 */
const KEYWORD_PATTERNS: Record<KeywordType, RegExp> = {
  cancel: /\b(cancelomc|stopomc)\b/i,
  ralph: /\b(ralph)\b(?!-)|(랄프)(?!로렌)/i,
  autopilot: /\b(autopilot|auto[\s-]?pilot|fullsend|full\s+auto)\b|(오토파일럿)/i,
  ultrawork: /\b(ultrawork|ulw)\b|(울트라워크)/i,
  // Team keyword detection disabled — team mode is now explicit-only via /team skill.
  // This prevents infinite spawning when Claude workers receive prompts containing "team".
  team: /(?!x)x/,  // never-match placeholder (type system requires the key)
  ralplan: /\b(ralplan)\b|(랄플랜)/i,
  tdd: /\b(tdd)\b|\btest\s+first\b|(테스트\s?퍼스트)/i,
  'code-review': /\b(code\s+review|review\s+code)\b|(코드\s?리뷰)(?!어)/i,
  'security-review': /\b(security\s+review|review\s+security)\b|(보안\s?리뷰)(?!어)/i,
  ultrathink: /\b(ultrathink)\b|(울트라씽크)/i,
  deepsearch: /\b(deepsearch)\b|\bsearch\s+the\s+codebase\b|\bfind\s+in\s+(the\s+)?codebase\b|(딥\s?서치)/i,
  analyze: /\b(deep[\s-]?analyze|deepanalyze)\b|(딥\s?분석)/i,
  'deep-interview': /\b(deep[\s-]interview|ouroboros)\b|(딥인터뷰)/i,
  ccg: /\b(ccg|claude-codex-gemini)\b|(씨씨지)/i,
  codex: /\b(ask|use|delegate\s+to)\s+(codex|gpt)\b/i,
  gemini: /\b(ask|use|delegate\s+to)\s+gemini\b/i
};

/**
 * Priority order for keyword detection
 */
const KEYWORD_PRIORITY: KeywordType[] = [
  'cancel', 'ralph', 'autopilot', 'team', 'ultrawork',
  'ccg', 'ralplan', 'tdd', 'code-review', 'security-review',
  'ultrathink', 'deepsearch', 'analyze', 'deep-interview', 'codex', 'gemini'
];

/**
 * Remove code blocks from text to prevent false positives
 * Handles both fenced code blocks and inline code
 */
export function removeCodeBlocks(text: string): string {
  // Remove fenced code blocks (``` or ~~~)
  let result = text.replace(/```[\s\S]*?```/g, '');
  result = result.replace(/~~~[\s\S]*?~~~/g, '');

  // Remove inline code (single backticks)
  result = result.replace(/`[^`]+`/g, '');

  return result;
}


/**
 * Regex matching non-Latin script characters for prompt translation detection.
 * Uses Unicode script ranges (not raw non-ASCII) to avoid false positives on emoji and accented Latin.
 * Covers: CJK (Japanese/Chinese), Korean, Cyrillic, Arabic, Devanagari, Thai, Myanmar.
 */
export const NON_LATIN_SCRIPT_PATTERN =
  // eslint-disable-next-line no-misleading-character-class -- Intentional: detecting script presence, not matching grapheme clusters
  /[\u3000-\u9FFF\uAC00-\uD7AF\u0400-\u04FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u1000-\u109F]/u;

/**
* Sanitize text for keyword detection by removing structural noise.
 * Strips XML tags, URLs, file paths, and code blocks.
 */
export function sanitizeForKeywordDetection(text: string): string {
  // Remove HTML/markdown comments first so keywords inside comments cannot trigger modes
  let result = text.replace(/<!--[\s\S]*?-->/g, '');
  // Remove XML tag blocks (opening + content + closing; tag names must match)
  result = result.replace(/<(\w[\w-]*)[\s>][\s\S]*?<\/\1>/g, '');
  // Remove self-closing XML tags
  result = result.replace(/<\w[\w-]*(?:\s[^>]*)?\s*\/>/g, '');
  // Remove URLs
  result = result.replace(/https?:\/\/\S+/g, '');
  // Remove block quotes and markdown table rows - they are typically reference content
  result = result.replace(/^\s*>\s.*$/gm, '');
  result = result.replace(/^\s*\|(?:[^|\n]*\|){2,}\s*$/gm, '');
  result = result.replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|){1,}\s*$/gm, '');
  // Remove file paths — requires leading / or ./ or multi-segment dir/file.ext
  result = result.replace(/(^|[\s"'`(])(?:\.?\/(?:[\w.-]+\/)*[\w.-]+|(?:[\w.-]+\/)+[\w.-]+\.\w+)/gm, '$1');
  // Remove code blocks (fenced and inline)
  result = removeCodeBlocks(result);
  return result;
}

const INFORMATIONAL_INTENT_PATTERNS: RegExp[] = [
  /\b(?:what(?:'s|\s+is)|what\s+are|how\s+(?:to|do\s+i)\s+use|explain|explanation|tell\s+me\s+about|describe)\b/i,
  /(?:뭐야|뭔데|무엇(?:이야|인가요)?|어떻게|설명(?!서\s*(?:작성|만들|생성|추가|업데이트|수정|편집|쓰))|사용법|알려\s?줘|알려줄래|소개해?\s?줘|소개\s*부탁|설명해\s?줘|뭐가\s*달라|어떤\s*기능|기능\s*(?:알려|설명|뭐)|방법\s*(?:알려|설명|뭐))/u,
  /(?:とは|って何|使い方|説明)/u,
  /(?:什么是|怎(?:么|樣)用|如何使用|解释|說明|说明)/u,
];
const INFORMATIONAL_CONTEXT_WINDOW = 80;
const QUOTED_SPAN_PATTERN =
  /"[^"\n]{1,400}"|'[^'\n]{1,400}'|“[^”\n]{1,400}”|‘[^’\n]{1,400}’/g;
const REFERENCE_META_PATTERNS: RegExp[] = [
  /\b(?:vs\.?|versus|compared\s+to|comparison|compare|article|blog\s+post|documentation|docs?|reference)\b/i,
  /(?:비교|차이|설명|정리|문서|자료|가이드|이\s*(?:글|비교|문서)는|블로그)/u,
  /\b(?:this\s+(?:article|comparison|guide|documentation|doc)|quoted|quote(?:d)?)\b/i,
];
const REFERENCE_EXPLANATION_PATTERNS: RegExp[] = [
  /(?:^|\n)\s*(?:결론|특징|예시|요약|장점|단점|설명)\s*[:：]/u,
  /\b(?:summary|conclusion|key\s+points?|example|examples|pros|cons|overview)\s*:/i,
  /[^\n]{1,80}=\s*["“]/,
  /[→⇒]/,
];
const QUESTION_FOLLOWUP_PATTERNS: RegExp[] = [
  /\b(?:how\s+many|how\s+much|why|what\s+happened|what\s+went\s+wrong|token\s+budget|cost|pricing)\b/i,
  /(?:왜|얼마|몇\s*번|몇번|토큰|가격|비용|질문)/u,
];
const MODE_REFERENCE_PATTERN =
  /\b(?:ralph|autopilot|auto[\s-]?pilot|ultrawork|ulw|ralplan|ultrathink|deepsearch|deep[\s-]?analyze|deepanalyze|deep[\s-]interview|ouroboros|ccg|claude-codex-gemini|deerflow)\b/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getLineBounds(text: string, position: number): { start: number; end: number } {
  const start = text.lastIndexOf('\n', Math.max(0, position - 1)) + 1;
  const nextNewline = text.indexOf('\n', position);
  const end = nextNewline === -1 ? text.length : nextNewline;
  return { start, end };
}

function isWithinQuotedSpan(text: string, position: number): boolean {
  for (const match of text.matchAll(QUOTED_SPAN_PATTERN)) {
    if (match.index === undefined) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (position >= start && position < end) {
      return true;
    }
  }
  return false;
}

function stripQuotedSpans(text: string): string {
  return text.replace(QUOTED_SPAN_PATTERN, ' ');
}

function countDistinctModeReferences(text: string): number {
  const matches = text.match(MODE_REFERENCE_PATTERN) ?? [];
  const normalized = new Set(
    matches.map((match) => match.toLowerCase().replace(/\s+/g, '').replace(/-/g, '')),
  );
  return normalized.size;
}

function looksLikeReferenceContent(text: string): boolean {
  const hasReferenceMeta = REFERENCE_META_PATTERNS.some((pattern) => pattern.test(text));
  const hasExplanationShape = REFERENCE_EXPLANATION_PATTERNS.some((pattern) => pattern.test(text));
  const hasAnyModeMention = countDistinctModeReferences(text) >= 1;
  const hasMultipleModeMentions = countDistinctModeReferences(text) >= 2;
  const hasQuestionOutsideQuotes = QUESTION_FOLLOWUP_PATTERNS.some((pattern) =>
    pattern.test(stripQuotedSpans(text)),
  );

  return (
    (hasReferenceMeta && (hasExplanationShape || hasAnyModeMention || hasQuestionOutsideQuotes)) ||
    (hasExplanationShape && (hasMultipleModeMentions || hasQuestionOutsideQuotes)) ||
    (hasMultipleModeMentions && hasQuestionOutsideQuotes)
  );
}

function hasActivationIntentNearKeyword(context: string, keyword: string): boolean {
  const escaped = escapeRegExp(keyword.trim());
  if (!escaped) return false;

  // Help-question phrasing like "How do I use autopilot?" should not be
  // treated as activation intent.
  const helpQuestionPatterns = [
    new RegExp(`\\bhow\\s+do\\s+i\\s+use\\b[^\\n]{0,40}\\b${escaped}\\b`, 'i'),
    new RegExp(`\\bwhat(?:'s|\\s+is)\\b[^\\n]{0,40}\\b${escaped}\\b[^\\n]{0,40}\\bhow\\s+to\\s+use\\b`, 'i'),
  ];
  if (helpQuestionPatterns.some((pattern) => pattern.test(context))) {
    return false;
  }

  const patterns = [
    new RegExp(`\\b(?:use|run|start|enable|activate|invoke|trigger|launch)\\b[^\\n]{0,28}\\b${escaped}\\b`, 'i'),
    new RegExp(`\\b(?:fix|debug|investigate|resolve|handle|patch|address)\\b[^\\n]{0,28}\\b(?:issue|bug|problem|error)\\b[^\\n]{0,12}\\b(?:with|in)\\s+\\b${escaped}\\b`, 'i'),

  ];

  return patterns.some((pattern) => pattern.test(context));
}

function hasDirectInvocationPrefix(text: string, position: number): boolean {
  const prefix = text.slice(0, position);
  return /^\s*(?:[$/!]\s*|force:\s*|oh-my-(?:claudecode|codex):\s*)?$/i.test(prefix);
}

function hasExplicitInvocationContext(
  text: string,
  position: number,
  keywordLength: number,
  keywordText: string,
): boolean {
  if (hasDirectInvocationPrefix(text, position)) {
    return true;
  }

  const start = Math.max(0, position - INFORMATIONAL_CONTEXT_WINDOW);
  const end = Math.min(text.length, position + keywordLength + INFORMATIONAL_CONTEXT_WINDOW);
  const context = text.slice(start, end);
  if (hasActivationIntentNearKeyword(context, keywordText)) {
    return true;
  }

  const escaped = escapeRegExp(keywordText.trim());
  if (!escaped) {
    return false;
  }

  const conversationalInvocationPatterns = [
    new RegExp(`\\bplease\\s+${escaped}\\b`, 'i'),
    new RegExp(`\\blet['’]?s\\s+${escaped}\\b`, 'i'),
    new RegExp(`\\bi\\s+(?:want|need|would\\s+like)\\s+(?:a|an)\\s+${escaped}\\b`, 'i'),
    new RegExp(`\\b(?:can|could|would|will)\\s+you\\s+${escaped}\\b`, 'i'),
  ];

  return conversationalInvocationPatterns.some((pattern) => pattern.test(context));
}

function hasDiagnosticIntentNearKeyword(context: string, keyword: string): boolean {
  const escaped = escapeRegExp(keyword.trim());
  if (!escaped) return false;

  const patterns = [
    new RegExp(`\\b${escaped}\\b[^\\n]{0,48}\\b(?:keeps?\\s+(?:looping|re-?running)|has\\s+(?:a\\s+)?(?:bug|issue|problem|error)|is\\s+(?:stuck|broken|failing)|loop(?:ing)?)\\b`, 'i'),
    new RegExp(`\\b(?:bug|issue|problem|error)\\b[^\\n]{0,16}\\b(?:with|in)\\s+\\b${escaped}\\b`, 'i'),
    new RegExp(`${escaped}.{0,14}(?:자꾸|계속).{0,14}(?:재실행|반복|루프|멈추)`, 'u'),
  ];

  return patterns.some((pattern) => pattern.test(context));
}

function isInformationalKeywordContext(text: string, position: number, keywordLength: number, keywordText?: string): boolean {
  const start = Math.max(0, position - INFORMATIONAL_CONTEXT_WINDOW);
  const end = Math.min(text.length, position + keywordLength + INFORMATIONAL_CONTEXT_WINDOW);
  const context = text.slice(start, end);
  const hasInformationalIntent = INFORMATIONAL_INTENT_PATTERNS.some((pattern) => pattern.test(context));
  const hasStrongHelpQueryIntent = /\?|？|\b(?:how\s+(?:to|do\s+i)\s+use|what(?:'s|\s+is)|explain|describe|tell\s+me\s+about)\b|(?:사용법|使い方|什么是|怎么用|如何使用)/iu.test(context);
  const lineBounds = getLineBounds(text, position);
  const line = text.slice(lineBounds.start, lineBounds.end);
  const questionOutsideQuotes = stripQuotedSpans(text);
  const keywordInsideQuotes = isWithinQuotedSpan(text, position);

  if (keywordText) {
    const hasActivationIntent = hasActivationIntentNearKeyword(context, keywordText);
    const hasExecutionDirective = /\b(?:fix|debug|investigate|resolve|handle|patch|address|implement|build)\b/i.test(context);

    // Explicit command + execution intent should remain actionable even if the
    // surrounding message also contains a help question.
    if (hasActivationIntent && hasExecutionDirective) {
      return false;
    }

    // Help-style informational queries must not activate execution modes,
    // even when they contain phrases like "use <keyword>".
    if (hasInformationalIntent && hasStrongHelpQueryIntent) {
      return true;
    }

    if (hasActivationIntent) {
      return false;
    }

    if (hasDiagnosticIntentNearKeyword(context, keywordText)) {
      return true;
    }
  }

  if (/^\s*>\s/.test(line) || /^\s*\|(?:[^|\n]*\|){2,}\s*$/.test(line)) {
    return true;
  }

  if (keywordInsideQuotes && QUESTION_FOLLOWUP_PATTERNS.some((pattern) => pattern.test(questionOutsideQuotes))) {
    return true;
  }

  if (looksLikeReferenceContent(text)) {
    return true;
  }

  return hasInformationalIntent;
}

function findActionableKeywordMatch(
  text: string,
  pattern: RegExp,
): Omit<DetectedKeyword, 'type'> | null {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);

  for (const match of text.matchAll(globalPattern)) {
    if (match.index === undefined) {
      continue;
    }

    const keyword = match[0];
    if (isInformationalKeywordContext(text, match.index, keyword.length, keyword)) {
      continue;
    }

    return {
      keyword,
      position: match.index,
    };
  }

  return null;
}

function findActionableRalplanMatch(
  text: string,
  pattern: RegExp,
): Omit<DetectedKeyword, 'type'> | null {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);

  for (const match of text.matchAll(globalPattern)) {
    if (match.index === undefined) {
      continue;
    }

    const keyword = match[0];
    if (isInformationalKeywordContext(text, match.index, keyword.length, keyword)) {
      continue;
    }

    if (!hasExplicitInvocationContext(text, match.index, keyword.length, keyword)) {
      continue;
    }

    return {
      keyword,
      position: match.index,
    };
  }

  return null;
}

/**
 * Extract prompt text from message parts
 */
export function extractPromptText(
  parts: Array<{ type: string; text?: string; [key: string]: unknown }>
): string {
  return parts
    .filter(p => p.type === 'text' && p.text)
    .map(p => p.text!)
    .join(' ');
}

/**
 * Detect keywords in text and return matches with type info
 */
export function detectKeywordsWithType(
  text: string,
  _agentName?: string
): DetectedKeyword[] {
  const detected: DetectedKeyword[] = [];
  const cleanedText = sanitizeForKeywordDetection(text);

  // Check each keyword type
  for (const type of KEYWORD_PRIORITY) {
    // Team keyword detection disabled — team mode is now explicit-only via /team skill
    if (type === 'team') {
      continue;
    }

    const pattern = KEYWORD_PATTERNS[type];
    const match =
      type === 'ralplan'
        ? findActionableRalplanMatch(cleanedText, pattern)
        : findActionableKeywordMatch(cleanedText, pattern);

    if (match) {
      detected.push({
        ...match,
        type,
      });
    }
  }

  return detected;
}

/**
 * Check if text contains any magic keyword
 */
export function hasKeyword(text: string): boolean {
  return detectKeywordsWithType(text).length > 0;
}

/**
 * Get all detected keywords with conflict resolution applied
 */
export function getAllKeywords(text: string): KeywordType[] {
  const detected = detectKeywordsWithType(text);

  if (detected.length === 0) return [];

  let types = [...new Set(detected.map(d => d.type))];

  // Exclusive: cancel suppresses everything
  if (types.includes('cancel')) return ['cancel'];

  // Mutual exclusion: team beats autopilot
  if (types.includes('team') && types.includes('autopilot')) {
    types = types.filter(t => t !== 'autopilot');
  }

  // Sort by priority order
  return KEYWORD_PRIORITY.filter(k => types.includes(k));
}

/**
 * Options for task-size-aware keyword filtering
 */
export interface TaskSizeFilterOptions {
  /** Enable task-size detection. Default: true */
  enabled?: boolean;
  /** Word count threshold for small tasks. Default: 50 */
  smallWordLimit?: number;
  /** Word count threshold for large tasks. Default: 200 */
  largeWordLimit?: number;
  /** Suppress heavy modes for small tasks. Default: true */
  suppressHeavyModesForSmallTasks?: boolean;
}

/**
 * Result of task-size-aware keyword detection
 */
export interface TaskSizeAwareKeywordsResult {
  keywords: KeywordType[];
  taskSizeResult: TaskSizeResult | null;
  suppressedKeywords: KeywordType[];
}

/**
 * Get all keywords with task-size-based filtering applied.
 * For small tasks, heavy orchestration modes (ralph/autopilot/team/ultrawork etc.)
 * are suppressed to avoid over-orchestration.
 *
 * This is the recommended function to use in the bridge hook for keyword detection.
 */
export function getAllKeywordsWithSizeCheck(
  text: string,
  options: TaskSizeFilterOptions = {},
): TaskSizeAwareKeywordsResult {
  const {
    enabled = true,
    smallWordLimit = 50,
    largeWordLimit = 200,
    suppressHeavyModesForSmallTasks = true,
  } = options;

  const keywords = getAllKeywords(text);

  if (!enabled || !suppressHeavyModesForSmallTasks || keywords.length === 0) {
    return { keywords, taskSizeResult: null, suppressedKeywords: [] };
  }

  const thresholds: TaskSizeThresholds = { smallWordLimit, largeWordLimit };
  const taskSizeResult = classifyTaskSize(text, thresholds);

  // Only suppress heavy modes for small tasks
  if (taskSizeResult.size !== 'small') {
    return { keywords, taskSizeResult, suppressedKeywords: [] };
  }

  const suppressedKeywords: KeywordType[] = [];
  const filteredKeywords = keywords.filter(keyword => {
    if (isHeavyMode(keyword)) {
      suppressedKeywords.push(keyword);
      return false;
    }
    return true;
  });

  return {
    keywords: filteredKeywords,
    taskSizeResult,
    suppressedKeywords,
  };
}

/**
 * Get the highest priority keyword detected with conflict resolution
 */
export function getPrimaryKeyword(text: string): DetectedKeyword | null {
  const allKeywords = getAllKeywords(text);

  if (allKeywords.length === 0) {
    return null;
  }

  // Get the highest priority keyword type
  const primaryType = allKeywords[0];

  // Find the original detected keyword for this type
  const detected = detectKeywordsWithType(text);
  const match = detected.find(d => d.type === primaryType);

  return match || null;
}

/**
 * Execution mode keywords subject to the ralplan-first gate (issue #997).
 * These modes spin up heavy orchestration and should not run on vague requests.
 */
export const EXECUTION_GATE_KEYWORDS = new Set<KeywordType>([
  'ralph',
  'autopilot',
  'team',
  'ultrawork',
]);

/**
 * Escape hatch prefixes that bypass the ralplan gate.
 */
const GATE_BYPASS_PREFIXES = ['force:', '!'];

/**
 * Positive signals that the prompt IS well-specified enough for direct execution.
 * If ANY of these are present, the prompt auto-passes the gate (fast path).
 */
const WELL_SPECIFIED_SIGNALS: RegExp[] = [
  // References specific files by extension
  /\b[\w/.-]+\.(?:ts|js|py|go|rs|java|tsx|jsx|vue|svelte|rb|c|cpp|h|css|scss|html|json|yaml|yml|toml)\b/,
  // References specific paths with directory separators
  /(?:src|lib|test|spec|app|pages|components|hooks|utils|services|api|dist|build|scripts)\/\w+/,
  // References specific functions/classes/methods by keyword
  /\b(?:function|class|method|interface|type|const|let|var|def|fn|struct|enum)\s+\w{2,}/i,
  // CamelCase identifiers (likely symbol names: processKeyword, getUserById)
  /\b[a-z]+(?:[A-Z][a-z]+)+\b/,
  // PascalCase identifiers (likely class/type names: KeywordDetector, UserModel)
  /\b[A-Z][a-z]+(?:[A-Z][a-z0-9]*)+\b/,
  // snake_case identifiers with 2+ segments (likely symbol names: user_model, get_user)
  /\b[a-z]+(?:_[a-z]+)+\b/,
  // Bare issue/PR number (#123, #42)
  /(?:^|\s)#\d+\b/,
  // Has numbered steps or bullet list (structured request)
  /(?:^|\n)\s*(?:\d+[.)]\s|-\s+\S|\*\s+\S)/m,
  // Has acceptance criteria or test spec keywords
  /\b(?:acceptance\s+criteria|test\s+(?:spec|plan|case)|should\s+(?:return|throw|render|display|create|delete|update))\b/i,
  // Has specific error or issue reference
  /\b(?:error:|bug\s*#?\d+|issue\s*#\d+|stack\s*trace|exception|TypeError|ReferenceError|SyntaxError)\b/i,
  // Has a code block with substantial content.
  // NOTE: In the bridge.ts integration, cleanedText has code blocks pre-stripped by
  // removeCodeBlocks(), so this regex will not match there. It remains useful for
  // direct callers of isUnderspecifiedForExecution() that pass raw prompt text.
  /```[\s\S]{20,}?```/,
  // PR or commit reference
  /\b(?:PR\s*#\d+|commit\s+[0-9a-f]{7}|pull\s+request)\b/i,
  // "in <specific-path>" pattern
  /\bin\s+[\w/.-]+\.(?:ts|js|py|go|rs|java|tsx|jsx)\b/,
  // Test runner commands (explicit test target)
  /\b(?:npm\s+test|npx\s+(?:vitest|jest)|pytest|cargo\s+test|go\s+test|make\s+test)\b/i,
];

/**
 * Check if a prompt is underspecified for direct execution.
 * Returns true if the prompt lacks enough specificity for heavy execution modes.
 *
 * Conservative: only gates clearly vague prompts. Borderline cases pass through.
 */
export function isUnderspecifiedForExecution(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;

  // Escape hatch: force: or ! prefix bypasses the gate
  for (const prefix of GATE_BYPASS_PREFIXES) {
    if (trimmed.startsWith(prefix)) return false;
  }

  // If any well-specified signal is present, pass through
  if (WELL_SPECIFIED_SIGNALS.some(p => p.test(trimmed))) return false;

  // Strip mode keywords for effective word counting
  const stripped = trimmed
    .replace(/\b(?:ralph|autopilot|team|ultrawork|ulw)\b/gi, '')
    .trim();
  const effectiveWords = stripped.split(/\s+/).filter(w => w.length > 0).length;

  // Short prompts without well-specified signals are underspecified
  if (effectiveWords <= 15) return true;

  return false;
}

/**
 * Apply the ralplan-first gate (issue #997): if execution keywords are present
 * but the prompt is underspecified, redirect to ralplan.
 *
 * Returns the modified keyword list and gate metadata.
 */
export function applyRalplanGate(
  keywords: KeywordType[],
  text: string,
): { keywords: KeywordType[]; gateApplied: boolean; gatedKeywords: KeywordType[] } {
  if (keywords.length === 0) {
    return { keywords, gateApplied: false, gatedKeywords: [] };
  }

  // Don't gate if cancel is present (cancel always wins)
  if (keywords.includes('cancel')) {
    return { keywords, gateApplied: false, gatedKeywords: [] };
  }

  // Don't gate if ralplan is already in the list
  if (keywords.includes('ralplan')) {
    return { keywords, gateApplied: false, gatedKeywords: [] };
  }

  // Check if any execution keywords are present
  const executionKeywords = keywords.filter(k => EXECUTION_GATE_KEYWORDS.has(k));
  if (executionKeywords.length === 0) {
    return { keywords, gateApplied: false, gatedKeywords: [] };
  }

  // Check if prompt is underspecified
  if (!isUnderspecifiedForExecution(text)) {
    return { keywords, gateApplied: false, gatedKeywords: [] };
  }

  // Gate: replace execution keywords with ralplan
  const filtered = keywords.filter(k => !EXECUTION_GATE_KEYWORDS.has(k));
  if (!filtered.includes('ralplan')) {
    filtered.push('ralplan');
  }

  return { keywords: filtered, gateApplied: true, gatedKeywords: executionKeywords };
}
