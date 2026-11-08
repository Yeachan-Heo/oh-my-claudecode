/**
 * Generalized parser for extracting structured findings from any agent output.
 *
 * For critic/harsh-critic agents, delegates to the existing harsh-critic parser.
 * For other agents (code-reviewer, debugger, executor), uses a generic
 * severity-section parser that works with common markdown output formats.
 */

import type { ParsedAgentOutput, ParsedFinding, Severity } from './types.ts';

// Re-export the harsh-critic parser for backward compatibility
export { parseAgentOutput as parseCriticOutput } from '../harsh-critic/scoring/parser.ts';

// ============================================================
// Evidence detection
// ============================================================

const EVIDENCE_PATTERN =
  /`[^`]+`|\b(?:[A-Za-z0-9_./-]+\.[A-Za-z0-9_+-]+|[A-Za-z_][A-Za-z0-9_]*\(\)):\d+(?:-\d+)?(?:[:]\d+)?\b/;

function hasEvidence(text: string): boolean {
  return EVIDENCE_PATTERN.test(text);
}

// ============================================================
// Shared list extraction
// ============================================================

const LIST_ITEM_PATTERN = /^(?:[-*\u2022]|\d+[.)])\s+(.+)$/;

function extractListItems(lines: string[]): string[] {
  const items: string[] = [];
  let current = '';

  const flush = () => {
    const item = current.trim();
    if (item && !/^none\.?$/i.test(item)) {
      items.push(item);
    }
    current = '';
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      flush();
      continue;
    }

    const match = LIST_ITEM_PATTERN.exec(trimmed);
    if (match) {
      flush();
      current = match[1].trim();
    } else if (current) {
      current += ' ' + trimmed;
    }
  }

  flush();
  return items;
}

// ============================================================
// Section detection
// ============================================================

function normalizeHeading(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\*{1,2}\s*/, '')
    .replace(/\s*\*{1,2}\s*:?\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^#{1,6}\s+\S/.test(trimmed)) return true;
  if (/^\*{1,2}[^*\n]+?\*{1,2}(?:\s*\([^)\n]*\))?\s*:?\s*$/.test(trimmed)) return true;
  if (/^[A-Za-z][A-Za-z0-9'() \-/]{2,}:\s*$/.test(trimmed)) return true;
  return false;
}

interface Section {
  heading: string;
  lines: string[];
}

function extractSections(rawOutput: string): Section[] {
  const lines = rawOutput.split(/\r?\n/);
  const sections: Section[] = [];
  let currentHeading = '';
  let currentLines: string[] = [];

  for (const line of lines) {
    if (isHeadingLine(line)) {
      if (currentHeading || currentLines.length > 0) {
        sections.push({ heading: currentHeading, lines: currentLines });
      }
      currentHeading = normalizeHeading(line);
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  if (currentHeading || currentLines.length > 0) {
    sections.push({ heading: currentHeading, lines: currentLines });
  }

  return sections;
}

// ============================================================
// Severity detection from section headings
// ============================================================

function detectSeverity(heading: string): Severity | null {
  const lower = heading.toLowerCase();
  if (/\bcritical\b/.test(lower)) return 'CRITICAL';
  if (/\bmajor\b/.test(lower)) return 'MAJOR';
  if (/\bminor\b/.test(lower)) return 'MINOR';
  return null;
}

function detectSeverityFromText(text: string): Severity {
  const upper = text.toUpperCase();
  if (/\bCRITICAL\b/.test(upper)) return 'CRITICAL';
  if (/\bMAJOR\b/.test(upper)) return 'MAJOR';
  if (/\bMINOR\b/.test(upper)) return 'MINOR';
  return 'MAJOR'; // default
}

// ============================================================
// Generic parser
// ============================================================

function toFinding(text: string, severity: Severity): ParsedFinding {
  return { text, severity, hasEvidence: hasEvidence(text) };
}

/**
 * Generic parser that works with any markdown-structured agent output.
 * Looks for severity-labeled sections (Critical/Major/Minor) and extracts
 * list items as findings. Falls back to treating all list items as MAJOR.
 */
export function parseGenericOutput(rawOutput: string): ParsedAgentOutput {
  const sections = extractSections(rawOutput);

  const criticalFindings: ParsedFinding[] = [];
  const majorFindings: ParsedFinding[] = [];
  const minorFindings: ParsedFinding[] = [];
  const missingItems: string[] = [];
  let hasSeveritySections = false;

  // Extract verdict (various formats)
  let verdict = '';
  const verdictMatch = /\*{0,2}(?:VERDICT|CLASSIFICATION|DIAGNOSIS|APPROACH)\s*:\s*([^\n*]+)/i.exec(rawOutput);
  if (verdictMatch) {
    verdict = verdictMatch[1].trim().replace(/\*+$/, '');
  }

  for (const section of sections) {
    const heading = section.heading;
    const items = extractListItems(section.lines);

    // Check for severity sections
    const severity = detectSeverity(heading);
    if (severity) {
      hasSeveritySections = true;
      const findings = items.map((item) => toFinding(item, severity));
      if (severity === 'CRITICAL') criticalFindings.push(...findings);
      else if (severity === 'MAJOR') majorFindings.push(...findings);
      else minorFindings.push(...findings);
      continue;
    }

    // Check for "what's missing" section
    if (/\bmissing\b/.test(heading) || /\bgap\b/.test(heading)) {
      missingItems.push(...items);
      continue;
    }

    // Check for findings/issues/problems generic section
    if (/\bfinding|issue|problem|bug|error|diagnos|root.?cause|fix|recommend/i.test(heading)) {
      for (const item of items) {
        const sev = detectSeverityFromText(item);
        const finding = toFinding(item, sev);
        if (sev === 'CRITICAL') criticalFindings.push(finding);
        else if (sev === 'MINOR') minorFindings.push(finding);
        else majorFindings.push(finding);
      }
    }
  }

  // If no severity-labeled sections found, scan the entire output for findings
  if (!hasSeveritySections && criticalFindings.length === 0 && majorFindings.length === 0 && minorFindings.length === 0) {
    const allItems = extractListItems(rawOutput.split(/\r?\n/));
    for (const item of allItems) {
      // Skip items that look like headers or meta-text
      if (item.length < 15) continue;
      const sev = detectSeverityFromText(item);
      const finding = toFinding(item, sev);
      if (sev === 'CRITICAL') criticalFindings.push(finding);
      else if (sev === 'MINOR') minorFindings.push(finding);
      else majorFindings.push(finding);
    }
  }

  // Detect process compliance features
  const hasPreCommitment = /\bpre-?commitment\b/i.test(rawOutput);
  const hasGapAnalysis = /\bwhat'?s?\s+missing\b/i.test(rawOutput) || /\bgap\s+analysis\b/i.test(rawOutput);
  const hasMultiPerspective = /\bperspective\b/i.test(rawOutput) && /\bsecurity\b/i.test(rawOutput);

  return {
    verdict,
    criticalFindings,
    majorFindings,
    minorFindings,
    missingItems,
    perspectiveNotes: { security: [], newHire: [], ops: [] },
    hasPreCommitment,
    hasGapAnalysis,
    hasMultiPerspective,
    rawOutput,
  };
}

/**
 * Parse agent output using the appropriate parser based on agent type.
 *
 * - 'harsh-critic' and 'critic' use the specialized critic parser (via parseCriticOutput re-export)
 * - All other agents use the generic parser
 */
export function parseAgentOutput(
  rawOutput: string,
  agentType: string,
): ParsedAgentOutput {
  if (agentType === 'harsh-critic' || agentType === 'critic') {
    return parseCriticOutput(rawOutput, agentType as 'harsh-critic' | 'critic');
  }
  return parseGenericOutput(rawOutput);
}
