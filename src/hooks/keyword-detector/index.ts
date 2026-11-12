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
  | 'ralplan'     // Priority 8
  | 'tdd'         // Priority 9
  | 'code-review' // Priority 10
  | 'security-review' // Priority 10.5
  | 'ultrathink'  // Priority 11
  | 'deepsearch'  // Priority 12
  | 'deep-interview' // Priority 13.5
  | 'analyze'     // Priority 13
  | 'ultragoal'   // Script-detected workflow trigger
  | 'ai-slop-cleaner' // Script-detected workflow trigger
  | 'wiki'        // Script-detected workflow trigger
  | 'codex'       // Priority 15
  | 'gemini'      // Priority 16
  | 'cursor'      // Priority 17
  | 'antigravity'; // Priority 18

export interface DetectedKeyword {
  type: KeywordType;
  keyword: string;
  position: number;
}

// The Latin aliases need a command (see findActionableAutopilotAliasMatch); the
// creation phrases and the Korean and Japanese aliases keep the generic check.
const AUTOPILOT_ALIAS_PATTERN = /\b(autopilot|auto[\s-]?pilot|fullsend|full\s+auto)\b/i;
const AUTOPILOT_OTHER_PATTERN = /\b(?:build|create|make)\s+me\s+(?:an?\s+)?(?:app|feature|project|tool|plugin|website|api|server|cli|script|system|service|dashboard|bot|extension)\b|\bi\s+want\s+an?\s+(?:app|feature|project|tool|plugin|website|api|server|cli|script|system|service|dashboard|bot|extension)\b|(오토파일럿)|(オートパイロット)/i;

/**
 * Keyword patterns for each mode
 */
const KEYWORD_PATTERNS: Record<KeywordType, RegExp> = {
  cancel: /\b(cancelomc|stopomc)\b/i,
  ralph: /\b(ralph)\b(?!-)|(랄프)(?!로렌)|(ラルフ)(?!・?ローレン)/i,
  autopilot: new RegExp(`${AUTOPILOT_ALIAS_PATTERN.source}|${AUTOPILOT_OTHER_PATTERN.source}`, 'i'),
  // Team keyword detection disabled — team mode is now explicit-only via /team skill.
  // This prevents infinite spawning when Claude workers receive prompts containing "team".
  team: /(?!x)x/,  // never-match placeholder (type system requires the key)
  ralplan: /\b(ralplan)\b|(랄플랜)|(ラルプラン)/i,
  tdd: /\b(tdd)\b|\btest\s+first\b|(테스트\s?퍼스트)|(テスト\s?ファースト)/i,
  'code-review': /\b(code\s+review|review\s+code)\b|(코드\s?리뷰)(?!어)|(コード\s?レビュー)(?!ア)/i,
  'security-review': /\b(security\s+review|review\s+security)\b|(보안\s?리뷰)(?!어)|(セキュリティ[ー]?\s?レビュー)(?!ア)/i,
  ultrathink: /\b(ultrathink)\b|(울트라씽크)|(ウルトラシンク)/i,
  deepsearch: /\b(deepsearch)\b|\bsearch\s+the\s+codebase\b|\bfind\s+in\s+(the\s+)?codebase\b|(딥\s?서치)|(ディープ\s?サーチ)/i,
  analyze: /\b(deep[\s-]?analyze|deepanalyze)\b|(딥\s?분석)|(ディープ\s?アナライズ)/i,
  'deep-interview': /\b(deep[\s-]interview|ouroboros)\b|(딥인터뷰)|(ディープインタビュー)/i,
  // Script-only triggers: never-match placeholders (script detects them, TypeScript doesn't)
  ultragoal: /(?!x)x/,  // Script-only detection
  'ai-slop-cleaner': /(?!x)x/,  // Script-only detection
  wiki: /(?!x)x/,  // Script-only detection
  codex: /\b(ask|use|delegate\s+to)\s+(codex|gpt)\b/i,
  gemini: /\b(ask|use|delegate\s+to)\s+gemini\b/i,
  cursor: /\b(ask|use|delegate\s+to)\s+cursor\b/i,
  antigravity: /\b(ask|use|delegate\s+to)\s+(antigravity|agy)\b/i
};

/**
 * Matches the upstream Ouroboros CLI invocation form at the start of the
 * prompt: `ouroboros <sub>`, `ooo <sub>`, or `/ouroboros:<sub>`. Used as a
 * skip predicate for the deep-interview trigger so direct CLI calls are
 * not rerouted into the OMC skill.
 */
const OUROBOROS_BRAND_AT_START = /^\s*\/?(?:ouroboros|ooo)\b/i;

/**
 * Optional per-keyword skip predicate. When the predicate returns true for
 * a given prompt, the corresponding keyword regex match is suppressed even
 * if it would otherwise fire. Used for narrow false-positive guards.
 *
 * `deep-interview` matches the bare brand name `ouroboros`, which fires on
 * upstream CLI invocations like `ouroboros auto "X"`, `ooo auto`, and
 * `/ouroboros:auto`. The predicate defers to the upstream CLI in those
 * cases without changing what the trigger recognizes elsewhere.
 */
const KEYWORD_SKIP_PREDICATES: Partial<Record<KeywordType, (text: string) => boolean>> = {
  'deep-interview': (text) => OUROBOROS_BRAND_AT_START.test(text),
};

/**
 * Priority order for keyword detection. Exported so the shadow judgment
 * points (jev-shadow.ts) can derive their criteria from the same constants
 * the detector emits.
 */
export const KEYWORD_PRIORITY: KeywordType[] = [
  'cancel', 'ralph', 'autopilot', 'team',
  'ralplan', 'tdd', 'code-review', 'security-review',
  'ultrathink', 'deepsearch', 'analyze', 'deep-interview',
  'ultragoal', 'ai-slop-cleaner', 'wiki',
  'codex', 'gemini', 'cursor', 'antigravity'
];

const RETIRED_WORKFLOW_SLASH_PATTERN =
  /^\s*\/(?:oh-my-claudecode:|omc:)?(?:ultrawork|ulw|uw|울트라워크|ウルトラワーク|ccg|claude-codex-gemini|씨씨지|シーシージー|ultraqa|omc-teams)(?=\s|$|[?!.,;:])/i;

export function isRetiredWorkflowSlashInvocation(text: string): boolean {
  return RETIRED_WORKFLOW_SLASH_PATTERN.test(text);
}

/**
 * Canonical workflow skills detected via explicit slash invocation.
 * This is intentionally narrower than the state compatibility registry:
 * removed-not-aliased workflows may retain legacy state readers, but must not
 * be parsed as active slash routes.
 */
const CANONICAL_WORKFLOW_SLASH_SKILLS = [
  'autopilot',
  'ralph',
  'team',
  'deep-interview',
  'ralplan',
  'self-improve',
] as const;

export type CanonicalWorkflowSlashSkill =
  (typeof CANONICAL_WORKFLOW_SLASH_SKILLS)[number];

/**
 * Map workflow slash skills to keyword types so explicit slash invocations
 * surface alongside ordinary keyword detection. Skills with no dedicated
 * KeywordType (`self-improve`) is intentionally absent — the bridge handles
 * their seeding via the parser result instead of through the keyword-priority
 * loop.
 */
const SLASH_SKILL_TO_KEYWORD_TYPE: Partial<
  Record<CanonicalWorkflowSlashSkill, KeywordType>
> = {
  autopilot: 'autopilot',
  ralph: 'ralph',
  team: 'team',
  'deep-interview': 'deep-interview',
  ralplan: 'ralplan',
};

const WORKFLOW_SLASH_PATTERN = new RegExp(
  '^\\s*/(?:oh-my-claudecode:|omc:)?(' +
    CANONICAL_WORKFLOW_SLASH_SKILLS
      .map((skill) => skill.replace(/-/g, '\\-'))
      .join('|') +
    ')(?=\\s|$|[?!.,;:])',
  'i',
);

export interface ExplicitWorkflowSlashInvocation {
  /** Canonical workflow skill name (lowercase, no `oh-my-claudecode:` prefix). */
  skill: CanonicalWorkflowSlashSkill;
  /** Trailing arguments after the slash command. */
  args: string;
  /** Raw matched prefix (including any namespace prefix and the skill name). */
  raw: string;
}

/**
 * Parse an explicit workflow slash invocation at the start of a prompt.
 *
 * Recognizes `/<skill>`, `/omc:<skill>`, and `/oh-my-claudecode:<skill>` for
 * the canonical workflow skill list. Code fences and inline backticks are
 * stripped first so quoted commands do not match. The trailing lookahead
 * (whitespace, end-of-text, or punctuation) prevents file paths like
 * `/ralph-logs/foo.txt` from matching `/ralph`.
 *
 * Returns `null` when no explicit invocation is present.
 */
export function parseExplicitWorkflowSlashInvocation(
  promptText: string,
): ExplicitWorkflowSlashInvocation | null {
  if (typeof promptText !== 'string' || promptText.length === 0) return null;
  const stripped = removeCodeBlocks(promptText);
  const match = WORKFLOW_SLASH_PATTERN.exec(stripped);
  if (!match) return null;
  const skill = match[1].toLowerCase() as CanonicalWorkflowSlashSkill;
  const args = stripped.slice(match[0].length).trim();
  return { skill, args, raw: match[0] };
}

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

const PASTED_MAGIC_KEYWORD_HEADER_PATTERN =
  /^\s*\[MAGIC KEYWORDS?(?: DETECTED)?:.*$/i;
const ROLE_BOUNDARY_PATTERN =
  /^<\s*\/?\s*(system|human|assistant|user|tool_use|tool_result)\b[^>]*>/i;
const SKILL_TRANSCRIPT_LINE_PATTERN =
  /^\s*Skill:\s+oh-my-(?:claudecode|codex):/i;
const USER_REQUEST_LINE_PATTERN = /^\s*User request(?:\s*\([^)]*\))?:\s*$/i;
const SHELL_TRANSCRIPT_LINE_PATTERN = /^\s*[$%❯]\s+/;
const GIT_DIFF_START_PATTERNS: RegExp[] = [
  /^diff\s+--git\s+a\//,
  /^index\s+[0-9a-f]+\.\.[0-9a-f]+(?:\s+\d+)?$/i,
  /^(?:---|\+\+\+)\s+[ab]\//,
  /^@@\s+-\d+/,
];
const GIT_DIFF_CONTINUATION_PATTERNS: RegExp[] = [
  /^new file mode\s+\d+$/i,
  /^deleted file mode\s+\d+$/i,
  /^similarity index\s+\d+%$/i,
  /^rename (?:from|to)\s+/i,
  /^Binary files .+ differ$/i,
  /^(?:diff\s+--git\s+a\/|index\s+[0-9a-f]+\.\.[0-9a-f]+|(?:---|\+\+\+)\s+[ab]\/|@@\s+-\d+)/i,
  /^[ +\-].*/,
];

function stripPastedCommandPayloads(text: string): string {
  const lines = text.split('\n');
  const sanitized: string[] = [];
  let insideRoleBlock = false;
  let insideDiffBlock = false;
  let insideMagicKeywordBlock = false;
  let magicBlockSawUserRequest = false;
  let magicBlockSawRequestPayload = false;
  let previousLineWasUserRequest = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (insideMagicKeywordBlock) {
      if (ROLE_BOUNDARY_PATTERN.test(trimmed)) {
        insideRoleBlock = !/^<\s*\//.test(trimmed);
        insideMagicKeywordBlock = false;
        magicBlockSawUserRequest = false;
        magicBlockSawRequestPayload = false;
        continue;
      }

      if (USER_REQUEST_LINE_PATTERN.test(line)) {
        magicBlockSawUserRequest = true;
        magicBlockSawRequestPayload = false;
        continue;
      }

      if (magicBlockSawUserRequest) {
        if (trimmed) {
          magicBlockSawRequestPayload = true;
          continue;
        }

        if (magicBlockSawRequestPayload) {
          insideMagicKeywordBlock = false;
          magicBlockSawUserRequest = false;
          magicBlockSawRequestPayload = false;
          sanitized.push(line);
          continue;
        }
      }

      continue;
    }

    if (PASTED_MAGIC_KEYWORD_HEADER_PATTERN.test(line)) {
      insideMagicKeywordBlock = true;
      magicBlockSawUserRequest = false;
      magicBlockSawRequestPayload = false;
      continue;
    }

    if (ROLE_BOUNDARY_PATTERN.test(trimmed)) {
      insideRoleBlock = !/^<\s*\//.test(trimmed);
      continue;
    }

    if (insideRoleBlock) {
      continue;
    }

    if (!trimmed) {
      sanitized.push(line);
      insideDiffBlock = false;
      previousLineWasUserRequest = false;
      continue;
    }

    if (previousLineWasUserRequest) {
      previousLineWasUserRequest = false;
      continue;
    }

    if (USER_REQUEST_LINE_PATTERN.test(line) || SKILL_TRANSCRIPT_LINE_PATTERN.test(line)) {
      previousLineWasUserRequest = USER_REQUEST_LINE_PATTERN.test(line);
      continue;
    }

    if (SHELL_TRANSCRIPT_LINE_PATTERN.test(line) && !/^\s*\$\w/.test(line)) {
      continue;
    }

    if (insideDiffBlock) {
      if (GIT_DIFF_CONTINUATION_PATTERNS.some((pattern) => pattern.test(trimmed))) {
        continue;
      }
      insideDiffBlock = false;
    }

    if (GIT_DIFF_START_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      insideDiffBlock = true;
      continue;
    }

    sanitized.push(line);
  }

  return sanitized.join('\n');
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
 * Character class for a single file-path segment. Includes `\w.-` plus the same
 * non-Latin script ranges as NON_LATIN_SCRIPT_PATTERN, so CJK/etc. file names
 * (e.g. `docs/\u30B3\u30FC\u30C9\u30EC\u30D3\u30E5\u30FC.md`) are recognized as paths and stripped before
 * keyword detection. Without this, a CJK alias embedded in a path survives
 * sanitization and falsely activates its mode (path detection is ASCII-only
 * with a bare `[\w.-]`). Building the path regex from this shared constant
 * avoids the class drifting across its repeated uses below.
 */
const PATH_SEGMENT_CHARS =
  '[\\w.\\-\\u3000-\\u9FFF\\uAC00-\\uD7AF\\u0400-\\u04FF\\u0600-\\u06FF\\u0900-\\u097F\\u0E00-\\u0E7F\\u1000-\\u109F]';

/**
 * File-path matcher used by sanitizeForKeywordDetection. Requires at least one
 * slash-terminated directory segment `(?:SEG+/)+` (optionally preceded by a `/`;
 * a leading `./` is absorbed by the first segment since SEG includes `.`), then a
 * final segment bounded as a (CJK-capable) stem ending in an ASCII `.ext` OR an
 * ASCII-only extensionless name. Directory/stem segments are Unicode-aware
 * (PATH_SEGMENT_CHARS) so CJK file names strip too, while a no-space CJK directive
 * after a path is NOT consumed by a greedy tail. Structurally identical to the
 * runtime `.mjs` path stripper, so index.ts and the .mjs produce the same keyword
 * outcome for every path input — no detector/bundle divergence. Bare slash-commands
 * like `/ralph` lack an internal slash so they are not stripped here (and are
 * detected pre-sanitization via parseExplicitWorkflowSlashInvocation anyway).
 */
/* eslint-disable no-misleading-character-class -- Same script ranges as NON_LATIN_SCRIPT_PATTERN: intentional range set, not grapheme clusters */
const FILE_PATH_PATTERN = new RegExp(
  '(^|[\\s"\'`(])(?:\\/)?(?:' +
    PATH_SEGMENT_CHARS +
    '+\\/)+(?:' +
    PATH_SEGMENT_CHARS +
    '*\\.\\w+|[\\w.\\-]+)',
  'gm',
);
/* eslint-enable no-misleading-character-class */

/**
* Sanitize text for keyword detection by removing structural noise.
 * Strips XML tags, URLs, file paths, and code blocks.
 */
export function sanitizeForKeywordDetection(text: string): string {
  let result = stripPastedCommandPayloads(text);
  // Remove HTML/markdown comments first so keywords inside comments cannot trigger modes
  result = result.replace(/<!--[\s\S]*?-->/g, '');
  // Keep optional closing-tag attributes on one line and stop at adjacent tags.
  result = result.replace(/<(\w[\w-]*)[\s>][\s\S]*?<\/\1(?:[ \t][^<>\r\n]*)?>/g, '');
  // Remove self-closing XML tags
  result = result.replace(/<\w[\w-]*(?:\s[^>]*)?\s*\/>/g, '');
  // Remove URLs
  result = result.replace(/https?:\/\/\S+/g, '');
  // Remove block quotes and markdown table rows - they are typically reference content
  result = result.replace(/^\s*>\s.*$/gm, '');
  result = result.replace(/^\s*\|(?:[^|\n]*\|){2,}\s*$/gm, '');
  result = result.replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|){1,}\s*$/gm, '');
  // Remove file paths — requires leading / or ./ or multi-segment dir/file.ext.
  // Unicode-aware segments (FILE_PATH_PATTERN) so CJK file names are stripped too.
  result = result.replace(FILE_PATH_PATTERN, '$1');
  // Remove code blocks (fenced and inline)
  result = removeCodeBlocks(result);
  return result;
}

const INFORMATIONAL_INTENT_PATTERNS: RegExp[] = [
  /\b(?:what(?:'s|\s+is)|what\s+are|how\s+(?:to|do\s+i)\s+use|explain|explanation|tell\s+me\s+about|describe)\b/i,
  /(?:뭐야|뭔데|무엇(?:이야|인가요)?|어떻게|설명(?!서\s*(?:작성|만들|생성|추가|업데이트|수정|편집|쓰))|사용법|알려\s?줘|알려줄래|소개해?\s?줘|소개\s*부탁|설명해\s?줘|뭐가\s*달라|어떤\s*기능|기능\s*(?:알려|설명|뭐)|방법\s*(?:알려|설명|뭐))/u,
  /(?:とは|って何|使い方|説明|(?:について|に関して|違い)[^\n]{0,24}(?:教えて|説明|知りたい)|(?:どう|何が|どこが)違う)/u,
  /(?:什么是|怎(?:么|樣)用|如何使用|解释|說明|说明)/u,
  /(?:ทำไม|อะไร|ยังไง|อย่างไร|คืออะไร|หมายถึง|แปลว่า|อธิบาย|มั้ย|ไหม|เหรอ|หรอ|หรือไม่|หรือเปล่า|ใช่ไหม|ถูกมั้ย|เกี่ยวกับ|เหมือน)/u,
];
const STRONG_HELP_QUERY_PATTERN =
  /\?|？|\b(?:how\s+(?:to|do\s+i)\s+use|what(?:'s|\s+is)|what\s+are|explain|describe|tell\s+me\s+about)\b|(?:사용법|使い方|什么是|怎么用|如何使用)/iu;
// Help-request constructions ("tell me", "how to use", "what is"), not bare
// help terms or particles such as 사용법, 使い方, or とは, keep task objects actionable.
const MULTILINGUAL_HELP_REQUEST_PATTERN =
  /(?:알려\s?줘|알려줄래|설명해\s?줘|뭐야|뭔데|어떻게\s*(?:써|쓰|사용)|教えて|説明して|って何|如何使用|怎(?:么|樣)用|是什么|什么是|(?:(?:请|請)\s*(?:解释|解釋|說明|说明)|(?:解释|解釋|說明|说明)(?:一下|下|如何|怎么|怎麼|怎样|怎樣))|คืออะไร|ใช้(?:งาน)?ยังไง|ใช้(?:งาน)?อย่างไร)/u;
const ENGLISH_HELP_REQUEST_PATTERN =
  /\b(?:what(?:'s|\s+is)|what\s+are|how\s+(?:to|do\s+i)\s+use|explain|describe|tell\s+me\s+about)\b/iu;
const TASK_ACTION_VERB_PATTERN =
  /\b(?:fix|debug|investigate|resolve|handle|patch|address|implement|build|create|make|run|start|enable|activate|invoke|trigger|launch)\b|(?:ทำ|ทํา|สร้าง|แก้|เปิด|รัน|เรียก|เริ่ม|만들어줘|만들어|생성해|추가해|수정해|편집해|작성해|구현해|고쳐(?:줘)?|실행해|作成して|作って|修正して|直して|追加して|実装して|更新して|実行して|创建|生成|修复|修改|构建|实现|执行)/iu;
const RESULTS_REPORTING_REQUEST_PATTERN =
  /(?:(?:결과|변경\s*(?:사항|내용)|수정\s*(?:사항|내용)|変更(?:内容|点)|修正内容)[^\n]{0,24}(?:알려\s?줘|알려줄래|설명해\s?줘|教えて|説明して)|(?:(?:结果|結果|(?:改动|改動|更改|修改|变更|變更)(?:内容|內容|结果|結果))[^\n]{0,24}(?:解释|說明|说明)|(?:解释|說明|说明)[^\n]{0,24}(?:结果|結果|改动|改動|更改|修改|变更|變更))|(?:results?|changes?|summary)[^\n]{0,24}(?:tell\s+me|explain|describe)|(?:tell\s+me|explain|describe)[^\n]{0,24}(?:results?|changes?|summary))/iu;
const INFORMATIONAL_CONTEXT_WINDOW = 80;
const QUOTED_SPAN_PATTERN =
  /"[^"\n]{1,400}"|'[^'\n]{1,400}'|“[^”\n]{1,400}”|‘[^’\n]{1,400}’/g;
const REFERENCE_META_PATTERNS: RegExp[] = [
  /\b(?:vs\.?|versus|compared\s+to|comparison|compare|article|blog\s+post|documentation|docs?|reference)\b/i,
  /(?:비교|차이|설명|정리|문서|자료|가이드|이\s*(?:글|비교|문서)는|블로그)/u,
  /\b(?:this\s+(?:article|comparison|guide|documentation|doc)|quoted|quote(?:d)?)\b/i,
  /(?:เปรียบเทียบ|ต่างกัน|ความต่าง|เอกสาร|บทความ|ไกด์|คู่มือ|เกี่ยวกับ|เหมือน)/u,
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
  /(?:ทำไม|อะไร|ยังไง|อย่างไร|เท่าไหร่|กี่|มั้ย|ไหม|เหรอ|หรอ|หรือไม่|หรือเปล่า|ใช่ไหม|ถูกมั้ย)/u,
];
const MODE_REFERENCE_PATTERN =
  /\b(?:ralph|autopilot|auto[\s-]?pilot|ralplan|ultrathink|deepsearch|deep[\s-]?analyze|deepanalyze|deep[\s-]interview|ouroboros|deerflow)\b/gi;

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

/**
 * Bounds of the specific quoted span containing `position`, or null if none.
 * Used to scope the execution-directive check for the quote exemption to
 * this keyword's own quote — not the generic ±80-char context window, which
 * can otherwise pick up an unrelated genuine command elsewhere in the same
 * message (e.g. a second keyword issued as a real directive) and wrongly
 * neutralize the exemption for a keyword that is purely quoted as an
 * example.
 */
function findQuotedSpanBounds(text: string, position: number): { start: number; end: number } | null {
  for (const match of text.matchAll(QUOTED_SPAN_PATTERN)) {
    if (match.index === undefined) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (position >= start && position < end) {
      return { start, end };
    }
  }
  return null;
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
  return /^\s*(?:[$/!]\s*|force:\s*|\/?oh-my-(?:claudecode|codex):\s*)?$/i.test(prefix);
}

// A leading alias is direct only with invocation syntax or an action; a bare
// alias can be ordinary prose in supported languages.
function hasDirectLeadingInvocation(text: string, position: number, keywordLength: number): boolean {
  const prefix = text.slice(0, position);
  if (!hasDirectInvocationPrefix(text, position)) {
    return false;
  }

  if (/^\s*\/oh-my-(?:claudecode|codex):\s*$/i.test(prefix)) {
    return true;
  }

  return /^\s*[:：]/.test(text.slice(position + keywordLength)) || hasLeadingCommandVerb(text, position, keywordLength);
}

function hasLeadingCommandVerb(text: string, position: number, keywordLength: number): boolean {
  return /^\s+(?:fix|debug|investigate|resolve|handle|patch|address|implement|build|create|make|run|start|enable|activate|invoke|trigger|launch|plan)\b/i.test(
    text.slice(position + keywordLength),
  );
}

function hasConversationalInvocationNearKeyword(
  text: string,
  position: number,
  _keywordLength: number,
  _keywordText: string,
): boolean {
  if (isWithinQuotedSpan(text, position)) {
    return false;
  }

  const start = Math.max(0, position - INFORMATIONAL_CONTEXT_WINDOW);
  const prefix = stripQuotedSpans(text.slice(start, position));
  const conversationalInvocationPatterns = [
    /\bplease\s+$/i,
    /\blet['’]?s\s+$/i,
    /\bi\s+(?:want|need|would\s+like)\s+(?:a|an)\s+$/i,
    /\b(?:can|could|would|will)\s+you\s+$/i,
  ];

  return conversationalInvocationPatterns.some((pattern) => pattern.test(prefix));
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

  return hasConversationalInvocationNearKeyword(text, position, keywordLength, keywordText);
}

function hasDiagnosticIntentNearKeyword(context: string, keyword: string): boolean {
  const escaped = escapeRegExp(keyword.trim());
  if (!escaped) return false;

  const patterns = [
    new RegExp(`\\b${escaped}\\b[^\\n]{0,48}\\b(?:keeps?\\s+(?:looping|re-?running)|has\\s+(?:a\\s+)?(?:bug|issue|problem|error)|is\\s+(?:stuck|broken|failing)|loop(?:ing)?)\\b`, 'i'),
    new RegExp(`\\b(?:bug|issue|problem|error)\\b[^\\n]{0,16}\\b(?:with|in)\\s+\\b${escaped}\\b`, 'i'),
    new RegExp(`${escaped}.{0,14}(?:자꾸|계속).{0,14}(?:재실행|반복|루프|멈추)`, 'u'),
    // Japanese: repeated-failure complaint — direct mirror of the Korean 자꾸/계속 line above
    // (frequency adverb + problem verb). No P2 subject-particle pattern / no work-request escape: Korean parity.
    new RegExp(`${escaped}[^\\n]{0,16}(?:また|何度も|ずっと|頻繁|繰り返|いつも)[^\\n]{0,16}(?:失敗|エラー|ループ|止ま|落ち|再実行|動かな|フリーズ|壊れ|クラッシュ|こけ|暴走|無限)`, 'u'),
  ];

  return patterns.some((pattern) => pattern.test(context));
}

function isRalphMetaOrBanterContext(context: string, keywordText: string): boolean {
  const normalizedKeyword = keywordText.toLowerCase().replace(/\s+/g, '');
  if (!['ralph', '랄프', 'ラルフ'].includes(normalizedKeyword)) {
    return false;
  }

  const currentKeywordPattern = ['ralph', '랄프', 'ラルフ'].join('|');
  const imperativeVerbPattern = '켜|켜줘|실행|시작|돌려|돌려줘|써|써줘|사용해|진행해';
  const koreanImperativePatterns = [
    new RegExp(`(?:${currentKeywordPattern})[^?？\n]{0,16}(?:${imperativeVerbPattern})`, 'u'),
    new RegExp(`(?:${imperativeVerbPattern})[^?？\n]{0,16}(?:${currentKeywordPattern})`, 'u'),
  ];
  if (koreanImperativePatterns.some((pattern) => pattern.test(context))) {
    return false;
  }

  const metaOrBanterPatterns = [
    /[?？].{0,12}(?:ㅋ{1,}|ㅎ{1,}|lol|lmao)/iu,
    /(?:ㅋ{1,}|ㅎ{1,}|lol|lmao).{0,40}[?？]/iu,
    /(?:ralph|랄프|ラルフ).{0,40}(?:라도|줘야\s*해|쥐어\s*줘야\s*해|해야\s*해).{0,20}[?？]/iu,
    /(?:관계|관련|연관|차이|비교).{0,40}(?:뭐|무엇|어떻게|설명|알려|궁금|인가|야|냐|니|까|[?？])/u,
    /(?:뭐|무엇|어떻게|설명|알려|궁금).{0,40}(?:관계|관련|연관|차이|비교)/u,
  ];

  return metaOrBanterPatterns.some((pattern) => pattern.test(context));
}

function isAutopilotCreationAlias(keywordText: string): boolean {
  const normalized = keywordText.toLowerCase().trim();
  return /^(?:build|create|make)\s+me\b/.test(normalized) || /^i\s+want\s+an?(?:\s+(?:app|feature|project|tool|plugin|website|api|server|cli|script|system|service|dashboard|bot|extension))?\s*$/.test(normalized);
}

function hasResultsReportingRequestAfterAction(text: string): boolean {
  const taskText = stripQuotedSpans(text);
  const reportingRequestIndex = taskText.search(RESULTS_REPORTING_REQUEST_PATTERN);
  if (reportingRequestIndex <= 0) return false;

  const precedingTaskText = taskText.slice(0, reportingRequestIndex);
  const precedingTextHasHelpRequest =
    ENGLISH_HELP_REQUEST_PATTERN.test(precedingTaskText) || MULTILINGUAL_HELP_REQUEST_PATTERN.test(precedingTaskText);
  return !precedingTextHasHelpRequest && TASK_ACTION_VERB_PATTERN.test(precedingTaskText);
}

function hasActionableRequestLine(text: string): boolean {
  const taskText = stripQuotedSpans(text);
  if (/\?|？/u.test(taskText) || !TASK_ACTION_VERB_PATTERN.test(taskText)) return false;
  const hasHelpRequest = ENGLISH_HELP_REQUEST_PATTERN.test(taskText) || MULTILINGUAL_HELP_REQUEST_PATTERN.test(taskText);
  return !hasHelpRequest || hasResultsReportingRequestAfterAction(taskText);
}

function hasActionableCommandAfterSeparator(text: string, position: number, keywordLength: number): boolean {
  const suffix = text.slice(position + keywordLength).match(/^\s*[:：]\s*([^\n]{0,80})/u)?.[1] ?? '';
  const taskText = stripQuotedSpans(suffix);
  if (/\?|？/u.test(taskText)) {
    return false;
  }
  if (
    (ENGLISH_HELP_REQUEST_PATTERN.test(taskText) || MULTILINGUAL_HELP_REQUEST_PATTERN.test(taskText)) &&
    !hasResultsReportingRequestAfterAction(taskText)
  ) {
    return false;
  }
  return TASK_ACTION_VERB_PATTERN.test(taskText);
}

function getLeadingRequestLine(text: string, position: number, keywordLength: number, line: string): string {
  const [sameLine, ...rest] = text.slice(position + keywordLength).replace(/^[^\S\n]*[:：]?/u, '').split('\n');
  if (sameLine.trim()) {
    return line;
  }
  return rest.find((candidate) => candidate.trim()) ?? line;
}

function isInformationalKeywordContext(text: string, position: number, keywordLength: number, keywordText?: string): boolean {
  const start = Math.max(0, position - INFORMATIONAL_CONTEXT_WINDOW);
  const end = Math.min(text.length, position + keywordLength + INFORMATIONAL_CONTEXT_WINDOW);
  const context = text.slice(start, end);
  const hasInformationalIntent = INFORMATIONAL_INTENT_PATTERNS.some((pattern) => pattern.test(context));
  const hasStrongHelpQueryIntent = STRONG_HELP_QUERY_PATTERN.test(context);
  const lineBounds = getLineBounds(text, position);
  const line = text.slice(lineBounds.start, lineBounds.end);
  const questionOutsideQuotes = stripQuotedSpans(text);
  const keywordInsideQuotes = isWithinQuotedSpan(text, position);
  const hasExecutionDirective = /\b(?:fix|debug|investigate|resolve|handle|patch|address|implement|build)\b/i.test(context);
  const hasCommandSeparatorInvocation =
    hasDirectInvocationPrefix(text, position) && /^\s*[:：]/.test(text.slice(position + keywordLength));
  const hasActionableCommandSeparatorInvocation =
    hasCommandSeparatorInvocation && hasActionableCommandAfterSeparator(text, position, keywordLength);

  // A keyword occurrence inside a quoted span is usually reported/example
  // text, not a command directed at the assistant — e.g. an example sentence
  // like `"use autopilot"` inside a paragraph discussing that exact phrasing.
  // But a quoted keyword paired with a nearby execution directive OR
  // activation verb (e.g. `"ralph" fix the auth bug`, or `run "ralph" on
  // this issue`) is still a genuine request stylistically wrapped in quotes,
  // so the exemption only applies when neither is present — checked before
  // any other activation-intent logic so quoting wins for reported speech
  // but not for real commands.
  //
  // This check is scoped to text immediately OUTSIDE this keyword's own
  // quoted span (±28 chars before/after the span's bounds), not the generic
  // ±80-char context window used elsewhere in this function, and NOT the
  // quote's own interior. Three failure modes this avoids:
  // - Scoping to the wide window: an unrelated genuine command elsewhere in
  //   the same message (e.g. a second keyword issued as a real directive)
  //   could sit inside it and wrongly neutralize the exemption for a keyword
  //   that is purely quoted as an example.
  // - Scoping to (or including) the quote's own interior: a directive or
  //   activation word used INSIDE the quoted text itself — extremely common
  //   in narrated examples and bug reports, e.g. `"please fix autopilot"
  //   they said` or `"...told it to use autopilot..."` — would make the
  //   quote self-report as command-bearing and defeat the exemption for
  //   exactly the reported-speech case it exists to catch.
  // - Checking only execution-directive verbs (fix/debug/...) and not
  //   activation verbs (use/run/start/...): genuine commands stylistically
  //   quoting just the mode name, e.g. `run "ralph" on this issue` or
  //   `use "autopilot" on this task`, would be wrongly suppressed even
  //   though they activated before this exemption existed.
  if (keywordInsideQuotes) {
    const span = findQuotedSpanBounds(text, position);
    const hasGenuineCommandNearQuote = span
      ? /\b(?:fix|debug|investigate|resolve|handle|patch|address|implement|build|use|run|start|enable|activate|invoke|trigger|launch)\b/i.test(
          text.slice(Math.max(0, span.start - 28), span.start) +
            ' ' +
            text.slice(span.end, Math.min(text.length, span.end + 28)),
        )
      : hasExecutionDirective;
    if (!hasGenuineCommandNearQuote) {
      return true;
    }
  }

  // A direct leading invocation is decided by its own line: a command verb
  // right after the keyword or an actionable command after the separator
  // always runs, a help request on that line stays informational, and later
  // prose never suppresses it.
  if (keywordText && hasDirectLeadingInvocation(text, position, keywordLength)) {
    if (hasActionableCommandSeparatorInvocation || hasLeadingCommandVerb(text, position, keywordLength)) {
      return false;
    }
    // English help needs a help-query construction on the line, so task
    // objects such as "update the explanation" stay actionable; the other
    // languages keep their dedicated informational phrasing patterns. A bare
    // prefix line is judged by the first nonempty request line after it.
    const requestLine = getLeadingRequestLine(text, position, keywordLength, line);
    if (hasActionableRequestLine(requestLine)) {
      return false;
    }
    return INFORMATIONAL_INTENT_PATTERNS.slice(1).some((pattern) => pattern.test(requestLine)) ||
      MULTILINGUAL_HELP_REQUEST_PATTERN.test(requestLine) ||
      (INFORMATIONAL_INTENT_PATTERNS[0].test(requestLine) && STRONG_HELP_QUERY_PATTERN.test(requestLine));
  }

  if (keywordText) {
    const hasActivationIntent = hasActivationIntentNearKeyword(context, keywordText);
    if (hasActionableCommandSeparatorInvocation) {
      return false;
    }

    if (isAutopilotCreationAlias(keywordText)) {
      return false;
    }

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

    if (hasConversationalInvocationNearKeyword(text, position, keywordLength, keywordText)) {
      return false;
    }

    if (isRalphMetaOrBanterContext(context, keywordText)) {
      return true;
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

// The Latin autopilot aliases (autopilot, auto pilot, auto-pilot, full auto, fullsend) start the mode only as an
// explicit command, like ralph and ralplan. Without this, a foreign sentence pasted into a prompt
// ("Add tests (autopilot at cap; ...)") armed the mode, because the generic hasActionableKeyword treats every
// mention outside quotes and help questions as a command. The grammar is deliberately small. A sentence is a
// command when all of these hold:
//  1. It is not a question: it does not end in "?" and does not start with a question or auxiliary word
//     (did, does, is, can, what, how, ...), except the request "can/could/would/will you ...".
//  2. It is not negated (don't, can't, never, without, ...) and not a reference label line ("Docs: ...").
//  3. The alias is the first word of the command, followed by a command verb from a closed list (also re-run,
//     double-check), by ":" plus such a verb, or by nothing; at the very start of the prompt any continuation that is
//     not a status line counts. Or an activation phrase stands directly before it: use, run, start, ...
//     (also after please, let's, I want) with an optional the/a/my/our/your, or turn/switch autopilot on.
// "full auto" and "fullsend" are ordinary hardware phrases: only an activation phrase, a line-leading command verb
// or ":" plus a verb count. A line with a non-ASCII letter is not English and keeps the generic check.
//  4. Anything else that passes rules 1 and 2 and is not a status line keeps the generic activation-verb check (an
//     activation verb elsewhere in the clause: "Run in autopilot mode", "fix issue with autopilot in parser module").
// Phrasings beyond this grammar (an open verb list, other languages) are out of scope.
const AUTOPILOT_COMMAND_VERBS = 'fix|debug|investigate|resolve|handle|patch|address|implement|build|create|make|run|start|enable|activate|invoke|trigger|launch|plan|add|write|refactor|update|remove|migrate|finish|continue|do|go|test|review|check|verify|audit|analy[sz]e|inspect|deploy|install|configure|document|explain|find|search|generate|convert|ship|release|merge|prepare|design|draft|upgrade|rename|clean|optimi[sz]e|rewrite|summari[sz]e|compare|bring|ping|seed';
const AUTOPILOT_HYPHENATED_VERB = '(?:re-(?:run|test|check|build|deploy|install|implement|review|verify|try|apply|start|launch|write|format|generate|create)|double-check|cross-check|un-install)';
const AUTOPILOT_COMMAND_WORD = `(?:(?:${AUTOPILOT_COMMAND_VERBS})|${AUTOPILOT_HYPHENATED_VERB})`;
const AUTOPILOT_STATUS_CONTINUATION = '\\s+(?:fails|was|were|is|are|has|had|looks|takes|keeps|hangs|hung|timed\\s+out|succeeds|passes|completes|finishes|works)(?![\\p{L}\\d])|\\s+(?:failed|crashed|errored|ok|okay|done|green|succeeded|passed|completed|finished|worked)(?![\\p{L}\\d])(?=[ \\t]*(?:[.,;:!?)]|\\r?\\n|$)|[ \\t]+(?:on|at|in|with|after|during|for|because|again|twice|and|but|so|before|when|while|since|until|due|once|yesterday|today|overnight|too|earlier|already)(?![\\p{L}\\d]))|\\s+(?:step|phase|exit|status|log|suite|mode|output|report|results?|summary)\\s+(?:\\d+|is|are|was|were|has|had|failed|fails|passed|passes|succeeded|looks|takes|keeps|crashed|errored|ok|okay|red|green)(?![\\p{L}\\d])';
const AUTOPILOT_NOT_A_COMMAND_AFTER = `(?!${AUTOPILOT_STATUS_CONTINUATION})`;
// Words that open a status line after a colon, not a command: articles, pronouns, auxiliaries, prepositions,
// conjunctions, adverbs and status words.
const AUTOPILOT_NON_COMMAND_WORDS = 'a|an|the|this|that|these|those|my|our|your|his|her|its|their|i|we|you|he|she|it|they|me|us|them|is|are|was|were|be|been|am|has|have|had|do|does|did|will|would|can|could|should|may|might|must|shall|not|no|nor|and|or|but|so|if|then|than|as|at|in|on|of|to|for|from|with|by|about|into|onto|over|under|after|before|during|until|while|when|where|which|who|whom|what|why|how|also|just|only|still|already|always|never|now|currently|ready|idle|off|none|nothing|active|inactive|enabled|disabled|available|unavailable|busy|pending|offline|online|yes|here|there|too|very|really|actually|maybe|perhaps|however|hung|hangs|stuck|ran|went|got|took|broke|broken|froze|frozen|became|seems|seemed|remains|lost|left|hit|began|saw|said|gave|found|kept|knew|thought|told|wrote|made|built|sent|spent|stood|held|fell|drew|drove|chose|came|won|threw|grew|met|paid|rose|sold|taught|understood|wore|sat|slept|spoke|swept|sank';
// A plain alias that opens the prompt counts as a command unless it reads as a status line:
// a command verb followed by a result ("autopilot run failed"), or a colon plus a status word or gerund.
const AUTOPILOT_LEADING_STATUS = new RegExp(`^(?:[ \\t]*[:\\uFF1A][ \\t]*(?:(?:${AUTOPILOT_NON_COMMAND_WORDS})|(?!(?:bring|ping|seed|feed|embed|proceed|succeed|speed|need|shred|string|swing|sing|ring|fling|sling|sting|wring|spring|cling)(?![\\p{L}\\d]))\\p{L}*(?:ing|ed))(?![\\p{L}\\d])|[ \\t]+(?:${AUTOPILOT_COMMAND_VERBS})(?![\\p{L}\\d])(?:${AUTOPILOT_STATUS_CONTINUATION}))`, 'iu');
const AUTOPILOT_COMMAND_AFTER = new RegExp(`^(?:[ \\t]*[,;!\\u2014\\u2013][ \\t]*|[ \\t]+-[ \\t]+|[ \\t]+)${AUTOPILOT_COMMAND_WORD}(?![\\p{L}\\d])${AUTOPILOT_NOT_A_COMMAND_AFTER}`, 'iu');
const AUTOPILOT_COLON_VERB = new RegExp(`^[ \\t]*[:\\uFF1A][ \\t]*${AUTOPILOT_COMMAND_WORD}(?![\\p{L}\\d])${AUTOPILOT_NOT_A_COMMAND_AFTER}`, 'iu');
const AUTOPILOT_ALONE_ON_LINE = /^[ \t]*[.!]?[ \t]*(?:\r?\n|$)/;
const AUTOPILOT_NEGATION_BEFORE = /(?<![\p{L}\d])(?:(?:don|doesn|didn|shouldn|couldn|wouldn|can|won|mustn|isn|aren|shan|needn)['’]?t|cannot|do\s+not|never|not|without)\s+(?!(?:just|only|simply|merely|also|solely|stop|quit|forget|fail|hesitat\w*|delay\w*|wait\w*|paus\w*|ask\w*)(?![\p{L}\d]))(?:(?!(?:so|but|and|then|instead|because|now|mind)(?![\p{L}]))[\p{L}'’]+\s+){0,4}$/iu;
// Quotes, emphasis marks and brackets right before the alias do not change what a negation governs.
const AUTOPILOT_OPENING_DELIMITERS_AT_END = /["'“”‘’`*_([{<]+$/;
// A sentence that starts with a question or auxiliary word asks; "can/could/would/will you ..." is a request.
// Imperative "do use" / "do check" is not a question.
const AUTOPILOT_QUESTION_START = /^[ \t]*(?:[-*+>#]+[ \t]+|\d+[.)][ \t]+|\[[ xX]\][ \t]+|["''([*_`])*(?!(?:can|could|would|will)\s+you(?![\p{L}\d]))(?!do\s+not(?![\p{L}\d]))(?!do\s+(?:use|check|fix|test|run|try|build|create|make|implement|execute|invoke|trigger|launch|apply)\s)(?:did|does|do|is|are|was|were|has|have|had|can|could|should|would|will|may|might|must|shall|what|why|how|when|where|who|which)(?![\p{L}\d])/iu;
// The polite request "can/could/would/will you ..." keeps its question mark without being a question.
const AUTOPILOT_REQUEST_START = /^[ \t]*(?:[-*+>#]+[ \t]+|\d+[.)][ \t]+|\[[ xX]\][ \t]+|["'“‘([*_`])*(?:please[ ,]+)?(?:can|could|would|will)\s+you(?![\p{L}\d])/iu;
const AUTOPILOT_SENTENCE_END = /(?<=\S)[.!?][)\]}"'*_\u201D\u2019]*(?=\s|$)/g;
// Markdown emphasis and heading marks around a label ("**Docs:**") do not hide it.
const AUTOPILOT_MARKDOWN_MARKS = /[*_`#>]+/g;
const AUTOPILOT_LIST_PREFIX = /^[\s\-+]*(?:\d+[.)]\s+)?/;
const AUTOPILOT_REFERENCE_LABEL_LINE = /^[ \t]*(?:docs?|documentation|summary|status|logs?|release\s+notes|changelog|readme|examples?|output|result|results|description|title|commit|trigger|triggers|keywords?)[ \t]*:/i;
// A heading line that is only the label ("## Documentation") also marks what follows as reference text.
const AUTOPILOT_REFERENCE_HEADING = /^[ \t]*(?:docs?|documentation|summary|status|logs?|release\s+notes|changelog|readme|examples?|output|result|results|description|title|commit|trigger|triggers|keywords?)[ \t]*:?[ \t]*$/i;
const AUTOPILOT_NOUN_USE_BEFORE = /(?<![\p{L}\d])(?:the|a|an|this|that|these|those|last|previous|our|my|its|your|their)\s+$/iu;
const AUTOPILOT_COMMIT_LINE_BEFORE = /(?<![\p{L}\d])[0-9a-f]{7,40}\s+$/iu;
// A line with any non-ASCII letter (Hangul, kana, Han, Thai, Cyrillic, Arabic, Polish diacritics, ...) is not
// English prose, so the English command grammar cannot judge it and the generic check applies.
const AUTOPILOT_NON_ENGLISH_LINE = /[\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{Script=Thai}]|(?![A-Za-z])\p{L}/u;
// Imperative "use / start" in the common ASCII-only languages (Spanish, French, German, Italian, Portuguese).
const AUTOPILOT_FOREIGN_VERB_BEFORE = /(?<![\p{L}\d])(?:usa|usar|utiliza|utilizar|activa|activar|ejecuta|ejecutar|inicia|iniciar|lanza|utilise|utiliser|active|lance|lancer|nutze|nutzen|benutze|verwende|starte|aktiviere|attiva|avvia|ative|inicie|execute)\s+(?:(?:el|la|le|il|der|die|das)\s+)?$/iu;
// The activation phrase directly before the alias: an activation verb, or please / let's / I want, optionally
// followed by a verb, then an optional the/a/my/our/your. Allow commas after please ("please, use").
const AUTOPILOT_ACTIVATION_BEFORE = /(?<![\p{L}\d])(?:(?:please|let['']?s|i\s+(?:want|need|would\s+like)(?:\s+to)?)[\s,]+(?:(?:use|run|start|enable|activate|invoke|trigger|launch|engage|initiate|begin|kick\s+off|fire\s+up|spin\s+up|turn\s+on|switch\s+to|go(?:\s+with|\s+for)?|set)\s+)?|(?:use|run|start|enable|activate|invoke|trigger|launch|engage|initiate|begin|kick\s+off|fire\s+up|spin\s+up|turn\s+on|switch\s+to|go(?:\s+with|\s+for)?|set)\s+)(?:(?:the|a|my|our|your)\s+)?$/iu;
// "do not stop using autopilot" asks to keep it running, so the negation does not cancel it.
const AUTOPILOT_KEEP_USING_BEFORE = /(?<![\p{L}\d])(?:don['’]?t|do\s+not|never)\s+(?:ever\s+)?(?:stop|quit)\s+using\s+$/iu;
// The separable form "turn autopilot on" / "switch autopilot on": "turn" or "switch" before the alias and "on" right after it.
const AUTOPILOT_TURN_BEFORE = /(?<![\p{L}\d])(?:turn|switch)\s+(?:the\s+|a\s+|my\s+|our\s+|your\s+)?$/iu;
const AUTOPILOT_ON_AFTER = /^[ \t]+on(?![\p{L}\d])/iu;
const AUTOPILOT_NAMESPACE_PREFIX = /^\s*\/?(?:oh-my-(?:claudecode|codex)|omc):\s*$/i;
// Thematic break: a line with only dashes, underscores, or asterisks (with optional spaces).
const AUTOPILOT_THEMATIC_BREAK = /^[ \t]*(?:(?:[-_*])[ \t]*){3,}$/;
const AUTOPILOT_MAX_MATCHES = 1000;
// The costly informational check sees this many characters on each side of a mention, so its cost does not grow
// with the prompt length.
const AUTOPILOT_CONTEXT_WINDOW = 2000;

function hasExplicitAutopilotInvocationContext(
  text: string,
  position: number,
  keywordLength: number,
  keywordText: string,
): boolean {
  if (AUTOPILOT_NAMESPACE_PREFIX.test(text.slice(getLineBounds(text, position).start, position))) return true;
  // $, !, / and force: are explicit invocation syntax.
  const leadingPrefix = hasDirectInvocationPrefix(text, position);
  if (leadingPrefix && /[$/!:]/.test(text.slice(0, position))) return true;
  const { start: lineStart, end: lineEnd } = getLineBounds(text, position);
  // $, ! and slash directly before the alias on its line is explicit invocation syntax, also on a later line.
  if (/^[ \t]*[$/!]$/.test(text.slice(lineStart, position))) return true;
  const headStart = Math.max(lineStart, position - 80);
  const tail = text.slice(headStart, position);
  const afterKeyword = text.slice(position + keywordLength, position + keywordLength + 60);
  const lineHead = text.slice(lineStart, Math.min(position, lineStart + 80));
  // A question never starts the mode: it starts with a question word, or the sentence ends in "?".
  const sentenceHead = /(?:^|[.!?;]\s+)([^.!?;]*)$/.exec(text.slice(Math.max(lineStart, position - 200), position));
  // The clause after a label or an introductory phrase ("Question: Must I ...", "Out of curiosity, should I ...") is what gets classified.
  const clauseHead = (sentenceHead ? sentenceHead[1] : tail).replace(/^.*[,:\u2014\u2013]\s*/, '');
  if (AUTOPILOT_QUESTION_START.test(sentenceHead ? sentenceHead[1] : tail) || AUTOPILOT_QUESTION_START.test(clauseHead)) return false;
  AUTOPILOT_SENTENCE_END.lastIndex = position + keywordLength;
  const sentenceEnd = AUTOPILOT_SENTENCE_END.exec(text);
  // "?" inside a quotation or parenthesis that the sentence continues after ("... from "Ready?" to "Go.") is not terminal.
  // A bare "?" followed by a lowercase word ("rename Ready? to Go.") is a literal, not the end of a question.
  const afterEnd = sentenceEnd === null ? '' : text.slice(sentenceEnd.index + sentenceEnd[0].length, lineEnd);
  const nestedQuestion = sentenceEnd !== null
    && ((sentenceEnd[0].length > 1 && !/^[ \t]*$/.test(afterEnd)) || /^[ \t]+\p{Ll}/u.test(afterEnd));
  if (sentenceEnd && sentenceEnd.index < lineEnd && sentenceEnd[0][0] === '?' && !nestedQuestion && !AUTOPILOT_REQUEST_START.test(clauseHead) && !AUTOPILOT_ACTIVATION_BEFORE.test(tail)) return false;
  // Check for negation first, before the polite-request exemption:
  // "Do not use autopilot (could you check the logs)" should not activate despite the polite request in parentheses.
  if (AUTOPILOT_NEGATION_BEFORE.test(tail) || AUTOPILOT_NEGATION_BEFORE.test(tail.replace(AUTOPILOT_OPENING_DELIMITERS_AT_END, ''))) return false;
  // Check for reference labels before the polite-request exemption.
  if (AUTOPILOT_REFERENCE_LABEL_LINE.test(lineHead.replace(AUTOPILOT_MARKDOWN_MARKS, '').replace(AUTOPILOT_LIST_PREFIX, '').replace(/\s+$/, ''))) return false;
  // Check for status verb + status result followed by parentheses (e.g., "run failed (")
  // This handles cases like "The autopilot run failed (could you check the logs)" which should not activate.
  if (/^[ \t]+(?:run|test|build|deploy|check)[ \t]+(?:failed|passed|succeeded|completed|crashed|errored|hung)(?![\p{L}\d])[ \t]*\(/iu.test(afterKeyword)) return false;
  // Check for a parenthesized question at the end of the sentence: "One question (should I use ...)"
  // But only reject if the keyword is INSIDE that parenthesized clause AND it's a true question.
  // "autopilot fix the parser (why it fails)" activates because the keyword is outside the parens.
  // "Please do the following (use autopilot to replace ? with ! in the template)" activates because
  // the parenthesized clause is not a true question (? is an example character, not sentence-final).
  const sentenceText = text.slice(lineStart, lineEnd).replace(/\s+$/, '');
  if (sentenceText.endsWith(')')) {
    const parenStart = sentenceText.lastIndexOf('(');
    if (parenStart >= 0) {
      const parenContent = sentenceText.slice(parenStart + 1, -1);
      // Calculate if the keyword is inside the parenthesized clause.
      // position is in the full text, lineStart is where the line begins.
      // parenStart is the index within sentenceText (which starts at lineStart).
      const keywordStartInSentence = position - lineStart;
      const keywordEndInSentence = keywordStartInSentence + keywordLength;
      const keywordInsideParens = keywordStartInSentence > parenStart && keywordEndInSentence < sentenceText.length - 1;
      
      if (keywordInsideParens) {
        // Preserve polite-request exemptions: AUTOPILOT_REQUEST_START already exempts "can/could/would/will you"
        if (AUTOPILOT_REQUEST_START.test('(' + parenContent)) return true; // Polite request activates
        // A true question is one that ends with '?' immediately before ')' OR starts with question/auxiliary word.
        // Note: AUTOPILOT_QUESTION_START already excludes "do use/check/fix..." which are imperatives.
        const endsWithQuestion = /\?[ \t]*$/.test(parenContent);
        const startsWithQuestion = AUTOPILOT_QUESTION_START.test('(' + parenContent);
        if (endsWithQuestion || startsWithQuestion) {
          return false; // Reject: keyword is in a true question
        }
      }
    }
  }
  if (AUTOPILOT_NON_ENGLISH_LINE.test(text.slice(lineStart, Math.min(lineEnd, lineStart + 400)))) return true;
  const isHardwareAlias = /^(?:full\s*auto|fullsend)$/i.test((keywordText || '').trim());
  if (leadingPrefix) {
    // A plain alias that opens the prompt counts unless it reads as a status line ("autopilot run failed").
    if (isHardwareAlias) {
      return AUTOPILOT_ALONE_ON_LINE.test(afterKeyword)
        || AUTOPILOT_COLON_VERB.test(afterKeyword)
        || AUTOPILOT_COMMAND_AFTER.test(afterKeyword)
        || /^[ \t]+(?:this|these|that|it|my|our|everything)(?![\p{L}\d])/iu.test(afterKeyword);
    }
    return !AUTOPILOT_LEADING_STATUS.test(afterKeyword);
  }
  if (AUTOPILOT_TURN_BEFORE.test(tail) && AUTOPILOT_ON_AFTER.test(afterKeyword)) return true;
  if (AUTOPILOT_KEEP_USING_BEFORE.test(tail)) return true;
  const atLineStart = /^[ \t]*(?:[$/!][ \t]*)?$/.test(lineHead);
  if (atLineStart && (/[$/!]/.test(lineHead) || AUTOPILOT_ALONE_ON_LINE.test(afterKeyword))) return true;
  if (AUTOPILOT_ACTIVATION_BEFORE.test(tail) || AUTOPILOT_FOREIGN_VERB_BEFORE.test(tail)) return true;
  if (AUTOPILOT_COLON_VERB.test(afterKeyword)) return true;
  if (isHardwareAlias) {
    return (atLineStart && AUTOPILOT_COMMAND_AFTER.test(afterKeyword))
      || hasConversationalInvocationNearKeyword(text, position, keywordLength, keywordText);
  }
  if (AUTOPILOT_NOUN_USE_BEFORE.test(tail) || AUTOPILOT_COMMIT_LINE_BEFORE.test(tail) || AUTOPILOT_LEADING_STATUS.test(afterKeyword)) return false;
  if (AUTOPILOT_COMMAND_AFTER.test(afterKeyword)) return true;
  if (hasConversationalInvocationNearKeyword(text, position, keywordLength, keywordText)) return true;
  return hasActivationIntentNearKeyword(text.slice(Math.max(lineStart, position - INFORMATIONAL_CONTEXT_WINDOW), Math.min(lineEnd, position + keywordLength + INFORMATIONAL_CONTEXT_WINDOW)), keywordText);
}

function findActionableAutopilotAliasMatch(
  text: string,
  pattern: RegExp,
): Omit<DetectedKeyword, 'type'> | null {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  let scanned = 0;

  for (const match of text.matchAll(globalPattern)) {
    if (match.index === undefined) continue;
    if (++scanned > AUTOPILOT_MAX_MATCHES) break;

    const keyword = match[0];
    if (!hasExplicitAutopilotInvocationContext(text, match.index, keyword.length, keyword)) continue;
    // A namespaced or $ / ! / slash-prefixed command is unambiguous, whatever surrounds it.
    const linePrefix = text.slice(getLineBounds(text, match.index).start, match.index);
    if (AUTOPILOT_NAMESPACE_PREFIX.test(linePrefix) || /^[ \t]*[$/!]$/.test(linePrefix)) {
      return { keyword, position: match.index };
    }
    // A command that opens its line with a command verb is judged on its own line, so a help question on an
    // earlier line does not veto it; every other mention is judged on a bounded window around it.
    const { start: lineStart, end: lineEnd } = getLineBounds(text, match.index);
    let previousLine = '';
    for (let end = lineStart - 1; end > 0 && (!previousLine.trim() || AUTOPILOT_THEMATIC_BREAK.test(previousLine));) {
      const start = text.lastIndexOf('\n', end - 1) + 1;
      previousLine = text.slice(start, end);
      end = start - 1;
    }
    const afterAlias = text.slice(match.index + keyword.length, match.index + keyword.length + 60);
    const ownLine = /^[ \t]*$/.test(linePrefix)
      && !AUTOPILOT_REFERENCE_HEADING.test(previousLine.replace(AUTOPILOT_MARKDOWN_MARKS, '').replace(AUTOPILOT_LIST_PREFIX, '').replace(/\s+$/, ''))
      && (AUTOPILOT_COMMAND_AFTER.test(afterAlias) || AUTOPILOT_COLON_VERB.test(afterAlias));
    const from = ownLine ? lineStart : Math.max(0, match.index - AUTOPILOT_CONTEXT_WINDOW);
    const to = ownLine ? lineEnd : match.index + keyword.length + AUTOPILOT_CONTEXT_WINDOW;
    if (isInformationalKeywordContext(text.slice(from, to), match.index - from, keyword.length, keyword)) continue;

    return { keyword, position: match.index };
  }

  return null;
}

function findActionableAutopilotMatch(
  text: string,
): Omit<DetectedKeyword, 'type'> | null {
  // Only the Latin aliases need a command; the creation phrases and the
  // Korean and Japanese aliases keep the generic check.
  // When both classes match, the earlier (then longer) match wins, as in the combined pattern.
  const alias = findActionableAutopilotAliasMatch(text, AUTOPILOT_ALIAS_PATTERN);
  const other = findActionableKeywordMatch(text, AUTOPILOT_OTHER_PATTERN);
  if (!alias || !other) return alias ?? other;
  if (other.position !== alias.position) return other.position < alias.position ? other : alias;
  return other.keyword.length > alias.keyword.length ? other : alias;
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

  if (isRetiredWorkflowSlashInvocation(text)) {
    return detected;
  }

  // Check for an explicit canonical workflow slash invocation BEFORE sanitization.
  // The general sanitizer strips bare `/word` tokens as file paths, so bare
  // commands like `/ralph fix auth` would otherwise never match. This must be
  // robust to surrounding whitespace, namespace prefixes (`/omc:`,
  // `/oh-my-claudecode:`), and code-fence/backtick wrapping (handled inside
  // the parser via removeCodeBlocks).
  const explicitSlash = parseExplicitWorkflowSlashInvocation(text);
  const explicitSlashType = explicitSlash
    ? SLASH_SKILL_TO_KEYWORD_TYPE[explicitSlash.skill]
    : undefined;
  if (explicitSlash && explicitSlashType) {
    const position = Math.max(0, text.indexOf(explicitSlash.raw.trim()));
    detected.push({
      type: explicitSlashType,
      keyword: explicitSlash.raw.trim(),
      position,
    });
  }

  const cleanedText = sanitizeForKeywordDetection(text);

  // Check each keyword type
  for (const type of KEYWORD_PRIORITY) {
    // Team keyword detection disabled — team mode is now explicit-only via /team skill
    if (type === 'team') {
      continue;
    }

    // Skip the type that the explicit-slash detector already surfaced so we
    // do not emit duplicate entries for the same intent.
    if (explicitSlashType && type === explicitSlashType) {
      continue;
    }

    const pattern = KEYWORD_PATTERNS[type];
    const skipPredicate = KEYWORD_SKIP_PREDICATES[type];
    if (skipPredicate && skipPredicate(cleanedText)) {
      continue;
    }
    const match =
      type === 'ralplan'
        ? findActionableRalplanMatch(cleanedText, pattern)
        : type === 'autopilot'
          ? findActionableAutopilotMatch(cleanedText)
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

const CODE_EDITING_KEYWORDS = new Set<KeywordType>(['autopilot', 'ralph', 'tdd']);
const NO_IMPLEMENT_PATTERN = /\b(?:do\s+not|don'?t|never|without)\s+(?:begin\s+|start\s+)?implement(?:ing|ation)?\b|\bno\s+(?:code\s+)?(?:changes|edits)\b|\bread[\s-]only\s+(?:review|audit|investigation)\b/i;

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

  // A prompt that forbids implementation never auto-routes to a code-editing mode
  // (slash commands are explicit and keep their mode).
  if (NO_IMPLEMENT_PATTERN.test(removeCodeBlocks(text)) && !/^\s*\//.test(text)) {
    types = types.filter(t => !CODE_EDITING_KEYWORDS.has(t));
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
  /** Jev-provided task size result (used in active mode). Overrides heuristic if provided. */
  jevTaskSizeResult?: TaskSizeResult;
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
 * For small tasks, heavy orchestration modes (ralph/autopilot/team etc.)
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
    jevTaskSizeResult,
  } = options;

  const keywords = getAllKeywords(text);

  if (!enabled || !suppressHeavyModesForSmallTasks || keywords.length === 0) {
    return { keywords, taskSizeResult: jevTaskSizeResult ?? null, suppressedKeywords: [] };
  }

  const thresholds: TaskSizeThresholds = { smallWordLimit, largeWordLimit };
  const taskSizeResult = jevTaskSizeResult ?? classifyTaskSize(text, thresholds);

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
    .replace(/\b(?:ralph|autopilot|team)\b/gi, '')
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
