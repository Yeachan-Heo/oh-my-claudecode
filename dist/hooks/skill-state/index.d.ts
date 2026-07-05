/**
 * Skill Active State Management
 *
 * Tracks when a skill is actively executing so the persistent-mode Stop hook
 * can prevent premature session termination.
 *
 * Skills like plan, external-context, deepinit etc. don't write mode state
 * files (ralph-state.json, etc.), so the Stop hook previously had no way to
 * know they were running.
 *
 * This module provides:
 * 1. A protection level registry for all skills (none/light/medium/heavy)
 * 2. Read/write/clear functions for skill-active-state.json
 * 3. A check function for the Stop hook to determine if blocking is needed
 *
 * Fix for: https://github.com/Yeachan-Heo/lazycc/issues/1033
 */
export type SkillProtectionLevel = 'none' | 'light' | 'medium' | 'heavy';
export interface SkillStateConfig {
    /** Max stop-hook reinforcements before allowing stop */
    maxReinforcements: number;
    /** Time-to-live in ms before state is considered stale */
    staleTtlMs: number;
}
export interface SkillActiveState {
    active: boolean;
    skill_name: string;
    session_id?: string;
    started_at: string;
    last_checked_at: string;
    reinforcement_count: number;
    max_reinforcements: number;
    stale_ttl_ms: number;
}
/**
 * Get the protection level for a skill.
 *
 * Only skills explicitly registered in SKILL_PROTECTION receive stop-hook
 * protection. Unregistered skills (including external plugin skills like
 * Anthropic's example-skills, document-skills, superpowers, data, etc.)
 * default to 'none' so the Stop hook does not block them.
 *
 * @param skillName - The normalized (prefix-stripped) skill name.
 * @param rawSkillName - The original skill name as invoked (e.g., 'lazycc:plan'
 *   or 'plan'). When provided, only skills invoked with the 'lazycc:' prefix
 *   are eligible for protection. This prevents project custom skills (e.g., a user's
 *   `.claude/skills/plan/`) from being confused with OMC built-in skills of the same name.
 *   See: https://github.com/Yeachan-Heo/lazycc/issues/1581
 */
export declare function getSkillProtection(skillName: string, rawSkillName?: string): SkillProtectionLevel;
/**
 * Get the protection config for a skill.
 */
export declare function getSkillConfig(skillName: string, rawSkillName?: string): SkillStateConfig;
/**
 * Read the current skill active state.
 * Returns null if no state exists or state is invalid.
 */
export declare function readSkillActiveState(directory: string, sessionId?: string): SkillActiveState | null;
/**
 * Write skill active state.
 * Called when a skill is invoked via the Skill tool.
 *
 * @param rawSkillName - The original skill name as invoked, used to distinguish
 *   OMC built-in skills from project custom skills. See getSkillProtection().
 */
export declare function writeSkillActiveState(directory: string, skillName: string, sessionId?: string, rawSkillName?: string): SkillActiveState | null;
/**
 * Clear skill active state.
 * Called when a skill completes or is cancelled.
 */
export declare function clearSkillActiveState(directory: string, sessionId?: string): boolean;
/**
 * Check if the skill state is stale (exceeded its TTL).
 */
export declare function isSkillStateStale(state: SkillActiveState): boolean;
/**
 * Check skill active state for the Stop hook.
 * Returns blocking decision with continuation message.
 *
 * Called by checkPersistentModes() in the persistent-mode hook.
 */
export declare function checkSkillActiveState(directory: string, sessionId?: string): {
    shouldBlock: boolean;
    message: string;
    skillName?: string;
};
//# sourceMappingURL=index.d.ts.map