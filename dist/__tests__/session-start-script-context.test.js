import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const SCRIPT_PATH = join(__dirname, '..', '..', 'scripts', 'session-start.mjs');
const NODE = process.execPath;
describe('session-start.mjs regression #1386', () => {
    let tempDir;
    let fakeHome;
    let fakeProject;
    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'omc-session-start-script-'));
        fakeHome = join(tempDir, 'home');
        fakeProject = join(tempDir, 'project');
        mkdirSync(join(fakeProject, '.omc', 'state', 'sessions', 'session-1386'), { recursive: true });
    });
    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });
    it('marks restored ultrawork state as prior-session context instead of imperative continuation', () => {
        writeFileSync(join(fakeProject, '.omc', 'state', 'sessions', 'session-1386', 'ultrawork-state.json'), JSON.stringify({
            active: true,
            session_id: 'session-1386',
            started_at: '2026-03-06T00:00:00.000Z',
            original_prompt: 'Old task that should not override a new request',
        }));
        const raw = execFileSync(NODE, [SCRIPT_PATH], {
            input: JSON.stringify({
                hook_event_name: 'SessionStart',
                session_id: 'session-1386',
                cwd: fakeProject,
            }),
            encoding: 'utf-8',
            env: {
                ...process.env,
                HOME: fakeHome,
                USERPROFILE: fakeHome,
            },
            timeout: 15000,
        }).trim();
        const output = JSON.parse(raw);
        const context = output.hookSpecificOutput?.additionalContext || '';
        expect(context).toContain('[ULTRAWORK MODE RESTORED]');
        expect(context).toContain("Prioritize the user's newest request");
        expect(context).not.toContain('Continue working in ultrawork mode until all tasks are complete.');
    });
    it('injects persisted project memory into session-start additionalContext', () => {
        mkdirSync(join(fakeProject, '.git'));
        mkdirSync(join(fakeProject, '.omc'), { recursive: true });
        writeFileSync(join(fakeProject, '.omc', 'project-memory.json'), JSON.stringify({
            version: '1.0.0',
            lastScanned: Date.now(),
            projectRoot: fakeProject,
            techStack: {
                languages: [
                    {
                        name: 'TypeScript',
                        version: '5.0.0',
                        confidence: 'high',
                        markers: ['tsconfig.json', 'package.json'],
                    },
                ],
                frameworks: [],
                packageManager: 'pnpm',
                runtime: 'node',
            },
            build: {
                buildCommand: 'pnpm build',
                testCommand: 'pnpm test',
                lintCommand: null,
                devCommand: null,
                scripts: {},
            },
            conventions: {
                namingStyle: null,
                importStyle: null,
                testPattern: null,
                fileOrganization: null,
            },
            structure: {
                isMonorepo: false,
                workspaces: [],
                mainDirectories: ['src'],
                gitBranches: null,
            },
            customNotes: [
                {
                    timestamp: Date.now(),
                    source: 'manual',
                    category: 'env',
                    content: 'Requires LOCAL_API_BASE for smoke tests',
                },
            ],
            directoryMap: {},
            hotPaths: [],
            userDirectives: [
                {
                    timestamp: Date.now(),
                    directive: 'Preserve project memory directives at session start',
                    context: '',
                    source: 'explicit',
                    priority: 'high',
                },
            ],
        }));
        const raw = execFileSync(NODE, [SCRIPT_PATH], {
            input: JSON.stringify({
                hook_event_name: 'SessionStart',
                session_id: 'session-1779',
                cwd: fakeProject,
            }),
            encoding: 'utf-8',
            env: {
                ...process.env,
                HOME: fakeHome,
                USERPROFILE: fakeHome,
            },
            timeout: 15000,
        }).trim();
        const output = JSON.parse(raw);
        const context = output.hookSpecificOutput?.additionalContext || '';
        expect(output.continue).toBe(true);
        expect(context).toContain('<project-memory-context>');
        expect(context).toContain('[PROJECT MEMORY]');
        expect(context).toContain('Preserve project memory directives at session start');
        expect(context).toContain('[Project Environment]');
        expect(context).toContain('- TypeScript | pkg:pnpm | node');
        expect(context).toContain('- build=pnpm build | test=pnpm test');
        expect(context).toContain('[env] Requires LOCAL_API_BASE for smoke tests');
        expect(context).toContain('</project-memory-context>');
    });
});
//# sourceMappingURL=session-start-script-context.test.js.map