import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectStalePrd, formatStalePrdWarning, getSessionEndStalePrdWarning, reconcileStalePrd, reconcileStalePrdForStartup, runObservableCheck, PRD_RECONCILIATION_AUDIT_FILENAME, DEFAULT_STALE_PRD_AFTER_MS, readPrd, writePrd, getPrdStatus, shouldCompleteByPrd, ensurePrdForStartup, getRalphContext, writeRalphState, createRalphLoopHook, getSessionPrdPath, } from '../hooks/ralph/index.js';
// ============================================================================
// Helpers
// ============================================================================
function makePrd(overrides) {
    return {
        project: 'TestProject',
        branchName: 'ralph/test-feature',
        description: 'Test feature',
        userStories: [
            { id: 'US-001', title: 'Story one', description: '', acceptanceCriteria: [], priority: 1, passes: false, architectVerified: false },
            { id: 'US-002', title: 'Story two', description: '', acceptanceCriteria: [], priority: 2, passes: false, architectVerified: false },
        ],
        ...overrides,
    };
}
function backdateFile(filePath, msAgo) {
    const past = new Date(Date.now() - msAgo);
    utimesSync(filePath, past, past);
}
function backdatePrd(directory, sessionId, msAgo = 1000) {
    const prd = readPrd(directory, sessionId);
    expect(prd).not.toBeNull();
    const prdPath = sessionId ? getSessionPrdPath(directory, sessionId) : join(directory, '.omc', 'prd.json');
    backdateFile(prdPath, msAgo);
}
function initGitRepo(directory) {
    execFileSync('git', ['init', '-q'], { cwd: directory });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: directory });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: directory });
}
function gitCommitAll(directory, message) {
    execFileSync('git', ['add', '-A'], { cwd: directory });
    execFileSync('git', ['commit', '-q', '-m', message], { cwd: directory });
}
function readAuditEntries(directory, sessionId) {
    const auditDir = sessionId
        ? join(directory, '.omc', 'state', 'sessions', sessionId)
        : join(directory, '.omc', 'state');
    const auditPath = join(auditDir, PRD_RECONCILIATION_AUDIT_FILENAME);
    if (!existsSync(auditPath)) {
        return [];
    }
    return readFileSync(auditPath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
}
describe('Ralph PRD Stale-State Detection & Reconciliation (#3669)', () => {
    let testDir;
    beforeEach(() => {
        testDir = join(tmpdir(), `ralph-prd-stale-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(testDir, { recursive: true });
    });
    afterEach(() => {
        if (existsSync(testDir)) {
            rmSync(testDir, { recursive: true, force: true });
        }
    });
    // ==========================================================================
    // Reproduction: all-false-but-landed PRD stays silent today
    // ==========================================================================
    it('reproduces #3669: an all-false PRD whose work actually landed is not complete and produced no warning', () => {
        // Work "landed": the symbol the PR was supposed to introduce exists on trunk.
        mkdirSync(join(testDir, 'src'), { recursive: true });
        writeFileSync(join(testDir, 'src', 'landed.ts'), 'export const LANDED_SYMBOL = 42;\n');
        const prd = makePrd({
            // No reconciliation config: this is the "before the fix" shape.
            userStories: [
                { id: 'US-001', title: 'Land story', description: '', acceptanceCriteria: [], priority: 1, passes: false, architectVerified: false },
                { id: 'US-002', title: 'Land story two', description: '', acceptanceCriteria: [], priority: 2, passes: false, architectVerified: false },
            ],
        });
        expect(writePrd(testDir, prd)).toBe(true);
        // Completion is never inferred from landed state alone.
        expect(getPrdStatus(prd).allComplete).toBe(false);
        expect(shouldCompleteByPrd(testDir)).toBe(false);
        // Before the fix there was no warning surface at all; today the detector
        // flags the divergence only when a stale signal exists.
        expect(detectStalePrd(testDir)?.stale).toBe(false); // fresh file, no signals
        // A stale PRD (old + unfinished) IS detected, and with configured content
        // evidence the story is reconciled instead of silently left outstanding.
        const prdWithChecks = makePrd({
            branchName: 'ralph/landed-work',
            reconciliation: {
                staleAfterMs: 1,
                observableChecks: {
                    'US-001': [{ type: 'fileContains', path: 'src/landed.ts', pattern: 'LANDED_SYMBOL' }],
                    'US-002': [{ type: 'fileContains', path: 'src/landed.ts', pattern: 'LANDED_SYMBOL' }],
                },
            },
        });
        expect(writePrd(testDir, prdWithChecks)).toBe(true);
        backdatePrd(testDir);
        const detection = detectStalePrd(testDir);
        expect(detection?.stale).toBe(true);
        expect(detection?.unfinished).toEqual(['US-001', 'US-002']);
        const result = reconcileStalePrd(testDir);
        expect(result?.reconciled).toEqual(['US-001', 'US-002']);
        expect(result?.warning).toBeNull();
        const reconciled = readPrd(testDir);
        expect(reconciled?.userStories.every(s => s.passes === true)).toBe(true);
        // Reconciled stories still require Step 7 reviewer verification.
        expect(getPrdStatus(reconciled).allComplete).toBe(false);
    });
    // ==========================================================================
    // Never infer completion from PR status / branch state alone
    // ==========================================================================
    it('never infers completion from PR status alone: branch/merge signals warn but never auto-complete', () => {
        initGitRepo(testDir);
        mkdirSync(join(testDir, 'src'), { recursive: true });
        writeFileSync(join(testDir, 'src', 'landed.ts'), 'export const LANDED_SYMBOL = 42;\n');
        gitCommitAll(testDir, 'land work');
        // PRD points at a branch that does not exist and has no reconciliation config.
        const prd = makePrd({ branchName: 'feature/merged-elsewhere' });
        expect(writePrd(testDir, prd)).toBe(true);
        const detection = detectStalePrd(testDir);
        expect(detection?.stale).toBe(true); // stale pointer signal, fresh file
        expect(detection?.stalePointers.length).toBeGreaterThan(0);
        const result = reconcileStalePrd(testDir);
        expect(result?.reconciled).toEqual([]);
        expect(result?.skipped).toHaveLength(2);
        expect(result?.skipped.every(s => s.reason.includes('no configured observable evidence'))).toBe(true);
        expect(result?.warning).not.toBeNull();
        // No story was auto-marked: PR status/branch state is a signal, not evidence.
        const prdAfter = readPrd(testDir);
        expect(prdAfter?.userStories.every(s => s.passes === false)).toBe(true);
        expect(getPrdStatus(prdAfter).allComplete).toBe(false);
    });
    // ==========================================================================
    // Observable checks
    // ==========================================================================
    it('runs observable checks fail-closed (fileExists / fileContains / gitGrep / traversal)', () => {
        mkdirSync(join(testDir, 'src'), { recursive: true });
        writeFileSync(join(testDir, 'src', 'landed.ts'), 'export const LANDED_SYMBOL = 42;\n');
        expect(runObservableCheck({ type: 'fileExists', path: 'src/landed.ts' }, testDir)).toMatchObject({ passed: true });
        expect(runObservableCheck({ type: 'fileExists', path: 'src/missing.ts' }, testDir)).toMatchObject({ passed: false });
        expect(runObservableCheck({ type: 'fileContains', path: 'src/landed.ts', pattern: 'LANDED_SYMBOL' }, testDir)).toMatchObject({ passed: true });
        expect(runObservableCheck({ type: 'fileContains', path: 'src/landed.ts', pattern: 'MISSING_SYMBOL' }, testDir)).toMatchObject({ passed: false });
        // Path traversal is rejected, not resolved outside the project root.
        expect(runObservableCheck({ type: 'fileExists', path: '../escape.txt' }, testDir)).toMatchObject({ passed: false });
        // Unknown types fail closed.
        expect(runObservableCheck({ type: 'bogus' }, testDir)).toMatchObject({ passed: false });
        initGitRepo(testDir);
        gitCommitAll(testDir, 'land work');
        expect(runObservableCheck({ type: 'gitGrep', ref: 'HEAD', pattern: 'LANDED_SYMBOL' }, testDir)).toMatchObject({ passed: true });
        expect(runObservableCheck({ type: 'gitGrep', ref: 'HEAD', pattern: 'MISSING_SYMBOL' }, testDir)).toMatchObject({ passed: false });
    });
    // ==========================================================================
    // all-false-but-landed evidence (content on trunk, gitGrep)
    // ==========================================================================
    it('reconciles all-false-but-landed stories from git content evidence with an audit trail', () => {
        initGitRepo(testDir);
        mkdirSync(join(testDir, 'src'), { recursive: true });
        writeFileSync(join(testDir, 'src', 'landed.ts'), 'export const S1_SYMBOL = 1; export const S2_SYMBOL = 2;\n');
        gitCommitAll(testDir, 'land work');
        const prd = makePrd({
            reconciliation: {
                staleAfterMs: 1,
                observableChecks: {
                    'US-001': [{ type: 'gitGrep', ref: 'HEAD', pattern: 'S1_SYMBOL', description: 'S1 symbol on trunk' }],
                    'US-002': [{ type: 'gitGrep', ref: 'HEAD', pattern: 'S2_SYMBOL' }],
                },
            },
        });
        expect(writePrd(testDir, prd)).toBe(true);
        backdatePrd(testDir);
        const result = reconcileStalePrd(testDir);
        expect(result?.reconciled).toEqual(['US-001', 'US-002']);
        expect(result?.skipped).toEqual([]);
        expect(result?.warning).toBeNull();
        expect(result?.auditPath).not.toBeNull();
        const entries = readAuditEntries(testDir);
        expect(entries).toHaveLength(2);
        expect(entries.every(e => e.decision === 'reconciled' && e.newPasses === true)).toBe(true);
        expect(entries.every(e => typeof e.evidence === 'string' && (e.evidence.includes('S1_SYMBOL') || e.evidence.includes('S2_SYMBOL')))).toBe(true);
        const prdAfter = readPrd(testDir);
        expect(prdAfter?.userStories[0].passes).toBe(true);
        expect(prdAfter?.userStories[0].architectVerified).toBe(false);
        expect(prdAfter?.userStories[0].notes).toContain('Reconciled from observable evidence');
        // Audit trail preserved: reconciliation config survives the round trip.
        expect(prdAfter?.reconciliation?.observableChecks?.['US-001']).toBeDefined();
    });
    // ==========================================================================
    // Partial reconciliation
    // ==========================================================================
    it('reconciles only stories whose configured evidence passes; others are skipped with a warning', () => {
        mkdirSync(join(testDir, 'src'), { recursive: true });
        writeFileSync(join(testDir, 'src', 'landed.ts'), 'export const S1_SYMBOL = 1;\n');
        const prd = makePrd({
            reconciliation: {
                staleAfterMs: 1,
                observableChecks: {
                    'US-001': [{ type: 'fileContains', path: 'src/landed.ts', pattern: 'S1_SYMBOL' }],
                    'US-002': [{ type: 'fileContains', path: 'src/landed.ts', pattern: 'S2_SYMBOL' }], // fails
                },
            },
        });
        // US-003 has no configured checks at all.
        prd.userStories.push({ id: 'US-003', title: 'Unverifiable', description: '', acceptanceCriteria: [], priority: 3, passes: false, architectVerified: false });
        expect(writePrd(testDir, prd)).toBe(true);
        backdatePrd(testDir);
        const result = reconcileStalePrd(testDir);
        expect(result?.reconciled).toEqual(['US-001']);
        expect(result?.skipped.map(s => s.storyId).sort()).toEqual(['US-002', 'US-003']);
        expect(result?.warning).not.toBeNull();
        expect(result?.warning).toContain('US-002');
        expect(result?.warning).toContain('US-003');
        const prdAfter = readPrd(testDir);
        expect(prdAfter?.userStories.find(s => s.id === 'US-001')?.passes).toBe(true);
        expect(prdAfter?.userStories.find(s => s.id === 'US-002')?.passes).toBe(false);
        expect(prdAfter?.userStories.find(s => s.id === 'US-003')?.passes).toBe(false);
        const entries = readAuditEntries(testDir);
        expect(entries).toHaveLength(3);
        expect(entries.filter(e => e.decision === 'reconciled')).toHaveLength(1);
        expect(entries.filter(e => e.decision === 'skipped')).toHaveLength(2);
    });
    // ==========================================================================
    // Stale pointers
    // ==========================================================================
    it('flags a dead branch pointer and a merged branch pointer as staleness signals', () => {
        initGitRepo(testDir);
        writeFileSync(join(testDir, 'a.txt'), 'a\n');
        gitCommitAll(testDir, 'base');
        // feature/landed points at the current HEAD → "already merged" pointer.
        execFileSync('git', ['branch', 'feature/landed'], { cwd: testDir });
        const deadBranchPrd = makePrd({ branchName: 'feature/dead' });
        expect(writePrd(testDir, deadBranchPrd)).toBe(true);
        const dead = detectStalePrd(testDir);
        expect(dead?.stale).toBe(true);
        expect(dead?.stalePointers.join(' ')).toContain('no longer exists');
        expect(formatStalePrdWarning(dead)).toContain('no longer exists');
        const mergedBranchPrd = makePrd({ branchName: 'feature/landed' });
        expect(writePrd(testDir, mergedBranchPrd)).toBe(true);
        const merged = detectStalePrd(testDir);
        expect(merged?.stale).toBe(true);
        expect(merged?.stalePointers.join(' ')).toContain('already merged');
    });
    it('does not flag the current working branch as a stale pointer', () => {
        initGitRepo(testDir);
        writeFileSync(join(testDir, 'a.txt'), 'a\n');
        gitCommitAll(testDir, 'base');
        const current = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: testDir }).toString().trim();
        const prd = makePrd({ branchName: current });
        expect(writePrd(testDir, prd)).toBe(true);
        expect(detectStalePrd(testDir)?.stale).toBe(false); // fresh + current branch
    });
    // ==========================================================================
    // Normal Step 8 → no warning
    // ==========================================================================
    it('emits no session-end warning after a normal Step 8 (all stories complete, ralph state cleared)', () => {
        const prd = makePrd({
            userStories: [
                { id: 'US-001', title: 'Done', description: '', acceptanceCriteria: [], priority: 1, passes: true, architectVerified: true },
                { id: 'US-002', title: 'Done', description: '', acceptanceCriteria: [], priority: 2, passes: true, architectVerified: true },
            ],
        });
        expect(writePrd(testDir, prd, 'session-step8')).toBe(true);
        expect(getSessionEndStalePrdWarning(testDir, 'session-step8')).toBeNull();
        expect(detectStalePrd(testDir, 'session-step8')?.stale).toBe(false);
    });
    // ==========================================================================
    // Cancel / crash
    // ==========================================================================
    it('warns on session end when the PRD was left unfinished by a cancel (ralph state cleared)', () => {
        expect(writePrd(testDir, makePrd(), 'session-cancel')).toBe(true);
        const warning = getSessionEndStalePrdWarning(testDir, 'session-cancel');
        expect(warning).not.toBeNull();
        expect(warning).toContain('2/2 unfinished stories');
        expect(warning).toContain('US-001');
        expect(warning).toContain('US-002');
    });
    it('flags an abnormal exit when the ralph loop state is still active (crash/force-kill)', () => {
        expect(writePrd(testDir, makePrd(), 'session-crash')).toBe(true);
        expect(writeRalphState(testDir, { active: true, iteration: 3, max_iterations: 10, started_at: new Date().toISOString(), prompt: 'task', session_id: 'session-crash' }, 'session-crash')).toBe(true);
        const detection = detectStalePrd(testDir, 'session-crash');
        expect(detection?.abnormalExit).toBe(true);
        expect(detection?.stale).toBe(true);
        expect(detection?.reasons.join(' ')).toContain('Step 8 cancel never ran');
        const warning = getSessionEndStalePrdWarning(testDir, 'session-crash');
        expect(warning).not.toBeNull();
        expect(warning).toContain('Ralph loop state is still active');
    });
    it('excludes the active-loop signal from the continuation context, so a live loop is not spammed', () => {
        // Fresh unfinished PRD with an active ralph state: this is a healthy live
        // loop, so the continuation context must NOT warn.
        expect(writePrd(testDir, makePrd(), 'session-live')).toBe(true);
        expect(writeRalphState(testDir, { active: true, iteration: 2, max_iterations: 10, started_at: new Date().toISOString(), prompt: 'task', session_id: 'session-live' }, 'session-live')).toBe(true);
        const context = getRalphContext(testDir, 'session-live');
        expect(context).not.toContain('<stale-prd-warning>');
        // The same setup DOES warn when staleness has a real signal (old PRD).
        backdatePrd(testDir, 'session-live', DEFAULT_STALE_PRD_AFTER_MS + 60_000);
        const staleContext = getRalphContext(testDir, 'session-live');
        expect(staleContext).toContain('<stale-prd-warning>');
        expect(staleContext).toContain('unfinished stories');
    });
    // ==========================================================================
    // Session isolation
    // ==========================================================================
    it('keeps detection, reconciliation, and audit strictly session-scoped', () => {
        const prdA = makePrd({
            reconciliation: { staleAfterMs: 1, observableChecks: { 'US-001': [{ type: 'fileContains', path: 'src/landed.ts', pattern: 'A_SYMBOL' }] } },
        });
        const prdB = makePrd({});
        mkdirSync(join(testDir, 'src'), { recursive: true });
        writeFileSync(join(testDir, 'src', 'landed.ts'), 'export const A_SYMBOL = 1;\n');
        expect(writePrd(testDir, prdA, 'session-a')).toBe(true);
        expect(writePrd(testDir, prdB, 'session-b')).toBe(true);
        backdatePrd(testDir, 'session-a');
        const result = reconcileStalePrd(testDir, 'session-a');
        // US-001 has passing evidence; US-002 has no configured checks → skipped.
        expect(result?.reconciled).toEqual(['US-001']);
        expect(result?.skipped.map(s => s.storyId)).toEqual(['US-002']);
        const prdARead = readPrd(testDir, 'session-a');
        expect(prdARead?.userStories[0].passes).toBe(true);
        const prdBRead = readPrd(testDir, 'session-b');
        expect(prdBRead?.userStories.every(s => s.passes === false)).toBe(true);
        // Audit log is per-session; session-b has none.
        expect(readAuditEntries(testDir, 'session-a').length).toBeGreaterThan(0);
        expect(readAuditEntries(testDir, 'session-b')).toEqual([]);
    });
    // ==========================================================================
    // Legacy schema (project-level prd.json, no session)
    // ==========================================================================
    it('supports legacy project-level PRDs without a session and round-trips reconciliation config', () => {
        const legacy = makePrd({
            branchName: 'feature/legacy',
            reconciliation: {
                staleAfterMs: 1,
                observableChecks: {
                    'US-001': [{ type: 'fileContains', path: 'src/landed.ts', pattern: 'LEGACY_SYMBOL', description: 'legacy evidence' }],
                },
            },
        });
        mkdirSync(join(testDir, 'src'), { recursive: true });
        writeFileSync(join(testDir, 'src', 'landed.ts'), 'export const LEGACY_SYMBOL = 1;\n');
        expect(writePrd(testDir, legacy)).toBe(true);
        // Round trip preserves the reconciliation config.
        const read = readPrd(testDir);
        expect(read?.reconciliation?.staleAfterMs).toBe(1);
        expect(read?.reconciliation?.observableChecks?.['US-001']?.[0]).toMatchObject({ type: 'fileContains', path: 'src/landed.ts' });
        backdatePrd(testDir);
        const result = reconcileStalePrd(testDir);
        expect(result?.reconciled).toEqual(['US-001']); // US-002 has no configured checks
        expect(result?.skipped.map(s => s.storyId)).toEqual(['US-002']);
        const after = readPrd(testDir);
        expect(after?.userStories.find(s => s.id === 'US-001')?.passes).toBe(true);
        expect(after?.userStories.find(s => s.id === 'US-002')?.passes).toBe(false);
    });
    it('keeps legacy PRDs without reconciliation config readable and never auto-marks them', () => {
        // Old-shape PRD: literally no reconciliation field anywhere.
        const legacyRaw = {
            project: 'Legacy',
            branchName: 'ralph/legacy',
            description: 'old',
            userStories: [
                { id: 'US-001', title: 'A', description: '', acceptanceCriteria: [], priority: 1, passes: false, architectVerified: false },
            ],
        };
        mkdirSync(join(testDir, '.omc'), { recursive: true });
        writeFileSync(join(testDir, '.omc', 'prd.json'), JSON.stringify(legacyRaw, null, 2));
        const prd = readPrd(testDir);
        expect(prd?.userStories[0].passes).toBe(false);
        expect(prd?.reconciliation).toBeUndefined();
        backdatePrd(testDir, undefined, DEFAULT_STALE_PRD_AFTER_MS + 60_000);
        const detection = detectStalePrd(testDir);
        expect(detection?.stale).toBe(true);
        expect(detection?.unfinished).toEqual(['US-001']);
        const result = reconcileStalePrd(testDir);
        expect(result?.reconciled).toEqual([]);
        expect(result?.skipped[0]?.reason).toContain('no configured observable evidence');
        expect(readPrd(testDir)?.userStories[0].passes).toBe(false);
    });
    it('migrates a legacy PRD into a session scope carrying the reconciliation config, without mutating the legacy file', () => {
        const legacy = makePrd({
            reconciliation: { staleAfterMs: 1, observableChecks: { 'US-001': [{ type: 'fileExists', path: 'src/landed.ts' }] } },
        });
        mkdirSync(join(testDir, '.omc'), { recursive: true });
        mkdirSync(join(testDir, 'src'), { recursive: true });
        writeFileSync(join(testDir, 'src', 'landed.ts'), 'x');
        writeFileSync(join(testDir, '.omc', 'prd.json'), JSON.stringify(legacy, null, 2));
        const legacyPath = join(testDir, '.omc', 'prd.json');
        const legacyBefore = readFileSync(legacyPath, 'utf-8');
        const result = ensurePrdForStartup(testDir, 'Project', 'branch', 'task', undefined, 'session-migrate');
        expect(result.ok).toBe(true);
        expect(result.path).toBe(getSessionPrdPath(testDir, 'session-migrate'));
        const migrated = readPrd(testDir, 'session-migrate');
        expect(migrated?.reconciliation?.observableChecks?.['US-001']).toBeDefined();
        // Legacy file untouched.
        expect(readFileSync(legacyPath, 'utf-8')).toBe(legacyBefore);
    });
    // ==========================================================================
    // Startup integration (startLoop)
    // ==========================================================================
    it('reconciles a stale session PRD at Ralph startup and surfaces no residual warning when all evidence passes', () => {
        mkdirSync(join(testDir, 'src'), { recursive: true });
        writeFileSync(join(testDir, 'src', 'landed.ts'), 'export const START_SYMBOL = 1;\n');
        const prd = makePrd({
            reconciliation: {
                staleAfterMs: 1,
                observableChecks: {
                    'US-001': [{ type: 'fileContains', path: 'src/landed.ts', pattern: 'START_SYMBOL' }],
                    'US-002': [{ type: 'fileContains', path: 'src/landed.ts', pattern: 'START_SYMBOL' }],
                },
            },
        });
        expect(writePrd(testDir, prd, 'session-start')).toBe(true);
        backdatePrd(testDir, 'session-start');
        const hook = createRalphLoopHook(testDir);
        const started = hook.startLoop('session-start', 'reconcile me');
        expect(started).toBe(true);
        const prdAfter = readPrd(testDir, 'session-start');
        expect(prdAfter?.userStories.every(s => s.passes === true)).toBe(true);
    });
    it('reconcileStalePrdForStartup never throws and reports the remaining warning', () => {
        mkdirSync(join(testDir, 'src'), { recursive: true });
        writeFileSync(join(testDir, 'src', 'landed.ts'), 'x');
        const prd = makePrd({
            reconciliation: { staleAfterMs: 1, observableChecks: { 'US-001': [{ type: 'fileExists', path: 'src/landed.ts' }] } },
        });
        expect(writePrd(testDir, prd, 'session-warn')).toBe(true);
        backdatePrd(testDir, 'session-warn');
        const result = reconcileStalePrdForStartup(testDir, 'session-warn');
        expect(result.warning).not.toBeNull();
        expect(result.warning).toContain('US-002');
    });
    // ==========================================================================
    // Warning format
    // ==========================================================================
    it('formats the explicit stale-unfinished-PRD warning with counts, ids, and age', () => {
        const prd = makePrd();
        expect(writePrd(testDir, prd, 'session-fmt')).toBe(true);
        backdatePrd(testDir, 'session-fmt', 3 * 60 * 60 * 1000);
        const detection = detectStalePrd(testDir, 'session-fmt');
        const warning = formatStalePrdWarning(detection);
        expect(warning).toContain('[STALE PRD WARNING]');
        expect(warning).toContain('2/2 unfinished stories');
        expect(warning).toContain('US-001, US-002');
        expect(warning).toContain('last touched');
        expect(warning).toContain('3 hours ago');
        expect(warning).toContain('Step 5');
        expect(DEFAULT_STALE_PRD_AFTER_MS).toBe(2 * 60 * 60 * 1000);
    });
});
//# sourceMappingURL=ralph-prd-stale.test.js.map