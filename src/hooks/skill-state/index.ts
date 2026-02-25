/**
 * Skill Active State Management
 *
 * Tracks when a skill is actively executing so the persistent-mode Stop hook
 * can prevent premature session termination.
 *
 * Skills like code-review, plan, tdd, analyze, build-fix, security-review,
 * external-context, deepinit etc. don't write mode state files (ralph-state.json,
 * etc.), so the Stop hook previously had no way to know they were running.
 *
 * This module provides:
 * 1. A protection level registry for all skills (none/light/medium/heavy)
 * 2. Read/write/clear functions for skill-active-state.json
 * 3. A check function for the Stop hook to determine if blocking is needed
 *
 * Fix for: https://github.com/Yeachan-Heo/oh-my-claudecode/issues/1033
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { resolveSessionStatePath } from '../../lib/worktree-paths.js';

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
 * - 'light': Quick agent shortcuts (tdd, build-fix, analyze)
 * - 'medium': Review/planning skills that run multiple agents
 * - 'heavy': Long-running skills (deepinit, omc-setup)
 */
const SKILL_PROTECTION: Record<string, SkillProtectionLevel> = {
  // === Already have mode state → no additional protection ===
  autopilot: 'none',
  ralph: 'none',
  ultrawork: 'none',
  ultrapilot: 'none',
  team: 'none',
  'omc-teams': 'none',
  ultraqa: 'none',
  pipeline: 'none',
  cancel: 'none',

  // === Instant / read-only → no protection needed ===
  trace: 'none',
  hud: 'none',
  'omc-doctor': 'none',
  'omc-help': 'none',
  'learn-about-omc': 'none',
  note: 'none',

  // === Light protection (simple agent shortcuts, 3 reinforcements) ===
  tdd: 'light',
  'build-fix': 'light',
  analyze: 'light',
  skill: 'light',
  'configure-notifications': 'light',

  // === Medium protection (review/planning, 5 reinforcements) ===
  'code-review': 'medium',
  'security-review': 'medium',
  plan: 'medium',
  ralplan: 'medium',
  review: 'medium',
  'external-context': 'medium',
  sciomc: 'medium',
  learner: 'medium',
  'omc-setup': 'medium',
  'mcp-setup': 'medium',
  'project-session-manager': 'medium',
  'writer-memory': 'medium',
  'ralph-init': 'medium',
  ccg: 'medium',

  // === Heavy protection (long-running, 10 reinforcements) ===
  deepinit: 'heavy',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the protection level for a skill.
 * Unknown skills default to 'light' for safety.
 */
export function getSkillProtection(skillName: string): SkillProtectionLevel {
  const normalized = skillName.toLowerCase().replace(/^oh-my-claudecode:/, '');
  return SKILL_PROTECTION[normalized] ?? 'light';
}

/**
 * Get the protection config for a skill.
 */
export function getSkillConfig(skillName: string): SkillStateConfig {
  return PROTECTION_CONFIGS[getSkillProtection(skillName)];
}

/**
 * Resolve the path to skill-active-state.json.
 * Uses session-scoped path when sessionId is provided.
 */
export function getSkillStatePath(directory: string, sessionId?: string): string {
  if (sessionId) {
    return resolveSessionStatePath('skill-active', sessionId, directory);
  }
  return join(directory, '.omc', 'state', 'skill-active-state.json');
}

/**
 * Read the current skill active state.
 * Returns null if no state exists or state is invalid.
 */
export function readSkillActiveState(
  directory: string,
  sessionId?: string
): SkillActiveState | null {
  const statePath = getSkillStatePath(directory, sessionId);

  try {
    if (!existsSync(statePath)) {
      return null;
    }
    const content = readFileSync(statePath, 'utf-8');
    const state = JSON.parse(content) as SkillActiveState;

    if (!state || typeof state.active !== 'boolean') {
      return null;
    }

    return state;
  } catch {
    return null;
  }
}

/**
 * Write skill active state.
 * Called when a skill is invoked via the Skill tool.
 */
export function writeSkillActiveState(
  directory: string,
  skillName: string,
  sessionId?: string
): SkillActiveState | null {
  const protection = getSkillProtection(skillName);

  // Skills with 'none' protection don't need state tracking
  if (protection === 'none') {
    return null;
  }

  const config = PROTECTION_CONFIGS[protection];
  const now = new Date().toISOString();
  const normalized = skillName.toLowerCase().replace(/^oh-my-claudecode:/, '');

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

  const statePath = getSkillStatePath(directory, sessionId);

  try {
    const dir = dirname(statePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    return state;
  } catch {
    return null;
  }
}

/**
 * Clear skill active state.
 * Called when a skill completes or is cancelled.
 */
export function clearSkillActiveState(directory: string, sessionId?: string): boolean {
  const statePath = getSkillStatePath(directory, sessionId);

  try {
    if (existsSync(statePath)) {
      unlinkSync(statePath);
    }
    return true;
  } catch {
    return false;
  }
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

  // Block the stop and increment reinforcement count
  state.reinforcement_count += 1;
  state.last_checked_at = new Date().toISOString();

  const statePath = getSkillStatePath(directory, sessionId);
  try {
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch {
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
