/**
 * Feedback baseline engine (spec #45): the single executor of ralph's
 * feedback diff judgment.
 *
 * A ralph run records, per feedback command, a set of normalized failure
 * SIGNATURE LINES from the current tree at startup; every later gate judges by
 * diffing the current run's signatures against that baseline. New signatures
 * are real signal; baseline-only signatures are environment noise (a dirty
 * toolchain or platform-specific suite) and must not consume iterations.
 *
 * Pure logic here; the CLI command owns execution, IO, and exit codes. The
 * skill text owns when to gate and what a signature means for the current
 * story — this module never decides that.
 */

import * as fs from 'fs';
import { dirname, join } from 'path';

export const FEEDBACK_BASELINE_FILENAME = 'feedback-baseline.json';
/** Sibling directory that keeps replaced baselines recoverable. */
export const FEEDBACK_BASELINE_HISTORY_DIRNAME = 'feedback-baseline.history';
/** Bounded history: older re-records are pruned so the state directory cannot grow without limit. */
export const MAX_FEEDBACK_BASELINE_HISTORY = 20;
/** Per-command signature cap: a pathological runaway output must not become a giant baseline. */
export const MAX_SIGNATURES_PER_COMMAND = 200;

/** ANSI escape sequences, stripped before fingerprinting. */
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
/** Volatile substrings normalized away: durations, timestamps, tmp paths, hex ids. */
const VOLATILE_PATTERNS: RegExp[] = [
  /\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds)\b/gi,
  /\bduration_ms\s*:?\s*\d+(?:\.\d+)?\b/gi,
  /\bduration\s*:?\s*\d+(?:\.\d+)?\b/gi,
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g,
  /[A-Za-z]:\\[^\s:]*\\[^\s]*(?:omc|omc-)[^\s\\\/]+/g,
  /\/tmp\/[\w.-]+/g,
  /\b[0-9a-f]{8,}\b/gi,
];

/**
 * Reduce one command's combined output to its failure signature set:
 * ANSI stripped, volatile fragments normalized, boilerplate dropped,
 * deduplicated, capped, and sorted for a stable diff. Lines that look like
 * progress rather than failure ("Running tests...", spinner frames) are
 * dropped. Pass/test count summary lines (e.g., '# pass N', '# tests N') are
 * excluded but failure count lines (e.g., '# fail N') are kept — a changed
 * fail count is signal that something moved. Individual passing test results
 * ("ok N ...") are excluded to prevent false positives when tests are added;
 * failing results ("not ok ...") are kept.
 */
export function signatureLines(output: string): string[] {
  const seen = new Set<string>();
  for (const raw of output.replace(ANSI_PATTERN, '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    for (const pattern of VOLATILE_PATTERNS) line = line.replace(pattern, '<v>');
    line = line.replace(/\s+/g, ' ').trim();
    if (!line || line.length > 500) continue;
    // Pure progress chatter and test format headers carry no failure signal.
    if (/^(running|collecting|compiling|building|passing|tap\s+version|✓|√|%|\s*at\s)/i.test(line) && !/fail|error|✗|×/i.test(line)) continue;
    // Exclude pass/test/fail/skipped/cancelled/todo summary counters when 0 or for non-failure types.
    // These vary as tests are added; only keep failure counter when fail > 0.
    if (/^#\s*(?:pass|tests?|skipped|cancelled|todo)\s+\d+\s*$/.test(line)) continue;
    if (/^#\s*fail\s+0\s*$/.test(line)) continue;
    // Exclude comments that are just markers or durations (# <v>, # <v> <v>, etc).
    if (/^#\s*<v>\s*(<v>\s*)*$/.test(line)) continue;
    // Exclude TAP plan lines (e.g., "1..2") which vary as tests are added.
    if (/^\d+\.\.\d+\s*$/.test(line)) continue;
    // Exclude individual passing test results (ok N) which vary as tests are added; keep failures (not ok).
    if (/^ok\s+\d+\s+/i.test(line) && !line.includes('not ok')) continue;
    seen.add(line);
    if (seen.size >= MAX_SIGNATURES_PER_COMMAND) break;
  }
  return [...seen].sort();
}

export interface CommandBaseline {
  /** Normalized failure signatures observed for this command at baseline time. */
  signatures: string[];
  /** True when the command could not execute at all (tool missing, suite unrunnable). */
  unrunnable?: boolean;
}

export interface FeedbackBaseline {
  version: 1;
  /** ISO 8601. */
  recordedAt: string;
  commands: Record<string, CommandBaseline>;
}

export interface BaselineDiff {
  /** Present now, absent in the baseline — the only real signal. */
  newSignatures: string[];
  /** In the baseline, gone now — informational only. */
  resolvedSignatures: string[];
}

/**
 * Pure diff: a signature is new when it is absent from the baseline. A command
 * that used to run and now cannot execute is itself a regression. With no
 * baseline at all, everything present is reported as new — the caller decides
 * what that means (baseline creation reports instead of failing).
 */
export function diffAgainstBaseline(
  baseline: FeedbackBaseline | null,
  current: Record<string, CommandBaseline>,
): BaselineDiff {
  if (!baseline) {
    return {
      newSignatures: Object.entries(current).flatMap(([command, entry]) => entry.signatures.map((signature) => `${command}: ${signature}`)),
      resolvedSignatures: [],
    };
  }
  const newSignatures: string[] = [];
  const resolvedSignatures: string[] = [];
  // Iterate the union so a command dropped from the current set still reports
  // its baseline signatures as resolved/removed instead of vanishing silently.
  for (const command of new Set([...Object.keys(baseline.commands), ...Object.keys(current)])) {
    const entry = current[command];
    const before = baseline.commands[command];
    if (!entry) {
      if (before) resolvedSignatures.push(...before.signatures.map((signature) => `${command}: ${signature}`));
      continue;
    }
    if (!before) {
      newSignatures.push(...entry.signatures.map((signature) => `${command}: ${signature}`));
      continue;
    }
    if (entry.unrunnable && !before.unrunnable) {
      newSignatures.push(`${command}: <command became unrunnable>`);
      continue;
    }
    const beforeSet = new Set(before.signatures);
    const afterSet = new Set(entry.signatures);
    for (const signature of afterSet) if (!beforeSet.has(signature)) newSignatures.push(`${command}: ${signature}`);
    for (const signature of beforeSet) if (!afterSet.has(signature)) resolvedSignatures.push(`${command}: ${signature}`);
  }
  return { newSignatures, resolvedSignatures };
}

export function baselinePath(stateRoot: string, sessionId: string): string {
  return join(stateRoot, 'state', 'sessions', sessionId, FEEDBACK_BASELINE_FILENAME);
}

export function readBaseline(path: string): FeedbackBaseline | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const doc = parsed as Partial<FeedbackBaseline>;
    if (doc.version !== 1 || !doc.commands || typeof doc.commands !== 'object') return null;
    return { version: 1, recordedAt: typeof doc.recordedAt === 'string' ? doc.recordedAt : '', commands: doc.commands as Record<string, CommandBaseline> };
  } catch {
    return null;
  }
}

/**
 * Copy the live baseline into its sibling history directory before it is
 * replaced, returning the history path (or null when there is nothing to
 * archive or the copy failed). The file name uses the replaced document's own
 * `recordedAt` (sanitized for cross-platform paths) plus a counter, so history
 * sorts chronologically.
 */
export function archiveBaseline(path: string, now: Date = new Date()): string | null {
  try {
    if (!fs.existsSync(path)) return null;
    const dir = join(dirname(path), FEEDBACK_BASELINE_HISTORY_DIRNAME);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = (readBaseline(path)?.recordedAt || now.toISOString()).replace(/[^0-9A-Za-z.-]+/g, '-');
    // Continue past the highest counter for this stamp. Reusing a hole left by
    // pruning would let a newer archive land on an older-looking name, breaking
    // both chronological sorting and newest-first retention.
    let counter = 1;
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith(`${stamp}-`)) continue;
        const match = /-(\d+)\.json$/.exec(name);
        if (match) counter = Math.max(counter, Number(match[1]) + 1);
      }
    } catch {
      // The directory was just created; start from the first slot.
    }
    let target = join(dir, `${stamp}-${counter}.json`);
    while (fs.existsSync(target)) target = join(dir, `${stamp}-${++counter}.json`);
    fs.copyFileSync(path, target);
    // The archive created by this call must survive pruning even when older
    // timestamps (a restored baseline) sort before existing history entries.
    pruneBaselineHistory(dir, target);
    return target;
  } catch {
    return null;
  }
}

function pruneBaselineHistory(dir: string, keepPath: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((name) => name.endsWith('.json') && join(dir, name) !== keepPath).sort(compareHistoryNames);
  } catch {
    return;
  }
  // Reserve one slot for `keepPath`, so the total never exceeds the cap.
  const budget = Math.max(0, MAX_FEEDBACK_BASELINE_HISTORY - 1);
  for (const name of entries.slice(0, Math.max(0, entries.length - budget))) {
    try {
      fs.rmSync(join(dir, name), { force: true });
    } catch {
      // A file we cannot prune must not block the re-record.
    }
  }
}

/**
 * Chronological history order: the recordedAt stem first, then numeric suffix.
 * A plain string sort would place `...-10.json` before `...-2.json`, so pruning
 * a run of same-timestamp collisions would delete the wrong (newer) archives.
 */
function compareHistoryNames(left: string, right: string): number {
  const leftMatch = /^(.*)-(\d+)\.json$/.exec(left);
  const rightMatch = /^(.*)-(\d+)\.json$/.exec(right);
  if (!leftMatch || !rightMatch) return left < right ? -1 : left > right ? 1 : 0;
  if (leftMatch[1] !== rightMatch[1]) return leftMatch[1] < rightMatch[1] ? -1 : 1;
  return Number(leftMatch[2]) - Number(rightMatch[2]);
}

export interface BaselineWriteResult {
  written: boolean;
  /** History path preserving the replaced baseline, when one existed. */
  previousPath?: string;
  /** Signatures present now but absent from the replaced baseline. */
  added: number;
  /** Signatures in the replaced baseline that are gone now. */
  removed: number;
  /** Commands that ran in the replaced baseline but could not execute now. */
  becameUnrunnable?: string[];
}

/**
 * Write a baseline, archiving any existing document first. The archive must
 * succeed before the live file is replaced: losing history silently is the bug
 * this guards against, so an unarchivable previous baseline fails the write.
 */
export function recordBaseline(path: string, commands: Record<string, CommandBaseline>, now: Date = new Date()): BaselineWriteResult {
  const previous = readBaseline(path);
  const previousPath = archiveBaseline(path, now);
  if (previousPath === null && fs.existsSync(path)) return { written: false, added: 0, removed: 0 };
  try {
    fs.mkdirSync(join(path, '..'), { recursive: true });
    fs.writeFileSync(path, `${JSON.stringify({ version: 1, recordedAt: now.toISOString(), commands }, null, 2)}\n`, 'utf8');
  } catch {
    return { written: false, added: 0, removed: 0 };
  }
  // Audit the document replacement from the raw signature sets, independent of
  // the gate judgment in diffAgainstBaseline: that function collapses a newly
  // unrunnable command into one synthetic marker, which would misreport the
  // stored signatures the replacement actually removed.
  let added = 0;
  let removed = 0;
  const becameUnrunnable: string[] = [];
  if (previous && previousPath) {
    for (const command of new Set([...Object.keys(previous.commands), ...Object.keys(commands)])) {
      const before = previous.commands[command];
      const after = commands[command];
      const beforeSet = new Set(before?.signatures ?? []);
      const afterSet = new Set(after?.signatures ?? []);
      for (const signature of afterSet) if (!beforeSet.has(signature)) added += 1;
      for (const signature of beforeSet) if (!afterSet.has(signature)) removed += 1;
      if (after?.unrunnable && !before?.unrunnable) becameUnrunnable.push(command);
    }
  }
  return {
    written: true,
    ...(previousPath ? { previousPath } : {}),
    added,
    removed,
    ...(becameUnrunnable.length > 0 ? { becameUnrunnable } : {}),
  };
}

/** Backward-compatible wrapper: the boolean says only whether the write succeeded. */
export function writeBaseline(path: string, commands: Record<string, CommandBaseline>, now: Date = new Date()): boolean {
  return recordBaseline(path, commands, now).written;
}
