#!/usr/bin/env node

/**
 * OMC Keyword Detector Hook (Node.js)
 * Detects magic keywords and invokes skill tools
 * Cross-platform: Windows, macOS, Linux
 *
 * Supported keywords (in priority order):
 * 1. cancelomc/stopomc: Stop active modes
 * 2. ralph: Persistence mode until task completion
 * 3. autopilot: Full autonomous execution
 * 4. team: Explicit-only via /team (not auto-triggered)
 * 5. ultrawork/ulw: Maximum parallel execution
 * 5. ccg: Claude-Codex-Gemini tri-model orchestration
 * 6. ralplan: Iterative planning with consensus
 * 7. deep interview: Socratic interview workflow
 * 8. ai-slop-cleaner: Cleanup/deslop anti-slop workflow
 * 9. tdd: Test-driven development
 * 10. code review: Comprehensive review mode
 * 11. security review: Security-focused review mode
 * 12. ultrathink: Extended reasoning
 * 13. deepsearch: Codebase search (restricted patterns)
 * 14. analyze: Analysis mode (restricted patterns)
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { getClaudeConfigDir } from './lib/config-dir.mjs';
import { atomicWriteFileSync } from './lib/atomic-write.mjs';
import { readStdin } from './lib/stdin.mjs';
import { resolveOmcStateRoot } from './lib/state-root.mjs';

// Resolve OMC package root: CLAUDE_PLUGIN_ROOT (plugin system) or derive from this script's location
const _omcRoot = process.env.CLAUDE_PLUGIN_ROOT ||
  join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_INVOCATION_USER_REQUEST_MAX = 1200;

const RALPLAN_FOLLOWUP_TERMINAL_PHASES = new Set([
  'completed',
  'complete',
  'failed',
  'cancelled',
  'canceled',
  'aborted',
  'terminated',
  'done',
  'handoff',
  'pending approval',
  'pending-approval',
  'pending_approval',
  'awaiting approval',
  'awaiting-approval',
  'awaiting_approval',
  'approval-required',
  'approval_required',
]);

function normalizeRalplanFollowupPhase(state) {
  if (!state || typeof state !== 'object') return null;
  const raw = state.current_phase ?? state.phase ?? state.status;
  if (typeof raw !== 'string') return null;
  const phase = raw.trim().toLowerCase();
  if (!phase) return null;
  if (phase === 'handoff' || phase.startsWith('handoff:') || phase.startsWith('handoff-')) return 'handoff';
  return phase;
}

function readRalplanFollowupState(statePaths, sessionId) {
  const safeSessionId = sessionId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId) ? sessionId : '';
  for (const statePath of statePaths) {
    try {
      if (!existsSync(statePath)) continue;
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      if (!state || typeof state !== 'object') continue;
      if (safeSessionId && typeof state.session_id === 'string' && state.session_id !== safeSessionId) continue;
      return state;
    } catch { /* ignore malformed state */ }
  }
  return null;
}

function isRalplanFollowupTerminal(state) {
  if (!state || typeof state !== 'object') return false;
  if (state.active === true) return false;
  const phase = normalizeRalplanFollowupPhase(state);
  return Boolean(phase && RALPLAN_FOLLOWUP_TERMINAL_PHASES.has(phase));
}

function compactHookText(text, maxChars = SKILL_INVOCATION_USER_REQUEST_MAX) {
  const notice = '\n...[truncated; original user prompt remains available in the conversation]';
  if (!text || text.length <= maxChars) return text || '';
  if (maxChars <= notice.length) return notice.slice(0, Math.max(0, maxChars));
  return `${text.slice(0, maxChars - notice.length).trimEnd()}${notice}`;
}

function getSkillPathCandidates(skillName) {
  const roots = [
    process.env.CLAUDE_PLUGIN_ROOT,
    _omcRoot,
    process.cwd(),
  ].filter(Boolean);
  return [...new Set(roots.map(root => join(root, 'skills', skillName, 'SKILL.md')))];
}

function resolveSkillPath(skillName) {
  for (const skillPath of getSkillPathCandidates(skillName)) {
    if (existsSync(skillPath)) return skillPath;
  }
  return getSkillPathCandidates(skillName)[0] || `skills/${skillName}/SKILL.md`;
}

const ULTRATHINK_MESSAGE = `<think-mode>

**ULTRATHINK MODE ENABLED** - Extended reasoning activated.

You are now in deep thinking mode. Take your time to:
1. Thoroughly analyze the problem from multiple angles
2. Consider edge cases and potential issues
3. Think through the implications of each approach
4. Reason step-by-step before acting

Use your extended thinking capabilities to provide the most thorough and well-reasoned response.

</think-mode>

---
`;

const SEARCH_MESSAGE = `<search-mode>
MAXIMIZE SEARCH EFFORT. Launch multiple background agents IN PARALLEL:
- explore agents (codebase patterns, file structures)
- document-specialist agents (remote repos, official docs, GitHub examples)
Plus direct tools: Grep, Glob
NEVER stop at first result - be exhaustive.
</search-mode>

---
`;

const ANALYZE_MESSAGE = `<analyze-mode>
ANALYSIS MODE. Gather context before diving deep:
- Search relevant code paths first
- Compare working vs broken behavior
- Synthesize findings before proposing changes
</analyze-mode>

---
`;

const TDD_MESSAGE = `<tdd-mode>
[TDD MODE ACTIVATED]
Write or update tests first when practical, confirm they fail for the right reason, then implement the minimal fix and re-run verification.
</tdd-mode>

---
`;

const CODE_REVIEW_MESSAGE = `<code-review-mode>
[CODE REVIEW MODE ACTIVATED]
Perform a comprehensive code review of the relevant changes or target area. Focus on correctness, maintainability, edge cases, regressions, and test adequacy before recommending changes.
</code-review-mode>

---
`;

const SECURITY_REVIEW_MESSAGE = `<security-review-mode>
[SECURITY REVIEW MODE ACTIVATED]
Perform a focused security review of the relevant changes or target area. Check trust boundaries, auth/authz, data exposure, input validation, command/file access, secrets handling, and escalation risks before recommending changes.
</security-review-mode>

---
`;

const MODE_MESSAGE_KEYWORDS = new Map([
  ['ultrathink', ULTRATHINK_MESSAGE],
  ['deepsearch', SEARCH_MESSAGE],
  ['analyze', ANALYZE_MESSAGE],
  ['tdd', TDD_MESSAGE],
  ['code-review', CODE_REVIEW_MESSAGE],
  ['security-review', SECURITY_REVIEW_MESSAGE],
]);

// Extract prompt from various JSON structures
function extractPrompt(input) {
  try {
    const data = JSON.parse(input);
    if (data.prompt) return data.prompt;
    if (data.message?.content) return data.message.content;
    if (Array.isArray(data.parts)) {
      return data.parts
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join(' ');
    }
    return '';
  } catch {
    // Fail closed: don't risk false-positive keyword detection from malformed input
    return '';
  }
}

function isExplicitRalplanSlashInvocation(prompt) {
  return /^\s*\/(?:oh-my-claudecode:)?ralplan(?:\s|$)/i.test(prompt);
}

function isExplicitAskSlashInvocation(prompt) {
  return /^\s*\/(?:oh-my-claudecode:)?ask\s+(?:claude|codex|gemini|grok|cursor)\b/i.test(prompt);
}

// Sanitize text to prevent false positives from code blocks, XML tags, URLs, and file paths
const ANTI_SLOP_EXPLICIT_PATTERN = /\b(ai[\s-]?slop|anti[\s-]?slop|deslop|de[\s-]?slop)\b/i;
const ANTI_SLOP_ACTION_PATTERN = /\b(clean(?:\s*up)?|cleanup|refactor|simplify|dedupe|de-duplicate|prune)\b/i;
const ANTI_SLOP_SMELL_PATTERN = /\b(slop|duplicate(?:d|s)?|duplication|dead\s+code|unused\s+code|over[\s-]?abstract(?:ion|ed)?|wrapper\s+layers?|boundary\s+violations?|needless\s+abstractions?|unnecessary\s+abstractions?|ai[\s-]?generated|generated\s+code|tech\s+debt)\b/i;

function isAntiSlopCleanupRequest(text) {
  return ANTI_SLOP_EXPLICIT_PATTERN.test(text) ||
    (ANTI_SLOP_ACTION_PATTERN.test(text) && ANTI_SLOP_SMELL_PATTERN.test(text));
}

/** Review-outcome labels that appear together in seeded review instruction text. */
const REVIEW_SEED_OUTCOME_RES = [
  /\bapprove\b/i,
  /\brequest[- ]changes\b/i,
  /\bmerge[- ]ready\b/i,
  /\bblocked\b/i,
];

/**
 * Returns true when the prompt looks like echoed review-instruction text
 * (an injected outcome menu: approve / request-changes / merge-ready / blocked),
 * not a genuine user intent to start review mode.
 *
 * Heuristic: ≥2 distinct outcome labels in the first 20 lines → seeded context.
 */
function isReviewSeedContext(text) {
  const preview = text.split('\n').slice(0, 20).join('\n');
  return REVIEW_SEED_OUTCOME_RES.filter(re => re.test(preview)).length >= 2;
}

function sanitizeForKeywordDetection(text) {
  return stripPastedCommandPayloads(text)
    // 0. Strip HTML/markdown comments before tag stripping
    .replace(/<!--[\s\S]*?-->/g, '')
    // 1. Strip XML-style tag blocks: <tag-name ...>...</tag-name> (multi-line, greedy on tag name)
    .replace(/<(\w[\w-]*)[\s>][\s\S]*?<\/\1>/g, '')
    // 2. Strip self-closing XML tags: <tag-name />, <tag-name attr="val" />
    .replace(/<\w[\w-]*(?:\s[^>]*)?\s*\/>/g, '')
    // 3. Strip URLs: http://... or https://... up to whitespace
    .replace(/https?:\/\/[^\s)>\]]+/g, '')
    // 3.5 Strip block quotes and markdown table rows - these are usually reference content
    .replace(/^\s*>\s.*$/gm, '')
    .replace(/^\s*\|(?:[^|\n]*\|){2,}\s*$/gm, '')
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|){1,}\s*$/gm, '')
    // 4. Strip file paths — uses lookbehind (Node.js supports it). Requires at least one
    // slash-terminated directory segment (?:SEG+\/)+ so bare slash-commands like /ralph are NOT
    // stripped (the .mjs has no pre-sanitization slash handler for them). Directory/stem segments
    // are Unicode-aware (\w.- plus the NON_LATIN_SCRIPT_PATTERN ranges) so CJK file names like
    // docs/コードレビュー.md are stripped. The final segment is bounded: a CJK-capable stem ending
    // in a .ext, OR an ASCII-only extensionless name — so a no-space CJK directive following a path
    // (e.g. src/auth.tsをコードレビューして) is NOT consumed by a greedy CJK tail and the alias
    // still activates.
    .replace(/(?<=^|[\s"'`(])(?:\/)?(?:[\w.\-　-鿿가-힯Ѐ-ӿ؀-ۿऀ-ॿ฀-๿က-႟]+\/)+(?:[\w.\-　-鿿가-힯Ѐ-ӿ؀-ۿऀ-ॿ฀-๿က-႟]*\.\w+|[\w.\-]+)/gm, '')
    // 5. Strip markdown code blocks (existing)
    .replace(/```[\s\S]*?```/g, '')
    // 6. Strip inline code (existing)
    .replace(/`[^`]+`/g, '');
}

const PASTED_MAGIC_KEYWORD_HEADER_PATTERN =
  /^\s*\[MAGIC KEYWORDS?(?: DETECTED)?:.*$/i;
const ROLE_BOUNDARY_PATTERN =
  /^<\s*\/?\s*(system|human|assistant|user|tool_use|tool_result)\b[^>]*>/i;
const SKILL_TRANSCRIPT_LINE_PATTERN =
  /^\s*Skill:\s+oh-my-(?:claudecode|codex):/i;
const USER_REQUEST_LINE_PATTERN = /^\s*User request(?:\s*\([^)]*\))?:\s*$/i;
const SHELL_TRANSCRIPT_LINE_PATTERN = /^\s*[$%❯]\s+/;
const GIT_DIFF_START_PATTERNS = [
  /^diff\s+--git\s+a\//,
  /^index\s+[0-9a-f]+\.\.[0-9a-f]+(?:\s+\d+)?$/i,
  /^(?:---|\+\+\+)\s+[ab]\//,
  /^@@\s+-\d+/,
];
const GIT_DIFF_CONTINUATION_PATTERNS = [
  /^new file mode\s+\d+$/i,
  /^deleted file mode\s+\d+$/i,
  /^similarity index\s+\d+%$/i,
  /^rename (?:from|to)\s+/i,
  /^Binary files .+ differ$/i,
  /^(?:diff\s+--git\s+a\/|index\s+[0-9a-f]+\.\.[0-9a-f]+|(?:---|\+\+\+)\s+[ab]\/|@@\s+-\d+)/i,
  /^[ +\-].*/,
];

function stripPastedCommandPayloads(text) {
  const lines = text.split('\n');
  const sanitized = [];
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

const INFORMATIONAL_INTENT_PATTERNS = [
  /\b(?:what(?:'s|\s+is)|what\s+are|how\s+(?:to|do\s+i)\s+use|explain|explanation|tell\s+me\s+about|describe)\b/i,
  /(?:뭐야|뭔데|무엇(?:이야|인가요)?|어떻게|설명(?!서\s*(?:작성|만들|생성|추가|업데이트|수정|편집|쓰))|사용법|알려\s?줘|알려줄래|소개해?\s?줘|소개\s*부탁|설명해\s?줘|뭐가\s*달라|어떤\s*기능|기능\s*(?:알려|설명|뭐)|방법\s*(?:알려|설명|뭐))/u,
  /(?:とは|って何|使い方|説明|(?:について|に関して|違い)[^\n]{0,24}(?:教えて|説明|知りたい)|(?:どう|何が|どこが)違う)/u,
  /(?:什么是|什麼是|怎(?:么|樣)用|如何使用|解释|說明|说明)/u,
];
const INFORMATIONAL_CONTEXT_WINDOW = 80;
const QUOTED_SPAN_PATTERN =
  /"[^"\n]{1,400}"|'[^'\n]{1,400}'|“[^”\n]{1,400}”|‘[^’\n]{1,400}’/g;
const REFERENCE_META_PATTERNS = [
  /\b(?:vs\.?|versus|compared\s+to|comparison|compare|article|blog\s+post|documentation|docs?|reference)\b/i,
  /(?:비교|차이|설명|정리|문서|자료|가이드|이\s*(?:글|비교|문서)는|블로그)/u,
  /\b(?:this\s+(?:article|comparison|guide|documentation|doc)|quoted|quote(?:d)?)\b/i,
];
const REFERENCE_EXPLANATION_PATTERNS = [
  /(?:^|\n)\s*(?:결론|특징|예시|요약|장점|단점|설명)\s*[:：]/u,
  /\b(?:summary|conclusion|key\s+points?|example|examples|pros|cons|overview)\s*:/i,
  /[^\n]{1,80}=\s*["“]/,
  /[→⇒]/,
];
const QUESTION_FOLLOWUP_PATTERNS = [
  /\b(?:how\s+many|how\s+much|why|what\s+happened|what\s+went\s+wrong|token\s+budget|cost|pricing)\b/i,
  /(?:왜|얼마|몇\s*번|몇번|토큰|가격|비용|질문)/u,
];

// Patterns that identify system-generated echoes (hook outputs) which can be
// pasted back into the prompt verbatim. If a mode keyword only appears inside
// such an echo block we MUST NOT re-activate the mode: otherwise a user who
// copies a "[RALPH LOOP - ITERATION N] ..." block into a new session to debug
// it will unintentionally re-trigger ralph, and the pasted text ends up as
// the new state.prompt — producing a recursive self-reinforcing loop.
// Continuation lines that hook output typically emits DIRECTLY after a
// recognized block header. They must be stripped only in that context —
// never standalone — because a user might legitimately start a prompt with
// "Task: …" or similar (Codex automated review P1/P2 on #2795).
const ECHO_CONTINUATION = '(?:\\r?\\n[ \\t]*(?:Task:\\s|When FULLY complete \\(after Architect verification\\)|run\\s+\\/oh-my-claudecode:cancel).*)*';

// NOTE: each pattern is a SINGLE LOGICAL BLOCK: the block header line +
// zero-or-more continuation lines that hooks emit right after it. The whole
// match is stripped together. Both `i` (case-insensitive against the
// lower-cased cleanPrompt upstream) and `m` (so `^`/`$` match line
// boundaries) are required.
function buildEchoBlockRegex(headerBody) {
  return new RegExp(`^[ \\t]*${headerBody}.*${ECHO_CONTINUATION}$`, 'gim');
}

const SYSTEM_ECHO_BLOCK_PATTERNS = [
  // persistent-mode.mjs block headers
  buildEchoBlockRegex('\\[RALPH LOOP\\s*-\\s*ITERATION[^\\]\\n]*\\]'),
  buildEchoBlockRegex('\\[RALPH LOOP\\s*-\\s*(?:HARD LIMIT|EXTENDED)\\]'),
  buildEchoBlockRegex('\\[TEAM\\s*-\\s*Phase:[^\\]\\n]*\\]'),
  buildEchoBlockRegex('\\[AUTOPILOT[^\\]\\n]*\\]'),
  buildEchoBlockRegex('\\[ULTRAPILOT[^\\]\\n]*\\]'),
  buildEchoBlockRegex('\\[ULTRAWORK[^\\]\\n]*\\]'),
  buildEchoBlockRegex('\\[ULTRAQA[^\\]\\n]*\\]'),
  buildEchoBlockRegex('\\[PIPELINE[^\\]\\n]*\\]'),
  buildEchoBlockRegex('\\[SWARM[^\\]\\n]*\\]'),
  buildEchoBlockRegex('\\[TOOL ERROR[^\\]\\n]*\\]'),
  // keyword-detector.mjs block headers
  buildEchoBlockRegex('\\[MAGIC KEYWORD:[^\\]\\n]*\\]'),
  buildEchoBlockRegex('\\[MAGIC KEYWORDS DETECTED:[^\\]\\n]*\\]'),
  // Stop-hook wrapping by the Claude Code harness
  buildEchoBlockRegex('Stop hook (?:blocking error|feedback|stopped continuation)'),
  buildEchoBlockRegex('PreToolUse:[^\\n]*hook additional context:'),
  buildEchoBlockRegex('PostToolUse:[^\\n]*hook additional context:'),
];

// Signature lines indicating the text is predominantly a system echo. Even
// when the block patterns above fail to delimit cleanly (e.g. truncation),
// presence of these sentinels should make us treat the prompt as an echo.
// All patterns use `i` because hasActionableKeyword sees a lowercased prompt.
const SYSTEM_ECHO_SIGNATURES = [
  /\bWhen FULLY complete \(after Architect verification\)\b/i,
  /\brun\s+\/oh-my-claudecode:cancel\b/i,
  /\[RALPH LOOP\s*-\s*ITERATION\b/i,
];

const MAX_STATE_PROMPT_LEN = 500;

function stripSystemEchoes(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  let cleaned = text;
  for (const pattern of SYSTEM_ECHO_BLOCK_PATTERNS) {
    cleaned = cleaned.replace(pattern, ' ');
  }
  return cleaned;
}

function looksLikeSystemEcho(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (SYSTEM_ECHO_SIGNATURES.some((pattern) => pattern.test(text))) return true;
  // Also treat the presence of ANY echo block pattern as an echo, so that
  // mode-specific paste blocks (AUTOPILOT, ULTRAWORK, TEAM, etc.) are
  // recognized without needing a dedicated signature line.
  for (const pattern of SYSTEM_ECHO_BLOCK_PATTERNS) {
    const probe = new RegExp(pattern.source, pattern.flags.replace('g', ''));
    if (probe.test(text)) return true;
  }
  return false;
}

/**
 * Sanitize a prompt before persisting it to a *-state.json file.
 * Returning the raw prompt risks storing large system echoes or pasted
 * hook output, which persistent-mode.mjs would then blast back into the
 * next Stop-hook block reason on every iteration.
 *
 * Strategy:
 * 1. Strip echoes first. If non-empty content remains AND that remainder no
 *    longer looks like an echo, keep it (preserves the real user request in
 *    an "echo + blank line + real request" paste).
 * 2. Otherwise, if the raw prompt looks like a pure echo, substitute the
 *    placeholder sentinel.
 * 3. Finally, hard-truncate to MAX_STATE_PROMPT_LEN chars.
 */
function sanitizePromptForState(prompt) {
  if (typeof prompt !== 'string') return '';
  const trimmed = prompt.trim();
  if (!trimmed) return '';

  const stripped = stripSystemEchoes(trimmed).trim();
  if (stripped.length > 0 && !looksLikeSystemEcho(stripped)) {
    return stripped.length > MAX_STATE_PROMPT_LEN
      ? `${stripped.slice(0, MAX_STATE_PROMPT_LEN - 3)}...`
      : stripped;
  }

  if (looksLikeSystemEcho(trimmed)) {
    return '(prompt omitted: pasted system echo)';
  }

  // Fallback (stripping left nothing but original isn't recognizably an echo)
  const base = stripped.length > 0 ? stripped : trimmed;
  return base.length > MAX_STATE_PROMPT_LEN
    ? `${base.slice(0, MAX_STATE_PROMPT_LEN - 3)}...`
    : base;
}
const MODE_REFERENCE_PATTERN =
  /\b(?:ralph|autopilot|auto[\s-]?pilot|ultragoal|ultrawork|ulw|ralplan|ultrathink|deepsearch|deep[\s-]?analyze|deepanalyze|deep[\s-]interview|ouroboros|ccg|claude-codex-gemini|deerflow)\b/gi;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getLineBounds(text, position) {
  const start = text.lastIndexOf('\n', Math.max(0, position - 1)) + 1;
  const nextNewline = text.indexOf('\n', position);
  const end = nextNewline === -1 ? text.length : nextNewline;
  return { start, end };
}

function isWithinQuotedSpan(text, position) {
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

function stripQuotedSpans(text) {
  return text.replace(QUOTED_SPAN_PATTERN, ' ');
}

function countDistinctModeReferences(text) {
  const matches = text.match(MODE_REFERENCE_PATTERN) ?? [];
  const normalized = new Set(
    matches.map((match) => match.toLowerCase().replace(/\s+/g, '').replace(/-/g, '')),
  );
  return normalized.size;
}

function looksLikeReferenceContent(text) {
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

function hasActivationIntentNearKeyword(context, keyword) {
  const escaped = escapeRegExp((keyword || '').trim());
  if (!escaped) return false;

  const patterns = [
    new RegExp(`\\b(?:use|run|start|enable|activate|invoke|trigger|launch)\\b[^\\n]{0,28}\\b${escaped}\\b`, 'i'),
    new RegExp(`\\b(?:fix|debug|investigate|resolve|handle|patch|address)\\b[^\\n]{0,28}\\b(?:issue|bug|problem|error)\\b[^\\n]{0,12}\\b(?:with|in)\\s+\\b${escaped}\\b`, 'i'),

  ];

  return patterns.some((pattern) => pattern.test(context));
}

function hasDirectInvocationPrefix(text, position) {
  const prefix = text.slice(0, position);
  return /^\s*(?:[$/!]\s*|force:\s*|oh-my-(?:claudecode|codex):\s*)?$/i.test(prefix);
}

function hasExplicitInvocationContext(text, position, keywordLength, keywordText) {
  if (hasDirectInvocationPrefix(text, position)) {
    return true;
  }

  const start = Math.max(0, position - INFORMATIONAL_CONTEXT_WINDOW);
  const end = Math.min(text.length, position + keywordLength + INFORMATIONAL_CONTEXT_WINDOW);
  const context = text.slice(start, end);
  return hasActivationIntentNearKeyword(context, keywordText);
}

function hasDiagnosticIntentNearKeyword(context, keyword) {
  const escaped = escapeRegExp((keyword || '').trim());
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

function isRalphUltraworkMetaOrBanterContext(context, keywordText) {
  const normalizedKeyword = (keywordText || '').toLowerCase().replace(/\s+/g, '');
  if (!['ralph', '랄프', 'ラルフ', 'ultrawork', 'ulw', 'uw', '울트라워크', 'ウルトラワーク'].includes(normalizedKeyword)) {
    return false;
  }

  const currentKeywordAliases = normalizedKeyword === 'ralph' || normalizedKeyword === '랄프' || normalizedKeyword === 'ラルフ'
    ? ['랄프', 'ラルフ']
    : ['울트라워크', 'ウルトラワーク'];
  const currentKeywordPattern = currentKeywordAliases.join('|');
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
    /(?:ralph|랄프|ultrawork|ulw|uw|울트라워크).{0,40}(?:라도|줘야\s*해|쥐어\s*줘야\s*해|해야\s*해).{0,20}[?？]/iu,
    /(?:관계|관련|연관|차이|비교).{0,40}(?:뭐|무엇|어떻게|설명|알려|궁금|인가|야|냐|니|까|[?？])/u,
    /(?:뭐|무엇|어떻게|설명|알려|궁금).{0,40}(?:관계|관련|연관|차이|비교)/u,
  ];

  return metaOrBanterPatterns.some((pattern) => pattern.test(context));
}

function isInformationalKeywordContext(text, position, keywordLength, keywordText) {
  const start = Math.max(0, position - INFORMATIONAL_CONTEXT_WINDOW);
  const end = Math.min(text.length, position + keywordLength + INFORMATIONAL_CONTEXT_WINDOW);
  const context = text.slice(start, end);
  const lineBounds = getLineBounds(text, position);
  const line = text.slice(lineBounds.start, lineBounds.end);
  const questionOutsideQuotes = stripQuotedSpans(text);
  const keywordInsideQuotes = isWithinQuotedSpan(text, position);

  if (keywordText) {
    if (hasActivationIntentNearKeyword(context, keywordText)) {
      return false;
    }
    if (isRalphUltraworkMetaOrBanterContext(context, keywordText)) {
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

  return INFORMATIONAL_INTENT_PATTERNS.some((pattern) => pattern.test(context));
}

function hasActionableKeyword(text, pattern) {
  // Strip system-generated echo blocks (persistent-mode/keyword-detector
  // outputs, Stop-hook wrappers) BEFORE searching for keywords. Otherwise
  // pasting a previous "[RALPH LOOP - ITERATION N] ..." block into a prompt
  // would re-activate ralph mode and the echo itself would be saved as
  // state.prompt, which persistent-mode.mjs then blasts back on every
  // iteration — a self-reinforcing loop that is hard to cancel.
  const searchText = looksLikeSystemEcho(text)
    ? stripSystemEchoes(text)
    : text;

  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);

  for (const match of searchText.matchAll(globalPattern)) {
    if (match.index === undefined) {
      continue;
    }

    if (isInformationalKeywordContext(searchText, match.index, match[0].length, match[0])) {
      continue;
    }

    return true;
  }

  return false;
}

function hasExplicitWorkflowInvocationContext(text, position, keywordLength, keywordText) {
  const prefix = text.slice(0, position);
  if (/^\s*(?:[$/!]\s*|force:\s*|oh-my-(?:claudecode|codex):\s*)$/i.test(prefix)) {
    return true;
  }

  const start = Math.max(0, position - INFORMATIONAL_CONTEXT_WINDOW);
  const end = Math.min(text.length, position + keywordLength + INFORMATIONAL_CONTEXT_WINDOW);
  const context = text.slice(start, end);
  return hasActivationIntentNearKeyword(context, keywordText);
}

function hasExplicitActionableKeyword(text, pattern) {
  const searchText = looksLikeSystemEcho(text)
    ? stripSystemEchoes(text)
    : text;

  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);

  for (const match of searchText.matchAll(globalPattern)) {
    if (match.index === undefined) {
      continue;
    }

    if (isInformationalKeywordContext(searchText, match.index, match[0].length, match[0])) {
      continue;
    }

    if (!hasExplicitWorkflowInvocationContext(searchText, match.index, match[0].length, match[0])) {
      continue;
    }

    return true;
  }

  return false;
}

function hasActionableRalplanKeyword(text, pattern) {
  // Same echo guard as hasActionableKeyword.
  const searchText = looksLikeSystemEcho(text)
    ? stripSystemEchoes(text)
    : text;

  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);

  for (const match of searchText.matchAll(globalPattern)) {
    if (match.index === undefined) {
      continue;
    }

    // match.index is relative to searchText — use searchText for all
    // downstream context lookups to keep indices aligned.
    if (isInformationalKeywordContext(searchText, match.index, match[0].length, match[0])) {
      continue;
    }

    if (!hasExplicitInvocationContext(searchText, match.index, match[0].length, match[0])) {
      continue;
    }

    return true;
  }

  return false;
}

// Create state file for a mode
function activateState(directory, prompt, stateName, sessionId, omcRoot) {
  const _omcRoot = omcRoot;
  const now = new Date().toISOString();
  // Sanitize prompt BEFORE writing to state: prevents pasted system echoes
  // and oversized blobs from being persisted and re-emitted by Stop hook.
  const safePrompt = sanitizePromptForState(prompt);
  let state;

  if (stateName === 'ralph') {
    // Ralph needs specific fields for proper loop tracking
    state = {
      active: true,
      iteration: 1,
      max_iterations: 100,
      started_at: now,
      prompt: safePrompt,
      session_id: sessionId || undefined,
      project_path: directory,
      linked_ultrawork: true,
      awaiting_confirmation: true,
      awaiting_confirmation_set_at: now,
      last_checked_at: now
    };
  } else if (stateName === 'ralplan') {
    // Ralplan needs active + session_id for stop-hook enforcement
    state = {
      active: true,
      started_at: now,
      session_id: sessionId || undefined,
      project_path: directory,
      awaiting_confirmation: true,
      awaiting_confirmation_set_at: now,
      last_checked_at: now
    };
  } else if (stateName === 'ultragoal') {
    // Ultragoal persists a durable goal workflow and requires Claude /goal parity.
    state = {
      active: true,
      started_at: now,
      current_phase: 'executing',
      original_prompt: safePrompt,
      session_id: sessionId || undefined,
      project_path: directory,
      reinforcement_count: 0,
      max_reinforcements: 50,
      awaiting_confirmation: true,
      awaiting_confirmation_set_at: now,
      last_checked_at: now
    };
  } else {
    // Generic state for ultrawork, autopilot, etc.
    state = {
      active: true,
      started_at: now,
      original_prompt: safePrompt,
      session_id: sessionId || undefined,
      project_path: directory,
      reinforcement_count: 0,
      awaiting_confirmation: true,
      awaiting_confirmation_set_at: now,
      last_checked_at: now
    };
  }

  // Write to session-scoped path if sessionId available. Use atomic writes
  // so that concurrent hook processes cannot expose half-written JSON to
  // persistent-mode.mjs's readJsonFile (which would otherwise return null
  // and temporarily drop mode enforcement).
  if (sessionId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) {
    const sessionDir = join(_omcRoot, 'state', 'sessions', sessionId);
    if (!existsSync(sessionDir)) {
      try { mkdirSync(sessionDir, { recursive: true }); } catch {}
    }
    try { atomicWriteFileSync(join(sessionDir, `${stateName}-state.json`), JSON.stringify(state, null, 2)); } catch {}
    return;
  }

  // Fallback: write to legacy local .omc/state directory
  const localDir = join(_omcRoot, 'state');
  if (!existsSync(localDir)) {
    try { mkdirSync(localDir, { recursive: true }); } catch {}
  }
  try { atomicWriteFileSync(join(localDir, `${stateName}-state.json`), JSON.stringify(state, null, 2)); } catch {}
}

function activateRalplanStartupState(directory, prompt, sessionId, omcRoot) {
  const _omcRoot = omcRoot;
  const now = new Date().toISOString();
  const state = {
    active: true,
    started_at: now,
    current_phase: 'ralplan',
    original_prompt: sanitizePromptForState(prompt),
    session_id: sessionId || undefined,
    project_path: directory,
    awaiting_confirmation: true,
    awaiting_confirmation_set_at: now,
    last_checked_at: now
  };

  if (sessionId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) {
    const sessionDir = join(_omcRoot, 'state', 'sessions', sessionId);
    if (!existsSync(sessionDir)) {
      try { mkdirSync(sessionDir, { recursive: true }); } catch {}
    }
    try { atomicWriteFileSync(join(sessionDir, 'ralplan-state.json'), JSON.stringify(state, null, 2)); } catch {}
    return;
  }

  const localDir = join(_omcRoot, 'state');
  if (!existsSync(localDir)) {
    try { mkdirSync(localDir, { recursive: true }); } catch {}
  }
  try { atomicWriteFileSync(join(localDir, 'ralplan-state.json'), JSON.stringify(state, null, 2)); } catch {}
}

/**
 * Clear state files for cancel operation
 */
function clearStateFiles(directory, modeNames, sessionId, omcRoot) {
  const _omcRoot = omcRoot;
  for (const name of modeNames) {
    const localPath = join(_omcRoot, 'state', `${name}-state.json`);
    const globalPath = join(homedir(), '.omc', 'state', `${name}-state.json`);
    try { if (existsSync(localPath)) unlinkSync(localPath); } catch {}
    try { if (existsSync(globalPath)) unlinkSync(globalPath); } catch {}
    // Clear session-scoped file too
    if (sessionId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) {
      const sessionPath = join(_omcRoot, 'state', 'sessions', sessionId, `${name}-state.json`);
      try { if (existsSync(sessionPath)) unlinkSync(sessionPath); } catch {}
    }
  }
}

/**
 * Link ralph and team state files for composition.
 * Updates both state files to reference each other.
 */
function linkRalphTeam(directory, sessionId, omcRoot) {
  const _omcRoot = omcRoot;
  const getStatePath = (modeName) => {
    if (sessionId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) {
      return join(_omcRoot, 'state', 'sessions', sessionId, `${modeName}-state.json`);
    }
    return join(_omcRoot, 'state', `${modeName}-state.json`);
  };

  // Update ralph state with linked_team
  try {
    const ralphPath = getStatePath('ralph');
    if (existsSync(ralphPath)) {
      const state = JSON.parse(readFileSync(ralphPath, 'utf-8'));
      state.linked_team = true;
      writeFileSync(ralphPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    }
  } catch { /* silent */ }

  // Update team state with linked_ralph
  try {
    const teamPath = getStatePath('team');
    if (existsSync(teamPath)) {
      const state = JSON.parse(readFileSync(teamPath, 'utf-8'));
      state.linked_ralph = true;
      writeFileSync(teamPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    }
  } catch { /* silent */ }
}

/**
 * Check if the team feature is enabled in Claude Code settings.
 * Reads settings.json from [$CLAUDE_CONFIG_DIR|~/.claude] and checks for
 * CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS env var.
 * @returns {boolean} true if team feature is enabled
 */
function isTeamEnabled() {
  try {
    // Check settings.json first (authoritative, user-controlled)
    const cfgDir = getClaudeConfigDir();
    const settingsPath = join(cfgDir, 'settings.json');
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      if (settings.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === '1' ||
          settings.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === 'true') {
        return true;
      }
    }
    // Fallback: check env var (for dev/CI environments)
    if (process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === '1' ||
        process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === 'true') {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Create a compact skill invocation guide without inlining SKILL.md bodies.
 * Full skill text remains available by path, avoiding UserPromptSubmit token blowups.
 */
function createSkillInvocation(skillName, originalPrompt, args = '') {
  const argsSection = args ? `
Arguments: ${args}` : '';
  const skillPath = resolveSkillPath(skillName);
  const pathStatus = existsSync(skillPath)
    ? `Read fallback: open ${skillPath} and follow its SKILL.md instructions.`
    : `Read fallback: locate skills/${skillName}/SKILL.md in the active oh-my-claudecode plugin/install and follow it.`;

  return `[MAGIC KEYWORD: ${skillName.toUpperCase()}]

Skill routing detected: ${skillName}
Preferred invocation: /oh-my-claudecode:${skillName}${args ? ` ${args}` : ''}
${pathStatus}${argsSection}

User request (compact echo; original prompt remains authoritative):
${compactHookText(originalPrompt)}

IMPORTANT: Start the ${skillName} workflow immediately. If the slash invocation is unavailable, read the SKILL.md at the fallback path instead of relying on this compact guide.`;
}

/**
 * Create multi-skill invocation message for combined keywords
 */
function createMultiSkillInvocation(skills, originalPrompt) {
  if (skills.length === 0) return '';
  if (skills.length === 1) {
    return createSkillInvocation(skills[0].name, originalPrompt, skills[0].args);
  }

  const skillBlocks = skills.map((s, i) => {
    const skillPath = resolveSkillPath(s.name);
    const argsText = s.args ? ` ${s.args}` : '';
    const pathStatus = existsSync(skillPath)
      ? `Read fallback: ${skillPath}`
      : `Read fallback: locate skills/${s.name}/SKILL.md in the active oh-my-claudecode plugin/install`;
    return `### Skill ${i + 1}: ${s.name.toUpperCase()}
Preferred invocation: /oh-my-claudecode:${s.name}${argsText}
${pathStatus}`;
  }).join('\n\n');

  return `[MAGIC KEYWORDS DETECTED: ${skills.map(s => s.name.toUpperCase()).join(', ')}]

Execute ALL detected workflows in order using compact invocation guidance. Do not inline full SKILL.md files into the prompt.

${skillBlocks}

User request (compact echo; original prompt remains authoritative):
${compactHookText(originalPrompt)}

IMPORTANT: Complete ALL skills listed above in order. Start with the first skill IMMEDIATELY.`;
}

/**
 * Create combined output for multiple skill matches
 */
function createCombinedOutput(skillMatches, originalPrompt) {
  const parts = [];
  if (skillMatches.length > 0) {
    parts.push('## Section 1: Skill Invocations\n\n' + createMultiSkillInvocation(skillMatches, originalPrompt));
  }
  const allNames = skillMatches.map(m => m.name.toUpperCase());
  return `[MAGIC KEYWORDS DETECTED: ${allNames.join(', ')}]\n\n${parts.join('\n\n---\n\n')}\n\nIMPORTANT: Complete ALL sections above in order.`;
}

/**
 * Resolve conflicts between detected keywords
 */
function resolveConflicts(matches) {
  const names = matches.map(m => m.name);

  // Cancel is exclusive
  if (names.includes('cancel')) {
    return [matches.find(m => m.name === 'cancel')];
  }

  let resolved = [...matches];

  // Team keyword detection removed — team is now explicit-only via /team skill.

  // Sort by priority order
  const priorityOrder = ['cancel','ralph','ultragoal','autopilot','ultrawork',
    'ccg','ralplan','deep-interview','ai-slop-cleaner','tdd','code-review','security-review','ultrathink','deepsearch','analyze'];
  resolved.sort((a, b) => priorityOrder.indexOf(a.name) - priorityOrder.indexOf(b.name));

  return resolved;
}

/**
 * Create proper hook output with additionalContext (Claude Code hooks API)
 * The 'message' field is NOT a valid hook output - use hookSpecificOutput.additionalContext
 */
function createHookOutput(additionalContext) {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext
    }
  };
}

// Main
async function main() {
  // Skip guard: check OMC_SKIP_HOOKS env var (see issue #838)
  const _skipHooks = (process.env.OMC_SKIP_HOOKS || '').split(',').map(s => s.trim());
  if (process.env.DISABLE_OMC === '1' || _skipHooks.includes('keyword-detector')) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  // Team worker guard: prevent keyword detection inside team workers to avoid
  // infinite spawning loops (worker detects "team" -> invokes team skill -> spawns more workers)
  if (process.env.OMC_TEAM_WORKER) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  try {
    const input = await readStdin();
    if (!input.trim()) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    let data = {};
    try { data = JSON.parse(input); } catch {}
    const directory = data.cwd || data.directory || process.cwd();
    const sessionId = data.session_id || data.sessionId || '';
    const omcRoot = await resolveOmcStateRoot(directory);

    const prompt = extractPrompt(input);
    if (!prompt) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    // `/ask <provider> ...` delegates the remainder of the prompt to an
    // advisor process. Magic keywords inside that delegated payload must not
    // activate modes in the current Claude Code session.
    if (isExplicitAskSlashInvocation(prompt)) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    if (isExplicitRalplanSlashInvocation(prompt)) {
      activateRalplanStartupState(directory, prompt, sessionId, omcRoot);
      console.log(JSON.stringify(createHookOutput(
        `[RALPLAN INIT]\n` +
        `Explicit /ralplan invoke detected during UserPromptSubmit.\n` +
        `ralplan state has been initialized immediately and marked awaiting confirmation so the stop hook will not block this startup path.\n\n` +
        createSkillInvocation('ralplan', prompt)
      )));
      return;
    }

    // Strip pasted system-echo blocks BEFORE any mode-keyword dispatch runs.
    // This covers both the hasActionableKeyword() call sites AND alternative
    // matchers (e.g. isAntiSlopCleanupRequest) that bypass it. The helper
    // inside hasActionableKeyword also strips defensively, which stays as
    // belt-and-suspenders.
    const cleanPrompt = stripSystemEchoes(
      sanitizeForKeywordDetection(prompt).toLowerCase(),
    );

    // Collect all matching keywords
    const matches = [];

    // Cancel keywords
    if (hasActionableKeyword(cleanPrompt, /\b(cancelomc|stopomc)\b/i)) {
      matches.push({ name: 'cancel', args: '' });
    }

    // Ralph keywords
    if (hasActionableKeyword(cleanPrompt, /\b(ralph|don't stop|must complete|until done)\b|(랄프)(?!로렌)|(ラルフ)(?!・?ローレン)/i)) {
      matches.push({ name: 'ralph', args: '' });
    }

    // Autopilot keywords
    // "autonomous" intentionally excluded — it is too common in technical and
    // research prose (e.g. "autonomous driving", "autonomous agent") to be a
    // reliable trigger. Aligns with src/hooks/keyword-detector/index.ts and
    // templates/hooks/keyword-detector.mjs, which already exclude it.
    if (hasActionableKeyword(cleanPrompt, /\b(autopilot|auto pilot|auto-pilot|full auto|fullsend)\b|(오토파일럿)|(オートパイロット)/i) ||
        hasActionableKeyword(cleanPrompt, /\b(build|create|make)\s+me\s+(an?\s+)?(app|feature|project|tool|plugin|website|api|server|cli|script|system|service|dashboard|bot|extension)\b/i) ||
        hasActionableKeyword(cleanPrompt, /\bi\s+want\s+a\s+/i) ||
        hasActionableKeyword(cleanPrompt, /\bi\s+want\s+an\s+/i) ||
        hasActionableKeyword(cleanPrompt, /\bhandle\s+it\s+all\b/i) ||
        hasActionableKeyword(cleanPrompt, /\bend\s+to\s+end\b/i) ||
        hasActionableKeyword(cleanPrompt, /\be2e\s+this\b/i)) {
      matches.push({ name: 'autopilot', args: '' });
    }

    // Ultragoal keywords
    if (hasExplicitActionableKeyword(cleanPrompt, /\b(ultragoal)\b/i)) {
      matches.push({ name: 'ultragoal', args: '' });
    }

    // Ultrapilot keywords removed — routed to team which is now explicit-only (/team).

    // Ultrawork keywords
    if (hasActionableKeyword(cleanPrompt, /\b(ultrawork|ulw|uw)\b|(울트라워크)|(ウルトラワーク)/i)) {
      matches.push({ name: 'ultrawork', args: '' });
    }

    // Team keyword detection removed — team mode is now explicit-only via /team skill.
    // This prevents infinite spawning when Claude workers receive prompts containing "team".

    // CCG keywords (Claude-Codex-Gemini tri-model orchestration)
    if (hasActionableKeyword(cleanPrompt, /\b(ccg|claude-codex-gemini)\b|(씨씨지)|(シーシージー)/i)) {
      matches.push({ name: 'ccg', args: '' });
    }

    // Ralplan keyword
    if (hasActionableRalplanKeyword(cleanPrompt, /\b(ralplan)\b|(랄플랜)|(ラルプラン)/i)) {
      matches.push({ name: 'ralplan', args: '' });
    }

    // Deep interview keywords
    if (hasActionableKeyword(cleanPrompt, /\b(deep[\s-]interview|ouroboros)\b|(딥인터뷰)|(ディープインタビュー)/i)) {
      matches.push({ name: 'deep-interview', args: '' });
    }

    // AI slop cleanup keywords
    if (isAntiSlopCleanupRequest(cleanPrompt)) {
      matches.push({ name: 'ai-slop-cleaner', args: '' });
    }

    // TDD keywords
    if (hasActionableKeyword(cleanPrompt, /\b(tdd)\b|(테스트\s?퍼스트)|(テスト\s?ファースト)/i) ||
        hasActionableKeyword(cleanPrompt, /\btest\s+first\b/i) ||
        hasActionableKeyword(cleanPrompt, /\bred\s+green\b/i)) {
      matches.push({ name: 'tdd', args: '' });
    }

    // Code review keywords — skip when the prompt is echoed review-instruction text
    if (!isReviewSeedContext(cleanPrompt) &&
        hasActionableKeyword(cleanPrompt, /\b(code\s+review|review\s+code)\b|(코드\s?리뷰)(?!어)|(コード\s?レビュー)(?!ア)/i)) {
      matches.push({ name: 'code-review', args: '' });
    }

    // Security review keywords — skip when the prompt is echoed review-instruction text
    if (!isReviewSeedContext(cleanPrompt) &&
        hasActionableKeyword(cleanPrompt, /\b(security\s+review|review\s+security)\b|(보안\s?리뷰)(?!어)|(セキュリティ[ー]?\s?レビュー)(?!ア)/i)) {
      matches.push({ name: 'security-review', args: '' });
    }

    // Ultrathink keywords
    if (hasActionableKeyword(cleanPrompt, /\b(ultrathink|think hard|think deeply)\b|(울트라씽크)|(ウルトラシンク)/i)) {
      matches.push({ name: 'ultrathink', args: '' });
    }

    // Deepsearch keywords
    if (hasActionableKeyword(cleanPrompt, /\b(deepsearch)\b|(딥\s?서치)|(ディープ\s?サーチ)/i) ||
        hasActionableKeyword(cleanPrompt, /\bsearch\s+(the\s+)?(codebase|code|files?|project)\b/i) ||
        hasActionableKeyword(cleanPrompt, /\bfind\s+(in\s+)?(codebase|code|all\s+files?)\b/i)) {
      matches.push({ name: 'deepsearch', args: '' });
    }

    // Analyze keywords
    if (hasActionableKeyword(cleanPrompt, /\b(deep[\s-]?analyze|deepanalyze)\b|(딥\s?분석)|(ディープ\s?アナライズ)/i)) {
      matches.push({ name: 'analyze', args: '' });
    }

    // Wiki keywords
    if (hasActionableKeyword(cleanPrompt, /\b(wiki(?:\s+(?:this|add|lint|query))?)\b/i)) {
      matches.push({ name: 'wiki', args: '' });
    }

    // Deduplicate matches by keyword name before conflict resolution
    const seen = new Set();
    const uniqueMatches = [];
    for (const m of matches) {
      if (!seen.has(m.name)) {
        seen.add(m.name);
        uniqueMatches.push(m);
      }
    }

    // Resolve conflicts
    const resolved = resolveConflicts(uniqueMatches);

    // Import flow tracer once (best-effort)
    let tracer = null;
    try { tracer = await import('../dist/hooks/subagent-tracker/flow-tracer.js'); } catch { /* silent */ }

    // Import follow-up planner modules (best-effort — requires npm run build)
    let followupPlanner = null;
    let planningArtifacts = null;
    try {
      followupPlanner = await import('../dist/team/followup-planner.js');
      planningArtifacts = await import('../dist/planning/artifacts.js');
    } catch { /* silent — dist/ may not exist yet */ }

    // Check for approved follow-up shortcut: bypass ralplan gate when a prior ralplan
    // cycle completed and left an approved plan with a launch hint.
    if (followupPlanner && planningArtifacts) {
      // Detect if ralplan state exists (was recently active) — serves as "prior skill = ralplan" signal
      const ralplanStatePaths = sessionId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)
        ? [
            join(omcRoot, 'state', 'sessions', sessionId, 'ralplan-state.json'),
            join(directory, '.omx', 'state', 'sessions', sessionId, 'ralplan-state.json'),
          ]
        : [
            join(omcRoot, 'state', 'ralplan-state.json'),
            join(directory, '.omx', 'state', 'ralplan-state.json'),
          ];
      const ralplanState = readRalplanFollowupState(ralplanStatePaths, sessionId);
      const ralplanTerminal = isRalplanFollowupTerminal(ralplanState);

      if (ralplanState) {
        const artifacts = planningArtifacts.readPlanningArtifacts(directory);
        const planningComplete = planningArtifacts.isPlanningComplete(artifacts);
        const teamHint = planningArtifacts.readApprovedExecutionLaunchHint?.(directory, 'team');
        const ralphHint = planningArtifacts.readApprovedExecutionLaunchHint?.(directory, 'ralph');

        const isTeamFollowup = followupPlanner.isApprovedExecutionFollowupShortcut('team', prompt, {
          planningComplete,
          priorSkill: 'ralplan',
          ralplanTerminal,
          approvedExecutionLaunchHint: Boolean(teamHint),
        });
        const isRalphFollowup = followupPlanner.isApprovedExecutionFollowupShortcut('ralph', prompt, {
          planningComplete,
          priorSkill: 'ralplan',
          ralplanTerminal,
          approvedExecutionLaunchHint: Boolean(ralphHint),
        });

        if (isTeamFollowup) {
          console.log(JSON.stringify(createHookOutput(createSkillInvocation('team', prompt))));
          return;
        }
        if (isRalphFollowup) {
          console.log(JSON.stringify(createHookOutput(createSkillInvocation('ralph', prompt))));
          return;
        }

        const isShortTeamRequest = followupPlanner.isShortTeamFollowupRequest?.(prompt) === true;
        const isShortRalphRequest = followupPlanner.isShortRalphFollowupRequest?.(prompt) === true;
        if (isShortTeamRequest || isShortRalphRequest) {
          // A compact continuation can echo the saved plan and a terse lane hint.
          // Unless the ralplan state is terminal and a launch hint is present,
          // keep ralplan read-only instead of falling through to generic ralph.
          console.log(JSON.stringify({ continue: true, suppressOutput: true }));
          return;
        }
      }
    }

    // No matches - pass through.
    // Keep this after approved follow-up handling so short post-ralplan
    // prompts like "team" can launch the approved execution path even
    // though generic team keyword auto-detection is disabled.
    if (matches.length === 0) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    // Record detected keywords to flow trace
    if (tracer) {
      for (const match of resolved) {
        try { tracer.recordKeywordDetected(directory, sessionId, match.name); } catch { /* silent */ }
      }
    }

    // Handle cancel specially - clear states and emit
    if (resolved.length > 0 && resolved[0].name === 'cancel') {
      clearStateFiles(directory, ['ralph', 'ultragoal', 'autopilot', 'ultrawork', 'swarm', 'ralplan'], sessionId, omcRoot);
      console.log(JSON.stringify(createHookOutput(createSkillInvocation('cancel', prompt))));
      return;
    }

    // Activate states for modes that need them (team removed — explicit-only via /team skill)
    const stateModes = resolved.filter(m => ['ralph', 'ultragoal', 'autopilot', 'ultrawork', 'ralplan'].includes(m.name));
    for (const mode of stateModes) {
      activateState(directory, prompt, mode.name, sessionId, omcRoot);
    }

    // Record mode changes to flow trace
    if (tracer) {
      for (const mode of stateModes) {
        try { tracer.recordModeChange(directory, sessionId, 'none', mode.name); } catch { /* silent */ }
      }
    }

    // Special: Ralph with ultrawork
    const hasRalph = resolved.some(m => m.name === 'ralph');
    const hasUltrawork = resolved.some(m => m.name === 'ultrawork');
    if (hasRalph && !hasUltrawork) {
      activateState(directory, prompt, 'ultrawork', sessionId, omcRoot);
    }

    const additionalContextParts = [];
    for (const [keywordName, message] of MODE_MESSAGE_KEYWORDS) {
      const index = resolved.findIndex(m => m.name === keywordName);
      if (index !== -1) {
        resolved.splice(index, 1);
        additionalContextParts.push(message);
      }
    }

    if (resolved.length === 0 && additionalContextParts.length > 0) {
      console.log(JSON.stringify(createHookOutput(additionalContextParts.join(''))));
      return;
    }

    if (resolved.length > 0) {
      additionalContextParts.push(createMultiSkillInvocation(resolved, prompt));
    }

    if (additionalContextParts.length > 0) {
      console.log(JSON.stringify(createHookOutput(additionalContextParts.join(''))));
      return;
    }
  } catch (error) {
    // On any error, allow continuation
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

main();
