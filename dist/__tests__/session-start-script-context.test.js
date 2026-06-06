import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
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
        // session-start validateCwd requires a real workspace anchor (.git / .omc-workspace)
        mkdirSync(join(fakeProject, '.git'), { recursive: true });
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
    it('injects model routing override for non-standard providers before lower-priority context', () => {
        writeFileSync(join(fakeProject, 'AGENTS.md'), `# oh-my-claudecode - Intelligent Multi-Agent Orchestration

<guidance_schema_contract>schema</guidance_schema_contract>

<operating_principles>
${'- oversized startup guidance\n'.repeat(700)}
</operating_principles>`);
        const raw = execFileSync(NODE, [SCRIPT_PATH], {
            input: JSON.stringify({
                hook_event_name: 'SessionStart',
                session_id: 'session-bedrock-script',
                cwd: fakeProject,
            }),
            encoding: 'utf-8',
            env: {
                ...process.env,
                HOME: fakeHome,
                USERPROFILE: fakeHome,
                CLAUDE_CODE_USE_BEDROCK: '1',
            },
            timeout: 15000,
        }).trim();
        const output = JSON.parse(raw);
        const context = output.hookSpecificOutput?.additionalContext || '';
        expect(output.continue).toBe(true);
        expect(context).toContain('[MODEL ROUTING OVERRIDE');
        expect(context).toContain('tier alias');
        expect(context).toMatch(/\b(sonnet|opus|haiku)\b/);
        expect(context).not.toContain('Do NOT pass the `model` parameter');
        expect(context).not.toContain('Omit it entirely');
        expect(context.length).toBeLessThanOrEqual(6000);
    });
    it('surfaces update notices through systemMessage without injecting them into additionalContext', () => {
        const claudeDir = join(fakeHome, '.claude');
        const pluginRoot = join(tempDir, 'plugin');
        mkdirSync(join(claudeDir, '.omc'), { recursive: true });
        mkdirSync(join(claudeDir, 'hud'), { recursive: true });
        mkdirSync(pluginRoot, { recursive: true });
        writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ version: '1.0.0', type: 'module' }));
        writeFileSync(join(claudeDir, 'hud', 'omc-hud.mjs'), '');
        writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ statusLine: 'node ~/.claude/hud/omc-hud.mjs' }));
        writeFileSync(join(claudeDir, '.omc', 'update-check.json'), JSON.stringify({
            timestamp: Date.now(),
            latestVersion: '999.0.0',
            currentVersion: '1.0.0',
            updateAvailable: true,
        }));
        const result = spawnSync(NODE, [SCRIPT_PATH], {
            input: JSON.stringify({
                hook_event_name: 'SessionStart',
                session_id: 'session-update-script',
                cwd: fakeProject,
            }),
            encoding: 'utf-8',
            env: {
                ...process.env,
                HOME: fakeHome,
                USERPROFILE: fakeHome,
                CLAUDE_PLUGIN_ROOT: pluginRoot,
                OMC_NOTIFY: '0',
            },
            timeout: 15000,
        });
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        const output = JSON.parse(result.stdout);
        expect(output.continue).toBe(true);
        expect(output.systemMessage).toContain('[OMC UPDATE AVAILABLE]');
        expect(output.systemMessage).toContain('v999.0.0');
        expect(output.systemMessage).toContain('/update');
        expect(output.hookSpecificOutput?.additionalContext ?? '').not.toContain('[OMC UPDATE AVAILABLE]');
        expect(output.hookSpecificOutput?.additionalContext ?? '').not.toContain('999.0.0');
    });
    it('does not show update notice when stale CLAUDE_PLUGIN_ROOT is older than plugin cache', () => {
        const claudeDir = join(fakeHome, '.claude');
        const stalePluginRoot = join(claudeDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.14.4');
        const latestPluginRoot = join(claudeDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode', '4.14.5');
        mkdirSync(join(claudeDir, '.omc'), { recursive: true });
        mkdirSync(join(claudeDir, 'hud'), { recursive: true });
        mkdirSync(stalePluginRoot, { recursive: true });
        mkdirSync(latestPluginRoot, { recursive: true });
        writeFileSync(join(stalePluginRoot, 'package.json'), JSON.stringify({ version: '4.14.4', type: 'module' }));
        writeFileSync(join(latestPluginRoot, 'package.json'), JSON.stringify({ version: '4.14.5', type: 'module' }));
        writeFileSync(join(claudeDir, 'hud', 'omc-hud.mjs'), '');
        writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ statusLine: 'node ~/.claude/hud/omc-hud.mjs' }));
        writeFileSync(join(claudeDir, '.omc', 'update-check.json'), JSON.stringify({
            timestamp: Date.now(),
            latestVersion: '4.14.5',
            currentVersion: '4.14.4',
            updateAvailable: true,
        }));
        const result = spawnSync(NODE, [SCRIPT_PATH], {
            input: JSON.stringify({
                hook_event_name: 'SessionStart',
                session_id: 'session-stale-plugin-root',
                cwd: fakeProject,
            }),
            encoding: 'utf-8',
            env: {
                ...process.env,
                HOME: fakeHome,
                USERPROFILE: fakeHome,
                CLAUDE_PLUGIN_ROOT: stalePluginRoot,
                OMC_NOTIFY: '0',
            },
            timeout: 15000,
        });
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        const output = JSON.parse(result.stdout);
        expect(output.continue).toBe(true);
        expect(output.systemMessage ?? '').not.toContain('[OMC UPDATE AVAILABLE]');
        expect(output.systemMessage ?? '').not.toContain('4.14.4');
        expect(output.hookSpecificOutput?.additionalContext ?? '').not.toContain('[OMC UPDATE AVAILABLE]');
    });
});
//# sourceMappingURL=session-start-script-context.test.js.map