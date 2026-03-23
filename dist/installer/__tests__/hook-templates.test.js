import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
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
            ['deep interview me about requirements', 'oh-my-claudecode:deep-interview'],
            ['deslop this module with duplicate dead code', 'oh-my-claudecode:ai-slop-cleaner'],
        ]) {
            const templateResult = JSON.stringify(runKeywordHook(templatePath, prompt));
            const pluginResult = JSON.stringify(runKeywordHook(pluginPath, prompt));
            expect(templateResult).toContain(expected);
            expect(pluginResult).toContain(expected);
        }
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
        expect(templatePositive).toContain('oh-my-claudecode:ai-slop-cleaner');
        expect(pluginPositive).toContain('oh-my-claudecode:ai-slop-cleaner');
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
                [templatePath, join(tempDir, '.omc', 'state', 'ralph-state.json')],
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
    it('does not auto-trigger informational keyword questions in packaged artifacts', () => {
        const templatePath = join(packageRoot, 'templates', 'hooks', 'keyword-detector.mjs');
        const pluginPath = join(packageRoot, 'scripts', 'keyword-detector.mjs');
        for (const prompt of [
            'What is ralph and how do I use it?',
            'ralph 와 ralplan 은 뭐야?',
            'ralplan とは？ 使い方を教えて',
            'ralph 是什么？怎么用？',
        ]) {
            expect(runKeywordHook(templatePath, prompt)).toEqual({ continue: true, suppressOutput: true });
            expect(runKeywordHook(pluginPath, prompt)).toEqual({ continue: true, suppressOutput: true });
        }
    });
});
//# sourceMappingURL=hook-templates.test.js.map