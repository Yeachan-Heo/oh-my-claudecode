import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { KEYWORD_DETECTOR_SCRIPT_NODE } from '../hooks.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, '..', '..', '..');
const STALE_PIPELINE_SNIPPETS = [
    "matches.push({ name: 'pipeline', args: '' });",
    "'pipeline','ccg','ralplan'",
    "'pipeline']);",
    "'swarm', 'pipeline'], sessionId);",
];
function runKeywordHook(scriptPath, prompt) {
    return JSON.parse(execFileSync('node', [scriptPath], {
        cwd: packageRoot,
        input: JSON.stringify({ prompt }),
        encoding: 'utf-8',
    }));
}
function runPreToolHook(scriptPath, command) {
    return JSON.parse(execFileSync('node', [scriptPath], {
        cwd: packageRoot,
        input: JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command },
        }),
        encoding: 'utf-8',
    }));
}
describe('keyword-detector packaged artifacts', () => {
    it('does not ship stale pipeline keyword handling in installer templates', () => {
        const template = KEYWORD_DETECTOR_SCRIPT_NODE;
        for (const snippet of STALE_PIPELINE_SNIPPETS) {
            expect(template).not.toContain(snippet);
        }
    });
    it('does not ship stale pipeline keyword handling in plugin scripts', () => {
        const pluginScript = readFileSync(join(packageRoot, 'scripts', 'keyword-detector.mjs'), 'utf-8');
        for (const snippet of STALE_PIPELINE_SNIPPETS) {
            expect(pluginScript).not.toContain(snippet);
        }
    });
    it('keeps installer template and plugin script aligned for supported compatibility keywords', () => {
        const templatePath = join(packageRoot, 'templates', 'hooks', 'keyword-detector.mjs');
        const pluginPath = join(packageRoot, 'scripts', 'keyword-detector.mjs');
        for (const [prompt, expected] of [
            ['tdd implement password validation', '[TDD MODE ACTIVATED]'],
            ['deep-analyze the test failure', 'ANALYSIS MODE'],
            ['deep interview me about requirements', '[MAGIC KEYWORD: DEEP-INTERVIEW]'],
            ['deslop this module with duplicate dead code', '[MAGIC KEYWORD: AI-SLOP-CLEANER]'],
        ]) {
            const templateResult = JSON.stringify(runKeywordHook(templatePath, prompt));
            const pluginResult = JSON.stringify(runKeywordHook(pluginPath, prompt));
            expect(templateResult).toContain(expected);
            expect(pluginResult).toContain(expected);
        }
    });
    it('emits compact skill invocation guidance instead of full SKILL.md bodies', () => {
        const templatePath = join(packageRoot, 'templates', 'hooks', 'keyword-detector.mjs');
        const pluginPath = join(packageRoot, 'scripts', 'keyword-detector.mjs');
        for (const scriptPath of [templatePath, pluginPath]) {
            const result = runKeywordHook(scriptPath, 'ralph fix and code review this change');
            const context = JSON.stringify(result);
            expect(context).toContain('[MAGIC KEYWORD: RALPH]');
            expect(context).toContain('Preferred invocation: /oh-my-claudecode:ralph');
            expect(context).toContain('Read fallback:');
            expect(context).not.toContain('name: ralph');
            expect(context).not.toContain('[RALPH + ULTRAWORK');
            expect(context.length).toBeLessThan(2000);
        }
    });
    it('keeps multi-skill keyword payloads under a compact budget', () => {
        const pluginPath = join(packageRoot, 'scripts', 'keyword-detector.mjs');
        const result = runKeywordHook(pluginPath, 'ralph this with ultrawork and plan this migration');
        const context = JSON.stringify(result);
        expect(context).toContain('[MAGIC KEYWORDS DETECTED: RALPH, ULTRAWORK]');
        expect(context).toContain('Do not inline full SKILL.md files');
        expect(context).not.toContain('[RALPH + ULTRAWORK');
        expect(context.length).toBeLessThan(4000);
    });
    it('only triggers ai-slop-cleaner for anti-slop cleanup/refactor prompts', () => {
        const templatePath = join(packageRoot, 'templates', 'hooks', 'keyword-detector.mjs');
        const pluginPath = join(packageRoot, 'scripts', 'keyword-detector.mjs');
        const positivePrompt = 'cleanup this ai slop: remove dead code and duplicate wrappers';
        const negativePrompt = 'refactor auth to support SSO';
        const templatePositive = JSON.stringify(runKeywordHook(templatePath, positivePrompt));
        const pluginPositive = JSON.stringify(runKeywordHook(pluginPath, positivePrompt));
        const templateNegative = runKeywordHook(templatePath, negativePrompt);
        const pluginNegative = runKeywordHook(pluginPath, negativePrompt);
        expect(templatePositive).toContain('[MAGIC KEYWORD: AI-SLOP-CLEANER]');
        expect(pluginPositive).toContain('[MAGIC KEYWORD: AI-SLOP-CLEANER]');
        expect(templateNegative).toEqual({ continue: true, suppressOutput: true });
        expect(pluginNegative).toEqual({ continue: true, suppressOutput: true });
    });
    it('does not auto-trigger team mode from keyword-detector artifacts', () => {
        const templatePath = join(packageRoot, 'templates', 'hooks', 'keyword-detector.mjs');
        const pluginPath = join(packageRoot, 'scripts', 'keyword-detector.mjs');
        const templateResult = runKeywordHook(templatePath, 'team 3 agents fix lint');
        const pluginResult = runKeywordHook(pluginPath, 'team 3 agents fix lint');
        expect(templateResult).toEqual({ continue: true, suppressOutput: true });
        expect(pluginResult).toEqual({ continue: true, suppressOutput: true });
    });
    it('marks packaged keyword-triggered states as awaiting confirmation', () => {
        const templatePath = join(packageRoot, 'templates', 'hooks', 'keyword-detector.mjs');
        const pluginPath = join(packageRoot, 'scripts', 'keyword-detector.mjs');
        const tempDir = mkdtempSync(join(tmpdir(), 'keyword-hook-awaiting-'));
        const fakeHome = mkdtempSync(join(tmpdir(), 'keyword-hook-home-'));
        try {
            for (const [scriptPath, statePath] of [
                [templatePath, join(tempDir, '.omc', 'state', 'sessions', 'hook-session', 'ralph-state.json')],
                [pluginPath, join(tempDir, '.omc', 'state', 'sessions', 'hook-session', 'ralph-state.json')],
            ]) {
                execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
                execFileSync('node', [scriptPath], {
                    cwd: packageRoot,
                    env: { ...process.env, HOME: fakeHome },
                    input: JSON.stringify({
                        prompt: 'ralph fix the regression in src/hooks/bridge.ts after issue #1795',
                        directory: tempDir,
                        cwd: tempDir,
                        session_id: 'hook-session',
                    }),
                    encoding: 'utf-8',
                });
                const state = JSON.parse(readFileSync(statePath, 'utf-8'));
                expect(state.awaiting_confirmation).toBe(true);
                rmSync(join(tempDir, '.omc'), { recursive: true, force: true });
                rmSync(join(fakeHome, '.omc'), { recursive: true, force: true });
            }
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
            rmSync(fakeHome, { recursive: true, force: true });
        }
    });
    it('preserves foreign shared-home state and every dead recovery generation during generic autopilot activation', () => {
        const templatePath = join(packageRoot, 'templates', 'hooks', 'keyword-detector.mjs');
        const projectA = mkdtempSync(join(tmpdir(), 'keyword-hook-project-a-'));
        const projectB = mkdtempSync(join(tmpdir(), 'keyword-hook-project-b-'));
        const fakeHome = mkdtempSync(join(tmpdir(), 'keyword-hook-home-'));
        const emptyXdg = mkdtempSync(join(tmpdir(), 'keyword-hook-xdg-'));
        const globalStatePath = join(fakeHome, '.omc', 'state', 'autopilot-state.json');
        const foreignState = JSON.stringify({ active: true, project_path: projectB, sentinel: 'project-b' });
        const deadTempPath = `${globalStatePath}.emergency-quarantine.00000000-0000-4000-8000-000000000001.payload.999999999.1.00000000-0000-4000-8000-000000000002.tmp`;
        try {
            execFileSync('git', ['init'], { cwd: projectA, stdio: 'pipe' });
            mkdirSync(dirname(globalStatePath), { recursive: true });
            writeFileSync(globalStatePath, foreignState);
            writeFileSync(deadTempPath, foreignState);
            execFileSync('node', [templatePath], {
                cwd: packageRoot,
                env: { ...process.env, HOME: fakeHome, XDG_CONFIG_HOME: emptyXdg, NODE_ENV: 'test' },
                input: JSON.stringify({ prompt: 'autopilot fix the regression', directory: projectA, cwd: projectA, session_id: 'project-a-session' }),
                encoding: 'utf-8',
            });
            expect(readFileSync(globalStatePath, 'utf-8')).toBe(foreignState);
            expect(readFileSync(deadTempPath, 'utf-8')).toBe(foreignState);
            expect(existsSync(join(projectA, '.omc', 'state', 'sessions', 'project-a-session', 'autopilot-state.json'))).toBe(true);
            const malformedJournalPath = `${globalStatePath}.emergency-journal.json`;
            writeFileSync(malformedJournalPath, '{not-json');
            execFileSync('node', [templatePath], {
                cwd: packageRoot,
                env: { ...process.env, HOME: fakeHome, XDG_CONFIG_HOME: emptyXdg, NODE_ENV: 'test' },
                input: JSON.stringify({ prompt: 'autopilot fix another regression', directory: projectA, cwd: projectA, session_id: 'project-a-session-2' }),
                encoding: 'utf-8',
            });
            expect(readFileSync(globalStatePath, 'utf-8')).toBe(foreignState);
            expect(readFileSync(deadTempPath, 'utf-8')).toBe(foreignState);
            expect(readFileSync(malformedJournalPath, 'utf-8')).toBe('{not-json');
        }
        finally {
            rmSync(projectA, { recursive: true, force: true });
            rmSync(projectB, { recursive: true, force: true });
            rmSync(fakeHome, { recursive: true, force: true });
            rmSync(emptyXdg, { recursive: true, force: true });
        }
    });
    it('does not auto-trigger informational keyword questions in packaged artifacts', () => {
        const templatePath = join(packageRoot, 'templates', 'hooks', 'keyword-detector.mjs');
        const pluginPath = join(packageRoot, 'scripts', 'keyword-detector.mjs');
        for (const prompt of [
            'What is ralph and how do I use it?',
            'ralph 와 ralplan 은 뭐야?',
            'ralplan とは？ 使い方を教えて',
            'ralph 是什么？怎么用？',
            'What is autopilot mode now?',
            'what is ralph mode now?',
            'ralph keeps looping, investigate',
            "there's an issue with ultrawork",
            'autopilot has a bug in this repo',
            'ralph-loop이 자꾸 재실행되는 문제가 있어. 점검해줘',
            `🦌 DeerFlow vs ⚡ OMC Ultrawork - 완전 비교!
...
OMC Ultrawork = "특수부대 작전 반"
...
결론: "순식간에 많은 작업" → OMC Ultrawork ⚡
이런대화가 한번이라면 몇번할수있을까 오픈라우터 20달러 결제기준 api로`,
            'The article said "OMC Ultrawork", but why is the answer the same?',
            'OMC Ultrawork = "special ops". how much would it cost?',
        ]) {
            expect(runKeywordHook(templatePath, prompt)).toEqual({ continue: true, suppressOutput: true });
            expect(runKeywordHook(pluginPath, prompt)).toEqual({ continue: true, suppressOutput: true });
        }
    });
    it('still triggers for explicit activation requests in bug-fix context', () => {
        const templatePath = join(packageRoot, 'templates', 'hooks', 'keyword-detector.mjs');
        const pluginPath = join(packageRoot, 'scripts', 'keyword-detector.mjs');
        const templateAutopilot = runKeywordHook(templatePath, 'use autopilot to fix bug in payments');
        const pluginAutopilot = runKeywordHook(pluginPath, 'use autopilot to fix bug in payments');
        expect(JSON.stringify(templateAutopilot)).toContain('[MAGIC KEYWORD: AUTOPILOT]');
        expect(JSON.stringify(pluginAutopilot)).toContain('[MAGIC KEYWORD: AUTOPILOT]');
        const templateRalph = runKeywordHook(templatePath, 'run ralph on issue in parser module');
        const pluginRalph = runKeywordHook(pluginPath, 'run ralph on issue in parser module');
        expect(JSON.stringify(templateRalph)).toContain('[MAGIC KEYWORD: RALPH]');
        expect(JSON.stringify(pluginRalph)).toContain('[MAGIC KEYWORD: RALPH]');
        const templateAutopilotIssue = runKeywordHook(templatePath, 'fix issue with autopilot in parser module');
        const pluginAutopilotIssue = runKeywordHook(pluginPath, 'fix issue with autopilot in parser module');
        expect(JSON.stringify(templateAutopilotIssue)).toContain('[MAGIC KEYWORD: AUTOPILOT]');
        expect(JSON.stringify(pluginAutopilotIssue)).toContain('[MAGIC KEYWORD: AUTOPILOT]');
        const templateRalphProblem = runKeywordHook(templatePath, 'run ralph on parser state issue');
        const pluginRalphProblem = runKeywordHook(pluginPath, 'run ralph on parser state issue');
        expect(JSON.stringify(templateRalphProblem)).toContain('[MAGIC KEYWORD: RALPH]');
        expect(JSON.stringify(pluginRalphProblem)).toContain('[MAGIC KEYWORD: RALPH]');
    });
    it('honors keywordDetector.disabled from .claude/omc.jsonc in both packaged artifacts', () => {
        const templatePath = join(packageRoot, 'templates', 'hooks', 'keyword-detector.mjs');
        const pluginPath = join(packageRoot, 'scripts', 'keyword-detector.mjs');
        // Isolate from any real user config at ~/.config/claude-omc/config.jsonc.
        const emptyXdg = mkdtempSync(join(tmpdir(), 'keyword-hook-xdg-'));
        const disabledDir = mkdtempSync(join(tmpdir(), 'keyword-hook-disabled-'));
        const controlDir = mkdtempSync(join(tmpdir(), 'keyword-hook-control-'));
        const runInDir = (scriptPath, prompt, dir) => JSON.parse(execFileSync('node', [scriptPath], {
            cwd: packageRoot,
            env: { ...process.env, XDG_CONFIG_HOME: emptyXdg },
            input: JSON.stringify({ prompt, cwd: dir, directory: dir }),
            encoding: 'utf-8',
        }));
        try {
            mkdirSync(join(disabledDir, '.claude'), { recursive: true });
            // Canonical JSONC shape from the #3421 review: comment + trailing commas.
            writeFileSync(join(disabledDir, '.claude', 'omc.jsonc'), '{\n  // disable tdd auto-routing\n  "keywordDetector": { "disabled": ["tdd",], },\n}');
            for (const scriptPath of [templatePath, pluginPath]) {
                // Opt-out is honored: the shipped hook does not route the disabled keyword.
                expect(runInDir(scriptPath, 'tdd implement password validation', disabledDir)).toEqual({
                    continue: true,
                    suppressOutput: true,
                });
                // Control: without the opt-out the same prompt still routes.
                expect(JSON.stringify(runInDir(scriptPath, 'tdd implement password validation', controlDir))).toContain('[TDD MODE ACTIVATED]');
            }
        }
        finally {
            rmSync(emptyXdg, { recursive: true, force: true });
            rmSync(disabledDir, { recursive: true, force: true });
            rmSync(controlDir, { recursive: true, force: true });
        }
    });
});
describe('pre-tool-use packaged artifacts', () => {
    it('does not warn for .json commands just because .js is a substring', () => {
        const scriptPath = join(packageRoot, 'templates', 'hooks', 'pre-tool-use.mjs');
        expect(runPreToolHook(scriptPath, 'cat settings.json > backup.txt')).toEqual({
            continue: true,
            suppressOutput: true,
        });
        expect(JSON.stringify(runPreToolHook(scriptPath, 'cat app.js > backup.txt'))).toContain('Bash command may modify source files');
    });
});
describe('atomic write packaged helpers', () => {
    it.each([
        ['plugin helper', join(packageRoot, 'scripts', 'lib', 'atomic-write.mjs')],
        ['standalone hook helper', join(packageRoot, 'templates', 'hooks', 'lib', 'atomic-write.mjs')],
    ])('allows its own recovery claim to converge while preserving foreign claim artifacts through the %s', async (_label, helperPath) => {
        const tempDir = mkdtempSync(join(tmpdir(), 'atomic-write-recovery-claim-'));
        const statePath = join(tempDir, '.omc', 'state', 'autopilot-state.json');
        const claimPath = `${statePath}.emergency-recovery.claim`;
        const projectPath = join(tempDir, 'project-a');
        const state = JSON.stringify({ active: true, project_path: projectPath });
        const foreignClaim = JSON.stringify({
            version: 1,
            pid: 424242,
            processStart: '1',
            createdAt: '2026-01-01T00:00:00.000Z',
            nonce: '00000000-0000-4000-8000-000000000001',
        });
        const foreignClaimTemp = `${claimPath}.424242.1.00000000-0000-4000-8000-000000000001.tmp`;
        try {
            mkdirSync(dirname(statePath), { recursive: true });
            writeFileSync(statePath, state);
            const { recoverEmergencyStateFile } = await import(pathToFileURL(helperPath).href);
            const authorizeState = (candidate) => candidate.project_path === projectPath;
            expect(recoverEmergencyStateFile(statePath, { authorizeState })).toBe(true);
            expect(readFileSync(statePath, 'utf-8')).toBe(state);
            expect(existsSync(claimPath)).toBe(false);
            writeFileSync(claimPath, foreignClaim);
            expect(recoverEmergencyStateFile(statePath, { authorizeState })).toBe(false);
            expect(readFileSync(claimPath, 'utf-8')).toBe(foreignClaim);
            rmSync(claimPath);
            writeFileSync(foreignClaimTemp, foreignClaim);
            expect(recoverEmergencyStateFile(statePath, { authorizeState })).toBe(false);
            expect(readFileSync(foreignClaimTemp, 'utf-8')).toBe(foreignClaim);
        }
        finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
describe('workflow profile runtime packaged artifacts (#3487)', () => {
    it('ships the same descriptor and stop-transition helper with plugin and standalone hook payloads', () => {
        const templateHelper = readFileSync(join(packageRoot, 'templates', 'hooks', 'lib', 'workflow-profile-runtime.mjs'), 'utf-8');
        const pluginHelper = readFileSync(join(packageRoot, 'scripts', 'lib', 'workflow-profile-runtime.mjs'), 'utf-8');
        for (const contractTerm of ['selectWorkflowProfile', 'createWorkflowState', 'advanceWorkflowOnStop', 'profileHash', 'pipelineTracking', 'completionObservations']) {
            expect(pluginHelper).toContain(contractTerm);
            expect(templateHelper).toContain(contractTerm);
        }
    });
    it('loads workflow profile transition helpers before running either persistent hook', () => {
        for (const script of [
            join(packageRoot, 'scripts', 'persistent-mode.mjs'),
            join(packageRoot, 'templates', 'hooks', 'persistent-mode.mjs'),
        ]) {
            const payload = readFileSync(script, 'utf-8');
            expect(payload).toContain('workflow-profile-runtime.mjs');
            expect(payload).toContain('advanceWorkflowOnStop');
            expect(payload).toContain('pipelineTracking?.trackingRevision');
        }
    });
});
//# sourceMappingURL=hook-templates.test.js.map