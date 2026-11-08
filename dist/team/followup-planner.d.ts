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
 * Returns true if the text is a short team follow-up request.
 */
export declare function isShortTeamFollowupRequest(text: string): boolean;
/**
 * Returns true if the text is a short ralph follow-up request.
 */
export declare function isShortRalphFollowupRequest(text: string): boolean;
/**
 * Returns true when ALL of the following conditions hold:
 * 1. Planning is complete (planningComplete === true)
 * 2. The prior skill was 'ralplan'
 * 3. The ralplan workflow is terminal (not still in planning after compact)
 * 4. An approved execution launch hint exists for the selected mode
 * 5. The text matches a short follow-up for the given mode
 */
export declare function isApprovedExecutionFollowupShortcut(mode: FollowupMode, text: string, context: ApprovedExecutionFollowupContext): boolean;
/**
 * Resolve the full follow-up context for a short team follow-up.
 * Reads the approved plan and extracts the launch configuration.
 * Returns null when no approved plan is available.
 */
export declare function resolveApprovedTeamFollowupContext(cwd: string, _task: string): TeamFollowupContext | null;
//# sourceMappingURL=followup-planner.d.ts.map