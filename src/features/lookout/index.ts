/**
 * lookout: pre-flight danger scan for autonomous runs.
 *
 * Before an unattended effort starts (graph run, autopilot, launch, a
 * multi-agent team), lookout scans two inputs:
 *   1. the task briefing text (what the agent is about to be asked to do)
 *   2. the workspace state (what dangerous surfaces already exist)
 * and emits a machine-readable report of findings. High-risk verdicts pair
 * naturally with OMC's approval gates (`omc graph run --approval-mode
 * remote`) and checkpoints (`omc checkpoint create`), but lookout itself is
 * advisory only: it never blocks, never mutates, and has no skip-file
 * backdoor (silence is a whole-feature decision, not a per-run reflex).
 *
 * Design constraints (lessons from the retired risk-assess classifier,
 * see upstream issue #3164):
 * - High-confidence signals only: every rule is mechanically checkable and
 *   reports the exact evidence it matched. No volume heuristics, no
 *   catch-all "unknown means warn" branches, no bare substring matching
 *   on broad tokens (patterns are word- and path-segment-anchored).
 * - Prefer misses over false positives: a lookout that cries wolf trains
 *   users to ignore it, and the protection dies with the habit.
 * - Zero-config: no ignore files, no per-rule toggles. If a scan is noisy,
 *   that is a bug in the rules, not something the user should have to
 *   suppress per run.
 *
 * The finding shape (severity / confidence / actionable) deliberately uses
 * the vocabulary drydock's `--check` audit documents, so a structured
 * contract can later be shared by both surfaces.
 */

import { lstatSync, readFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { LookoutError } from "./types.js";
import type {
  LookoutFinding,
  LookoutReport,
  LookoutSeverity,
  LookoutVerdict,
} from "./types.js";
import { repoRoot, scanWorkspace } from "./workspace.js";
import { addMatch, collectForceOps, collectProtectedPushDests } from "./command-parser.js";
import type { CollectedMatch } from "./command-parser.js";
import { collectRmTestArtifacts } from "./test-artifact-parser.js";
import { findNestedSubstitutions } from "./substitution-parser.js";

export { LookoutError } from "./types.js";
export type {
  LookoutConfidence,
  LookoutFinding,
  LookoutReport,
  LookoutSeverity,
  LookoutVerdict,
} from "./types.js";

const GATE_ADVICE =
  "Pair the run with approval gates: " +
  "`omc graph run --approval-mode remote --checkpoint` so the dangerous " +
  "step waits for explicit human approval.";

const CHECKPOINT_ADVICE =
  "Snapshot the workspace first: `omc checkpoint create --label \"before <task>\"` " +
  "so any bad outcome is one `omc checkpoint rollback <id>` away from undone.";
const MAX_BRIEF_BYTES = 1024 * 1024;

interface BriefRule {
  id: string;
  title: string;
  severity: Extract<LookoutSeverity, "high" | "medium" | "low">;
  pattern: RegExp;
  advice: string;
  /**
   * Optional code-level scanner for signals a single regex cannot express
   * (e.g. inspecting every refspec of a push command, not just the first).
   * Returns evidence snippets and offsets for the line; each is still subject
   * to the same negation check as regex matches.
   */
  collect?: (line: string) => CollectedMatch[];
}

/**
 * Bounded negation handling: a briefing that *forbids* a dangerous action
 * ("Do not skip tests", "Never run git reset --hard") must not be flagged
 * for requesting it. A match is ignored when a negation cue appears within
 * 48 characters before it on the same clause. Clause boundaries prevent a
 * prohibition from masking a separate requested operation later in a line.
 */
const NEGATION_CUE = /\b(?:do\s+not|don't|dont|never|avoid|must\s+not|should\s+not|prohibited)\b/gi;
const NEGATION_HARD_BOUNDARY = /;|&&|\|\||[!?]|\.(?=\s|$)|\r?\n/g;
const NEGATION_WORD_BOUNDARY = /\b(?:then|and|but|however|except|instead)\b/gi;

interface NegationContext {
  cues: Array<{ index: number; end: number }>;
  cueIndexes: number[];
  hardBoundaries: number[];
  wordBoundaries: number[];
  commas: number[];
}

function lastIndexAtMost(values: number[], target: number): number {
  let low = 0;
  let high = values.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] <= target) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

function hasIndexBetween(values: number[], start: number, end: number): boolean {
  const first = lastIndexAtMost(values, start) + 1;
  return first < values.length && values[first] < end;
}

function buildNegationContext(line: string): NegationContext {
  const cues = [...line.matchAll(NEGATION_CUE)].flatMap((match) =>
      match.index === undefined ? [] : [{ index: match.index, end: match.index + match[0].length }],
    );
  return {
    cues,
    cueIndexes: cues.map((cue) => cue.index),
    hardBoundaries: [...line.matchAll(NEGATION_HARD_BOUNDARY)].flatMap((match) =>
      match.index === undefined ? [] : [match.index],
    ),
    wordBoundaries: [...line.matchAll(NEGATION_WORD_BOUNDARY)].flatMap((match) => {
      if (match.index === undefined) return [];
      const before = match.index > 0 ? line[match.index - 1] : "";
      const after = line[match.index + match[0].length] ?? "";
      return (before === "" || /\s/.test(before)) && (after === "" || /\s/.test(after))
        ? [match.index]
        : [];
    }),
    commas: [...line.matchAll(/,/g)].flatMap((match) => (match.index === undefined ? [] : [match.index])),
  };
}

function isNegated(line: string, matchIndex: number, context = buildNegationContext(line)): boolean {
  const cuePosition = lastIndexAtMost(context.cueIndexes, matchIndex);
  const cue = cuePosition >= 0 ? context.cues[cuePosition] : undefined;
  if (!cue || matchIndex - cue.index >= 48) return false;
  const cueIndex = cue.index;
  const cueEnd = cue.end;
  if (/^\s+(?:forget|hesitate|mind)\b/i.test(line.slice(cueEnd))) return false;
  return (
    !hasIndexBetween(context.hardBoundaries, cueIndex, matchIndex) &&
    !hasIndexBetween(context.wordBoundaries, cueIndex, matchIndex) &&
    !hasIndexBetween(context.commas, cueIndex, matchIndex)
  );
}

/**
 * Protected destinations and force flags for `git push` lines, one evidence
 * snippet per offending operand. Grammar (git-push(1)): `git push [<options>]
 * [<repository> [<refspec>...]]` — flags are skipped (value-taking options
 * consume the following token), the first non-flag token is the repository,
 * and every remaining non-flag token is a refspec. Because classification is
 * operand-based, a push-option value can never masquerade as a dry-run or
 * force flag (`git push -o -n origin main --force` is a real forced update).
 * Tokenizing stops at anything that does not look like a command word or at
 * a clause connector, so trailing prose ("... origin feature, then update
 * main docs") cannot turn prose into a refspec.
 */
const SQL_CONTEXT_PATTERN =
  /\bDROP\s+(?:TABLE|DATABASE|MATERIALIZED\s+VIEW|VIEW|INDEX|TYPE|SEQUENCE|TRIGGER)(?:\s+IF\s+EXISTS)?\s+(?:[A-Za-z_][\w.]*|"[^"\r\n]+"|`[^`\r\n]+`)(?=$|[\s;,.`'"])|\bDROP\s+COLUMN\s+(?:[A-Za-z_][\w.]*|"[^"\r\n]+"|`[^`\r\n]+`)(?=$|[\s;,.`'"])|\bDELETE\s+FROM\s+(?:[A-Za-z_][\w.]*|"[^"\r\n]+"|`[^`\r\n]+`)(?=$|[\s;,.`'"])|\bTRUNCATE\s+(?:(?:TABLE|ONLY)\s+)?(?:IF\s+EXISTS\s+)?(?:[A-Za-z_][\w.]*|"[^"\r\n]+"|`[^`\r\n]+`)(?=$|[\s;,.`'"])/gi;
const SQL_SCHEMA_PATTERN = /\bDROP\s+SCHEMA(?:\s+IF\s+EXISTS)?\s+(?:[A-Za-z_][\w.]*|"[^"\r\n]+"|`[^`\r\n]+`)(?=$|[\s;,.`'"])/gi;

function isExplicitSqlContext(line: string, end: number, start: number): boolean {
  const before = line.slice(0, start);
  const backticks = (before.match(/`/g) ?? []).length;
  if (backticks % 2 === 1) return true;
  if (hasSqlClientCommandContext(before)) {
    return true;
  }
  const rest = line.slice(end);
  if (/^\s*;/.test(rest)) return true;
  const semicolon = rest.indexOf(";");
  return (
    semicolon >= 0 &&
    /\b(?:where|cascade|restrict|using|returning|set|order\s+by|group\s+by|limit|having)\b/i.test(
      rest.slice(0, semicolon),
    )
  );
}

function hasOpenShellQuote(text: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (character === '"') quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
  }
  return quote !== null;
}

function hasSqlClientCommandContext(before: string): boolean {
  const lastNewline = before.lastIndexOf("\n");
  const context = lastNewline >= 0 && !hasOpenShellQuote(before) ? before.slice(lastNewline + 1) : before;
  const segment = context.split(/[;&|]/).at(-1) ?? context;
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < tokens.length) {
    const value = tokens[index].replace(/^[-*>]+/, "");
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
      index += 1;
      continue;
    }
    if (/^(?:sudo|env)$/i.test(value)) {
      const wrapper = value.toLowerCase();
      index += 1;
      while (index < tokens.length) {
        const option = tokens[index];
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(option)) {
          index += 1;
          continue;
        }
        if (wrapper === "sudo" && /^(?:-u|--user|-g|--group|-D|-R|-T|--chdir|--chroot|--command-timeout)$/.test(option)) {
          index += 2;
          continue;
        }
        if (wrapper === "env" && /^(?:-C|--chdir|-u|--unset)$/.test(option)) {
          index += 2;
          continue;
        }
        if (option.startsWith("-")) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    return /(?:^|\/)(?:sqlite3|psql|mysql|mariadb|sqlcmd)$/i.test(value);
  }
  return false;
}

function collectSqlDestructive(line: string): CollectedMatch[] {
  const hits: CollectedMatch[] = [];
  const normalizedLine = line.replace(/\\(?=\s)/g, " ");
  for (const pattern of [SQL_CONTEXT_PATTERN, SQL_SCHEMA_PATTERN]) {
    for (const match of normalizedLine.matchAll(pattern)) {
      const index = match.index ?? 0;
      const uppercaseSchema = pattern === SQL_SCHEMA_PATTERN && /^DROP\s+SCHEMA\b/.test(match[0]);
      if (uppercaseSchema || isExplicitSqlContext(normalizedLine, index + match[0].length, index)) {
        addMatch(hits, match[0].replace(/\s+/g, " ").trim(), index);
      }
    }
  }
  return hits;
}

/**
 * Briefing rules. Every pattern is anchored on the dangerous operation or
 * surface itself (word boundaries, explicit compound phrases) — never on
 * broad tokens like "auth" or "migration" that appear in routine work.
 */
const BRIEF_RULES: BriefRule[] = [
  {
    id: "lookout.brief.force-op",
    title: "Briefing asks for a destructive git/file operation",
    severity: "high",
    // All command-shaped operations are classified by the operand parser
    // below; a bare regex would also flag printed examples such as
    // `echo 'git reset --hard'`.
    pattern: /$^/g,
    advice: GATE_ADVICE,
    // Command-shaped pushes and rm invocations are parsed below so option
    // values, dry runs, mixed spellings, and clause boundaries are handled
    // without a regex guessing at token roles.
    collect: collectForceOps,
  },
  {
    id: "lookout.brief.db-destructive",
    title: "Briefing asks for destructive database operations",
    severity: "high",
    // Case-sensitive SQL keywords on purpose: "drop table borders" and
    // "truncate long labels" are English prose, not SQL. Uppercase (or a
    // quoted/statement context) is the high-confidence signal. The keyword
    // carries the case sensitivity — the identifier may be any case
    // (TRUNCATE TABLE Users is valid SQL).
    advice: GATE_ADVICE,
    pattern:
      /\bDROP\s+(?:TABLE|DATABASE|MATERIALIZED\s+VIEW|VIEW|INDEX|TYPE|SEQUENCE|TRIGGER)(?:\s+IF\s+EXISTS)?\s+(?:[A-Za-z_][\w.]*|"[^"\r\n]+"|`[^`\r\n]+`)(?=$|[\s;,.`'"])|\bDROP\s+COLUMN\s+(?:[A-Za-z_][\w.]*|"[^"\r\n]+"|`[^`\r\n]+`)(?=$|[\s;,.`'"])|\bDELETE\s+FROM\s+(?:[A-Za-z_][\w.]*|"[^"\r\n]+"|`[^`\r\n]+`)(?=$|[\s;,.`'"])|\bTRUNCATE\s+(?:TABLE\s+|ONLY\s+)?(?:IF\s+EXISTS\s+)?(?:[A-Za-z_][\w.]*|"[^"\r\n]+"|`[^`\r\n]+`)(?=$|[\s;,.`'"])/g,
    collect: collectSqlDestructive,
  },
  {
    id: "lookout.brief.test-deletion",
    title: "Briefing asks to delete, skip, or disable tests",
    severity: "high",
    // Covers plural "tests", "test files/suites/cases" phrases, and direct
    // conventional test paths (src/auth.test.ts, tests/auth.spec.ts).
    pattern:
      /\b(?:delete|remove|drop)\s+(?:(?:all|the|existing|failing|flaky|these|unit|integration|e2e|regression)\s+){0,3}tests\b|\b(?:delete|remove|drop|skip|disable|bypass|ignore)\s+(?:the\s+)?(?:[\w./-]+\s+){1,2}tests\b|\b(?:delete|remove|drop)\s+(?:\w+\s+){0,2}test\s+(?:files?|suites?|cases?)\b|\b(?:skip|disable|bypass|ignore)\s+(?:(?:the|all|failing|flaky|unit|integration|e2e|regression)\s+){0,3}tests\b|\b(?:delete|remove|drop|skip|disable|bypass|ignore)\s+(?:(?:the|this|that|failing|flaky|unit|integration|e2e|regression)\s+){0,3}test\b(?!\s+(?:data|fixtures?|code|directory|folder|account|environment|database|server|user|record|table|branch|helper|hook)\b)|\b(?:delete|remove|drop|skip|disable|bypass|ignore)\s+(?:\w+\s+){0,2}[\w./@~-]*\.(?:test|spec)\.[cm]?[jt]sx?\b|\b(?:delete|remove|drop)\s+(?:the\s+)?(?:tests?|__tests?__|specs?|e2e)\s+(?:directories?|folders?|trees?)\b/gi,
    advice: GATE_ADVICE,
    collect: collectRmTestArtifacts,
  },
  {
    id: "lookout.brief.protected-branch",
    title: "Briefing targets a protected branch directly",
    severity: "high",
    // Prose forms only — command-shaped pushes (`git push ...`) are handled
    // by the tokenizer below, which parses operands instead of guessing at
    // token roles (a remote can be named main; value-taking options consume
    // the next token).
    pattern:
      /\b(?:push|merge|force-merge|squash-merge)\s+(?:\w+\s+){0,3}?(?:to|into|on|against|onto)\s+(?:the\s+)?(?:main|master|develop|release(?:\/[\w./-]+)?|production(?:\/[\w./-]+)?)(?![\w-])|\bdirect(?:ly)?\s+(?:push|commit|merge)\w*\s+(?:\w+\s+){0,2}?(?:to|into|on)\s+(?:the\s+)?(?:main|master|develop|release(?:\/[\w./-]+)?|production(?:\/[\w./-]+)?)(?![\w-])/gi,
    advice: GATE_ADVICE,
    // A push may carry several refspecs (`git push origin feature main`
    // updates both), so every operand-parsed refspec destination is
    // inspected; dry-run pushes are silenced inside the parser.
    collect: collectProtectedPushDests,
  },
  {
    id: "lookout.brief.secrets-touch",
    title: "Briefing touches secret material (.env, keys, credentials)",
    severity: "medium",
    pattern:
      /\.env(?![\w-])(?!(?:\.[\w-]+)*\.(?:example|sample|template|dist)\b)(?:\.[\w-]+)*|\bapi[-_ ]?keys?\b|\bprivate[-_ ]?keys?\b|\bcredentials?\b|\bsecrets?\b/gi,
    advice:
      "Secret surfaces are easy to leak and hard to un-leak. If the task " +
      "really needs to read or change them, " + GATE_ADVICE,
  },
  {
    id: "lookout.brief.ci-touch",
    title: "Briefing modifies CI/CD configuration",
    severity: "medium",
    pattern:
      /\bgithub\s+actions?\b|\bgitlab[- ]?ci\b|\bjenkinsfile\b|\.github\/workflows\b|\bci\s+(?:workflow|pipeline|config|job|yml|yaml)s?\b/gi,
    advice:
      "CI changes silently widen what future runs can do. If intended, " +
      GATE_ADVICE,
  },
  {
    id: "lookout.brief.deploy-touch",
    title: "Briefing modifies deployment/infrastructure configuration",
    severity: "medium",
    pattern:
      /\b(?:deploy|deployment|k8s|kubernetes|helm|terraform|infra|staging|production)\s+(?:config|configuration|manifest|definition|yml|yaml|file|script|infra(?:structure)?|cluster|environment)s?\b|\b(?:deploy|infra|k8s|kubernetes|helm|terraform)\//gi,
    advice:
      "Deployment changes can be irreversible once shipped. If intended, " +
      GATE_ADVICE,
  },
];

function computeSummary(findings: LookoutFinding[]): LookoutReport["summary"] {
  const counts: Record<LookoutSeverity, number> = {
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const finding of findings) counts[finding.severity] += 1;
  const verdict: LookoutVerdict =
    counts.high > 0
      ? "review-recommended"
      : counts.medium > 0 || counts.low > 0
        ? "advisory"
        : "clear";
  return { counts, verdict };
}

function isInertTestDeletionText(line: string, index: number): boolean {
  const prefix = line.slice(0, index);
  const commandPrefix = prefix.split(/[;&|]/).at(-1) ?? prefix;
  if (/^\s*(?:echo|printf|print|cat)\b/i.test(commandPrefix)) return true;
  return (
    /["'`]\s*$/.test(prefix) &&
    /\b(?:add|include|write|document|quote|show|print)\b/i.test(prefix)
  );
}

function isInertOutputText(line: string, index: number): boolean {
  const prefix = line.slice(0, index);
  const commandPrefix = prefix.split(/[;&|]/).at(-1) ?? prefix;
  if (/\|\s*(?:[\w./-]*\/)?(?:sqlite3|psql|mysql|mariadb|sqlcmd)\b/i.test(line.slice(index))) return false;
  return /^\s*(?:echo|printf|print|cat)\b/i.test(commandPrefix);
}

function isDocumentationSqlExample(line: string, index: number): boolean {
  const prefix = line.slice(0, index);
  return /\b(?:document|write|quote|include|show|example)\b/i.test(prefix) && /["'`]/.test(prefix);
}

const HEREDOC_INTERPRETER = /^(?:[\w./@-]+\/)?(?:bash|sh|dash|zsh|ksh|sqlite3|psql|mysql|mariadb|sqlcmd)$/i;

interface HereDocMarker {
  name: string;
  quoted: boolean;
  stripTabs: boolean;
  interpreter: boolean;
}

function findHereDocMarkers(line: string): HereDocMarker[] {
  const markers: HereDocMarker[] = [];
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (character === '"') quote = null;
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "'") {
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = '"';
      continue;
    }
    if (character === "#" && (index === 0 || /\s/.test(line[index - 1] ?? ""))) return [];
    if (!line.startsWith("<<", index)) continue;
    let cursor = index + 2;
    const stripTabs = line[cursor] === "-";
    if (stripTabs) cursor += 1;
    while (/\s/.test(line[cursor] ?? "")) cursor += 1;
    let delimiterQuote: "'" | '"' | null = null;
    let quoted = false;
    let name = "";
    while (cursor < line.length) {
      const value = line[cursor] ?? "";
      if (delimiterQuote === "'") {
        if (value === "'") delimiterQuote = null;
        else name += value;
        cursor += 1;
        continue;
      }
      if (delimiterQuote === '"') {
        if (value === "\\" && cursor + 1 < line.length) {
          quoted = true;
          name += line[cursor + 1] ?? "";
          cursor += 2;
          continue;
        }
        if (value === '"') delimiterQuote = null;
        else name += value;
        cursor += 1;
        continue;
      }
      if (value === "'") {
        delimiterQuote = "'";
        quoted = true;
        cursor += 1;
        continue;
      }
      if (value === '"') {
        delimiterQuote = '"';
        quoted = true;
        cursor += 1;
        continue;
      }
      if (value === "\\" && cursor + 1 < line.length) {
        quoted = true;
        name += line[cursor + 1] ?? "";
        cursor += 2;
        continue;
      }
      if (/\s|[;&|<>]/.test(value)) break;
      name += value;
      cursor += 1;
    }
    if (!name || delimiterQuote !== null) return [];
    const receiver = line.slice(0, index).split(/[\s|;&()]+/).filter(Boolean);
    markers.push({ name, quoted, stripTabs, interpreter: receiver.some((token) => HEREDOC_INTERPRETER.test(token)) });
    index = cursor - 1;
  }
  return markers;
}

function maskHereDocBody(brief: string): string[] {
  const lines = brief.split("\n");
  let pending: HereDocMarker[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (pending.length > 0) {
      const marker = pending[0];
      const candidate = marker.stripTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === marker.name) {
        pending.shift();
        lines[index] = "";
      } else if (marker.interpreter) {
        // The body is executable input to a shell or SQL client; keep it for scanning.
      } else if (marker.quoted) {
        lines[index] = "";
      } else {
        lines[index] = findNestedSubstitutions([{ text: line, index: 0 }])
          .map((substitution) => substitution.text)
          .join(" ");
      }
      continue;
    }
    const markers = findHereDocMarkers(line);
    if (markers.length > 0) pending = markers;
  }
  return lines;
}

export interface ScanLookoutOptions {
  /** Directory to scan (defaults to process.cwd() at the CLI layer). */
  repo: string;
  /** Briefing text to scan; omit to scan workspace state only. */
  brief?: string;
  /** Where the brief came from (report metadata only). */
  briefSource?: LookoutReport["briefSource"];
  /** Injectable clock for tests. */
  now?: Date;
}

/**
 * Runs every lookout rule over the given inputs and returns the full report.
 * Read-only by construction: the only filesystem/git access is reading
 * tracked-file lists and status output.
 */
export function scanLookout(options: ScanLookoutOptions): LookoutReport {
  const findings: LookoutFinding[] = [];

  const brief = options.brief;
  if (brief !== undefined) {
    const scanBrief = brief.replace(/\\\r?\n[ \t]*/g, " ");
    const scanLines = maskHereDocBody(scanBrief);
    const maskedBrief = scanLines.join("\n");
    // Rules evaluate line by line while command collectors split clauses so
    // a dry run or prohibition cannot hide a separate requested operation later in the
    // same line.
    for (const rule of BRIEF_RULES) {
      const evidence: string[] = [];
      const inputLines =
        rule.id === "lookout.brief.db-destructive" ? [maskedBrief] : scanLines;
      for (const line of inputLines) {
        const negationContext = buildNegationContext(line);
        const re = new RegExp(rule.pattern.source, rule.pattern.flags);
        for (const match of line.matchAll(re)) {
          if (match.index !== undefined && isNegated(line, match.index, negationContext)) continue;
          if (
            match.index !== undefined &&
            (rule.id === "lookout.brief.db-destructive" || rule.id === "lookout.brief.protected-branch") &&
            (isInertOutputText(line, match.index) || isDocumentationSqlExample(line, match.index))
          ) {
            continue;
          }
          if (
            rule.id === "lookout.brief.test-deletion" &&
            match.index !== undefined &&
            isInertTestDeletionText(line, match.index)
          ) {
            continue;
          }
          const snippet = match[0].replace(/\s+/g, " ").trim();
          if (
            rule.id === "lookout.brief.protected-branch" &&
            /\b(?:main|master|develop|release(?:\/[\w./-]+)?|production(?:\/[\w./-]+)?)\b/i.test(snippet) &&
            !/\b(?:git|branch|ref(?:spec)?|remote|commit|pr|force\s+push)\b/i.test(line)
          ) {
            continue;
          }
          if (snippet && !evidence.includes(snippet)) evidence.push(snippet);
          if (evidence.length >= 3) break;
        }
        if (rule.collect) {
          for (const match of rule.collect(line)) {
            if (isNegated(line, match.index, negationContext)) continue;
            if (
              rule.id === "lookout.brief.db-destructive" &&
              (isInertOutputText(line, match.index) || isDocumentationSqlExample(line, match.index))
            ) continue;
            if (!evidence.includes(match.snippet)) evidence.push(match.snippet);
            if (evidence.length >= 3) break;
          }
        }
        if (evidence.length >= 3) break;
      }
      if (evidence.length > 0) {
        findings.push({
          id: rule.id,
          title: rule.title,
          severity: rule.severity,
          confidence: "high",
          actionable: true,
          evidence,
          advice: rule.advice,
        });
      }
    }
  }

  const root = repoRoot(options.repo);
  if (root) {
    findings.push(
      ...scanWorkspace(root, { gate: GATE_ADVICE, checkpoint: CHECKPOINT_ADVICE }),
    );
  }

  return {
    scannedAt: (options.now ?? new Date()).toISOString(),
    repo: root,
    briefSource: options.briefSource ?? (brief === undefined ? "none" : "flag"),
    findings,
    summary: computeSummary(findings),
  };
}

/** Loads a briefing from `@path` (or returns inline text unchanged). */
export function resolveBriefArg(briefArg: string): { text: string; source: LookoutReport["briefSource"] } {
  if (!briefArg.startsWith("@")) return { text: briefArg, source: "flag" };
  const path = isAbsolute(briefArg.slice(1)) ? briefArg.slice(1) : join(resolve(process.cwd()), briefArg.slice(1));
  let text: string;
  try {
    const stats = lstatSync(path);
    if (!stats.isFile()) throw new Error("briefing path is not a regular file");
    if (stats.size > MAX_BRIEF_BYTES) throw new Error(`briefing exceeds ${MAX_BRIEF_BYTES} bytes`);
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new LookoutError(`Cannot read briefing file ${path}: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
  return { text, source: "file" };
}
