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
import { withFileLockSync, lockPathFor } from '../../lib/file-lock.js';

export const FEEDBACK_BASELINE_FILENAME = 'feedback-baseline.json';
/** Sibling directory that keeps replaced baselines recoverable. */
export const FEEDBACK_BASELINE_HISTORY_DIRNAME = 'feedback-baseline.history';
/** Bounded history: older re-records are pruned so the state directory cannot grow without limit. */
export const MAX_FEEDBACK_BASELINE_HISTORY = 20;
/** Per-command signature cap: a pathological runaway output must not become a giant baseline. */
export const MAX_SIGNATURES_PER_COMMAND = 200;
// Lock timeout constants are now in the PID-aware file-lock.ts module.

/** ANSI escape sequences, stripped before fingerprinting. */
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
/** Failure vocabulary shared by the log-level, progress, and summary filters. */
const FAILURE_WORD_PATTERN = /\bfail(?:ed|ure|ures|ing)?\b|\w*(?:Error|Exception)s?\b|✗|×/i;
/** Volatile substrings normalized away: durations, timestamps, tmp paths, hex ids. */
const VOLATILE_PATTERNS: RegExp[] = [
  // Pytest's wall-clock parenthesized duration, e.g. "... in 194.32s (0:03:14)".
  // Anchored to the "in <duration>" suffix so clock-shaped assertion values
  // (e.g. assert '(12:15)' == '(12:16)') keep their failure signal.
  /(?<=\bin \d+(?:\.\d+)?s\s)\(\d+:\d{2}(?::\d{2})?(?:\.\d+)?\)/g,
  /\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds)\b/gi,
  /\bduration_ms\s*:?\s*\d+(?:\.\d+)?\b/gi,
  /\bduration\s*:?\s*\d+(?:\.\d+)?\b/gi,
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g,
  /[A-Za-z]:\\[^\s:]*\\[^\s]*(?:omc|omc-)[^\s\\\/]+/g,
  /\/tmp\/[\w.-]+/g,
  // The process id in Node's warning prefix, "(node:12345) [DEP0040] DeprecationWarning: ...", differs on every run.
  // Only an id followed by an optional [code] and a "Name:" is replaced, so "(node:42) ready" in an assertion keeps its signal.
  /(?<=\(node:)\d+(?=\) (?:\[[^\]]+\] )?\w+:)/g,
  // macOS per-user temp dirs (os.tmpdir()) are handled by
  // normalizeMacosTempPaths(): only the mkdtemp-style random segment is
  // replaced so stable suffixes (file:line:column) still distinguish failures.
  /\b[0-9a-f]{8,}\b/gi,
];

/** macOS temp roots: /var/folders/<xx>/<hash>/T/<segments>, optionally /private-prefixed. */
const MACOS_TEMP_PATH_PATTERN = /(?:\/private)?\/var\/folders\/[^/\s"']+\/[^/\s"']+\/T((?:\/[^/\s"']*)*)/g;

/** mkdtemp appends six random alphanumerics (e.g. 85IacC, jxgQGA, 0yogcC). */
const RANDOM_TEMP_SEGMENT_PATTERN = /^[A-Za-z0-9._-]*[A-Za-z0-9]{6}$/;

function isRandomTempSegment(segment: string): boolean {
  if (!RANDOM_TEMP_SEGMENT_PATTERN.test(segment)) return false;
  const suffix = segment.slice(-6);
  return /[0-9]/.test(suffix) || (/[A-Z]/.test(suffix) && /[a-z]/.test(suffix));
}

/**
 * Replace the temp root, the first directory beneath it (the mkdtemp dir), and
 * any later mkdtemp-style segment, while keeping stable repo-relative
 * directories and the leaf filename/line:
 * `/var/folders/x/y/T/repo-A/packages/a/index.ts:1:1` becomes
 * `<v>/packages/a/index.ts:1:1`, so failures in different packages stay
 * distinct across runs.
 */
function normalizeMacosTempPaths(line: string): string {
  return line.replace(MACOS_TEMP_PATH_PATTERN, (_match, rest: string) => {
    const segments = rest.split('/').filter(Boolean);
    const normalized = segments.map((segment, index) => {
      const isLeaf = index === segments.length - 1;
      if (isLeaf && /[.:]/.test(segment)) return segment;
      if (index === 0 || isRandomTempSegment(segment)) return '<v>';
      return segment;
    });
    const joined = normalized.join('/');
    // A lone leaf filename has no directory to anchor it; keep the temp-root
    // marker so it cannot collide with a real relative path.
    return segments.length === 1 && /[.:]/.test(segments[0]) ? `<v>/${joined}` : joined;
  });
}

/**
 * Reduce one command's combined output to its failure signature set:
 * ANSI stripped, volatile fragments normalized, boilerplate dropped,
 * deduplicated, capped, and sorted for a stable diff. Lines that look like
 * progress rather than failure ("Running tests...", spinner frames) are
 * dropped, as are below-WARN log levels and package-manager/runner chrome
 * that is identical on a green run. Pass/test count summary lines (e.g.,
 * '# pass N', '# tests N') are excluded but failure count lines (e.g.,
 * '# fail N') are kept — a changed fail count is signal that something moved.
 * Individual passing test results ("ok N ...", "✓ ...") are excluded to
 * prevent false positives when tests are added; failing results ("not ok
 * ...", "✗ ...") are kept.
 */
export function signatureLines(output: string): string[] {
  const seen = new Set<string>();
  for (const raw of output.replace(ANSI_PATTERN, '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    for (const pattern of VOLATILE_PATTERNS) line = line.replace(pattern, '<v>');
    line = normalizeMacosTempPaths(line);
    line = line.replace(/\s+/g, ' ').trim();
    if (!line || line.length > 500) continue;
    // Below-WARN logs are noise unless the message itself reports a failure
    // ("INFO validation failed"), which is the only signal a quiet failing
    // command may emit.
    if ((/^(?:\[[^\]]*\]\s*)*(?:<v>\s+)?(?:TRACE|DEBUG|INFO|NOTICE)\b/i.test(line)
      || /^\[(?:TRACE|DEBUG|INFO|NOTICE)\]/i.test(line)) && !FAILURE_WORD_PATTERN.test(line)) continue;
    if (/^(?:npm|yarn|pnpm)\s+warn\b/i.test(line)) continue;
    if (/^>\s+\S+@\S+/.test(line)) continue;
    if (/^>\s+(?:tsc|vite|vitest|jest|node|npm|yarn|pnpm|eslint|tsx|ts-node)\b/i.test(line)) continue;
    if (/^(?:RUN\s+v?\d|Duration\s)/i.test(line)) continue;
    // Green summaries are chrome; summaries naming any failure variant are signal.
    if (/^(?:Test Files|Tests)\b/.test(line) && !FAILURE_WORD_PATTERN.test(line)) continue;
    // Source-context frames repeat the failing code but shift on every edit.
    if (/^\d+\|\s/.test(line) || /^\|\s*\^/.test(line)) continue;
    // Vitest/Jest mark passing cases with ✓/√ — never failure signal, even
    // when the test name itself mentions "Error" (e.g. EmptyDiffError).
    if (/^(?:✓|√)/.test(line)) continue;
    // Pure progress chatter and test format headers carry no failure signal.
    if (/^(running|collecting|compiling|building|passing|tap\s+version|%|\s*at\s)/i.test(line) && !FAILURE_WORD_PATTERN.test(line)) continue;
    // Drop all-pass pytest progress lines (dots plus skipped/xfail/xpass markers with an optional "[ NN%]" suffix); their width and percentages shift with the test count. A line containing F/E is a failure marker and must survive, because quiet runs can emit only that line.
    if (/^[.sxX]+(?:\s*\[\s*\d+%\]\s*)?$/.test(line)) continue;
    // Exclude pytest all-pass summaries ("N passed in <v>", optionally with warnings/skipped/...
    // and a trailing duration already normalized to one or more "<v>" tokens); a summary that
    // reports failures/errors does not match and is kept below.
    if (/^\d+ passed(?:, \d+ (?:warnings?|skipped|xfailed|xpassed|deselected))* in <v>(?: <v>)*(?: \([^)]*\))?$/.test(line)) continue;
    // Drop vitest's summary clock ("Start at  00:09:56"): the wall-clock start time differs on every run and
    // carries no failure signal. Whole-line match, so a clock inside an assertion message is kept.
    if (/^Start at \d{2}:\d{2}:\d{2}$/.test(line)) continue;
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
  /** Process exit status observed at baseline time; absent when the command never ran. */
  exitCode?: number;
  /** True when the command could not execute at all (tool missing, suite unrunnable). */
  unrunnable?: boolean;
  /**
   * True when the command exceeded the verify timeout. A killed process only
   * produced partial output, so nothing in it is failure evidence: the
   * progress lines depend on how long the run lasted, not on what failed.
   */
  timedOut?: boolean;
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

function exitCodeFailure(command: string, entry: CommandBaseline): string | null {
  return entry.exitCode !== undefined && entry.exitCode !== 0
    ? `${command}: <exited with code ${entry.exitCode}>`
    : null;
}

/**
 * Pure diff: a signature is new when it is absent from the baseline. A command
 * that used to run and now cannot execute is itself a regression. So is a
 * command that used to exit 0 and now exits nonzero — a failure whose only
 * diagnostic is below WARN (e.g. `INFO validation failed`) normalizes to no
 * signatures, so the status transition is the only signal it leaves. A command
 * absent from the baseline inherits the same rule: a newly discovered failing
 * command must not slip through just because it has no history. With no
 * baseline at all, everything present is reported as new — the caller decides
 * what that means (baseline creation reports instead of failing).
 */
export function diffAgainstBaseline(
  baseline: FeedbackBaseline | null,
  current: Record<string, CommandBaseline>,
): BaselineDiff {
  if (!baseline) {
    return {
      newSignatures: Object.entries(current).flatMap(([command, entry]) => {
        const exitFailure = exitCodeFailure(command, entry);
        return [
          ...entry.signatures.map((signature) => `${command}: ${signature}`),
          ...(exitFailure ? [exitFailure] : []),
        ];
      }),
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
      const exitFailure = exitCodeFailure(command, entry);
      if (exitFailure) newSignatures.push(exitFailure);
      continue;
    }
    if (entry.timedOut && !before.timedOut) {
      // The command never finished, so there is no output to compare. Report
      // the timeout itself instead of fingerprinting a partial run.
      newSignatures.push(`${command}: <command timed out>`);
      continue;
    }
    if (entry.unrunnable && !before.unrunnable) {
      newSignatures.push(`${command}: <command became unrunnable>`);
      continue;
    }
    // Baselines recorded before exitCode existed default to success; they must
    // be re-recorded, and the one-time transition is the nudge to do so.
    const beforeExitCode = before.exitCode ?? 0;
    if (entry.exitCode !== undefined && beforeExitCode === 0 && entry.exitCode !== 0) {
      newSignatures.push(`${command}: <exited with code ${entry.exitCode}>`);
    } else if (entry.exitCode === 0 && beforeExitCode !== 0) {
      resolvedSignatures.push(`${command}: <no longer exits with code ${beforeExitCode}>`);
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
    // Reserve the target atomically: COPYFILE_EXCL prevents overwriting an
    // existing file (critical when concurrent writers create the same timestamp).
    // Retry with an incremented counter on collision.
    while (true) {
      try {
        fs.copyFileSync(path, target, fs.constants.COPYFILE_EXCL);
        break;
      } catch (err) {
        const isEEXIST = (err as NodeJS.ErrnoException)?.code === 'EEXIST';
        if (isEEXIST) {
          counter += 1;
          target = join(dir, `${stamp}-${counter}.json`);
          continue;
        }
        throw err;
      }
    }
    // No pruning here: the archive must not be evicted until the replacement
    // that depends on it has actually landed. recordBaseline prunes after a
    // successful live write; pruning first would evict history when that write
    // fails and the caller retries.
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

// Lock acquisition and release are now handled by the PID-aware withFileLockSync from file-lock.ts.

/**
 * Write a baseline, archiving any existing document first. The archive must
 * succeed before the live file is replaced: losing history silently is the bug
 * this guards against, so an unarchivable previous baseline fails the write.
 *
 * The whole read/archive/write transaction runs under a sibling `.lock` file.
 * `COPYFILE_EXCL` only makes archive NAMES unique; without serialization two
 * writers could archive the same original and the second could overwrite the
 * first replacement without archiving it. A writer that cannot take the lock
 * fails closed rather than proceeding unlocked.
 *
 * A failed live write leaves the archive in place: when `writeFileSync` fails
 * partway (ENOSPC/EFBIG) that archive is the only intact recovery copy.
 */
export function recordBaseline(path: string, commands: Record<string, CommandBaseline>, now: Date = new Date()): BaselineWriteResult {
  // The lock lives beside the baseline, so its parent must exist first.
  try {
    fs.mkdirSync(dirname(path), { recursive: true });
  } catch {
    return { written: false, added: 0, removed: 0 };
  }
  const lockPath = lockPathFor(path);
  // Use PID-aware locking to respect live process ownership.
  // Pass explicit retry/timeout options (10s timeout, 50ms retry), matching the previous bounded wait to handle lock contention gracefully.
  try {
    return withFileLockSync(lockPath, () => {
      const previous = readBaseline(path);
      const previousPath = archiveBaseline(path, now);
      if (previousPath === null && fs.existsSync(path)) return { written: false, added: 0, removed: 0 };
      try {
        fs.writeFileSync(path, `${JSON.stringify({ version: 1, recordedAt: now.toISOString(), commands }, null, 2)}\n`, 'utf8');
      } catch {
        // Deliberately keep the archive: a partial live write makes it the only
        // intact copy of the document the caller was replacing.
        return { written: false, added: 0, removed: 0 };
      }
      // Prune only now that the live replacement succeeded, so a failed write and
      // its retry never evict history for a replacement that never landed.
      if (previousPath) pruneBaselineHistory(dirname(previousPath), previousPath);
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
          // Only mark as becameUnrunnable if the command existed in the previous baseline.
          // A newly added unrunnable command was never runnable, so it doesn't "become" unrunnable.
          if (before && after?.unrunnable && !before?.unrunnable) becameUnrunnable.push(command);
        }
      }
      return {
        written: true,
        ...(previousPath ? { previousPath } : {}),
        added,
        removed,
        ...(becameUnrunnable.length > 0 ? { becameUnrunnable } : {}),
      };
    }, { timeoutMs: 10_000, retryDelayMs: 50 });
  } catch (err) {
    // Lock acquisition failed due to contention or timeout
    if (err instanceof Error && err.message.includes('Failed to acquire file lock')) {
      return { written: false, added: 0, removed: 0 };
    }
    throw err;
  }
}

/** Backward-compatible wrapper: the boolean says only whether the write succeeded. */
export function writeBaseline(path: string, commands: Record<string, CommandBaseline>, now: Date = new Date()): boolean {
  return recordBaseline(path, commands, now).written;
}
