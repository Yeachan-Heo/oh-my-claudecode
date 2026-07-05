/**
 * Nikoflow gate detection.
 *
 * Pure transcript-text scanning for the correlated gate tag
 *   <nikoflow-gate phase="X" [depth="..."] [request-id="..."]>PAYLOAD</nikoflow-gate>
 *
 * Mirrors ralph's detectArchitectApproval: strips injected examples (the
 * continuation prompt block and code-fenced sample tags) before matching, and
 * correlates on request-id so a stale tag from a previous gate cannot satisfy a
 * new one. Caller (persistent-mode) supplies the transcript text; this module
 * stays free of fs/hook dependencies so it is trivially unit-testable.
 */

import { NIKOFLOW_DEPTHS, type NikoflowDepth } from "./loop.js";

/** Expected payload(s) per gate. A tag only counts if its payload matches. */
export const NIKOFLOW_GATE_PAYLOADS: Record<string, string[]> = {
  depth: ["CONFIRMED"],
  interview: ["CONFIRMED"],
  adr: ["RECORDED", "SKIPPED"],
  prd: ["SEAMS_CONFIRMED"],
  tickets: ["APPROVED"],
  // execute advances per-ticket via dynamic "execute:TSK-NNN" gates (payload
  // TICKET_DONE, passed explicitly) and auto-advances when all tickets are done —
  // there is no phase-level "execute" gate.
  verify: ["VERIFIED", "NO_ACTIONABLE_FINDINGS"],
};

/** Gates that require proof of a real user turn after the request was minted. */
export const HUMAN_GATE_PHASES: ReadonlySet<string> = new Set([
  "depth",
  "interview",
  "prd",
  "tickets",
]);

export interface GateMatch {
  matched: boolean;
  /** For the depth gate: the tier the user confirmed, if present. */
  depth?: NikoflowDepth;
  /** The exact payload that matched (e.g. VERIFIED vs NO_ACTIONABLE_FINDINGS). */
  payload?: string;
  /** For the verify gate: the reviewer's numeric score, if present. */
  score?: number;
}

// Precompiled attribute matchers for the known gate attributes — avoids a fresh
// RegExp compile per attribute per tag per Stop (perf F4). (?<![\w-]) not \b so a
// hyphen-prefixed lookalike (data-phase, x-request-id) can't shadow the real one.
const ATTR_REGEXES: Record<string, RegExp> = {
  phase: /(?<![\w-])phase=(["'])(.*?)\1/i,
  "request-id": /(?<![\w-])request-id=(["'])(.*?)\1/i,
  score: /(?<![\w-])score=(["'])(.*?)\1/i,
  depth: /(?<![\w-])depth=(["'])(.*?)\1/i,
};

function extractAttribute(attributes: string, name: string): string | undefined {
  // No `g` flag → exec always starts at 0, so a shared precompiled regex is safe.
  const re = ATTR_REGEXES[name] ?? new RegExp(`(?<![\\w-])${name}=(["'])(.*?)\\1`, "i");
  return re.exec(attributes)?.[2];
}

// Module-level strip patterns (perf F4) — .replace() ignores/rewinds lastIndex,
// so reusing these `g`-flagged regexes across calls is safe.
const STRIP_CONTINUATION = /<nikoflow-continuation\b[\s\S]*?<\/nikoflow-continuation>/gi;
const STRIP_FENCE_BACKTICK = /```[\s\S]*?```/g;
const STRIP_FENCE_TILDE = /~~~[\s\S]*?~~~/g;
const STRIP_INLINE_TAG = /`<nikoflow-gate\b[\s\S]*?<\/nikoflow-gate>`/gi;

/**
 * Remove text that legitimately CONTAINS example gate tags so they cannot be
 * mistaken for a real confirmation: the continuation prompt block we inject,
 * and any code-fenced (`...`) sample tag.
 */
function stripInjectedExamples(text: string): string {
  return text
    .replace(STRIP_CONTINUATION, " ")
    .replace(STRIP_FENCE_BACKTICK, " ")
    .replace(STRIP_FENCE_TILDE, " ")
    .replace(STRIP_INLINE_TAG, " ");
}

/**
 * Detect a valid gate confirmation for `phase` in the transcript text.
 * When `requestId` is given, the tag MUST carry a matching request-id.
 */
export function detectNikoflowGate(
  text: string,
  opts: { phase: string; requestId?: string; expectedPayloads?: string[] },
): GateMatch {
  // Dynamic per-ticket gates (e.g. "execute:TSK-001") pass their own payloads.
  const expectedPayloads =
    opts.expectedPayloads ?? NIKOFLOW_GATE_PAYLOADS[opts.phase];
  if (!expectedPayloads) return { matched: false };

  const sanitized = stripInjectedExamples(text);
  // (?![\w-]) not \b: \b matches the boundary before the hyphen in a sibling like
  // <nikoflow-gate-blocked>, mis-parsing it as an open <nikoflow-gate> whose
  // payload then swallows the NEXT real gate (audit F1). The lookahead requires
  // the name to end exactly at "nikoflow-gate".
  const tagRe = /<nikoflow-gate(?![\w-])([^>]*)>([\s\S]*?)<\/nikoflow-gate>/gi;

  for (const m of sanitized.matchAll(tagRe)) {
    const attributes = m[1] ?? "";
    const payload = (m[2] ?? "").trim();

    const phaseAttr = extractAttribute(attributes, "phase");
    if (phaseAttr !== opts.phase) continue;

    // Exact payload match (not substring) so e.g. "NOT_CONFIRMED" ≠ "CONFIRMED".
    if (!expectedPayloads.includes(payload)) continue;

    if (opts.requestId) {
      const rid = extractAttribute(attributes, "request-id");
      if (rid !== opts.requestId) continue;
    }

    const result: GateMatch = { matched: true, payload };
    const scoreAttr = extractAttribute(attributes, "score");
    if (scoreAttr !== undefined) {
      const parsed = Number.parseFloat(scoreAttr);
      // Scores are on a 1–10 scale; ignore out-of-range values (a placeholder
      // like "N.N" → NaN, or "99" → nonsense) so they can't force a pass (audit F6).
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 10) {
        result.score = parsed;
      }
    }
    if (opts.phase === "depth") {
      const depthAttr = extractAttribute(attributes, "depth")?.toLowerCase();
      // A depth confirmation is only real with a concrete tier — a verbatim
      // template copy ("tactical|standard|deep") must NOT count as a match,
      // otherwise it would burn the user's confirmation without setting depth.
      if (!depthAttr || !(NIKOFLOW_DEPTHS as readonly string[]).includes(depthAttr)) {
        continue;
      }
      result.depth = depthAttr as NikoflowDepth;
    }
    return result;
  }

  return { matched: false };
}
