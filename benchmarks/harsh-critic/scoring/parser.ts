/**
 * Parser for extracting structured data from agent review output.
 *
 * Supports two agent formats:
 * - harsh-critic: Structured sections with verdicts, severity-bucketed findings,
 *   "What's Missing", and multi-perspective notes.
 * - critic: Simpler OKAY/REJECT verdict with findings from summary/justification.
 */

import type {
  AgentType,
  ParsedAgentOutput,
  ParsedFinding,
  Severity,
} from './types.js';

// ============================================================
// Evidence detection
// ============================================================

/**
 * Matches evidence markers such as:
 * - backtick snippets: `code()`
 * - path/file refs: src/auth.ts:42, auth.ts:12:5
 * - function location refs: processPayment():47-52
 */
const EVIDENCE_PATTERN =
  /`[^`]+`|\b(?:[A-Za-z0-9_./-]+\.[A-Za-z0-9_+-]+|[A-Za-z_][A-Za-z0-9_]*\(\)):\d+(?:-\d+)?(?:[:]\d+)?\b/;

function hasEvidence(text: string): boolean {
  return EVIDENCE_PATTERN.test(text);
}

// ============================================================
// Shared utilities
// ============================================================

type PerspectiveKey = 'security' | 'newHire' | 'ops';

interface SectionBounds {
  start: number;
  end: number;
}

const NUMBERED_ITEM_PATTERN = /^([ \t]*)(?:\*{1,2}\s*)?\d+[.)](?:\*{1,2})?\s+(.+)$/;
const BULLET_ITEM_PATTERN = /^([ \t]*)[-*•]\s+(.+)$/;
const LIST_MARKER_PATTERN = /^(?:[-*•]|(?:\*{1,2}\s*)?\d+[.)](?:\*{1,2})?)\s+(.+)$/;

// Common subfields used inside a finding item; keep them attached to the parent item.
const SUBFIELD_PATTERN =
  /^(?:\*{1,2})?(?:evidence|why this matters|fix|impact|risk|mitigation|proof|location|example|note)\b/i;

function normalizeHeadingLine(line: string): string {
  let normalized = line.trim();
  normalized = normalized.replace(/^#{1,6}\s*/, '');
  normalized = normalized.replace(/^\*{1,2}\s*/, '');
  normalized = normalized.replace(/\s*\*{1,2}\s*:?\s*$/, '');
  normalized = normalized.replace(/[—–]/g, '-');
  normalized = normalized.replace(/\s+/g, ' ');
  return normalized.trim().toLowerCase();
}

function isHorizontalRule(line: string): boolean {
  return /^\s*(?:---+|\*\*\*+)\s*$/.test(line);
}

function isHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  if (isHorizontalRule(trimmed)) return true;
  if (/^#{1,6}\s+\S/.test(trimmed)) return true;

  // Bold-numbered lines like "**1. Finding**" are list items, not headings.
  if (/^\*{1,2}\s*\d+[.)]\s+/.test(trimmed)) return false;

  if (/^\*{1,2}[^*\n]+?\*{1,2}(?:\s*\([^)\n]*\))?\s*:?\s*$/.test(trimmed)) {
    return true;
  }

  if (/^[A-Za-z][A-Za-z0-9'() \-/]{2,}:\s*$/.test(trimmed)) {
    return true;
  }

  return false;
}

function lineMatchesAnyHeadingAlias(line: string, aliases: RegExp[]): boolean {
  const normalized = normalizeHeadingLine(line);
  return aliases.some((alias) => alias.test(normalized));
}

function findSectionHeadingIndex(lines: string[], aliases: RegExp[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (lineMatchesAnyHeadingAlias(lines[i], aliases)) return i;
  }
  return -1;
}

function findSectionBounds(lines: string[], aliases: RegExp[]): SectionBounds | null {
  const headingIndex = findSectionHeadingIndex(lines, aliases);
  if (headingIndex === -1) return null;

  const start = headingIndex + 1;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (isHeadingLine(lines[i])) {
      end = i;
      break;
    }
  }

  return { start, end };
}

function hasSection(lines: string[], aliases: RegExp[]): boolean {
  return findSectionHeadingIndex(lines, aliases) !== -1;
}

function extractListItemsFromSection(sectionLines: string[]): string[] {
  const items: string[] = [];
  let current = '';
  let currentKind: 'numbered' | 'bullet' | null = null;

  const flush = () => {
    const item = current.trim();
    if (item && !/^none\.?$/i.test(item)) {
      items.push(item);
    }
    current = '';
    currentKind = null;
  };

  for (const rawLine of sectionLines) {
    const line = rawLine.replace(/\r/g, '');
    const trimmed = line.trim();

    if (!trimmed || isHorizontalRule(trimmed)) {
      flush();
      continue;
    }

    const numbered = NUMBERED_ITEM_PATTERN.exec(line);
    if (numbered) {
      flush();
      current = numbered[2].trim();
      currentKind = 'numbered';
      continue;
    }

    const bullet = BULLET_ITEM_PATTERN.exec(line);
    if (bullet) {
      const indent = bullet[1].replace(/\t/g, '  ').length;
      const text = bullet[2].trim();
      if (!text) continue;

      // Many model outputs use unindented "-" sub-bullets after numbered headings
      // (Evidence/Why/Fix). Keep those attached to the parent finding.
      const appendToCurrent =
        current.length > 0 &&
        (indent >= 2 || currentKind === 'numbered' || SUBFIELD_PATTERN.test(text));

      if (appendToCurrent) {
        current += ' ' + text;
      } else {
        flush();
        current = text;
        currentKind = 'bullet';
      }
      continue;
    }

    // Plain continuation prose inside the active item.
    if (current.length > 0) {
      current += ' ' + trimmed;
    }
  }

  flush();
  return items;
}

function extractSectionItems(lines: string[], aliases: RegExp[]): string[] {
  const bounds = findSectionBounds(lines, aliases);
  if (!bounds) return [];
  return extractListItemsFromSection(lines.slice(bounds.start, bounds.end));
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const item of items) {
    const key = item.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item.trim());
  }
  return deduped;
}

function detectPerspectiveHeading(line: string): PerspectiveKey | null {
  const normalized = normalizeHeadingLine(line);

  if (
    /\bsecurity\b(?:\s+engineer)?(?:\s+perspective)?\b/.test(normalized) ||
    normalized === 'security'
  ) {
    return 'security';
  }
  if (
    /\bnew[- ]?hire\b(?:\s+perspective)?\b/.test(normalized) ||
    normalized === 'new-hire' ||
    normalized === 'new hire'
  ) {
    return 'newHire';
  }
  if (
    /\bops\b(?:\s+engineer)?(?:\s+perspective)?\b/.test(normalized) ||
    normalized === 'ops'
  ) {
    return 'ops';
  }

  return null;
}

function parsePerspectiveNotes(
  lines: string[],
  multiPerspectiveHeadingIndex: number,
): { security: string[]; newHire: string[]; ops: string[] } {
  const notes = {
    security: [] as string[],
    newHire: [] as string[],
    ops: [] as string[],
  };

  const scopedLines =
    multiPerspectiveHeadingIndex >= 0
      ? lines.slice(multiPerspectiveHeadingIndex + 1)
      : lines;

  const pushNote = (key: PerspectiveKey, value: string) => {
    const text = value.trim();
    if (!text || /^none\.?$/i.test(text)) return;
    notes[key].push(text);
  };

  // Pass 1: inline labels like "- Security: ..."
  for (const line of scopedLines) {
    const bullet = BULLET_ITEM_PATTERN.exec(line);
    if (!bullet) continue;
    const inline = /^(Security|New-?hire|Ops)\s*:\s*(.+)$/i.exec(bullet[2].trim());
    if (!inline) continue;

    const label = inline[1].toLowerCase();
    const content = inline[2].trim();
    if (label === 'security') pushNote('security', content);
    else if (label.startsWith('new')) pushNote('newHire', content);
    else pushNote('ops', content);
  }

  // Pass 2: subsection headings like "### Security Engineer Perspective"
  let currentPerspective: PerspectiveKey | null = null;
  let currentItem = '';
  const flushCurrent = () => {
    if (currentPerspective && currentItem.trim()) {
      pushNote(currentPerspective, currentItem.trim());
    }
    currentItem = '';
  };

  for (const line of scopedLines) {
    const trimmed = line.trim();

    if (!trimmed || isHorizontalRule(trimmed)) {
      flushCurrent();
      continue;
    }

    if (isHeadingLine(line)) {
      const headingPerspective = detectPerspectiveHeading(line);
      if (headingPerspective) {
        flushCurrent();
        currentPerspective = headingPerspective;
        continue;
      }
      flushCurrent();
      currentPerspective = null;
      continue;
    }

    if (!currentPerspective) continue;

    const listContent = LIST_MARKER_PATTERN.exec(trimmed);
    if (listContent) {
      flushCurrent();
      currentItem = listContent[1].trim();
      continue;
    }

    currentItem = currentItem ? `${currentItem} ${trimmed}` : trimmed;
  }

  flushCurrent();

  return {
    security: dedupeStrings(notes.security),
    newHire: dedupeStrings(notes.newHire),
    ops: dedupeStrings(notes.ops),
  };
}

/**
 * Build a ParsedFinding from raw item text and severity.
 */
function toFinding(text: string, severity: Severity): ParsedFinding {
  return { text, severity, hasEvidence: hasEvidence(text) };
}

// ============================================================
// Harsh-critic parser
// ============================================================

const PRECOMMIT_ALIASES = [/\bpre-?commitment\s+predictions?\b/];
const CRITICAL_ALIASES = [/\bcritical\s+findings?\b/];
const MAJOR_ALIASES = [/\bmajor\s+findings?\b/];
const MINOR_ALIASES = [/\bminor\s+findings?\b/];
const MISSING_ALIASES = [/\bwhat'?s?\s+missing\b/];
const MULTI_PERSPECTIVE_ALIASES = [
  /\bmulti-?perspective\b.*\b(?:notes?|review)\b/,
  /\bphase\s*\d+\b.*\bmulti-?perspective\b/,
];
const SUMMARY_ALIASES = [/\bsummary\b/];
const JUSTIFICATION_ALIASES = [/\bjustification\b/];

function parseVerdict(text: string): string {
  // Match: **VERDICT: REJECT** or **VERDICT: ACCEPT-WITH-RESERVATIONS**
  const m = /\*{1,2}VERDICT\s*:\s*([A-Z][A-Z\s-]*?)\*{1,2}/i.exec(text);
  if (m) return m[1].trim();

  // Fallback: look for bare verdict-like keyword
  const bare = /\bVERDICT\s*:\s*([A-Z][A-Z\s-]+)/i.exec(text);
  if (bare) return bare[1].trim();

  return '';
}

function parseFindingsSection(lines: string[], aliases: RegExp[], severity: Severity): ParsedFinding[] {
  return extractSectionItems(lines, aliases).map((item) => toFinding(item, severity));
}

function parseHarshCritic(rawOutput: string): ParsedAgentOutput {
  const lines = rawOutput.split(/\r?\n/);

  // Verdict
  const verdict = parseVerdict(rawOutput);

  // Pre-commitment predictions
  const hasPreCommitment = hasSection(lines, PRECOMMIT_ALIASES);

  // Findings sections
  const criticalFindings = parseFindingsSection(lines, CRITICAL_ALIASES, 'CRITICAL');
  const majorFindings = parseFindingsSection(lines, MAJOR_ALIASES, 'MAJOR');
  const minorFindings = parseFindingsSection(lines, MINOR_ALIASES, 'MINOR');

  // What's Missing
  const missingItems = extractSectionItems(lines, MISSING_ALIASES);
  const hasGapAnalysis = hasSection(lines, MISSING_ALIASES);

  // Multi-Perspective Notes/Review
  const multiPerspectiveHeadingIndex = findSectionHeadingIndex(
    lines,
    MULTI_PERSPECTIVE_ALIASES,
  );
  const perspectiveNotes = parsePerspectiveNotes(lines, multiPerspectiveHeadingIndex);
  const hasMultiPerspective =
    multiPerspectiveHeadingIndex !== -1 ||
    perspectiveNotes.security.length > 0 ||
    perspectiveNotes.newHire.length > 0 ||
    perspectiveNotes.ops.length > 0;

  return {
    verdict,
    criticalFindings,
    majorFindings,
    minorFindings,
    missingItems,
    perspectiveNotes,
    hasPreCommitment,
    hasGapAnalysis,
    hasMultiPerspective,
    rawOutput,
  };
}

// ============================================================
// Critic parser
// ============================================================

function parseCriticVerdict(text: string): string {
  // Match: **OKAY** / **REJECT** / **[OKAY]** / **[REJECT]**
  const m =
    /\*{1,2}\[?\s*(OKAY|REJECT)\s*\]?\*{1,2}/i.exec(text);
  if (m) return m[1].toUpperCase();

  // Fallback: bare keyword at line start
  const bare = /^\s*\[?\s*(OKAY|REJECT)\s*\]?\s*$/im.exec(text);
  if (bare) return bare[1].toUpperCase();

  return '';
}

/**
 * Extract findings from critic's Summary / Justification paragraphs.
 * Each numbered list item or dash-bullet becomes a MAJOR finding (default severity).
 */
function parseCriticFindings(text: string): ParsedFinding[] {
  const lines = text.split(/\r?\n/);
  const summaryItems = extractSectionItems(lines, SUMMARY_ALIASES);
  const justificationItems = extractSectionItems(lines, JUSTIFICATION_ALIASES);
  const merged = dedupeStrings([...summaryItems, ...justificationItems]);
  return merged.map((item) => toFinding(item, 'MAJOR'));
}

function parseCritic(rawOutput: string): ParsedAgentOutput {
  const verdict = parseCriticVerdict(rawOutput);

  // Critic has no severity-bucketed sections; put extracted findings in majorFindings
  const majorFindings = parseCriticFindings(rawOutput);

  return {
    verdict,
    criticalFindings: [],
    majorFindings,
    minorFindings: [],
    missingItems: [],
    perspectiveNotes: { security: [], newHire: [], ops: [] },
    hasPreCommitment: false,
    hasGapAnalysis: false,
    hasMultiPerspective: false,
    rawOutput,
  };
}

// ============================================================
// Public API
// ============================================================

/**
 * Parse raw markdown output from a review agent into a structured representation.
 *
 * @param rawOutput - The full markdown text produced by the agent.
 * @param agentType - Which agent produced the output ('harsh-critic' | 'critic').
 * @returns Structured ParsedAgentOutput.
 */
export function parseAgentOutput(
  rawOutput: string,
  agentType: AgentType,
): ParsedAgentOutput {
  if (agentType === 'harsh-critic') {
    return parseHarshCritic(rawOutput);
  }
  return parseCritic(rawOutput);
}
