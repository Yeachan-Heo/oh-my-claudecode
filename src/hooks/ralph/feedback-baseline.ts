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
import { join } from 'path';

export const FEEDBACK_BASELINE_FILENAME = 'feedback-baseline.json';
/** Per-command signature cap: a pathological runaway output must not become a giant baseline. */
export const MAX_SIGNATURES_PER_COMMAND = 200;

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
  for (const [command, entry] of Object.entries(current)) {
    const before = baseline.commands[command];
    if (!before) {
      newSignatures.push(...entry.signatures.map((signature) => `${command}: ${signature}`));
      const exitFailure = exitCodeFailure(command, entry);
      if (exitFailure) newSignatures.push(exitFailure);
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

export function writeBaseline(path: string, commands: Record<string, CommandBaseline>, now: Date = new Date()): boolean {
  try {
    fs.mkdirSync(join(path, '..'), { recursive: true });
    fs.writeFileSync(path, `${JSON.stringify({ version: 1, recordedAt: now.toISOString(), commands }, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}