import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const SCRIPT_PATH = join(__dirname, '..', '..', '..', 'templates', 'hooks', 'session-start.mjs');
const NODE = process.execPath;
describe('session-start template guard for same-root parallel sessions (#1744)', () => {
    let tempDir;
    let fakeHome;
    let fakeProject;
    let fetchPreload;
    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'omc-session-start-template-'));
        fakeHome = join(tempDir, 'home');
        fakeProject = join(tempDir, 'project');
        mkdirSync(join(fakeProject, '.omc', 'state'), { recursive: true });
        fetchPreload = join(tempDir, 'fetch-preload.mjs');
        writeFileSync(fetchPreload, "globalThis.fetch = async () => ({ ok: true, json: async () => ({ version: '99.99.99' }) });\n");
    });
    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });
    function runSessionStart(input, env = {}) {
        const raw = execFileSync(NODE, ['--import', fetchPreload, SCRIPT_PATH], {
            input: JSON.stringify(input),
            encoding: 'utf-8',
            env: {
                ...process.env,
                HOME: fakeHome,
                USERPROFILE: fakeHome,
                ...env,
            },
            timeout: 15000,
        }).trim();
        return JSON.parse(raw);
    }
    it('warns and suppresses conflicting same-root restore for a different active session', () => {
        const now = new Date().toISOString();
        writeFileSync(join(fakeProject, '.omc', 'state', 'ultrawork-state.json'), JSON.stringify({
            active: true,
            session_id: 'session-a',
            started_at: now,
            last_checked_at: now,
            original_prompt: 'Old task that should not bleed into session-b',
        }));
        const output = runSessionStart({
            hook_event_name: 'SessionStart',
            session_id: 'session-b',
            cwd: fakeProject,
        });
        const context = output.hookSpecificOutput?.additionalContext || '';
        expect(output.continue).toBe(true);
        expect(context).toContain('[PARALLEL SESSION WARNING]');
        expect(context).toContain('suppressed the restore');
        expect(context).not.toContain('[ULTRAWORK MODE RESTORED]');
        expect(context).not.toContain('Old task that should not bleed into session-b');
    });
    it('still restores ultrawork for the owning session', () => {
        writeFileSync(join(fakeProject, '.omc', 'state', 'ultrawork-state.json'), JSON.stringify({
            active: true,
            session_id: 'session-owner',
            started_at: '2026-03-19T00:00:00.000Z',
            last_checked_at: '2026-03-19T00:05:00.000Z',
            original_prompt: 'Resume me',
        }));
        const output = runSessionStart({
            hook_event_name: 'SessionStart',
            session_id: 'session-owner',
            cwd: fakeProject,
        });
        const context = output.hookSpecificOutput?.additionalContext || '';
        expect(output.continue).toBe(true);
        expect(context).toContain('[ULTRAWORK MODE RESTORED]');
        expect(context).toContain('Resume me');
        expect(context).not.toContain('[PARALLEL SESSION WARNING]');
    });
    it('does not warn for global fallback state from a different normalized project path', () => {
        mkdirSync(join(fakeHome, '.omc', 'state'), { recursive: true });
        writeFileSync(join(fakeHome, '.omc', 'state', 'ultrawork-state.json'), JSON.stringify({
            active: true,
            session_id: 'session-a',
            started_at: '2026-03-19T00:00:00.000Z',
            last_checked_at: '2026-03-19T00:05:00.000Z',
            original_prompt: 'Different project task',
            project_path: join(tempDir, 'other-project'),
        }));
        const output = runSessionStart({
            hook_event_name: 'SessionStart',
            session_id: 'session-b',
            cwd: fakeProject,
        });
        expect(output.continue).toBe(true);
        const context = output.hookSpecificOutput?.additionalContext || '';
        expect(context).not.toContain('[PARALLEL SESSION WARNING]');
        expect(context).not.toContain('[ULTRAWORK MODE RESTORED]');
    });
    it('does not run the standalone update probe without LazyCodex opt-in', () => {
        const output = runSessionStart({
            hook_event_name: 'SessionStart',
            session_id: 'session-b',
            cwd: fakeProject,
        });
        const context = output.hookSpecificOutput?.additionalContext || '';
        expect(output.continue).toBe(true);
        expect(context).not.toContain('[OMC AUTO-UPGRADE AVAILABLE]');
        expect(existsSync(join(fakeHome, '.omc', 'update-check.json'))).toBe(false);
    });
    it('does not run the standalone update probe with explicit false or malformed env values', () => {
        const output = runSessionStart({
            hook_event_name: 'SessionStart',
            session_id: 'session-b',
            cwd: fakeProject,
        }, {
            OMC_LAZYCODEX_AUTO_UPDATE: 'yes; touch /tmp/omc-injected',
            OMC_LAZYCODEX_GLOBAL_CLAUDE_MUTATION: 'false',
            OMC_LAZYCODEX_TELEMETRY: 'false',
        });
        const context = output.hookSpecificOutput?.additionalContext || '';
        expect(output.continue).toBe(true);
        expect(context).not.toContain('[OMC AUTO-UPGRADE AVAILABLE]');
        expect(existsSync(join(fakeHome, '.omc', 'update-check.json'))).toBe(false);
    });
    it('runs the standalone update probe when LazyCodex auto-update is explicitly opted in', () => {
        const configDir = join(fakeHome, '.claude');
        mkdirSync(configDir, { recursive: true });
        writeFileSync(join(configDir, '.omc-config.json'), JSON.stringify({ lazycodex: { autoUpdate: true } }));
        const output = runSessionStart({
            hook_event_name: 'SessionStart',
            session_id: 'session-b',
            cwd: fakeProject,
        }, { CLAUDE_CONFIG_DIR: configDir });
        const context = output.hookSpecificOutput?.additionalContext || '';
        expect(output.continue).toBe(true);
        expect(context).toContain('[OMC AUTO-UPGRADE AVAILABLE]');
        expect(existsSync(join(fakeHome, '.omc', 'update-check.json'))).toBe(true);
    });
});
//# sourceMappingURL=session-start-template.test.js.map