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
 * Fix for: https://github.com/Yeachan-Heo/oh-my-claudecode/issues/1033
 */

import { writeModeState, readModeState, clearModeStateFile } from '../../lib/mode-state-io.js';
import { getActiveAgentCount } from '../subagent-tracker/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Protection configuration per level
// ---------------------------------------------------------------------------

const PROTECTION_CONFIGS: Record<SkillProtectionLevel, SkillStateConfig> = {
  none: { maxReinforcements: 0, staleTtlMs: 0 },
  light: { maxReinforcements: 3, staleTtlMs: 5 * 60 * 1000 },      // 5 min
  medium: { maxReinforcements: 5, staleTtlMs: 15 * 60 * 1000 },     // 15 min
  heavy: { maxReinforcements: 10, staleTtlMs: 30 * 60 * 1000 },     // 30 min
};

// ---------------------------------------------------------------------------
// Skill → protection level mapping
// ---------------------------------------------------------------------------

/**
 * Maps each skill name to its protection level.
 *
 * - 'none': Already has dedicated mode state (ralph, autopilot, etc.) or is
 *   instant/read-only (trace, hud, omc-help, etc.)
 * - 'light': Quick utility skills
 * - 'medium': Review/planning skills that run multiple agents
 * - 'heavy': Long-running skills (deepinit, omc-setup)
 *
 * IMPORTANT: When adding a new OMC skill, register it here with the
 * appropriate protection level. Unregistered skills default to 'none'
 * (no stop-hook protection) to avoid blocking external plugin skills.
 */
const SKILL_PROTECTION: Record<string, SkillProtectionLevel> = {
  // === Already have mode state → no additional protection ===
  autopilot: 'none',
  ralph: 'none',
  ultrawork: 'none',
  team: 'none',
  'omc-teams': 'none',
  ultraqa: 'none',
  cancel: 'none',

  // === Instant / read-only → no protection needed ===
  trace: 'none',
  hud: 'none',
  'omc-doctor': 'none',
  'omc-help': 'none',
  'learn-about-omc': 'none',
  note: 'none',

  // === Light protection (simple shortcuts, 3 reinforcements) ===
  skill: 'light',
  ask: 'light',
  'configure-notifications': 'light',

  // === Medium protection (review/planning, 5 reinforcements) ===
  'omc-plan': 'medium',
  plan: 'medium',
  ralplan: 'none',  // Has first-class checkRalplan() enforcement; no skill-active needed
  'deep-interview': 'heavy',
  review: 'medium',
  'external-context': 'medium',
  'ai-slop-cleaner': 'medium',
  sciomc: 'medium',
  learner: 'medium',
  'omc-setup': 'medium',
  setup: 'medium',        // alias for omc-setup
  'mcp-setup': 'medium',
  'project-session-manager': 'medium',
  psm: 'medium',          // alias for project-session-manager
  'writer-memory': 'medium',
  'ralph-init': 'medium',
  release: 'medium',
  ccg: 'medium',

  // === Heavy protection (long-running, 10 reinforcements) ===
  deepinit: 'heavy',
  'self-improve': 'heavy',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the protection level for a skill.
 *
 * Only skills explicitly registered in SKILL_PROTECTION receive stop-hook
 * protection. Unregistered skills (including external plugin skills like
 * Anthropic's example-skills, document-skills, superpowers, data, etc.)
 * default to 'none' so the Stop hook does not block them.
 *
 * @param skillName - The normalized (prefix-stripped) skill name.
 * @param rawSkillName - The original skill name as invoked (e.g., 'oh-my-claudecode:plan'
 *   or 'plan'). When provided, only skills invoked with the 'oh-my-claudecode:' prefix
 *   are eligible for protection. This prevents project custom skills (e.g., a user's
 *   `.claude/skills/plan/`) from being confused with OMC built-in skills of the same name.
 *   See: https://github.com/Yeachan-Heo/oh-my-claudecode/issues/1581
 */
export function getSkillProtection(skillName: string, rawSkillName?: string): SkillProtectionLevel {
  // When rawSkillName is provided, only apply protection to OMC-prefixed skills.
  // Non-prefixed skills are project custom skills or other plugins — no protection.
  if (rawSkillName != null && !rawSkillName.toLowerCase().startsWith('oh-my-claudecode:')) {
    return 'none';
  }
  const normalized = skillName.toLowerCase().replace(/^oh-my-claudecode:/, '');
  return SKILL_PROTECTION[normalized] ?? 'none';
}

/**
 * Get the protection config for a skill.
 */
export function getSkillConfig(skillName: string, rawSkillName?: string): SkillStateConfig {
  return PROTECTION_CONFIGS[getSkillProtection(skillName, rawSkillName)];
}

/**
 * Read the current skill active state.
 * Returns null if no state exists or state is invalid.
 */
export function readSkillActiveState(
  directory: string,
  sessionId?: string
): SkillActiveState | null {
  const state = readModeState<SkillActiveState>('skill-active', directory, sessionId);
  if (!state || typeof state.active !== 'boolean') {
    return null;
  }
  return state;
}

/**
 * Write skill active state.
 * Called when a skill is invoked via the Skill tool.
 *
 * @param rawSkillName - The original skill name as invoked, used to distinguish
 *   OMC built-in skills from project custom skills. See getSkillProtection().
 */
export function writeSkillActiveState(
  directory: string,
  skillName: string,
  sessionId?: string,
  rawSkillName?: string,
): SkillActiveState | null {
  const protection = getSkillProtection(skillName, rawSkillName);

  // Skills with 'none' protection don't need state tracking
  if (protection === 'none') {
    return null;
  }

  const config = PROTECTION_CONFIGS[protection];
  const now = new Date().toISOString();
  const normalized = skillName.toLowerCase().replace(/^oh-my-claudecode:/, '');

  // Nesting guard: when a skill (e.g. omc-setup) invokes a child skill
  // (e.g. mcp-setup), the child must not overwrite the parent's active state.
  // If a DIFFERENT skill is already active in this session, skip writing —
  // the parent's stop-hook protection already covers the session.
  // If the SAME skill is re-invoked, allow the overwrite (idempotent refresh).
  //
  // NOTE: This read-check-write sequence has a TOCTOU race condition
  // (non-atomic), but this is acceptable because Claude Code sessions are
  // single-threaded — only one tool call executes at a time within a session.
  const existingState = readSkillActiveState(directory, sessionId);
  if (existingState && existingState.active && existingState.skill_name !== normalized) {
    // A different skill already owns the active state — do not overwrite.
    return null;
  }

  const state: SkillActiveState = {
    active: true,
    skill_name: normalized,
    session_id: sessionId,
    started_at: now,
    last_checked_at: now,
    reinforcement_count: 0,
    max_reinforcements: config.maxReinforcements,
    stale_ttl_ms: config.staleTtlMs,
  };

  const success = writeModeState('skill-active', state as unknown as Record<string, unknown>, directory, sessionId);
  return success ? state : null;
}

/**
 * Clear skill active state.
 * Called when a skill completes or is cancelled.
 */
export function clearSkillActiveState(directory: string, sessionId?: string): boolean {
  return clearModeStateFile('skill-active', directory, sessionId);
}

/**
 * Check if the skill state is stale (exceeded its TTL).
 */
export function isSkillStateStale(state: SkillActiveState): boolean {
  if (!state.active) return true;

  const lastChecked = state.last_checked_at
    ? new Date(state.last_checked_at).getTime()
    : 0;
  const startedAt = state.started_at
    ? new Date(state.started_at).getTime()
    : 0;
  const mostRecent = Math.max(lastChecked, startedAt);

  if (mostRecent === 0) return true;

  const age = Date.now() - mostRecent;
  return age > (state.stale_ttl_ms || 5 * 60 * 1000);
}

/**
 * Check skill active state for the Stop hook.
 * Returns blocking decision with continuation message.
 *
 * Called by checkPersistentModes() in the persistent-mode hook.
 */
export function checkSkillActiveState(
  directory: string,
  sessionId?: string
): { shouldBlock: boolean; message: string; skillName?: string } {
  const state = readSkillActiveState(directory, sessionId);

  if (!state || !state.active) {
    return { shouldBlock: false, message: '' };
  }

  // Session isolation
  if (sessionId && state.session_id && state.session_id !== sessionId) {
    return { shouldBlock: false, message: '' };
  }

  // Staleness check
  if (isSkillStateStale(state)) {
    clearSkillActiveState(directory, sessionId);
    return { shouldBlock: false, message: '' };
  }

  // Reinforcement limit check
  if (state.reinforcement_count >= state.max_reinforcements) {
    clearSkillActiveState(directory, sessionId);
    return { shouldBlock: false, message: '' };
  }

  // Orchestrators are allowed to go idle while delegated work is still active.
  // Do not consume a reinforcement here; the skill is still active and should
  // resume enforcement only after the running subagents finish.
  if (getActiveAgentCount(directory) > 0) {
    return { shouldBlock: false, message: '', skillName: state.skill_name };
  }

  // Block the stop and increment reinforcement count
  state.reinforcement_count += 1;
  state.last_checked_at = new Date().toISOString();

  const written = writeModeState('skill-active', state as unknown as Record<string, unknown>, directory, sessionId);
  if (!written) {
    // If we can't write, don't block
    return { shouldBlock: false, message: '' };
  }

  const message = `[SKILL ACTIVE: ${state.skill_name}] The "${state.skill_name}" skill is still executing (reinforcement ${state.reinforcement_count}/${state.max_reinforcements}). Continue working on the skill's instructions. Do not stop until the skill completes its workflow.`;

  return {
    shouldBlock: true,
    message,
    skillName: state.skill_name,
  };
}
