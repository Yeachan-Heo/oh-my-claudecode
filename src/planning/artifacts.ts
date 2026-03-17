// src/planning/artifacts.ts

/**
 * Planning artifacts reader.
 *
 * Reads .omc/plans/ directory for PRD and test-spec files,
 * and extracts approved execution launch hints embedded in PRD markdown.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface PlanningArtifacts {
  prdPaths: string[];
  testSpecPaths: string[];
}

export interface ApprovedExecutionLaunchHint {
  mode: 'team' | 'ralph';
  command: string;
  task: string;
  workerCount?: number;
  agentType?: string;
  linkedRalph?: boolean;
  sourcePath: string;
}

/**
 * Read planning artifacts from .omc/plans/ directory.
 * Returns paths to all PRD and test-spec files found.
 */
export function readPlanningArtifacts(cwd: string): PlanningArtifacts {
  const plansDir = join(cwd, '.omc', 'plans');
  if (!existsSync(plansDir)) {
    return { prdPaths: [], testSpecPaths: [] };
  }

  let entries: string[];
  try {
    entries = readdirSync(plansDir);
  } catch {
    return { prdPaths: [], testSpecPaths: [] };
  }

  const prdPaths: string[] = [];
  const testSpecPaths: string[] = [];

  for (const entry of entries) {
    if (entry.startsWith('prd-') && entry.endsWith('.md')) {
      prdPaths.push(join(plansDir, entry));
    } else if (entry.startsWith('test-spec-') && entry.endsWith('.md')) {
      testSpecPaths.push(join(plansDir, entry));
    }
  }

  // Sort descending so newest (lexicographically last) is first
  prdPaths.sort((a, b) => b.localeCompare(a));
  testSpecPaths.sort((a, b) => b.localeCompare(a));

  return { prdPaths, testSpecPaths };
}

/**
 * Returns true when both a PRD and a test spec are present.
 */
export function isPlanningComplete(artifacts: PlanningArtifacts): boolean {
  return artifacts.prdPaths.length > 0 && artifacts.testSpecPaths.length > 0;
}

/**
 * Regex patterns for extracting omc team/ralph launch commands from PRD markdown.
 *
 * Matches lines like:
 *   omc team 3:claude "implement the feature"
 *   omc team 2:codex "fix the bug" --linked-ralph
 *   omc ralph "do the work"
 */
const TEAM_LAUNCH_RE =
  /\bomc\s+team\s+(?:(\d+):(\w+)\s+)?"([^"]+)"((?:\s+--[\w-]+)*)/;
const RALPH_LAUNCH_RE =
  /\bomc\s+ralph\s+"([^"]+)"((?:\s+--[\w-]+)*)/;

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
  mode: 'team' | 'ralph'
): ApprovedExecutionLaunchHint | null {
  const artifacts = readPlanningArtifacts(cwd);
  if (artifacts.prdPaths.length === 0) return null;

  // Use the latest PRD (sorted descending, so index 0 is newest)
  const prdPath = artifacts.prdPaths[0];
  let content: string;
  try {
    content = readFileSync(prdPath, 'utf-8');
  } catch {
    return null;
  }

  if (mode === 'team') {
    const match = TEAM_LAUNCH_RE.exec(content);
    if (!match) return null;

    const [fullMatch, workerCountStr, agentType, task, flagStr] = match;
    const { linkedRalph } = parseFlags(flagStr ?? '');

    return {
      mode: 'team',
      command: fullMatch.trim(),
      task,
      workerCount: workerCountStr ? parseInt(workerCountStr, 10) : undefined,
      agentType: agentType || undefined,
      linkedRalph,
      sourcePath: prdPath,
    };
  }

  if (mode === 'ralph') {
    const match = RALPH_LAUNCH_RE.exec(content);
    if (!match) return null;

    const [fullMatch, task, flagStr] = match;
    const { linkedRalph } = parseFlags(flagStr ?? '');

    return {
      mode: 'ralph',
      command: fullMatch.trim(),
      task,
      linkedRalph,
      sourcePath: prdPath,
    };
  }

  return null;
}
