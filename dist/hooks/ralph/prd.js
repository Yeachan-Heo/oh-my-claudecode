/**
 * Ralph PRD (Product Requirements Document) Support
 *
 * Implements structured task tracking using prd.json format from the original Ralph.
 * Each user story has:
 * - id: Unique identifier (e.g., "US-001")
 * - title: Short description
 * - description: User story format
 * - acceptanceCriteria: List of criteria to pass
 * - priority: Execution order (1 = highest)
 * - passes: Boolean indicating completion
 * - notes: Optional notes from implementation
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { ensureSessionStateDir, getOmcRoot, getSessionStateDir } from '../../lib/worktree-paths.js';
// ============================================================================
// Constants
// ============================================================================
export const PRD_FILENAME = 'prd.json';
export const PRD_EXAMPLE_FILENAME = 'prd.example.json';
export const MIN_CRITERION_EVIDENCE_LENGTH = 10;
function normalizeCriterionAmendment(candidate) {
    if (!candidate || typeof candidate !== 'object') {
        return null;
    }
    const amendment = candidate;
    const kind = amendment.kind;
    const original = amendment.original;
    const reason = amendment.reason;
    const evidence = amendment.evidence;
    const authority = amendment.authority;
    const timestamp = amendment.timestamp;
    const replacement = amendment.replacement;
    if ((kind !== 'replaced' && kind !== 'superseded') ||
        typeof original !== 'string' ||
        original.trim() === '' ||
        typeof reason !== 'string' ||
        reason.trim() === '' ||
        typeof evidence !== 'string' ||
        evidence.trim() === '' ||
        typeof authority !== 'string' ||
        authority.trim() === '' ||
        typeof timestamp !== 'string' ||
        timestamp.trim() === '' ||
        (kind === 'replaced' && (typeof replacement !== 'string' || replacement.trim() === '')) ||
        (kind === 'superseded' && replacement !== undefined)) {
        return null;
    }
    return {
        kind,
        original,
        replacement: kind === 'replaced' ? replacement : undefined,
        reason,
        evidence,
        authority,
        timestamp
    };
}
/**
 * Normalize a story's optional amendment ledger and enforce its invariants:
 * - an amended/superseded original must not still be active, and
 * - an original may be amended at most once.
 * Any violation makes the story (and therefore the PRD) invalid so that a
 * silently deviated PRD fails closed instead of being misread as authoritative.
 */
function normalizeCriterionAmendments(candidate, acceptanceCriteria) {
    if (candidate === undefined) {
        return undefined;
    }
    if (!Array.isArray(candidate)) {
        return null;
    }
    if (candidate.length === 0) {
        return undefined;
    }
    const amendments = candidate.map(normalizeCriterionAmendment);
    if (amendments.some(amendment => amendment === null)) {
        return null;
    }
    const originals = new Set();
    const active = new Set(acceptanceCriteria);
    for (const amendment of amendments) {
        if (originals.has(amendment.original) || active.has(amendment.original)) {
            return null;
        }
        originals.add(amendment.original);
    }
    return amendments;
}
function normalizeStory(candidate) {
    if (!candidate || typeof candidate !== 'object') {
        return null;
    }
    const story = candidate;
    if (typeof story.id !== 'string' ||
        typeof story.title !== 'string' ||
        typeof story.description !== 'string' ||
        !Array.isArray(story.acceptanceCriteria) ||
        !story.acceptanceCriteria.every(criterion => typeof criterion === 'string') ||
        typeof story.priority !== 'number' ||
        !Number.isFinite(story.priority) ||
        typeof story.passes !== 'boolean') {
        return null;
    }
    const acceptanceCriteria = [...story.acceptanceCriteria];
    const criterionAmendments = normalizeCriterionAmendments(story.criterionAmendments, acceptanceCriteria);
    if (criterionAmendments === null) {
        return null;
    }
    return {
        id: story.id,
        title: story.title,
        description: story.description,
        acceptanceCriteria,
        criterionAmendments,
        priority: story.priority,
        passes: story.passes,
        architectVerified: story.architectVerified === true,
        notes: typeof story.notes === 'string' ? story.notes : undefined
    };
}
function normalizePrd(candidate) {
    if (!candidate || typeof candidate !== 'object') {
        return null;
    }
    const prd = candidate;
    if (typeof prd.project !== 'string' ||
        typeof prd.branchName !== 'string' ||
        typeof prd.description !== 'string' ||
        !Array.isArray(prd.userStories)) {
        return null;
    }
    const userStories = prd.userStories
        .map(normalizeStory);
    if (userStories.some(story => story === null)) {
        return null;
    }
    const reconciliation = normalizeReconciliation(prd.reconciliation);
    return {
        project: prd.project,
        branchName: prd.branchName,
        description: prd.description,
        userStories: userStories,
        ...(reconciliation ? { reconciliation } : {})
    };
}
/**
 * Validate and preserve the optional reconciliation config. Returns undefined
 * for legacy PRDs (no field) or malformed values — a malformed config must not
 * invalidate an otherwise valid PRD, it just disables auto-reconciliation.
 */
function normalizeReconciliation(candidate) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return undefined;
    }
    const raw = candidate;
    const config = {};
    if (typeof raw.staleAfterMs === 'number' && Number.isFinite(raw.staleAfterMs) && raw.staleAfterMs > 0) {
        config.staleAfterMs = raw.staleAfterMs;
    }
    if (typeof raw.autoReconcile === 'boolean') {
        config.autoReconcile = raw.autoReconcile;
    }
    if (raw.observableChecks && typeof raw.observableChecks === 'object' && !Array.isArray(raw.observableChecks)) {
        const checksByStory = raw.observableChecks;
        const observableChecks = {};
        for (const [storyId, checks] of Object.entries(checksByStory)) {
            if (!Array.isArray(checks)) {
                continue;
            }
            const normalizedChecks = checks
                .map(c => normalizeObservableCheck(c))
                .filter((c) => c !== null);
            if (normalizedChecks.length > 0) {
                observableChecks[storyId] = normalizedChecks;
            }
        }
        if (Object.keys(observableChecks).length > 0) {
            config.observableChecks = observableChecks;
        }
    }
    return Object.keys(config).length > 0 ? config : undefined;
}
/**
 * Validate a single observable check. Unknown check types or missing required
 * fields are dropped rather than failing the whole PRD.
 */
function normalizeObservableCheck(candidate) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return null;
    }
    const raw = candidate;
    const type = raw.type;
    if (type !== 'fileExists' && type !== 'fileContains' && type !== 'gitGrep') {
        return null;
    }
    const check = { type };
    if (typeof raw.path === 'string' && raw.path.length > 0) {
        check.path = raw.path;
    }
    if (typeof raw.ref === 'string' && raw.ref.length > 0) {
        check.ref = raw.ref;
    }
    if (typeof raw.pattern === 'string' && raw.pattern.length > 0) {
        check.pattern = raw.pattern;
    }
    if (typeof raw.description === 'string' && raw.description.length > 0) {
        check.description = raw.description;
    }
    return check;
}
export function readPrdFromPath(prdPath) {
    try {
        const content = readFileSync(prdPath, 'utf-8');
        const parsed = JSON.parse(content);
        const normalized = normalizePrd(parsed);
        if (!normalized) {
            return { error: `Invalid PRD structure in ${prdPath}.` };
        }
        return { prd: normalized };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { error: `Failed to read ${prdPath}: ${message}` };
    }
}
function isStoryComplete(story) {
    return story.passes && story.architectVerified === true;
}
// ============================================================================
// File Operations
// ============================================================================
/**
 * Get the path to the prd.json file in a directory
 */
export function getPrdPath(directory) {
    return join(directory, PRD_FILENAME);
}
/**
 * Get the path to the prd.json in .omc subdirectory
 */
export function getOmcPrdPath(directory) {
    return join(getOmcRoot(directory), PRD_FILENAME);
}
/**
 * Get the session-scoped transient PRD path.
 */
export function getSessionPrdPath(directory, sessionId) {
    return join(getSessionStateDir(sessionId, directory), PRD_FILENAME);
}
/**
 * Get the legacy state-manager PRD path used by older builds.
 */
export function getLegacyStatePrdPath(directory) {
    return join(getOmcRoot(directory), 'state', PRD_FILENAME);
}
/**
 * Find prd.json in a directory.
 *
 * With a session ID, active PRD state is read from the session-scoped path
 * first, then legacy project-level paths are treated as migration inputs.
 */
export function findPrdPath(directory, sessionId) {
    if (sessionId) {
        const sessionPath = getSessionPrdPath(directory, sessionId);
        if (existsSync(sessionPath)) {
            return sessionPath;
        }
    }
    const rootPath = getPrdPath(directory);
    if (existsSync(rootPath)) {
        return rootPath;
    }
    const omcPath = getOmcPrdPath(directory);
    if (existsSync(omcPath)) {
        return omcPath;
    }
    const legacyStatePath = getLegacyStatePrdPath(directory);
    if (existsSync(legacyStatePath)) {
        return legacyStatePath;
    }
    return null;
}
/**
 * Read PRD from disk
 */
export function readPrd(directory, sessionId) {
    const prdPath = findPrdPath(directory, sessionId);
    if (!prdPath) {
        return null;
    }
    return readPrdFromPath(prdPath).prd ?? null;
}
/**
 * Write PRD to disk
 */
export function writePrd(directory, prd, sessionId) {
    let prdPath;
    if (sessionId) {
        try {
            ensureSessionStateDir(sessionId, directory);
        }
        catch {
            return false;
        }
        prdPath = getSessionPrdPath(directory, sessionId);
    }
    else {
        // Backward compatibility for direct callers without a session ID:
        // prefer writing to an existing legacy location, or .omc by default.
        prdPath = findPrdPath(directory) ?? getOmcPrdPath(directory);
    }
    try {
        mkdirSync(dirname(prdPath), { recursive: true });
        writeFileSync(prdPath, JSON.stringify(prd, null, 2));
        return true;
    }
    catch {
        return false;
    }
}
// ============================================================================
// PRD Status & Operations
// ============================================================================
/**
 * Get the status of a PRD
 */
export function getPrdStatus(prd) {
    const stories = prd.userStories;
    const pending = stories.filter(s => !isStoryComplete(s));
    const fullyCompleted = stories.filter(isStoryComplete);
    // Sort pending by priority to find next story
    const sortedPending = [...pending].sort((a, b) => a.priority - b.priority);
    return {
        total: stories.length,
        completed: fullyCompleted.length,
        pending: pending.length,
        allComplete: pending.length === 0,
        nextStory: sortedPending[0] || null,
        incompleteIds: pending.map(s => s.id)
    };
}
/**
 * Mark a story as complete (passes: true)
 */
export function markStoryComplete(directory, storyId, notes, sessionId) {
    const prd = readPrd(directory, sessionId);
    if (!prd) {
        return false;
    }
    const story = prd.userStories.find(s => s.id === storyId);
    if (!story) {
        return false;
    }
    story.passes = true;
    story.architectVerified = false;
    if (notes) {
        story.notes = notes;
    }
    return writePrd(directory, prd, sessionId);
}
/**
 * Mark a story as incomplete (passes: false)
 */
export function markStoryIncomplete(directory, storyId, notes, sessionId) {
    const prd = readPrd(directory, sessionId);
    if (!prd) {
        return false;
    }
    const story = prd.userStories.find(s => s.id === storyId);
    if (!story) {
        return false;
    }
    story.passes = false;
    story.architectVerified = false;
    if (notes) {
        story.notes = notes;
    }
    return writePrd(directory, prd, sessionId);
}
/**
 * Mark a story as architect-verified after reviewer approval
 */
export function markStoryArchitectVerified(directory, storyId, notes, sessionId) {
    const prd = readPrd(directory, sessionId);
    if (!prd) {
        return false;
    }
    const story = prd.userStories.find(s => s.id === storyId);
    if (!story) {
        return false;
    }
    story.architectVerified = true;
    if (notes) {
        story.notes = notes;
    }
    return writePrd(directory, prd, sessionId);
}
/**
 * Get a specific story by ID
 */
export function getStory(directory, storyId, sessionId) {
    const prd = readPrd(directory, sessionId);
    if (!prd) {
        return null;
    }
    return prd.userStories.find(s => s.id === storyId) || null;
}
/**
 * Get the next incomplete story (highest priority)
 */
export function getNextStory(directory, sessionId) {
    const prd = readPrd(directory, sessionId);
    if (!prd) {
        return null;
    }
    const status = getPrdStatus(prd);
    return status.nextStory;
}
/**
 * Apply an evidence-preserving criterion amendment to a story.
 *
 * The original criterion must currently be active. On success the original is
 * removed from `acceptanceCriteria` (a corrected criterion is inserted at the
 * original's position for kind 'replaced'), and the amendment is appended to
 * the story's `criterionAmendments` ledger with bounded proof, reason,
 * authority, and timestamp. There is no silent deletion path: an original can
 * only leave the active list through this ledger or a direct hand edit that
 * fails closed on the next read.
 */
function applyCriterionAmendment(directory, storyId, kind, input, sessionId) {
    const prd = readPrd(directory, sessionId);
    if (!prd) {
        return { ok: false, error: 'prd-not-found' };
    }
    const story = prd.userStories.find(s => s.id === storyId);
    if (!story) {
        return { ok: false, error: 'story-not-found' };
    }
    const original = input.original;
    if (typeof original !== 'string' || original.trim() === '' || !story.acceptanceCriteria.includes(original)) {
        return { ok: false, error: 'original-not-active' };
    }
    const reason = input.reason?.trim() ?? '';
    const evidence = input.evidence?.trim() ?? '';
    const authority = input.authority?.trim() ?? '';
    if (reason === '') {
        return { ok: false, error: 'reason-required' };
    }
    if (evidence === '') {
        return { ok: false, error: 'evidence-required' };
    }
    if (evidence.length < MIN_CRITERION_EVIDENCE_LENGTH) {
        return { ok: false, error: 'evidence-too-short' };
    }
    if (authority === '') {
        return { ok: false, error: 'authority-required' };
    }
    const replacement = input.replacement?.trim();
    if (kind === 'replaced' && (replacement === undefined || replacement === '')) {
        return { ok: false, error: 'replacement-required' };
    }
    if (kind === 'superseded' && input.replacement !== undefined) {
        return { ok: false, error: 'replacement-not-allowed' };
    }
    // A successfully amended original leaves the active list and can never return:
    // read-time normalization rejects any PRD where an amended original is still
    // active, so no second amendment of the same original is possible here.
    const ledger = story.criterionAmendments ?? [];
    const amendment = {
        kind,
        original,
        replacement: kind === 'replaced' ? replacement : undefined,
        reason,
        evidence,
        authority,
        timestamp: input.timestamp ?? new Date().toISOString()
    };
    const originalIndex = story.acceptanceCriteria.indexOf(original);
    const nextCriteria = [...story.acceptanceCriteria];
    nextCriteria.splice(originalIndex, 1);
    if (kind === 'replaced' && replacement !== undefined) {
        nextCriteria.splice(originalIndex, 0, replacement);
    }
    story.acceptanceCriteria = nextCriteria;
    story.criterionAmendments = [...ledger, amendment];
    if (!writePrd(directory, prd, sessionId)) {
        return { ok: false, error: 'write-failed' };
    }
    return { ok: true, amendment };
}
/**
 * Amend (replace) an active acceptance criterion with a corrected one.
 * The original is retained verbatim in the amendment ledger.
 */
export function amendCriterion(directory, storyId, input, sessionId) {
    return applyCriterionAmendment(directory, storyId, 'replaced', input, sessionId);
}
/**
 * Supersede an active acceptance criterion with no replacement. The original
 * no longer governs completion, but is retained verbatim with proof, reason,
 * authority, and timestamp in the amendment ledger.
 */
export function supersedeCriterion(directory, storyId, input, sessionId) {
    return applyCriterionAmendment(directory, storyId, 'superseded', input, sessionId);
}
/**
 * Create a new PRD with user stories from a task description
 */
export function createPrd(project, branchName, description, stories) {
    return {
        project,
        branchName,
        description,
        userStories: stories.map((s, index) => ({
            ...s,
            priority: s.priority ?? index + 1,
            passes: false,
            architectVerified: false
        }))
    };
}
/**
 * Create a simple PRD from a task description (single story)
 */
export function createSimplePrd(project, branchName, taskDescription) {
    return createPrd(project, branchName, taskDescription, [
        {
            id: 'US-001',
            title: taskDescription.slice(0, 50) + (taskDescription.length > 50 ? '...' : ''),
            description: taskDescription,
            acceptanceCriteria: [
                'Implementation is complete',
                'Code compiles/runs without errors',
                'Tests pass (if applicable)',
                'Changes are committed'
            ],
            priority: 1
        }
    ]);
}
/**
 * Initialize a PRD in a directory
 */
export function initPrd(directory, project, branchName, description, stories, sessionId) {
    const prd = stories
        ? createPrd(project, branchName, description, stories)
        : createSimplePrd(project, branchName, description);
    return writePrd(directory, prd, sessionId);
}
/**
 * Ensure Ralph startup has a valid PRD.json to work from.
 * - Missing PRD -> create scaffold
 * - Invalid PRD -> fail clearly
 */
export function ensurePrdForStartup(directory, project, branchName, description, stories, sessionId) {
    const existingPath = findPrdPath(directory, sessionId);
    if (!existingPath) {
        const created = initPrd(directory, project, branchName, description, stories, sessionId);
        const createdPath = findPrdPath(directory, sessionId);
        const prd = created ? readPrd(directory, sessionId) : null;
        if (!created || !createdPath || !prd) {
            return {
                ok: false,
                created: false,
                path: createdPath,
                error: `Ralph requires a valid ${PRD_FILENAME} at startup, but scaffold creation failed.`
            };
        }
        if (prd.userStories.length === 0) {
            return {
                ok: false,
                created: true,
                path: createdPath,
                error: `Ralph created ${createdPath}, but it contains no user stories.`
            };
        }
        return { ok: true, created: true, path: createdPath, prd };
    }
    const parsed = readPrdFromPath(existingPath);
    if (!parsed.prd) {
        return {
            ok: false,
            created: false,
            path: existingPath,
            error: parsed.error ?? `Ralph requires a valid ${PRD_FILENAME} at startup.`
        };
    }
    if (parsed.prd.userStories.length === 0) {
        return {
            ok: false,
            created: false,
            path: existingPath,
            error: `${existingPath} must contain at least one user story for Ralph to start.`
        };
    }
    if (sessionId) {
        const sessionPath = getSessionPrdPath(directory, sessionId);
        if (existingPath !== sessionPath) {
            if (!writePrd(directory, parsed.prd, sessionId)) {
                return {
                    ok: false,
                    created: false,
                    path: existingPath,
                    error: `Ralph found ${existingPath}, but failed to migrate it to session-scoped ${sessionPath}.`
                };
            }
            return {
                ok: true,
                created: false,
                path: sessionPath,
                prd: parsed.prd
            };
        }
    }
    return {
        ok: true,
        created: false,
        path: existingPath,
        prd: parsed.prd
    };
}
// ============================================================================
// PRD Formatting
// ============================================================================
/**
 * Format PRD status as a string for display
 */
export function formatPrdStatus(status) {
    const lines = [];
    lines.push(`[PRD Status: ${status.completed}/${status.total} stories complete]`);
    if (status.allComplete) {
        lines.push('All stories are COMPLETE!');
    }
    else {
        lines.push(`Remaining: ${status.incompleteIds.join(', ')}`);
        if (status.nextStory) {
            lines.push(`Next story: ${status.nextStory.id} - ${status.nextStory.title}`);
        }
    }
    return lines.join('\n');
}
/**
 * Format a story's amendment ledger (struck-through originals with proof).
 * Returns an empty string when the story has no amendments.
 */
export function formatCriterionAmendments(story) {
    const amendments = story.criterionAmendments;
    if (!amendments || amendments.length === 0) {
        return '';
    }
    const lines = ['**Amended/Superseded Criteria (evidence ledger):**'];
    for (const amendment of amendments) {
        const action = amendment.kind === 'replaced' ? 'replaced by' : 'superseded';
        const target = amendment.kind === 'replaced' ? `: ${amendment.replacement}` : '';
        lines.push(`- ~~${amendment.original}~~ — ${action}${target} (reason: ${amendment.reason}; evidence: ${amendment.evidence}; authority: ${amendment.authority}; at: ${amendment.timestamp})`);
    }
    return lines.join('\n');
}
/**
 * Format a story for display
 */
export function formatStory(story) {
    const lines = [];
    lines.push(`## ${story.id}: ${story.title}`);
    const statusLabel = isStoryComplete(story)
        ? 'COMPLETE'
        : story.passes
            ? 'AWAITING ARCHITECT REVIEW'
            : 'PENDING';
    lines.push(`Status: ${statusLabel}`);
    lines.push(`Priority: ${story.priority}`);
    lines.push('');
    lines.push(story.description);
    lines.push('');
    lines.push('**Acceptance Criteria:**');
    story.acceptanceCriteria.forEach((c, i) => {
        lines.push(`${i + 1}. ${c}`);
    });
    const amendments = formatCriterionAmendments(story);
    if (amendments) {
        lines.push('');
        lines.push(amendments);
    }
    if (story.notes) {
        lines.push('');
        lines.push(`**Notes:** ${story.notes}`);
    }
    return lines.join('\n');
}
/**
 * Format entire PRD for display
 */
export function formatPrd(prd) {
    const lines = [];
    const status = getPrdStatus(prd);
    lines.push(`# ${prd.project}`);
    lines.push(`Branch: ${prd.branchName}`);
    lines.push('');
    lines.push(prd.description);
    lines.push('');
    lines.push(formatPrdStatus(status));
    lines.push('');
    lines.push('---');
    lines.push('');
    // Sort by priority for display
    const sortedStories = [...prd.userStories].sort((a, b) => a.priority - b.priority);
    for (const story of sortedStories) {
        lines.push(formatStory(story));
        lines.push('');
        lines.push('---');
        lines.push('');
    }
    return lines.join('\n');
}
/**
 * Format next story prompt for injection into ralph
 */
export function formatNextStoryPrompt(story, prdPath) {
    const amendments = formatCriterionAmendments(story);
    const amendmentSection = amendments ? `\n${amendments}\n` : '';
    return `<current-story>

## Current Story: ${story.id} - ${story.title}

${story.description}

**Acceptance Criteria:**
${story.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}
${amendmentSection}
${prdPath ? `**Active PRD file:** ${prdPath}\n\n` : ''}**Instructions:**
1. Implement this story completely
2. Verify ALL acceptance criteria are met
3. Run quality checks (tests, typecheck, lint)
4. When complete, mark story as passes: true in the active PRD file
5. If implementation proves an acceptance criterion false, amend or supersede it with evidence instead of silently deleting it or claiming it passes (see the amendment ledger above and the ralph skill)
6. If ALL stories are done, run \`/oh-my-claudecode:cancel\` to cleanly exit ralph mode and clean up all state files

</current-story>

---

`;
}
//# sourceMappingURL=prd.js.map