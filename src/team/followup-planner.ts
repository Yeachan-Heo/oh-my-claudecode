// src/team/followup-planner.ts

/**
 * Post-ralplan follow-up planner.
 *
 * Detects short follow-up requests after a ralplan cycle has completed
 * and an approved execution plan exists.  When all conditions are met,
 * the follow-up can bypass the ralplan gate and launch the approved
 * team / ralph execution directly.
 */

import { readPlanningArtifacts, isPlanningComplete, readApprovedExecutionLaunchHint } from '../planning/artifacts.js';
import type { ApprovedExecutionLaunchHint } from '../planning/artifacts.js';

export type FollowupMode = 'team' | 'ralph';

export interface ApprovedExecutionFollowupContext {
  planningComplete?: boolean;
  priorSkill?: string | null;
  /** True only after a user-approved execution launch hint was persisted. */
  approvedExecutionLaunchHint?: boolean;
  /** True only when the ralplan workflow has ended instead of still planning. */
  ralplanTerminal?: boolean;
}

export interface TeamFollowupContext {
  hint: ApprovedExecutionLaunchHint;
  launchCommand: string;
}

/**
 * Short team follow-up patterns.
 * Matches: "team", "team please", "team으로 해줘", "/team", "run team", etc.
 */
const SHORT_TEAM_PATTERNS: RegExp[] = [
  /^\s*\/?\s*team\s*$/i,
  /^\s*team\s+please\s*$/i,
  /^\s*run\s+team\s*$/i,
  /^\s*start\s+team\s*$/i,
  /^\s*team으로\s+해줘\s*$/i,
  /^\s*launch\s+team\s*$/i,
  /^\s*go\s+team\s*$/i,
];

/**
 * Short ralph follow-up patterns.
 * Matches: "ralph", "ralph please", "/ralph", "run ralph", etc.
 */
const SHORT_RALPH_PATTERNS: RegExp[] = [
  /^\s*\/?\s*ralph\s*$/i,
  /^\s*ralph\s+please\s*$/i,
  /^\s*run\s+ralph\s*$/i,
  /^\s*start\s+ralph\s*$/i,
  /^\s*launch\s+ralph\s*$/i,
  /^\s*go\s+ralph\s*$/i,
];

/**
 * Returns true if the text is a short team follow-up request.
 */
export function isShortTeamFollowupRequest(text: string): boolean {
  return SHORT_TEAM_PATTERNS.some(re => re.test(text));
}

/**
 * Returns true if the text is a short ralph follow-up request.
 */
export function isShortRalphFollowupRequest(text: string): boolean {
  return SHORT_RALPH_PATTERNS.some(re => re.test(text));
}

/**
 * Returns true when ALL of the following conditions hold:
 * 1. Planning is complete (planningComplete === true)
 * 2. The prior skill was 'ralplan'
 * 3. The ralplan workflow is terminal (not still in planning after compact)
 * 4. An approved execution launch hint exists for the selected mode
 * 5. The text matches a short follow-up for the given mode
 */
export function isApprovedExecutionFollowupShortcut(
  mode: FollowupMode,
  text: string,
  context: ApprovedExecutionFollowupContext
): boolean {
  if (!context.planningComplete) return false;
  if (context.priorSkill !== 'ralplan') return false;
  if (!context.ralplanTerminal) return false;
  if (!context.approvedExecutionLaunchHint) return false;

  if (mode === 'team') return isShortTeamFollowupRequest(text);
  if (mode === 'ralph') return isShortRalphFollowupRequest(text);

  return false;
}

/**
 * Resolve the full follow-up context for a short team follow-up.
 * Reads the approved plan and extracts the launch configuration.
 * Returns null when no approved plan is available.
 */
export function resolveApprovedTeamFollowupContext(
  cwd: string,
  _task: string
): TeamFollowupContext | null {
  const artifacts = readPlanningArtifacts(cwd);
  if (!isPlanningComplete(artifacts)) return null;

  const hint = readApprovedExecutionLaunchHint(cwd, 'team');
  if (!hint) return null;

  return {
    hint,
    launchCommand: hint.command,
  };
}
