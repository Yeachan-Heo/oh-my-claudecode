import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
const SCRIPT_PATH = join(process.cwd(), 'scripts', 'keyword-detector.mjs');
const NODE = process.execPath;
function runKeywordDetector(prompt) {
    const raw = execFileSync(NODE, [SCRIPT_PATH], {
        input: JSON.stringify({
            hook_event_name: 'UserPromptSubmit',
            cwd: process.cwd(),
            session_id: 'session-2053',
            prompt,
        }),
        encoding: 'utf-8',
        env: {
            ...process.env,
            NODE_ENV: 'test',
            OMC_SKIP_HOOKS: '',
        },
        timeout: 15000,
    }).trim();
    return JSON.parse(raw);
}
describe('keyword-detector.mjs mode-message dispatch', () => {
    it('injects search mode for deepsearch without emitting a magic skill invocation', () => {
        const output = runKeywordDetector('deepsearch the codebase for keyword dispatch');
        const context = output.hookSpecificOutput?.additionalContext ?? '';
        expect(output.continue).toBe(true);
        expect(output.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
        expect(context).toContain('<search-mode>');
        expect(context).toContain('MAXIMIZE SEARCH EFFORT');
        expect(context).not.toContain('[MAGIC KEYWORD: DEEPSEARCH]');
        expect(context).not.toContain('Skill: oh-my-claudecode:deepsearch');
    });
    it.each([
        ['ultrathink', '<think-mode>'],
        ['deep-analyze this subsystem', '<analyze-mode>'],
        ['tdd fix the failing test', '<tdd-mode>'],
        ['code review this diff', '<code-review-mode>'],
        ['security review this auth flow', '<security-review-mode>'],
    ])('keeps mode keyword %s on the context-injection path', (prompt, marker) => {
        const output = runKeywordDetector(prompt);
        const context = output.hookSpecificOutput?.additionalContext ?? '';
        expect(context).toContain(marker);
        expect(context).not.toContain('[MAGIC KEYWORD:');
    });
    it('still emits magic keyword invocation for true skills like ralplan', () => {
        const output = runKeywordDetector('ralplan fix issue #2053');
        const context = output.hookSpecificOutput?.additionalContext ?? '';
        expect(context).toContain('[MAGIC KEYWORD: RALPLAN]');
        expect(context).toContain('name: ralplan');
    });
    it('ignores HTML comments that mention ralph and autopilot during normal review text', () => {
        const output = runKeywordDetector(`Please review this draft document for tone and clarity:

<!-- ralph: rewrite intro section with more urgency -->
<!-- autopilot note: Why Artificially Inflating GitHub Star Counts Is Harmful:
popularity without merit misleads developers, distorts discovery, unfairly rewards dishonest projects, and erodes trust in GitHub stars as a community signal. -->

Final draft:

Why Artificially Inflating GitHub Star Counts Is Harmful
=========================================================

This article argues that fake popularity signals damage trust in open source.`);
        const context = output.hookSpecificOutput?.additionalContext ?? '';
        expect(output.continue).toBe(true);
        expect(context).not.toContain('[MAGIC KEYWORD: RALPH]');
        expect(context).not.toContain('[MAGIC KEYWORD: AUTOPILOT]');
        expect(context).toBe('');
    });
});
//# sourceMappingURL=keyword-detector-script.test.js.map