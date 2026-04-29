/**
 * Skill Active State Management (v2 mixed schema)
 *
 * `skill-active-state.json` is a dual-copy workflow ledger:
 *
 *   {
 *     "version": 2,
 *     "active_skills": {                    // workflow-slot ledger
 *       "<canonical workflow skill>": {
 *         "skill_name": ...,
 *         "started_at": ...,
 *         "completed_at": ...,              // soft tombstone
 *         "parent_skill": ...,              // lineage for nested runs
 *         "session_id": ...,
 *         "mode_state_path": ...,
 *         "initialized_mode": ...,
 *         "initialized_state_path": ...,
 *         "initialized_session_state_path": ...
 *       }
 *     },
 *     "support_skill": {                    // legacy-compatible branch
 *       "active": true, "skill_name": "plan", ...
 *     }
 *   }
 *
 * HARD INVARIANTS:
 *   1. `writeSkillActiveStateCopies()` is the only helper allowed to persist
 *      workflow-slot state. Every workflow-slot write, confirm, tombstone, TTL
 *      pruning, and hard-clear must update BOTH
 *        - `.omc/state/skill-active-state.json`
 *        - `.omc/state/sessions/{sessionId}/skill-active-state.json`
 *      together through this single helper.
 *   2. Support-skill writes go through the same helper so the shared file
 *      never drops the `active_skills` branch.
 *   3. The session copy is authoritative for session-local reads; the root
 *      copy is authoritative for cross-session aggregation.
 */
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { resolveStatePath, resolveSessionStatePath, } from '../../lib/worktree-paths.js';
import { atomicWriteJsonSync } from '../../lib/atomic-write.js';
import { readTrackingState, getStaleAgents } from '../subagent-tracker/index.js';
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const SKILL_ACTIVE_STATE_MODE = 'skill-active';
export const SKILL_ACTIVE_STATE_FILE = 'skill-active-state.json';
export const WORKFLOW_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
/**
 * Canonical workflow skills — the only skills that get workflow slots.
 * Non-workflow skills keep today's `light/medium/heavy` protection via the
 * `support_skill` branch.
 */
export const CANONICAL_WORKFLOW_SKILLS = [
    'autopilot',
    'ralph',
    'team',
    'ultrawork',
    'ultraqa',
    'deep-interview',
    'ralplan',
    'self-improve',
];
export function isCanonicalWorkflowSkill(skillName) {
    const normalized = skillName.toLowerCase().replace(/^oh-my-claudecode:/, '');
    return CANONICAL_WORKFLOW_SKILLS.includes(normalized);
}
const PROTECTION_CONFIGS = {
    none: { maxReinforcements: 0, staleTtlMs: 0 },
    light: { maxReinforcements: 3, staleTtlMs: 5 * 60 * 1000 }, // 5 min
    medium: { maxReinforcements: 5, staleTtlMs: 15 * 60 * 1000 }, // 15 min
    heavy: { maxReinforcements: 10, staleTtlMs: 30 * 60 * 1000 }, // 30 min
};
/**
 * Maps each skill name to its support-skill protection level.
 *
 * Workflow skills (autopilot, ralph, ultrawork, team, ultraqa, ralplan,
 * deep-interview, self-improve) have dedicated mode state and workflow slots,
 * so their support-skill protection is 'none'. They flow through the
 * `active_skills` branch instead.
 */
const SKILL_PROTECTION = {
    // === Canonical workflow skills — bypass support-skill protection; flow through the workflow-slot path ===
    autopilot: 'none',
    autoresearch: 'none',
    ralph: 'none',
    ultrawork: 'none',
    team: 'none',
    'omc-teams': 'none',
    ultraqa: 'none',
    ralplan: 'none',
    'self-improve': 'none',
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
    'deep-interview': 'heavy',
    review: 'medium',
    'external-context': 'medium',
    'ai-slop-cleaner': 'medium',
    sciomc: 'medium',
    skillify: 'medium',
    learner: 'medium',
    'omc-setup': 'medium',
    setup: 'medium',
    'mcp-setup': 'medium',
    'project-session-manager': 'medium',
    psm: 'medium',
    'writer-memory': 'medium',
    'ralph-init': 'medium',
    release: 'medium',
    ccg: 'medium',
    // === Heavy protection (long-running, 10 reinforcements) ===
    deepinit: 'heavy',
};
export function getSkillProtection(skillName, rawSkillName) {
    if (rawSkillName != null && !rawSkillName.toLowerCase().startsWith('oh-my-claudecode:')) {
        return 'none';
    }
    const normalized = skillName.toLowerCase().replace(/^oh-my-claudecode:/, '');
    return SKILL_PROTECTION[normalized] ?? 'none';
}
export function getSkillConfig(skillName, rawSkillName) {
    return PROTECTION_CONFIGS[getSkillProtection(skillName, rawSkillName)];
}
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
export function emptySkillActiveStateV2() {
    return { version: 2, active_skills: {} };
}
function isEmptyV2(state) {
    return Object.keys(state.active_skills).length === 0 && !state.support_skill;
}
function readRawFromPath(path) {
    if (!existsSync(path))
        return null;
    try {
        return JSON.parse(readFileSync(path, 'utf-8'));
    }
    catch {
        return null;
    }
}
/**
 * Normalize any raw payload (v1 scalar, v2 mixed, or unknown) into v2. Legacy
 * scalar state is folded into `support_skill` so support-skill data is never
 * dropped during migration.
 */
function normalizeToV2(raw) {
    if (!raw || typeof raw !== 'object') {
        return emptySkillActiveStateV2();
    }
    const obj = raw;
    // Strip `_meta` envelope if present (added by atomic writes).
    const { _meta: _meta, ...rest } = obj;
    void _meta;
    const state = rest;
    const looksV2 = state.version === 2 || 'active_skills' in state || 'support_skill' in state;
    if (looksV2) {
        const active_skills = {};
        const raw_slots = state.active_skills;
        if (raw_slots && typeof raw_slots === 'object' && !Array.isArray(raw_slots)) {
            for (const [name, slot] of Object.entries(raw_slots)) {
                if (slot && typeof slot === 'object') {
                    active_skills[name] = slot;
                }
            }
        }
        const support_skill = state.support_skill && typeof state.support_skill === 'object'
            ? state.support_skill
            : null;
        return { version: 2, active_skills, support_skill };
    }
    // Legacy scalar shape → fold into support_skill.
    if (typeof state.active === 'boolean' && typeof state.skill_name === 'string') {
        return {
            version: 2,
            active_skills: {},
            support_skill: state,
        };
    }
    return emptySkillActiveStateV2();
}
// ---------------------------------------------------------------------------
// Pure workflow-slot helpers
// ---------------------------------------------------------------------------
/** Upsert (create or update) a workflow slot on a v2 state. Pure. */
export function upsertWorkflowSkillSlot(state, skillName, slotData = {}) {
    const normalized = skillName.toLowerCase().replace(/^oh-my-claudecode:/, '');
    const existing = state.active_skills[normalized];
    const now = new Date().toISOString();
    const base = {
        skill_name: normalized,
        started_at: existing?.started_at ?? now,
        completed_at: existing?.completed_at ?? null,
        parent_skill: existing?.parent_skill ?? null,
        session_id: existing?.session_id ?? '',
        mode_state_path: existing?.mode_state_path ?? '',
        initialized_mode: existing?.initialized_mode ?? normalized,
        initialized_state_path: existing?.initialized_state_path ?? '',
        initialized_session_state_path: existing?.initialized_session_state_path ?? '',
    };
    if (existing?.last_confirmed_at !== undefined) {
        base.last_confirmed_at = existing.last_confirmed_at;
    }
    if (existing?.source !== undefined) {
        base.source = existing.source;
    }
    const next = {
        ...base,
        ...slotData,
        skill_name: normalized,
    };
    return {
        ...state,
        active_skills: { ...state.active_skills, [normalized]: next },
    };
}
/**
 * Soft tombstone: set `completed_at` on an existing slot. Slot is retained
 * until the TTL pruner removes it. Returns state unchanged when the slot is
 * absent (idempotent).
 */
export function markWorkflowSkillCompleted(state, skillName, now = new Date().toISOString()) {
    const normalized = skillName.toLowerCase().replace(/^oh-my-claudecode:/, '');
    const existing = state.active_skills[normalized];
    if (!existing)
        return state;
    const updated = { ...existing, completed_at: now };
    return {
        ...state,
        active_skills: { ...state.active_skills, [normalized]: updated },
    };
}
/** Hard-clear: remove a slot entirely (for explicit cancel). Pure. */
export function clearWorkflowSkillSlot(state, skillName) {
    const normalized = skillName.toLowerCase().replace(/^oh-my-claudecode:/, '');
    if (!(normalized in state.active_skills))
        return state;
    const next = { ...state.active_skills };
    delete next[normalized];
    return { ...state, active_skills: next };
}
/**
 * TTL prune: remove tombstoned slots whose `completed_at + ttlMs < now`.
 * Called on UserPromptSubmit. Pure.
 */
export function pruneExpiredWorkflowSkillTombstones(state, ttlMs = WORKFLOW_TOMBSTONE_TTL_MS, now = Date.now()) {
    const next = {};
    let changed = false;
    for (const [name, slot] of Object.entries(state.active_skills)) {
        if (!slot.completed_at) {
            next[name] = slot;
            continue;
        }
        const tombstonedAt = new Date(slot.completed_at).getTime();
        if (!Number.isFinite(tombstonedAt)) {
            // Malformed timestamp — keep defensively rather than silently drop.
            next[name] = slot;
            continue;
        }
        if (now - tombstonedAt < ttlMs) {
            next[name] = slot;
        }
        else {
            changed = true;
        }
    }
    return changed ? { ...state, active_skills: next } : state;
}
/**
 * Resolve the authoritative workflow slot for stop-hook and downstream
 * consumers.
 *
 * Rule: among live (non-tombstoned) slots, prefer those whose parent lineage
 * is absent or itself tombstoned (roots of the live chain). Among those,
 * return the newest by `started_at`. In nested `autopilot → ralph` flows this
 * returns `autopilot` while ralph is still live beneath it, so stop-hook
 * enforcement keeps reinforcing the outer loop.
 */
export function resolveAuthoritativeWorkflowSkill(state) {
    const live = Object.values(state.active_skills).filter((s) => !s.completed_at);
    if (live.length === 0)
        return null;
    const isLiveAncestor = (name) => {
        if (!name)
            return false;
        const parent = state.active_skills[name];
        return !!parent && !parent.completed_at;
    };
    const roots = live.filter((s) => !isLiveAncestor(s.parent_skill ?? null));
    const pool = roots.length > 0 ? roots : live;
    pool.sort((a, b) => {
        const bt = new Date(b.started_at).getTime() || 0;
        const at = new Date(a.started_at).getTime() || 0;
        return bt - at;
    });
    return pool[0] ?? null;
}
/**
 * Pure query: is the workflow slot for `skillName` live (non-tombstoned)?
 * Returns false when no slot exists at all, so callers can distinguish
 * "no ledger entry" from "tombstoned" via `isWorkflowSkillTombstoned`.
 */
export function isWorkflowSkillLive(state, skillName) {
    const normalized = skillName.toLowerCase().replace(/^oh-my-claudecode:/, '');
    const slot = state.active_skills[normalized];
    return !!slot && !slot.completed_at;
}
/**
 * Pure query: is the slot tombstoned (has `completed_at`) and not yet expired?
 * Used by stop enforcement to suppress noisy re-handoff on completed workflows
 * until TTL pruning removes the slot or a fresh invocation reactivates it.
 */
export function isWorkflowSkillTombstoned(state, skillName, ttlMs = WORKFLOW_TOMBSTONE_TTL_MS, now = Date.now()) {
    const normalized = skillName.toLowerCase().replace(/^oh-my-claudecode:/, '');
    const slot = state.active_skills[normalized];
    if (!slot || !slot.completed_at)
        return false;
    const tombstonedAt = new Date(slot.completed_at).getTime();
    if (!Number.isFinite(tombstonedAt))
        return true;
    return now - tombstonedAt < ttlMs;
}
// ---------------------------------------------------------------------------
// Read / Write I/O
// ---------------------------------------------------------------------------
/**
 * Read the v2 mixed-schema workflow ledger, normalizing legacy scalar state
 * into `support_skill` without dropping support-skill data.
 *
 * When `sessionId` is provided, the session copy is authoritative for
 * session-local reads. No fall-through to the root copy, to prevent
 * cross-session leakage. When no session copy exists for the session, the
 * ledger is treated as empty for that session's local reads.
 *
 * When `sessionId` is omitted (legacy/global path), the root copy is read.
 *
 * Logs a reconciliation warning when the session copy diverges from the root
 * for slots belonging to the same session. The next mutation through
 * `writeSkillActiveStateCopies()` re-synchronizes both copies.
 */
export function readSkillActiveStateNormalized(directory, sessionId) {
    const rootPath = resolveStatePath('skill-active', directory);
    const sessionPath = sessionId
        ? resolveSessionStatePath('skill-active', sessionId, directory)
        : null;
    const sessionExists = !!(sessionPath && existsSync(sessionPath));
    const rootExists = existsSync(rootPath);
    const sessionV2 = sessionExists ? normalizeToV2(readRawFromPath(sessionPath)) : null;
    const rootV2 = rootExists ? normalizeToV2(readRawFromPath(rootPath)) : null;
    // Divergence detection — best-effort; logged but non-fatal.
    if (sessionV2 && rootV2 && sessionId) {
        for (const [name, sessSlot] of Object.entries(sessionV2.active_skills)) {
            const rootSlot = rootV2.active_skills[name];
            if (!rootSlot)
                continue;
            if (sessSlot.session_id !== sessionId)
                continue;
            if (JSON.stringify(sessSlot) !== JSON.stringify(rootSlot)) {
                // Non-fatal — next writeSkillActiveStateCopies() call will re-sync.
                console.warn(`[skill-active] copy drift detected for slot "${name}" in session ${sessionId}; ` +
                    'next mutation will reconcile via writeSkillActiveStateCopies().');
                break;
            }
        }
    }
    // Session copy authoritative for session-local reads.
    if (sessionV2)
        return sessionV2;
    // sessionId provided but no session copy — do NOT fall back to root to
    // prevent cross-session state leakage (#456).
    if (sessionId)
        return emptySkillActiveStateV2();
    // Legacy/global path: read root.
    return rootV2 ?? emptySkillActiveStateV2();
}
/**
 * THE ONLY HELPER allowed to persist workflow-slot state.
 *
 * Writes BOTH root `.omc/state/skill-active-state.json` AND session
 * `.omc/state/sessions/{sessionId}/skill-active-state.json` together. When a
 * resolved state is empty (no slots, no support_skill), the corresponding
 * file is removed instead — the absence of a file is the canonical empty
 * state.
 *
 * @returns true when all writes / deletes succeeded, false otherwise.
 */
export function writeSkillActiveStateCopies(directory, nextState, sessionId, options) {
    const rootPath = resolveStatePath('skill-active', directory);
    const sessionPath = sessionId
        ? resolveSessionStatePath('skill-active', sessionId, directory)
        : null;
    // Root defaults to the same payload as session. Explicit `null` deletes root.
    const rootState = options?.rootState === undefined ? nextState : options.rootState;
    const writeOrRemove = (filePath, payload) => {
        const shouldRemove = payload === null || isEmptyV2(payload);
        if (shouldRemove) {
            if (!existsSync(filePath))
                return true;
            try {
                unlinkSync(filePath);
                return true;
            }
            catch {
                return false;
            }
        }
        try {
            const envelope = {
                ...payload,
                version: 2,
                _meta: {
                    written_at: new Date().toISOString(),
                    mode: SKILL_ACTIVE_STATE_MODE,
                    ...(sessionId ? { sessionId } : {}),
                },
            };
            atomicWriteJsonSync(filePath, envelope);
            return true;
        }
        catch {
            return false;
        }
    };
    let ok = writeOrRemove(rootPath, rootState);
    if (sessionPath) {
        ok = writeOrRemove(sessionPath, nextState) && ok;
    }
    return ok;
}
// ---------------------------------------------------------------------------
// Legacy-compatible support-skill API (operates on the `support_skill` branch)
// ---------------------------------------------------------------------------
/**
 * Read the support-skill state as a legacy scalar `SkillActiveState`.
 *
 * Returns null when no support_skill entry is present in the v2 ledger.
 * Workflow slots are intentionally NOT exposed through this function —
 * downstream workflow consumers should call `readSkillActiveStateNormalized()`
 * and `resolveAuthoritativeWorkflowSkill()` instead.
 */
export function readSkillActiveState(directory, sessionId) {
    const v2 = readSkillActiveStateNormalized(directory, sessionId);
    const support = v2.support_skill;
    if (!support || typeof support.active !== 'boolean')
        return null;
    return support;
}
/**
 * Write support-skill state. No-op for skills with 'none' protection.
 *
 * Preserves the `active_skills` workflow ledger — every write reads the full
 * v2 state, updates only the `support_skill` branch, and re-writes both
 * copies together via `writeSkillActiveStateCopies()`.
 *
 * @param rawSkillName - Original skill name as invoked. When provided without
 *   the `oh-my-claudecode:` prefix, protection returns 'none' to avoid
 *   confusion with user-defined project skills of the same name (#1581).
 */
export function writeSkillActiveState(directory, skillName, sessionId, rawSkillName) {
    const protection = getSkillProtection(skillName, rawSkillName);
    if (protection === 'none')
        return null;
    const config = PROTECTION_CONFIGS[protection];
    const now = new Date().toISOString();
    const normalized = skillName.toLowerCase().replace(/^oh-my-claudecode:/, '');
    const existingV2 = readSkillActiveStateNormalized(directory, sessionId);
    const existing = existingV2.support_skill;
    // Nesting guard: a DIFFERENT support skill already owns the slot — skip.
    // Same skill re-invocation is allowed (idempotent refresh).
    if (existing && existing.active && existing.skill_name !== normalized) {
        return null;
    }
    const support = {
        active: true,
        skill_name: normalized,
        session_id: sessionId,
        started_at: now,
        last_checked_at: now,
        reinforcement_count: 0,
        max_reinforcements: config.maxReinforcements,
        stale_ttl_ms: config.staleTtlMs,
    };
    const nextV2 = { ...existingV2, support_skill: support };
    const ok = writeSkillActiveStateCopies(directory, nextV2, sessionId);
    return ok ? support : null;
}
/**
 * Clear support-skill state while preserving workflow slots.
 */
export function clearSkillActiveState(directory, sessionId) {
    const existingV2 = readSkillActiveStateNormalized(directory, sessionId);
    const nextV2 = { ...existingV2, support_skill: null };
    return writeSkillActiveStateCopies(directory, nextV2, sessionId);
}
export function isSkillStateStale(state) {
    if (!state.active)
        return true;
    const lastChecked = state.last_checked_at
        ? new Date(state.last_checked_at).getTime()
        : 0;
    const startedAt = state.started_at
        ? new Date(state.started_at).getTime()
        : 0;
    const mostRecent = Math.max(lastChecked, startedAt);
    if (mostRecent === 0)
        return true;
    const age = Date.now() - mostRecent;
    return age > (state.stale_ttl_ms || 5 * 60 * 1000);
}
/**
 * Stop-hook integration for support skills.
 *
 * Reinforcement increments go through `writeSkillActiveStateCopies()` so the
 * workflow-slot ledger is never clobbered by support-skill writes.
 */
export function checkSkillActiveState(directory, sessionId) {
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
    const trackingState = readTrackingState(directory);
    const staleIds = new Set(getStaleAgents(trackingState).map((a) => a.agent_id));
    const nonStaleRunning = trackingState.agents.filter((a) => a.status === 'running' && !staleIds.has(a.agent_id));
    if (nonStaleRunning.length > 0) {
        if (state.reinforcement_count > 0) {
            const resetSupport = {
                ...state,
                reinforcement_count: 0,
                last_checked_at: new Date().toISOString(),
            };
            const v2 = readSkillActiveStateNormalized(directory, sessionId);
            writeSkillActiveStateCopies(directory, { ...v2, support_skill: resetSupport }, sessionId);
        }
        return { shouldBlock: false, message: '', skillName: state.skill_name };
    }
    // Block the stop and increment reinforcement count.
    const incremented = {
        ...state,
        reinforcement_count: state.reinforcement_count + 1,
        last_checked_at: new Date().toISOString(),
    };
    const v2 = readSkillActiveStateNormalized(directory, sessionId);
    const ok = writeSkillActiveStateCopies(directory, { ...v2, support_skill: incremented }, sessionId);
    if (!ok) {
        return { shouldBlock: false, message: '' };
    }
    const message = `[SKILL ACTIVE: ${incremented.skill_name}] The "${incremented.skill_name}" skill is still executing ` +
        `(reinforcement ${incremented.reinforcement_count}/${incremented.max_reinforcements}). ` +
        `Continue working on the skill's instructions. Do not stop until the skill completes its workflow.`;
    return {
        shouldBlock: true,
        message,
        skillName: incremented.skill_name,
    };
}
//# sourceMappingURL=index.js.map