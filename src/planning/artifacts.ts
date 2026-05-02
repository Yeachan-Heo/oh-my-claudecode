// src/planning/artifacts.ts

/**
 * Planning artifacts reader.
 *
 * Reads .omc/plans/ directory for PRD and test-spec files,
 * and extracts approved execution launch hints embedded in PRD markdown.
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import {
  comparePlanningArtifactPaths,
  selectLatestPlanningArtifactPath,
  selectMatchingTestSpecsForPrd,
} from "./artifact-names.js";

export interface PlanningArtifacts {
  prdPaths: string[];
  testSpecPaths: string[];
}

export interface ApprovedExecutionLaunchHint {
  mode: "team" | "ralph";
  command: string;
  task: string;
  workerCount?: number;
  agentType?: string;
  linkedRalph?: boolean;
  sourcePath: string;
}

interface ApprovedExecutionLaunchHintReadOptions {
  prdPath?: string;
  task?: string;
  command?: string;
  requirePlanningComplete?: boolean;
}

export type ApprovedExecutionLaunchHintOutcome =
  | { status: "absent" }
  | { status: "ambiguous" }
  | { status: "incomplete" }
  | { status: "resolved"; hint: ApprovedExecutionLaunchHint };

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getSectionContent(markdown: string, heading: string): string | null {
  const headingRe = new RegExp(
    `^##\\s+${escapeRegex(heading)}[ \\t]*$`,
    "im",
  );
  const headingMatch = headingRe.exec(markdown);
  if (!headingMatch || headingMatch.index === undefined) return null;

  const bodyStart = headingMatch.index + headingMatch[0].length;
  const rest = markdown.slice(bodyStart).replace(/^\r?\n/, "");
  const nextHeadingMatch = /\r?\n##\s+/.exec(rest);
  const body = (nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest).trim();
  return body.length > 0 ? body : null;
}

function hasRequiredSections(markdown: string, headings: string[]): boolean {
  return headings.every(
    (heading) => getSectionContent(markdown, heading) !== null,
  );
}

function getPlansDirCandidates(cwd: string): string[] {
  return [join(cwd, ".omc", "plans"), join(cwd, ".omx", "plans")];
}

function sortArtifactPathsDescending(paths: string[]): string[] {
  return [...paths].sort((a, b) => comparePlanningArtifactPaths(b, a));
}

function hasCompletePlanningPair(
  prdPath: string,
  matchingTestSpecPaths: string[],
): boolean {
  if (matchingTestSpecPaths.length === 0) {
    return false;
  }

  const prd = readFileSafe(prdPath);
  const testSpec = readFileSafe(matchingTestSpecPaths[0]);
  if (!prd || !testSpec) {
    return false;
  }

  return (
    hasRequiredSections(prd, [
      "Acceptance criteria",
      "Requirement coverage map",
    ]) &&
    hasRequiredSections(testSpec, [
      "Unit coverage",
      "Verification mapping",
    ])
  );
}

/**
 * Read planning artifacts from .omc/.omx plans directories.
 * Returns paths to all PRD and test-spec files found.
 */
export function readPlanningArtifacts(cwd: string): PlanningArtifacts {
  let entries: string[];
  const prdPaths: string[] = [];
  const testSpecPaths: string[] = [];

  for (const plansDir of getPlansDirCandidates(cwd)) {
    if (!existsSync(plansDir)) {
      continue;
    }

    try {
      entries = readdirSync(plansDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.startsWith("prd-") && entry.endsWith(".md")) {
        prdPaths.push(join(plansDir, entry));
      } else if (entry.startsWith("test-spec-") && entry.endsWith(".md")) {
        testSpecPaths.push(join(plansDir, entry));
      }
    }
  }

  return {
    prdPaths: sortArtifactPathsDescending(prdPaths),
    testSpecPaths: sortArtifactPathsDescending(testSpecPaths),
  };
}

/**
 * Returns true when the latest PRD and latest test spec contain
 * the required non-empty quality-gate sections.
 */
export function isPlanningComplete(artifacts: PlanningArtifacts): boolean {
  const latestPrdPath = selectLatestPlanningArtifactPath(artifacts.prdPaths);
  const matchingTestSpecPaths = selectMatchingTestSpecsForPrd(
    latestPrdPath,
    artifacts.testSpecPaths,
  );

  if (!latestPrdPath || matchingTestSpecPaths.length === 0) {
    return false;
  }

  return hasCompletePlanningPair(latestPrdPath, matchingTestSpecPaths);
}

type LaunchHintSelection =
  | { status: "no-match" }
  | { status: "ambiguous" }
  | {
      status: "unique";
      command: string;
      task: string;
      workerCount?: number;
      agentType?: string;
      linkedRalph: boolean;
    };

function decodeQuotedValue(raw: string): string | null {
  const normalized = raw.trim();
  if (!normalized) return null;
  try {
    return JSON.parse(normalized) as string;
  } catch {
    if (
      (normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'"))
    ) {
      return normalized.slice(1, -1);
    }
    return null;
  }
}

function launchHintPattern(mode: "team" | "ralph"): RegExp {
  return mode === "team"
    ? /(?<command>(?:om[cx]\s+team|\$team)(?:\s+ralph)?(?:\s+(?<count>\d+)(?::(?<role>[a-z][a-z0-9-]*))?)?\s+(?<task>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')(?<flags>(?:\s+--[\w-]+)*))/gi
    : /(?<command>(?:om[cx]\s+ralph|\$ralph)\s+(?<task>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')(?<flags>(?:\s+--[\w-]+)*))/gi;
}

function collectLaunchHintMatches(
  content: string,
  mode: "team" | "ralph",
): RegExpMatchArray[] {
  return [...content.matchAll(launchHintPattern(mode))];
}

function selectLaunchHintMatch(
  matches: RegExpMatchArray[],
  normalizedTask?: string,
  normalizedCommand?: string,
): LaunchHintSelection {
  const decodedMatches = matches.flatMap((match) => {
    const command = match[0]?.trim();
    const task = match.groups?.task ? decodeQuotedValue(match.groups.task) : null;
    if (!command || task == null) return [];
    const flags = match.groups?.flags ?? "";
    const workerCount = match.groups?.count
      ? Number.parseInt(match.groups.count, 10)
      : undefined;

    return [{
      command,
      task,
      ...(workerCount == null ? {} : { workerCount }),
      agentType: match.groups?.role || undefined,
      linkedRalph: /\sralph(?:\s|$)/.test(command) || parseFlags(flags).linkedRalph,
    }];
  });

  const matchesToConsider = normalizedCommand
    ? decodedMatches.filter((match) => match.command === normalizedCommand)
    : normalizedTask
      ? decodedMatches.filter((match) => match.task.trim() === normalizedTask)
      : decodedMatches;

  if (matchesToConsider.length === 0) return { status: "no-match" };
  if (matchesToConsider.length > 1) return { status: "ambiguous" };
  return { status: "unique", ...matchesToConsider[0]! };
}

function parseFlags(flagStr: string): { linkedRalph: boolean } {
  return {
    linkedRalph: /--linked-ralph/.test(flagStr),
  };
}

/**
 * Read the latest PRD file and extract an embedded launch hint for the given mode.
 * Returns null when no hint is found.
 */
export function readApprovedExecutionLaunchHint(
  cwd: string,
  mode: "team" | "ralph",
  options: ApprovedExecutionLaunchHintReadOptions = {},
): ApprovedExecutionLaunchHint | null {
  const outcome = readApprovedExecutionLaunchHintOutcome(cwd, mode, options);
  return outcome.status === "resolved" ? outcome.hint : null;
}

export function readApprovedExecutionLaunchHintOutcome(
  cwd: string,
  mode: "team" | "ralph",
  options: ApprovedExecutionLaunchHintReadOptions = {},
): ApprovedExecutionLaunchHintOutcome {
  const artifacts = readPlanningArtifacts(cwd);
  if (artifacts.prdPaths.length === 0) return { status: "absent" };

  const prdPath = options.prdPath
    ? artifacts.prdPaths.includes(options.prdPath)
      ? options.prdPath
      : null
    : selectLatestPlanningArtifactPath(artifacts.prdPaths);
  const matchingTestSpecs = selectMatchingTestSpecsForPrd(
    prdPath,
    artifacts.testSpecPaths,
  );
  if (!prdPath) return { status: "absent" };
  if (artifacts.testSpecPaths.length > 0 && matchingTestSpecs.length === 0) {
    return { status: "absent" };
  }
  const content = readFileSafe(prdPath);
  if (!content) return { status: "absent" };

  const selected = selectLaunchHintMatch(
    collectLaunchHintMatches(content, mode),
    options.task?.trim(),
    options.command?.trim(),
  );
  if (selected.status === "ambiguous") return { status: "ambiguous" };
  if (selected.status !== "unique") return { status: "absent" };
  if (
    options.requirePlanningComplete &&
    !hasCompletePlanningPair(prdPath, matchingTestSpecs)
  ) {
    return { status: "incomplete" };
  }

  if (mode === "team") {
    return {
      status: "resolved",
      hint: {
        mode: "team",
        command: selected.command,
        task: selected.task,
        workerCount: selected.workerCount,
        agentType: selected.agentType,
        linkedRalph: selected.linkedRalph,
        sourcePath: prdPath,
      },
    };
  }

  return {
    status: "resolved",
    hint: {
      mode: "ralph",
      command: selected.command,
      task: selected.task,
      linkedRalph: selected.linkedRalph,
      sourcePath: prdPath,
    },
  };
}
